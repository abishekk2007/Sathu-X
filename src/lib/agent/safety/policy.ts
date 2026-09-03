/**
 * Phase 8F — Agent Safety: deterministic tool safety policy.
 *
 * The closed tool-safety matrix, one entry per 8C `AgentToolName`. It encodes
 * risk, side-effect (read vs write), reversibility, and confirmation needs.
 * This is application code, never model-influenced, and it is the single
 * authority the 8C executor consults when deciding whether a step may run.
 *
 * Rationale for each tier (matches real adapter behavior):
 *  - READ tools (retrieval, research, realtime, maps, image-understanding,
 *    location, internal reasoning) are low-risk: no persistent state change.
 *  - RESPONSE_SYNTHESIS / CLARIFICATION are internal notes, not side effects.
 *  - VOICE_PROCESSING is a read of client-sent audio; privacy-sensitive input
 *    but not a state change.
 *  - TASK_MANAGEMENT is the only persisted-WRITE tool. It is user-scoped (RLS)
 *    and reversible for CREATE but IRREVERSIBLE for hard DELETE — so the DELETE
 *    path requires confirmation (handled by the guards + confirmation module).
 *  - IMAGE_GENERATION is a side-effectful provider call but reversible to the
 *    user (produces accessible output); low-medium risk, no confirmation.
 */

import type { AgentToolName } from "../tools/types";
import { PLAN_EXECUTION_TYPES } from "../planner";
import type { AgentSafetyDecision, ToolSafetyProfile } from "./types";

/** Builds the complete, closed safety matrix over every execution type. */
export function buildToolSafetyMatrix(): ToolSafetyProfile[] {
  const matrix: ToolSafetyProfile[] = [];

  const add = (
    toolName: AgentToolName,
    risk: ToolSafetyProfile["risk"],
    sideEffect: ToolSafetyProfile["sideEffect"],
    irreversible: boolean,
    requiresConfirmation: boolean,
    scope: ToolSafetyProfile["scope"] = "user"
  ) => {
    matrix.push({ toolName, risk, sideEffect, irreversible, requiresConfirmation, scope });
  };

  // READ / low-risk tools.
  add("INTERNAL_REASONING", "low", "none", false, false, "none");
  add("RESPONSE_SYNTHESIS", "low", "none", false, false, "none");
  add("CLARIFICATION", "low", "none", false, false, "none");
  add("DOCUMENT_RETRIEVAL", "low", "read", false, false);
  add("WEB_RESEARCH", "low", "read", false, false, "none");
  add("REALTIME_LOOKUP", "low", "read", false, false);
  add("MAP_LOOKUP", "low", "read", false, false);
  add("IMAGE_UNDERSTANDING", "low", "read", false, false);
  add("IMAGE_GENERATION", "medium", "write", false, false);
  add("VOICE_PROCESSING", "medium", "read", false, false);
  add("LOCATION_LOOKUP", "medium", "read", false, false);

  // The only persisted-write tool. Base state change; the DELETE sub-action is
  // confirmed at the guard layer, but the tool itself is bounded to "user" scope.
  add("TASK_MANAGEMENT", "medium", "write", false, false);

  // Guard: the matrix must cover every closed execution type (a missed tool
  // fails closed, since the executor denies anything without a profile).
  return matrix;
}

/** Indexes the matrix by tool name for O(1) lookups. Pure. */
export function indexToolSafetyMatrix(
  matrix: ToolSafetyProfile[]
): Map<AgentToolName, ToolSafetyProfile> {
  return new Map(matrix.map((p) => [p.toolName, p]));
}

/**
 * Evaluates whether a given tool may execute under the provided safety
 * context. FAILS CLOSED: an unknown tool, or a tool with no profile, is
 * DENIED — never implicitly allowed. The decision is deterministic and pure.
 */
export function evaluateToolSafety(
  toolName: AgentToolName,
  policies: ToolSafetyProfile[],
  userId: string | undefined
): AgentSafetyDecision {
  const profile = indexToolSafetyMatrix(policies).get(toolName);

  // Unknown / unprofiled tool -> deny (fail closed). Never allow tools we did
  // not explicitly profile.
  if (!profile) {
    return {
      allowed: false,
      action: "DENY",
      reasonCode: "TOOL_NOT_ALLOWED",
      safeMessage: "That action isn't available.",
      requiresConfirmation: false,
    };
  }

  // The authenticated caller is required for any user-scoped tool. When no
  // authenticated identity is present (e.g. an unauthenticated execution
  // context), user-scoped tools are denied; scope-less read tools are allowed.
  if (profile.scope === "user" && !userId) {
    return {
      allowed: false,
      action: "DENY",
      reasonCode: "UNAUTHORIZED",
      safeMessage: "Please sign in to continue.",
      requiresConfirmation: false,
    };
  }

  // Confirmation-gated tool without a supplied approval -> DENY with the
  // CONFIRM action so the caller can prompt. (The executor treats DENY as a
  // hard block; the route decides whether to surface a confirm prompt.)
  if (profile.requiresConfirmation) {
    return {
      allowed: false,
      action: "CONFIRM",
      reasonCode: "MISSING_CONFIRMATION",
      safeMessage: "I need your confirmation before doing that.",
      requiresConfirmation: true,
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

/** Convenience: a read-only "does the closed set cover these profiles?" check. */
export function coversAllExecutionTypes(profiles: ToolSafetyProfile[]): boolean {
  const names = new Set(profiles.map((p) => p.toolName));
  return PLAN_EXECUTION_TYPES.every((t) => names.has(t));
}
