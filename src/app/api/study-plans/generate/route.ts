import { z } from "zod";

import { getGeminiClient } from "@/lib/gemini";
import {
  AI_PLAN_MAX_DAYS,
  AI_PROMPT_TOPIC_CAP,
  buildDeterministicPlan,
  diffCalendarDays,
  mapAiPlanToDrafts,
  parseAiPlan,
  serializePlanRow,
  serializeStudySessionRow,
} from "@/lib/study-planner";
import type {
  AiPlanPayload,
  PlannedSessionDraft,
} from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date");
const TIME_STRING = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "invalid_time");

const generateSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    /** Regeneration mode: patch this plan instead of creating a new one. */
    planId: z.string().uuid().optional(),
    /** Explicit confirmation required before replacing future sessions. */
    replaceFutureSessions: z.boolean().optional(),
    examId: z.string().uuid().nullable().optional(),
    startDate: DATE_STRING.optional(),
    endDate: DATE_STRING.optional(),
    dailyMinutes: z.number().int().min(15).max(720).optional(),
    preferredDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    preferredTime: TIME_STRING.nullable().optional(),
    subjectIds: z.array(z.string().uuid()).max(12).optional(),
    /** Client's local date so "today" matches the user's calendar. */
    today: DATE_STRING.optional(),
  })
  .refine(
    (value) => !(value.planId !== undefined && value.replaceFutureSessions !== true),
    { message: "confirmation_required" }
  )
  .refine(
    (value) => !value.startDate || !value.endDate || value.endDate >= value.startDate,
    { message: "date_order" }
  );

interface TopicScanRow {
  id: string;
  subject_id: string;
  name: string;
  mastery: number;
  status: string;
}

const PLAN_SYSTEM_INSTRUCTION = [
  "You are a study-plan generator. You receive a JSON payload describing an",
  "exam, subjects, topics with mastery percentages, and the student's",
  'available time. Reply with ONLY a JSON object: {"plan":[{"date":"YYYY-MM-DD",',
  '"sessions":[{"subject":"...","topic":"...","type":"study|revision|practice|',
  'mock_test|review","minutes":45}]}]}.',
  "",
  "Rules:",
  "- Only use dates inside the given window and only the allowed weekdays.",
  "- Only reference topics exactly as given; never invent topics or subjects.",
  "- Prioritise low-mastery topics first; give strong topics short revision.",
  "- Keep each day's minutes within daily_minutes. Use 25-45 minute blocks.",
  "- Schedule light review or one mock test in the last days before the exam.",
  "- No prose, no markdown fences — just the JSON object.",
].join("\n");

/** Calls Gemini for a structured plan; returns null on ANY failure. */
async function generateAiPlanPayload(
  promptPayload: string
): Promise<AiPlanPayload | null> {
  const client = getGeminiClient();
  if (!client) return null;

  try {
    const result = await client.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
      contents: [{ role: "user", parts: [{ text: promptPayload }] }],
      config: {
        systemInstruction: PLAN_SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        temperature: 0.4,
      },
    });

    const text =
      result.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("") ?? "";
    if (!text.trim()) return null;
    return parseAiPlan(text);
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    console.error(`[api/study-plans/generate] Gemini planning failed (${name})`);
    return null;
  }
}

/**
 * Generates a study plan from the caller's real data:
 *   1. Loads owned exams/subjects/topics through RLS-scoped reads.
 *   2. Tries Gemini structured output (Zod-validated, mapped to known ids).
 *   3. Falls back to the deterministic weak-first planner on any failure.
 *   4. Persists plan + sessions; regeneration keeps completed history.
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

  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message;
    if (issue === "confirmation_required")
      return jsonError(400, "confirmation_required");
    if (issue === "date_order") return jsonError(400, "invalid_date_range");
    return jsonError(400, "invalid_request");
  }
  const input = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();
    const todayIso = input.today ?? new Date().toISOString().slice(0, 10);

    // ---- Load owned context ------------------------------------------------
    let exam:
      | {
          id: string;
          title: string;
          exam_date: string;
          subject_id: string | null;
          target_score: number | null;
          status: string;
        }
      | null = null;

    if (input.examId) {
      const { data } = await supabase
        .from("exams")
        .select("id, title, exam_date, subject_id, target_score, status")
        .eq("id", input.examId)
        .maybeSingle();
      // Foreign/unknown exam → safe 404.
      if (!data) return jsonError(404, "not_found");
      // Completed/cancelled exams stop generating sessions (spec).
      if (data.status !== "upcoming" && data.status !== "in_progress") {
        return jsonError(400, "exam_not_active");
      }
      exam = data;
    }

    const [subjectsResult] = await Promise.all([
      supabase.from("subjects").select("id, name").limit(50),
    ]);

    const subjects = (subjectsResult.data ?? []) as Array<{ id: string; name: string }>;

    const selectedSubjectIds = new Set<string>(
      input.subjectIds?.length
        ? input.subjectIds
        : exam?.subject_id
          ? [exam.subject_id]
          : []
    );
    const scopedSubjects =
      selectedSubjectIds.size > 0
        ? subjects.filter((subject) => selectedSubjectIds.has(subject.id))
        : subjects;
    if (scopedSubjects.length === 0) return jsonError(400, "no_subjects");

    const { data: topicsData } = await supabase
      .from("subject_topics")
      .select("id, subject_id, name, mastery, status")
      .in(
        "subject_id",
        scopedSubjects.map((subject) => subject.id)
      )
      .order("updated_at", { ascending: false })
      .limit(400);

    // Mastered topics need no new study sessions.
    const topics = ((topicsData ?? []) as unknown as TopicScanRow[]).filter(
      (topic) => topic.status !== "mastered"
    );
    if (topics.length === 0) return jsonError(400, "no_topics");

    // ---- Resolve the scheduling window -------------------------------------
    const examDateOnly = exam ? exam.exam_date.slice(0, 10) : null;
    let startIso = input.startDate ?? todayIso;
    if (diffCalendarDays(startIso, todayIso) < 0) startIso = todayIso;

    let endIso =
      input.endDate ??
      (examDateOnly && diffCalendarDays(examDateOnly, todayIso) > 0
        ? examDateOnly
        : addDaysIsoLocal(startIso, Math.min(13, AI_PLAN_MAX_DAYS - 1)));
    if (diffCalendarDays(endIso, startIso) < 0) endIso = startIso;
    if (diffCalendarDays(endIso, startIso) > AI_PLAN_MAX_DAYS - 1)
      endIso = addDaysIsoLocal(startIso, AI_PLAN_MAX_DAYS - 1);
    // Never schedule on/after the exam instant's calendar date.
    if (
      examDateOnly &&
      diffCalendarDays(endIso, examDateOnly) > 0 &&
      diffCalendarDays(startIso, examDateOnly) <= 0
    ) {
      endIso = examDateOnly;
    }

    const dailyMinutes = input.dailyMinutes ?? 60;
    const preferredDays = input.preferredDays ?? [0, 1, 2, 3, 4, 5, 6];
    const preferredTime = input.preferredTime ?? null;

    // ---- Try Gemini, then fall back to the deterministic engine -------------
    const prioritizedTopics = [...topics]
      .sort((a, b) => a.mastery - b.mastery)
      .slice(0, AI_PROMPT_TOPIC_CAP);

    const promptPayload = JSON.stringify({
      today: todayIso,
      window: { start: startIso, end: endIso },
      daily_minutes: dailyMinutes,
      allowed_weekdays: preferredDays,
      preferred_start_time: preferredTime,
      exam: exam
        ? {
            title: exam.title,
            date: examDateOnly,
            days_left: examDateOnly
              ? diffCalendarDays(examDateOnly, todayIso)
              : null,
            target_score: exam.target_score,
          }
        : null,
      subjects: scopedSubjects.map((subject) => ({ name: subject.name })),
      topics: prioritizedTopics.map((topic) => ({
        subject: scopedSubjects.find((s) => s.id === topic.subject_id)?.name ?? "",
        topic: topic.name,
        mastery: topic.mastery,
        status: topic.status,
      })),
    });

    const aiPayload = await generateAiPlanPayload(promptPayload);

    // Name→id maps for validating AI output against REAL owned rows only.
    const subjectsByName = new Map<string, { id: string }>();
    for (const subject of scopedSubjects) {
      subjectsByName.set(subject.name.trim().toLowerCase(), { id: subject.id });
    }
    const topicsByKey = new Map<string, { id: string; subjectId: string }>();
    for (const topic of topics) {
      const key = `${topic.name.trim().toLowerCase()}`;
      topicsByKey.set(key, { id: topic.id, subjectId: topic.subject_id });
    }

    let drafts: PlannedSessionDraft[] = [];
    let source: "ai" | "fallback" = "ai";
    if (aiPayload) {
      drafts = mapAiPlanToDrafts(aiPayload, {
        allowedDates: buildAllowedDates(startIso, endIso),
        preferredDays: new Set(preferredDays),
        subjectsByName,
        topicsByKey,
        fallbackSubjectId: scopedSubjects.length === 1 ? scopedSubjects[0].id : null,
        fallbackStartTime: preferredTime,
        maxDailyMinutes: dailyMinutes,
        maxSessions: 400,
      });
    }

    // Fewer than three usable AI sessions → deterministic fallback wins.
    if (drafts.length < 3) {
      source = "fallback";
      drafts = buildDeterministicPlan({
        startDate: startIso,
        endDate: endIso,
        dailyMinutes,
        preferredDays,
        preferredTime,
        topics: topics.map((topic) => ({
          id: topic.id,
          subjectId: topic.subject_id,
          name: topic.name,
          mastery: topic.mastery,
          status: topic.status,
        })),
        hardEndDate: examDateOnly,
      });
    }

    // ---- Persist (regeneration keeps completed history) ---------------------
    let planId: string;
    let planName = input.name;
    let savedPlan: Record<string, unknown>;

    if (input.planId) {
      // Ownership verified through an RLS-scoped read — foreign ids 404.
      const { data: existingPlan } = await supabase
        .from("study_plans")
        .select("id, name")
        .eq("id", input.planId)
        .maybeSingle();
      if (!existingPlan) return jsonError(404, "not_found");

      planName = planName ?? String(existingPlan.name);
      // Delete ONLY future unfinished sessions — completed history stays.
      const { error: deleteError } = await supabase
        .from("study_sessions")
        .delete()
        .eq("study_plan_id", input.planId)
        .in("status", ["planned", "in_progress"])
        .gte("scheduled_date", todayIso);
      if (deleteError) {
        console.error("[api/study-plans/generate] Failed to clear old sessions");
        return jsonError(500, "server_error");
      }

      const { data: updatedPlan, error: updateError } = await supabase
        .from("study_plans")
        .update({
          name: planName,
          start_date: startIso,
          end_date: endIso,
          daily_minutes: dailyMinutes,
          status: "active",
        })
        .eq("id", input.planId)
        .select("*")
        .single();
      if (updateError || !updatedPlan) {
        console.error("[api/study-plans/generate] Plan update failed");
        return jsonError(404, "not_found");
      }
      planId = input.planId;
      savedPlan = updatedPlan as unknown as Record<string, unknown>;
    } else {
      if (!planName) {
        planName = exam ? `${exam.title} — prep plan` : `Study plan · ${startIso}`;
      }
      const { data: newPlan, error: insertError } = await supabase
        .from("study_plans")
        .insert({
          name: planName,
          start_date: startIso,
          end_date: endIso,
          daily_minutes: dailyMinutes,
          status: "active",
        })
        .select("*")
        .single();
      if (insertError || !newPlan) {
        console.error("[api/study-plans/generate] Plan insert failed");
        return jsonError(500, "server_error");
      }
      planId = String(newPlan.id);
      savedPlan = newPlan as unknown as Record<string, unknown>;
    }

    if (drafts.length > 0) {
      const rows = drafts.slice(0, 400).map((draft) => ({
        study_plan_id: planId,
        subject_id: draft.subjectId,
        topic_id: draft.topicId,
        exam_id: exam?.id ?? null,
        scheduled_date: draft.scheduledDate,
        start_time: draft.startTime,
        duration_minutes: draft.durationMinutes,
        session_type: draft.sessionType,
        status: "planned",
      }));
      const { error: sessionError } = await supabase
        .from("study_sessions")
        .insert(rows);
      if (sessionError) {
        console.error("[api/study-plans/generate] Session insert failed");
        return jsonError(500, "server_error");
      }
    }

    const { data: finalSessions } = await supabase
      .from("study_sessions")
      .select("*, subject:subjects(name), topic:subject_topics(name)")
      .eq("study_plan_id", planId)
      .order("scheduled_date", { ascending: true })
      .order("start_time", { ascending: true, nullsFirst: false })
      .limit(500);

    return Response.json({
      plan: serializePlanRow(savedPlan as never),
      sessions: ((finalSessions ?? []) as Array<Record<string, unknown>>).map((row) =>
        serializeStudySessionRow(row)
      ),
      source,
    });
  } catch {
    console.error("[api/study-plans/generate] crashed");
    return jsonError(500, "server_error");
  }
}

// ---------------------------------------------------------------------------
// Local date helpers (mirror lib/study-planner without importing server-only)
// ---------------------------------------------------------------------------

function addDaysIsoLocal(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildAllowedDates(startIso: string, endIso: string): Set<string> {
  const dates = new Set<string>();
  let cursor = startIso;
  while (diffCalendarDays(endIso, cursor) >= 0) {
    dates.add(cursor);
    cursor = addDaysIsoLocal(cursor, 1);
  }
  return dates;
}
