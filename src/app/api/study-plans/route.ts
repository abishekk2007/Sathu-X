import { z } from "zod";

import { serializePlanRow } from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date");

export const planCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).nullable().optional(),
    startDate: DATE_STRING,
    endDate: DATE_STRING,
    dailyMinutes: z.number().int().min(1).max(960).optional(),
    status: z
      .enum(["draft", "active", "completed", "paused", "archived"])
      .optional(),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: "date_order",
  });

interface PlanRow {
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

/** Study plan list + manual creation (generation lives in /generate). */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("study_plans")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("[api/study-plans] GET failed");
      return jsonError(500, "server_error");
    }
    return Response.json({
      plans: ((data ?? []) as unknown as PlanRow[]).map(serializePlanRow),
    });
  } catch {
    console.error("[api/study-plans] GET crashed");
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

  const parsed = planCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const input = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    // Duplicate guard for accidental double-submits.
    const { data: clash } = await supabase
      .from("study_plans")
      .select("id")
      .ilike("name", input.name)
      .eq("start_date", input.startDate)
      .limit(1);
    if (clash && clash.length > 0) return jsonError(409, "duplicate_plan");

    const { data, error } = await supabase
      .from("study_plans")
      .insert({
        name: input.name,
        description: input.description ?? null,
        start_date: input.startDate,
        end_date: input.endDate,
        daily_minutes: input.dailyMinutes ?? 60,
        status: input.status ?? "active",
      })
      .select("*")
      .single();

    if (error || !data) {
      console.error("[api/study-plans] POST failed");
      return jsonError(500, "server_error");
    }
    return Response.json(
      { plan: serializePlanRow(data as unknown as PlanRow) },
      { status: 201 }
    );
  } catch {
    console.error("[api/study-plans] POST crashed");
    return jsonError(500, "server_error");
  }
}
