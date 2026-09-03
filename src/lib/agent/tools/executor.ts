// ---------------------------------------------------------------------------
// Phase 8C — Agent Tool Calling: executor.
//
// `validateAgentPlan` + `executeAgentPlan` turn an immutable 8B `AgentPlan`
// into an `AgentExecutionResult` without ever mutating the plan. Execution is
// deterministic, sequential, dependency-gated, bounded, and at-most-once per
// step:
//   - steps run in ascending `order` (no autonomous re-planning),
//   - a step whose dependency FAILED/TIMEOUT/SKIPPED is itself marked SKIPPED,
//   - UNAVAILABLE does NOT block (the capability is absent, not failed),
//   - every tool call is bounded by a per-step timeout and a global deadline
//     and a hard call-count ceiling,
//   - no dynamic import / eval / shell / arbitrary URL or filesystem ops.
// ---------------------------------------------------------------------------

import type { AgentPlan, PlanExecutionType } from "../planner";
import { PLAN_EXECUTION_TYPES } from "../planner";
import type {
  AgentExecutionResult,
  AgentToolResult,
  AgentToolName,
  ExecuteAgentPlanOptions,
} from "./types";
import { resolveAgentTool, agentToolSkipped, type AgentToolRegistry } from "./registry";
import { buildAdapters } from "./adapters";
import { evaluateToolSafety } from "../safety";

/** Hard ceiling on a single tool call (ms). */
export const DEFAULT_TOOL_TIMEOUT_MS = 20_000;
/** Total deadline for the whole plan execution (ms). */
export const MAX_AGENT_EXECUTION_MS = 40_000;
/** Max tool calls across the whole execution. */
export const MAX_AGENT_TOOL_CALLS = 16;

export interface PlanValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validates that a plan is safe + consistent before execution. Pure. */
export function validateAgentPlan(plan: AgentPlan | null | undefined): PlanValidationResult {
  const errors: string[] = [];
  if (!plan) {
    return { ok: false, errors: ["plan is missing"] };
  }
  if (plan.version !== 1) {
    errors.push(`unsupported plan version: ${plan.version}`);
  }
  if (plan.status !== "PLANNED") {
    errors.push(`plan must be PLANNED to execute, got ${plan.status}`);
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    errors.push("plan has no steps");
    return { ok: errors.length === 0, errors };
  }

  const ids = new Set<string>();
  const orders = new Set<number>();
  const byId = new Map<string, { order: number }>();

  for (const step of plan.steps) {
    if (typeof step !== "object" || step === null) {
      errors.push("a step is malformed");
      continue;
    }
    if (!step.id || typeof step.id !== "string") {
      errors.push("a step has no id");
    } else if (ids.has(step.id)) {
      errors.push(`duplicate step id: ${step.id}`);
    } else {
      ids.add(step.id);
    }
    if (typeof step.executionType !== "string" || !(PLAN_EXECUTION_TYPES as readonly string[]).includes(step.executionType)) {
      errors.push(`step ${step.id ?? "?"} has a closed-set-violating execution type: ${String(step.executionType)}`);
    }
    if (typeof step.order !== "number" || !Number.isInteger(step.order) || orders.has(step.order)) {
      errors.push(`step ${step.id ?? "?"} has a non-unique/non-integer order`);
    } else {
      orders.add(step.order);
      byId.set(step.id, { order: step.order });
    }
    if (step.dependencyIds && Array.isArray(step.dependencyIds)) {
      for (const dep of step.dependencyIds) {
        if (typeof dep !== "string") {
          errors.push(`step ${step.id ?? "?"} has a non-string dependency`);
        }
      }
    }
  }

  // Forward / circular dependency detection using order.
  const realIds = new Set(plan.steps.map((s) => s.id));
  for (const step of plan.steps) {
    for (const dep of step.dependencyIds ?? []) {
      if (!realIds.has(dep)) {
        errors.push(`step ${step.id} depends on unknown step ${dep}`);
      } else {
        const depOrder = byId.get(dep)?.order ?? -1;
        const ownOrder = byId.get(step.id)?.order ?? -1;
        if (depOrder >= ownOrder) {
          errors.push(`step ${step.id} has a forward/circular dependency on ${dep}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("tool call exceeded the time budget");
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Normalizes an unexpected throw from an adapter into a safe FAILED result. */
function normalizeFailure(
  toolName: PlanExecutionType,
  stepId: string
): AgentToolResult {
  return {
    toolName,
    stepId,
    status: "FAILED",
    error: { code: "internal", message: "The tool failed unexpectedly; continuing safely." },
  };
}

/**
 * Executes a validated plan deterministically. Returns an `AgentExecutionResult`
 * with per-step results, executed/skipped step ids, and bounded timing. The
 * plan is never mutated.
 */
export async function executeAgentPlan(
  plan: AgentPlan,
  options: ExecuteAgentPlanOptions,
  registry?: AgentToolRegistry
): Promise<AgentExecutionResult> {
  const started = Date.now();
  const validation = validateAgentPlan(plan);
  if (!validation.ok) {
    throw new Error(`invalid agent plan: ${validation.errors.join("; ")}`);
  }

  const maxExecutionMs = options.maxExecutionMs ?? MAX_AGENT_EXECUTION_MS;
  const maxToolCalls = options.maxToolCalls ?? MAX_AGENT_TOOL_CALLS;
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const ctx = options.context;
  const runtime = options.runtime ?? {};
  const now = options.now ?? Date.now;

  const resultsMap = new Map<string, AgentToolResult>();
  const executed: string[] = [];
  const skipped: string[] = [];
  const executedTypes = new Set<PlanExecutionType>();
  let toolCallCount = 0;

  // Deterministic order: ascending `order`, tie-broken by id for stability.
  const steps = [...plan.steps].sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.id.localeCompare(b.id)
  );

  for (const step of steps) {
    if (executed.length + skipped.length >= maxToolCalls) {
      // Ceiling reached — remaining steps are marked skipped.
      for (const remaining of steps) {
        if (!resultsMap.has(remaining.id)) {
          resultsMap.set(remaining.id, agentToolSkipped(
            remaining.executionType,
            remaining.id,
            "Execution call ceiling reached."
          ));
          skipped.push(remaining.id);
        }
      }
      break;
    }

    if (now() - started > maxExecutionMs) {
      for (const remaining of steps) {
        if (!resultsMap.has(remaining.id)) {
          resultsMap.set(remaining.id, agentToolSkipped(
            remaining.executionType,
            remaining.id,
            "Execution deadline reached."
          ));
          skipped.push(remaining.id);
        }
      }
      break;
    }

    // Dependency gating: if any dependency failed / timed out / was skipped,
    // this step is skipped (UNAVAILABLE does NOT block).
    const blockingDep = (step.dependencyIds ?? []).find((depId) => {
      const depResult = resultsMap.get(depId);
      if (!depResult) return false;
      return (
        depResult.status === "FAILED" ||
        depResult.status === "TIMEOUT" ||
        depResult.status === "SKIPPED"
      );
    });
    if (blockingDep) {
      const result = agentToolSkipped(
        step.executionType,
        step.id,
        `Dependency ${blockingDep} did not resolve.`
      );
      resultsMap.set(step.id, result);
      skipped.push(step.id);
      continue;
    }

    const adapter = resolveAgentTool(step.executionType, registry ?? defaultRegistry());
    if (!adapter) {
      const result = agentToolSkipped(step.executionType, step.id, "Unknown tool type.");
      resultsMap.set(step.id, result);
      skipped.push(step.id);
      continue;
    }

    // Phase 8F — deterministic safety gate. When a safety context is supplied,
    // every step is authorized against the tool-safety matrix before it runs.
    // A denied (or unrecognized/unauthorized) tool fails CLOSED: its step is
    // marked as not_allowed and never executes, and it blocks any dependent
    // step (which the dependency-gating above enforces).
    if (options.safety) {
      const safetyDecision = evaluateToolSafety(
        step.executionType,
        options.safety.policies,
        options.safety.userId
      );
      if (!safetyDecision.allowed) {
        // FAILED (not SKIPPED) so dependent steps are blocked — a denied tool
        // must not silently degrade into downstream execution.
        const result: AgentToolResult = {
          toolName: step.executionType,
          stepId: step.id,
          status: "FAILED",
          error: {
            code: "not_allowed",
            message: "This action is not permitted, or requires confirmation.",
          },
          metadata: { source: "safety" },
        };
        resultsMap.set(step.id, result);
        executed.push(step.id);
        continue;
      }
    }

    toolCallCount += 1;
    executedTypes.add(step.executionType);
    const stepCtx = { ...ctx, stepId: step.id };
    try {
      const raw = await withTimeout(
        adapter(stepCtx, runtime),
        toolTimeoutMs
      );
      resultsMap.set(step.id, { ...raw, stepId: step.id });
      executed.push(step.id);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const result: AgentToolResult = timedOut
        ? { toolName: step.executionType, stepId: step.id, status: "TIMEOUT", error: { code: "timed_out", message: "The tool took too long and was stopped." } }
        : normalizeFailure(step.executionType, step.id);
      resultsMap.set(step.id, result);
      (timedOut ? executed : executed).push(step.id);
    }
  }

  const results = steps.map((s) => resultsMap.get(s.id)!).filter(Boolean);
  const statuses = new Set(results.map((r) => r.status));
  const continuationSource = pickContinuationSource(results);

  const status: AgentExecutionResult["status"] = statuses.has("FAILED") || statuses.has("TIMEOUT")
    ? "PARTIAL"
    : statuses.size === 0
      ? "FAILED"
      : "COMPLETED";

  return {
    version: 1,
    status,
    results,
    executedStepIds: executed,
    skippedStepIds: skipped,
    metadata: {
      toolCallCount,
      durationMs: now() - started,
      ...(continuationSource ? { continuationSource } : {}),
    },
  };
}

/** Determines which execution type's result should drive the downstream
 *  pipeline continuation (the plan step whose output feeds the final answer). */
function pickContinuationSource(results: AgentToolResult[]): AgentToolName | undefined {
  const priority: PlanExecutionType[] = [
    "WEB_RESEARCH",
    "REALTIME_LOOKUP",
    "MAP_LOOKUP",
    "DOCUMENT_RETRIEVAL",
    "IMAGE_GENERATION",
    "TASK_MANAGEMENT",
    "VOICE_PROCESSING",
    "LOCATION_LOOKUP",
    "IMAGE_UNDERSTANDING",
  ];
  for (const type of priority) {
    const hit = results.find((r) => r.toolName === type && (r.status === "SUCCESS" || r.status === "UNAVAILABLE"));
    if (hit) return hit.toolName;
  }
  return undefined;
}

let defaultReg: AgentToolRegistry | null = null;

function defaultRegistry(): AgentToolRegistry {
  if (!defaultReg) {
    defaultReg = buildAdapters();
  }
  return defaultReg;
}

/** Used by tests / index to seed the default registry once. */
export function setDefaultRegistry(reg: AgentToolRegistry): void {
  defaultReg = reg;
}
