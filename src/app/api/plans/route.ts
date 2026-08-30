import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import { createPlan, listPlans, validateStepCount } from "@/lib/tasks";
import type { $Plan, $PlanStep } from "@/lib/tasks";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const PLAN_STATUSES = ["active", "completed", "cancelled"] as const;

const stepSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(1000).nullable().optional(),
  position: z.number().int().positive().optional(),
  dependsOnPositions: z.array(z.number().int().positive()).max(8).optional(),
  dependsOn: z.array(z.string().uuid()).max(8).optional(),
  taskId: z.string().uuid().nullable().optional(),
  estimatedMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  dueAt: z.string().trim().max(64).nullable().optional(),
});

const planCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    objective: z.string().trim().min(1).max(1000),
    description: z.string().trim().max(1000).nullable().optional(),
    dueAt: z.string().trim().max(64).nullable().optional(),
    steps: z.array(stepSchema).min(1).max(8),
  })
  .refine((value) => Object.prototype.hasOwnProperty.call(value, "objective"), {
    message: "objective is required",
  });

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

export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  if (status && !(PLAN_STATUSES as readonly string[]).includes(status)) {
    return jsonError(400, "invalid_status");
  }

  const supabase = await getSupabaseServerClient();
  const plans = await listPlans(supabase, { status: (status as $Plan["status"]) || undefined });
  return Response.json({ plans: plans.map(serializePlan) });
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
  const parsed = planCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_plan");
  const { title, objective, description, dueAt, steps } = parsed.data;
  validateStepCount(steps.length);

  const supabase = await getSupabaseServerClient();
  const created = await createPlan(
    supabase,
    {
      title: title ?? "Study plan",
      objective,
      description: description ?? null,
      dueAt: dueAt ?? null,
      source: "ui",
    },
    steps
  );
  if (!created) return jsonError(500, "plan_create_failed");
  console.log(`[api/plans] created plan ${created.plan.id} with ${created.steps.length} steps`);
  return Response.json(
    {
      plan: serializePlan(created.plan),
      steps: created.steps.map(serializeStep),
    },
    { status: 201 }
  );
}