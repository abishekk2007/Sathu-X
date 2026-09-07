import { z } from "zod";

import { parseDateOnly } from "@/lib/study-planner";
import type { StudyFlashcard } from "@/types";

/** A card is due when it was never reviewed or was last reviewed before the client's local midnight. */
export function flashcardIsDue(
  lastReviewedAt: string | null,
  todayIso: string
): boolean {
  if (lastReviewedAt === null) return true;
  return (
    new Date(lastReviewedAt).getTime() < parseDateOnly(todayIso).getTime()
  );
}

export const flashcardCreateSchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(5000),
  subjectId: z.string().uuid().nullable().optional(),
});

export const flashcardPatchSchema = z
  .object({
    question: z.string().trim().min(1).max(500).optional(),
    answer: z.string().trim().min(1).max(5000).optional(),
    subjectId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

export interface FlashcardDbRow {
  id: string;
  subject_id: string | null;
  question: string;
  answer: string;
  review_count: number;
  last_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  subject?: { name: string } | { name: string }[] | null;
}

export function serializeFlashcard(
  row: FlashcardDbRow,
  todayIso: string
): StudyFlashcard {
  const subjectRef = row.subject;
  const subjectName =
    subjectRef == null
      ? null
      : Array.isArray(subjectRef)
        ? (subjectRef[0]?.name ?? null)
        : subjectRef.name;
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName,
    question: row.question,
    answer: row.answer,
    reviewCount: Number(row.review_count ?? 0),
    lastReviewedAt: row.last_reviewed_at,
    isDue: flashcardIsDue(row.last_reviewed_at, todayIso),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}