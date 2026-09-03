// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: centralized write/read policy gates.
//
// Every save/delete/recall flows through this layer so the "can we do this?"
// decision lives in exactly one place:
//   ALLOW            → the operation may proceed (explicit user request)
//   DENY             → must not proceed (secret, disabled memory, unknown row)
//   ASK              → deterministic stand-down that asks for more input when a
//                      command is genuinely ambiguous
//   UPDATE_EXISTING  → the write replaces a same-key/duplicate row instead of
//                      adding one
//
// Priority (safety first): system rule (never store secrets) > user master
// switch > ownership/row existence > duplicate conflict resolution.
// ---------------------------------------------------------------------------

import type { $UserMemory, MemorySource } from "./types";
import { looksSensitive, looksLikeRawLocation } from "./security";

export type PolicyDecision =
  | { action: "allow"; reason: "explicit_write" }
  | { action: "deny"; reason: "secret"; scope: "value" }
  | { action: "deny"; reason: "raw_location"; scope: "value" }
  | { action: "deny"; reason: "memory_disabled" }
  | { action: "deny"; reason: "no_match" }
  | { action: "deny"; reason: "preserve_explicit"; existingId: string }
  | { action: "ask"; reason: "ambiguous"; message: string }
  | {
      action: "update_existing";
      reason: "duplicate";
      existingId: string;
      existingKey: string;
    };

export interface SaveContext {
  /** Master switch — false means no writes or writes-lite. */
  memoryEnabled: boolean;
}

/**
 * Decides whether a proposed memory write may happen and how. The store still
 * enforces RLS ownership at the database; this layer covers the user-facing
 * gates that SQL cannot.
 */
export function evaluateSave(input: {
  content: string;
  source: MemorySource;
  /** A same-key row (or near-duplicate) the new fact would replace. */
  existing: $UserMemory | null;
  context: SaveContext;
}): PolicyDecision {
  const content = input.content.trim();

  // System safety beats everything: credentials are never memorable, even
  // under an explicit request.
  if (looksSensitive(content)) {
    return { action: "deny", reason: "secret", scope: "value" };
  }

  // Phase 8D — raw coordinates are personal-location PII and are never
  // persisted verbatim, even on an explicit "remember my location".
  if (looksLikeRawLocation(content)) {
    return { action: "deny", reason: "raw_location", scope: "value" };
  }

  if (!content) {
    return {
      action: "ask",
      reason: "ambiguous",
      message:
        "I couldn't find a clear fact to remember in that. Try something like \"Remember that I prefer concise answers\".",
    };
  }

  // Master switch off — offer the way back instead of silently ignoring.
  if (!input.context.memoryEnabled) {
    return {
      action: "deny",
      reason: "memory_disabled",
    };
  }

  if (input.existing) {
    // A newer explicit statement supersedes an older one, whatever its source.
    // An inferred candidate must never lower or overwrite an explicit fact.
    if (input.source === "explicit") {
      return {
        action: "update_existing",
        reason: "duplicate",
        existingId: input.existing.id,
        existingKey: input.existing.key || input.existing.id,
      };
    }
    return {
      action: "deny",
      reason: "preserve_explicit",
      existingId: input.existing.id,
    };
  }

  return { action: "allow", reason: "explicit_write" };
}

/**
 * Decides whether a recall (list / the chat context injection) may use stored
 * memories. Memory is always auxiliary; when the switch is off or reads fail,
 * chat continues without it.
 */
export function evaluateRecall(context: { memoryEnabled: boolean }): PolicyDecision {
  if (!context.memoryEnabled) {
    return { action: "deny", reason: "memory_disabled" };
  }
  return { action: "allow", reason: "explicit_write" };
}

/**
 * Decides whether a delete may run. Only ownership (row existence via RLS) is
 * checked here — the store returns honest failure if deletion itself errors.
 */
export function evaluateDelete(input: {
  matchedCount: number;
  memoryEnabled: boolean;
}): PolicyDecision {
  if (!input.memoryEnabled) {
    return { action: "deny", reason: "memory_disabled" };
  }
  if (input.matchedCount <= 0) {
    return { action: "deny", reason: "no_match" };
  }
  return { action: "allow", reason: "explicit_write" };
}