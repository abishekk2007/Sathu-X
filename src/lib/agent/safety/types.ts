/**
 * Phase 8F — Agent Safety: types.
 *
 * A deterministic safety/control boundary around the agent. It answers the
 * questions "is this request allowed?", "is this tool allowed?", "is this
 * action safe?", "does it require confirmation?", "is the input trustworthy?",
 * "is the operation too expensive/broad/irreversible?".
 *
 * Responsibilities are intentionally NOT blurred: 8A classifies, 8B plans, 8C
 * executes, 8D stores memory, 8E evaluates research, 8F decides safety.
 *
 * Everything here is pure/deterministic (no model, no network) and reuses the
 * existing secret / location / prompt-injection primitives from the memory
 * module — nothing is duplicated.
 */

import type { AgentToolName } from "../tools/types";

/** The outcome of a safety decision for a request/action/tool. Closed set. */
export type SafetyAction = "ALLOW" | "DENY" | "CONFIRM" | "CLARIFY";

/**
 * Closed, typed reason codes. Only codes that are actually used exist — no
 * decorative taxonomy.
 */
export type SafetyReasonCode =
  | "UNSAFE_REQUEST"
  | "UNAUTHORIZED"
  | "TOOL_NOT_ALLOWED"
  | "MISSING_CONFIRMATION"
  | "EXTERNAL_ACTION"
  | "IRREVERSIBLE_ACTION"
  | "SENSITIVE_DATA"
  | "PROMPT_INJECTION"
  | "RESOURCE_LIMIT"
  | "POLICY_BLOCK"
  | "INVALID_INPUT"
  | "AMBIQUOUS_ACTION";

/**
 * A typed safety decision. `safeMessage` is a concise, polite, NON-revealing
 * user-facing reason (never internal policy detail).
 */
export interface AgentSafetyDecision {
  allowed: boolean;
  action: SafetyAction;
  reasonCode: SafetyReasonCode;
  /** Concise, polite, non-revealing reason suitable for the user. */
  safeMessage: string;
  /** True when this action must be confirmed before it may run. */
  requiresConfirmation?: boolean;
}

/** Risk tier of a tool or action. */
export type SafetyRisk = "low" | "medium" | "high";

/** Side-effect class of a tool: does it change state or read only? */
export type SafetySideEffect = "read" | "write" | "none";

/**
 * Deterministic safety profile for a single agent tool. This is the 8F "tool
 * safety matrix".
 */
export interface ToolSafetyProfile {
  toolName: AgentToolName;
  /** Low-risk read-only tools have lower checks; write/irreversible are gated. */
  risk: SafetyRisk;
  sideEffect: SafetySideEffect;
  /** True when the action's effects cannot be undone. */
  irreversible: boolean;
  /** True when the action must be explicitly confirmed before execution. */
  requiresConfirmation: boolean;
  /** "user" = must be the authenticated user's own scoped data; "none" = n/a. */
  scope: "user" | "none";
}

/** Request-level safety classification of a user message/action. */
export interface RequestSafety {
  /** The coarse action class of the request. */
  kind: "READ" | "WRITE" | "DESTRUCTIVE" | "EXTERNAL" | "IRREVERSIBLE" | "UNKNOWN";
  sideEffect: SafetySideEffect;
  irreversible: boolean;
  requiresConfirmation: boolean;
}

/**
 * The confinement context handed to the tool executor so it can gate every
 * tool deterministically. When absent, execution behaves exactly as today
 * (backward compatible) — it is the route's responsibility to supply it.
 */
export interface AgentSafetyContext {
  /** The authenticated, server-derived user id (never from the browser). */
  userId: string;
  /** The closed tool-safety matrix for this runtime. */
  policies: ToolSafetyProfile[];
}
