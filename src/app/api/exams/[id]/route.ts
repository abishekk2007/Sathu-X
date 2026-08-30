import {
  examPatchSchema,
  serializeExamRow,
  toExamTimestamp,
  verifySubjectReference,
} from "@/lib/exam-helpers";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Single exam. RLS guarantees only the owner's row matches → safe 404s. */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("exams")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      console.error("[api/exams/:id] GET failed");
      return jsonError(500, "server_error");
    }
    if (!data) return jsonError(404, "not_found");
    return Response.json({ exam: serializeExamRow(data as never) });
  } catch {
    console.error("[api/exams/:id] GET crashed");
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

  const parsed = examPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const input = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    if (!(await verifySubjectReference(supabase, input.subjectId))) {
      return jsonError(404, "not_found");
    }

    // Whitelist mapping — id/user_id/created_at are never client-writable.
    const updates: Record<string, unknown> = {};
    if (input.title !== undefined) updates.title = input.title;
    if (input.examDate !== undefined)
      updates.exam_date = toExamTimestamp(input.examDate);
    if (input.subjectId !== undefined) updates.subject_id = input.subjectId;
    if (input.examType !== undefined) updates.exam_type = input.examType;
    if (input.description !== undefined) updates.description = input.description;
    if (input.targetScore !== undefined) updates.target_score = input.targetScore;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.status !== undefined) updates.status = input.status;

    const { data, error } = await supabase
      .from("exams")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/exams/:id] PATCH found no owned row");
      return jsonError(404, "not_found");
    }
    return Response.json({ exam: serializeExamRow(data as never) });
  } catch {
    console.error("[api/exams/:id] PATCH crashed");
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
      .from("exams")
      .delete()
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("[api/exams/:id] DELETE failed");
      return jsonError(500, "server_error");
    }
    if (!data || data.length === 0) return jsonError(404, "not_found");
    return Response.json({ deleted: data.length });
  } catch {
    console.error("[api/exams/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}
