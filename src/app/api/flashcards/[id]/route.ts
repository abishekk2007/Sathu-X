import { verifySubjectReference } from "@/lib/exam-helpers";
import {
  flashcardPatchSchema,
  serializeFlashcard,
  type FlashcardDbRow,
} from "@/lib/flashcards";
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

  const parsed = flashcardPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const { question, answer, subjectId } = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();

    if (!(await verifySubjectReference(supabase, subjectId))) {
      return jsonError(404, "not_found");
    }

    // Whitelist mapping — id/user_id/review_count/created_at are never client-writable.
    const updates: Record<string, unknown> = {};
    if (question !== undefined) updates.question = question;
    if (answer !== undefined) updates.answer = answer;
    if (subjectId !== undefined) updates.subject_id = subjectId;

    const { data, error } = await supabase
      .from("flashcards")
      .update(updates)
      .eq("id", id)
      .select(FLASHCARD_SELECT)
      .single();

    if (error || !data) {
      console.error("[api/flashcards/:id] PATCH found no owned row");
      return jsonError(404, "not_found");
    }
    return Response.json({
      flashcard: serializeFlashcard(data as unknown as FlashcardDbRow, toDateOnly(new Date())),
    });
  } catch {
    console.error("[api/flashcards/:id] PATCH crashed");
    return jsonError(500, "server_error");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("flashcards")
      .delete()
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("[api/flashcards/:id] DELETE failed");
      return jsonError(500, "server_error");
    }
    if (!data || data.length === 0) return jsonError(404, "not_found");
    return Response.json({ deleted: data.length });
  } catch {
    console.error("[api/flashcards/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}