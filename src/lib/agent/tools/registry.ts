// ---------------------------------------------------------------------------
// Phase 8C — Agent Tool Calling: closed registry.
//
// Maps every 8B `PlanExecutionType` to a single adapter via a typed, closed
// record (built in `adapters.ts`). The executor NEVER performs a lookup keyed
// by user input — `resolveAgentTool` only accepts a value already typed as
// `AgentToolName` and returns null for anything outside the closed set. The
// closed record itself is the registry: one adapter per name, no dynamic import.
// ---------------------------------------------------------------------------

import type { PlanExecutionType } from "../planner";
import type { AgentToolName, AgentToolResult } from "./types";

export type AgentToolAdapter = (
  ctx: import("./types").AgentToolContext,
  runtime: import("./types").AgentRuntimeContext
) => Promise<AgentToolResult>;

/** Builds a uniform "skipped because a dependency did not resolve" result. */
export function agentToolSkipped(
  toolName: AgentToolName,
  stepId: string,
  reason: string
): AgentToolResult {
  return {
    toolName,
    stepId,
    status: "SKIPPED",
    error: { code: "internal", message: reason },
    metadata: { source: "executor" },
  };
}

/**
 * The closed adapter record. Every execution type has exactly one entry; there
 * is no code path that resolves an arbitrary user string to a tool.
 */
export type AgentToolRegistry = Record<AgentToolName, AgentToolAdapter>;

/**
 * Resolves an execution type to its adapter. Because the tool name is already
 * constrained to the closed `AgentToolName` union by the caller, this can
 * never be driven by user input. Returns null defensively for unknown strings
 * (unreachable through a typed plan step).
 */
export function resolveAgentTool(
  name: AgentToolName,
  registry: AgentToolRegistry
): AgentToolAdapter | null {
  const adapter = registry[name];
  return typeof adapter === "function" ? adapter : null;
}

/** Type helper: records the full closed set of execution type names. */
export type { PlanExecutionType as ExecutionTypeForRegistry };