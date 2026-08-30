// ---------------------------------------------------------------------------
// Phase 5G — Failure classification (Steps 8, 11, 12)
//
// Every failed evaluation receives exactly ONE primary classification. The
// classifier uses observation to separate:
//   - INGESTION_FAILURE     document wasn't processed (evidence missing)
//   - CHUNKING_FAILURE      chunks lost structural info
//   - QUERY_ANALYSIS_FAILURE query mis-analyzed
//   - STRUCTURAL_RETRIEVAL_FAILURE  right doc, wrong structural location
//   - SEMANTIC_RETRIEVAL_FAILURE     right doc, semantically wrong passage
//   - RERANKING_FAILURE     correct chunk ranked too low
//   - SOURCE_SELECTION_FAILURE  needed source excluded
//   - MULTI_SOURCE_FAILURE  multi-source lost a source
//   - VISUAL_RETRIEVAL_FAILURE visual evidence not retrieved
//   - GROUNDING_FAILURE     hallucinated content / no refusal
//   - GENERATION_FAILURE    retrieval correct but answer wrong
//   - AUTH_FAILURE / CACHE_FAILURE / STREAMING_FAILURE  (infra)
//   - UNKNOWN
// ---------------------------------------------------------------------------

import type {
  EvaluationCase,
  FailureClassification,
  SyntheticDocument,
} from "./evaluation-types";
import { pathMatchLevel, expectedMarkers, evidenceFound } from "./retrieval-evaluator";

export interface ClassificationInput {
  testCase: EvaluationCase;
  doc: SyntheticDocument | null;
  rankedContent: string[];
  debug?: string;
}

const LOCATION_BY_CLASS: Record<FailureClassification, string> = {
  INGESTION_FAILURE: "document-processing / extraction",
  CHUNKING_FAILURE: "document-processing / chunking",
  QUERY_ANALYSIS_FAILURE: "retrieval/query-analyzer.ts → analyzeQuery()/extractEntities()",
  STRUCTURAL_RETRIEVAL_FAILURE: "retrieval/scoring.ts + document-retrieval.ts exact/scope paths",
  SEMANTIC_RETRIEVAL_FAILURE: "retrieval/scoring.ts → scoreChunk()/token overlap",
  RERANKING_FAILURE: "retrieval/reranker.ts + document-retrieval.ts rerank",
  SOURCE_SELECTION_FAILURE: "agent/source-selector.ts / source-intent.ts",
  MULTI_SOURCE_FAILURE: "agent/multi-source.ts → orchestrateMultiSourceRetrieval()",
  VISUAL_RETRIEVAL_FAILURE: "agent/visual-evidence.ts + visual-intent.ts",
  GROUNDING_FAILURE: "agent/policy.ts + chat route grounding",
  GENERATION_FAILURE: "Gemini generation (post-retrieval)",
  AUTH_FAILURE: "supabase auth",
  CACHE_FAILURE: "lib/cache.ts",
  STREAMING_FAILURE: "chat route streaming",
  UNKNOWN: "unknown",
};

/**
 * Classify a single test result.
 */
export function classifyFailure(
  input: ClassificationInput
): {
  classification: FailureClassification;
  pipelineStage: string;
  location: string;
} {
  const { testCase, doc, rankedContent } = input;

  // Retrieval vs answer distinction (Step 8):
  // If the correct evidence WAS found in ranked content, retrieval was correct →
  // any failure here is generation/grounding.
  const markers = expectedMarkers(testCase.expectedLocation);
  const pathLevel = pathMatchLevel(rankedContent.map((c) => ({ content: c })), markers);
  const ev = evidenceFound(rankedContent.map((c) => ({ content: c })), testCase.expectedAnswerEvidence ?? []);

  const retrievalHadEvidence =
    (markers.length === 0 || pathLevel === "exact") &&
    (testCase.expectedAnswerEvidence?.length === 0 || ev.missing.length === 0);

  let classification: FailureClassification;

  if (!doc) {
    classification = "INGESTION_FAILURE";
  } else if (retrievalHadEvidence) {
    // Retrieval succeeded → the failure is post-retrieval (grounding/generation)
    classification = testCase.shouldRefuse
      ? "GROUNDING_FAILURE" // should refuse but hallucinated fabricable content
      : "GENERATION_FAILURE";
  } else if (markers.length > 0) {
    if (pathLevel === "none") {
      classification = "STRUCTURAL_RETRIEVAL_FAILURE";
    } else {
      classification = "STRUCTURAL_RETRIEVAL_FAILURE";
    }
  } else if (testCase.expectedAnswerEvidence && testCase.expectedAnswerEvidence.length > 0) {
    classification = "SEMANTIC_RETRIEVAL_FAILURE";
  } else if (testCase.visual) {
    classification = "VISUAL_RETRIEVAL_FAILURE";
  } else if (testCase.multiSource) {
    classification = "MULTI_SOURCE_FAILURE";
  } else {
    classification = "UNKNOWN";
  }

  return {
    classification,
    pipelineStage: mapStage(classification),
    location: LOCATION_BY_CLASS[classification],
  };
}

function mapStage(c: FailureClassification): string {
  switch (c) {
    case "INGESTION_FAILURE":
      return "Document Ingestion / Extraction";
    case "CHUNKING_FAILURE":
      return "Document Chunking";
    case "QUERY_ANALYSIS_FAILURE":
      return "Query Analysis";
    case "STRUCTURAL_RETRIEVAL_FAILURE":
      return "Structural Retrieval";
    case "SEMANTIC_RETRIEVAL_FAILURE":
      return "Semantic Retrieval";
    case "RERANKING_FAILURE":
      return "Reranking";
    case "SOURCE_SELECTION_FAILURE":
      return "Source Selection";
    case "MULTI_SOURCE_FAILURE":
      return "Multi-Source Fusion";
    case "VISUAL_RETRIEVAL_FAILURE":
      return "Visual Retrieval";
    case "GROUNDING_FAILURE":
      return "Grounding Policy";
    case "GENERATION_FAILURE":
      return "Answer Generation";
    case "AUTH_FAILURE":
      return "Authentication";
    case "CACHE_FAILURE":
      return "Caching";
    case "STREAMING_FAILURE":
      return "Streaming";
    default:
      return "Unknown";
  }
}

export const CLASSIFICATION_LOCATION = LOCATION_BY_CLASS;
