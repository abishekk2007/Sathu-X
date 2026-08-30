// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: validation.
//
// Pure, deterministic validators used by BOTH the API routes and the chat
// route. Every rule here mirrors a constraint in the migration DDL so an app
// error and a database violation can never disagree.
// ---------------------------------------------------------------------------

import {
  PLAN_MAX_STEPS,
  PLAN_OBJECTIVE_LIMIT,
  TASK_DESCRIPTION_LIMIT,
  TASK_PRIORITIES,
  TASK_RECURRENCES,
  TASK_TITLE_LIMIT,
  MAX_TAGS,
} from "./types";
import type { TaskPriority, TaskRecurrence } from "./types";

/** Matches a Supabase UUID. Shared with Phase 6F route conventions. */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const VALID_PRIORITIES: TaskPriority[] = [...TASK_PRIORITIES];
export const VALID_RECURRENCES: TaskRecurrence[] = [...TASK_RECURRENCES];

/** Recursively bounds a JSON object so metadata can never exceed a sane payload. */
export function normalizeMetadata(
  value: unknown,
  depth = 0,
  keyBudget = 16
): Record<string, unknown> {
  if (depth > 3) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Date) {
    return {};
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (count >= keyBudget) break;
    if (typeof val === "string") {
      if (val.length > 400) continue;
      out[key] = val;
    } else if (typeof val === "number" && Number.isFinite(val)) {
      out[key] = val;
    } else if (typeof val === "boolean") {
      out[key] = val;
    } else if (Array.isArray(val) && val.length <= 8) {
      out[key] = val.slice(0, 8);
    } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const nested = normalizeMetadata(val, depth + 1, 8);
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
    count += 1;
  }
  return out;
}

export function validateTitle(title: string): string {
  const trimmed = String(title ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > TASK_TITLE_LIMIT) {
    throw new ValidationError(
      `Title must be 1–${TASK_TITLE_LIMIT} characters.`
    );
  }
  return trimmed;
}

export function validateTaskDescription(description: string | null | undefined): string | null {
  if (description == null) return null;
  const trimmed = String(description).trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > TASK_DESCRIPTION_LIMIT) {
    throw new ValidationError(
      `Description must be at most ${TASK_DESCRIPTION_LIMIT} characters.`
    );
  }
  return trimmed;
}

export function validatePriority(priority: unknown): TaskPriority {
  if (priority === undefined || priority === null) return "medium";
  const value = String(priority).toLowerCase();
  if (!VALID_PRIORITIES.includes(value as TaskPriority)) {
    throw new ValidationError("Priority must be high, medium or low.");
  }
  return value as TaskPriority;
}

export function validateRecurrence(recurrence: unknown): TaskRecurrence {
  if (recurrence === undefined || recurrence === null) return "none";
  const value = String(recurrence).toLowerCase();
  if (!VALID_RECURRENCES.includes(value as TaskRecurrence)) {
    throw new ValidationError("Recurrence must be none, daily, weekly or monthly.");
  }
  return value as TaskRecurrence;
}

export function validateTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) {
    throw new ValidationError("Tags must be an array of strings.");
  }
  const out: string[] = [];
  for (const tag of tags) {
    if (out.length >= MAX_TAGS) break;
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim().toLowerCase().replace(/\s+/g, "-");
    if (trimmed.length === 0 || trimmed.length > 30) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function validateCategory(category: unknown): string {
  if (category === undefined || category === null) return "General";
  const value = String(category).trim();
  if (value.length === 0 || value.length > 50) return "General";
  return value;
}

/** Rejects impossible/absurd due-dates (year 9999, far-past epochs, etc.). */
export function validateDueAt(dueAt: string | null | undefined): string | null {
  if (dueAt === undefined || dueAt === null) return null;
  const date = new Date(dueAt);
  if (!Number.isFinite(date.getTime())) {
    throw new ValidationError("due_at must be a valid ISO timestamp.");
  }
  const year = date.getFullYear();
  if (year < 2000 || year > 2200) {
    throw new ValidationError("due_at must be between the years 2000 and 2200.");
  }
  return date.toISOString();
}

export function validatePlanObjective(objective: string): string {
  const trimmed = String(objective ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > PLAN_OBJECTIVE_LIMIT) {
    throw new ValidationError(
      `Objective must be 1–${PLAN_OBJECTIVE_LIMIT} characters.`
    );
  }
  return trimmed;
}

export function validateStepCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > PLAN_MAX_STEPS) {
    throw new ValidationError(`A plan must have 1–${PLAN_MAX_STEPS} steps.`);
  }
}

/** True for a plausible non-empty plan id reference ("parent"/"task" links). */
export function isUuidLike(value: unknown): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value);
}