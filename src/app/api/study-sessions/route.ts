import { z } from "zod";

import {
  diffCalendarDays,
  serializeStudySessionRow,
} from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date");
const TIME_STRING = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "invalid_time");

const listQuerySchema = z.object({
  from: DATE_STRING.optional(),
  to: DATE_STRING.optional(),
  planId: z.string().uuid().optional(),
  status: z
    .enum(["planned", "in_progress", "completed", "skipped", "cancelled"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(400).optional(),
  today: DATE_STRING.optional(),
});

const createSchema = z.object({
  scheduledDate: DATE_STRING,
  startTime: TIME_STRING.nullable().optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  sessionType: z
    .enum(["study", "revision", "practice", "mock_test", "review"])
    .optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  studyPlanId: z.string().uuid().nullable().optional(),
  subjectId: z.string().uuid().nullable().optional(),
  topicId: z.string().uuid().nullable().optional(),
  examId: z.string().uuid().nullable().optional(),
});

const SESSION_SELECT =
  "*, subject:subjects(name), topic:subject_topics(name)";

/** Bounded session list for the daily/weekly views. */
export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const parsedQuery = listQuerySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    planId: url.searchParams.get("planId") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    today: url.searchParams.get("today") ?? undefined,
  });
  if (!parsedQuery.success) return jsonError(400, "invalid_request");
  const { from, to, planId, status, limit } = parsedQuery.data;

  // Default window: the client's local week ± context (bounded to 62 days).
  const todayIso =
    parsedQuery.data.today ??
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  const defaultFrom = addDays(todayIso, -7);
  const defaultTo = addDays(todayIso, 14);
  let rangeFrom = from ?? defaultFrom;
  let rangeTo = to ?? defaultTo;
  if (diffCalendarDays(rangeFrom, rangeTo) > 0)
    [rangeFrom, rangeTo] = [rangeTo, rangeFrom];
  if (diffCalendarDays(rangeFrom, rangeTo) > 61)
    rangeTo = addDays(rangeFrom, 61);

  try {
    const supabase = await getSupabaseServerClient();
    let query = supabase
      .from("study_sessions")
      .select(SESSION_SELECT)
      .gte("scheduled_date", rangeFrom)
      .lte("scheduled_date", rangeTo)
      .order("scheduled_date", { ascending: true })
      .order("start_time", { ascending: true, nullsFirst: false });

    if (planId) query = query.eq("study_plan_id", planId);
    if (status) query = query.eq("status", status);

    const { data, error } = await query.limit(limit ?? 200);
    if (error) {
      console.error("[api/study-sessions] GET failed");
      return jsonError(500, "server_error");
    }
    return Response.json({
      sessions: ((data ?? []) as Array<Record<string, unknown>>).map((row) =>
        serializeStudySessionRow(row)
      ),
    });
  } catch {
    console.error("[api/study-sessions] GET crashed");
    return jsonError(500, "server_error");
  }
}

/**
 * Manual single-session creation. Every optional reference is verified via an
 * RLS-scoped read first; foreign ids yield safe 404s.
 */
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
  const input = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    // Verify every supplied reference is owned (RLS filters foreign rows).
    const references = [
      { column: "study_plans", value: input.studyPlanId },
      { column: "subjects", value: input.subjectId },
      { column: "subject_topics", value: input.topicId },
      { column: "exams", value: input.examId },
    ] as const;
    for (const reference of references) {
      if (!reference.value) continue;
      if (!UUID_PATTERN.test(reference.value)) return jsonError(404, "not_found");
      const { data } = await supabase
        .from(reference.column)
        .select("id")
        .eq("id", reference.value)
        .limit(1);
      if (!data || data.length === 0) return jsonError(404, "not_found");
    }

    const { data, error } = await supabase
      .from("study_sessions")
      .insert({
        scheduled_date: input.scheduledDate,
        start_time: input.startTime ?? null,
        duration_minutes: input.durationMinutes ?? 30,
        session_type: input.sessionType ?? "study",
        notes: input.notes ?? null,
        study_plan_id: input.studyPlanId ?? null,
        subject_id: input.subjectId ?? null,
        topic_id: input.topicId ?? null,
        exam_id: input.examId ?? null,
        status: "planned",
      })
      .select(SESSION_SELECT)
      .single();

    if (error || !data) {
      console.error("[api/study-sessions] POST failed");
      return jsonError(500, "server_error");
    }
    return Response.json(
      { session: serializeStudySessionRow(data as Record<string, unknown>) },
      { status: 201 }
    );
  } catch {
    console.error("[api/study-sessions] POST crashed");
    return jsonError(500, "server_error");
  }
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
