import {
  MASTERY_LEARNING_THRESHOLD,
  MASTERY_REVIEW_THRESHOLD,
  MASTERY_STRONG_THRESHOLD,
} from "@/lib/student-intelligence";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import type {
  StudentDashboardData,
  StudentRecentActivity,
  StudentTopicHighlight,
} from "@/types";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

interface TopicAggRow {
  id: string;
  subject_id: string;
  name: string;
  mastery: number;
  status: string;
}

/**
 * Aggregated student dashboard payload — every number is computed from real,
 * RLS-scoped rows. Three bounded reads + one count; no joins on the client.
 */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  try {
    const supabase = await getSupabaseServerClient();

    const [subjectsResult, topicsResult, recentResult, practicedCount] =
      await Promise.all([
        supabase
          .from("subjects")
          .select("id, name, code, semester, color")
          .order("updated_at", { ascending: false })
          .limit(100),
        supabase
          .from("subject_topics")
          .select("id, subject_id, name, mastery, status")
          .order("updated_at", { ascending: false })
          .limit(1000),
        supabase
          .from("student_knowledge")
          .select(
            "id, last_reviewed_at, topic:subject_topics(name), subject:subjects(name)"
          )
          .not("last_reviewed_at", "is", null)
          .order("last_reviewed_at", { ascending: false })
          .limit(6),
        supabase
          .from("student_knowledge")
          .select("id", { count: "exact", head: true }),
      ]);

    const firstError =
      subjectsResult.error ?? topicsResult.error ?? recentResult.error;
    if (firstError) {
      console.error("[api/student/dashboard] Query failed");
      return jsonError(500, "server_error");
    }

    const subjects = (subjectsResult.data ?? []) as Array<{
      id: string;
      name: string;
      code: string | null;
      semester: string | null;
      color: string | null;
    }>;
    const topics = (topicsResult.data ?? []) as unknown as TopicAggRow[];

    // ---- Aggregations -----------------------------------------------------
    const topicsBySubject = new Map<string, TopicAggRow[]>();
    for (const topic of topics) {
      const list = topicsBySubject.get(topic.subject_id);
      if (list) list.push(topic);
      else topicsBySubject.set(topic.subject_id, [topic]);
    }

    const subjectCards = subjects.map((subject) => {
      const subjectTopics = topicsBySubject.get(subject.id) ?? [];
      const avg =
        subjectTopics.length === 0
          ? null
          : Math.round(
              subjectTopics.reduce((sum, t) => sum + t.mastery, 0) /
                subjectTopics.length
            );
      return {
        id: subject.id,
        name: subject.name,
        code: subject.code,
        semester: subject.semester,
        color: subject.color,
        topicCount: subjectTopics.length,
        avgMastery: avg,
      };
    });

    const active = topics.filter((t) => t.status !== "not_started");
    const overallMastery =
      topics.length === 0
        ? null
        : Math.round(
            topics.reduce((sum, t) => sum + t.mastery, 0) / topics.length
          );

    const strongTopics = active.filter(
      (t) => t.mastery >= MASTERY_STRONG_THRESHOLD
    ).length;
    const needsReviewTopics = active.filter(
      (t) =>
        t.mastery >= MASTERY_REVIEW_THRESHOLD &&
        t.mastery < MASTERY_LEARNING_THRESHOLD
    ).length;
    const weakTopics = active.filter(
      (t) => t.mastery < MASTERY_REVIEW_THRESHOLD
    ).length;

    const subjectNameOf = (subjectId: string) =>
      subjects.find((s) => s.id === subjectId)?.name ?? null;

    const toHighlight = (
      row: TopicAggRow
    ): StudentTopicHighlight & { subjectId: string } => ({
      topicId: row.id,
      topicName: row.name,
      subjectName: subjectNameOf(row.subject_id) ?? "—",
      mastery: row.mastery,
      subjectId: row.subject_id,
    });

    const stripInternal = ({
      topicId,
      topicName,
      subjectName,
      mastery,
    }: StudentTopicHighlight & { subjectId: string }) =>
      ({ topicId, topicName, subjectName, mastery }) as StudentTopicHighlight;

    const weakAreas = [...active]
      .sort((a, b) => a.mastery - b.mastery)
      .slice(0, 6)
      .map(toHighlight)
      .map(stripInternal);

    const strongAreas = [...active]
      .sort((a, b) => b.mastery - a.mastery)
      .filter((t) => t.mastery >= MASTERY_LEARNING_THRESHOLD)
      .slice(0, 6)
      .map(toHighlight)
      .map(stripInternal);

    const recentActivity = ((recentResult.data ?? []) as Array<{
      id: string;
      last_reviewed_at: string | null;
      topic: { name: string } | { name: string }[] | null;
      subject: { name: string } | { name: string }[] | null;
    }>).map<StudentRecentActivity>((row) => {
      const topicRef = Array.isArray(row.topic) ? row.topic[0] : row.topic;
      const subjectRef = Array.isArray(row.subject)
        ? row.subject[0]
        : row.subject;
      return {
        topicName: topicRef?.name ?? "Topic",
        subjectName: subjectRef?.name ?? null,
        reviewedAt: row.last_reviewed_at ?? "",
      };
    });

    // ---- Deterministic insights -------------------------------------------
    const insights: string[] = [];
    const weakest = [...active].sort((a, b) => a.mastery - b.mastery)[0];
    if (weakTopics > 0 && weakest) {
      insights.push(
        `You have ${weakTopics} topic${weakTopics === 1 ? "" : "s"} below ${MASTERY_REVIEW_THRESHOLD}% mastery — start with "${weakest.name}" (${weakest.mastery}%).`
      );
    }
    if (needsReviewTopics > 0) {
      insights.push(
        `${needsReviewTopics} topic${needsReviewTopics === 1 ? " is" : "s are"} in the ${MASTERY_REVIEW_THRESHOLD}–${MASTERY_LEARNING_THRESHOLD}% review zone — one focused session each would lift them.`
      );
    }
    if (strongTopics >= 5) {
      insights.push(
        `Strong work — ${strongTopics} topics are above ${MASTERY_STRONG_THRESHOLD}%. Revisit them occasionally so they stay fresh.`
      );
    }
    if (
      topics.length > 0 &&
      weakTopics === 0 &&
      needsReviewTopics === 0 &&
      strongTopics > 0
    ) {
      insights.push(
        "No weak areas right now — keep up the practice streak."
      );
    }
    if (topics.length > 0 && active.length === 0) {
      insights.push(
        "All your topics are still marked not started — set the ones you're currently learning."
      );
    }

    const payload: StudentDashboardData = {
      stats: {
        subjects: subjects.length,
        topics: topics.length,
        overallMastery,
        strongTopics,
        needsReviewTopics,
        weakTopics,
        practicedTopics: practicedCount.count ?? 0,
      },
      subjects: subjectCards,
      weakAreas,
      strongAreas,
      recentActivity,
      insights,
    };

    return Response.json(payload);
  } catch {
    console.error("[api/student/dashboard] crashed");
    return jsonError(500, "server_error");
  }
}
