/**
 * Phase 8E — Research Agent: depth classification (pure).
 *
 * Classifies how deep a turn's research SHOULD be. Deliberately deterministic
 * and side-effect-free: it never triggers new searches. It types the turn so
 * the synthesis layer can tune how much it leans on (or hedges around) the
 * retrieved evidence. Reuses the 7C freshness signal as the foundation for
 * need, then refines depth from explicit topic-signal words rooted in intent.
 */

import type { AgentRoute } from "../controller";
import type { ResearchDepth } from "./types";

/** Freshness-demanding subjects (re-checkable, time-sensitive facts). */
const FRESH_TOPIC_RE =
  /\b(?:latest|current|recent|newest|up\s*to\s*date|price|prices|version|versions|release|announcemen[ct]|chang[eis]|updates?|developments?|news|results|standings|fixtures|schedule|election|candidate|policy|legislation|live\s+score|weather|forecast)\b/i;

/** Compound/intent-heavy asks that benefit from more corroboration. */
const DEEP_TOPIC_RE =
  /\b(?:compare|comparison|difference|between|versus|vs\.?|best|top\s*\d|list|review|reviews|how\s+to|tutorial|guide|report|analysis|why|how\s+does|impact|effects?|causes?|timeline|history)\b/i;

/**
 * Classifies the research depth for a turn, given the 7C freshness decision,
 * the user message, and the 8A route. Pure and deterministic.
 *
 * Rules (conservative, never invents research):
 *  - no fresh/signal need, mixed or static route   -> NONE (no research layer)
 *  - fresh signal, single light topic              -> STANDARD
 *  - fresh signal + compound/compare/deep topic    -> DEEP
 *  - a research-dedicated route (image/web, results) that yielded content
 *    but carries only a light signal                -> QUICK
 *  - anything else with a need                      -> QUICK
 */
export function classifyResearchDepth(
  freshness: boolean,
  message: string,
  primaryRoute: AgentRoute | string
): ResearchDepth {
  const text = message.trim();
  if (!freshness) {
    // Intent-driven research routes (image/web, results) can still warrant a
    // shallow research layer even without a strict freshness read.
    if (/WEB_RESEARCH|HYBRID/.test(primaryRoute)) {
      return /\b(?:compare|difference|versus|vs\.?|top\s*\d)\b/i.test(text)
        ? "QUICK"
        : "QUICK";
    }
    return "NONE";
  }

  const deep = DEEP_TOPIC_RE.test(text);
  if (deep) return "DEEP";
  if (FRESH_TOPIC_RE.test(text)) return "STANDARD";
  return "QUICK";
}

/**
 * Classifies whether the turn should carry a research layer at all, given the
 * 7C gate output and the 8A route. Mirrors need typing without a network call.
 */
export function classifyResearchNeed(
  freshness: boolean,
  dedicated: boolean,
  primaryRoute: AgentRoute | string
): boolean {
  if (freshness) return true;
  if (dedicated) return true;
  return /WEB_RESEARCH|HYBRID/.test(primaryRoute);
}
