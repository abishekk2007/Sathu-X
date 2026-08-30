// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: security.
//
// Pure rules shared by the API routes, the chat route and the store:
//   * Ownership lives on the SERVER (auth.uid()); the app NEVER accepts a
//     userId/owner field from a request body.
//   * Task/plan/step transitions are explicit and transition-aware — a
//     cancelled task cannot silently become completed, a completed one cannot
//     jump back to pending via a malformed bulk update.
//   * Free-text fields are length-capped (mirrored in the DDL) and the same
//     chat prompt boundary that Phase 6F uses keeps user text out of the
//     system layer.
// ---------------------------------------------------------------------------

import type { TaskStatus, StepStatus } from "./types";
import { ValidationError } from "./validation";

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["in_progress", "completed", "cancelled", "failed"],
  in_progress: ["pending", "completed", "cancelled", "failed"],
  completed: ["pending"],
  cancelled: ["pending"],
  failed: ["pending", "in_progress"],
};

export const STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ["in_progress", "completed", "cancelled"],
  in_progress: ["pending", "completed", "cancelled"],
  completed: ["pending"],
  cancelled: ["pending"],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  if (from === to) return true;
  return (STEP_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (from !== to && !canTransitionTask(from, to)) {
    throw new ValidationError(
      `Invalid task status transition: ${from} → ${to}. Allowed: ${[...TASK_TRANSITIONS[from]].join(", ")} or unchanged.`
    );
  }
  return to;
}

export function assertStepTransition(from: StepStatus, to: StepStatus): StepStatus {
  if (from !== to && !canTransitionStep(from, to)) {
    throw new ValidationError(
      `Invalid step status transition: ${from} → ${to}. Allowed: ${[...STEP_TRANSITIONS[from]].join(", ")} or unchanged.`
    );
  }
  return to;
}

/**
 * Cross-user references are rejected by CONSTRUCTION: a step may only link to
 * tasks the caller owns, and a task may only attach to plans the caller owns.
 * The check happens before any query, in addition to the RLS policies.
 */
export function assertOwnIncoming<T extends { userId: string }>(
  callerUserId: string,
  row: T,
  label: string
): T {
  if (row.userId !== callerUserId) {
    throw new ValidationError(`Cannot ${label}: not owned by the caller.`);
  }
  return row;
}

const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Rejects strings carrying control/unescaped characters that could corrupt logs or SQL. */
export function assertSafeTextField(value: string, label: string): string {
  if (CONTROL_CHARACTER_RE.test(value)) {
    throw new ValidationError(`${label} contains unprintable control characters.`);
  }
  return value;
}

/** Any string destined for a SQL query builder must be length-bounded first. */
export function assertSqlSafeBound(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string.`);
  }
  return assertSafeTextField(value.slice(0, max), label);
}