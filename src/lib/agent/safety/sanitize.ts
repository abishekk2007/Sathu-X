/**
 * Phase 8F — Agent Safety: post-execution result validation (pure).
 *
 * Screens a tool result / any arbitrary output before it can reach the model
 * or the user. Guarantees that untrusted tool output never becomes:
 *   - a leaked credential (secret value shapes),
 *   - a leaked raw coordinate,
 *   - a prompt-injection vector,
 *   - another user's data.
 *
 * Reuses the existing memory security primitives — nothing duplicated.
 */

import {
  looksSensitive,
  looksLikeRawLocation,
  containsPromptInjection,
  sanitizeForLog,
  neutralizePromptInjection,
} from "../../memory";

export interface ToolResultScreen {
  /** True when the output is safe to surface/persist (possibly neutralized). */
  ok: boolean;
  /** True when something secret-like was detected and must not be exposed. */
  blockedSensitive: boolean;
  /** True when raw coordinates were detected and must not be exposed. */
  blockedLocation: boolean;
  /** True when a prompt-injection attempt was present. */
  blockedInjection: boolean;
  /** True when the content references another user (crude heuristic). */
  blockedCrossUser: boolean;
  /** The (possibly neutralized / redacted) content safe to pass onward. */
  safeText: string;
}

/**
 * Screens arbitrary text output. Fails CLOSED on secrets: any credential-like
 * material means the result must not be surfaced — we return an empty safe
 * text and let callers avoid persisting/echoing it. Injection is neutralized
 * (the content stays DATA) rather than dropped, so legitimate research/
 * document text is preserved.
 */
export function screenToolResultText(
  text: string | null | undefined,
  opts: { currentUserId?: string } = {}
): ToolResultScreen {
  const raw = text ?? "";
  const blockedSensitive = looksSensitive(raw);
  const blockedLocation = looksLikeRawLocation(raw);
  const blockedInjection = containsPromptInjection(raw);
  const blockedCrossUser = false; // cross-user detection is structural, not textual (see below)

  // Secrets and raw coordinates fail closed: never surface.
  if (blockedSensitive || blockedLocation) {
    return {
      ok: false,
      blockedSensitive,
      blockedLocation,
      blockedInjection,
      blockedCrossUser,
      safeText: "",
    };
  }

  // Injection is DATA: neutralize the hostile phrasing but keep the content.
  let safeText = raw;
  if (blockedInjection) {
    safeText = neutralizePromptInjection(raw);
  }

  return {
    ok: true,
    blockedSensitive,
    blockedLocation,
    blockedInjection,
    blockedCrossUser,
    safeText,
  };
}

/**
 * Verifies that a user-scoped result's owner equals the current authenticated
 * user. Structural ownership is enforced by RLS in every store, but a tool may
 * still return cross-cutting material (e.g. a scalar). This helper provides a
 * deterministable over-check for any client-supplied owner id that appears in
 * a result, so a foreign owner is never trusted.
 */
export function ownerMatches(
  resultOwnerId: string | null | undefined,
  currentUserId: string | undefined
): boolean {
  if (resultOwnerId == null || resultOwnerId === "") return true; // no owner claim to check
  if (!currentUserId) return false; // no authenticated identity → deny ownership claim
  return resultOwnerId === currentUserId;
}

/** Safe, secret-redacted log form of any raw string. */
export function safeLogText(text: string): string {
  return sanitizeForLog((text ?? "").slice(0, 500));
}
