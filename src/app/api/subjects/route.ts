import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(40).optional(),
  description: z.string().trim().max(1000).optional(),
  semester: z.string().trim().max(40).optional(),
  credits: z.coerce.number().int().min(0).max(20).optional(),
  color: z.string().trim().max(20).optional(),
});

interface SubjectRow {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  semester: string | null;
  credits: number | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

function serializeSubject(row: SubjectRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    semester: row.semester,
    credits: row.credits,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 200
      ? limitRaw
      : 100;

  try {
    const supabase = await getSupabaseServerClient();
    let query = supabase
      .from("subjects")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (search) query = query.ilike("name", `%${search}%`);

    const { data, error } = await query;
    if (error) {
      console.error("[api/subjects] GET failed");
      return jsonError(500, "server_error");
    }
    return Response.json({
      subjects: ((data ?? []) as SubjectRow[]).map(serializeSubject),
    });
  } catch {
    console.error("[api/subjects] GET crashed");
    return jsonError(500, "server_error");
  }
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

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const { name, code, description, semester, credits, color } = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    // Reject exact-duplicate names for the same user (case-insensitive).
    const { data: existing } = await supabase
      .from("subjects")
      .select("id, name")
      .ilike("name", name)
      .limit(1);
    if (existing && existing.length > 0) {
      return jsonError(409, "duplicate_subject");
    }

    // user_id is never accepted from the client — the database default
    // (auth.uid()) plus RLS ownership checks keep rows scoped to the caller.
    const { data, error } = await supabase
      .from("subjects")
      .insert({
        name,
        ...(code !== undefined ? { code } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(semester !== undefined ? { semester } : {}),
        ...(credits !== undefined ? { credits } : {}),
        ...(color !== undefined ? { color } : {}),
      })
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/subjects] Insert rejected");
      return jsonError(500, "server_error");
    }
    return Response.json(
      { subject: serializeSubject(data as SubjectRow) },
      { status: 201 }
    );
  } catch {
    console.error("[api/subjects] POST crashed");
    return jsonError(500, "server_error");
  }
}
