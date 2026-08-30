// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: shared types, taxonomy and constants.
//
// The typed model is the boundary every other tasks module speaks:
//   status      → 5 closed values: pending / in_progress / completed /
//                 cancelled / failed. Transitions are transition-aware and
//                 never mutate ownership.
//   priority    → high / medium / low
//   recurrence  → none / daily / weekly / monthly — next-due is COMPUTED at
//                 read time from due_at, never stored as a rolling row.
//   source      → chat | ui | plan (provenance only, for honest UI labels)
//   category    → free text bucket (General fallback), trimmed to 50 chars.
//
// Nothing in this file depends on Supabase, Gemini or the network, so every
// layer below is unit-testable with plain fixtures.
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_RECURRENCES = ["none", "daily", "weekly", "monthly"] as const;
export type TaskRecurrence = (typeof TASK_RECURRENCES)[number];

export const TASK_SOURCES = ["chat", "ui", "plan"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const PLAN_STATUSES = ["active", "completed", "cancelled"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const STEP_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const PLAN_SOURCES = ["chat", "ui"] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

/** A single owned task as the 6G layers and chat route see it. */
export interface $Task {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /** Free-text bucket; defaults to "General". */
  category: string;
  /** Instant (timestamptz). Render in the user's local timezone. */
  dueAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  recurrence: TaskRecurrence;
  tags: string[];
  source: TaskSource;
  /** Owning plan, when the task was materialized from a plan step. */
  planId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Payload accepted by the store for create/update. userId is NEVER accepted. */
export interface TaskWrite {
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  category?: string;
  dueAt?: string | null;
  recurrence?: TaskRecurrence;
  tags?: string[];
  source?: TaskSource;
  planId?: string | null;
  metadata?: Record<string, unknown>;
}

/** A single owned plan (objective + ordered, dependency-aware steps). */
export interface $Plan {
  id: string;
  userId: string;
  title: string;
  objective: string;
  description: string | null;
  status: PlanStatus;
  dueAt: string | null;
  source: PlanSource;
  createdAt: string;
  updatedAt: string;
}

/** A single plan step, always bound to one plan the caller owns. */
export interface $PlanStep {
  id: string;
  planId: string;
  userId: string;
  title: string;
  description: string | null;
  position: number;
  status: StepStatus;
  /** Sibling step ids this step depends on (validated app-side; no cycles). */
  dependsOn: string[];
  /** Optional linked task — always the caller's own task. */
  taskId: string | null;
  estimatedMinutes: number | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Payload accepted by the store for plan create (userId never accepted). */
export interface PlanWrite {
  title: string;
  objective: string;
  description?: string | null;
  dueAt?: string | null;
  source?: PlanSource;
}

/** Payload accepted by the store for step create. */
export interface PlanStepWrite {
  title: string;
  description?: string | null;
  position?: number;
  dependsOn?: string[];
  /** Creation-only: 1-based sibling positions to resolve to real IDs after insert. */
  dependsOnPositions?: number[];
  taskId?: string | null;
  estimatedMinutes?: number | null;
  dueAt?: string | null;
}

// ---------------------------------------------------------------------------
// Deterministic command intents (no LLM is ever consulted for these)
// ---------------------------------------------------------------------------

export const TASK_INTENTS = [
  "TASK_NONE",
  "TASK_CREATE",
  "TASK_LIST",
  "TASK_UPDATE",
  "TASK_COMPLETE",
  "TASK_CANCEL",
  "TASK_DELETE",
  "TASK_RESCHEDULE",
] as const;

export type TaskIntentKind = (typeof TASK_INTENTS)[number];

/** Parsed deterministic task command that the chat route turns into a reply. */
export interface TaskIntentResult {
  intent: TaskIntentKind;
  /** Human task title/description for CREATE ("remind me to call mom"). */
  title: string;
  /** Raw due phrase ("tomorrow at 6pm") — resolved later, timezone-aware. */
  rawDue: string | null;
  priority: TaskPriority;
  recurrence: TaskRecurrence;
  tags: string[];
  /** Target phrase for UPDATE/COMPLETE/CANCEL/DELETE/RESCHEDULE commands. */
  target: string;
  /** New due-phrase for RESCHEDULE. */
  rescheduleTo: string | null;
  reason: string;
}

export const PLAN_INTENTS = ["PLAN_NONE", "PLAN_CREATE", "PLAN_STATUS"] as const;
export type PlanIntentKind = (typeof PLAN_INTENTS)[number];

export interface PlanIntentResult {
  intent: PlanIntentKind;
  /** Objective for PLAN_CREATE ("my physics exam prep"). */
  objective: string;
  /** Optional explicit title ("a 2-week study plan"). */
  title: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Bounded-surface constants
// ---------------------------------------------------------------------------

/** Column max for tasks.title (checked also in the migration DDL). */
export const TASK_TITLE_LIMIT = 200;
/** Column max for tasks.description (checked also in the migration DDL). */
export const TASK_DESCRIPTION_LIMIT = 1000;
/** Column max for plans.objective (checked also in the migration DDL). */
export const PLAN_OBJECTIVE_LIMIT = 1000;
/** Hard cap so a list never bloats a chat request. */
export const TASK_FETCH_LIMIT = 200;
/** Hard cap on steps returned with a plan. */
export const PLAN_STEP_FETCH_LIMIT = 50;
/** Max tags accepted per task. */
export const MAX_TAGS = 8;
/** Ceiling for the planner step templates. */
export const PLAN_MAX_STEPS = 8;

/** True when the stored task is past its due moment (overdue) or due today. */
export function isTaskOverdue(task: Pick<$Task, "status" | "dueAt">, now: Date): boolean {
  if (task.status === "completed" || task.status === "cancelled") return false;
  if (!task.dueAt) return false;
  return new Date(task.dueAt).getTime() <= now.getTime();
}