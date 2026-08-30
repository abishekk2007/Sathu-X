// ---------------------------------------------------------------------------
// Phase 6G â€” Tasks + Planning: persistence service (RLS-scoped).
//
// Every function speaks to the row-level security-scoped server client â€” the
// database derives the owner from the session (auth.uid()), and NO function
// here ever accepts or writes a user_id. Ownership mistakes are therefore
// impossible by construction: a foreign row simply doesn't match and returns
// null / 0 instead of leaking or mutating someone else's task/plan.
//
// Fail-open contract: DB errors return [] / null / false / 0 â€” the chat route
// treats tasks as an auxiliary layer and never fabricates success. Logs stay
// sanitized (titles only, truncated).
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  $Plan,
  $PlanStep,
  $Task,
  PlanSource,
  PlanStepWrite,
  PlanStatus,
  PlanWrite,
  StepStatus,
  TaskPriority,
  TaskRecurrence,
  TaskStatus,
  TaskWrite,
} from "./types";
import { PLAN_STEP_FETCH_LIMIT, TASK_FETCH_LIMIT } from "./types";
import { assertTaskTransition, assertStepTransition } from "./security";
import {
  isUuidLike,
  normalizeMetadata,
  validateCategory,
  validateDueAt,
  validatePriority,
  validateRecurrence,
  validateTags,
  validateTaskDescription,
  validateTitle,
} from "./validation";

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: string;
  due_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  recurrence: TaskRecurrence;
  tags: string[] | null;
  source: string;
  plan_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function mapTaskRow(row: TaskRow): $Task {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    category: row.category,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    recurrence: row.recurrence,
    tags: row.tags ?? [],
    source: (["chat", "ui", "plan"].includes(row.source) ? row.source : "ui") as $Task["source"],
    planId: row.plan_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface PlanRow {
  id: string;
  user_id: string;
  title: string;
  objective: string;
  description: string | null;
  status: PlanStatus;
  due_at: string | null;
  source: PlanSource;
  created_at: string;
  updated_at: string;
}

function mapPlanRow(row: PlanRow): $Plan {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    objective: row.objective,
    description: row.description,
    status: row.status,
    dueAt: row.due_at,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface StepRow {
  id: string;
  plan_id: string;
  user_id: string;
  title: string;
  description: string | null;
  position: number;
  status: StepStatus;
  depends_on: string[] | null;
  task_id: string | null;
  estimated_minutes: number | null;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapStepRow(row: StepRow): $PlanStep {
  return {
    id: row.id,
    planId: row.plan_id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    position: row.position,
    status: row.status,
    dependsOn: row.depends_on ?? [],
    taskId: row.task_id,
    estimatedMinutes: row.estimated_minutes,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TASK_COLUMNS =
  "id, user_id, title, description, status, priority, category, due_at, completed_at, cancelled_at, recurrence, tags, source, plan_id, metadata, created_at, updated_at";
const PLAN_COLUMNS =
  "id, user_id, title, objective, description, status, due_at, source, created_at, updated_at";
const STEP_COLUMNS =
  "id, plan_id, user_id, title, description, position, status, depends_on, task_id, estimated_minutes, due_at, completed_at, created_at, updated_at";

// ---------------------------------------------------------------------------
// Tasks â€” reads
// ---------------------------------------------------------------------------

export interface TaskListFilter {
  status?: TaskStatus;
  planId?: string;
  category?: string;
  overdue?: boolean;
  duesFrom?: string;
  duesTo?: string;
  search?: string;
  limit?: number;
}

export async function listTasks(
  supabase: SupabaseClient,
  filters: TaskListFilter = {}
): Promise<$Task[]> {
  try {
    let query = supabase
      .from("tasks")
      .select(TASK_COLUMNS)
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.planId && isUuidLike(filters.planId)) query = query.eq("plan_id", filters.planId);
    if (filters.category) query = query.eq("category", filters.category);
    if (filters.duesFrom) query = query.gte("due_at", filters.duesFrom);
    if (filters.duesTo) query = query.lte("due_at", filters.duesTo);
    if (filters.search) {
      query = query.ilike("title", `%${filters.search.trim().slice(0, 100)}%`);
    }
    query = query.limit(Math.min(filters.limit ?? 100, TASK_FETCH_LIMIT));
    const { data, error } = await query;
    if (error) {
      console.error("[tasks/store] listTasks select failed (RLS-scoped)");
      return [];
    }
    let tasks = (data ?? []).map(mapTaskRow);
    if (filters.overdue === true) {
      const now = Date.now();
      tasks = tasks.filter(
        (t) => t.dueAt && new Date(t.dueAt).getTime() <= now && t.status === "pending"
      );
    }
    return tasks;
  } catch {
    console.error("[tasks/store] listTasks crashed");
    return [];
  }
}

export async function getTask(
  supabase: SupabaseClient,
  id: string
): Promise<$Task | null> {
  try {
    if (!isUuidLike(id)) return null;
    const { data, error } = await supabase
      .from("tasks")
      .select(TASK_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return mapTaskRow(data as TaskRow);
  } catch {
    console.error("[tasks/store] getTask crashed");
    return null;
  }
}

export interface TaskCountFilter {
  status?: TaskStatus;
}

export async function countTasksByStatus(
  supabase: SupabaseClient,
  filter: TaskCountFilter = {}
): Promise<Record<TaskStatus, number>> {
  const out: Record<TaskStatus, number> = {
    pending: 0, in_progress: 0, completed: 0, cancelled: 0, failed: 0,
  };
  try {
    let query = supabase.from("tasks").select("status");
    if (filter.status) query = query.eq("status", filter.status);
    query = query.limit(TASK_FETCH_LIMIT);
    const { data, error } = await query;
    if (error || !data) return out;
    for (const row of data) {
      const status = row.status as TaskStatus;
      if (status in out) out[status] += 1;
    }
    return out;
  } catch {
    return out;
  }
}

// ---------------------------------------------------------------------------
// Tasks â€” writes
// ---------------------------------------------------------------------------

/** Creates an owned task. userId is NEVER passed to the DB. */
export async function createTask(
  supabase: SupabaseClient,
  write: TaskWrite
): Promise<$Task | null> {
  try {
    const title = validateTitle(write.title);
    const description = validateTaskDescription(write.description ?? null);
    const priority = validatePriority(write.priority);
    const recurrence = validateRecurrence(write.recurrence);
    const tags = validateTags(write.tags);
    const category = validateCategory(write.category);
    const dueAt = validateDueAt(write.dueAt ?? null);
    const planId = write.planId && isUuidLike(write.planId) ? write.planId : null;
    const metadata = normalizeMetadata(write.metadata);
    const source = write.source ?? "chat";

    const { data, error } = await supabase
      .from("tasks")
      .insert({
        title,
        description,
        status: "pending",
        priority,
        category,
        due_at: dueAt,
        recurrence,
        tags,
        source,
        plan_id: planId,
        metadata,
      })
      .select(TASK_COLUMNS)
      .single();
    if (error || !data) {
      console.error("[tasks/store] createTask insert failed");
      return null;
    }
    return mapTaskRow(data as TaskRow);
  } catch {
    console.error("[tasks/store] createTask crashed");
    return null;
  }
}

/** Applies a validated, transition-aware status change. */
export async function setTaskStatus(
  supabase: SupabaseClient,
  id: string,
  status: TaskStatus
): Promise<$Task | null> {
  try {
    const current = await getTask(supabase, id);
    if (!current) return null;
    const finalStatus = assertTaskTransition(current.status, status);
    const patch: Record<string, unknown> = { status: finalStatus };
    const now = new Date().toISOString();
    if (finalStatus === "completed") {
      patch.completed_at = now;
      patch.cancelled_at = null;
    } else if (finalStatus === "cancelled") {
      patch.cancelled_at = now;
      patch.completed_at = null;
    } else {
      patch.completed_at = null;
      patch.cancelled_at = null;
    }
    const { data, error } = await supabase
      .from("tasks")
      .update(patch)
      .eq("id", id)
      .select(TASK_COLUMNS)
      .single();
    if (error || !data) {
      console.error("[tasks/store] setTaskStatus update failed");
      return null;
    }
    return mapTaskRow(data as TaskRow);
  } catch {
    console.error("[tasks/store] setTaskStatus crashed");
    return null;
  }
}

export async function completeTask(supabase: SupabaseClient, id: string): Promise<$Task | null> {
  return setTaskStatus(supabase, id, "completed");
}

export async function cancelTask(supabase: SupabaseClient, id: string): Promise<$Task | null> {
  return setTaskStatus(supabase, id, "cancelled");
}

/** Deterministic title-match helper for chat commands ("complete the task 'read ch 3'"). */
export async function findTaskByTitle(
  supabase: SupabaseClient,
  titleFragment: string
): Promise<$Task | null> {
  try {
    if (!titleFragment || titleFragment.length < 2) return null;
    const tasks = await listTasks(supabase, { limit: 100 });
    const needle = titleFragment.toLowerCase().replace(/^the\s+/, "");
    const exact = tasks.find((t) => t.title.toLowerCase() === needle);
    if (exact) return exact;
    const startsWith = tasks.find(
      (t) => t.title.toLowerCase().startsWith(needle) && t.status !== "completed" && t.status !== "cancelled"
    );
    if (startsWith) return startsWith;
    const includes = tasks.find(
      (t) => t.status !== "completed" && t.status !== "cancelled" && t.title.toLowerCase().includes(needle)
    );
    return includes ?? startsWith ?? null;
  } catch {
    return null;
  }
}

export async function updateTask(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<TaskWrite> & { status?: TaskStatus }
): Promise<$Task | null> {
  try {
    const current = await getTask(supabase, id);
    if (!current) return null;

    const payload: Record<string, unknown> = {};
    if (patch.title !== undefined) payload.title = validateTitle(patch.title);
    if (patch.description !== undefined) {
      payload.description = validateTaskDescription(patch.description ?? null);
    }
    if (patch.priority !== undefined) payload.priority = validatePriority(patch.priority);
    if (patch.category !== undefined) payload.category = validateCategory(patch.category);
    if (patch.dueAt !== undefined) payload.due_at = validateDueAt(patch.dueAt ?? null);
    if (patch.recurrence !== undefined) payload.recurrence = validateRecurrence(patch.recurrence);
    if (patch.tags !== undefined) payload.tags = validateTags(patch.tags);
    if (patch.metadata !== undefined) payload.metadata = normalizeMetadata(patch.metadata);
    if (patch.status !== undefined) {
      const finalStatus = assertTaskTransition(current.status, patch.status);
      payload.status = finalStatus;
      const now = new Date().toISOString();
      if (finalStatus === "completed") {
        payload.completed_at = now;
        payload.cancelled_at = null;
      } else if (finalStatus === "cancelled") {
        payload.cancelled_at = now;
        payload.completed_at = null;
      } else {
        payload.completed_at = null;
        payload.cancelled_at = null;
      }
    }
    if (Object.keys(payload).length === 0) return current;

    const { data, error } = await supabase
      .from("tasks")
      .update(payload)
      .eq("id", id)
      .select(TASK_COLUMNS)
      .single();
    if (error || !data) {
      console.error("[tasks/store] updateTask update failed");
      return null;
    }
    return mapTaskRow(data as TaskRow);
  } catch {
    console.error("[tasks/store] updateTask crashed");
    return null;
  }
}

export async function rescheduleTask(
  supabase: SupabaseClient,
  id: string,
  dueAt: string | null
): Promise<$Task | null> {
  return updateTask(supabase, id, { dueAt });
}

export async function deleteTask(supabase: SupabaseClient, id: string): Promise<boolean> {
  try {
    if (!isUuidLike(id)) return false;
    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (error) {
      console.error("[tasks/store] deleteTask failed");
      return false;
    }
    return true;
  } catch {
    console.error("[tasks/store] deleteTask crashed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function listPlans(
  supabase: SupabaseClient,
  opts: { status?: PlanStatus; limit?: number } = {}
): Promise<$Plan[]> {
  try {
    let query = supabase
      .from("plans")
      .select(PLAN_COLUMNS)
      .order("created_at", { ascending: false });
    if (opts.status) query = query.eq("status", opts.status);
    query = query.limit(Math.min(opts.limit ?? 20, 100));
    const { data, error } = await query;
    if (error || !data) return [];
    return (data ?? []).map(mapPlanRow);
  } catch {
    console.error("[plans/store] listPlans crashed");
    return [];
  }
}

export async function getPlan(supabase: SupabaseClient, id: string): Promise<$Plan | null> {
  try {
    if (!isUuidLike(id)) return null;
    const { data, error } = await supabase
      .from("plans")
      .select(PLAN_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return mapPlanRow(data as PlanRow);
  } catch {
    console.error("[plans/store] getPlan crashed");
    return null;
  }
}

export async function listPlanSteps(
  supabase: SupabaseClient,
  planId: string
): Promise<$PlanStep[]> {
  try {
    const { data, error } = await supabase
      .from("plan_steps")
      .select(STEP_COLUMNS)
      .eq("plan_id", planId)
      .order("position", { ascending: true })
      .limit(PLAN_STEP_FETCH_LIMIT);
    if (error || !data) return [];
    return (data ?? []).map(mapStepRow);
  } catch {
    console.error("[plans/store] listPlanSteps crashed");
    return [];
  }
}

export async function getPlanWithSteps(
  supabase: SupabaseClient,
  id: string
): Promise<{ plan: $Plan; steps: $PlanStep[] } | null> {
  const plan = await getPlan(supabase, id);
  if (!plan) return null;
  const steps = await listPlanSteps(supabase, id);
  return { plan, steps };
}

export async function createPlan(
  supabase: SupabaseClient,
  write: PlanWrite,
  steps: PlanStepWrite[]
): Promise<{ plan: $Plan; steps: $PlanStep[] } | null> {
  try {
    if (!Array.isArray(steps) || steps.length === 0) return null;
    const { data: planData, error: planError } = await supabase
      .from("plans")
      .insert({
        title: write.title.trim().slice(0, 200) || "Study plan",
        objective: write.objective.trim().slice(0, 1000),
        description: write.description ? write.description.trim().slice(0, 1000) : null,
        status: "active",
        due_at: validateDueAt(write.dueAt ?? null),
        source: write.source ?? "chat",
      })
      .select(PLAN_COLUMNS)
      .single();
    if (planError || !planData) {
      console.error("[plans/store] createPlan insert failed");
      return null;
    }
    const plan = mapPlanRow(planData as PlanRow);

    const stepRows = steps.map((step, index) => ({
      plan_id: plan.id,
      title: step.title.trim().slice(0, 300),
      description: step.description ? step.description.trim().slice(0, 1000) : null,
      position: step.position ?? index + 1,
      status: "pending" as StepStatus,
      depends_on: [],
      task_id: step.taskId && isUuidLike(step.taskId) ? step.taskId : null,
      estimated_minutes:
        typeof step.estimatedMinutes === "number"
          ? Math.min(1440, Math.max(1, Math.round(step.estimatedMinutes)))
          : null,
      due_at: validateDueAt(step.dueAt ?? null),
    }));

    const { data: stepsData, error: stepsError } = await supabase
      .from("plan_steps")
      .insert(stepRows)
      .select(STEP_COLUMNS);
    if (stepsError || !stepsData) {
      console.error("[plans/store] createPlan steps insert failed");
      return null;
    }
    const createdSteps = (stepsData ?? []).map(mapStepRow).sort((a, b) => a.position - b.position);

    // Dependencies arrived as 1-based sibling positions; resolve them to the
    // REAL generated ids so depends_on always references actual sibling rows.
    const idByPosition = new Map<number, string>();
    for (const row of createdSteps) idByPosition.set(row.position, row.id);
    const dependencyRefs = steps
      .map((step, index) => ({
        stepId: createdSteps[index]?.id,
        positions: step.dependsOnPositions ?? [],
        positionsById: step.dependsOn ?? [],
      }))
      .filter((d) => d.stepId && (d.positions.length > 0 || d.positionsById.length > 0));
    for (const dep of dependencyRefs) {
      const resolved: string[] = [];
      for (const p of dep.positions) {
        const id = idByPosition.get(p);
        if (id && id !== dep.stepId && !resolved.includes(id)) resolved.push(id);
      }
      for (const id of dep.positionsById) {
        if (createdSteps.some((s) => s.id === id) && id !== dep.stepId && !resolved.includes(id)) {
          resolved.push(id);
        }
      }
      if (resolved.length === 0) continue;
      const { error: depError } = await supabase
        .from("plan_steps")
        .update({ depends_on: resolved })
        .eq("id", dep.stepId);
      if (depError) {
        console.error("[plans/store] createPlan dependency resolution failed");
      }
    }
    console.log(`[tasks/store] created plan ${plan.id} with ${createdSteps.length} steps`);
    return { plan, steps: createdSteps };
  } catch {
    console.error("[plans/store] createPlan crashed");
    return null;
  }
}

export async function updatePlan(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<PlanWrite> & { status?: PlanStatus }
): Promise<$Plan | null> {
  try {
    const current = await getPlan(supabase, id);
    if (!current) return null;
    const payload: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      payload.title = patch.title.trim().slice(0, 200);
    }
    if (patch.objective !== undefined) {
      payload.objective = patch.objective.trim().slice(0, 1000);
    }
    if (patch.description !== undefined) {
      payload.description = patch.description ? patch.description.trim().slice(0, 1000) : null;
    }
    if (patch.dueAt !== undefined) payload.due_at = validateDueAt(patch.dueAt ?? null);
    if (patch.status !== undefined) payload.status = patch.status;
    if (Object.keys(payload).length === 0) return current;
    const { data, error } = await supabase
      .from("plans")
      .update(payload)
      .eq("id", id)
      .select(PLAN_COLUMNS)
      .single();
    if (error || !data) return null;
    return mapPlanRow(data as PlanRow);
  } catch {
    return null;
  }
}

export async function deletePlan(supabase: SupabaseClient, id: string): Promise<boolean> {
  try {
    if (!isUuidLike(id)) return false;
    const { error } = await supabase.from("plans").delete().eq("id", id);
    if (error) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plan steps â€” writes
// ---------------------------------------------------------------------------

export async function addPlanStep(
  supabase: SupabaseClient,
  planId: string,
  write: PlanStepWrite
): Promise<$PlanStep | null> {
  try {
    const existing = await listPlanSteps(supabase, planId);
    const { data, error } = await supabase
      .from("plan_steps")
      .insert({
        plan_id: planId,
        title: write.title.trim().slice(0, 300),
        description: write.description ? write.description.trim().slice(0, 1000) : null,
        position: write.position ?? existing.length + 1,
        status: "pending",
        depends_on: write.dependsOn ?? [],
        task_id: write.taskId && isUuidLike(write.taskId) ? write.taskId : null,
        estimated_minutes:
          typeof write.estimatedMinutes === "number"
            ? Math.min(1440, Math.max(1, Math.round(write.estimatedMinutes)))
            : null,
        due_at: validateDueAt(write.dueAt ?? null),
      })
      .select(STEP_COLUMNS)
      .single();
    if (error || !data) return null;
    return mapStepRow(data as StepRow);
  } catch {
    return null;
  }
}

export async function setStepStatus(
  supabase: SupabaseClient,
  stepId: string,
  status: StepStatus
): Promise<$PlanStep | null> {
  try {
    const { data: current, error: readError } = await supabase
      .from("plan_steps")
      .select(STEP_COLUMNS)
      .eq("id", stepId)
      .maybeSingle();
    if (readError || !current) return null;
    const finalStatus = assertStepTransition((current as StepRow).status, status);
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("plan_steps")
      .update({
        status: finalStatus,
        completed_at: finalStatus === "completed" ? now : null,
      })
      .eq("id", stepId)
      .select(STEP_COLUMNS)
      .single();
    if (error || !data) return null;
    return mapStepRow(data as StepRow);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic aggregation for chat ("show my tasks")
// ---------------------------------------------------------------------------

export interface TaskDigest {
  totalOpen: number;
  dueSoon: string[];
  overdue: string[];
  completedToday: number;
}

export async function buildTaskDigest(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<TaskDigest> {
  const tasks = await listTasks(supabase, { limit: 200 });
  const open = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  const dueSoon = open
    .filter((t) => t.dueAt && new Date(t.dueAt).getTime() <= now.getTime() + 3 * 86_400_000)
    .sort((a, b) => new Date(a.dueAt ?? 0).getTime() - new Date(b.dueAt ?? 0).getTime())
    .slice(0, 5)
    .map((t) => `${t.title} (${new Date(t.dueAt!).toISOString().slice(0, 10)})`);
  const overdue = open
    .filter((t) => t.dueAt && new Date(t.dueAt).getTime() <= now.getTime())
    .slice(0, 5)
    .map((t) => t.title);
  const completedToday = tasks.filter((t) => {
    if (t.status !== "completed" || !t.completedAt) return false;
    const d = new Date(t.completedAt);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }).length;
  return { totalOpen: open.length, dueSoon, overdue, completedToday };
}