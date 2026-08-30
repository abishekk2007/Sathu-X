import { z } from "zod";

import {
  examCreateSchema,
  serializeExamRow,
  toExamTimestamp,
  verifySubjectReference,
} from "@/lib/exam-helpers";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const listQuerySchema = z.object({
  status: z
    .enum(["upcoming", "in_progress", "completed", "cancelled"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Exam list + creation. Identity always comes from the Supabase session; the
 * insert relies on the column default auth.uid() so a spoofed user_id in the
 * payload is ignored.
 */
export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const parsedQuery = listQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsedQuery.success) return jsonError(400, "invalid_request");
  const { status, limit } = parsedQuery.data;

  try {
    const supabase = await getSupabaseServerClient();
    let query = supabase.from("exams").select("*").order("exam_date", {
      ascending: true,
    });
    if (status) query = query.eq("status", status);
    const { data, error } = await query.limit(limit ?? 100);

    if (error) {
      console.error("[api/exams] GET failed");
      return jsonError(500, "server_error");
    }
    return Response.json({
      exams: ((data ?? []) as Array<Record<string, unknown>>).map((row) =>
        serializeExamRow(row as never)
      ),
    });
  } catch {
    console.error("[api/exams] GET crashed");
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

  const parsed = examCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const input = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    if (!(await verifySubjectReference(supabase, input.subjectId))) {
      // Foreign or unknown subject — safe 404, no existence leak.
      return jsonError(404, "not_found");
    }

    const examDateIso = toExamTimestamp(input.examDate);

    // Duplicate guard for accidental double-submits (same title + instant).
    const { data: clash } = await supabase
      .from("exams")
      .select("id")
      .ilike("title", input.title)
      .eq("exam_date", examDateIso)
      .limit(1);
    if (clash && clash.length > 0) return jsonError(409, "duplicate_exam");

    const { data, error } = await supabase
      .from("exams")
      .insert({
        title: input.title,
        exam_date: examDateIso,
        subject_id: input.subjectId ?? null,
        exam_type: input.examType ?? "semester",
        description: input.description ?? null,
        target_score: input.targetScore ?? null,
        priority: input.priority ?? 3,
        status: "upcoming",
      })
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/exams] POST failed");
      return jsonError(500, "server_error");
    }
    return Response.json(
      { exam: serializeExamRow(data as Record<string, unknown> as never) },
      { status: 201 }
    );
  } catch {
    console.error("[api/exams] POST crashed");
    return jsonError(500, "server_error");
  }
}
