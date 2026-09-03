// ---------------------------------------------------------------------------
// Phase 8D — Agent Memory: memory candidate model + deterministic screening.
//
// The chat route feeds every potential write through this single gate so the
// "what is a storable memory?" decision lives in exactly one place, on top of
// the Phase 6F extractor/policy layers (which already cover secrets, dedup and
// conflict resolution). Screening is 100% deterministic — no LLM — because the
// 8D directive forbids depending on a model for safety-sensitive "never store
// this" decisions.
//
//   secret            → credentials/API keys/tokens (fortified by security.ts)
//   raw_location      → raw lat/lng / DMS coordinate PII (never persisted)
//   conversation_dump → a bulk paste of a whole conversation/transcript
//   reasoning         → internal tool-calling reasoning / chain-of-thought
//   injection         → stored-text that tries to hijack the model (defense)
//   storable          → a normal durable fact, ready for extractor+policy
// ---------------------------------------------------------------------------

import { looksSensitive, looksLikeRawLocation } from "./security";

/** The deterministic verdict a candidate is assigned before any write. */
export type CandidateVerdict =
  | "storable"
  | "secret"
  | "raw_location"
  | "conversation_dump"
  | "reasoning"
  | "injection"
  | "empty";

export interface ScreenedCandidate {
  verdict: CandidateVerdict;
  /** Normalized, vetted fact when verdict === "storable"; else undefined. */
  content?: string;
}

const MAX_PLAUSIBLE_FACT_CHARS = 600;

/** Verbose transcript / multi-turn paste markers that indicate a conversation dump. */
const DUMP_MARKERS: RegExp[] = [
  // Speaker-turn transcript ("You:", "Bot:", "User: ... Assistant: ...").
  /\b(?:you|ai|bot|assistant|user|me|human)\s*:\s*.{1,40}?\s*[\r\n]+(?:you|ai|bot|assistant|user|me|human)\s*:/i,
  // Bulk "here's our whole conversation / chat log" framing.
  /\b(?:here\s+is|this\s+is|please\s+remember)\s+(?:our\s+|the\s+)?(?:entire\s+|whole\s+|full\s+)?(?:conversation|chat\s*(?:log|history|transcript)|transcript)\b/i,
];

/**
 * True when the text is a bulk conversation/chat-session paste rather than a
 * single durable fact. Such dumps are never stored (8D directive).
 */
export function isConversationDump(text: string): boolean {
  if (!text) return false;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length > MAX_PLAUSIBLE_FACT_CHARS * 2) return true;
  for (const marker of DUMP_MARKERS) {
    if (marker.test(text)) return true;
  }
  return false;
}

/** Framing that betrays internal tool-calling / step-by-step reasoning output. */
const REASONING_MARKERS: RegExp[] = [
  /\b(?:here\s+is|from)\s+(?:my|the)\s+(?:tool|step|internal|scratch|chain)\s*(?:result|output|reasoning|thinking)\b/i,
  /\b(?:tool|internal|scratch)\s+(?:result|output|reasoning|thinking)\b/i,
  /\b(?:step[\s-]?by[\s-]?step|chain[\s-]?of[\s-]?thought)\s+(?:result|output|reasoning|trace)\b/i,
];

/**
 * True when the candidate claims to be internal tool-calling or step-by-step
 * reasoning — the assistant's own working, never a durable user fact.
 */
export function looksLikeReasoning(text: string): boolean {
  if (!text) return false;
  for (const marker of REASONING_MARKERS) {
    if (marker.test(text)) return true;
  }
  return false;
}

/** Instruction-injection attempts that stored memory must never smuggle in. */
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?|context|guidelines)\b/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?|context)\b/i,
  /\bforget\s+(?:all\s+)?(?:previous\s+)?(?:instructions?|prompts?|rules?)\b\s+and\b/i,
  /\byou\s+(?:are|now\s+are|should)\s+(?:now\s+)?(?:a\s+)?(?:jailbreak|unrestricted|not\s+(?:bound|constrained))\b/i,
  /\bnew\s+system\s+(?:prompt|instructions?)\b/i,
];

/**
 * True when a stored-memory string carries prompt-injection text ("ignore
 * previous instructions", "you are now unrestricted", …). Such content is
 * redacted defensively (never blanked wholesale) so the model still gets the
 * durable fact but is not handed a hijack instruction.
 */
export function containsPromptInjection(text: string): boolean {
  if (!text) return false;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/** Start/end markers that make any injection text inert within a fenced block. */
const INJECTION_REDACT_RE = /(?:\bignore\b|\bdisregard\b|\bforget\b)[^\n.,;!?]{0,80}|(?:\byou\s+are\b)[^\n.,;!?]{0,60}/gi;

/**
 * Defensively neutralizes known injection phrases in a stored-memory string.
 * Deterministic and cheap; applied as defense-in-depth inside the context
 * formatter right before the fenced block is emitted.
 */
export function neutralizePromptInjection(text: string): string {
  return text.replace(INJECTION_REDACT_RE, "[redacted-injection]");
}

/**
 * The single 8D screening gate. Returns the storable fact (normalized) or a
 * veto verdict. Order is safety-first: secrets and raw coordinates are
 * absolute, then volume (conversation dumps), then reasoning framing, then
 * injection marker (note: injection alone does not block storage — the text is
 * still valuable; it is neutralized at render time — so it maps to "storable"
 * with the raw text passed through for the formatter to fence).
 */
export function screenMemoryCandidate(raw: string): ScreenedCandidate {
  const text = (raw ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim();
  if (!text) return { verdict: "empty" };
  if (text.length < 3) return { verdict: "empty" };
  if (looksSensitive(text)) return { verdict: "secret" };
  if (looksLikeRawLocation(text)) return { verdict: "raw_location" };
  if (isConversationDump(text)) return { verdict: "conversation_dump" };
  if (looksLikeReasoning(text)) return { verdict: "reasoning" };
  return { verdict: "storable", content: text };
}
