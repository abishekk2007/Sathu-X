import { z } from "zod";

import { goalCoversDate } from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import type { GoalStatus, StudyGoalRecord } from "@/types";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date");

const createSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  targetDate: DATE_STRING.nullable().optional(),
  targetMinutes: z.number().int().min(1).max(100000).nullable().optional(),
});

interface GoalDbRow {
  id: string;
  title: string;
  description: string | null;
  target_date: string | null;
  target_minutes: number | null;
  completed_minutes: number;
  status: string;
  created_at: string;
  updated_at: string;
}

function serializeGoalRow(
  row: GoalDbRow,
  progressMinutes?: number
): StudyGoalRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    targetDate: row.target_date,
    targetMinutes: row.target_minutes,
    completedMinutes: row.completed_minutes,
    status: row.status as GoalStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(progressMinutes !== undefined ? { progressMinutes } : {}),
  };
}

/**
 * Goal list with REAL recomputed progress: completed minutes are summed from
 * actual completed sessions inside each goal's window — the stored counter is
 * never trusted for display.
 */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  try {
    const supabase = await getSupabaseServerClient();
    const [goalsResult, sessionsResult] = await Promise.all([
      supabase
        .from("study_goals")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("study_sessions")
        .select("scheduled_date, duration_minutes, status, created_at, updated_at")
        .eq("status", "completed")
        .order("scheduled_date", { ascending: false })
        .limit(500),
    ]);

    const firstError = goalsResult.error ?? sessionsResult.error;
    if (firstError) {
      console.error("[api/study-goals] GET failed");
      return jsonError(500, "server_error");
    }

    const goals = (goalsResult.data ?? []) as unknown as GoalDbRow[];
    const completedSessions = (sessionsResult.data ?? []) as Array<{
      scheduled_date: string;
      duration_minutes: number;
      status: string;
      created_at: string;
      updated_at: string;
    }>;

    // One pass over bounded completed sessions attributes them per goal.
    const payload = goals.map((goal) => {
      let progress = 0;
      for (const session of completedSessions) {
        if (goalCoversDate({ createdAt: goal.created_at, targetDate: goal.target_date }, session.scheduled_date)) {
          progress += Number(session.duration_minutes ?? 0);
        }
      }
      return serializeGoalRow(goal, progress);
    });

    return Response.json({ goals: payload });
  } catch {
    console.error("[api/study-goals] GET crashed");
    return jsonError(500, "server_error");
  }
}

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

    // Duplicate guard for accidental double-submits.
    const { data: clash } = await supabase
      .from("study_goals")
      .select("id")
      .ilike("title", input.title)
      .eq("status", "active")
      .limit(1);
    if (clash && clash.length > 0) return jsonError(409, "duplicate_goal");

    const { data, error } = await supabase
      .from("study_goals")
      .insert({
        title: input.title,
        description: input.description ?? null,
        target_date: input.targetDate ?? null,
        target_minutes: input.targetMinutes ?? null,
        status: "active",
      })
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/study-goals] POST failed");
      return jsonError(500, "server_error");
    }
    return Response.json(
      { goal: serializeGoalRow(data as unknown as GoalDbRow, 0) },
      { status: 201 }
    );
  } catch {
    console.error("[api/study-goals] POST crashed");
    return jsonError(500, "server_error");
  }
}
