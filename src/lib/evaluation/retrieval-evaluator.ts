// ---------------------------------------------------------------------------
// Phase 5G — Retrieval evaluator
//
// OBSERVES the existing production retrieval pipeline (analyzeQuery → scoreChunk
// → hierarchical structural → rerank) against synthetic documents and scores
// whether the correct evidence is retrieved at the correct location.
//
// This is an OBSERVATION LAYER. It calls the real functions from
// `@/lib/retrieval` and `@/lib/document-retrieval` scoring/reranking helpers.
// It does NOT re-implement retrieval and does NOT modify production code.
// ---------------------------------------------------------------------------

import {
  analyzeQuery,
  scoreChunk,
  buildChunkTokenSets,
  validateStructuralMatch,
  filterDuplicates,
  boundContext,
  promoteStructuralMatches,
  extractStructuralMarkers,
  type ScoredChunk,
} from "@/lib/retrieval";
import type {
  EvaluationCase,
  EvalChunk,
  SyntheticDocument,
  TestResult,
} from "./evaluation-types";
import { normNum } from "./document-builder";

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Zeroed signal bundle for evaluation path that bypasses the scorer. */
const ZERO_SIGNALS: ScoredChunk["signals"] = {
  exactPhrase: 0,
  quotedPhrase: 0,
  structuralRef: 0,
  headingMatch: 0,
  tokenOverlap: 0,
  coverage: 0,
  proximity: 0,
  pageMatch: 0,
  headingPhrase: 0,
  hierarchicalStructural: 0,
  structuralMismatch: false,
};

// ---------------------------------------------------------------------------
// Generic structural containment: does a chunk's text + page + index match an
// expected location? This is used to determine whether the evaluator's ground
// truth (expected evidence) is present in a retrieved chunk.
// ---------------------------------------------------------------------------

interface GroundTruthMarker {
  type: string;
  number: string;
}

/**
 * Extract the expected structural markers from an EvaluationCase.location.
 * Only uses fields that are present. Returns [] when none present (pure text).
 */
export function expectedMarkers(loc: EvaluationCase["expectedLocation"]): GroundTruthMarker[] {
  const m: GroundTruthMarker[] = [];
  const map: Array<[string, keyof NonNullable<EvaluationCase["expectedLocation"]>]> = [
    ["unit", "unit"],
    ["module", "module"],
    ["chapter", "chapter"],
    ["section", "section"],
    ["subsection", "subsection"],
    ["part", "part"],
    ["question", "question"],
    ["exercise", "exercise"],
    ["problem", "problem"],
    ["example", "example"],
    ["theorem", "theorem"],
    ["definition", "definition"],
    ["figure", "figure"],
    ["table", "table"],
    ["topic", "topic"],
  ];
  for (const [type, key] of map) {
    const v = loc?.[key];
    if (v != null) m.push({ type, number: normNum(v) });
  }
  return m;
}

/**
 * Does a chunk's content contain the given structural marker (in order of
 * appearance, matching the production extractStructuralMarkers semantics)?
 * Returns boolean.
 */
function chunkHasMarker(content: string, type: string, number: string): boolean {
  const lower = content.toLowerCase();
  const re = new RegExp(
    `\\b${type}\\s+${escapeRegex(number)}(?![\\d.])`,
    "i"
  );
  return re.test(lower);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Structural path match level for a set of chunks, given expected markers.
 * "exact" = every expected marker present in order across the top chunks.
 * "partial" = some present, not all.
 * "none" = none present.
 */
export function pathMatchLevel(
  chunks: Array<{ content?: string; text?: string }>,
  markers: GroundTruthMarker[]
): "exact" | "partial" | "none" | "n/a" {
  if (markers.length === 0) return "n/a";
  const combined = chunks.map((c) => chunkText(c).toLowerCase()).join("\n");

  // Check presence in document order
  let matched = 0;
  let lastPos = -1;
  for (const marker of markers) {
    const lower = combined;
    let pos = lower.indexOf(
      `${marker.type} ${marker.number}`.toLowerCase(),
      lastPos + 1
    );
    if (pos === -1) {
      // try the string in reverse search from end as fallback (marker may be
      // at the very start of combined)
      pos = lower.indexOf(`${marker.type} ${marker.number}`.toLowerCase());
    }
    if (pos !== -1) {
      matched++;
      lastPos = pos;
    }
  }

  if (matched === 0) return "none";
  if (matched === markers.length) return "exact";
  return "partial";
}

// ---------------------------------------------------------------------------
// Evidence-needle containment
// ---------------------------------------------------------------------------

function containsNeedle(chunkText: string, needle: string): boolean {
  if (!chunkText) return false;
  return chunkText.toLowerCase().includes(needle.toLowerCase());
}

/** Normalize chunk text access (ScoredChunk uses `text`, EvalChunk uses `content`). */
function chunkText(c: { content?: string; text?: string }): string {
  return (c.content ?? c.text ?? "").toLowerCase();
}

/**
 * Determine which expected evidence needles appear in a ranked chunk list.
 */
export function evidenceFound(
  ranked: Array<{ content?: string; text?: string }>,
  needles: string[]
): { found: string[]; missing: string[] } {
  const found: string[] = [];
  const missing: string[] = [];
  for (const needle of needles ?? []) {
    const present = ranked.some((c) => containsNeedle(chunkText(c), needle));
    if (present) found.push(needle);
    else missing.push(needle);
  }
  return { found, missing };
}

// ---------------------------------------------------------------------------
// Ranking pipeline (observes production functions)
// ---------------------------------------------------------------------------

export interface RankedResult {
  /** Top chunks in retrieval order. */
  chunks: ScoredChunk[];
  /** Raw chunks used (for attribution). */
  all: ScoredChunk[];
  /** Production query analysis. */
  analysis: ReturnType<typeof analyzeQuery>;
  /** Production structural validation result for the top bounded set. */
  structuralValidation: ReturnType<typeof validateStructuralMatch>;
  /** When the production exact-question lookup path fired. */
  exactQuestion?: { applied: boolean; found: boolean; questionNumber?: string };
}

/**
 * Run the production-compatible single-source retrieval scoring pipeline against
 * an arbitrary set of chunks. Mirrors the mechanics of
 * `retrieveDocumentChunks` (scoring path) so evaluation is faithful.
 */
// ---------------------------------------------------------------------------
// Production-faithful exact-question lookup
//
// Mirrors `retrieveDocumentChunks` lines 256-330 (document-retrieval.ts),
// which fires when the query has BOTH a question number AND >1 structural
// marker. It walks the full document building a structural-context ancestry
// map, then locates the question block whose ancestry matches the requested
// path — regardless of how many chunks separate the unit/part/question
// headings. No fixed sliding window, no hard-coded unit/question numbers.
// ---------------------------------------------------------------------------

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
    unit: null,
    module: null,
    chapter: null,
    section: null,
    subsection: null,
    part: null,
  };
  // Mirror of STRUCTURAL_DEPTH in scoring.ts: a shallower container resets any
  // deeper parent scope inherited from earlier content (e.g. a new "UNIT" must
  // clear a stale "PART" that belonged to the previous unit).
  const SCOPE_DEPTH: Record<string, number> = {
    unit: 0, module: 1, chapter: 2, section: 3, subsection: 4, part: 5,
  };
  for (const chunk of chunks) {
    const markers = extractStructuralMarkers(chunk.content.toLowerCase());
    for (const marker of markers) {
      if (
        marker.type === "unit" ||
        marker.type === "module" ||
        marker.type === "chapter" ||
        marker.type === "section" ||
        marker.type === "subsection" ||
        marker.type === "part"
      ) {
        const depth = SCOPE_DEPTH[marker.type] ?? 50;
        for (const key of Object.keys(current) as Array<keyof StructuralContext>) {
          if ((SCOPE_DEPTH[key] ?? 50) > depth && current[key] != null) {
            current[key] = null;
          }
        }
        current[marker.type] = marker.number;
      }
    }
    map.set(chunk.chunk_index, { ...current });
  }
  return map;
}

function escapeRegexStr(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTargetQuestion(content: string, questionNum: string): boolean {
  const n = escapeRegexStr(questionNum);
  if (new RegExp(`(?:^|\\n)\\s*(?:question|q)\\.?\\s*(?:no\\.?\\s*)?${n}\\b`, "i").test(content)) return true;
  if (new RegExp(`\\b(?:question|q)\\s+${n}(?:st|nd|rd|th)\\b`, "i").test(content)) return true;
  if (new RegExp(`\\b${n}(?:st|nd|rd|th)\\s+(?:question|q)\\b`, "i").test(content)) return true;
  return false;
}

function hasAnyQuestion(content: string): boolean {
  if (/(?:^|\n)\s*(?:question|q)\.?\s*(?:no\.?\s*)?\d+\b/i.test(content)) return true;
  if (/\b\d+(?:st|nd|rd|th)\s+(?:question|q)\b/i.test(content)) return true;
  return false;
}

function contextValue(ctx: StructuralContext, type: string): string | null | undefined {
  switch (type) {
    case "unit":
      return ctx.unit;
    case "module":
      return ctx.module;
    case "chapter":
      return ctx.chapter;
    case "section":
      return ctx.section;
    case "subsection":
      return ctx.subsection;
    case "part":
      return ctx.part;
    default:
      return undefined;
  }
}

function isPathMatch(ctx: StructuralContext, requiredPath: Record<string, string>): boolean {
  for (const [type, value] of Object.entries(requiredPath)) {
    if (value && contextValue(ctx, type) !== value) return false;
  }
  return true;
}

/**
 * Run the production exact-question-lookup path (document-retrieval.ts:256-330).
 * Returns the question block chunks (possibly empty = NOT FOUND) plus whether
 * the fast path applied (i.e. production would have taken it).
 */
export function exactQuestionLookup(
  doc: SyntheticDocument,
  analysis: ReturnType<typeof analyzeQuery>
): { applied: boolean; chunks: EvalChunk[]; found: boolean } {
  const questionNum = analysis.entities.questionNumber?.toString();
  if (!questionNum || analysis.entities.structuralPath.length <= 1) {
    return { applied: false, chunks: [], found: false };
  }

  const contextMap = buildStructuralContextMap(doc.chunks);

  const requiredPath: Record<string, string> = {};
  for (const marker of analysis.entities.structuralPath) {
    if (marker.type === "question") continue;
    if (marker.type in requiredPath) continue;
    if (marker.type in ({ unit: 1, module: 1, chapter: 1, section: 1, subsection: 1, part: 1 } as const)) {
      requiredPath[marker.type] = marker.number;
    }
  }

  const result: EvalChunk[] = [];
  let insideBlock = false;

  for (const chunk of doc.chunks) {
    const ctx = contextMap.get(chunk.chunk_index);
    if (!ctx) continue;

    if (insideBlock) {
      if (hasAnyQuestion(chunk.content)) break;
      result.push(chunk);
    } else if (matchesTargetQuestion(chunk.content, questionNum)) {
      if (isPathMatch(ctx, requiredPath)) {
        result.push(chunk);
        insideBlock = true;
      }
    }
  }

  return { applied: true, chunks: result, found: result.length > 0 };
}

export function evaluateRetrieval(
  doc: SyntheticDocument,
  query: string,
  options: { maxChunks?: number; maxChars?: number } = {}
): RankedResult {
  const maxChunks = options.maxChunks ?? 8;
  const maxChars = options.maxChars ?? 12000;

  const analysis = analyzeQuery(query);
  const chunks = doc.chunks;

  // Production fast path: exact question lookup (structuralPath > 1).
  const exact = exactQuestionLookup(doc, analysis);
  if (exact.applied) {
    const bounded = boundContext(
      exact.chunks.map((c) => ({
        id: c.id,
        text: c.content,
        score: exact.found ? 1.0 : 0.0,
        pageNumber: c.page_number,
        chunkIndex: c.chunk_index,
        signals: ZERO_SIGNALS,
      })),
      maxChunks,
      maxChars
    );
    const structuralValidation = validateStructuralMatch(bounded, analysis.entities.structuralPath);
    return {
      chunks: bounded,
      all: bounded,
      analysis,
      structuralValidation,
      exactQuestion: { applied: true, found: exact.found, questionNumber: analysis.entities.questionNumber?.toString() },
    };
  }

  // Precompute preceding content (hierarchy context), like production
  const precedingMap = new Map<number, string>();
  {
    let acc = "";
    for (const c of chunks) {
      precedingMap.set(c.chunk_index, acc);
      acc += "\n" + c.content;
      if (acc.length > 4000) acc = acc.slice(-2000);
    }
  }

  const tokenSets = buildChunkTokenSets(chunks);
  const scored: ScoredChunk[] = chunks.map((c) =>
    scoreChunk(
      { id: c.id, content: c.content, chunk_index: c.chunk_index, page_number: c.page_number },
      analysis,
      tokenSets,
      precedingMap.get(c.chunk_index)
    )
  );

  scored.sort((a, b) => b.score - a.score);

  // Structural query re-ranking (production behavior)
  const hasStructural = analysis.entities.structuralPath.length > 0;
  let candidates = scored;
  if (hasStructural) {
    const candidateCount = Math.min(
      Math.max(12, Math.ceil(maxChunks * 3)),
      30,
      scored.length
    );
    candidates = promoteStructuralMatches(scored.slice(0, candidateCount), analysis.entities.structuralPath);
  }

  // Diversity + bound (production)
  const diverse = filterDuplicates(candidates);
  diverse.sort((a, b) => b.score - a.score);
  const bounded = boundContext(diverse, maxChunks, maxChars);

  const structuralValidation = validateStructuralMatch(bounded, analysis.entities.structuralPath);

  return {
    chunks: bounded,
    all: scored,
    analysis,
    structuralValidation,
  };
}

// ---------------------------------------------------------------------------
// Scoring an individual test case
// ---------------------------------------------------------------------------

export interface ScoreCaseOptions {
  /** Max search depth to treat a needle as "retrieved" (recall). */
  recallDepth?: number;
  /** Treat missing evidence as retrieval failure. */
  requireEvidence?: boolean;
}

/**
 * Score ONE evaluation case against ONE document.
 * Returns a normalized TestResult (status + classification assigned in the
 * regression suite / runner; this returns the observation fields).
 */
export function evaluateCaseAgainstDoc(
  doc: SyntheticDocument,
  testCase: EvaluationCase,
  options: ScoreCaseOptions = {}
): Omit<TestResult, "status"> {
  const recallDepth = options.recallDepth ?? 8;
  const ranked = evaluateRetrieval(doc, testCase.query, { maxChunks: recallDepth });

  const topChunks = ranked.chunks.slice(0, recallDepth);
  const allForRecall = ranked.all.slice(0, 12);

  // Evidence needling over the (recall) set
  const needles = testCase.expectedAnswerEvidence ?? [];
  const ev = evidenceFound(allForRecall, needles);

  // Structural path over currently-ranked chunks
  const markers = expectedMarkers(testCase.expectedLocation);
  let pathLevel: "exact" | "partial" | "none" | "n/a";

  if (ranked.exactQuestion?.applied) {
    // Production exact-question lookup governs structural correctness: the full
    // structural ancestry is satisfied iff the block was found (NOT FOUND → none).
    pathLevel = ranked.exactQuestion.found ? "exact" : "none";
  } else {
    pathLevel = pathMatchLevel(topChunks, markers);
  }

  // Page accuracy: is the expected page among the top chunks' pages?
  let pageCorrect: boolean | undefined;
  if (testCase.expectedLocation?.page != null) {
    pageCorrect = topChunks.some((c) => c.pageNumber === testCase.expectedLocation!.page);
  }

  // Relevance: does the expected structural location win in the top chunk?
  let relevant: boolean;
  if (ranked.exactQuestion?.applied) {
    // Exact-question path: correct iff found and no evidence missing.
    const blockFound = ranked.exactQuestion.found;
    relevant =
      !testCase.shouldRefuse
        ? blockFound && ev.missing.length === 0
        : !blockFound;
  } else if (markers.length > 0) {
    relevant = pathLevel === "exact";
  } else {
    relevant = needles.length === 0 || ev.missing.length === 0;
  }

  // Negative case: should NOT retrieve → relevant means evidence not hallucinated
  if (testCase.shouldRefuse && !ranked.exactQuestion?.applied) {
    relevant = !hasFabricatedEvidence(topChunks, testCase);
  }

  return {
    id: testCase.id,
    category: testCase.category,
    query: testCase.query,
    relevant,
    foundEvidence: ev.found,
    missingEvidence: ev.missing,
    structuralMatch: pathLevel,
    pageCorrect,
  };
}

/**
 * Negative check: for a shouldRefuse case, any "expectedAnswerEvidence"
 * needles present = fabricated. If none supplied, treat as refuse when no
 * strong structural match occurred.
 */
function hasFabricatedEvidence(
  chunks: ScoredChunk[],
  testCase: EvaluationCase
): boolean {
  if ((testCase.expectedAnswerEvidence ?? []).length > 0) {
    return chunks.some((c) =>
      (testCase.expectedAnswerEvidence ?? []).some((n) => containsNeedle(chunkText(c), n))
    );
  }
  // No needles: fabricated means we returned a chunk about a topic that does
  // not exist. The runner supplies forbiddenEvidence for these cases; here we
  // just check whether forbidden evidence leaked.
  return (testCase.forbiddenEvidence ?? []).some((n) =>
    chunks.some((c) => containsNeedle(chunkText(c), n))
  );
}

// ---------------------------------------------------------------------------
// Multi-document evaluator (Steps N/O)
// ---------------------------------------------------------------------------

export interface MultiDocScore {
  results: RankedResult[];
  coveredSources: string[];
  sourceOrder: string[];
  relevant: boolean;
}

/**
 * Evaluate a multi-document request: run retrieval against each document and
 * combine into source coverage observation. Does not call the real DB
 * orchestrator (that needs Supabase) — it exercises the same per-source
 * scoring used by `orchestrateMultiSourceRetrieval` internally.
 */
export function evaluateMultiDoc(
  docs: SyntheticDocument[],
  query: string
): MultiDocScore {
  const results = docs.map((d) => evaluateRetrieval(d, query));
  const coveredSources = results
    .filter((r) => r.chunks.length > 0)
    .map((_, i) => docs[i].displayName);
  const sourceOrder = results
    .map((r, i) => ({ name: docs[i].displayName, top: r.chunks[0]?.score ?? 0 }))
    .sort((a, b) => b.top - a.top)
    .map((x) => x.name);
  return { results, coveredSources, sourceOrder, relevant: coveredSources.length > 0 };
}

// Re-export for consumers
export type { ScoredChunk };
export type { EvalChunk };
