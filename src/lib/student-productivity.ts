import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase 4D server-side student productivity engine.
 *
 * All functions are pure where possible — data fetching is separated from
 * business logic. No Gemini dependency for core functionality.
 *
 * Sources of truth:
 *   - study_sessions (completed = study day)
 *   - chat_study_sessions (active chat study, ≥5 min = study day)
 *   - subject_topics (mastery/weakness)
 *   - exams (upcoming urgency)
 *   - study_goals (targets)
 *   - student_knowledge (practice history)
 *   - profiles (routine preferences)
 *
 * Aggregation logic:
 *   Daily study time = completed planner sessions + active chat study minutes.
 *   Both sources are additive — no double-counting because they come from
 *   separate tables with distinct lifecycle management.
 *   Streak counts a day if EITHER ≥1 completed planner session OR ≥5 min
 *   active chat study occurred on that date.
 */

import type {
  NextAction,
  ProductivityDayRecord,
  ProductivityNotification,
  ProductivityScore,
  ProductivityStreak,
} from "@/types";

import {
  addDaysIso,
  diffCalendarDays,
  toDateOnly,
} from "@/lib/study-planner";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many days back to look for streak calculation. */
const STREAK_LOOKBACK = 60;
/** Budget cap for the chat productivity context block. */
const CHAT_CONTEXT_CHAR_BUDGET = 1800;
/** Minimum active chat seconds to qualify as a study day for streaks (5 min). */
const MIN_CHAT_STREAK_SECONDS = 300;

// ---------------------------------------------------------------------------
// Scoring weights (transparent, documented)
// ---------------------------------------------------------------------------

const WEIGHT_STUDY_COMPLETION = 0.40;
const WEIGHT_GOAL_PROGRESS = 0.20;
const WEIGHT_CONSISTENCY = 0.20;
const WEIGHT_PRACTICE = 0.20;

// ---------------------------------------------------------------------------
// Pure scoring helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Study completion score (0–100).
 * Compares completed minutes vs planned minutes across the last 7 days.
 * Missing data (no plan) defaults to 50 — neutral, not punitive.
 */
export function studyCompletionScore(
  completedMinutesLast7: number,
  plannedMinutesLast7: number
): number {
  if (plannedMinutesLast7 <= 0) {
    // No plan — score based purely on activity.
    return clamp((completedMinutesLast7 / 120) * 80, 0, 80);
  }
  const ratio = completedMinutesLast7 / plannedMinutesLast7;
  return clamp(ratio * 100, 0, 100);
}

/**
 * Goal progress score (0–100).
 * Weighted by how many active goals are on track.
 */
export function goalProgressScore(
  goals: Array<{ targetMinutes: number | null; completedMinutes: number }>
): number {
  if (goals.length === 0) return 50; // neutral when no goals
  let total = 0;
  for (const goal of goals) {
    if (goal.targetMinutes === null || goal.targetMinutes <= 0) {
      total += goal.completedMinutes > 0 ? 80 : 30;
    } else {
      const ratio = goal.completedMinutes / goal.targetMinutes;
      total += clamp(ratio * 100, 0, 100);
    }
  }
  return clamp(total / goals.length, 0, 100);
}

/**
 * Consistency / streak score (0–100).
 * Current streak maps linearly: 0 days → 0, 14+ days → 100.
 */
export function consistencyScore(currentStreak: number): number {
  return clamp((currentStreak / 14) * 100, 0, 100);
}

/**
 * Practice activity score (0–100).
 * Measures how many topics were practised in the last 7 days.
 */
export function practiceActivityScore(
  topicsPractisedLast7: number,
  totalTopics: number
): number {
  if (totalTopics === 0) return 30; // no topics = neutral
  const ratio = topicsPractisedLast7 / Math.min(totalTopics, 20);
  return clamp(ratio * 100, 0, 100);
}

/**
 * Composite productivity score (0–100).
 */
export function computeProductivityScore(inputs: {
  completedMinutesLast7: number;
  plannedMinutesLast7: number;
  currentStreak: number;
  goals: Array<{ targetMinutes: number | null; completedMinutes: number }>;
  topicsPractisedLast7: number;
  totalTopics: number;
}): ProductivityScore {
  const study = studyCompletionScore(
    inputs.completedMinutesLast7,
    inputs.plannedMinutesLast7
  );
  const goals = goalProgressScore(inputs.goals);
  const consistency = consistencyScore(inputs.currentStreak);
  const practice = practiceActivityScore(
    inputs.topicsPractisedLast7,
    inputs.totalTopics
  );

  const value = clamp(
    study * WEIGHT_STUDY_COMPLETION +
      goals * WEIGHT_GOAL_PROGRESS +
      consistency * WEIGHT_CONSISTENCY +
      practice * WEIGHT_PRACTICE,
    0,
    100
  );

  let label: string;
  let explanation: string;

  if (value >= 80) {
    label = "Excellent";
    explanation = "Outstanding week — you are consistently hitting your study targets.";
  } else if (value >= 60) {
    label = "Good";
    explanation = "Strong progress this week — keep the momentum going.";
  } else if (value >= 40) {
    label = "Fair";
    explanation = "You are making some progress. A bit more consistency will help.";
  } else if (value >= 20) {
    label = "Needs attention";
    explanation = "Study activity is low. A short session today can restart your streak.";
  } else {
    label = "Quiet week";
    explanation = "No study activity detected yet. Start with a short session to build momentum.";
  }

  return { value, label, explanation };
}

// ---------------------------------------------------------------------------
// Streak calculation
// ---------------------------------------------------------------------------

/**
 * Merges qualifying study dates from planner sessions AND chat study sessions.
 * A date qualifies if:
 *   - ≥1 completed planner session, OR
 *   - ≥MIN_CHAT_STREAK_SECONDS of active chat study.
 * This prevents double-counting a single day across sources.
 */
export function mergeQualifyingStudyDates(
  completedPlannerDates: string[],
  chatStudyRows: Array<{ started_at: string; active_seconds: number }>
): string[] {
  const dates = new Set(completedPlannerDates);
  for (const row of chatStudyRows) {
    if (row.active_seconds >= MIN_CHAT_STREAK_SECONDS) {
      dates.add(toDateOnly(new Date(row.started_at)));
    }
  }
  return [...dates];
}

export function computeStreak(
  completedDates: string[],
  todayIso: string
): ProductivityStreak {
  const unique = new Set(completedDates);

  // Current streak: consecutive completed days ending at today or yesterday.
  let anchor = unique.has(todayIso)
    ? todayIso
    : unique.has(addDaysIso(todayIso, -1))
      ? addDaysIso(todayIso, -1)
      : null;
  let current = 0;
  while (anchor && unique.has(anchor)) {
    current += 1;
    anchor = addDaysIso(anchor, -1);
  }

  // Longest streak within the lookback window.
  let longest = 0;
  let run = 0;
  let cursor = todayIso;
  for (let i = 0; i < STREAK_LOOKBACK; i += 1) {
    if (unique.has(cursor)) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
    cursor = addDaysIso(cursor, -1);
  }
  if (longest < current) longest = current;

  // Days in last 7 and 30.
  const weekAgo = addDaysIso(todayIso, -6);
  let daysLast7 = 0;
  let daysLast30 = 0;
  let dayCursor = todayIso;
  for (let i = 0; i < 30; i += 1) {
    if (unique.has(dayCursor)) {
      daysLast30 += 1;
      if (diffCalendarDays(dayCursor, weekAgo) >= 0) daysLast7 += 1;
    }
    dayCursor = addDaysIso(dayCursor, -1);
  }

  return { current, longest, daysLast7, daysLast30 };
}

// ---------------------------------------------------------------------------
// Daily productivity record
// ---------------------------------------------------------------------------

export function computeDayRecord(
  date: string,
  sessions: Array<{ scheduledDate: string; durationMinutes: number; status: string }>,
  chatMinutes?: number
): ProductivityDayRecord {
  const daySessions = sessions.filter((s) => s.scheduledDate === date);
  const plannerCompleted = daySessions
    .filter((s) => s.status === "completed")
    .reduce((sum, s) => sum + s.durationMinutes, 0);
  const plannerPlanned = daySessions.reduce(
    (sum, s) => sum + s.durationMinutes,
    0
  );
  const chat = chatMinutes ?? 0;

  // Completed minutes = planner completed + chat active minutes.
  // Both sources are additive — they come from separate tables with
  // distinct lifecycle management, so no double-counting occurs.
  const completedMinutes = plannerCompleted + chat;
  const plannedMinutes = plannerPlanned;
  const sessionsCompleted = daySessions.filter(
    (s) => s.status === "completed"
  ).length;
  const completionPercent =
    plannedMinutes > 0
      ? clamp((completedMinutes / plannedMinutes) * 100, 0, 100)
      : completedMinutes > 0
        ? 100
        : 0;

  // Simplified day score (no goals/practice per-day — those are weekly).
  const score = clamp(
    (completionPercent * 0.6 + (sessionsCompleted > 0 || chat > 0 ? 40 : 0)),
    0,
    100
  );

  return {
    date,
    plannedMinutes,
    completedMinutes,
    completionPercent,
    sessionsCompleted,
    score,
    plannerMinutes: plannerCompleted,
    chatMinutes: chat,
  };
}

// ---------------------------------------------------------------------------
// Next action recommendation
// ---------------------------------------------------------------------------

export interface NextActionInput {
  todayIso: string;
  upcomingExams: Array<{
    title: string;
    subjectName: string | null;
    daysLeft: number;
    subjectId: string | null;
  }>;
  weakTopics: Array<{
    id: string;
    name: string;
    subjectId: string;
    subjectName: string | null;
    mastery: number;
  }>;
  todaySessions: Array<{
    id: string;
    subjectName: string | null;
    topicName: string | null;
    subjectId: string | null;
    topicId: string | null;
    durationMinutes: number;
    status: string;
  }>;
  activeGoals: Array<{
    title: string;
    targetMinutes: number | null;
    completedMinutes: number;
  }>;
  currentStreak: number;
  dailyTargetMinutes: number | null;
  todayCompletedMinutes: number;
}

/**
 * Deterministic next-action recommendation.
 * Priority order:
 *   1. Exam within 3 days + weak topic → exam prep (HIGH)
 *   2. Incomplete today sessions → complete session (HIGH)
 *   3. Exam within 7 days → exam prep (MEDIUM)
 *   4. Weak topic + no exam pressure → review weak (MEDIUM)
 *   5. Goal behind schedule → goal push (MEDIUM)
 *   6. Streak at risk (0–1 today) → re-entry (LOW)
 *   7. General practice → practice (LOW)
 */
export function buildNextAction(input: NextActionInput): NextAction | null {
  const {
    upcomingExams,
    weakTopics,
    todaySessions,
    activeGoals,
    currentStreak,
    todayCompletedMinutes,
    dailyTargetMinutes,
  } = input;

  // 1. Exam within 3 days + weak topic
  const urgentExam = upcomingExams.find((e) => e.daysLeft >= 0 && e.daysLeft <= 3);
  if (urgentExam && weakTopics.length > 0) {
    // Pick the weakest topic that belongs to the exam's subject, or just the weakest overall.
    const subjectWeak = weakTopics.find(
      (t) => t.subjectId && upcomingExams.some((e) => e.subjectId === t.subjectId)
    );
    const topic = subjectWeak ?? weakTopics[0];
    return {
      title: `Review ${topic.name}`,
      reason: `Your ${urgentExam.title} exam is in ${urgentExam.daysLeft === 0 ? "today" : urgentExam.daysLeft === 1 ? "tomorrow" : `${urgentExam.daysLeft} days`} and this topic is currently weak (${topic.mastery}% mastery).`,
      subject: topic.subjectName,
      topic: topic.name,
      estimatedMinutes: 45,
      actionType: "exam_prep",
    };
  }

  // 2. Incomplete today session
  const pendingSession = todaySessions.find((s) => s.status === "planned" || s.status === "in_progress");
  if (pendingSession) {
    return {
      title: `Complete ${pendingSession.topicName ?? pendingSession.subjectName ?? "study session"}`,
      reason: `You have a ${pendingSession.durationMinutes}-minute session planned that hasn't been completed yet.`,
      subject: pendingSession.subjectName,
      topic: pendingSession.topicName,
      estimatedMinutes: pendingSession.durationMinutes,
      actionType: "complete_session",
    };
  }

  // 3. Exam within 7 days
  const nearExam = upcomingExams.find((e) => e.daysLeft >= 0 && e.daysLeft <= 7);
  if (nearExam) {
    const topic = weakTopics[0];
    return {
      title: `Prepare for ${nearExam.title}`,
      reason: `Your ${nearExam.title} exam is ${nearExam.daysLeft === 0 ? "today" : nearExam.daysLeft === 1 ? "tomorrow" : `${nearExam.daysLeft} days away`}. Focus on the topics that need the most work.`,
      subject: nearExam.subjectName,
      topic: topic?.name ?? null,
      estimatedMinutes: 45,
      actionType: "exam_prep",
    };
  }

  // 4. Weak topic
  if (weakTopics.length > 0) {
    const topic = weakTopics[0];
    return {
      title: `Review ${topic.name}`,
      reason: `This topic is at ${topic.mastery}% mastery — your lowest. A short review session will help.`,
      subject: topic.subjectName,
      topic: topic.name,
      estimatedMinutes: 30,
      actionType: "review_weak",
    };
  }

  // 5. Goal behind schedule
  for (const goal of activeGoals) {
    if (goal.targetMinutes !== null && goal.completedMinutes < goal.targetMinutes * 0.5) {
      const remaining = goal.targetMinutes - goal.completedMinutes;
      return {
        title: `Continue "${goal.title}"`,
        reason: `You have ${Math.round(remaining)} minutes left on this goal. Keep it on track.`,
        subject: null,
        topic: null,
        estimatedMinutes: Math.min(remaining, 45),
        actionType: "goal_push",
      };
    }
  }

  // 6. Streak at risk
  if (currentStreak === 0 && todayCompletedMinutes === 0) {
    return {
      title: "Start a short study session",
      reason: "You haven't studied today. Even 15 minutes will start (or protect) your streak.",
      subject: null,
      topic: null,
      estimatedMinutes: 15,
      actionType: "re_entry",
    };
  }

  // 7. General practice
  return {
    title: "Practice a topic",
    reason: "No urgent tasks today. Use this time to review or practice any subject.",
    subject: null,
    topic: null,
    estimatedMinutes: dailyTargetMinutes ? Math.min(dailyTargetMinutes, 30) : 30,
    actionType: "practice",
  };
}

// ---------------------------------------------------------------------------
// Deterministic study recommendation (enhanced version of Phase 4C)
// ---------------------------------------------------------------------------

export interface RecommendationInput {
  todayIso: string;
  nextExam: { title: string; daysLeft: number } | null;
  weakestTopic: { name: string; mastery: number; subjectName: string | null } | null;
  unfinishedToday: number;
  completedTodayMinutes: number;
  currentStreak: number;
  dailyTargetMinutes: number | null;
  activeGoal:
    | { title: string; progressMinutes: number; targetMinutes: number | null }
    | null;
}

export function buildProductivityRecommendation(input: RecommendationInput): string | null {
  const { nextExam, weakestTopic, currentStreak, dailyTargetMinutes, completedTodayMinutes } = input;

  // Exam passed
  if (nextExam && nextExam.daysLeft < 0) {
    return `"${nextExam.title}" has passed — mark it completed so your planner stays accurate.`;
  }

  // Exam crunch + weak topic
  if (nextExam && nextExam.daysLeft <= 3 && weakestTopic) {
    return `Exam crunch: prioritize "${weakestTopic.name}" today — it is your weakest topic (${weakestTopic.mastery}%) and "${nextExam.title}" is ${nextExam.daysLeft === 0 ? "today" : nextExam.daysLeft === 1 ? "tomorrow" : `${nextExam.daysLeft} days away`}.`;
  }

  // Exam crunch without weak topic
  if (nextExam && nextExam.daysLeft <= 3) {
    return `"${nextExam.title}" is ${nextExam.daysLeft === 0 ? "today" : nextExam.daysLeft === 1 ? "tomorrow" : `${nextExam.daysLeft} days away`} — do a focused review or mock test rather than new material.`;
  }

  // Weak topic
  if (weakestTopic && weakestTopic.mastery < 40) {
    return `Start with "${weakestTopic.name}" (${weakestTopic.mastery}% mastery${weakestTopic.subjectName ? `, ${weakestTopic.subjectName}` : ""}) — it is currently your weakest topic.`;
  }

  // Incomplete sessions
  if (input.unfinishedToday > 0) {
    return `You have ${input.unfinishedToday} session${input.unfinishedToday === 1 ? "" : "s"} left today — clear them before adding anything new.`;
  }

  // Daily target progress
  if (dailyTargetMinutes && dailyTargetMinutes > 0 && completedTodayMinutes < dailyTargetMinutes) {
    const remaining = dailyTargetMinutes - completedTodayMinutes;
    return `You've studied ${completedTodayMinutes} of your ${dailyTargetMinutes}-minute daily target. ${remaining} minutes to go.`;
  }

  // Goal behind schedule
  if (input.activeGoal && input.activeGoal.targetMinutes !== null && input.activeGoal.progressMinutes < input.activeGoal.targetMinutes) {
    const remaining = input.activeGoal.targetMinutes - input.activeGoal.progressMinutes;
    return `${Math.max(0, Math.round(remaining / 60))}h ${remaining % 60}m left on "${input.activeGoal.title}" — one more session keeps it on track.`;
  }

  // Streak encouragement
  if (currentStreak >= 7) {
    return `Great streak — ${currentStreak} days in a row! Keep it going with a focused session.`;
  }
  if (currentStreak >= 3) {
    return `You're on a ${currentStreak}-day streak. A session today keeps the momentum going.`;
  }

  // Steady prep
  if (nextExam) {
    return `Steady prep for "${nextExam.title}" (${nextExam.daysLeft} days out) — keep revising your medium topics.`;
  }

  // No exams, no weak topics
  if (weakestTopic) {
    return `No exams scheduled — a short practice on "${weakestTopic.name}" would still lift your weakest area.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Productivity notifications (non-intrusive in-app indicators)
// ---------------------------------------------------------------------------

export interface NotificationInput {
  todayIso: string;
  upcomingExams: Array<{ title: string; daysLeft: number }>;
  weakTopics: Array<{ name: string; mastery: number; subjectName: string | null }>;
  currentStreak: number;
  todayCompletedMinutes: number;
  dailyTargetMinutes: number | null;
  activeGoals: Array<{
    title: string;
    targetMinutes: number | null;
    completedMinutes: number;
  }>;
}

export function buildNotifications(input: NotificationInput): ProductivityNotification[] {
  const notifications: ProductivityNotification[] = [];

  // Exam approaching
  for (const exam of input.upcomingExams) {
    if (exam.daysLeft >= 0 && exam.daysLeft <= 3) {
      notifications.push({
        id: `exam-${exam.title}`,
        kind: "exam_approaching",
        title: `${exam.title} — ${exam.daysLeft === 0 ? "today" : exam.daysLeft === 1 ? "tomorrow" : `${exam.daysLeft} days`}`,
        body: exam.daysLeft <= 1 ? "Final review recommended" : "Review weak topics for this exam",
        severity: exam.daysLeft <= 1 ? "urgent" : "warning",
      });
    }
  }

  // Goal behind schedule
  for (const goal of input.activeGoals) {
    if (goal.targetMinutes !== null && goal.targetMinutes > 0) {
      const progress = goal.completedMinutes / goal.targetMinutes;
      if (progress < 0.3) {
        notifications.push({
          id: `goal-${goal.title}`,
          kind: "goal_behind",
          title: `Goal behind: ${goal.title}`,
          body: `${goal.completedMinutes}/${goal.targetMinutes} min completed`,
          severity: "warning",
        });
      }
    }
  }

  // Streak at risk
  if (input.currentStreak >= 3 && input.todayCompletedMinutes === 0) {
    notifications.push({
      id: "streak-risk",
      kind: "streak_at_risk",
      title: `${input.currentStreak}-day streak at risk`,
      body: "Complete a study session today to keep your streak alive.",
      severity: "warning",
    });
  }

  // Weak topic needing review
  const criticalWeak = input.weakTopics.filter((t) => t.mastery < 30);
  for (const topic of criticalWeak.slice(0, 2)) {
    notifications.push({
      id: `weak-${topic.name}`,
      kind: "weak_topic",
      title: `${topic.name} needs attention`,
      body: `Currently at ${topic.mastery}% mastery${topic.subjectName ? ` (${topic.subjectName})` : ""}`,
      severity: "info",
    });
  }

  return notifications;
}

// ---------------------------------------------------------------------------
// Chat productivity context block (bounded)
// ---------------------------------------------------------------------------

export interface ChatProductivityContext {
  currentStreak: number;
  todayPlannedMinutes: number;
  todayCompletedMinutes: number;
  weakestTopic: { name: string; mastery: number } | null;
  nextExam: { title: string; daysLeft: number } | null;
  recommendation: string | null;
  scoreValue: number;
}

/**
 * Builds a bounded PRODUCTIVITY CONTEXT block for the chat system prompt.
 * ~1500 chars max — no database internals, no IDs, no secrets.
 */
export function buildProductivityChatBlock(
  context: ChatProductivityContext
): string | null {
  const lines: string[] = [];

  lines.push(`Productivity score: ${context.scoreValue}/100`);

  if (context.currentStreak > 0) {
    lines.push(`Current study streak: ${context.currentStreak} day${context.currentStreak === 1 ? "" : "s"}`);
  }

  if (context.todayPlannedMinutes > 0 || context.todayCompletedMinutes > 0) {
    lines.push(
      `Today's study: ${context.todayCompletedMinutes}/${context.todayPlannedMinutes} minutes completed`
    );
  }

  if (context.weakestTopic) {
    lines.push(`Weakest topic: ${context.weakestTopic.name} (${context.weakestTopic.mastery}% mastery)`);
  }

  if (context.nextExam) {
    const when =
      context.nextExam.daysLeft === 0
        ? "today"
        : context.nextExam.daysLeft === 1
          ? "tomorrow"
          : `in ${context.nextExam.daysLeft} days`;
    lines.push(`Upcoming exam: ${context.nextExam.title} (${when})`);
  }

  if (context.recommendation) {
    lines.push(`Recommendation: ${context.recommendation}`);
  }

  if (lines.length === 0) return null;

  const block = "STUDENT PRODUCTIVITY CONTEXT:\n" + lines.map((line) => `- ${line}`).join("\n");
  return block.length > CHAT_CONTEXT_CHAR_BUDGET
    ? block.slice(0, CHAT_CONTEXT_CHAR_BUDGET)
    : block;
}

// ---------------------------------------------------------------------------
// Chat context fetcher (bounded reads for the chat route)
// ---------------------------------------------------------------------------

/**
 * Fetches the minimal data needed for the productivity chat context block.
 * Four bounded parallel reads — total latency ≈ one Supabase round-trip.
 */
export async function fetchProductivityChatContext(
  supabase: SupabaseClient,
  todayIso: string
): Promise<ChatProductivityContext | null> {
  const streakStart = addDaysIso(todayIso, -60);

  const [todaySessionsResult, streakResult, goalsResult, examsResult, topicsResult] =
    await Promise.all([
      supabase
        .from("study_sessions")
        .select("duration_minutes, status")
        .eq("scheduled_date", todayIso)
        .in("status", ["planned", "in_progress", "completed"])
        .limit(20),
      supabase
        .from("study_sessions")
        .select("scheduled_date")
        .eq("status", "completed")
        .gte("scheduled_date", streakStart)
        .lte("scheduled_date", todayIso)
        .limit(61),
      supabase
        .from("study_goals")
        .select("title, target_minutes, completed_minutes, status")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("exams")
        .select("title, exam_date")
        .eq("status", "upcoming")
        .gte("exam_date", `${todayIso}T00:00:00`)
        .order("exam_date", { ascending: true })
        .limit(1),
      supabase
        .from("subject_topics")
        .select("name, mastery")
        .neq("status", "not_started")
        .order("mastery", { ascending: true })
        .limit(5),
    ]);

  if (
    todaySessionsResult.error ||
    streakResult.error ||
    goalsResult.error ||
    examsResult.error ||
    topicsResult.error
  ) {
    return null;
  }

  // Today's minutes
  const todaySessions = (todaySessionsResult.data ?? []) as Array<{
    duration_minutes: number;
    status: string;
  }>;
  const todayCompletedMinutes = todaySessions
    .filter((s) => s.status === "completed")
    .reduce((sum, s) => sum + Number(s.duration_minutes ?? 0), 0);
  const todayPlannedMinutes = todaySessions.reduce(
    (sum, s) => sum + Number(s.duration_minutes ?? 0),
    0
  );

  // Streak
  const completedDates = new Set(
    (streakResult.data ?? []).map((row) => String(row.scheduled_date))
  );
  const streak = computeStreak([...completedDates], todayIso);

  // Goals
  const goals = (goalsResult.data ?? []).map((row) => ({
    title: String(row.title),
    targetMinutes: (row.target_minutes as number | null) ?? null,
    completedMinutes: Number(row.completed_minutes ?? 0),
  }));

  // Next exam
  const examRow = (examsResult.data ?? [])[0] as
    | { title: string; exam_date: string }
    | undefined;
  const nextExam = examRow
    ? {
        title: examRow.title,
        daysLeft: diffCalendarDays(
          toDateOnly(new Date(examRow.exam_date)),
          todayIso
        ),
      }
    : null;

  // Weakest topic
  const topics = (topicsResult.data ?? []) as Array<{
    name: string;
    mastery: number;
  }>;
  const weakestTopic = topics[0] ? { ...topics[0], subjectName: null as string | null } : null;

  // Score
  const score = computeProductivityScore({
    completedMinutesLast7: todayCompletedMinutes,
    plannedMinutesLast7: todayPlannedMinutes,
    currentStreak: streak.current,
    goals,
    topicsPractisedLast7: 0,
    totalTopics: topics.length,
  });

  // Recommendation
  const recommendation = buildProductivityRecommendation({
    todayIso,
    nextExam,
    weakestTopic,
    unfinishedToday: todaySessions.filter((s) => s.status !== "completed").length,
    completedTodayMinutes: todayCompletedMinutes,
    currentStreak: streak.current,
    dailyTargetMinutes: null,
    activeGoal: goals[0]
      ? {
          title: goals[0].title,
          progressMinutes: goals[0].completedMinutes,
          targetMinutes: goals[0].targetMinutes,
        }
      : null,
  });

  return {
    currentStreak: streak.current,
    todayPlannedMinutes,
    todayCompletedMinutes,
    weakestTopic,
    nextExam,
    recommendation,
    scoreValue: score.value,
  };
}

// ---------------------------------------------------------------------------
// Personalized greeting helper
// ---------------------------------------------------------------------------

export interface GreetingInput {
  firstName: string | null;
  todayCompletedMinutes: number;
  todayPlannedMinutes: number;
  nextExam: { title: string; daysLeft: number; subjectName: string | null } | null;
  weakestTopic: { name: string; subjectName: string | null } | null;
}

export function buildPersonalizedGreeting(input: GreetingInput): {
  greeting: string;
  subtitle: string | null;
} {
  const hour = new Date().getHours();
  const timeGreeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const greeting = input.firstName
    ? `${timeGreeting}, ${input.firstName}`
    : timeGreeting;

  // Build a contextual subtitle
  const parts: string[] = [];

  if (input.todayCompletedMinutes > 0 && input.todayPlannedMinutes > 0) {
    parts.push(
      `You've completed ${input.todayCompletedMinutes} of ${input.todayPlannedMinutes} planned minutes today.`
    );
  } else if (input.nextExam && input.nextExam.daysLeft >= 0 && input.nextExam.daysLeft <= 4) {
    parts.push(
      `Your ${input.nextExam.title} exam is in ${input.nextExam.daysLeft === 0 ? "today" : input.nextExam.daysLeft === 1 ? "tomorrow" : `${input.nextExam.daysLeft} days`}.`
    );
  }

  if (parts.length === 0) return { greeting, subtitle: null };
  return { greeting, subtitle: parts.join(" ") };
}
