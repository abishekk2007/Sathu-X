import { z } from "zod";

import {
  buildNextAction,
  buildNotifications,
  buildProductivityRecommendation,
  computeDayRecord,
  computeProductivityScore,
  computeStreak,
  mergeQualifyingStudyDates,
} from "@/lib/student-productivity";
import { addDaysIso, toDateOnly, weekStartIso } from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import type {
  ChatStudyActivity,
  ProductivityDashboardData,
  ProductivityDayRecord,
  RoutineRecord,
} from "@/types";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const querySchema = z.object({
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date")
    .optional(),
});

const SESSION_SELECT = "scheduled_date, duration_minutes, status, subject_id, topic_id";
const SESSION_FIELDS = "subject:subjects(name), topic:subject_topics(name)";

export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const parsedQuery = querySchema.safeParse({
    today: url.searchParams.get("today") ?? undefined,
  });
  if (!parsedQuery.success) return jsonError(400, "invalid_request");

  const todayIso = parsedQuery.data.today ?? toDateOnly(new Date());
  const weekStart = weekStartIso(todayIso);
  const weekEnd = addDaysIso(weekStart, 6);
  const historyStart = addDaysIso(todayIso, -29);
  const streakStart = addDaysIso(todayIso, -60);
  // Chat study timestamp range covers the same windows.
  const todayStartTs = `${todayIso}T00:00:00`;

  try {
    const supabase = await getSupabaseServerClient();

    const [
      profileResult,
      todaySessionsResult,
      weekSessionsResult,
      historyResult,
      streakResult,
      examsResult,
      goalsResult,
      topicsResult,
      knowledgeResult,
      chatTodayResult,
      chatHistoryResult,
      chatStreakResult,
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select(
          "preferred_session_minutes, preferred_break_minutes, " +
            "preferred_study_time, daily_study_target_minutes"
        )
        .maybeSingle(),
      supabase
        .from("study_sessions")
        .select(`${SESSION_SELECT}, ${SESSION_FIELDS}`)
        .eq("scheduled_date", todayIso)
        .in("status", ["planned", "in_progress", "completed"])
        .order("start_time", { ascending: true, nullsFirst: false })
        .limit(20),
      supabase
        .from("study_sessions")
        .select("scheduled_date, duration_minutes, status, subject_id")
        .gte("scheduled_date", weekStart)
        .lte("scheduled_date", weekEnd)
        .in("status", ["planned", "in_progress", "completed"])
        .limit(500),
      supabase
        .from("study_sessions")
        .select("scheduled_date, duration_minutes, status")
        .gte("scheduled_date", historyStart)
        .lte("scheduled_date", todayIso)
        .in("status", ["planned", "in_progress", "completed"])
        .limit(600),
      supabase
        .from("study_sessions")
        .select("scheduled_date")
        .eq("status", "completed")
        .gte("scheduled_date", streakStart)
        .lte("scheduled_date", todayIso)
        .limit(61),
      supabase
        .from("exams")
        .select("id, title, exam_date, subject:subjects(name)")
        .eq("status", "upcoming")
        .gte("exam_date", `${todayIso}T00:00:00`)
        .order("exam_date", { ascending: true })
        .limit(5),
      supabase
        .from("study_goals")
        .select("title, target_minutes, completed_minutes, status")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("subject_topics")
        .select("id, name, subject_id, mastery, status, subjects(name)")
        .neq("status", "not_started")
        .order("mastery", { ascending: true })
        .limit(50),
      supabase
        .from("student_knowledge")
        .select("topic_id, last_reviewed_at")
        .not("last_reviewed_at", "is", null)
        .order("last_reviewed_at", { ascending: false })
        .limit(100),
      // Chat study: today's completed sessions (for daily minutes)
      supabase
        .from("chat_study_sessions")
        .select("started_at, active_seconds, subject_id, topic_id, ended_at")
        .gte("started_at", todayStartTs)
        .order("started_at", { ascending: false })
        .limit(50),
      // Chat study: 30-day history (for history bars)
      supabase
        .from("chat_study_sessions")
        .select("started_at, active_seconds, ended_at")
        .gte("started_at", `${historyStart}T00:00:00`)
        .order("started_at", { ascending: false })
        .limit(200),
      // Chat study: 60-day streak data
      supabase
        .from("chat_study_sessions")
        .select("started_at, active_seconds")
        .gte("started_at", `${streakStart}T00:00:00`)
        .order("started_at", { ascending: false })
        .limit(300),
    ]);

    const firstError =
      profileResult.error ??
      todaySessionsResult.error ??
      weekSessionsResult.error ??
      historyResult.error ??
      streakResult.error ??
      examsResult.error ??
      goalsResult.error ??
      topicsResult.error ??
      knowledgeResult.error;
    if (firstError) {
      console.error("[api/student/productivity] Query failed");
      return jsonError(500, "server_error");
    }

    // ---- Profile / routine preferences ------------------------------------
    const profileRow = profileResult.data as Record<string, unknown> | null;
    const routine: RoutineRecord = {
      preferredSessionMinutes: (profileRow?.preferred_session_minutes as number | null) ?? null,
      preferredBreakMinutes: (profileRow?.preferred_break_minutes as number | null) ?? null,
      preferredStudyTime: (profileRow?.preferred_study_time as string | null) ?? null,
      dailyStudyTargetMinutes: (profileRow?.daily_study_target_minutes as number | null) ?? null,
    };

    // ---- Chat study: today's minutes by date ------------------------------
    const chatTodayRows = (chatTodayResult.data ?? []) as Array<{
      started_at: string;
      active_seconds: number;
      subject_id: string | null;
      topic_id: string | null;
      ended_at: string | null;
    }>;
    // Sum chat minutes for today (active sessions with >0 seconds).
    const todayChatSeconds = chatTodayRows
      .filter((r) => r.ended_at !== null)
      .reduce((sum, r) => sum + (r.active_seconds ?? 0), 0);
    const todayChatMinutes = Math.round(todayChatSeconds / 60);

    // Build per-subject/topic recent activity from today's chat sessions.
    const recentChatStudy: ChatStudyActivity[] = [];
    // Group by subject+topic for summary.
    const chatBySubjectTopic = new Map<
      string,
      { subjectId: string; topicId: string | null; seconds: number }
    >();
    for (const row of chatTodayRows) {
      if (!row.subject_id || row.active_seconds <= 0) continue;
      const key = `${row.subject_id}:${row.topic_id ?? "none"}`;
      const existing = chatBySubjectTopic.get(key);
      if (existing) {
        existing.seconds += row.active_seconds;
      } else {
        chatBySubjectTopic.set(key, {
          subjectId: row.subject_id,
          topicId: row.topic_id,
          seconds: row.active_seconds,
        });
      }
    }

    // Resolve names for recent chat study (fetch subjects+topics if needed).
    if (chatBySubjectTopic.size > 0) {
      const subjectIds = [
        ...new Set([...chatBySubjectTopic.values()].map((v) => v.subjectId)),
      ];
      const topicIds = [
        ...new Set(
          [...chatBySubjectTopic.values()]
            .map((v) => v.topicId)
            .filter((t): t is string => t !== null)
        ),
      ];

      const [subRes, topRes] = await Promise.all([
        subjectIds.length > 0
          ? supabase
              .from("subjects")
              .select("id, name")
              .in("id", subjectIds)
              .limit(subjectIds.length)
          : Promise.resolve({ data: [], error: null }),
        topicIds.length > 0
          ? supabase
              .from("subject_topics")
              .select("id, name")
              .in("id", topicIds)
              .limit(topicIds.length)
          : Promise.resolve({ data: [], error: null }),
      ]);

      const subjectNames = new Map<string, string>();
      for (const row of (subRes.data ?? []) as Array<{ id: string; name: string }>) {
        subjectNames.set(row.id, row.name);
      }
      const topicNames = new Map<string, string>();
      for (const row of (topRes.data ?? []) as Array<{ id: string; name: string }>) {
        topicNames.set(row.id, row.name);
      }

      for (const entry of chatBySubjectTopic.values()) {
        const activeMin = Math.round(entry.seconds / 60);
        if (activeMin <= 0) continue;
        recentChatStudy.push({
          subjectName: subjectNames.get(entry.subjectId) ?? "Unknown",
          topicName: entry.topicId ? (topicNames.get(entry.topicId) ?? null) : null,
          activeMinutes: activeMin,
          date: todayIso,
        });
      }
    }

    // ---- Today's planner sessions ----------------------------------------
    const todayRows = (todaySessionsResult.data ?? []) as Array<
      Record<string, unknown> & {
        subject: { name: string }[] | null;
        topic: { name: string }[] | null;
      }
    >;
    const todaySessions = todayRows.map((row) => ({
      id: String(row.id),
      scheduledDate: String(row.scheduled_date),
      durationMinutes: Number(row.duration_minutes ?? 0),
      status: String(row.status),
      subjectId: (row.subject_id as string | null) ?? null,
      topicId: (row.topic_id as string | null) ?? null,
      subjectName: row.subject?.[0]?.name ?? null,
      topicName: row.topic?.[0]?.name ?? null,
    }));

    const todayPlannerCompletedMinutes = todaySessions
      .filter((s) => s.status === "completed")
      .reduce((sum, s) => sum + s.durationMinutes, 0);
    // Total today's completed = planner + chat (additive, no double-count).
    const todayCompletedMinutes = todayPlannerCompletedMinutes + todayChatMinutes;
    const today = computeDayRecord(todayIso, todaySessions, todayChatMinutes);

    // ---- Week stats -------------------------------------------------------
    const weekRows = (weekSessionsResult.data ?? []) as Array<{
      scheduled_date: string;
      duration_minutes: number;
      status: string;
      subject_id: string | null;
    }>;
    let plannerCompletedMinutes = 0;
    let plannedMinutes = 0;
    let sessionsCompleted = 0;
    const subjectsStudiedSet = new Set<string>();
    for (const row of weekRows) {
      const minutes = Number(row.duration_minutes ?? 0);
      plannedMinutes += minutes;
      if (row.status === "completed") {
        plannerCompletedMinutes += minutes;
        sessionsCompleted += 1;
      }
      if (row.subject_id) subjectsStudiedSet.add(row.subject_id);
    }

    // ---- Chat study history rows (for 30-day bars + weekly) ---------------
    const chatHistoryRows = (chatHistoryResult.data ?? []) as Array<{
      started_at: string;
      active_seconds: number;
      ended_at: string | null;
    }>;

    // Chat study this week (already have today; fetch is scoped via 30-day).
    const weekChatRows = chatHistoryRows.filter(
      (r) => toDateOnly(new Date(r.started_at)) >= weekStart
    );
    const weekChatMinutes = Math.round(
      weekChatRows.reduce((sum, r) => sum + (r.active_seconds ?? 0), 0) / 60
    );
    const totalCompletedMinutes = plannerCompletedMinutes + weekChatMinutes;
    const completionPercent =
      plannedMinutes > 0
        ? Math.min(100, Math.round((totalCompletedMinutes / plannedMinutes) * 100))
        : 0;

    // ---- Topics practised this week (from knowledge table) -----------------
    const sevenDaysAgo = addDaysIso(todayIso, -6);
    const knowledgeRows = (knowledgeResult.data ?? []) as Array<{
      topic_id: string | null;
      last_reviewed_at: string | null;
    }>;
    const topicsPractisedSet = new Set<string>();
    for (const row of knowledgeRows) {
      if (!row.topic_id || !row.last_reviewed_at) continue;
      const reviewedDate = toDateOnly(new Date(row.last_reviewed_at));
      if (reviewedDate >= sevenDaysAgo) {
        topicsPractisedSet.add(row.topic_id);
      }
    }

    // ---- Streak: merge planner + chat study dates -------------------------
    const completedDates = (streakResult.data ?? []).map((row) =>
      String(row.scheduled_date)
    );
    const chatStreakRows = (chatStreakResult.data ?? []) as Array<{
      started_at: string;
      active_seconds: number;
    }>;
    const qualifyingDates = mergeQualifyingStudyDates(
      completedDates,
      chatStreakRows
    );
    const streak = computeStreak(qualifyingDates, todayIso);

    // ---- Goals ------------------------------------------------------------
    const goals = (goalsResult.data ?? []).map((row) => ({
      title: String(row.title),
      targetMinutes: (row.target_minutes as number | null) ?? null,
      completedMinutes: Number(row.completed_minutes ?? 0),
    }));

    // ---- Exams (for next-action + notifications) --------------------------
    interface ExamJoinRow {
      id: string;
      title: string;
      exam_date: string;
      subject: { name: string }[] | null;
    }
    const exams = ((examsResult.data ?? []) as unknown as ExamJoinRow[]).map(
      (row) => {
        const examDate = toDateOnly(new Date(row.exam_date));
        const daysLeft = Math.round(
          (new Date(`${examDate}T12:00:00`).getTime() -
            new Date(`${todayIso}T12:00:00`).getTime()) /
            86_400_000
        );
        return {
          title: row.title,
          subjectName: row.subject?.[0]?.name ?? null,
          subjectId: null as string | null,
          daysLeft,
        };
      }
    );

    // ---- Weak topics (sorted by mastery ascending) ------------------------
    interface TopicRow {
      id: string;
      name: string;
      subject_id: string;
      mastery: number;
      subjects: { name: string }[] | null;
    }
    const weakTopics = ((topicsResult.data ?? []) as unknown as TopicRow[])
      .filter((row) => row.mastery < 40)
      .slice(0, 10)
      .map((row) => ({
        id: row.id,
        name: row.name,
        subjectId: row.subject_id,
        subjectName: row.subjects?.[0]?.name ?? null,
        mastery: row.mastery,
      }));

    const totalTopics = (topicsResult.data ?? []).length;

    // ---- Score (uses total completed = planner + chat) --------------------
    const score = computeProductivityScore({
      completedMinutesLast7: totalCompletedMinutes,
      plannedMinutesLast7: plannedMinutes,
      currentStreak: streak.current,
      goals,
      topicsPractisedLast7: topicsPractisedSet.size,
      totalTopics,
    });

    // ---- Next action ------------------------------------------------------
    const nextAction = buildNextAction({
      todayIso,
      upcomingExams: exams,
      weakTopics,
      todaySessions: todaySessions.map((s) => ({
        id: s.id,
        subjectName: s.subjectName,
        topicName: s.topicName,
        subjectId: s.subjectId,
        topicId: s.topicId,
        durationMinutes: s.durationMinutes,
        status: s.status,
      })),
      activeGoals: goals,
      currentStreak: streak.current,
      dailyTargetMinutes: routine.dailyStudyTargetMinutes,
      todayCompletedMinutes,
    });

    // ---- Recommendation ---------------------------------------------------
    const weakestTopic = weakTopics[0] ?? null;
    const recommendation = buildProductivityRecommendation({
      todayIso,
      nextExam: exams[0] ?? null,
      weakestTopic,
      unfinishedToday: todaySessions.filter(
        (s) => s.status !== "completed"
      ).length,
      completedTodayMinutes: todayCompletedMinutes,
      currentStreak: streak.current,
      dailyTargetMinutes: routine.dailyStudyTargetMinutes,
      activeGoal: goals[0]
        ? {
            title: goals[0].title,
            progressMinutes: goals[0].completedMinutes,
            targetMinutes: goals[0].targetMinutes,
          }
        : null,
    });

    // ---- Notifications ----------------------------------------------------
    const notifications = buildNotifications({
      todayIso,
      upcomingExams: exams,
      weakTopics,
      currentStreak: streak.current,
      todayCompletedMinutes,
      dailyTargetMinutes: routine.dailyStudyTargetMinutes,
      activeGoals: goals,
    });

    // ---- History (last 30 days, merged planner + chat) --------------------
    const historyRows = (historyResult.data ?? []) as Array<{
      scheduled_date: string;
      duration_minutes: number;
      status: string;
    }>;
    // Build per-day chat minutes map from 30-day chat history.
    const chatMinutesByDate = new Map<string, number>();
    for (const row of chatHistoryRows) {
      if (row.ended_at === null) continue;
      const date = toDateOnly(new Date(row.started_at));
      const minutes = Math.round((row.active_seconds ?? 0) / 60);
      chatMinutesByDate.set(date, (chatMinutesByDate.get(date) ?? 0) + minutes);
    }
    const history = buildHistory(historyRows, todayIso, chatMinutesByDate);

    // ---- Weekly stats -----------------------------------------------------
    const weeklyStats = {
      totalMinutes: totalCompletedMinutes,
      plannedMinutes,
      completionPercent,
      sessionsCompleted,
      subjectsStudied: [...subjectsStudiedSet],
      topicsPracticed: [...topicsPractisedSet],
      chatMinutes: weekChatMinutes,
      plannerMinutes: plannerCompletedMinutes,
    };

    const payload: ProductivityDashboardData = {
      today,
      streak,
      score,
      nextAction,
      recommendation,
      weeklyStats,
      history,
      routine,
      notifications,
      recentChatStudy,
    };

    return Response.json(payload);
  } catch {
    console.error("[api/student/productivity] crashed");
    return jsonError(500, "server_error");
  }
}

/**
 * Builds the 30-day history array, merging planner sessions and chat study
 * minutes per day. Chat minutes are additive — they never replace planner
 * minutes; they extend the total study time for the day.
 */
function buildHistory(
  rows: Array<{ scheduled_date: string; duration_minutes: number; status: string }>,
  todayIso: string,
  chatMinutesByDate?: Map<string, number>
): ProductivityDayRecord[] {
  const byDate = new Map<string, Array<{ scheduledDate: string; durationMinutes: number; status: string }>>();
  for (const row of rows) {
    const date = String(row.scheduled_date);
    const list = byDate.get(date) ?? [];
    list.push({
      scheduledDate: date,
      durationMinutes: Number(row.duration_minutes ?? 0),
      status: String(row.status),
    });
    byDate.set(date, list);
  }

  const result: ProductivityDayRecord[] = [];
  for (let i = 0; i < 30; i += 1) {
    const date = addDaysIso(todayIso, -i);
    const sessions = byDate.get(date) ?? [];
    const chatMin = chatMinutesByDate?.get(date) ?? 0;
    result.push(computeDayRecord(date, sessions, chatMin));
  }
  return result;
}
