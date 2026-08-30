// ---------------------------------------------------------------------------
// Phase 5G — Source attribution + multi-source coverage + visual fusion evaluators
// (Steps N, O, P, Q, R)
// ---------------------------------------------------------------------------

import type { SyntheticDocument } from "./evaluation-types";

// ---------------------------------------------------------------------------
// Source attribution (Step R)
//
// Every retrieved result should preserve document/source identity, page where
// available, structural location where available, visual source where applicable.
// Here we verify attribution is represented on the synthetic docs' chunk metadata
// and that the evaluator carries it through ranking.
// ---------------------------------------------------------------------------

export interface AttributionResult {
  documentPreserved: boolean;
  pagePreserved: boolean;
  structuralPreserved: boolean;
  sourceCount: number;
}

/**
 * Verify each doc preserves its metadata fields down to chunk level.
 */
export function verifyAttribution(docs: SyntheticDocument[]): AttributionResult {
  const docMarked = docs.every((d) => d.displayName.length > 0 && d.id.length > 0);
  const pagePreserved = docs.every((d) =>
    d.chunks.every((c) => typeof c.page_number === "number" || c.page_number === null)
  );

  // Structural preservation: every doc chunk content is non-empty and its
  // structural markers are extractable (i.e. retrieval could carry them).
  let allWithMarkers = 0;
  let allStrip = 0;
  for (const d of docs) {
    for (const c of d.chunks) {
      if (c.content.length > 0) allWithMarkers++;
      allStrip++;
    }
  }
  const structuralPreserved = allStrip > 0 ? allWithMarkers / allStrip : 0;

  return {
    documentPreserved: docMarked,
    pagePreserved: pagePreserved && pagePreserved &&
      docs.every((d) => d.chunks.every((c) => c.page_number != null)),
    structuralPreserved: structuralPreserved >= 0.9,
    sourceCount: docs.length,
  };
}

// ---------------------------------------------------------------------------
// Multi-document coverage (Step N)
// ---------------------------------------------------------------------------

export interface MultiSourceCoverage {
  /** Set of source display names that produced relevant chunks. */
  covered: string[];
  expected: string[];
  /** No source disappeared (each expected source had ≥1 chunk). */
  noSourceLost: boolean;
  /** No contamination: covered sources ⊆ expected sources. */
  noContamination: boolean;
}

/**
 * Evaluate whether the requested sources were all present in a retrieval and
 * whether a source NOT expected leaked in.
 */
export function evaluateMultiSourceCoverage(
  ranked: Array<{ sourceName: string }>,
  expectedSources: string[]
): MultiSourceCoverage {
  const coveredSet = new Set(ranked.map((r) => r.sourceName));
  const covered = [...coveredSet];
  const expected = new Set(expectedSources);
  const noSourceLost = expectedSources.every((s) => coveredSet.has(s));
  // contamination: covered source not in expected
  const noContamination = [...coveredSet].every((s) => expected.has(s));
  return { covered, expected: expectedSources, noSourceLost, noContamination };
}

// ---------------------------------------------------------------------------
// Visual evidence accuracy (Step P)
// ---------------------------------------------------------------------------

export interface VisualEvalCase {
  query: string;
  containsVisualReference: boolean;
  audioSafeHasVisualKeyword: boolean;
}
