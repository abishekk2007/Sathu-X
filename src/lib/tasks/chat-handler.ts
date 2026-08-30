// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: chat command handler.
//
// Turns a deterministic TASK_*/PLAN_* intent into an honest plain-text reply.
// Invoked from the chat route BEFORE any Gemini work. Rules:
//   * never claims a write that failed ("I couldn't create that task because…"),
//   * never guesses a due date — unresolvable due phrases stay null and the
//     reply says so explicitly,
//   * reminders are surfaced as due tasks; this build has NO push/notification
//     infrastructure and the reply is honest about that,
//   * a plan is a proposal — every step starts pending, nothing is marked done.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createTask,
  createPlan,
  deleteTask,
  cancelTask,
  completeTask,
  findTaskByTitle,
  listTasks,
  listPlans,
  getPlanWithSteps,
  buildTaskDigest,
  updateTask,
} from "./store";
import { resolveDuePhrase } from "./schedule";
import type {
  PlanIntentResult,
  TaskIntentResult,
  TaskPriority,
  TaskRecurrence,
} from "./types";
import { buildPlanDraft, draftToStepWrites, fetchPlannerContextForTasks } from "@/lib/planning";
import { toDateOnly } from "@/lib/study-planner";

export interface TaskCommandInput {
  supabase: SupabaseClient;
  taskIntent?: TaskIntentResult;
  planIntent?: PlanIntentResult;
  message: string;
  timezone?: string;
}

const RECURRENCE_LABEL: Record<TaskRecurrence, string> = {
  none: "one-off",
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: "high",
  medium: "medium",
  low: "low",
};

const NO_PUSH_NOTE =
  "(Reminder mode) — Spidey surfaces due tasks when you ask 'show my tasks'; no push notification exists in this version, so check the tasks board for the due list.";

function formatDue(dueAt: string | null, timezone?: string): string {
  if (!dueAt) return "no due date";
  const date = new Date(dueAt);
  if (!Number.isFinite(date.getTime())) return "no due date";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function quoteTitle(title: string): string {
  const clean = String(title ?? "").trim().replace(/\s+/g, " ").replace(/[.]+$/g, "");
  return clean.slice(0, 160);
}

function intentTitle(intent: TaskIntentResult): string {
  return quoteTitle(intent.title || intent.target);
}

// ---------------------------------------------------------------------------
// Task commands
// ---------------------------------------------------------------------------

async function handleTaskCreate(input: TaskCommandInput): Promise<string> {
  const intent = input.taskIntent!;
  const title = quoteTitle(intent.title);
  if (!title) {
    return "I couldn't create that task because the message didn't include a task name. Try: \u201cremind me to call mom at 6pm\u201d.";
  }

  const due = intent.rawDue
    ? resolveDuePhrase(intent.rawDue, { timezone: input.timezone })
    : null;

  const tags = intent.tags.length > 0 ? intent.tags : [];
  const task = await createTask(input.supabase, {
    title,
    description: null,
    priority: intent.priority,
    category: "General",
    dueAt: due?.dueAt ?? null,
    recurrence: intent.recurrence,
    tags,
    source: "chat",
  });
  if (!task) {
    return `I couldn't create the task "${title}" — the save failed. Nothing was recorded; please try again.`;
  }

  const recurrence = RECURRENCE_LABEL[task.recurrence];
  const parts = [
    `Task created: "${task.title}".`,
    `Status: pending.`,
    `Priority: ${PRIORITY_LABEL[task.priority]}.`,
    `Due: ${formatDue(task.dueAt, input.timezone)}.`,
    `Repeats: ${recurrence}.`,
    tags.length > 0 ? `Tags: ${tags.join(", ")}.` : "",
    due && !due.dueAt && intent.rawDue
      ? `Note: I couldn't pin down the time in "${intent.rawDue}", so I left it without a due date. Say "remind me to ${title} at 6pm" and I'll set it.`
      : "",
    `Say "show my tasks" any time to see it on the list.`,
  ].filter(Boolean);
  return parts.join(" ");
}

async function handleTaskList(input: TaskCommandInput): Promise<string> {
  const [digest, tasks] = await Promise.all([
    buildTaskDigest(input.supabase),
    listTasks(input.supabase, { limit: 100 }),
  ]);

  const open = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  if (open.length === 0) {
    const completed = digest.completedToday;
    return `You have no open tasks right now.${completed > 0 ? ` You completed ${completed} today — nice.` : ""} Say "set a reminder to…" or "create a task to…" to add one.`;
  }

  const now = Date.now();
  const overdue = open
    .filter((t) => t.dueAt && new Date(t.dueAt).getTime() <= now)
    .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime());
  const forthcoming = open
    .filter((t) => !t.dueAt || new Date(t.dueAt).getTime() > now)
    .sort((a, b) => (new Date(a.dueAt ?? 0).getTime()) - (new Date(b.dueAt ?? 0).getTime()));

  const line = (t: { title: string; status: string; dueAt: string | null; priority: TaskPriority }) =>
    `  • ${t.title}${t.status === "in_progress" ? " (in progress)" : ""} — ${PRIORITY_LABEL[t.priority]} priority, due ${formatDue(t.dueAt, input.timezone)}`;

  const parts: string[] = [];
  if (overdue.length > 0) {
    parts.push(`Overdue (${overdue.length}):`);
    parts.push(...overdue.slice(0, 5).map(line));
  }
  parts.push(`Open tasks (${open.length}):`);
  parts.push(...forthcoming.slice(0, 8).map(line));
  if (digest.completedToday > 0) parts.push(`Completed today: ${digest.completedToday}.`);
  if (digest.dueSoon.length > 0) parts.push(`Tip: ${digest.dueSoon[0]} is due within 3 days.`);
  return parts.join("\n");
}

async function handleTaskComplete(input: TaskCommandInput): Promise<string> {
  const target = intentTitle(input.taskIntent!);
  const task = await findTaskByTitle(input.supabase, target);
  if (!task) {
    return `I couldn't find a task matching "${target}", so I did NOT mark anything done. Say "show my tasks" to see the exact titles.`;
  }
  const updated = await completeTask(input.supabase, task.id);
  if (!updated) {
    return `I couldn't complete the task "${task.title}" — the change failed and nothing was recorded.`;
  }
  return `Done: "${task.title}" is now completed. ${NO_PUSH_NOTE}`;
}

async function handleTaskCancel(input: TaskCommandInput): Promise<string> {
  const target = intentTitle(input.taskIntent!);
  const task = await findTaskByTitle(input.supabase, target);
  if (!task) {
    return `I couldn't find a task matching "${target}", so I did NOT cancel anything. Say "show my tasks" to see the exact titles.`;
  }
  const updated = await cancelTask(input.supabase, task.id);
  if (!updated) {
    return `I couldn't cancel the task "${task.title}" — the change failed and nothing was recorded.`;
  }
  return `Task "${task.title}" is now cancelled.`;
}

async function handleTaskDelete(input: TaskCommandInput): Promise<string> {
  const target = intentTitle(input.taskIntent!);
  const task = await findTaskByTitle(input.supabase, target);
  if (!task) {
    return `I couldn't find a task matching "${target}", so I did NOT delete anything. Say "show my tasks" to see the exact titles.`;
  }
  const ok = await deleteTask(input.supabase, task.id);
  if (!ok) {
    return `I couldn't delete the task "${task.title}" — the delete failed and it is still there.`;
  }
  return `Task "${task.title}" was deleted.`;
}

async function handleTaskReschedule(input: TaskCommandInput): Promise<string> {
  const intent = input.taskIntent!;
  const target = quoteTitle(intent.target);
  const task = await findTaskByTitle(input.supabase, target);
  if (!task) {
    return `I couldn't find a task matching "${target}", so nothing was rescheduled. Say "show my tasks" to see the exact titles.`;
  }
  const due = intent.rescheduleTo
    ? resolveDuePhrase(intent.rescheduleTo, { timezone: input.timezone })
    : null;
  if (!due?.dueAt) {
    return `I couldn't read a clear new time from "${intent.rescheduleTo ?? ""}", so nothing changed. Try: "reschedule the task ${task.title} to tomorrow at 6pm".`;
  }
  const updated = await updateTask(input.supabase, task.id, { dueAt: due.dueAt });
  if (!updated) {
    return `I couldn't reschedule "${task.title}" — the change failed and nothing was recorded.`;
  }
  return `Task "${task.title}" rescheduled to ${formatDue(updated.dueAt, input.timezone)}.`;
}

async function handleTaskUpdate(input: TaskCommandInput): Promise<string> {
  const intent = input.taskIntent!;
  const target = quoteTitle(intent.target);
  const task = await findTaskByTitle(input.supabase, target);
  if (!task) {
    return `I couldn't find a task matching "${target}", so nothing was updated. Say "show my tasks" to see the exact titles.`;
  }
  const updated = await updateTask(input.supabase, task.id, {
    priority: intent.priority !== "medium" ? intent.priority : undefined,
    tags: intent.tags.length > 0 ? intent.tags : undefined,
  });
  if (!updated) {
    return `I couldn't update "${task.title}" — the change failed and nothing was recorded.`;
  }
  return `Task "${task.title}" updated (priority ${PRIORITY_LABEL[updated.priority]}, tags ${updated.tags.length > 0 ? updated.tags.join(", ") : "none"}).`;
}

// ---------------------------------------------------------------------------
// Plan commands
// ---------------------------------------------------------------------------

async function handlePlanCreate(input: TaskCommandInput): Promise<string> {
  const intent = input.planIntent!;
  const objective = intent.objective;
  if (!objective) {
    return "I couldn't create a plan because the request didn't state what for. Try: \u201ccreate a study plan for my physics exam\u201d.";
  }

  const context = await fetchPlannerContextForTasks(input.supabase, {
    todayIso: toDateOnly(new Date()),
  });
  const draft = buildPlanDraft(objective, context);
  const created = await createPlan(
    input.supabase,
    {
      title: draft.title,
      objective,
      description: null,
      source: "chat",
    },
    draftToStepWrites(draft)
  );
  if (!created) {
    return `I couldn't create the plan for "${objective}" — the save failed. Nothing was recorded; please try again.`;
  }

  const stepsText = created.steps
    .map(
      (step, index) =>
        `${index + 1}. ${step.title}${step.estimatedMinutes ? ` (~${step.estimatedMinutes} min)` : ""}${step.dependsOn.length > 0 ? " [after step " + (created.steps.findIndex((s) => s.id === step.dependsOn[0]) + 1) + "]" : ""}`
    )
    .join("\n");

  const headers = [
    `Plan created: "${created.plan.title}".`,
    `Objective: ${created.plan.objective}.`,
    "All steps start pending — a plan proposes the order; nothing is marked done until you tell me (e.g. \u201cstep 1 is done\u201d or complete the matching task).",
    "",
  ];
  return [...headers, stepsText].join("\n");
}

async function handlePlanStatus(input: TaskCommandInput): Promise<string> {
  const plans = await listPlans(input.supabase, { limit: 10 });
  if (plans.length === 0) {
    return "You have no plans yet. Try: \u201ccreate a study plan for my chemistry exam\u201d and I'll build a step-by-step plan.";
  }
  const parts: string[] = [];
  for (const plan of plans.slice(0, 5)) {
    const detail = await getPlanWithSteps(input.supabase, plan.id);
    const done = detail?.steps.filter((s) => s.status === "completed").length ?? 0;
    const total = detail?.steps.length ?? 0;
    parts.push(
      `• ${plan.title} (${plan.status}${total > 0 ? `, ${done}/${total} steps done` : ""})` +
        `\n    Objective: ${plan.objective}`
    );
  }
  parts.push("Say \u201ccreate a plan for …\u201d to add another, or \u201cshow my tasks\u201d to see the tasks built from a plan.");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Executes the router-decided 6G command and returns the human reply. */
export async function handleTaskCommand(input: TaskCommandInput): Promise<string> {
  const { taskIntent, planIntent } = input;

  if (planIntent?.intent === "PLAN_CREATE") {
    return handlePlanCreate(input);
  }
  if (planIntent?.intent === "PLAN_STATUS") {
    return handlePlanStatus(input);
  }

  switch (taskIntent?.intent) {
    case "TASK_CREATE":
      return handleTaskCreate(input);
    case "TASK_LIST":
      return handleTaskList(input);
    case "TASK_COMPLETE":
      return handleTaskComplete(input);
    case "TASK_CANCEL":
      return handleTaskCancel(input);
    case "TASK_DELETE":
      return handleTaskDelete(input);
    case "TASK_RESCHEDULE":
      return handleTaskReschedule(input);
    case "TASK_UPDATE":
      return handleTaskUpdate(input);
    default:
      return "I detected a task or planning request but couldn't execute it. Try: \u201cremind me to <thing> at <time>\u201d, \u201cshow my tasks\u201d, or \u201ccreate a study plan for <subject>\u201d.";
  }
}