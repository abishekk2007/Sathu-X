/**
 * Phase 8E — Research Agent: barrel.
 *
 * Exposes the pure, network-free orchestration surface. The actual web search
 * continues to run ONCE under the 8C `WEB_RESEARCH` adapter (→ researchWeb);
 * this module only ANALYSES that executed result into a synthesizable
 * `ResearchContext` (depth/plan typing, source tiers, ranking, conflicts,
 * quality/confidence, fenced synthesis block).
 */

export { orchestrateResearch } from "./orchestrate";
export { buildResearchSynthesisBlock } from "./context";
export { classifyResearchDepth, classifyResearchNeed } from "./depth";
export { classifySourceTier, buildSourceMeta, hasAuthoritativeSource } from "./source-type";
export { rankEvidence, evaluateResearchQuality, buildQualityWarnings } from "./ranking";
export { detectResearchConflicts, MAX_RESEARCH_CONFLICTS } from "./conflicts";

export type {
  ResearchDepth,
  ResearchNeed,
  ResearchPlan,
  ResearchSourceTier,
  ResearchSourceMeta,
  ResearchConflict,
  ResearchQuality,
  ResearchContext,
  ResearchInput,
} from "./types";
