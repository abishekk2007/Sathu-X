import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import {
  createTask,
  listTasks,
  validateTags,
} from "@/lib/tasks";
import type { $Task } from "@/lib/tasks";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const taskWriteSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).nullable().optional(),
    priority: z.enum(["high", "medium", "low"]).optional(),
    category: z.string().trim().max(50).optional(),
    dueAt: z.string().trim().max(64).nullable().optional(),
    recurrence: z.enum(["none", "daily", "weekly", "monthly"]).optional(),
    tags: z.array(z.string().trim().max(30)).max(8).optional(),
    planId: z.string().uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.prototype.hasOwnProperty.call(value, "title"), {
    message: "title is required",
  });

const LIST_STATUS_VALUES = ["pending", "in_progress", "completed", "cancelled", "failed"] as const;

function serializeTask(task: $Task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    category: task.category,
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    recurrence: task.recurrence,
    tags: task.tags,
    source: task.source,
    planId: task.planId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const planId = url.searchParams.get("planId");
  const category = url.searchParams.get("category");
  const search = url.searchParams.get("search")?.trim() || undefined;
  const overdue = url.searchParams.get("overdue") === "true";
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);

  if (status && !(LIST_STATUS_VALUES as readonly string[]).includes(status)) {
    return jsonError(400, "invalid_status");
  }

  const supabase = await getSupabaseServerClient();
  const tasks = await listTasks(supabase, {
    status: (status as $Task["status"]) || undefined,
    planId: planId || undefined,
    category: category || undefined,
    search,
    overdue: overdue || undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  });
  return Response.json({ tasks: tasks.map(serializeTask) });
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }
  const parsed = taskWriteSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, "invalid_task");
  }

  // The owner is NEVER accepted from the body — the DB derives auth.uid().
  const { title, description, priority, category, dueAt, recurrence, tags, planId, metadata } =
    parsed.data;

  const supabase = await getSupabaseServerClient();
  const task = await createTask(supabase, {
    title,
    description: description ?? null,
    priority,
    category,
    dueAt: dueAt ?? null,
    recurrence,
    tags: validateTags(tags),
    planId: planId ?? null,
    metadata,
    source: "ui",
  });
  if (!task) {
    return jsonError(500, "task_create_failed");
  }
  console.log(`[api/tasks] created task ${task.id} (uid=${user.id.slice(0, 8)})`);
  return Response.json({ task: serializeTask(task) }, { status: 201 });
}