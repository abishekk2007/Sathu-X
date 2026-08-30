import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

/**
 * Lists the caller's knowledge-state rows (bounded). Writes happen only
 * through /api/student/practice so scoring stays deterministic.
 */
export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 500
      ? limitRaw
      : 200;

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("student_knowledge")
      .select(
        "id, topic_id, subject_id, strength_score, confidence_score, " +
          "attempt_count, correct_count, last_reviewed_at, updated_at"
      )
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[api/student/knowledge] GET failed");
      return jsonError(500, "server_error");
    }

    return Response.json({
      knowledge: ((data ?? []) as unknown as Array<Record<string, unknown>>).map(
        (row) => ({
          id: row.id as string,
          topicId: (row.topic_id as string | null) ?? null,
          subjectId: (row.subject_id as string | null) ?? null,
          strengthScore: Number(row.strength_score ?? 50),
          confidenceScore: Number(row.confidence_score ?? 50),
          attemptCount: Number(row.attempt_count ?? 0),
          correctCount: Number(row.correct_count ?? 0),
          lastReviewedAt: (row.last_reviewed_at as string | null) ?? null,
          updatedAt: row.updated_at as string,
        })
      ),
    });
  } catch {
    console.error("[api/student/knowledge] crashed");
    return jsonError(500, "server_error");
  }
}
