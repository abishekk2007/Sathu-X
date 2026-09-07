import { serializeFlashcard, type FlashcardDbRow } from "@/lib/flashcards";
import { toDateOnly } from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FLASHCARD_SELECT =
  "id, subject_id, question, answer, review_count, last_reviewed_at, " +
  "created_at, updated_at, subject:subjects(name)";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/flashcards/:id/review — marks an owned card as reviewed now
 * (review_count + 1, last_reviewed_at = now). RLS scopes the row to the
 * caller; a missing or foreign card behaves as not_found.
 */
export async function POST(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();

    const { data: found, error: readError } = await supabase
      .from("flashcards")
      .select("id, review_count")
      .eq("id", id)
      .maybeSingle();
    if (readError) {
      console.error("[api/flashcards/:id/review] read failed");
      return jsonError(500, "server_error");
    }
    if (!found) return jsonError(404, "not_found");

    const { data, error } = await supabase
      .from("flashcards")
      .update({
        review_count: Number(found.review_count ?? 0) + 1,
        last_reviewed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select(FLASHCARD_SELECT)
      .single();

    if (error || !data) {
      console.error("[api/flashcards/:id/review] update failed");
      return jsonError(500, "server_error");
    }
    return Response.json({
      flashcard: serializeFlashcard(data as unknown as FlashcardDbRow, toDateOnly(new Date())),
    });
  } catch {
    console.error("[api/flashcards/:id/review] crashed");
    return jsonError(500, "server_error");
  }
}