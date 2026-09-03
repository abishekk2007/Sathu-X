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

// Phase 8A exports — Agent Controller (high-level capability classification
// above the 6B router; routing only, never executes anything)
export {
  classifyAgentRoute,
  credibleMapQuery,
  describeAgentRoute,
  type AgentRoute,
  type AgentRouteRequest,
  type AgentRouteResult,
  type AgentRouteMetadata,
  type InputModality,
} from "./controller";

// Phase 8B exports — Agentic Planning (deterministic plan decomposition for an
// 8A route; planning only, never executes anything)
export {
  createAgentPlan,
  PLAN_EXECUTION_TYPES,
  type AgentPlan,
  type AgentPlanStep,
  type AgentPlanMetadata,
  type AgentPlanInput,
  type PlanComplexity,
  type PlanExecutionType,
  type PlanStatus,
  type PlanStepStatus,
} from "./planner";

// Phase 8C exports — Agent Tool Calling (typed, closed registry + executor
// that turns an 8B AgentPlan into an AgentExecutionResult through the real,
// existing capabilities; adapters never duplicate engines)
export {
  buildAdapters,
  validateAgentPlan,
  executeAgentPlan,
  setDefaultRegistry,
  resolveAgentTool,
  agentToolSkipped,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_AGENT_EXECUTION_MS,
  MAX_AGENT_TOOL_CALLS,
  type AgentToolResult,
  type AgentToolStatus,
  type AgentToolErrorCode,
  type AgentToolName,
  type AgentToolContext,
  type AgentImageSource,
  type AgentRuntimeContext,
  type AgentExecutionResult,
  type AgentToolAdapter,
  type AgentToolRegistry,
  type ExecuteAgentPlanOptions,
  type PlanValidationResult,
} from "./tools";

// Phase 8E exports — Research Agent (pure orchestration/analysis layer on top
// of the single Phase 7C execution path; never issues its own search)
export {
  orchestrateResearch,
  buildResearchSynthesisBlock,
  classifyResearchDepth,
  classifyResearchNeed,
  classifySourceTier,
  buildSourceMeta,
  hasAuthoritativeSource,
  rankEvidence,
  evaluateResearchQuality,
  buildQualityWarnings,
  detectResearchConflicts,
  MAX_RESEARCH_CONFLICTS,
  type ResearchDepth,
  type ResearchNeed,
  type ResearchPlan,
  type ResearchSourceTier,
  type ResearchSourceMeta,
  type ResearchConflict,
  type ResearchQuality,
  type ResearchContext,
  type ResearchInput,
} from "./research";

// Phase 8F exports — Agent Safety (deterministic safety/control boundary that
// reuses the memory security primitives and the closed 8C tool set; never
// duplicates secret/location/injection detection)
export {
  buildToolSafetyMatrix,
  indexToolSafetyMatrix,
  evaluateToolSafety,
  coversAllExecutionTypes,
  classifyUserAction,
  contentLooksInjected,
  neutralizeContent,
  screenUntrustedContent,
  screenPersistProposal,
  reasonCodeOf,
  createConfirmationTicket,
  verifyConfirmation,
  CONFIRMATION_TTL_MS,
  screenToolResultText,
  ownerMatches,
  safeLogText,
  SAFETY_PREAMBLE,
  buildSafetyRefusalNote,
  type SafetyAction,
  type SafetyReasonCode,
  type AgentSafetyDecision,
  type SafetyRisk,
  type SafetySideEffect,
  type ToolSafetyProfile,
  type RequestSafety,
  type AgentSafetyContext,
  type ConfirmationTicket,
  type ToolResultScreen,
} from "./safety";
