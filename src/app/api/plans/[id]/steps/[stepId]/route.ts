import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import { setStepStatus } from "@/lib/tasks";
import { UUID_PATTERN } from "@/lib/tasks";
import type { $PlanStep } from "@/lib/tasks";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

interface RouteContext {
  params: Promise<{ id: string; stepId: string }>;
}

const STEP_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

const stepPatchSchema = z
  .object({
    status: z.enum(STEP_STATUSES),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

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

export async function PATCH(request: Request, { params }: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id, stepId } = await params;
  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(stepId)) return jsonError(400, "invalid_id");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }
  const parsed = stepPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_step_patch");

  const supabase = await getSupabaseServerClient();
  const step = await setStepStatus(supabase, stepId, parsed.data.status);
  if (!step) return jsonError(404, "not_found");
  return Response.json({ step: serializeStep(step) });
}