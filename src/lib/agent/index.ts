export type {
  AgentSource,
  AgentAction,
  AgentDecision,
  RetrievalRequest,
  RetrievalResult,
  AgentContext,
  AgentResponseMetadata,
} from "./types";

export { routeDecision } from "./router";
export { buildGroundingInstruction, buildNoResultsGrounding } from "./policy";
export { retrieveAgentContext, formatAgentRetrievalContext } from "./context";

// Phase 5C retrieval exports
export {
  analyzeQuery,
  classifyRetrievalState,
  explainRetrievalFailure,
  type QueryAnalysis,
  type RetrievalFailureState,
} from "@/lib/retrieval";

// Phase 5D multi-source exports
export {
  classifySourceIntent,
  type SourceIntentAnalysis,
  type SourceReference,
} from "./source-intent";

export {
  selectSources,
  scoreSourceRelevance,
  type SourceSelection,
} from "./source-selector";

export {
  orchestrateMultiSourceRetrieval,
  type MultiSourceAnalysis,
  type MultiSourceResult,
} from "./multi-source";

export {
  detectConflicts,
  consolidateEvidence,
  type SourceConflict,
} from "./conflict-detector";

// Re-export MultiSourceIntent from source-intent
export type { MultiSourceIntent } from "./source-intent";

// Phase 5E-2 multimodal exports
export {
  detectVisualIntent,
  getTargetPages,
  getTargetVisualKinds,
  parsePageNumbers,
  parseFirstPageNumber,
  type VisualIntentType,
  type VisualQueryIntent,
  type VisualReference,
} from "./visual-intent";

export {
  loadVisualEvidence,
  buildGeminiImageParts,
  buildVisualEvidenceNote,
  buildAssetQuery,
  type VisualEvidence,
  type MultimodalEvidence,
  type VisualEvidenceDeps,
} from "./visual-evidence";

// Phase 6B exports — central query router (decision layer above 1–6A)
export {
  routeQuery,
  isRealtimeConceptDefinition,
  describeQueryRoute,
  EXTENSION_POINTS,
  type QueryRoute,
  type QueryRouteDecision,
  type QueryRoutingInput,
  type ExecutionPlan,
  type ExecutionStep,
  type ConfidenceLabel,
} from "./query-router";

// Phase 6C exports — text→image generation intent (decision layer signal)
export type { ImageGenerationIntent } from "@/lib/image-generation/intent";

// Phase 6E exports — document→visual generation intent (decision layer signal)
export type { DocumentVisualIntent } from "@/lib/image-generation/document-visual-intent";
