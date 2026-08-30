import { z } from "zod";

import { serializeTopicRow } from "@/lib/student-intelligence";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional(),
  unit: z.string().trim().max(40).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Lists the topics of the caller's own subject. Foreign id → 404. */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();

    const { data: subject } = await supabase
      .from("subjects")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (!subject) return jsonError(404, "not_found");

    const { data, error } = await supabase
      .from("subject_topics")
      .select("*")
      .eq("subject_id", id)
      .order("unit", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true })
      .limit(500);

    if (error) {
      console.error("[api/subjects/:id/topics] GET failed");
      return jsonError(500, "server_error");
    }

    // Merge each topic's last practice time from the knowledge table so the
    // UI can show "last reviewed" without another round trip.
    const { data: knowledge } = await supabase
      .from("student_knowledge")
      .select("topic_id, last_reviewed_at")
      .eq("subject_id", id)
      .not("last_reviewed_at", "is", null)
      .limit(1000);

    const reviewedByTopic = new Map<string, string>();
    for (const row of knowledge ?? []) {
      if (row.topic_id && row.last_reviewed_at) {
        reviewedByTopic.set(row.topic_id, row.last_reviewed_at);
      }
    }

    return Response.json({
      topics: ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        ...serializeTopicRow(row),
        lastReviewedAt: reviewedByTopic.get(String(row.id)) ?? null,
      })),
    });
  } catch {
    console.error("[api/subjects/:id/topics] GET crashed");
    return jsonError(500, "server_error");
  }
}

export async function POST(request: Request, context: RouteContext) {
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

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const { name, description, unit } = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    // Ownership check happens here AND in RLS — defense in depth.
    const { data: subject } = await supabase
      .from("subjects")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (!subject) return jsonError(404, "not_found");

    const { data: duplicate } = await supabase
      .from("subject_topics")
      .select("id")
      .eq("subject_id", id)
      .ilike("name", name)
      .limit(1);
    if (duplicate && duplicate.length > 0) {
      return jsonError(409, "duplicate_topic");
    }

    const { data, error } = await supabase
      .from("subject_topics")
      .insert({
        subject_id: id,
        name,
        ...(description !== undefined ? { description } : {}),
        ...(unit !== undefined ? { unit } : {}),
      })
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/subjects/:id/topics] Insert rejected");
      return jsonError(500, "server_error");
    }
    return Response.json(
      { topic: serializeTopicRow(data as Record<string, unknown>) },
      { status: 201 }
    );
  } catch {
    console.error("[api/subjects/:id/topics] POST crashed");
    return jsonError(500, "server_error");
  }
}
