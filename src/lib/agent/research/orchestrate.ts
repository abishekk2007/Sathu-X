/**
 * Phase 8E — Research Agent: orchestrator (pure, network-free).
 *
 * Consumes the SINGLE already-executed `WebResearchResult` (from the 8C
 * `WEB_RESEARCH` adapter) and produces the enriched `ResearchContext` for
 * synthesis: depth + plan typing, source-tier metadata, evidence ranking,
 * conflict detection, and quality/confidence. It NEVER performs its own web
 * search — that would duplicate the real execution path, which the spec
 * forbids. This layer only ANALYSES what was already retrieved.
 */

import type { AgentRoute } from "../controller";
import type { WebResearchResult } from "../../web-research/types";
import { MAX_SOURCES as SEVEN_C_MAX_SOURCES } from "../../web-research";
import type {
  ResearchContext,
  ResearchDepth,
  ResearchInput,
  ResearchNeed,
  ResearchPlan,
} from "./types";
import { classifyResearchDepth, classifyResearchNeed } from "./depth";
import { buildSourceMeta } from "./source-type";
import { buildQualityWarnings, evaluateResearchQuality, rankEvidence } from "./ranking";
import { detectResearchConflicts } from "./conflicts";

/** Mirrors the 7C evidence cap (MAX_EVIDENCE_ITEMS). */
const MAX_EVIDENCE = 5;

/** Mirrors the 7C query budget (MAX_QUERY_BUDGET). */
const MAX_QUERIES = 2;

/** Mirrors the freshness gate (research only when the 7C gate passed). */
function isFresh(message: string): boolean {
  return /fresh|latest|current|recent|newest|up\s*to\s*date/.test(message) ||
    /\b20\d{2}\b/.test(message) ||
    /what\s+happened|breaking|headline/.test(message);
}

/**
 * Builds the research NEED from the executed result + route. `freshness` is a
 * light deterministic proxy of the 7C gate for SYNTHESIS TYPING only — it
 * never re-triggers a search.
 */
function buildNeed(message: string, primaryRoute: string, research: WebResearchResult): ResearchNeed {
  const freshness = isFresh(message);
  const dedicated = research.sources.length > 0 || research.evidence.length > 0;
  const selected =
    dedicated || classifyResearchNeed(freshness, dedicated, primaryRoute as AgentRoute);
  return { selected, freshness, dedicated };
}

/**
 * The single, pure orchestration entry for 8E. Feed it the executed result
 * (whatever the 8C executor produced — success, degraded, or empty) and it
 * returns the enriched, synthesizable `ResearchContext`.
 */
export function orchestrateResearch(input: ResearchInput): ResearchContext {
  const { research, message, primaryRoute } = input;

  const freshness = isFresh(message);
  const need: ResearchNeed = buildNeed(message, primaryRoute, research);

  let depth: ResearchDepth = "NONE";
  if (research.sources.length > 0 || research.evidence.length > 0 || freshness) {
    depth = classifyResearchDepth(freshness, message, primaryRoute as AgentRoute);
  }

  const plan: ResearchPlan = {
    depth,
    maxQueries: MAX_QUERIES,
    maxSources: SEVEN_C_MAX_SOURCES,
    maxEvidence: MAX_EVIDENCE,
    // The 7C query builder sets `news` from a freshness-heavy ask.
    newsBiased: /what\s+happened|latest|breaking|developments?|news/.test(message),
  };

  const sourceMeta = buildSourceMeta(research.sources, research.evidence);
  const rankedEvidence = rankEvidence(research.evidence, sourceMeta);
  const conflicts = detectResearchConflicts(research.evidence);
  const quality = evaluateResearchQuality(research, sourceMeta);
  const warnings = buildQualityWarnings(quality);

  return {
    need,
    plan,
    sources: sourceMeta,
    conflicts,
    evidence: rankedEvidence,
    quality,
    warnings,
  };
}
