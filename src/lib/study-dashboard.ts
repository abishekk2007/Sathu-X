import type { StudyActivity, StudySubject } from "@/types";
import { diffCalendarDays, toDateOnly } from "@/lib/study-planner";
import { flashcardIsDue } from "@/lib/flashcards";

/**
 * Pure, deterministic builders for the Study dashboard. Every value is a
 * function of the caller's own RLS-scoped rows — no randomness, no mock data,
 * no second source of truth. The API routes glue Supabase reads (bounded and
 * owner-scoped) into these functions; the tests drive them with fixtures.
 */

// ---------------------------------------------------------------------------
// Today's study minutes
// ---------------------------------------------------------------------------

export interface TodayPlannerRow {
  status: string;
  durationMinutes: number;
}

export interface ChatStudyRow {
  started_at: string;
  ended_at: string | null;
  active_seconds: number;
}

export interface TodayStudySummary {
  completed: number;
  planned: number;
}

/**
 * Real completed/planned study minutes for a day.
 * Completed = planner sessions with status "completed" + chat minutes from
 * chat_study_sessions that have ended (idle time excluded, as in the
 * productivity dashboard). Planned = all planner sessions for the day.
 */
export function computeTodayStudy(
  plannerToday: TodayPlannerRow[],
  chatToday: ChatStudyRow[]
): TodayStudySummary {
  const plannerCompleted = plannerToday
    .filter((session) => session.status === "completed")
    .reduce((sum, session) => sum + session.durationMinutes, 0);
  const planned = plannerToday.reduce(
    (sum, session) => sum + session.durationMinutes,
    0
  );
  const chatMinutes = Math.round(
    chatToday
      .filter((row) => row.ended_at !== null)
      .reduce((sum, row) => sum + (row.active_seconds ?? 0), 0) / 60
  );
  return { completed: plannerCompleted + chatMinutes, planned };
}

/** "0m" | "25m" | "1h" | "1h 15m" | "2h 15m" — clamped to whole minutes ≥ 0. */
export function formatStudyMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

// ---------------------------------------------------------------------------
// Daily goal
// ---------------------------------------------------------------------------

export interface GoalLike {
  target_minutes: number | null;
}

/**
 * The real daily goal: the profile's daily target when set, otherwise the
 * newest active study goal's target (null when neither exists → the UI shows
 * the "Set a daily goal" empty state).
 */
export function resolveDailyGoal(
  dailyTargetMinutes: number | null,
  activeGoals: GoalLike[]
): number | null {
  if (dailyTargetMinutes !== null && dailyTargetMinutes > 0) {
    return dailyTargetMinutes;
  }
  for (const goal of activeGoals) {
    if (goal.target_minutes !== null && goal.target_minutes > 0) {
      return goal.target_minutes;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subjects — real progress + next topic
// ---------------------------------------------------------------------------

export interface SubjectRowLike {
  id: string;
  name: string;
}

export interface SubjectTopicRowLike {
  id: string;
  subject_id: string;
  name: string;
  mastery: number;
  status: string;
}

function compareTopics(
  a: SubjectTopicRowLike,
  b: SubjectTopicRowLike
): number {
  if (a.mastery !== b.mastery) return a.mastery - b.mastery;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

/**
 * Per-subject progress (average topic mastery, 0 with no topics) and the next
 * topic to study (lowest-mastery non-mastered topic; "All topics mastered"
 * when every topic is mastered; null when the subject has no topics yet).
 */
export function buildSubjects(
  subjectRows: SubjectRowLike[],
  topicRows: SubjectTopicRowLike[]
): StudySubject[] {
  const topicsBySubject = new Map<string, SubjectTopicRowLike[]>();
  for (const topic of topicRows) {
    const list = topicsBySubject.get(topic.subject_id) ?? [];
    list.push(topic);
    topicsBySubject.set(topic.subject_id, list);
  }

  return subjectRows.map((subject) => {
    const topics = topicsBySubject.get(subject.id) ?? [];
    if (topics.length === 0) {
      return { id: subject.id, name: subject.name, progress: 0, nextTopic: null };
    }
    const progress = Math.round(
      topics.reduce((sum, topic) => sum + (topic.mastery ?? 0), 0) /
        topics.length
    );
    const toStudy = topics
      .filter((topic) => topic.status !== "mastered")
      .sort(compareTopics);
    const nextTopic =
      toStudy.length === 0 ? "All topics mastered" : toStudy[0].name;
    return { id: subject.id, name: subject.name, progress, nextTopic };
  });
}

// ---------------------------------------------------------------------------
// Flashcards — real counts
// ---------------------------------------------------------------------------

export interface FlashcardRowLike {
  last_reviewed_at: string | null;
}

export function computeFlashcardStats(
  cards: FlashcardRowLike[],
  todayIso: string
): { total: number; due: number } {
  return {
    total: cards.length,
    due: cards.filter((card) => flashcardIsDue(card.last_reviewed_at, todayIso))
      .length,
  };
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

const SESSION_TYPE_LABELS: Record<string, string> = {
  study: "Study",
  revision: "Revision",
  practice: "Practice",
  mock_test: "Mock test",
  review: "Review",
};

export interface ActivitySource {
  /** ISO instant the activity happened; drives ordering + the time label. */
  at: string;
  subject: string | null;
  action: string;
  kind: string;
}

export interface PlannerCompletedRowLike {
  completedAt: string | null;
  createdAt: string;
  subjectName?: string | null;
  topicName?: string | null;
  sessionType?: string;
  status: string;
}

export interface DocumentRowLike {
  name: string;
  created_at: string;
}

/** "Today" | "Yesterday" | "N days ago" — calendar-based, deterministic. */
export function activityTimeLabel(at: string, todayIso: string): string {
  const day = toDateOnly(new Date(at));
  const diff = diffCalendarDays(todayIso, day);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${diff} days ago`;
}

/** Groups chat study rows by subject+topic, returning recent-activity sources. */
export function buildChatSources(
  chatRows: Array<
    ChatStudyRow & {
      subject_id: string | null;
      topic_id: string | null;
      subjectName?: string | null;
      topicName?: string | null;
    }
  >
): ActivitySource[] {
  const byKey = new Map<
    string,
    { seconds: number; at: string; subject: string | null; name: string | null }
  >();
  for (const row of chatRows) {
    if (row.ended_at === null || !row.active_seconds || row.active_seconds <= 0)
      continue;
    const key = `${row.subject_id ?? "none"}::${row.topic_id ?? "none"}`;
    const existing = byKey.get(key);
    const subject = row.subjectName ?? null;
    const name = row.topicName ?? row.subjectName ?? null;
    if (existing) {
      existing.seconds += row.active_seconds;
      if (row.started_at > existing.at) existing.at = row.started_at;
    } else {
      byKey.set(key, {
        seconds: row.active_seconds,
        at: row.started_at,
        subject,
        name: name ?? subject,
      });
    }
  }
  return [...byKey.values()]
    .filter((entry) => Math.round(entry.seconds / 60) > 0)
    .map((entry) => ({
      at: entry.at,
      subject: entry.subject,
      action: entry.name
        ? `Studied ${entry.name}`
        : "Studied in chat",
      kind: "chat",
    }));
}

/** Sources from today's completed planner sessions. */
export function buildPlannerSources(
  plannerToday: PlannerCompletedRowLike[]
): ActivitySource[] {
  return plannerToday
    .filter((session) => session.status === "completed")
    .map((session) => {
      const label = session.sessionType
        ? SESSION_TYPE_LABELS[session.sessionType] ?? "Study"
        : "Study";
      return {
        at: session.completedAt ?? session.createdAt,
        subject: session.topicName ?? session.subjectName ?? null,
        action: `Completed ${label} session`,
        kind: "planner",
      };
    });
}

/** Sources from recently uploaded documents. */
export function buildDocumentSources(
  documents: DocumentRowLike[]
): ActivitySource[] {
  return documents.map((document) => ({
    at: document.created_at,
    subject: null,
    action: `Uploaded ${document.name}`,
    kind: "document",
  }));
}

/**
 * Merges and sorts recent activity newest-first (stable tie-break by kind +
 * action so ordering is deterministic) and caps the list.
 */
export function buildRecentActivity(
  sources: ActivitySource[],
  todayIso: string,
  limit = 8
): StudyActivity[] {
  return [...sources]
    .sort((a, b) => {
      if (a.at !== b.at) return b.at.localeCompare(a.at);
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.action.localeCompare(b.action);
    })
    .slice(0, limit)
    .map((source, index) => ({
      id: `${index}-${source.kind}`,
      action: source.action,
      subject: source.subject,
      timeLabel: activityTimeLabel(source.at, todayIso),
    }));
}