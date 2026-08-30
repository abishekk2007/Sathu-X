import { z } from "zod";

import {
  serializeTopicRow,
} from "@/lib/student-intelligence";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    code: z.string().trim().max(40).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    semester: z.string().trim().max(40).nullable().optional(),
    credits: z.coerce.number().int().min(0).max(20).nullable().optional(),
    color: z.string().trim().max(20).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

interface RouteContext {
  params: Promise<{ id: string }>;
}

function serializeSubject(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    name: row.name as string,
    code: (row.code as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    semester: (row.semester as string | null) ?? null,
    credits: (row.credits as number | null) ?? null,
    color: (row.color as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Single subject + its topics. RLS guarantees only the owner's row matches;
 * a foreign ID is indistinguishable from a missing one — both yield 404.
 */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();
    const { data: subject, error } = await supabase
      .from("subjects")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      console.error("[api/subjects/:id] GET failed");
      return jsonError(500, "server_error");
    }
    if (!subject) return jsonError(404, "not_found");

    const { data: topics } = await supabase
      .from("subject_topics")
      .select("*")
      .eq("subject_id", id)
      .order("unit", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true })
      .limit(500);

    return Response.json({
      subject: serializeSubject(subject),
      topics: ((topics ?? []) as Array<Record<string, unknown>>).map(
        serializeTopicRow
      ),
    });
  } catch {
    console.error("[api/subjects/:id] GET crashed");
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

  try {
    const supabase = await getSupabaseServerClient();

    if (parsed.data.name !== undefined) {
      const { data: clash } = await supabase
        .from("subjects")
        .select("id")
        .ilike("name", parsed.data.name)
        .neq("id", id)
        .limit(1);
      if (clash && clash.length > 0) {
        return jsonError(409, "duplicate_subject");
      }
    }

    // Whitelist mapping — id/user_id/timestamps are never client-writable.
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      updates[key] = value;
    }

    const { data, error } = await supabase
      .from("subjects")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/subjects/:id] PATCH found no owned row");
      return jsonError(404, "not_found");
    }
    return Response.json({ subject: serializeSubject(data) });
  } catch {
    console.error("[api/subjects/:id] PATCH crashed");
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
      .from("subjects")
      .delete()
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("[api/subjects/:id] DELETE failed");
      return jsonError(500, "server_error");
    }
    // Zero rows deleted → never existed or belongs to someone else.
    if (!data || data.length === 0) return jsonError(404, "not_found");
    return Response.json({ deleted: data.length });
  } catch {
    console.error("[api/subjects/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}
