import { z } from "zod";

import {
  buildStudyRecommendation,
  examDaysLeft,
  serializeStudySessionRow,
  toDateOnly,
  weekStartIso,
} from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import type { NextExamSummary, StudyDashboardData, StudySessionRecord } from "@/types";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const querySchema = z.object({
  /** Client's local date so "today"/"this week" match the user's calendar. */
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date")
    .optional(),
});

const EXAM_SELECT =
  "id, title, exam_date, exam_type, target_score, priority, status, subject:subjects(name)";
const SESSION_SELECT = "*, subject:subjects(name), topic:subject_topics(name)";

interface ExamJoinRow {
  id: string;
  title: string;
  exam_date: string;
  exam_type: string;
  target_score: number | null;
  priority: number;
  status: string;
  subject: { name: string }[] | null;
}

function toExamSummary(row: ExamJoinRow, todayIso: string): NextExamSummary {
  return {
    id: row.id,
    title: row.title,
    subjectName: row.subject?.[0]?.name ?? null,
    examDate: row.exam_date,
    examType: row.exam_type as NextExamSummary["examType"],
    targetScore: row.target_score,
    priority: row.priority,
    daysLeft: examDaysLeft(row.exam_date, todayIso),
  };
}

/**
 * Aggregated study dashboard. Seven bounded reads, every number derived from
 * real RLS-scoped rows; the client's local `today` anchors all grouping.
 */
export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const parsedQuery = querySchema.safeParse({
    today: url.searchParams.get("today") ?? undefined,
  });
  if (!parsedQuery.success) return jsonError(400, "invalid_request");

  const todayIso =
    parsedQuery.data.today ?? toDateOnly(new Date());
  const weekStart = weekStartIso(todayIso);
  const weekEnd = addDaysLocal(weekStart, 6);
  const streakFloor = addDaysLocal(todayIso, -60);

  try {
    const supabase = await getSupabaseServerClient();

    const [
      examsResult,
      todaySessionsResult,
      weekSessionsResult,
      streakResult,
      goalsResult,
      plansResult,
      topicsResult,
    ] = await Promise.all([
      supabase
        .from("exams")
        .select(EXAM_SELECT)
        .eq("status", "upcoming")
        .gte("exam_date", `${todayIso}T00:00:00`)
        .order("exam_date", { ascending: true })
        .limit(5),
      supabase
        .from("study_sessions")
        .select(SESSION_SELECT)
        .eq("scheduled_date", todayIso)
        .in("status", ["planned", "in_progress", "completed"])
        .order("start_time", { ascending: true, nullsFirst: false })
        .limit(10),
      supabase
        .from("study_sessions")
        .select("scheduled_date, duration_minutes, status")
        .gte("scheduled_date", weekStart)
        .lte("scheduled_date", weekEnd)
        .in("status", ["planned", "in_progress", "completed"])
        .limit(500),
      supabase
        .from("study_sessions")
        .select("scheduled_date")
        .eq("status", "completed")
        .gte("scheduled_date", streakFloor)
        .lte("scheduled_date", todayIso)
        .limit(61),
      supabase
        .from("study_goals")
        .select("*")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("study_plans")
        .select("*")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("subject_topics")
        .select("id, name, mastery, status, subject_id, subjects(name)")
        .neq("status", "not_started")
        .order("mastery", { ascending: true })
        .limit(100),
    ]);

    const firstError =
      examsResult.error ??
      todaySessionsResult.error ??
      weekSessionsResult.error ??
      streakResult.error ??
      goalsResult.error ??
      plansResult.error ??
      topicsResult.error;
    if (firstError) {
      console.error("[api/student/study-dashboard] Query failed");
      return jsonError(500, "server_error");
    }

    // ---- Exams --------------------------------------------------------------
    const upcomingExams = ((examsResult.data ?? []) as unknown as ExamJoinRow[])
      .map((row) => toExamSummary(row, todayIso))
      .sort((a, b) => a.daysLeft - b.daysLeft);
    const nextExam = upcomingExams[0] ?? null;

    // ---- Today's sessions ---------------------------------------------------
    const todaySessions = ((todaySessionsResult.data ?? []) as Array<
      Record<string, unknown>
    >).map((row) =>
      serializeStudySessionRow(row) as StudySessionRecord & {
        subjectName: string | null;
        topicName: string | null;
      }
    );
    const unfinishedToday = todaySessions.filter(
      (session) => session.status !== "completed"
    ).length;

    // ---- Week totals (real minutes only; skipped/cancelled excluded) --------
    const weekRows = (weekSessionsResult.data ?? []) as Array<{
      scheduled_date: string;
      duration_minutes: number;
      status: string;
    }>;
    let completedMinutes = 0;
    let plannedMinutes = 0;
    for (const session of weekRows) {
      const minutes = Number(session.duration_minutes ?? 0);
      plannedMinutes += minutes;
      if (session.status === "completed") completedMinutes += minutes;
    }
    const completionPercent =
      plannedMinutes > 0
        ? Math.min(100, Math.round((completedMinutes / plannedMinutes) * 100))
        : 0;

    // ---- Streak: consecutive completed days ending today/yesterday ----------
    const completedDates = new Set(
      ((streakResult.data ?? []) as Array<{ scheduled_date: string }>).map(
        (row) => row.scheduled_date
      )
    );
    let streakAnchor = completedDates.has(todayIso)
      ? todayIso
      : completedDates.has(addDaysLocal(todayIso, -1))
        ? addDaysLocal(todayIso, -1)
        : null;
    let streakDays = 0;
    while (streakAnchor && completedDates.has(streakAnchor)) {
      streakDays += 1;
      streakAnchor = addDaysLocal(streakAnchor, -1);
    }

    // ---- Goals + active plan -------------------------------------------------
    const activeGoals = goalsResult.data ?? [];
    const activePlanRow = (plansResult.data ?? [])[0] ?? null;

    // ---- Deterministic recommendation ---------------------------------------
    const weakestTopicRow = (
      (topicsResult.data ?? []) as Array<{
        id: string;
        name: string;
        mastery: number;
        status: string;
        subject_id: string;
        subjects: { name: string }[] | null;
      }>
    )[0];
    const recommendation = buildStudyRecommendation({
      todayIso,
      nextExam: nextExam ? { title: nextExam.title, daysLeft: nextExam.daysLeft } : null,
      weakestTopic: weakestTopicRow
        ? {
            name: weakestTopicRow.name,
            mastery: Number(weakestTopicRow.mastery ?? 0),
            subjectName: weakestTopicRow.subjects?.[0]?.name ?? null,
          }
        : null,
      unfinishedToday,
      completedTodayMinutes: todaySessions
        .filter((session) => session.status === "completed")
        .reduce((sum, session) => sum + session.durationMinutes, 0),
      activeGoal:
        (activeGoals[0] as
          | { title: string; target_minutes: number | null }
          | undefined) != null
          ? {
              title: String(activeGoals[0].title),
              progressMinutes: Number(activeGoals[0].completed_minutes ?? 0),
              targetMinutes: (activeGoals[0].target_minutes as number | null) ?? null,
            }
          : null,
    });

    const payload: StudyDashboardData = {
      today: todayIso,
      nextExam,
      upcomingExams,
      todaySessions,
      week: {
        start: weekStart,
        end: weekEnd,
        completedMinutes,
        plannedMinutes,
        completionPercent,
      },
      streakDays,
      activeGoals: (activeGoals as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        title: String(row.title),
        description: (row.description as string | null) ?? null,
        targetDate: (row.target_date as string | null) ?? null,
        targetMinutes: (row.target_minutes as number | null) ?? null,
        completedMinutes: Number(row.completed_minutes ?? 0),
        status: "active",
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
      activePlan: activePlanRow
        ? {
            id: String(activePlanRow.id),
            name: String(activePlanRow.name),
            description: (activePlanRow.description as string | null) ?? null,
            startDate: String(activePlanRow.start_date),
            endDate: String(activePlanRow.end_date),
            dailyMinutes: Number(activePlanRow.daily_minutes ?? 60),
            status: String(activePlanRow.status) as "active",
            createdAt: String(activePlanRow.created_at),
            updatedAt: String(activePlanRow.updated_at),
          }
        : null,
      recommendation: recommendation
        ? `${recommendation}`.replace(/^"|"$/g, "")
        : null,
    };

    return Response.json(payload);
  } catch {
    console.error("[api/student/study-dashboard] crashed");
    return jsonError(500, "server_error");
  }
}

function addDaysLocal(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toDateOnly(date);
}
