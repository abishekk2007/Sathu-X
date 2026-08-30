import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import { deletePlan, getPlanWithSteps, updatePlan } from "@/lib/tasks";
import { UUID_PATTERN } from "@/lib/tasks";
import type { $Plan, $PlanStep } from "@/lib/tasks";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PLAN_STATUSES = ["active", "completed", "cancelled"] as const;

const planPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    objective: z.string().trim().min(1).max(1000).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    dueAt: z.string().trim().max(64).nullable().optional(),
    status: z.enum(PLAN_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

function serializePlan(plan: $Plan) {
  return {
    id: plan.id,
    title: plan.title,
    objective: plan.objective,
    description: plan.description,
    status: plan.status,
    dueAt: plan.dueAt,
    source: plan.source,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function serializeStep(step: $PlanStep) {
  return {
    id: step.id,
    planId: step.planId,
    title: step.title,
    description: step.description,
    position: step.position,
    status: step.status,
    dependsOn: step.dependsOn,
    taskId: step.taskId,
    estimatedMinutes: step.estimatedMinutes,
    dueAt: step.dueAt,
    completedAt: step.completedAt,
    createdAt: step.createdAt,
    updatedAt: step.updatedAt,
  };
}

export async function GET(_request: Request, { params }: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return jsonError(400, "invalid_id");

  const supabase = await getSupabaseServerClient();
  const detail = await getPlanWithSteps(supabase, id);
  if (!detail) return jsonError(404, "not_found");
  return Response.json({ plan: serializePlan(detail.plan), steps: detail.steps.map(serializeStep) });
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
  const parsed = planPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_patch");

  const supabase = await getSupabaseServerClient();
  const detail = await getPlanWithSteps(supabase, id);
  if (!detail) return jsonError(404, "not_found");

  const { title, objective, description, dueAt, status } = parsed.data;
  const plan = await updatePlan(supabase, id, { title, objective, description, dueAt, status });
  if (!plan) return jsonError(500, "plan_update_failed");
  return Response.json({ plan: serializePlan(plan) });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return jsonError(400, "invalid_id");

  const supabase = await getSupabaseServerClient();
  const existing = await getPlanWithSteps(supabase, id);
  if (!existing) return jsonError(404, "not_found");

  const ok = await deletePlan(supabase, id);
  if (!ok) return jsonError(500, "plan_delete_failed");
  return Response.json({ deleted: true });
}