// ---------------------------------------------------------------------------
// Phase 5G — Structural path validation evaluator (Step 6)
//
// Evaluates the hierarchy as a PATH, not independent markers. A query path like
// {unit:4, part:b, section:2, question:5} must NOT match {unit:3, part:b,
// section:2, question:5} even if the text is semantically similar.
//
// This validates the PRODUCTION functions:
//   - extractStructuralMarkers()
//   - validateStructuralPath()
//   - scoreHierarchicalStructural()
// ---------------------------------------------------------------------------

import {
  extractStructuralMarkers,
  scoreHierarchicalStructural,
  validateStructuralPath,
  type StructuralMarker,
} from "@/lib/retrieval";
import { normNum } from "./document-builder";

export type PathVerdict = "match" | "no_match" | "partial";

export interface PathEvalCase {
  id: string;
  queryMarkers: StructuralMarker[];
  content: string;
  precedingContent: string;
  expected: PathVerdict;
  description: string;
}

/**
 * Run one structural path evaluation against the production validators.
 * Returns Pass/Fail whether the production function agreed with the ground
 * truth (expected) verdict.
 */
export function evaluateStructuralPath(test: PathEvalCase): {
  verdict: PathVerdict;
  pass: boolean;
  explain: string;
} {
  // Content markers extracted from content + preceding (like production)
  const contentMarkers = extractStructuralMarkers(test.content.toLowerCase());
  const precedingMarkers = extractStructuralMarkers(test.precedingContent.toLowerCase());
  const allContext = [...precedingMarkers, ...contentMarkers];

  const pathValid = validateStructuralPath(test.queryMarkers, allContext);
  const hier = scoreHierarchicalStructural(
    test.queryMarkers,
    test.content.toLowerCase(),
    test.precedingContent.toLowerCase()
  );

  // Production verdict:
  // - pathValid && hier.score>0  => full match
  // - !pathValid                => no_match
  // - pathValid but partial matching => partial (rarely emitted by score fn)
  let verdict: PathVerdict;
  if (pathValid && hier.matchLevel === "full") {
    verdict = "match";
  } else if (!pathValid) {
    verdict = "no_match";
  } else {
    verdict = "partial";
  }

  const pass = verdict === test.expected;

  return {
    verdict,
    pass,
    explain: `expected=${test.expected} got=${verdict} pathValid=${pathValid} hierarchical=${hier.score} matchedMarkers=${hier.matchedMarkers}`,
  };
}

/**
 * Build a full structural marker equality check (used in cross-case tests).
 */
export function markersEqual(
  a: StructuralMarker[],
  b: StructuralMarker[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type || normNum(a[i].number) !== normNum(b[i].number)) {
      return false;
    }
  }
  return true;
}

// Re-export normNum for convenience
export { normNum };
