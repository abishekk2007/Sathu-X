/**
 * Phase 8E — Research Agent: types.
 *
 * A bounded, evidence-aware orchestration layer that sits ON TOP of the Phase
 * 7C web research result produced by the existing single execution path (the
 * 8C `WEB_RESEARCH` adapter → `researchWeb`). 8E never performs its own
 * network search — it ANALYSES the already-executed `WebResearchResult` and
 * emits:
 *
 *   - a research-depth classification (NONE/QUICK/STANDARD/DEEP),
 *   - a typed research plan describing what WOULD satisfy the turn, and
 *   - an enriched `ResearchContext` (source types, per-source ranking,
 *     web-vs-web conflicts, overall confidence) that is fused into the model
 *     synthesis as untrusted DATA.
 */

import type { WebResearchResult } from "../../web-research/types";

/**
 * How deep a turn warrants going on the web. Derived from the message and the
 * 8A route — a pure classification, NEVER a trigger to run new searches (the
 * route controller already decided whether research runs).
 */
export type ResearchDepth = "NONE" | "QUICK" | "STANDARD" | "DEEP";

/**
 * The strength of the research need for this turn. `freshness` mirrors the 7C
 * `shouldResearch` gate; `dedicated` marks an intent-driven research turn
 * (e.g. an explicit "what happened / latest" ask) that ran without a strict
 * freshness read.
 */
export interface ResearchNeed {
  /** Whether a web search was (or would be) warranted for this turn. */
  selected: boolean;
  /** Healthy probability that the user wants fresh/current information. */
  freshness: boolean;
  /** True when the intent alone demanded research (image/web, results ask). */
  dedicated: boolean;
}

/**
 * A BOUNDED research plan describing what satisfying the turn would require.
 * This is metadata for synthesis — it is deterministic and never issues
 * requests. All ceilings mirror the real pipeline budgets so the reported plan
 * always matches what the executor actually ran.
 */
export interface ResearchPlan {
  /** The derived depth for this turn. */
  depth: ResearchDepth;
  /** Max queries the underlying pipeline could have issued this turn. */
  maxQueries: number;
  /** Max sources surfaced (mirrors 7C `MAX_SOURCES`). */
  maxSources: number;
  /** Max evidence passages handed to the model (mirrors 7C cap). */
  maxEvidence: number;
  /** Whether results should lean toward a "news" topic (freshness-heavy). */
  newsBiased: boolean;
}

/**
 * The trust tier of a surfaced source, derived from its domain. Used to tell
 * the model how much weight to give each citation and to surface conflicts.
 */
export type ResearchSourceTier = "primary" | "secondary" | "tertiary";

/** Typed metadata for a single surfaced web source (one citation). */
export interface ResearchSourceMeta {
  /** Citation index — matches the application-assigned 1..n position. */
  index: number;
  /** Source display title (from the real retrieval). */
  title: string;
  /** The source's URL (application-verified; never model-invented). */
  url: string;
  /** Clean domain. */
  domain: string;
  /** Trust tier derived from the domain. */
  tier: ResearchSourceTier;
  /** Provider relevance score 0..1 when known, else null. */
  relevance: number | null;
}

/**
 * A web-vs-web disagreement between two retrieved passages that discuss the
 * same topic but report incompatible specifics. Detected deterministically
 * from the evidence, never inferred by the model.
 */
export interface ResearchConflict {
  /** Bounded topic label (derived from shared tokens). */
  topic: string;
  /** The two conflicting sides, each pinned to its real source index. */
  sides: Array<{
    sourceIndex: number;
    passage: string;
  }>;
}

/**
 * Combined quality assessment of the retrieved evidence for synthesis.
 * `confidence` communicates how far the retrieved evidence can ground an
 * answer, so the model is honest when coverage is thin.
 */
export interface ResearchQuality {
  /** 0..1 confidence that the evidence can ground the user's question. */
  confidence: number;
  /** How many surfaces/passages actually carried retrievable content. */
  evidenceCount: number;
  /** True when the retrieval degraded/failed open (partial snippet coverage). */
  degraded: boolean;
  /** True when at least one source tier is authoritative (gov/edu/official). */
  hasAuthoritative: boolean;
  /** True when the evidence spans more than one distinct source. */
  multiSource: boolean;
}

/**
 * The complete enriched research context for a turn. This is what 8E hands to
 * the route for synthesis — it fully derives from the SINGLE executed
 * `WebResearchResult` and never triggers additional retrieval.
 */
export interface ResearchContext {
  need: ResearchNeed;
  plan: ResearchPlan;
  /** Typed metadata for each surfaced source (mirrors the citations). */
  sources: ResearchSourceMeta[];
  /** Web-vs-web conflicts detected among the evidence (bounded). */
  conflicts: ResearchConflict[];
  /** Bounded, ranked evidence already prepared by the 7C pipeline. */
  evidence: import("../../web-research/types").WebEvidenceItem[];
  quality: ResearchQuality;
  /** True when the source tiering detected any authoritative origin. */
  warnings: string[];
}

/**
 * The input 8E orchestrates from. `research` is the SINGLE executed web result
 * (possibly empty/degraded). `message` and `route` drive depth/need typing.
 */
export interface ResearchInput {
  /** The already-executed 7C web research result (may be empty/degraded). */
  research: WebResearchResult;
  /** The user's latest message. */
  message: string;
  /** The 8A route decision for this turn (used for depth typing). */
  primaryRoute: string;
}
