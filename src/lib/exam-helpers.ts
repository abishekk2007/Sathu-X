import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ExamRecord, ExamStatus, ExamType } from "@/types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const examTypeSchema = z.enum([
  "semester",
  "internal",
  "unit_test",
  "practical",
  "assignment",
  "other",
]);

/** Accepts an ISO instant or a date-only string; date-only becomes local noon. */
const examDateSchema = z
  .string()
  .min(10)
  .max(40)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "invalid_date",
  });

export const examCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  examDate: examDateSchema,
  subjectId: z.string().uuid().nullable().optional(),
  examType: examTypeSchema.optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  targetScore: z.number().int().min(0).max(100).nullable().optional(),
  priority: z.number().int().min(1).max(5).optional(),
});

export const examPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    examDate: examDateSchema.optional(),
    subjectId: z.string().uuid().nullable().optional(),
    examType: examTypeSchema.optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    targetScore: z.number().int().min(0).max(100).nullable().optional(),
    priority: z.number().int().min(1).max(5).optional(),
    status: z
      .enum(["upcoming", "in_progress", "completed", "cancelled"])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

interface ExamDbRow {
  id: string;
  subject_id: string | null;
  title: string;
  exam_date: string;
  exam_type: string;
  description: string | null;
  target_score: number | null;
  priority: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export function serializeExamRow(row: ExamDbRow): ExamRecord {
  return {
    id: row.id,
    subjectId: row.subject_id,
    title: row.title,
    examDate: row.exam_date,
    examType: row.exam_type as ExamType,
    description: row.description,
    targetScore: row.target_score,
    priority: row.priority,
    status: row.status as ExamStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toExamTimestamp(value: string): string {
  // Date-only input ("2027-01-25") gets a local-noon time so the calendar day
  // is preserved regardless of the server timezone offset.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T12:00:00`;
  return new Date(value).toISOString();
}

/**
 * Verifies an optional subject reference belongs to the caller. RLS makes a
 * foreign id indistinguishable from a missing one → both yield not_found.
 */
export async function verifySubjectReference(
  supabase: SupabaseClient,
  subjectId: string | null | undefined
): Promise<boolean> {
  if (subjectId === null || subjectId === undefined) return true;
  if (!UUID_PATTERN.test(subjectId)) return false;
  const { data } = await supabase
    .from("subjects")
    .select("id")
    .eq("id", subjectId)
    .limit(1);
  return Boolean(data && data.length > 0);
}
