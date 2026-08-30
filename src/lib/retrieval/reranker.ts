// ---------------------------------------------------------------------------
// Reranker — adjacent expansion, diversity filter, multi-source normalization,
// and structural validation. Phase 5C + Phase 5D.1.
// ---------------------------------------------------------------------------

import type { ScoredChunk } from "./scoring";
import { validateStructuralPath } from "./scoring";
import type { StructuralMarker } from "./query-analyzer";
import { extractStructuralMarkers } from "./query-analyzer";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ADJACENCY_MAX_EXPANSION = 1;
const DIVERSITY_OVERLAP_THRESHOLD = 0.7;
const SOURCE_NORMALIZATION_FLOOR = 0.3;

// ---------------------------------------------------------------------------
// Adjacent chunk expansion (hierarchy-aware — Phase 5D.1)
// ---------------------------------------------------------------------------

/**
 * Expands selected chunks with adjacent context when it improves continuity.
 * Phase 5D.1: Hierarchy-aware — prefers expanding within the same structural
 * section and avoids crossing unrelated structural boundaries.
 */
export function expandAdjacentChunks(
  selected: ScoredChunk[],
  allChunks: ScoredChunk[],
  maxExpansion: number = ADJACENCY_MAX_EXPANSION
): ScoredChunk[] {
  const indexMap = new Map(allChunks.map((c) => [c.chunkIndex, c]));
  const allIndices = new Set(allChunks.map((c) => c.chunkIndex));
  const selectedIndices = new Set(selected.map((c) => c.chunkIndex));
  const resultIndices = new Set(selected.map((c) => c.chunkIndex));

  for (const chunk of selected) {
    const shouldExpand = shouldExpandAdjacent(chunk, selected, allChunks);
    if (!shouldExpand) continue;

    for (let offset = -maxExpansion; offset <= maxExpansion; offset++) {
      if (offset === 0) continue;
      const idx = chunk.chunkIndex + offset;
      if (!allIndices.has(idx) || selectedIndices.has(idx)) continue;

      // Phase 5D.1: Hierarchy-aware expansion check
      const adjacentChunk = indexMap.get(idx);
      if (adjacentChunk && !wouldCrossStructuralBoundary(chunk, adjacentChunk)) {
        resultIndices.add(idx);
      }
    }
  }

  const result: ScoredChunk[] = [];
  for (const idx of resultIndices) {
    const chunk = indexMap.get(idx);
    if (chunk) {
      result.push({
        ...chunk,
        score: selectedIndices.has(idx)
          ? chunk.score
          : chunk.score * 0.5 + 1,
      });
    }
  }

  return result;
}

/**
 * Phase 5D.1: Check if expanding to an adjacent chunk would cross a major
 * structural boundary (e.g., jumping from Chapter 3 to Chapter 4).
 */
function wouldCrossStructuralBoundary(
  current: ScoredChunk,
  adjacent: ScoredChunk
): boolean {
  const currentMarkers = extractStructuralMarkers(current.text);
  const adjacentMarkers = extractStructuralMarkers(adjacent.text);

  // If both have structural markers, check for boundary crossing
  if (currentMarkers.length > 0 && adjacentMarkers.length > 0) {
    // Get the "parent" structural types (unit, chapter, module)
    const parentTypes = new Set(["unit", "module", "chapter"]);
    const currentParents = currentMarkers.filter((m) => parentTypes.has(m.type));
    const adjacentParents = adjacentMarkers.filter((m) => parentTypes.has(m.type));

    // If adjacent has a different parent marker, it's a boundary crossing
    if (currentParents.length > 0 && adjacentParents.length > 0) {
      for (const cp of currentParents) {
        for (const ap of adjacentParents) {
          if (cp.type === ap.type && cp.number !== ap.number) {
            return true; // Different chapter/unit = boundary crossing
          }
        }
      }
    }
  }

  return false;
}

function shouldExpandAdjacent(
  chunk: ScoredChunk,
  selected: ScoredChunk[],
  allChunks: ScoredChunk[]
): boolean {
  if (chunk.text.length < 200) return true;

  const trimmed = chunk.text.trimEnd();
  if (!/[.!?:]\s*$/.test(trimmed)) return true;

  if (/\b(?:question|q)\s*\d+/i.test(chunk.text)) return true;

  const nextChunk = allChunks.find((c) => c.chunkIndex === chunk.chunkIndex + 1);
  if (nextChunk && nextChunk.score > 0) {
    const nextScoreRatio = nextChunk.score / Math.max(chunk.score, 1);
    if (nextScoreRatio > 0.4) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Diversity / duplicate filter
// ---------------------------------------------------------------------------

export function filterDuplicates(chunks: ScoredChunk[]): ScoredChunk[] {
  const result: ScoredChunk[] = [];

  for (const chunk of chunks) {
    const chunkTokens = new Set(
      chunk.text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2)
    );

    let isDuplicate = false;
    for (const existing of result) {
      const existingTokens = new Set(
        existing.text
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((t) => t.length >= 2)
      );

      const overlap = computeJaccardSimilarity(chunkTokens, existingTokens);
      if (overlap >= DIVERSITY_OVERLAP_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      result.push(chunk);
    }
  }

  return result;
}

function computeJaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Multi-source reranking with normalization
// ---------------------------------------------------------------------------

export function rerankMultiSource(
  chunks: ScoredChunk[],
  sourceMap: Map<string, { sourceId: string; sourceName: string; sourceType: string }>
): ScoredChunk[] {
  if (chunks.length === 0) return chunks;

  const bySource = new Map<string, ScoredChunk[]>();
  for (const chunk of chunks) {
    const source = sourceMap.get(chunk.id);
    if (!source) continue;
    const existing = bySource.get(source.sourceId) ?? [];
    existing.push(chunk);
    bySource.set(source.sourceId, existing);
  }

  let globalMax = 0;
  for (const chunk of chunks) {
    if (chunk.score > globalMax) globalMax = chunk.score;
  }
  if (globalMax === 0) return chunks;

  const normalized: ScoredChunk[] = [];
  for (const [, sourceChunks] of bySource) {
    const sourceMax = Math.max(...sourceChunks.map((c) => c.score));
    if (sourceMax === 0) {
      normalized.push(...sourceChunks);
      continue;
    }

    for (const chunk of sourceChunks) {
      const crossSourceNorm = sourceMax / globalMax;
      const dampening = Math.max(SOURCE_NORMALIZATION_FLOOR, crossSourceNorm);
      normalized.push({
        ...chunk,
        score: Math.round(chunk.score * (0.6 + 0.4 * dampening)),
      });
    }
  }

  normalized.sort((a, b) => b.score - a.score);
  return normalized;
}

// ---------------------------------------------------------------------------
// Context bounding
// ---------------------------------------------------------------------------

export function boundContext(
  chunks: ScoredChunk[],
  maxChunks: number = 8,
  maxChars: number = 12000
): ScoredChunk[] {
  const result: ScoredChunk[] = [];
  let totalChars = 0;

  for (const chunk of chunks) {
    if (result.length >= maxChunks) break;
    if (totalChars + chunk.text.length > maxChars && result.length > 0) break;
    result.push(chunk);
    totalChars += chunk.text.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Score gap analysis
// ---------------------------------------------------------------------------

export function computeScoreGap(chunks: ScoredChunk[]): {
  best: number;
  second: number;
  gap: number;
  ratio: number;
} {
  const sorted = [...chunks].sort((a, b) => b.score - a.score);
  const best = sorted[0]?.score ?? 0;
  const second = sorted[1]?.score ?? 0;
  return {
    best,
    second,
    gap: best - second,
    ratio: second > 0 ? best / second : best > 0 ? Infinity : 0,
  };
}

// ---------------------------------------------------------------------------
// Phase 5D.1: Structural validation
// ---------------------------------------------------------------------------

export type StructuralValidationResult = "exact_match" | "partial_match" | "no_match";

/**
 * Phase 5D.1: Validate that a set of candidate chunks matches the requested
 * structural location. This is the core fix for the "wrong passage" bug.
 *
 * When a user specifies a structural reference (e.g., "unit 3 question 5"),
 * this function checks whether the top candidates actually contain that
 * structure — not just any passage with similar keywords.
 *
 * Returns:
 * - "exact_match": top candidate(s) match the full structural path
 * - "partial_match": some structural markers match but not all
 * - "no_match": no structural markers match (the requested location may not exist)
 */
export function validateStructuralMatch(
  candidates: ScoredChunk[],
  queryMarkers: StructuralMarker[]
): StructuralValidationResult {
  if (queryMarkers.length === 0 || candidates.length === 0) {
    return queryMarkers.length === 0 ? "exact_match" : "no_match";
  }

  // Check the top candidate using PATH validation (not independent matching)
  const topCandidate = candidates[0];
  const contentMarkers = extractStructuralMarkers(topCandidate.text.toLowerCase());
  const pathValid = validateStructuralPath(queryMarkers, contentMarkers);

  if (pathValid) {
    return "exact_match";
  }

  // Check if at least some markers exist (partial path)
  let matchedCount = 0;
  for (const qm of queryMarkers) {
    if (contentMarkers.some((cm) => cm.type === qm.type && cm.number === qm.number)) {
      matchedCount++;
    }
  }

  if (matchedCount >= 1 && matchedCount < queryMarkers.length) {
    return "partial_match";
  }

  return "no_match";
}

/**
 * Phase 5D.1: When structural validation fails, attempt to re-rank candidates
 * by structural match score alone. This handles cases where the hierarchical
 * scoring put the right candidate slightly below others.
 *
 * Returns re-ranked candidates with structural matches promoted.
 */
export function promoteStructuralMatches(
  candidates: ScoredChunk[],
  queryMarkers: StructuralMarker[]
): ScoredChunk[] {
  if (queryMarkers.length === 0 || candidates.length <= 1) return candidates;

  const scored = candidates.map((c) => {
    const contentMarkers = extractStructuralMarkers(c.text.toLowerCase());

    // Only boost when the full structural path is valid
    const pathValid = validateStructuralPath(queryMarkers, contentMarkers);
    const structuralBoost = pathValid ? queryMarkers.length * 100 : 0;

    return { ...c, score: c.score + structuralBoost, matchCount: pathValid ? queryMarkers.length : 0 };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Phase 5D.1: Check if any candidate in the list has a structural mismatch
 * (same structural type, different number). This indicates the retrieved
 * content is at the WRONG location.
 */
export function hasStructuralMismatch(
  candidates: ScoredChunk[],
  queryMarkers: StructuralMarker[]
): boolean {
  if (queryMarkers.length === 0 || candidates.length === 0) return false;

  const topCandidate = candidates[0];
  const contentMarkers = extractStructuralMarkers(topCandidate.text.toLowerCase());

  // Check for invalid structural path (the primary mismatch signal)
  if (!validateStructuralPath(queryMarkers, contentMarkers)) {
    return true;
  }

  const PARENT_TYPES = new Set(["unit", "module", "chapter", "section", "part"]);

  for (const qm of queryMarkers) {
    const sameTypeDifferent = contentMarkers.find(
      (cm) => cm.type === qm.type && cm.number !== qm.number
    );
    if (sameTypeDifferent) return true;

    // Also detect missing parent markers in hierarchical queries
    if (queryMarkers.length >= 2 && PARENT_TYPES.has(qm.type)) {
      const parentFound = contentMarkers.some(
        (cm) => cm.type === qm.type && cm.number === qm.number
      );
      if (!parentFound) return true;
    }
  }

  return false;
}
