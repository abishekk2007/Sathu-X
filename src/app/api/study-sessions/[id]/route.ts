import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { diffCalendarDays, serializeStudySessionRow } from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date");
const TIME_STRING = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "invalid_time");

const patchSchema = z
  .object({
    scheduledDate: DATE_STRING.optional(),
    startTime: TIME_STRING.nullable().optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    sessionType: z
      .enum(["study", "revision", "practice", "mock_test", "review"])
      .optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    status: z
      .enum(["planned", "in_progress", "completed", "skipped", "cancelled"])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SessionDbRow {
  id: string;
  study_plan_id: string | null;
  subject_id: string | null;
  topic_id: string | null;
  exam_id: string | null;
  scheduled_date: string;
  start_time: string | null;
  duration_minutes: number;
  session_type: string;
  status: string;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface GoalRow {
  id: string;
  title: string;
  created_at: string;
  target_date: string | null;
  target_minutes: number | null;
  completed_minutes: number;
}

/**
 * Adjusts active goals whose window covers `isoDate` by `delta` minutes
 * (floored at zero). Idempotent by construction: callers only invoke it when
 * the completion state actually flips.
 */
async function adjustGoalMinutes(
  supabase: SupabaseClient,
  isoDate: string,
  delta: number
): Promise<void> {
  if (delta === 0) return;
  const { data } = await supabase
    .from("study_goals")
    .select("id, title, created_at, target_date, target_minutes, completed_minutes")
    .eq("status", "active")
    .limit(20);
  const goals = ((data ?? []) as unknown as GoalRow[]).filter((goal) => {
    const startIso = new Date(goal.created_at).toISOString().slice(0, 10);
    const endIso = goal.target_date ?? addDaysIsoLocal(startIso, 6);
    return (
      diffCalendarDays(isoDate, startIso) >= 0 &&
      diffCalendarDays(endIso, isoDate) >= 0
    );
  });

  for (const goal of goals) {
    const next = Math.max(0, goal.completed_minutes + delta);
    const { error } = await supabase
      .from("study_goals")
      .update({
        completed_minutes: next,
        // Auto-complete a goal once its minute target is genuinely reached.
        ...(goal.target_minutes !== null && next >= goal.target_minutes
          ? { status: "completed" }
          : {}),
      })
      .eq("id", goal.id);
    if (error) {
      console.error("[api/study-sessions/:id] Goal minute update failed");
    }
  }
}

function addDaysIsoLocal(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Session updates. Completion is transition-guarded so clicking Complete
 * twice never double-counts; un-completing (or deleting) reverses the goal
 * contribution exactly once.
 */
export async function PATCH(request: Request, context: RouteContext) {
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const input = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    const { data: existing, error: loadError } = await supabase
      .from("study_sessions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (loadError) {
      console.error("[api/study-sessions/:id] PATCH load failed");
      return jsonError(500, "server_error");
    }
    if (!existing) return jsonError(404, "not_found");
    const before = existing as unknown as SessionDbRow;

    // Whitelist mapping — id/user_id/created_at are never client-writable.
    const updates: Record<string, unknown> = {};
    if (input.scheduledDate !== undefined)
      updates.scheduled_date = input.scheduledDate;
    if (input.startTime !== undefined) updates.start_time = input.startTime;
    if (input.durationMinutes !== undefined)
      updates.duration_minutes = input.durationMinutes;
    if (input.sessionType !== undefined) updates.session_type = input.sessionType;
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.status !== undefined) {
      updates.status = input.status;
      if (input.status === "completed") {
        // Keep the FIRST completion timestamp; repeated clicks are no-ops.
        updates.completed_at = before.completed_at ?? new Date().toISOString();
      } else if (before.status === "completed") {
        updates.completed_at = null;
      }
    }

    const { data, error } = await supabase
      .from("study_sessions")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();
    if (error || !data) {
      console.error("[api/study-sessions/:id] PATCH failed");
      return jsonError(500, "server_error");
    }

    // ---- Goal accounting on real transitions only ---------------------------
    const becameCompleted =
      input.status === "completed" && before.status !== "completed";
    const leftCompleted =
      input.status !== undefined &&
      input.status !== "completed" &&
      before.status === "completed";

    if (becameCompleted) {
      const effectiveDuration = input.durationMinutes ?? before.duration_minutes;
      const effectiveDate = input.scheduledDate ?? before.scheduled_date;
      await adjustGoalMinutes(supabase, effectiveDate, effectiveDuration);
    } else if (leftCompleted) {
      await adjustGoalMinutes(supabase, before.scheduled_date, -before.duration_minutes);
    }

    return Response.json({
      session: serializeStudySessionRow(data as Record<string, unknown>),
    });
  } catch {
    console.error("[api/study-sessions/:id] PATCH crashed");
    return jsonError(500, "server_error");
  }
}

/** Deletion reverses goal progress if (and only if) the session was completed. */
export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();

    const { data: existing } = await supabase
      .from("study_sessions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!existing) return jsonError(404, "not_found");
    const before = existing as unknown as SessionDbRow;

    const { data, error } = await supabase
      .from("study_sessions")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) {
      console.error("[api/study-sessions/:id] DELETE failed");
      return jsonError(500, "server_error");
    }
    if (!data || data.length === 0) return jsonError(404, "not_found");

    if (before.status === "completed") {
      await adjustGoalMinutes(
        supabase,
        before.scheduled_date,
        -before.duration_minutes
      );
    }
    return Response.json({ deleted: data.length });
  } catch {
    console.error("[api/study-sessions/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}
