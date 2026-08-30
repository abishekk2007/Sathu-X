// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: context adapter.
//
// Feeds the deterministic planner with REAL owned context the user has already
// given the app — upcoming exams, weak topics from practice — so a plan is
// built around the user's actual situation instead of a generic template.
// Reuses the existing Phase 4C planner context and Phase 4B student
// intelligence reads; nothing here is new data or new machinery.
//
// Fail-open: any read failure yields an empty context, and the planner still
// produces a structured plan.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchPlannerChatContext } from "@/lib/study-planner";
import { fetchChatAcademicContext } from "@/lib/student-intelligence";

import type { PlanSourceContext } from "./planner";

export interface PlannerContextOptions {
  todayIso: string;
  selection?: { subjectId?: string; topicId?: string } | undefined;
}

/**
 * Loads owned academic context (bounded, parallel, fail-open) and reduces it
 * to the fields the planner template engine actually consumes.
 */
export async function fetchPlannerContextForTasks(
  supabase: SupabaseClient,
  options: PlannerContextOptions
): Promise<PlanSourceContext> {
  try {
    const [planner, academic] = await Promise.all([
      fetchPlannerChatContext(supabase, options.todayIso),
      fetchChatAcademicContext(supabase, options.selection),
    ]);

    const nextExam = planner.exams[0] ?? null;
    return {
      weakTopics: academic.weakTopics.slice(0, 5).map((t) => t.name),
      strongTopics: academic.strongTopics.slice(0, 3).map((t) => t.name),
      examName: nextExam ? `${nextExam.title}${nextExam.subjectName ? ` (${nextExam.subjectName})` : ""}` : null,
      daysUntilExam: nextExam ? nextExam.daysLeft : null,
    };
  } catch {
    return {};
  }
}