import { z } from "zod";

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
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    targetDate: DATE_STRING.nullable().optional(),
    targetMinutes: z.number().int().min(1).max(100000).nullable().optional(),
    status: z.enum(["active", "completed", "paused", "cancelled"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

interface RouteContext {
  params: Promise<{ id: string }>;
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

    // Whitelist mapping — completed_minutes is derived, never client-set.
    const updates: Record<string, unknown> = {};
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.targetDate !== undefined) updates.target_date = input.targetDate;
    if (input.targetMinutes !== undefined) updates.target_minutes = input.targetMinutes;
    if (input.status !== undefined) updates.status = input.status;

    const { data, error } = await supabase
      .from("study_goals")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/study-goals/:id] PATCH found no owned row");
      return jsonError(404, "not_found");
    }
    return Response.json({ goal: data });
  } catch {
    console.error("[api/study-goals/:id] PATCH crashed");
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
    const { data, error } = await supabase
      .from("study_goals")
      .delete()
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("[api/study-goals/:id] DELETE failed");
      return jsonError(500, "server_error");
    }
    if (!data || data.length === 0) return jsonError(404, "not_found");
    return Response.json({ deleted: data.length });
  } catch {
    console.error("[api/study-goals/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}
