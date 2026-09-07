import { z } from "zod";

import { verifySubjectReference } from "@/lib/exam-helpers";
import {
  flashcardCreateSchema,
  serializeFlashcard,
  type FlashcardDbRow,
} from "@/lib/flashcards";
import { toDateOnly } from "@/lib/study-planner";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const querySchema = z.object({
  /** Client's local date so "due today" matches the user's calendar. */
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date")
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const FLASHCARD_SELECT =
  "id, subject_id, question, answer, review_count, last_reviewed_at, " +
  "created_at, updated_at, subject:subjects(name)";

function serializeRows(
  rows: FlashcardDbRow[],
  todayIso: string
): ReturnType<typeof serializeFlashcard>[] {
  return rows.map((row) => serializeFlashcard(row, todayIso));
}

export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    today: url.searchParams.get("today") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return jsonError(400, "invalid_request");

  const todayIso = parsed.data.today ?? toDateOnly(new Date());
  const limit = parsed.data.limit ?? 200;

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("flashcards")
      .select(FLASHCARD_SELECT)
      .order("last_reviewed_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[api/flashcards] GET failed");
      return jsonError(500, "server_error");
    }

    const rows = (data ?? []) as unknown as FlashcardDbRow[];
    const flashcards = serializeRows(rows, todayIso);
    return Response.json({
      flashcards,
      total: flashcards.length,
      due: flashcards.filter((card) => card.isDue).length,
    });
  } catch {
    console.error("[api/flashcards] GET crashed");
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

  const parsed = flashcardCreateSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const { question, answer, subjectId } = parsed.data;

  try {
    const supabase = await getSupabaseServerClient();
    if (!(await verifySubjectReference(supabase, subjectId))) {
      return jsonError(404, "not_found");
    }

    // user_id is never accepted from the client — RLS + auth.uid() scope rows.
    const { data, error } = await supabase
      .from("flashcards")
      .insert({
        question,
        answer,
        ...(subjectId !== null && subjectId !== undefined
          ? { subject_id: subjectId }
          : {}),
      })
      .select(FLASHCARD_SELECT)
      .single();

    if (error || !data) {
      console.error("[api/flashcards] Insert rejected");
      return jsonError(500, "server_error");
    }
    return Response.json(
      { flashcard: serializeFlashcard(data as unknown as FlashcardDbRow, toDateOnly(new Date())) },
      { status: 201 }
    );
  } catch {
    console.error("[api/flashcards] POST crashed");
    return jsonError(500, "server_error");
  }
}