// ---------------------------------------------------------------------------
// Retrieval module — Phase 5C + Phase 5D.1 barrel exports
// ---------------------------------------------------------------------------

export {
  analyzeQuery,
  normalizeQuery,
  tokenizeImportant,
  tokenizeAll,
  extractEntities,
  extractStructuralMarkers,
  type QueryAnalysis,
  type QueryIntent,
  type ExtractedEntities,
  type StructuralMarker,
  type StructuralMarkerType,
} from "./query-analyzer";

export {
  scoreChunk,
  scoreExactPhrase,
  scoreQuotedPhrases,
  scorePageMatch,
  scoreStructuralRef,
  scoreHierarchicalStructural,
  validateStructuralPath,
  scoreHeadingMatch,
  scoreHeadingPhrase,
  scoreTokenOverlap,
  scoreCoverage,
  scoreTermProximity,
  buildChunkTokenSets,
  SCORE_WEIGHTS,
  type ScoredChunk,
} from "./scoring";

export {
  expandAdjacentChunks,
  filterDuplicates,
  rerankMultiSource,
  boundContext,
  computeScoreGap,
  validateStructuralMatch,
  promoteStructuralMatches,
  hasStructuralMismatch,
  type StructuralValidationResult,
} from "./reranker";

// ---------------------------------------------------------------------------
// Retrieval failure states
// ---------------------------------------------------------------------------

export type RetrievalFailureState =
  | "NO_SOURCE"
  | "SOURCE_NOT_READY"
  | "NO_MATCH"
  | "LOW_CONFIDENCE"
  | "STRUCTURAL_MISMATCH"
  | "SUCCESS";

/**
 * Classifies the retrieval outcome into a failure state.
 * Phase 5D.1: Adds STRUCTURAL_MISMATCH state.
 */
export function classifyRetrievalState(
  hasSource: boolean,
  isSourceReady: boolean,
  bestScore: number,
  confidence: "high" | "medium" | "low" | "none",
  structuralMatch?: "exact_match" | "partial_match" | "no_match"
): RetrievalFailureState {
  if (!hasSource) return "NO_SOURCE";
  if (!isSourceReady) return "SOURCE_NOT_READY";

  // Phase 5D.1: Structural validation
  if (structuralMatch === "no_match" && confidence !== "high") {
    return "STRUCTURAL_MISMATCH";
  }

  if (confidence === "none") return "NO_MATCH";
  if (confidence === "low") return "LOW_CONFIDENCE";
  return "SUCCESS";
}

/**
 * Returns a user-friendly explanation for a retrieval failure state.
 */
export function explainRetrievalFailure(state: RetrievalFailureState): string {
  switch (state) {
    case "NO_SOURCE":
      return "No document source was attached to this conversation.";
    case "SOURCE_NOT_READY":
      return "The attached document is still being processed. Please try again shortly.";
    case "NO_MATCH":
      return "I couldn't find any relevant information in the attached source for your question.";
    case "LOW_CONFIDENCE":
      return "I found some potentially relevant information, but I'm not fully confident it answers your question.";
    case "STRUCTURAL_MISMATCH":
      return "I found content in the document, but it doesn't match the specific section or location you referenced. The requested location may not exist in this document, or it may be labeled differently.";
    case "SUCCESS":
      return "";
  }
}
