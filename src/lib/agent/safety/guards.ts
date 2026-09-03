/**
 * Phase 8F — Agent Safety: request/action guards (pure).
 *
 * Classifies a user message into a coarse action class and produces a
 * request-level safety decision. It reuses the existing memory security
 * primitives for secret / raw-location / prompt-injection detection and the
 * task-intent classifier for destructive task actions — nothing is duplicated.
 */

import {
  looksSensitive,
  looksLikeRawLocation,
  containsPromptInjection,
  neutralizePromptInjection,
} from "../../memory";
import type { AgentSafetyDecision, RequestSafety, SafetyReasonCode } from "./types";

/** Task-destructive verbs/patterns describing hard, irreversible deletions. */
const DESTRUCTIVE_ACTION_RE =
  /\b(?:delete|remove|erase|destroy|purge|clear|drop|cancel)\b/i;

/** Words signalling a request intends to make a persistent change. */
const WRITE_ACTION_RE =
  /\b(?:create|add|set|save|update|change|mark|complete|schedule|remember|remind|record|log)\b/i;

/** External side effects: anything that publishes/sends/acts outside the app. */
const EXTERNAL_ACTION_RE =
  /\b(?:send|post|publish|email|message|reply|tweet|share|invite|purchase|buy|pay|charge|refund|transfer|subscribe|unsubscribe|book|schedule\s+(?:meeting|call))\b/i;

/** Irreversible signals: hard deletes, permanent clears, irreversible changes. */
const IRREVERSIBLE_ACTION_RE =
  /\b(?:permanently\s+delete|delete\s+all|erase\s+all|destroy\s+all|clear\s+everything|wipe|remove\s+forever|orever)\b/i;

/**
 * Classifies a user message into a coarse action class. Pure and deterministic.
 * Used by the route to decide confirmation needs (especially destructive/
 * irreversible task actions) without any model inference.
 */
export function classifyUserAction(message: string): RequestSafety {
  const text = (message ?? "").trim();

  const external = EXTERNAL_ACTION_RE.test(text);
  const irreversible = IRREVERSIBLE_ACTION_RE.test(text) || /\b(?:delete|remove)\b.{0,30}\ball\b/i.test(text);
  const destructive = DESTRUCTIVE_ACTION_RE.test(text);
  const write = WRITE_ACTION_RE.test(text);

  let kind: RequestSafety["kind"];
  if (external) kind = "EXTERNAL";
  else if (irreversible && destructive) kind = "IRREVERSIBLE";
  else if (destructive) kind = "DESTRUCTIVE";
  else if (write) kind = "WRITE";
  else kind = "READ";
  if (text.length === 0) kind = "UNKNOWN";

  const sideEffect = external || destructive || write ? "write" : "read";
  const requiresConfirmation =
    kind === "DESTRUCTIVE" ||
    kind === "IRREVERSIBLE" ||
    kind === "EXTERNAL" ||
    (kind === "WRITE" && /(?:\b(?:delete|remove|cancel)\b|\bdelete\b)/i.test(text));

  return { kind, sideEffect, irreversible, requiresConfirmation };
}

/** Detects whether untrusted content carries a prompt-injection attempt. */
export function contentLooksInjected(text: string): boolean {
  return containsPromptInjection(text);
}

/** Neutralizes known injection phrases (defense-in-depth, never removes DATA
 *  that is safe — only rewrites the hostile phrasing). */
export function neutralizeContent(text: string): string {
  return neutralizePromptInjection(text);
}

/**
 * Guards a piece of untrusted content (user input, memory, web page, document,
 * OCR text, tool output) before it is treated as DATA. Returns the decision on
 * whether the content may be surfaced/persisted and the neutralized copy.
 */
export function screenUntrustedContent(content: string): {
  decision: AgentSafetyDecision;
  untrusted: boolean;
  safe: boolean;
  neutralized: string;
} {
  const injected = containsPromptInjection(content);
  if (contentLooksInjected(content)) {
    return {
      decision: {
        allowed: false,
        action: "DENY",
        reasonCode: injected ? "PROMPT_INJECTION" : "UNSAFE_REQUEST",
        safeMessage: "That doesn't look safe to include.",
        requiresConfirmation: false,
      },
      untrusted: true,
      safe: false,
      neutralized: neutralizeContent(content),
    };
  }
  return {
    decision: {
      allowed: true,
      action: "ALLOW",
      reasonCode: "POLICY_BLOCK",
      safeMessage: "",
      requiresConfirmation: false,
    },
    untrusted: false,
    safe: true,
    neutralized: content,
  };
}

/**
 * Determines whether a proposed write (memory save, any persisted content) is
 * SAFE to persist, reusing the 8D secret + raw-location primitives. Never
 * blocks reading — only persisting dangerous material.
 */
export function screenPersistProposal(content: string): AgentSafetyDecision {
  if (looksSensitive(content)) {
    return {
      allowed: false,
      action: "DENY",
      reasonCode: "SENSITIVE_DATA",
      safeMessage: "I don't save credentials.",
      requiresConfirmation: false,
    };
  }
  if (looksLikeRawLocation(content)) {
    return {
      allowed: false,
      action: "DENY",
      reasonCode: "POLICY_BLOCK",
      safeMessage: "I don't save precise coordinates.",
      requiresConfirmation: false,
    };
  }
  if (containsPromptInjection(content)) {
    return {
      allowed: false,
      action: "DENY",
      reasonCode: "PROMPT_INJECTION",
      safeMessage: "I can't save that as a fact.",
      requiresConfirmation: false,
    };
  }
  return {
    allowed: true,
    action: "ALLOW",
    reasonCode: "POLICY_BLOCK",
    safeMessage: "",
    requiresConfirmation: false,
  };
}

/** Formats a safety decision into a canonical reason-code string for tests. */
export function reasonCodeOf(decision: AgentSafetyDecision): SafetyReasonCode {
  return decision.reasonCode;
}
