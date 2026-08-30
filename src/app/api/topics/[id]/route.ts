import { z } from "zod";

import { serializeTopicRow } from "@/lib/student-intelligence";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    unit: z.string().trim().max(40).nullable().optional(),
    status: z
      .enum(["not_started", "learning", "review", "mastered"])
      .optional(),
    mastery: z.coerce.number().int().min(0).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Per-topic operations. RLS (plus its parent-ownership subqueries) guarantees
 * only the owner's rows match; a foreign ID is indistinguishable from a
 * missing one — both yield 404.
 */
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

  try {
    const supabase = await getSupabaseServerClient();

    // Whitelist mapping — id/user_id/subject_id/created_at are never writable.
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      updates[key] = value;
    }

    const { data, error } = await supabase
      .from("subject_topics")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/topics/:id] PATCH found no owned row");
      return jsonError(404, "not_found");
    }
    return Response.json({
      topic: serializeTopicRow(data as Record<string, unknown>),
    });
  } catch {
    console.error("[api/topics/:id] PATCH crashed");
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
      .from("subject_topics")
      .delete()
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("[api/topics/:id] DELETE failed");
      return jsonError(500, "server_error");
    }
    // Zero rows deleted → never existed or belongs to someone else.
    if (!data || data.length === 0) return jsonError(404, "not_found");
    return Response.json({ deleted: data.length });
  } catch {
    console.error("[api/topics/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}
