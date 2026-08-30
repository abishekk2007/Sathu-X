import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import type { RoutineRecord } from "@/types";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const ROUTINE_SELECT =
  "preferred_session_minutes, preferred_break_minutes, preferred_study_time, daily_study_target_minutes";

interface RoutineRow {
  preferred_session_minutes: number | null;
  preferred_break_minutes: number | null;
  preferred_study_time: string | null;
  daily_study_target_minutes: number | null;
}

function serializeRoutine(row: RoutineRow): RoutineRecord {
  return {
    preferredSessionMinutes: row.preferred_session_minutes,
    preferredBreakMinutes: row.preferred_break_minutes,
    preferredStudyTime: row.preferred_study_time,
    dailyStudyTargetMinutes: row.daily_study_target_minutes,
  };
}

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("profiles")
      .select(ROUTINE_SELECT)
      .maybeSingle();

    if (error) {
      console.error("[api/student/routine] Query failed");
      return jsonError(500, "server_error");
    }

    const row = data as RoutineRow | null;
    const routine: RoutineRecord = row
      ? serializeRoutine(row)
      : {
          preferredSessionMinutes: null,
          preferredBreakMinutes: null,
          preferredStudyTime: null,
          dailyStudyTargetMinutes: null,
        };

    return Response.json(routine);
  } catch {
    console.error("[api/student/routine] crashed");
    return jsonError(500, "server_error");
  }
}

const patchSchema = z.object({
  preferredSessionMinutes: z.number().int().min(5).max(240).nullable().optional(),
  preferredBreakMinutes: z.number().int().min(1).max(60).nullable().optional(),
  preferredStudyTime: z
    .string()
    .max(20)
    .nullable()
    .optional(),
  dailyStudyTargetMinutes: z.number().int().min(0).max(720).nullable().optional(),
});

export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");

  const updates: Record<string, number | string | null> = {};
  const d = parsed.data;
  if (d.preferredSessionMinutes !== undefined)
    updates.preferred_session_minutes = d.preferredSessionMinutes;
  if (d.preferredBreakMinutes !== undefined)
    updates.preferred_break_minutes = d.preferredBreakMinutes;
  if (d.preferredStudyTime !== undefined)
    updates.preferred_study_time = d.preferredStudyTime;
  if (d.dailyStudyTargetMinutes !== undefined)
    updates.daily_study_target_minutes = d.dailyStudyTargetMinutes;

  if (Object.keys(updates).length === 0) {
    return jsonError(400, "invalid_request");
  }

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", user.id)
      .select(ROUTINE_SELECT)
      .maybeSingle();

    if (error || !data) {
      console.error("[api/student/routine] Update failed");
      return jsonError(500, "server_error");
    }

    return Response.json(serializeRoutine(data as RoutineRow));
  } catch {
    console.error("[api/student/routine] crashed");
    return jsonError(500, "server_error");
  }
}
