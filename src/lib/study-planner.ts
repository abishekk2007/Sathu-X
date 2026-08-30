import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Phase 4C server-side study planner engine.
 *
 * Responsibilities:
 *  1. Date-only helpers that never shift a day across timezones (all
 *     scheduling works on local "YYYY-MM-DD" strings; the client sends its
 *     `today` so server grouping matches the user's calendar).
 *  2. Deterministic exam countdown + urgency scoring (no ML — transparent).
 *  3. The deterministic fallback planner: weak topics first, spaced passes,
 *     buffer before the exam, strong topics only for light revision.
 *  4. Gemini structured plan generation with strict Zod validation and a
 *     name→id mapping that silently drops anything unknown.
 *  5. Bounded planner context for chat + a deterministic recommendation.
 */

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/** Sessions are chunked so no single block exceeds this many minutes. */
export const MAX_SESSION_BLOCK_MINUTES = 45;
/** Smallest useful session; smaller remainders roll to the next topic. */
export const MIN_SESSION_BLOCK_MINUTES = 15;
/** Never schedule new content on the exam day itself (buffer). */
export const EXAM_BUFFER_DAYS = 1;
/** Hard caps so prompts and payloads stay bounded. */
export const PLANNER_TOPIC_CAP = 400;
export const AI_PROMPT_TOPIC_CAP = 60;
export const AI_PLAN_MAX_DAYS = 120;
export const AI_PLAN_MAX_SESSIONS_PER_DAY = 8;

const CHAT_EXAM_CAP = 5;
const CHAT_PLAN_CAP = 2;
const CHAT_SESSION_CAP = 10;
const CHAT_GOAL_CAP = 5;
const CHAT_BLOCK_CHAR_BUDGET = 1400;

// ---------------------------------------------------------------------------
// Date-only helpers (local calendar, timezone-safe)
// ---------------------------------------------------------------------------

/** Formats a Date as its LOCAL calendar date "YYYY-MM-DD". */
export function toDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parses "YYYY-MM-DD" into a LOCAL-midnight Date. Using the T00:00:00 suffix
 * avoids the UTC-interpretation pitfall of `new Date("2026-01-05")`.
 */
export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

/** Calendar-day difference a−b, immune to DST shifts (both at UTC noon). */
export function diffCalendarDays(a: string | Date, b: string | Date): number {
  const toNoonUtc = (value: string | Date) => {
    const date =
      typeof value === "string" ? parseDateOnly(value) : value;
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  };
  return Math.round((toNoonUtc(a) - toNoonUtc(b)) / 86_400_000);
}

export function addDaysIso(isoDate: string, days: number): string {
  const date = parseDateOnly(isoDate);
  date.setDate(date.getDate() + days);
  return toDateOnly(date);
}

/** Monday-based week start for a date-only string. */
export function weekStartIso(isoDate: string): string {
  const date = parseDateOnly(isoDate);
  const offset = (date.getDay() + 6) % 7;
  return addDaysIso(isoDate, -offset);
}

// ---------------------------------------------------------------------------
// Exam countdown (display strings)
// ---------------------------------------------------------------------------

/**
 * Human countdown from a whole number of calendar days. Negative values mean
 * the exam instant has already passed its calendar date.
 */
export function formatCountdownLabel(daysLeft: number): string {
  if (daysLeft === 0) return "Exam today";
  if (daysLeft === 1) return "Tomorrow";
  if (daysLeft > 1) return `${daysLeft} days left`;
  if (daysLeft === -1) return "Yesterday";
  return `${Math.abs(daysLeft)} days ago`;
}

/** Calendar days between the exam's local date and `todayIso`. */
export function examDaysLeft(examDateIso: string, todayIso: string): number {
  return diffCalendarDays(parseDateOnly(examDateIso.slice(0, 10)), todayIso);
}

// ---------------------------------------------------------------------------
// Deterministic exam urgency (transparent scoring, no ML)
// ---------------------------------------------------------------------------

export interface ExamUrgencyInput {
  /** Calendar days until the exam (may be ≤ 0 for past exams). */
  daysLeft: number;
  /** Weak topics (<40 mastery) attached to the exam's subject, capped at 5. */
  weakTopicCount: number;
  /** Average mastery of the subject's topics (null when no topics yet). */
  avgMastery: number | null;
  /** Manual priority 1–5 set by the user. */
  manualPriority: number;
  /** Target score 0–100 or null. */
  targetScore: number | null;
}

export type UrgencyBand = "critical" | "high" | "medium" | "low";

/**
 * Urgency score 0–100:
 *   up to 40 pts — time pressure (linear over a 30-day horizon)
 *   up to 25 pts — unpreparedness (inverse of average mastery; neutral when unknown)
 *   up to 15 pts — weak topics (3 pts each, capped at 5)
 *   up to 10 pts — manual priority (2 pts per level)
 *   up to 10 pts — ambition (target score share)
 */
export function computeExamUrgency(input: ExamUrgencyInput): {
  score: number;
  band: UrgencyBand;
} {
  const clampedDays = Math.max(0, Math.min(30, input.daysLeft));
  const timePressure =
    ((30 - clampedDays) / 30) * 40 * (input.daysLeft <= 0 ? 1 : 1);
  const masteryGap =
    input.avgMastery === null ? 20 : ((100 - input.avgMastery) / 100) * 25;
  const weakBonus = Math.min(5, Math.max(0, input.weakTopicCount)) * 3;
  const manual = Math.min(5, Math.max(1, input.manualPriority)) * 2;
  const ambition =
    input.targetScore === null ? 5 : (input.targetScore / 100) * 10;

  const score = Math.max(
    0,
    Math.min(100, Math.round(timePressure + masteryGap + weakBonus + manual + ambition))
  );
  const band: UrgencyBand =
    score >= 75 ? "critical" : score >= 55 ? "high" : score >= 35 ? "medium" : "low";
  return { score, band };
}

export function urgencyBandLabel(band: UrgencyBand): string {
  switch (band) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    default:
      return "Low";
  }
}

// ---------------------------------------------------------------------------
// Topic prioritisation + deterministic fallback planner
// ---------------------------------------------------------------------------

export interface PlannerTopicInput {
  id: string;
  subjectId: string;
  name: string;
  mastery: number;
  status: string;
}

interface QueuedTopic extends PlannerTopicInput {
  rank: number;
  remainingPasses: number;
  passIndex: number;
}

/**
 * Transparent priority order (spec):
 *   0 weak (<40) → 1 not started → 2 review band (40–59) →
 *   3 learning (60–79) → 4 strong (≥80, revision only).
 * Within a band, lower mastery first.
 */
function topicRank(topic: PlannerTopicInput): number {
  if (topic.status === "not_started") return 1;
  if (topic.mastery < 40) return 0;
  if (topic.mastery < 60) return 2;
  if (topic.mastery < 80) return 3;
  return 4;
}

function passesForRank(rank: number): number {
  // Weak/unstarted topics get several spaced passes, strong ones one revision.
  return [3, 3, 2, 2, 1][rank];
}

function sessionTypeForPass(
  rank: number,
  passIndex: number,
  totalPasses: number
): PlannedSessionDraft["sessionType"] {
  if (rank === 4) return "revision";
  if (passIndex === 0) return "study";
  if (passIndex === totalPasses - 1) return "review";
  return rank <= 1 ? "practice" : "revision";
}

export interface PlannedSessionDraft {
  scheduledDate: string;
  startTime: string | null;
  durationMinutes: number;
  sessionType: "study" | "revision" | "practice" | "mock_test" | "review";
  subjectId: string | null;
  topicId: string | null;
}

export interface DeterministicPlanInput {
  startDate: string;
  endDate: string;
  dailyMinutes: number;
  /** JS getDay() numbers (0=Sunday … 6=Saturday). Empty array = every day. */
  preferredDays: number[];
  preferredTime?: string | null;
  topics: PlannerTopicInput[];
  /** Exam date-only; nothing is scheduled on/after it minus buffer. */
  hardEndDate?: string | null;
}

/**
 * Fallback planner: walks the date window day by day, fills each preferred
 * day with blocks taken round-robin from the prioritised queue (never the
 * same topic twice in one day), and stops before the exam buffer. Strong
 * topics only receive their single late revision pass once everything else
 * is exhausted — weak topics are always drained first.
 */
export function buildDeterministicPlan(
  input: DeterministicPlanInput
): PlannedSessionDraft[] {
  const queue: QueuedTopic[] = [...input.topics]
    .sort((a, b) => {
      const rankDiff = topicRank(a) - topicRank(b);
      return rankDiff !== 0 ? rankDiff : a.mastery - b.mastery;
    })
    .map((topic) => {
      const rank = topicRank(topic);
      return { ...topic, rank, remainingPasses: passesForRank(rank), passIndex: 0 };
    });

  if (queue.length === 0) return [];

  const drafts: PlannedSessionDraft[] = [];
  const preferred = new Set(input.preferredDays);
  const lastScheduledFor = new Map<string, string>();

  let cursor = input.startDate;
  const finalDay =
    input.hardEndDate && diffCalendarDays(input.hardEndDate, input.endDate) < 0
      ? addDaysIso(input.hardEndDate, -EXAM_BUFFER_DAYS)
      : input.endDate;

  let guard = 0;
  while (
    queue.length > 0 &&
    guard < AI_PLAN_MAX_DAYS &&
    diffCalendarDays(cursor, finalDay) <= 0
  ) {
    guard += 1;
    const weekday = parseDateOnly(cursor).getDay();
    const dayAllowed = preferred.size === 0 || preferred.has(weekday);

    if (dayAllowed) {
      let capacity = Math.min(
        input.dailyMinutes,
        MAX_SESSION_BLOCK_MINUTES * AI_PLAN_MAX_SESSIONS_PER_DAY
      );

      while (capacity >= MIN_SESSION_BLOCK_MINUTES) {
        const index = queue.findIndex((item) => {
          const last = lastScheduledFor.get(item.id);
          return !last || last !== cursor;
        });
        if (index === -1) break;

        const item = queue[index];
        const block = Math.min(capacity, MAX_SESSION_BLOCK_MINUTES);
        drafts.push({
          scheduledDate: cursor,
          startTime: input.preferredTime ?? null,
          durationMinutes: block,
          sessionType: sessionTypeForPass(item.rank, item.passIndex, item.remainingPasses),
          subjectId: item.subjectId,
          topicId: item.id,
        });
        capacity -= block;
        lastScheduledFor.set(item.id, cursor);
        item.passIndex += 1;
        item.remainingPasses -= 1;
        if (item.remainingPasses <= 0) {
          queue.splice(index, 1);
        } else {
          // Rotate the item to the back so the next block goes elsewhere.
          queue.push(queue.splice(index, 1)[0]);
        }
      }
    }
    cursor = addDaysIso(cursor, 1);
  }

  return drafts;
}

// ---------------------------------------------------------------------------
// Gemini structured plan generation (validated; never trusted raw)
// ---------------------------------------------------------------------------

const DATE_STRING = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const aiPlanSchema = z.object({
  plan: z
    .array(
      z.object({
        date: DATE_STRING,
        sessions: z
          .array(
            z.object({
              subject: z.string().trim().min(1).max(160).optional(),
              topic: z.string().trim().min(1).max(200).optional(),
              type: z
                .enum(["study", "revision", "practice", "mock_test", "review"])
                .default("study"),
              minutes: z.number().int().min(5).max(240),
            })
          )
          .max(AI_PLAN_MAX_SESSIONS_PER_DAY),
      })
    )
    .max(AI_PLAN_MAX_DAYS),
});

export type AiPlanPayload = z.infer<typeof aiPlanSchema>;

/** Parses model output JSON; returns null for any malformed response. */
export function parseAiPlan(rawText: string): AiPlanPayload | null {
  try {
    const parsed: unknown = JSON.parse(rawText);
    const result = aiPlanSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export interface AiMappingContext {
  allowedDates: Set<string>;
  preferredDays: Set<number>;
  subjectsByName: Map<string, { id: string }>;
  /** Keys: `${subjectNameLower}::${topicNameLower}` and bare topic names. */
  topicsByKey: Map<string, { id: string; subjectId: string }>;
  fallbackSubjectId: string | null;
  fallbackStartTime: string | null;
  maxDailyMinutes: number;
  maxSessions: number;
}

/**
 * Converts validated AI output into persistable drafts. Anything referencing
 * an unknown subject/topic, a disallowed date, or duplicating an existing
 * (date+topic+type) triple is dropped; durations are clamped to the daily
 * budget. Returns [] when nothing usable survives.
 */
export function mapAiPlanToDrafts(
  payload: AiPlanPayload,
  ctx: AiMappingContext
): PlannedSessionDraft[] {
  const drafts: PlannedSessionDraft[] = [];
  const seen = new Set<string>();
  let totalSessions = 0;

  const canonical = (value: string) =>
    value.trim().toLowerCase().replace(/\s+/g, " ");

  for (const day of payload.plan) {
    if (!ctx.allowedDates.has(day.date)) continue;
    if (ctx.preferredDays.size > 0 && !ctx.preferredDays.has(parseDateOnly(day.date).getDay()))
      continue;

    let dayMinutes = 0;
    for (const session of day.sessions) {
      if (totalSessions >= ctx.maxSessions) break;
      if (dayMinutes + session.minutes > ctx.maxDailyMinutes) continue;

      const topicKey = session.topic ? canonical(session.topic) : null;
      let resolved: { id: string; subjectId: string } | null = null;

      if (topicKey) {
        const subjectKey = session.subject ? canonical(session.subject) : null;
        resolved =
          (subjectKey != null && subjectKey !== "" ? ctx.topicsByKey.get(`${subjectKey}::${topicKey}`) : null) ??
          ctx.topicsByKey.get(`::${topicKey}`) ??
          null;
      }

      const dedupeKey = `${day.date}::${resolved?.id ?? session.topic ?? ""}::${session.type}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      drafts.push({
        scheduledDate: day.date,
        startTime: ctx.fallbackStartTime,
        durationMinutes: Math.max(MIN_SESSION_BLOCK_MINUTES, session.minutes),
        sessionType: session.type,
        subjectId: resolved?.subjectId ?? ctx.fallbackSubjectId,
        topicId: resolved?.id ?? null,
      });
      dayMinutes += session.minutes;
      totalSessions += 1;
    }
  }

  return drafts;
}

// ---------------------------------------------------------------------------
// Goal progress helpers
// ---------------------------------------------------------------------------

export interface GoalWindowLike {
  createdAt: string;
  targetDate: string | null;
}

/** Progress window for a goal: from creation day to target date (+7d grace). */
export function goalWindow(goal: GoalWindowLike): { start: string; end: string } {
  const start = toDateOnly(new Date(goal.createdAt));
  const end = goal.targetDate ?? addDaysIso(start, 6);
  return { start, end };
}

export function goalCoversDate(goal: GoalWindowLike, isoDate: string): boolean {
  const { start, end } = goalWindow(goal);
  return diffCalendarDays(isoDate, start) >= 0 && diffCalendarDays(end, isoDate) >= 0;
}

// ---------------------------------------------------------------------------
// Deterministic study recommendation
// ---------------------------------------------------------------------------

export interface RecommendationInput {
  todayIso: string;
  nextExam: { title: string; daysLeft: number } | null;
  weakestTopic: { name: string; mastery: number; subjectName: string | null } | null;
  unfinishedToday: number;
  completedTodayMinutes: number;
  activeGoal:
    | { title: string; progressMinutes: number; targetMinutes: number | null }
    | null;
}

/**
 * Rule-based recommendation, highest applicable rule wins. Deterministic —
 * identical data always yields the same sentence.
 */
export function buildStudyRecommendation(input: RecommendationInput): string | null {
  const { nextExam, weakestTopic } = input;

  if (nextExam && nextExam.daysLeft < 0) {
    return `"${nextExam.title}" has passed — mark it completed so your planner stays accurate.`;
  }
  if (nextExam && nextExam.daysLeft <= 3 && weakestTopic) {
    return `Exam crunch: prioritize "${weakestTopic.name}" today — it is your weakest ${weakestTopic.subjectName ? `${weakestTopic.subjectName} ` : ""}topic (${weakestTopic.mastery}%) and "${nextExam.title}" is ${nextExam.daysLeft === 0 ? "today" : nextExam.daysLeft === 1 ? "tomorrow" : `${nextExam.daysLeft} days away`}.`;
  }
  if (nextExam && nextExam.daysLeft <= 3) {
    return `"${nextExam.title}" is ${nextExam.daysLeft === 0 ? "today" : nextExam.daysLeft === 1 ? "tomorrow" : `${nextExam.daysLeft} days away`} — do a focused review or mock test rather than new material.`;
  }
  if (weakestTopic && weakestTopic.mastery < 40) {
    return `Start with "${weakestTopic.name}" (${weakestTopic.mastery}% mastery${weakestTopic.subjectName ? `, ${weakestTopic.subjectName}` : ""}) — it is currently your weakest topic.`;
  }
  if (input.unfinishedToday > 0) {
    return `You have ${input.unfinishedToday} session${input.unfinishedToday === 1 ? "" : "s"} left today — clear them before adding anything new.`;
  }
  if (
    input.activeGoal &&
    input.activeGoal.targetMinutes !== null &&
    input.activeGoal.progressMinutes < input.activeGoal.targetMinutes
  ) {
    const remaining = input.activeGoal.targetMinutes - input.activeGoal.progressMinutes;
    return `${Math.max(0, Math.round(remaining / 60))}h ${remaining % 60}m left on "${input.activeGoal.title}" — one more session keeps it on track.`;
  }
  if (nextExam) {
    return `Steady prep for "${nextExam.title}" (${nextExam.daysLeft} days out) — keep revising your medium topics.`;
  }
  if (weakestTopic) {
    return `No exams scheduled — a short practice on "${weakestTopic.name}" would still lift your weakest area.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bounded planner context (chat + dashboards)
// ---------------------------------------------------------------------------

function normalizeRow(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

interface PlanDbRow {
  id: string;
  name: string;
  description: string | null;
  start_date: string;
  end_date: string;
  daily_minutes: number;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Serializes a raw study_plans row for API responses. */
export function serializePlanRow(row: PlanDbRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    dailyMinutes: Number(row.daily_minutes ?? 60),
    status: String(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Serializes a raw study_sessions row (with optional joined names) for APIs. */
export function serializeStudySessionRow(
  row: Record<string, unknown>
): StudySessionLike & { subjectName: string | null; topicName: string | null } {
  return {
    id: String(row.id),
    studyPlanId: (row.study_plan_id as string | null) ?? null,
    subjectId: (row.subject_id as string | null) ?? null,
    topicId: (row.topic_id as string | null) ?? null,
    examId: (row.exam_id as string | null) ?? null,
    scheduledDate: String(row.scheduled_date),
    startTime: row.start_time === null ? null : String(row.start_time).slice(0, 5),
    durationMinutes: Number(row.duration_minutes ?? 30),
    sessionType: String(row.session_type) as PlannedSessionDraft["sessionType"],
    status: String(row.status),
    notes: (row.notes as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    subjectName:
      typeof row.subject === "object" && row.subject !== null
        ? joinName(row.subject as { name: string } | { name: string }[])
        : ((row.subject_name as string | null) ?? null),
    topicName:
      typeof row.topic === "object" && row.topic !== null
        ? joinName(row.topic as { name: string } | { name: string }[])
        : ((row.topic_name as string | null) ?? null),
  };
}

interface StudySessionLike {
  id: string;
  studyPlanId: string | null;
  subjectId: string | null;
  topicId: string | null;
  examId: string | null;
  scheduledDate: string;
  startTime: string | null;
  durationMinutes: number;
  sessionType: string;
  status: string;
  notes: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlannerChatContext {
  todayIso: string;
  exams: Array<{
    title: string;
    subjectName: string | null;
    examDate: string;
    daysLeft: number;
    targetScore: number | null;
  }>;
  plans: Array<{ name: string; startDate: string; endDate: string; dailyMinutes: number }>;
  sessions: Array<{
    label: string;
    startTime: string | null;
    durationMinutes: number;
    sessionType: string;
    status: string;
  }>;
  goals: Array<{ title: string; targetMinutes: number | null; progressMinutes: number }>;
}

interface SessionJoinRow {
  id: string;
  scheduled_date: string;
  start_time: string | null;
  duration_minutes: number;
  session_type: string;
  status: string;
  subject: { name: string } | { name: string }[] | null;
  topic: { name: string } | { name: string }[] | null;
}

function joinName(
  value: { name: string } | { name: string }[] | null | undefined
): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0]?.name ?? null) : value.name;
}

/**
 * Loads everything the chat route needs about exams/plans/sessions/goals in
 * four bounded parallel reads. Failures degrade to empty lists (fail-open).
 */
export async function fetchPlannerChatContext(
  supabase: SupabaseClient,
  todayIso: string
): Promise<PlannerChatContext> {
  const todayStart = `${todayIso}T00:00:00`;

  const [examsResult, plansResult, sessionsResult, goalsResult] = await Promise.all([
    supabase
      .from("exams")
      .select("id, title, exam_date, target_score, status, subject:subjects(name)")
      .eq("status", "upcoming")
      .gte("exam_date", todayStart)
      .order("exam_date", { ascending: true })
      .limit(CHAT_EXAM_CAP),
    supabase
      .from("study_plans")
      .select("name, start_date, end_date, daily_minutes")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(CHAT_PLAN_CAP),
    supabase
      .from("study_sessions")
      .select(
        "id, scheduled_date, start_time, duration_minutes, session_type, status, " +
          "subject:subjects(name), topic:subject_topics(name)"
      )
      .eq("scheduled_date", todayIso)
      .in("status", ["planned", "in_progress", "completed"])
      .order("start_time", { ascending: true, nullsFirst: false })
      .limit(CHAT_SESSION_CAP),
    supabase
      .from("study_goals")
      .select("id, title, created_at, target_date, target_minutes, completed_minutes")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(CHAT_GOAL_CAP),
  ]);

  const exams = ((examsResult.data ?? []) as Array<Record<string, unknown>>).map(
    (row) => {
      const record = normalizeRow(row);
      const examDate = String(record.exam_date);
      const subjectRef = record.subject as
        | { name: string }
        | { name: string }[]
        | null;
      return {
        title: String(record.title),
        subjectName: joinName(subjectRef),
        examDate,
        daysLeft: examDaysLeft(examDate, todayIso),
        targetScore: (record.target_score as number | null) ?? null,
      };
    }
  );

  const plans = ((plansResult.data ?? []) as Array<Record<string, unknown>>).map(
    (row) => {
      const record = normalizeRow(row);
      return {
        name: String(record.name),
        startDate: String(record.start_date),
        endDate: String(record.end_date),
        dailyMinutes: Number(record.daily_minutes ?? 60),
      };
    }
  );

  const sessions = ((sessionsResult.data ?? []) as unknown as SessionJoinRow[]).map(
    (row) => ({
      label:
        joinName(row.topic) ??
        joinName(row.subject) ??
        "Study session",
      startTime: row.start_time ? row.start_time.slice(0, 5) : null,
      durationMinutes: Number(row.duration_minutes ?? 0),
      sessionType: row.session_type,
      status: row.status,
    })
  );

  const goalsRaw = ((goalsResult.data ?? []) as Array<Record<string, unknown>>).map(
    (row) => {
      const record = normalizeRow(row);
      return {
        title: String(record.title),
        createdAt: String(record.created_at),
        targetDate: (record.target_date as string | null) ?? null,
        targetMinutes: (record.target_minutes as number | null) ?? null,
        completedMinutes: Number(record.completed_minutes ?? 0),
      };
    }
  );

  const goals = goalsRaw.map((goal) => ({
    title: goal.title,
    targetMinutes: goal.targetMinutes,
    progressMinutes: goal.completedMinutes,
  }));

  return { todayIso, exams, plans, sessions, goals };
}

/** Builds the STUDY PLANNER CONTEXT block; null when the user has none. */
export function buildPlannerChatBlock(context: PlannerChatContext): string | null {
  const sections: string[] = [];

  if (context.exams.length > 0) {
    sections.push(
      `UPCOMING EXAMS:\n${context.exams
        .map((exam) => {
          const parts = [
            exam.subjectName ? `${exam.subjectName}: ` : "",
            exam.title,
            `— ${formatCountdownLabel(exam.daysLeft)}`,
            exam.targetScore !== null ? `, target ${exam.targetScore}%` : "",
          ];
          return `- ${parts.join("")}`;
        })
        .join("\n")}`
    );
  }

  if (context.plans.length > 0) {
    sections.push(
      `ACTIVE STUDY PLANS:\n${context.plans
        .map(
          (plan) =>
            `- ${plan.name} (${plan.startDate} → ${plan.endDate}, ${plan.dailyMinutes} min/day)`
        )
        .join("\n")}`
    );
  }

  if (context.sessions.length > 0) {
    sections.push(
      `TODAY'S STUDY SESSIONS (${context.todayIso}):\n${context.sessions
        .map(
          (session) =>
            `- ${session.startTime ?? "unscheduled"} ${session.label} — ${session.durationMinutes} min ${session.sessionType.replace("_", " ")} (${session.status})`
        )
        .join("\n")}`
    );
  }

  if (context.goals.length > 0) {
    sections.push(
      `STUDY GOALS:\n${context.goals
        .map((goal) => {
          const progress =
            goal.targetMinutes !== null
              ? ` — ${goal.progressMinutes}/${goal.targetMinutes} min done`
              : "";
          return `- ${goal.title}${progress}`;
        })
        .join("\n")}`
    );
  }

  if (sections.length === 0) return null;

  const block = sections.join("\n\n");
  return block.length > CHAT_BLOCK_CHAR_BUDGET
    ? `${block.slice(0, CHAT_BLOCK_CHAR_BUDGET)}…`
    : block;
}
