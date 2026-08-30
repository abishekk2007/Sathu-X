import { z } from "zod";

import { serializePlanRow, serializeStudySessionRow } from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date");

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    startDate: DATE_STRING.optional(),
    endDate: DATE_STRING.optional(),
    dailyMinutes: z.number().int().min(1).max(960).optional(),
    status: z
      .enum(["draft", "active", "completed", "paused", "archived"])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" })
  .refine(
    (value) =>
      !value.startDate ||
      !value.endDate ||
      value.endDate >= value.startDate,
    { message: "date_order" }
  );

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Single plan + its sessions. RLS scopes everything to the owner. */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("study_plans")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      console.error("[api/study-plans/:id] GET failed");
      return jsonError(500, "server_error");
    }
    if (!data) return jsonError(404, "not_found");

    const { data: sessions } = await supabase
      .from("study_sessions")
      .select("*, subject:subjects(name), topic:subject_topics(name)")
      .eq("study_plan_id", id)
      .order("scheduled_date", { ascending: true })
      .order("start_time", { ascending: true, nullsFirst: false })
      .limit(500);

    return Response.json({
      plan: serializePlanRow(data as never),
      sessions: ((sessions ?? []) as Array<Record<string, unknown>>).map((row) =>
        serializeStudySessionRow(row)
      ),
    });
  } catch {
    console.error("[api/study-plans/:id] GET crashed");
    return jsonError(500, "server_error");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const input = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    // Whitelist mapping — id/user_id/timestamps are never client-writable.
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.startDate !== undefined) updates.start_date = input.startDate;
    if (input.endDate !== undefined) updates.end_date = input.endDate;
    if (input.dailyMinutes !== undefined) updates.daily_minutes = input.dailyMinutes;
    if (input.status !== undefined) updates.status = input.status;

    const { data, error } = await supabase
      .from("study_plans")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/study-plans/:id] PATCH found no owned row");
      return jsonError(404, "not_found");
    }
    return Response.json({ plan: serializePlanRow(data as never) });
  } catch {
    console.error("[api/study-plans/:id] PATCH crashed");
    return jsonError(500, "server_error");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();
    // Sessions cascade via the FK; completed history goes with the plan.
    const { data, error } = await supabase
      .from("study_plans")
      .delete()
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("[api/study-plans/:id] DELETE failed");
      return jsonError(500, "server_error");
    }
    if (!data || data.length === 0) return jsonError(404, "not_found");
    return Response.json({ deleted: data.length });
  } catch {
    console.error("[api/study-plans/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}
