import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import { addPlanStep, getPlanWithSteps } from "@/lib/tasks";
import { UUID_PATTERN, isUuidLike } from "@/lib/tasks";
import type { $PlanStep } from "@/lib/tasks";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

const stepSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(1000).nullable().optional(),
  position: z.number().int().positive().optional(),
  dependsOn: z.array(z.string().uuid()).max(8).optional(),
  dependsOnPositions: z.array(z.number().int().positive()).max(8).optional(),
  taskId: z.string().uuid().nullable().optional(),
  estimatedMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  dueAt: z.string().trim().max(64).nullable().optional(),
});

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

export async function POST(request: Request, { params }: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return jsonError(400, "invalid_plan_id");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }
  const parsed = stepSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_step");

  const supabase = await getSupabaseServerClient();
  const detail = await getPlanWithSteps(supabase, id);
  if (!detail) return jsonError(404, "not_found");

  // References from the body must reference the caller's own rows; the store's
  // RLS + the DB policy re-verify, and isUuidLike bounds the gate.
  const step = await addPlanStep(supabase, id, {
    title: parsed.data.title,
    description: parsed.data.description,
    position: parsed.data.position,
    dependsOn: parsed.data.dependsOn ?? [],
    dependsOnPositions: parsed.data.dependsOnPositions,
    taskId: parsed.data.taskId && isUuidLike(parsed.data.taskId) ? parsed.data.taskId : null,
    estimatedMinutes: parsed.data.estimatedMinutes,
    dueAt: parsed.data.dueAt,
  });
  if (!step) return jsonError(500, "step_create_failed");
  return Response.json({ step: serializeStep(step) }, { status: 201 });
}