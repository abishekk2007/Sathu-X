import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Maximum active seconds a single heartbeat can add (2 minutes). */
const MAX_HEARTBEAT_SECONDS = 120;
/** Minimum seconds between heartbeat updates on the same session (debounce). */
const MIN_HEARTBEAT_GAP_SECONDS = 10;

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

// ---------------------------------------------------------------------------
// POST /api/student/chat-study-sessions — start a new session
// ---------------------------------------------------------------------------

const startSchema = z.object({
  subjectId: z.string().uuid(),
  topicId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const parsed = startSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");

  const { subjectId, topicId, conversationId } = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    // Verify subject ownership via RLS (insert policy checks ownership).
    // Check for an existing active session for this user+subject+topic to
    // prevent duplicate sessions (multi-tab guard).
    const { data: existingActive } = await supabase
      .from("chat_study_sessions")
      .select("id")
      .is("ended_at", null)
      .eq("subject_id", subjectId)
      .eq("topic_id", topicId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingActive) {
      // Return the existing active session — client should resume tracking.
      return Response.json({
        sessionId: existingActive.id,
        resumed: true,
      });
    }

    const now = new Date().toISOString();
    const { data: session, error: insertError } = await supabase
      .from("chat_study_sessions")
      .insert({
        subject_id: subjectId,
        topic_id: topicId ?? null,
        conversation_id: conversationId ?? null,
        started_at: now,
        last_activity_at: now,
        active_seconds: 0,
        source: "chat",
      })
      .select("id")
      .single();

    if (insertError || !session) {
      console.error("[api/chat-study-sessions] insert failed");
      return jsonError(500, "server_error");
    }

    return Response.json({
      sessionId: session.id as string,
      resumed: false,
    });
  } catch {
    console.error("[api/chat-study-sessions] crashed");
    return jsonError(500, "server_error");
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/student/chat-study-sessions — heartbeat / stop
// ---------------------------------------------------------------------------

const patchSchema = z.object({
  sessionId: z.string().uuid(),
  activeSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_HEARTBEAT_SECONDS)
    .optional(),
  stop: z.boolean().optional(),
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

  const { sessionId, activeSeconds, stop } = parsed.data;
  const isStop = stop === true;
  const delta = activeSeconds ?? 0;

  if (!isStop && delta <= 0) {
    // Nothing to update — skip round-trip.
    return Response.json({ ok: true });
  }

  try {
    const supabase = await getSupabaseServerClient();

    // Read the current session to validate ownership + anti-inflation.
    const { data: session, error: fetchError } = await supabase
      .from("chat_study_sessions")
      .select("id, started_at, active_seconds, ended_at, last_activity_at")
      .eq("id", sessionId)
      .maybeSingle();

    if (fetchError || !session) {
      return jsonError(404, "not_found");
    }

    // Already ended — client should start a new session.
    if (session.ended_at) {
      return Response.json({ ok: true, sessionEnded: true });
    }

    const now = new Date();
    const lastActivity = session.last_activity_at
      ? new Date(session.last_activity_at)
      : new Date(session.started_at);
    const gapSeconds = (now.getTime() - lastActivity.getTime()) / 1000;

    // Anti-inflation: ignore heartbeat if gap is too small.
    if (!isStop && gapSeconds < MIN_HEARTBEAT_GAP_SECONDS) {
      return Response.json({ ok: true, throttled: true });
    }

    // Anti-inflation: clamp delta to real elapsed time since last activity.
    const clampedDelta = isStop
      ? 0
      : Math.min(delta, Math.floor(gapSeconds) + 5, MAX_HEARTBEAT_SECONDS);

    const patch: Record<string, unknown> = {
      last_activity_at: now.toISOString(),
    };

    if (isStop) {
      patch.ended_at = now.toISOString();
    } else if (clampedDelta > 0) {
      patch.active_seconds = session.active_seconds + clampedDelta;
    }

    const { error: updateError } = await supabase
      .from("chat_study_sessions")
      .update(patch)
      .eq("id", sessionId);

    if (updateError) {
      console.error("[api/chat-study-sessions] update failed");
      return jsonError(500, "server_error");
    }

    return Response.json({ ok: true });
  } catch {
    console.error("[api/chat-study-sessions] crashed");
    return jsonError(500, "server_error");
  }
}
