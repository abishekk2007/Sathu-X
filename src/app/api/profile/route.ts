import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

/**
 * Dev-safe database failure log: PostgREST code/message only (schema and
 * policy info — never secrets, tokens, or personal data).
 */
function logDbError(scope: string, error: { code?: string; message?: string } | null) {
  const code = error?.code ?? "unknown";
  const message = (error?.message ?? "").slice(0, 200);
  console.error(`[api/profile] ${scope} failed: ${code} ${message}`);
}

const patchSchema = z.object({
  fullName: z.string().trim().min(1).max(80).optional(),
  bio: z.string().trim().max(500).optional(),
  college: z.string().trim().max(120).optional(),
  course: z.string().trim().max(120).optional(),
  year: z.string().trim().max(40).optional(),
  preferredMode: z.enum(["general", "student", "assistant"]).optional(),
  // Phase 4B academic context — all optional.
  department: z.string().trim().max(80).optional(),
  semester: z.string().trim().max(40).optional(),
  academicGoal: z.string().trim().max(200).optional(),
  learningStyle: z.string().trim().max(120).optional(),
  preferredLanguage: z.string().trim().max(40).optional(),
  targetScore: z.string().trim().max(40).optional(),
});

/**
 * Loads the caller's own profile row. If the row is missing (e.g. the user
 * existed before the signup trigger), seeds it from session metadata —
 * mirroring handle_new_user() — instead of failing.
 */
async function ensureProfileRow(supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>, user: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}) {
  const existing = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (existing.error) {
    logDbError("ensureProfileRow/select", existing.error);
  }
  if (existing.data) return existing.data;

  const meta = user.user_metadata ?? {};
  const fullName =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    user.email?.split("@")[0] ||
    null;
  const avatarUrl =
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    null;

  const seeded = await supabase
    .from("profiles")
    .upsert({ id: user.id, full_name: fullName, avatar_url: avatarUrl, email: user.email ?? null })
    .select("*")
    .single();
  if (seeded.error) {
    logDbError("ensureProfileRow/upsert", seeded.error);
    return null;
  }
  return seeded.data;
}

function serializeProfile(
  row: Record<string, unknown>,
  authEmail: string | null
) {
  return {
    // Auth owns the email; profile copy is only a cached display value.
    email: authEmail,
    fullName: row.full_name ?? null,
    avatarUrl: row.avatar_url ?? null,
    bio: row.bio ?? null,
    college: row.college ?? null,
    course: row.course ?? null,
    year: row.year ?? null,
    preferredMode:
      row.preferred_mode === "student" || row.preferred_mode === "assistant"
        ? row.preferred_mode
        : "general",
    department: row.department ?? null,
    semester: row.semester ?? null,
    academicGoal: row.academic_goal ?? null,
    learningStyle: row.learning_style ?? null,
    preferredLanguage: row.preferred_language ?? null,
    targetScore: row.target_score ?? null,
  };
}

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  try {
    const supabase = await getSupabaseServerClient();
    const row = await ensureProfileRow(supabase, user);
    if (!row) return jsonError(500, "server_error");
    return Response.json({ profile: serializeProfile(row, user.email ?? null) });
  } catch {
    console.error("[api/profile] GET failed");
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return jsonError(400, "invalid_request");
  }

  // Whitelist mapping — id/user_id/created_at/email are never client-writable.
  const updates: Record<string, string> = {};
  if (parsed.data.fullName !== undefined) updates.full_name = parsed.data.fullName;
  if (parsed.data.bio !== undefined) updates.bio = parsed.data.bio;
  if (parsed.data.college !== undefined) updates.college = parsed.data.college;
  if (parsed.data.course !== undefined) updates.course = parsed.data.course;
  if (parsed.data.year !== undefined) updates.year = parsed.data.year;
  if (parsed.data.preferredMode !== undefined)
    updates.preferred_mode = parsed.data.preferredMode;
  if (parsed.data.department !== undefined)
    updates.department = parsed.data.department;
  if (parsed.data.semester !== undefined)
    updates.semester = parsed.data.semester;
  if (parsed.data.academicGoal !== undefined)
    updates.academic_goal = parsed.data.academicGoal;
  if (parsed.data.learningStyle !== undefined)
    updates.learning_style = parsed.data.learningStyle;
  if (parsed.data.preferredLanguage !== undefined)
    updates.preferred_language = parsed.data.preferredLanguage;
  if (parsed.data.targetScore !== undefined)
    updates.target_score = parsed.data.targetScore;

  try {
    const supabase = await getSupabaseServerClient();
    await ensureProfileRow(supabase, user);

    const { data, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", user.id)
      .select("*")
      .single();

    if (error || !data) {
      logDbError("PATCH/update", error);
      return jsonError(500, "server_error");
    }
    return Response.json({ profile: serializeProfile(data, user.email ?? null) });
  } catch {
    console.error("[api/profile] PATCH failed");
    return jsonError(500, "server_error");
  }
}
