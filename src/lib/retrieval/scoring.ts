// ---------------------------------------------------------------------------
// Multi-signal chunk scoring engine — Phase 5C + Phase 5D.1
// Combines exact phrase, structural reference, heading, proximity, and
// coverage signals into a single deterministic relevance score.
// Phase 5D.1: Hierarchical structural matching with full-path validation.
// ---------------------------------------------------------------------------

import type { QueryAnalysis, StructuralMarker } from "./query-analyzer";
import { extractStructuralMarkers } from "./query-analyzer";

// ---------------------------------------------------------------------------
// Score weights (configurable)
// ---------------------------------------------------------------------------

export const SCORE_WEIGHTS = {
  exactPhrase: 120,
  quotedPhrase: 80,
  structuralRef: 100,
  headingMatch: 40,
  tokenOverlapBoundary: 8,
  tokenOverlap: 4,
  coverage: 30,
  proximity: 20,
  pageMatch: 150,
  questionNumberExact: 70,
  sectionNumberExact: 60,
  chapterNumberExact: 50,
  headingPhraseMatch: 35,
  // Phase 5D.1: Hierarchical structural scoring
  hierarchicalExactMatch: 200,
  hierarchicalPartialMatch: 80,
  structuralMarkerBonus: 40,
  structuralContextBonus: 30,
  structuralMismatchPenalty: -120,
} as const;

// ---------------------------------------------------------------------------
// Structural patterns
// ---------------------------------------------------------------------------

const NUMBERED_LINE_RE = /(?:^|\n)\s*(\d{1,3})\s*[.)]\s/;
const SECTION_HEADING_RE = /(?:^|\n)\s*(?:section|sec\.?)\s*(\d{1,3}(?:\.\d{1,3})?)\b/i;
const CHAPTER_HEADING_RE = /(?:^|\n)\s*(?:chapter|ch\.?)\s*(\d{1,3})\b/i;
const UNIT_HEADING_RE = /(?:^|\n)\s*(?:unit)\s*(\d{1,3})\b/i;
const MARKDOWN_HEADING_RE = /^#{1,6}\s/m;

// ---------------------------------------------------------------------------
// Core scoring signals
// ---------------------------------------------------------------------------

/**
 * Exact phrase match: chunk contains the full normalized query.
 */
export function scoreExactPhrase(query: string, contentLower: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  return contentLower.includes(q) ? SCORE_WEIGHTS.exactPhrase : 0;
}

/**
 * Quoted phrase match: chunk contains each quoted sub-phrase.
 */
export function scoreQuotedPhrases(
  quotedPhrases: string[],
  contentLower: string
): number {
  let score = 0;
  for (const phrase of quotedPhrases) {
    if (contentLower.includes(phrase)) {
      score += SCORE_WEIGHTS.quotedPhrase;
    }
  }
  return score;
}

/**
 * Page number match: chunk metadata matches the requested page.
 */
export function scorePageMatch(
  requestedPage: string | null,
  chunkPageNumber: number | null
): number {
  if (!requestedPage || chunkPageNumber === null) return 0;
  const target = Number.parseInt(requestedPage, 10);
  return chunkPageNumber === target ? SCORE_WEIGHTS.pageMatch : 0;
}

/**
 * Legacy structural reference matching (preserved for backward compatibility).
 * Enhanced with broader pattern matching.
 */
export function scoreStructuralRef(
  entities: QueryAnalysis["entities"],
  contentLower: string
): number {
  let score = 0;

  // Question number
  if (entities.questionNumber) {
    const num = entities.questionNumber;
    const patterns = [
      new RegExp(`(?:question|q)\\s*${num}\\b`, "i"),
      new RegExp(`\\b${num}\\.`),
      new RegExp(`\\b${num}\\)`),
      new RegExp(`\\b${num}\\s*:`),
    ];
    for (const pattern of patterns) {
      if (pattern.test(contentLower)) {
        score += SCORE_WEIGHTS.questionNumberExact;
        break;
      }
    }
  }

  // Section number
  if (entities.sectionNumber) {
    const secNum = entities.sectionNumber;
    if (
      SECTION_HEADING_RE.test(contentLower) &&
      contentLower.includes(secNum)
    ) {
      score += SCORE_WEIGHTS.sectionNumberExact;
    }
  }

  // Chapter number
  if (entities.chapterNumber) {
    const chNum = entities.chapterNumber;
    if (
      CHAPTER_HEADING_RE.test(contentLower) &&
      contentLower.includes(chNum)
    ) {
      score += SCORE_WEIGHTS.chapterNumberExact;
    }
  }

  // Unit number
  if (entities.unitNumber) {
    const unitNum = entities.unitNumber;
    if (UNIT_HEADING_RE.test(contentLower) && contentLower.includes(unitNum)) {
      score += SCORE_WEIGHTS.chapterNumberExact;
    }
  }

  // Part label
  if (entities.partLabel) {
    const partLabel = entities.partLabel;
    const partRe = new RegExp(`\\bpart\\s+${partLabel}\\b`, "i");
    if (partRe.test(contentLower)) {
      score += SCORE_WEIGHTS.chapterNumberExact;
    }
  }

  // Example number
  if (entities.exampleNumber) {
    const exNum = entities.exampleNumber;
    const exRe = new RegExp(`(?:example|ex\\.?)\\s*${exNum}\\b`, "i");
    if (exRe.test(contentLower)) {
      score += SCORE_WEIGHTS.questionNumberExact;
    }
  }

  // Module number
  if (entities.moduleNumber) {
    const modNum = entities.moduleNumber;
    const modRe = new RegExp(`\\bmodule\\s+${modNum}\\b`, "i");
    if (modRe.test(contentLower)) {
      score += SCORE_WEIGHTS.chapterNumberExact;
    }
  }

  // Figure number
  if (entities.figureNumber) {
    const figNum = entities.figureNumber;
    const figRe = new RegExp(`(?:figure|fig\\.?)\\s*${figNum}\\b`, "i");
    if (figRe.test(contentLower)) {
      score += SCORE_WEIGHTS.questionNumberExact;
    }
  }

  // Table number
  if (entities.tableNumber) {
    const tblNum = entities.tableNumber;
    const tblRe = new RegExp(`(?:table|tbl\\.?)\\s*${tblNum}\\b`, "i");
    if (tblRe.test(contentLower)) {
      score += SCORE_WEIGHTS.questionNumberExact;
    }
  }

  // Numbered line detection (e.g. "1.", "1)", "15.")
  if (NUMBERED_LINE_RE.test(contentLower)) {
    score += 10;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Phase 5D.1: Hierarchical structural matching
// ---------------------------------------------------------------------------

/**
 * Ordered by nesting depth — used for parent-to-child relationship checks.
 * A unit contains parts, which contain questions, etc.
 */
const STRUCTURAL_DEPTH: Record<string, number> = {
  unit: 0,
  module: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  part: 5,
  question: 10,
  exercise: 10,
  problem: 10,
  example: 10,
  theorem: 10,
  definition: 10,
  figure: 10,
  table: 10,
  topic: 10,
  page: 10,
};

const PARENT_TYPES = new Set(["unit", "module", "chapter", "section", "subsection", "part"]);

/**
 * Validates that query markers form a contiguous structural path within the
 * content context.  This is the CORE fix for the wrong-question bug.
 *
 * Instead of checking whether each marker exists *somewhere* in the context
 * (which allows markers from unrelated document regions to combine), this
 * function finds each leaf marker and walks backwards through the content to
 * verify that its parent markers appear in the correct nesting order with no
 * conflicting siblings between them.
 *
 * Example — query {unit:1, part:b, question:5}:
 *   VALID:   content has ...unit 1...part b...question 5 (no other unit/part between)
 *   INVALID: content has ...unit 1...part a...question 5...part b (wrong part)
 *   INVALID: content has ...unit 2...part b...question 5 (wrong unit between)
 */
export function validateStructuralPath(
  queryMarkers: StructuralMarker[],
  allContextMarkers: StructuralMarker[]
): boolean {
  if (queryMarkers.length === 0) return true;
  if (queryMarkers.length === 1) {
    // Single marker: just check it exists
    return allContextMarkers.some(
      (cm) => cm.type === queryMarkers[0].type && cm.number === queryMarkers[0].number
    );
  }

  // Separate into parents (containers) and leaves (target items)
  const parents = queryMarkers.filter((m) => PARENT_TYPES.has(m.type));
  const leaves = queryMarkers.filter((m) => !PARENT_TYPES.has(m.type));

  // Sort parents by depth (shallowest = broadest container first)
  const sortedParents = [...parents].sort(
    (a, b) => (STRUCTURAL_DEPTH[a.type] ?? 50) - (STRUCTURAL_DEPTH[b.type] ?? 50)
  );

  // For each leaf marker, validate its full ancestry
  for (const leaf of leaves) {
    // Find the LAST instance of this leaf in the context
    let leafIdx = -1;
    for (let i = allContextMarkers.length - 1; i >= 0; i--) {
      if (allContextMarkers[i].type === leaf.type && allContextMarkers[i].number === leaf.number) {
        leafIdx = i;
        break;
      }
    }
    if (leafIdx === -1) return false;

    // Walk backwards from the leaf, validating each parent in nesting order
    // (closest parent first — deepest container, then shallower ones)
    let currentIdx = leafIdx;
    for (let pi = sortedParents.length - 1; pi >= 0; pi--) {
      const parent = sortedParents[pi];

      // Find the closest instance of this parent BEFORE currentIdx
      let parentIdx = -1;
      for (let i = currentIdx - 1; i >= 0; i--) {
        if (allContextMarkers[i].type === parent.type && allContextMarkers[i].number === parent.number) {
          parentIdx = i;
          break;
        }
      }

      // Parent not found before the child — path is broken
      if (parentIdx === -1) return false;

      // Check for conflicting siblings between parent and child.
      // A conflicting sibling is a marker of the same type but different number
      // appearing between the parent and the leaf, meaning a different container
      // was opened before we reached the target.
      for (let i = parentIdx + 1; i < currentIdx; i++) {
        const sibling = allContextMarkers[i];
        if (sibling.type === parent.type && sibling.number !== parent.number) {
          return false;
        }
      }

      currentIdx = parentIdx;
    }
  }

  return true;
}

/**
 * Score a chunk based on hierarchical structural path matching.
 *
 * Phase 5D.1: Uses validateStructuralPath() to enforce that all structural
 * markers form a contiguous nesting hierarchy, not just independent existence.
 *
 * When the path is INVALID (markers come from unrelated document regions),
 * the score is forced to 0 regardless of other signals.
 */
export function scoreHierarchicalStructural(
  queryMarkers: StructuralMarker[],
  contentLower: string,
  precedingContentLower: string
): { score: number; matchLevel: "full" | "partial" | "none"; matchedMarkers: number } {
  if (queryMarkers.length === 0) {
    return { score: 0, matchLevel: "none", matchedMarkers: 0 };
  }

  // Extract structural markers from the chunk content
  const contentMarkers = extractStructuralMarkers(contentLower);
  // Also extract from preceding content (for hierarchy context)
  const precedingMarkers = extractStructuralMarkers(precedingContentLower);
  // Combined: preceding + current (preceding provides parent context)
  const allContextMarkers = [...precedingMarkers, ...contentMarkers];

  // ---- PATH VALIDATION (the critical check) ----
  // For multi-marker structural queries, verify the markers form a contiguous
  // path. If they don't, this chunk is at the wrong location — score = 0.
  const pathValid = validateStructuralPath(queryMarkers, allContextMarkers);

  if (!pathValid) {
    // Even though some markers may exist independently, they don't form a
    // valid structural path.  Return 0 to prevent this chunk from winning.
    return { score: 0, matchLevel: "none", matchedMarkers: 0 };
  }

  // ---- Markers form a valid path — now score how well ----
  const matchedCount = queryMarkers.length;

  // Compute hierarchy consistency bonus based on ordering
  let hierarchyBonus = 0;
  if (matchedCount >= 2) {
    const matchedIndices = queryMarkers.map((qm) => {
      return allContextMarkers.findIndex(
        (cm) => cm.type === qm.type && cm.number === qm.number
      );
    });
    let isOrdered = true;
    for (let i = 1; i < matchedIndices.length; i++) {
      if (matchedIndices[i] < matchedIndices[i - 1]) {
        isOrdered = false;
        break;
      }
    }
    if (isOrdered) {
      hierarchyBonus = SCORE_WEIGHTS.structuralContextBonus * (matchedCount - 1);
    }
  }

  const score = SCORE_WEIGHTS.hierarchicalExactMatch + hierarchyBonus;

  return { score, matchLevel: "full", matchedMarkers: matchedCount };
}

// ---------------------------------------------------------------------------
// Heading match
// ---------------------------------------------------------------------------

/**
 * Heading match: chunk starts with a markdown heading or ALL-CAPS heading
 * and the heading tokens overlap with query tokens.
 */
export function scoreHeadingMatch(
  content: string,
  queryTokens: Set<string>
): number {
  let score = 0;

  // Markdown heading
  if (MARKDOWN_HEADING_RE.test(content)) {
    const firstLine = content.split("\n")[0]?.toLowerCase() ?? "";
    const headingTokens = new Set(
      firstLine.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2)
    );
    let headingOverlap = 0;
    for (const token of queryTokens) {
      if (headingTokens.has(token)) headingOverlap++;
    }
    if (headingOverlap > 0) {
      score += SCORE_WEIGHTS.headingMatch + headingOverlap * 5;
    }
  }

  // ALL-CAPS heading (e.g. "NORMALIZATION")
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  if (/^[A-Z][A-Z\s]{2,}$/.test(firstLine) && firstLine.length < 80) {
    const headingTokens = new Set(
      firstLine.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2)
    );
    let headingOverlap = 0;
    for (const token of queryTokens) {
      if (headingTokens.has(token)) headingOverlap++;
    }
    if (headingOverlap > 0) {
      score += SCORE_WEIGHTS.headingMatch + headingOverlap * 5;
    }
  }

  // Phase 5D.1: Numbered heading match (e.g., "3.2 Subheading", "Unit III Part B")
  const numberedHeadingRe = /^[\s]*(?:(?:chapter|ch\.?|unit|module|section|part|topic)\s+[\divxlcdm]+(?:\.\d+)?)\s*[-:.]?\s*/im;
  if (numberedHeadingRe.test(content)) {
    score += 15; // Bonus for chunks that start with a structural heading
  }

  return score;
}

/**
 * Heading phrase match: entities contain an explicit heading reference.
 */
export function scoreHeadingPhrase(
  headingPhrases: string[],
  contentLower: string
): number {
  let score = 0;
  for (const phrase of headingPhrases) {
    if (contentLower.includes(phrase)) {
      score += SCORE_WEIGHTS.headingPhraseMatch;
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Token overlap and proximity
// ---------------------------------------------------------------------------

/**
 * Token overlap: how many important query tokens appear in the chunk.
 * Boundary matches (surrounded by spaces/start/end) score higher.
 */
export function scoreTokenOverlap(
  queryTokens: string[],
  chunkTokens: Set<string>,
  contentLower: string
): { score: number; matched: number; total: number } {
  let matched = 0;
  let score = 0;

  for (const token of queryTokens) {
    if (chunkTokens.has(token)) {
      matched++;
      if (
        contentLower.includes(` ${token} `) ||
        contentLower.startsWith(`${token} `) ||
        contentLower.endsWith(` ${token}`)
      ) {
        score += SCORE_WEIGHTS.tokenOverlapBoundary;
      } else {
        score += SCORE_WEIGHTS.tokenOverlap;
      }
    }
  }

  return { score, matched, total: queryTokens.length };
}

/**
 * Query coverage: ratio of matched important tokens to total important tokens.
 */
export function scoreCoverage(matched: number, total: number): number {
  if (total === 0) return 0;
  const coverage = matched / total;
  return Math.round(coverage * SCORE_WEIGHTS.coverage);
}

/**
 * Term proximity: measures how close query terms appear to each other in
 * the chunk. Terms that appear near each other get a higher score.
 */
export function scoreTermProximity(
  queryTokens: string[],
  contentLower: string
): number {
  if (queryTokens.length < 2) return 0;

  const positions: number[][] = [];
  for (const token of queryTokens) {
    const tokenPositions: number[] = [];
    let idx = contentLower.indexOf(token);
    while (idx !== -1 && tokenPositions.length < 5) {
      tokenPositions.push(idx);
      idx = contentLower.indexOf(token, idx + 1);
    }
    positions.push(tokenPositions);
  }

  if (positions.some((p) => p.length === 0)) return 0;

  let minSpan = Infinity;
  const allPositions: Array<{ tokenIdx: number; pos: number }> = [];
  for (let i = 0; i < positions.length; i++) {
    for (const p of positions[i]) {
      allPositions.push({ tokenIdx: i, pos: p });
    }
  }
  allPositions.sort((a, b) => a.pos - b.pos);

  const tokenSeen = new Set<number>();
  let left = 0;
  for (let right = 0; right < allPositions.length; right++) {
    tokenSeen.add(allPositions[right].tokenIdx);
    while (tokenSeen.size === queryTokens.length) {
      const span = allPositions[right].pos - allPositions[left].pos;
      if (span < minSpan) minSpan = span;
      tokenSeen.delete(allPositions[left].tokenIdx);
      left++;
    }
  }

  if (minSpan === Infinity || minSpan === 0) return 0;

  const maxUsefulSpan = 500;
  const normalizedSpan = Math.min(minSpan / maxUsefulSpan, 1);
  return Math.round(SCORE_WEIGHTS.proximity * (1 - normalizedSpan));
}

// ---------------------------------------------------------------------------
// Composite scorer
// ---------------------------------------------------------------------------

export interface ScoredChunk {
  id: string;
  text: string;
  score: number;
  pageNumber: number | null;
  chunkIndex: number;
  signals: {
    exactPhrase: number;
    quotedPhrase: number;
    structuralRef: number;
    headingMatch: number;
    tokenOverlap: number;
    coverage: number;
    proximity: number;
    pageMatch: number;
    headingPhrase: number;
    hierarchicalStructural: number;
    structuralMismatch: boolean;
  };
}

/**
 * Scores a single chunk against a query analysis.
 * Phase 5D.1: Includes hierarchical structural matching.
 */
export function scoreChunk(
  chunk: { id: string; content: string; chunk_index: number; page_number: number | null },
  analysis: QueryAnalysis,
  chunkTokenSets: Map<number, Set<string>>,
  precedingContent?: string
): ScoredChunk {
  const contentLower = chunk.content.toLowerCase();
  const chunkTokens =
    chunkTokenSets.get(chunk.chunk_index) ??
    new Set(tokenizeContent(chunk.content));

  // Phase 5D.1: Hierarchical structural scoring
  const precedingLower = (precedingContent ?? "").toLowerCase();
  const hierarchical = scoreHierarchicalStructural(
    analysis.entities.structuralPath,
    contentLower,
    precedingLower
  );

  const signals = {
    exactPhrase: scoreExactPhrase(analysis.normalizedQuery, contentLower),
    quotedPhrase: scoreQuotedPhrases(analysis.entities.quotedPhrases, contentLower),
    structuralRef: scoreStructuralRef(analysis.entities, contentLower),
    headingMatch: scoreHeadingMatch(chunk.content, new Set(analysis.importantTokens)),
    tokenOverlap: 0,
    coverage: 0,
    proximity: 0,
    pageMatch: scorePageMatch(analysis.entities.pageNumber, chunk.page_number),
    headingPhrase: scoreHeadingPhrase(analysis.entities.headingPhrases, contentLower),
    hierarchicalStructural: hierarchical.score,
    structuralMismatch: hierarchical.matchLevel === "none" && analysis.entities.structuralPath.length > 0 && hierarchical.matchedMarkers === 0,
  };

  const overlap = scoreTokenOverlap(
    analysis.importantTokens,
    chunkTokens,
    contentLower
  );
  signals.tokenOverlap = overlap.score;
  signals.coverage = scoreCoverage(overlap.matched, overlap.total);
  signals.proximity = scoreTermProximity(analysis.importantTokens, contentLower);

  const totalScore =
    signals.exactPhrase +
    signals.quotedPhrase +
    signals.structuralRef +
    signals.headingMatch +
    signals.tokenOverlap +
    signals.coverage +
    signals.proximity +
    signals.pageMatch +
    signals.headingPhrase +
    signals.hierarchicalStructural;

  return {
    id: chunk.id,
    text: chunk.content,
    score: totalScore,
    pageNumber: chunk.page_number,
    chunkIndex: chunk.chunk_index,
    signals,
  };
}

// ---------------------------------------------------------------------------
// Helper: tokenize a chunk's content for reuse across scoring
// ---------------------------------------------------------------------------

function tokenizeContent(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Pre-computes token sets for a batch of chunks.
 * Call once per retrieval to avoid re-tokenizing during scoring.
 */
export function buildChunkTokenSets(
  chunks: Array<{ content: string; chunk_index: number }>
): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  for (const chunk of chunks) {
    map.set(chunk.chunk_index, new Set(tokenizeContent(chunk.content)));
  }
  return map;
}
