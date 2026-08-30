import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  analyzeQuery,
  extractStructuralMarkers,
  scoreChunk,
  buildChunkTokenSets,
  expandAdjacentChunks,
  filterDuplicates,
  boundContext,
  computeScoreGap,
  validateStructuralMatch,
  promoteStructuralMatches,
  hasStructuralMismatch,
  type ScoredChunk,
  type QueryAnalysis,
} from "@/lib/retrieval";

// ---------------------------------------------------------------------------
// Types (preserved for backward compatibility)
// ---------------------------------------------------------------------------

export type RetrievalConfidence = "high" | "medium" | "low" | "none";

export interface RetrievalChunk {
  id: string;
  text: string;
  score: number;
  pageNumber: number | null;
  signals?: ScoredChunk["signals"];
}

export interface RetrievalResult {
  documentId: string;
  documentName: string;
  originalFilename: string;
  chunks: RetrievalChunk[];
  totalChunks: number;
  confidence: RetrievalConfidence;
  queryAnalysis?: QueryAnalysis;
  scoreGap?: { best: number; second: number; gap: number; ratio: number };
  /** Phase 5D.1: Structural validation result. */
  structuralMatch?: "exact_match" | "partial_match" | "no_match";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape special regex characters in a string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CANDIDATE_MULTIPLIER = 3;
const MIN_CANDIDATE_COUNT = 12;
const MAX_CANDIDATE_COUNT = 30;

const CONFIDENCE_HIGH_THRESHOLD = 120;
const CONFIDENCE_MEDIUM_THRESHOLD = 60;
const CONFIDENCE_LOW_THRESHOLD = 1;
const CONFIDENCE_GAP_HIGH_MIN = 40;

// ---------------------------------------------------------------------------
// Structural context map — full-document structural scope tracking
// ---------------------------------------------------------------------------

/**
 * Tracks the structural scope (Unit, Part, Chapter, etc.) for each chunk
 * using a single forward pass through the document. Unlike the sliding
 * preceding-content window, this preserves structural ancestry across the
 * entire document — critical for scope queries like "questions in Unit 4 Part B".
 */
interface StructuralContext {
  unit: string | null;
  module: string | null;
  chapter: string | null;
  section: string | null;
  subsection: string | null;
  part: string | null;
}

function buildStructuralContextMap(
  chunks: Array<{ chunk_index: number; content: string }>
): Map<number, StructuralContext> {
  const map = new Map<number, StructuralContext>();
  const current: StructuralContext = {
    unit: null, module: null, chapter: null,
    section: null, subsection: null, part: null,
  };

  // Mirror of STRUCTURAL_DEPTH in scoring.ts — a shallower container resets any
  // deeper parent scope inherited from earlier content (e.g. a new "UNIT" must
  // clear a stale "PART" that belonged to the previous unit).
  const SCOPE_DEPTH: Record<string, number> = {
    unit: 0, module: 1, chapter: 2, section: 3, subsection: 4, part: 5,
  };

  for (const chunk of chunks) {
    const markers = extractStructuralMarkers(chunk.content.toLowerCase());
    for (const marker of markers) {
      if (marker.type in current) {
        const depth = SCOPE_DEPTH[marker.type] ?? 50;
        for (const key of Object.keys(current) as Array<keyof StructuralContext>) {
          if ((SCOPE_DEPTH[key] ?? 50) > depth && current[key] != null) {
            current[key] = null;
          }
        }
        current[marker.type as keyof StructuralContext] = marker.number;
      }
    }
    map.set(chunk.chunk_index, { ...current });
  }
  return map;
}

/**
 * Detects if a chunk contains a question block marker.
 * Handles multiple common formats:
 * - "Question 1", "Question No. 5", "Q1", "Q.3"
 * - "1.", "1)", "1.", "(1)"
 * - "5th question", "Question 5th"
 * - "a)", "b)", etc. (lettered items after question marker)
 */
function detectQuestionBlock(content: string): boolean {
  // Standard question formats: "Question N", "Question No. N", "Q.N", "QN"
  if (/\b(?:question|q\.?)\s*(?:no\.?\s*)?\d+/i.test(content)) return true;

  // Numbered list formats: "1.", "1)", "(1)", "1:"
  // Must be at start of line or after whitespace, not inside a word
  if (/(?:^|\s)\d+[.)]\s/m.test(content)) return true;
  if (/(?:^|\s)\(\d+\)\s/m.test(content)) return true;

  // Ordinal formats: "5th question", "Question 5th"
  if (/\b\d+(?:st|nd|rd|th)\s+question\b/i.test(content)) return true;
  if (/\bquestion\s+\d+(?:st|nd|rd|th)\b/i.test(content)) return true;

  // Lettered list formats after question context: "a)", "b)", etc.
  // Only if content already mentions question-related terms
  if (/(?:question|exercise|problem|part)/i.test(content) && /(?:^|\s)[a-z][.)]\s/m.test(content)) {
    return true;
  }

  return false;
}

/**
 * Collects ALL question blocks within a structural scope.
 * Bypasses scoring entirely — returns chunks based on structural ancestry.
 *
 * Steps:
 * 1. Filter chunks by structural scope (e.g., unit=4, part=b)
 * 2. Identify question blocks: starts with question marker, ends before next question
 * 3. Include continuation chunks (metadata: Bloom's, CO, Marks) in each block
 * 4. Return in document order
 */
function retrieveScopeChunks(
  chunks: Array<{ id: string; content: string; chunk_index: number; page_number: number | null }>,
  contextMap: Map<number, StructuralContext>,
  scope: { unit?: string | null; part?: string | null; chapter?: string | null; module?: string | null; section?: string | null }
): Array<{ id: string; content: string; chunk_index: number; page_number: number | null }> {
  // Step 1: Filter to scope
  const inScope: typeof chunks = [];
  for (const chunk of chunks) {
    const ctx = contextMap.get(chunk.chunk_index);
    if (!ctx) continue;
    if (scope.unit != null && ctx.unit !== scope.unit) continue;
    if (scope.part != null && ctx.part !== scope.part) continue;
    if (scope.chapter != null && ctx.chapter !== scope.chapter) continue;
    if (scope.module != null && ctx.module !== scope.module) continue;
    if (scope.section != null && ctx.section !== scope.section) continue;
    inScope.push(chunk);
  }

  if (inScope.length === 0) return [];

  // Step 2: Collect question blocks
  // A question block starts with a question marker and includes all following
  // chunks until the next question marker or end of scope.
  const result: typeof chunks = [];
  let currentBlock: typeof chunks = [];
  let insideBlock = false;

  for (const chunk of inScope) {
    const hasQuestion = detectQuestionBlock(chunk.content);

    if (hasQuestion) {
      // Flush previous block
      if (currentBlock.length > 0) result.push(...currentBlock);
      currentBlock = [chunk];
      insideBlock = true;
    } else if (insideBlock) {
      // Continuation of current question block (metadata, etc.)
      currentBlock.push(chunk);
    }
  }
  // Flush last block
  if (currentBlock.length > 0) result.push(...currentBlock);

  // Fallback: If no question blocks detected, return all scope chunks
  // This handles cases where questions use non-standard formatting
  if (result.length === 0 && inScope.length > 0) {
    console.log(
      `[ScopeRetrieval] no question blocks detected, returning all ${inScope.length} scope chunks as fallback`
    );
    return inScope;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main retrieval function
// ---------------------------------------------------------------------------

export async function retrieveDocumentChunks({
  documentId,
  userId,
  question,
  maxChunks = 8,
  maxChars = 12000,
  adjacentExpansion = 1,
}: {
  documentId: string;
  userId: string;
  question: string;
  maxChunks?: number;
  maxChars?: number;
  adjacentExpansion?: number;
}): Promise<RetrievalResult | null> {
  const supabase = await getSupabaseServerClient();

  const { data: doc } = await supabase
    .from("documents")
    .select("id, user_id, name, original_filename, processing_status")
    .eq("id", documentId)
    .maybeSingle();

  if (!doc || doc.user_id !== userId) return null;
  if (doc.processing_status !== "ready") return null;

  const { data: chunks } = await supabase
    .from("document_chunks")
    .select("id, content, chunk_index, page_number")
    .eq("document_id", documentId)
    .order("chunk_index", { ascending: true });

  if (!chunks || chunks.length === 0) return null;

  // Analyze the query
  const analysis = analyzeQuery(question);

  console.log(
    `[Retrieval] intent=${analysis.intent} tokens=${analysis.importantTokens.length} entities=${JSON.stringify(analysis.entities)} structuralPath=${analysis.entities.structuralPath.length} markers scopeQuery=${analysis.scopeQuery}`
  );

  // -----------------------------------------------------------------------
  // Exact question lookup path — bypass scoring, use structural context map
  // -----------------------------------------------------------------------
  // When the query specifies a question number WITH parent hierarchy (e.g.,
  // "Unit 4 Question 5 Part B"), the 4K sliding preceding-content window
  // loses parent markers (unit, part, chapter), causing
  // validateStructuralPath to fail and score the correct chunk at 0.
  // Instead, we use the full-document structural context map to find the
  // exact question and validate its complete path.
  if (analysis.entities.questionNumber && analysis.entities.structuralPath.length > 1) {
    const contextMap = buildStructuralContextMap(chunks);
    const questionNum = analysis.entities.questionNumber;

    // Build required path from structural markers (excluding question itself)
    const requiredPath: Partial<StructuralContext> = {};
    for (const marker of analysis.entities.structuralPath) {
      if (marker.type === "question") continue;
      // Only take the first marker of each type (in case of duplicates)
      if (marker.type in requiredPath) continue;
      (requiredPath as Record<string, string>)[marker.type] = marker.number;
    }

    // Patterns to detect a chunk that BEGINS a question block for the target
    // number. The forward patterns are line-anchored so an in-prose reference
    // like "see q5 notes" does not open a block, and a bare backward match
    // ("5 question") never matches "Unit 5 Question 1".
    const targetLineRe = new RegExp(
      `(?:^|\\n)\\s*(?:question|q)\\.?\\s*(?:no\\.?\\s*)?${escapeRegex(questionNum)}\\b`,
      "i"
    );
    const targetOrdinalBackRe = new RegExp(
      `\\b(?:question|q)\\s+${escapeRegex(questionNum)}(?:st|nd|rd|th)\\b`,
      "i"
    );
    const targetOrdinalFrontRe = new RegExp(
      `\\b${escapeRegex(questionNum)}(?:st|nd|rd|th)\\s+(?:question|q)\\b`,
      "i"
    );

    function matchesTargetQuestion(content: string): boolean {
      if (targetLineRe.test(content)) return true;
      if (targetOrdinalBackRe.test(content)) return true;
      if (targetOrdinalFrontRe.test(content)) return true;
      return false;
    }

    function hasAnyQuestion(content: string): boolean {
      if (/(?:^|\n)\s*(?:question|q)\.?\s*(?:no\.?\s*)?\d+\b/i.test(content)) return true;
      if (/\b\d+(?:st|nd|rd|th)\s+(?:question|q)\b/i.test(content)) return true;
      return false;
    }

    function isPathMatch(ctx: StructuralContext): boolean {
      for (const [type, value] of Object.entries(requiredPath)) {
        if (value && ctx[type as keyof StructuralContext] !== value) return false;
      }
      return true;
    }

    // Find the first matching question block and collect it
    const resultChunks: typeof chunks = [];
    let insideBlock = false;

    for (const chunk of chunks) {
      const ctx = contextMap.get(chunk.chunk_index);

      if (insideBlock) {
        // Continue until next question marker
        if (hasAnyQuestion(chunk.content)) break;
        resultChunks.push(chunk);
      } else if (matchesTargetQuestion(chunk.content)) {
        // Check structural path via context map (full-document ancestry)
        if (ctx && isPathMatch(ctx)) {
          resultChunks.push(chunk);
          insideBlock = true;
        }
      }
    }

    console.log(
      `[ExactQuestionRetrieval] questionNumber=${questionNum} requiredPath=${JSON.stringify(requiredPath)} foundChunks=${resultChunks.length} totalChunks=${chunks.length}`
    );

    if (resultChunks.length > 0) {
      return {
        documentId,
        documentName: doc.name,
        originalFilename: doc.original_filename,
        chunks: resultChunks.map((c) => ({
          id: c.id,
          text: c.content,
          score: 1.0,
          pageNumber: c.page_number,
        })),
        totalChunks: chunks.length,
        confidence: "high",
        queryAnalysis: analysis,
        structuralMatch: "exact_match",
      };
    }

    // No match found — return empty result (NOT FOUND)
    return {
      documentId,
      documentName: doc.name,
      originalFilename: doc.original_filename,
      chunks: [],
      totalChunks: chunks.length,
      confidence: "none",
      queryAnalysis: analysis,
      structuralMatch: "no_match",
    };
  }

  // -----------------------------------------------------------------------
  // Scope query path — bypass scoring, use structural context map
  // -----------------------------------------------------------------------
  // When the query asks for ALL items within a structural scope (e.g.,
  // "what are questions in part b unit 4"), we use a full-document
  // structural context map instead of the sliding-window scoring pipeline.
  // This ensures ALL question blocks are returned, not just top-K.
  if (analysis.scopeQuery) {
    const contextMap = buildStructuralContextMap(chunks);

    // Extract scope from structural path
    const scope: { unit?: string | null; part?: string | null; chapter?: string | null; module?: string | null; section?: string | null } = {};
    for (const marker of analysis.entities.structuralPath) {
      switch (marker.type) {
        case "unit": scope.unit = marker.number; break;
        case "part": scope.part = marker.number; break;
        case "chapter": scope.chapter = marker.number; break;
        case "module": scope.module = marker.number; break;
        case "section": scope.section = marker.number; break;
      }
    }

    const scopeChunks = retrieveScopeChunks(chunks, contextMap, scope);

    console.log(
      `[ScopeRetrieval] scope=${JSON.stringify(scope)} foundChunks=${scopeChunks.length} totalChunks=${chunks.length}`
    );

    // Bound by character limit (more generous for scope queries)
    const SCOPE_MAX_CHARS = 24000;
    const SCOPE_MAX_CHUNKS = 20;
    const bounded: typeof scopeChunks = [];
    let totalChars = 0;
    for (const chunk of scopeChunks) {
      if (bounded.length >= SCOPE_MAX_CHUNKS) break;
      if (totalChars + chunk.content.length > SCOPE_MAX_CHARS && bounded.length > 0) break;
      bounded.push(chunk);
      totalChars += chunk.content.length;
    }

    return {
      documentId,
      documentName: doc.name,
      originalFilename: doc.original_filename,
      chunks: bounded.map((c) => ({
        id: c.id,
        text: c.content,
        score: 1.0,
        pageNumber: c.page_number,
      })),
      totalChunks: chunks.length,
      confidence: bounded.length > 0 ? "high" : "none",
      queryAnalysis: analysis,
      structuralMatch: bounded.length > 0 ? "exact_match" : "no_match",
    };
  }

  // Phase 5D.1: Pre-compute preceding content for each chunk
  // This gives the scorer hierarchy context (what section/chapter the chunk is in)
  const precedingContentMap = new Map<number, string>();
  {
    let accumulated = "";
    for (const chunk of chunks) {
      precedingContentMap.set(chunk.chunk_index, accumulated);
      // Keep a bounded window to avoid memory issues
      accumulated += "\n" + chunk.content;
      if (accumulated.length > 4000) {
        accumulated = accumulated.slice(-2000);
      }
    }
  }

  // Pre-compute token sets for all chunks
  const chunkTokenSets = buildChunkTokenSets(chunks);

  // Score all candidates using multi-signal scoring (with preceding context)
  const scored: ScoredChunk[] = chunks.map((chunk) =>
    scoreChunk(chunk, analysis, chunkTokenSets, precedingContentMap.get(chunk.chunk_index))
  );

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Phase 5D.1: If structural query, promote candidates with better structural match
  const hasStructuralQuery = analysis.entities.structuralPath.length > 0;
  let candidates: ScoredChunk[];

  if (hasStructuralQuery) {
    // Take initial candidates, then re-rank by structural match
    const initialCandidateCount = Math.min(
      Math.max(MIN_CANDIDATE_COUNT, Math.ceil(maxChunks * CANDIDATE_MULTIPLIER)),
      MAX_CANDIDATE_COUNT,
      scored.length
    );
    const initialCandidates = scored.slice(0, initialCandidateCount);

    // Promote structural matches
    candidates = promoteStructuralMatches(initialCandidates, analysis.entities.structuralPath);

    console.log(
      `[StructuralRetrieval] promoted candidates with structural match. Top candidate score=${candidates[0]?.score ?? 0} signals.hierarchicalStructural=${candidates[0]?.signals?.hierarchicalStructural ?? 0}`
    );
  } else {
    const candidateCount = Math.min(
      Math.max(MIN_CANDIDATE_COUNT, Math.ceil(maxChunks * CANDIDATE_MULTIPLIER)),
      MAX_CANDIDATE_COUNT,
      scored.length
    );
    candidates = scored.slice(0, candidateCount);
  }

  console.log(
    `[CandidateRetrieval] source=${doc.original_filename} candidateCount=${candidates.length} totalChunks=${chunks.length}`
  );

  // Adaptive adjacent expansion
  const expanded = expandAdjacentChunks(candidates, scored, adjacentExpansion);

  // Diversity filter
  const diverse = filterDuplicates(expanded);

  // Sort by score, take top chunks
  diverse.sort((a, b) => b.score - a.score);
  const bounded = boundContext(diverse, maxChunks, maxChars);

  // Re-sort by original chunk_index to preserve document order
  const indexMap = new Map(chunks.map((c, i) => [c.id, i]));
  bounded.sort(
    (a, b) => (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0)
  );

  // Score gap analysis
  const scoreGap = computeScoreGap(scored);

  // Determine confidence level
  const confidence = computeConfidence(scored, scoreGap);

  // Phase 5D.1: Structural validation
  const structuralMatch = hasStructuralQuery
    ? validateStructuralMatch(bounded, analysis.entities.structuralPath)
    : "exact_match";

  // Phase 5D.1: Log structural validation
  if (hasStructuralQuery) {
    const mismatchDetected = hasStructuralMismatch(bounded, analysis.entities.structuralPath);
    console.log(
      `[StructuralValidation] match=${structuralMatch} mismatch=${mismatchDetected} topCandidateStructural=${bounded[0]?.signals?.hierarchicalStructural ?? 0} queryMarkers=${analysis.entities.structuralPath.length}`
    );

    // If structural mismatch detected, try re-ranking with structural boost
    if (mismatchDetected && bounded.length > 1) {
      const reRanked = promoteStructuralMatches(bounded, analysis.entities.structuralPath);
      reRanked.sort((a, b) => b.score - a.score);
      const reBounded = boundContext(reRanked, maxChunks, maxChars);

      // If re-ranking found a better structural match, use it
      const newValidation = validateStructuralMatch(reBounded, analysis.entities.structuralPath);
      if (newValidation === "exact_match" && structuralMatch !== "exact_match") {
        console.log(
          `[StructuralRetrieval] re-ranking improved structural match from ${structuralMatch} to ${newValidation}`
        );
        // Re-sort by chunk order
        reBounded.sort(
          (a, b) => (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0)
        );
        return {
          documentId,
          documentName: doc.name,
          originalFilename: doc.original_filename,
          chunks: reBounded.map((c) => ({
            id: c.id,
            text: c.text,
            score: c.score,
            pageNumber: c.pageNumber,
            signals: c.signals,
          })),
          totalChunks: chunks.length,
          confidence: computeConfidence(reBounded, computeScoreGap(reBounded)),
          queryAnalysis: analysis,
          scoreGap: computeScoreGap(reBounded),
          structuralMatch: newValidation,
        };
      }
    }
  }

  console.log(
    `[RetrievalConfidence] confidence=${confidence} bestScore=${scoreGap.best} secondScore=${scoreGap.second} gap=${scoreGap.gap} structuralMatch=${structuralMatch}`
  );

  return {
    documentId,
    documentName: doc.name,
    originalFilename: doc.original_filename,
    chunks: bounded.map((c) => ({
      id: c.id,
      text: c.text,
      score: c.score,
      pageNumber: c.pageNumber,
      signals: c.signals,
    })),
    totalChunks: chunks.length,
    confidence,
    queryAnalysis: analysis,
    scoreGap,
    structuralMatch,
  };
}

// ---------------------------------------------------------------------------
// Confidence calculation
// ---------------------------------------------------------------------------

function computeConfidence(
  scored: ScoredChunk[],
  scoreGap: { best: number; second: number; gap: number; ratio: number }
): RetrievalConfidence {
  const best = scoreGap.best;
  if (best === 0) return "none";

  const bestChunk = scored[0];
  const hasStructural = bestChunk && bestChunk.signals.structuralRef > 0;
  const hasExactPhrase = bestChunk && bestChunk.signals.exactPhrase > 0;
  const hasPageMatch = bestChunk && bestChunk.signals.pageMatch > 0;
  // Phase 5D.1: Hierarchical structural match counts as high confidence
  const hasHierarchical = bestChunk && bestChunk.signals.hierarchicalStructural > 0;

  if (
    best >= CONFIDENCE_HIGH_THRESHOLD &&
    (scoreGap.gap >= CONFIDENCE_GAP_HIGH_MIN || hasStructural || hasExactPhrase || hasPageMatch || hasHierarchical)
  ) {
    return "high";
  }

  if (hasStructural || hasExactPhrase || hasHierarchical) {
    return "high";
  }

  if (best >= CONFIDENCE_MEDIUM_THRESHOLD) {
    return "medium";
  }

  if (best >= CONFIDENCE_LOW_THRESHOLD) {
    return "low";
  }

  return "none";
}

// ---------------------------------------------------------------------------
// Formatting (preserved + enhanced with signals)
// ---------------------------------------------------------------------------

export function formatRetrievalContext(result: RetrievalResult): string {
  const lines: string[] = [];

  for (let i = 0; i < result.chunks.length; i++) {
    const chunk = result.chunks[i];
    const pageInfo =
      chunk.pageNumber != null ? ` (page ${chunk.pageNumber})` : "";
    lines.push(`[Passage ${i + 1}${pageInfo}]:`);
    lines.push(chunk.text);
    lines.push("");
  }

  return lines.join("\n").trim();
}
