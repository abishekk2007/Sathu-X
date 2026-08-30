// ---------------------------------------------------------------------------
// Agent router — decides whether retrieval is needed for a given message.
// Rule-based: no LLM call, deterministic, fast.
// ---------------------------------------------------------------------------

import type { AgentDecision, AgentContext } from "./types";

/**
 * Patterns that suggest the user is referencing attached material.
 * Checked against the lowercased user message.
 */
const SOURCE_REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:according to|from|in)\s+(?:the\s+)?(?:document|file|notes|pdf|material|text|pasted)/i,
  /\b(?:question|q)\s*\d+/i,
  /\b(?:this|that|the)\s+(?:document|file|notes|pdf|material|text|pasted|image)/i,
  /\b(?:based on|using|refer to|referencing)\s+(?:the\s+)?(?:document|file|notes|pdf|material|text)/i,
  /\b(?:what does|what do)\s+(?:the\s+)?(?:document|file|notes|pdf|material|text)\s+(?:say|state|mention|contain)/i,
  /\b(?:explain|describe|summarize|summarise|analyse|analyze)\s+(?:the\s+)?(?:document|file|notes|pdf|material|text)/i,
  /\b(?:from my|from the)\s+(?:uploaded|attached|pasted|selected)/i,
];

/**
 * Analyses the current chat turn and decides whether the agent needs to
 * retrieve context from attached sources, or can answer directly.
 *
 * This is a pure function — no side effects, no network calls.
 */
export function routeDecision(ctx: AgentContext): AgentDecision {
  // 1. If sources are explicitly attached, always retrieve
  if (ctx.sources.length > 0) {
    // Check if the message explicitly references the sources
    const referencesSource = SOURCE_REFERENCE_PATTERNS.some((p) =>
      p.test(ctx.message)
    );

    if (referencesSource) {
      return {
        action: "retrieve_context",
        reason: "User message references attached sources",
        sourceTypes: [...new Set(ctx.sources.map((s) => s.type))],
      };
    }

    // Sources attached but message doesn't explicitly reference them —
    // still retrieve, because the user attached them for a reason.
    return {
      action: "retrieve_context",
      reason: "Sources are attached to this conversation turn",
      sourceTypes: [...new Set(ctx.sources.map((s) => s.type))],
    };
  }

  // 2. No sources attached — answer directly.
  //    Memory, student context, and planner context are loaded separately
  //    by the existing pipeline and don't count as "retrieval" here.
  return {
    action: "answer_directly",
    reason: "No external sources attached",
  };
}
