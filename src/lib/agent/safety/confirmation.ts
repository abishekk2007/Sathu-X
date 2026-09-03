/**
 * Phase 8F — Agent Safety: confirmation model.
 *
 * A deterministic, stateless confirmation for high-risk / irreversible /
 * external actions. There is no durable pending-action store in the app (and
 * we will not invent one), so a confirmation TICKET binds a user's "yes" to
 * the EXACT pending action via a content fingerprint and a short expiry:
 *
 *   - createConfirmationTicket(action) -> { action, nonce, fingerprint, expiresAt }
 *   - verifyConfirmation(action, userReply, ticket)
 *       → ALLOW only when the user affirmatively confirms THIS exact action,
 *         the ticket is unexpired, and the fingerprints match.
 *
 * Properties enforced deterministically (never model-influenced):
 *   - a confirmation cannot be replayed after expiry,
 *   - a "yes" cannot authorize a DIFFERENT action (fingerprint mismatch),
 *   - a casual "okay / yes / fine" does NOT authorize unless it is responding
 *     to a pending confirmation ticket for the matching action,
 *   - no stale confirmation is ever accepted.
 */

import type { AgentSafetyDecision } from "./types";

/** How long a confirmation ticket stays valid (ms). */
export const CONFIRMATION_TTL_MS = 60_000;

/** A stateless confirmation ticket bound to one pending action. */
export interface ConfirmationTicket {
  /** Stable, human-meaningful action label (used only for the pending prompt). */
  label: string;
  /** Content fingerprint — binds "yes" to this exact action. */
  fingerprint: string;
  /** Server-generated random nonce (never user-controlled). */
  nonce: string;
  /** Epoch ms at which this ticket expires. */
  expiresAt: number;
}

/** Creates a fresh confirmation ticket for a pending action. */
export function createConfirmationTicket(
  action: { kind: string; target: string },
  now: number,
  ttlMs = CONFIRMATION_TTL_MS
): ConfirmationTicket {
  const fingerprint = fingerprintAction(action);
  return {
    label: `${action.kind}:${action.target}`,
    fingerprint,
    nonce: randomNonce(),
    expiresAt: now + ttlMs,
  };
}

/**
 * Verifies a user reply against a pending confirmation ticket for the given
 * action.
 *
 *  - missing ticket                       → not authorized (nothing pending)
 *  - affirmative reply + matching fingerprint + unexpired → ALLOW
 *  - affirmative reply but WRONG action   → DENY (unrelated "yes")
 *  - expired ticket                       → DENY (no replay)
 *  - non-affirmative reply                → not authorized
 */
export function verifyConfirmation(
  action: { kind: string; target: string },
  userReply: string,
  ticket: ConfirmationTicket | null,
  now: number
): AgentSafetyDecision {
  // No pending confirmation → a bare "yes" authorizes nothing.
  if (!ticket) {
    return {
      allowed: false,
      action: "DENY",
      reasonCode: "MISSING_CONFIRMATION",
      safeMessage: "There's no action pending that I can confirm.",
      requiresConfirmation: false,
    };
  }

  // Expired — no replay.
  if (now > ticket.expiresAt) {
    return {
      allowed: false,
      action: "DENY",
      reasonCode: "MISSING_CONFIRMATION",
      safeMessage: "That confirmation has expired; please try again.",
      requiresConfirmation: false,
    };
  }

  // The user must affirmatively confirm.
  if (!isAffirmative(userReply)) {
    return {
      allowed: false,
      action: "DENY",
      reasonCode: "MISSING_CONFIRMATION",
      safeMessage: "I'd need your confirmation to continue.",
      requiresConfirmation: true,
    };
  }

  // The "yes" must be for THIS exact action — not a stale/different one.
  if (fingerprintAction(action) !== ticket.fingerprint) {
    return {
      allowed: false,
      action: "DENY",
      reasonCode: "MISSING_CONFIRMATION",
      safeMessage: "That confirmation doesn't match the pending action.",
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

/** Affirmative responses (case-insensitive, trimmed). */
function isAffirmative(reply: string): boolean {
  const t = (reply ?? "").trim().toLowerCase();
  return /^(?:yes|yep|yeah|sure|ok|okay|confirm|correct|go ahead|please do|do it)\b/i.test(t);
}

/** Deterministic, collision-safe-ish fingerprint of an action. */
function fingerprintAction(action: { kind: string; target: string }): string {
  const seed = `${action.kind.toLowerCase()}|${action.target.toLowerCase().trim()}`;
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return `a${h.toString(36)}`;
}

/** Cryptographically-random nonce for a confirmation ticket. */
function randomNonce(): string {
  try {
    if (typeof globalThis !== "undefined" && typeof (globalThis as { crypto?: Crypto }).crypto !== "undefined") {
      const arr = new Uint8Array(16);
      (globalThis as { crypto: Crypto }).crypto.getRandomValues(arr);
      return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* fall through to a timestamp-based nonce (never user-controlled) */
  }
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
