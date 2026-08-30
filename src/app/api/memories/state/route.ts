import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import { isMemoryEnabled, setMemoryMode } from "@/lib/memory";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const stateSchema = z.object({ enabled: z.boolean() });

/**
 * Phase 6F — per-user memory master switch. Reads and writes the authenticated
 * user's own profiles.memory_enabled via the RLS-scoped server client.
 */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  try {
    const supabase = await getSupabaseServerClient();
    const enabled = await isMemoryEnabled(supabase);
    return Response.json({ enabled });
  } catch {
    console.error("[api/memories/state] GET crashed");
    return jsonError(500, "server_error");
  }
}

export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const parsed = stateSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");

  try {
    const supabase = await getSupabaseServerClient();
    const ok = await setMemoryMode(supabase, parsed.data.enabled);
    if (!ok) return jsonError(500, "server_error");
    return Response.json({ enabled: parsed.data.enabled });
  } catch {
    console.error("[api/memories/state] PATCH crashed");
    return jsonError(500, "server_error");
  }
}