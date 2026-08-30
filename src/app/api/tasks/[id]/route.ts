import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import { deleteTask, getTask, updateTask } from "@/lib/tasks";
import { UUID_PATTERN } from "@/lib/tasks";
import type { $Task } from "@/lib/tasks";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled", "failed"] as const;

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    priority: z.enum(["high", "medium", "low"]).optional(),
    category: z.string().trim().max(50).optional(),
    dueAt: z.string().trim().max(64).nullable().optional(),
    recurrence: z.enum(["none", "daily", "weekly", "monthly"]).optional(),
    tags: z.array(z.string().trim().max(30)).max(8).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

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

export async function GET(_request: Request, { params }: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return jsonError(400, "invalid_id");

  const supabase = await getSupabaseServerClient();
  const task = await getTask(supabase, id);
  if (!task) return jsonError(404, "not_found");
  return Response.json({ task: serializeTask(task) });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return jsonError(400, "invalid_id");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_patch");

  const supabase = await getSupabaseServerClient();
  const existing = await getTask(supabase, id);
  if (!existing) return jsonError(404, "not_found");

  const { title, description, priority, category, dueAt, recurrence, tags, status, metadata } =
    parsed.data;
  const task = await updateTask(supabase, id, {
    title,
    description,
    priority,
    category,
    dueAt,
    recurrence,
    tags,
    status,
    metadata,
  });
  if (!task) return jsonError(500, "task_update_failed");
  return Response.json({ task: serializeTask(task) });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return jsonError(400, "invalid_id");

  const supabase = await getSupabaseServerClient();
  const existing = await getTask(supabase, id);
  if (!existing) return jsonError(404, "not_found");

  const ok = await deleteTask(supabase, id);
  if (!ok) return jsonError(500, "task_delete_failed");
  return Response.json({ deleted: true });
}