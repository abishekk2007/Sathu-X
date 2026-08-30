// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: deterministic plan engine.
//
// Turns a short objective ("my physics exam on Friday", "train for a 10k",
// "prepare a presentation") into an ordered, dependency-aware set of steps.
// It is PURE and deterministic — no LLM, no network — so creating a plan is
// always fast, explainable and repeatable. It deliberately NEVER claims a
// step is done: every generated step starts `pending`, and only the user (via
// a task/tracking command) marks work complete.
//
// Reuses the Phase 4C study-planner vocabulary (weak topics first, spaced
// passes, buffer before the exam) so 6G's planner speaks the same language as
// the existing /planner feature — there is no second, competing methodology.
// ---------------------------------------------------------------------------

import {
  PLAN_MAX_STEPS,
} from "@/lib/tasks/types";
import type { PlanStepWrite } from "@/lib/tasks/types";

export interface PlanDraftStep {
  title: string;
  description: string;
  estimateMinutes: number;
  dependsOn: string[]; // "step-0" style references → converted to positions later
  order: number;
}

export interface PlanDraft {
  title: string;
  objective: string;
  steps: PlanDraftStep[];
  reasoning: string[];
}

export interface PlanSourceContext {
  /** Topical knowledge signals from student-intelligence (weak topics first). */
  weakTopics?: string[];
  strongTopics?: string[];
  examName?: string | null;
  daysUntilExam?: number | null;
}

// ---------------------------------------------------------------------------
// Domain templates — deterministic, bounded, honest (all statuses start pending)
// ---------------------------------------------------------------------------

interface Template {
  match: RegExp;
  title: string;
  steps: (ctx: PlanSourceContext) => PlanDraftStep[];
}

function examSteps(ctx: PlanSourceContext, subject: string, examLabel: string): PlanDraftStep[] {
  const focus = subject.trim() || "the subject";
  const depth = ctx.daysUntilExam == null ? 1 : ctx.daysUntilExam < 3 ? 3 : ctx.daysUntilExam < 7 ? 2 : 1;
  const base: PlanDraftStep[] = [
    {
      order: 1,
      title: `Assessment pass for ${examLabel}`,
      description: `Skim ${focus} and list the topics you are weakest on — those get studied first.`,
      estimateMinutes: 25,
      dependsOn: [],
    },
    {
      order: 2,
      title: "Build condensed notes",
      description: `One-page-per-topic notes, formulas and key definitions for ${focus}.`,
      estimateMinutes: 60,
      dependsOn: ["step-1"],
    },
    {
      order: 3,
      title: "Spaced practice problems",
      description: `Work problems from the weak topics first, then the strong ones; repeat every 1–2 days.`,
      estimateMinutes: 45,
      dependsOn: ["step-2"],
    },
    {
      order: 4,
      title: "Progress check",
      description: "Answer a few questions without notes and mark what still needs review.",
      estimateMinutes: 30,
      dependsOn: ["step-3"],
    },
  ];
  if (depth < 3) {
    base.push({
      order: 5,
      title: "Final review + buffer",
      description: `Light revision of ${focus} the day before ${examLabel}; nothing new on exam day.`,
      estimateMinutes: 30,
      dependsOn: ["step-4"],
    });
  }
  return base.slice(0, PLAN_MAX_STEPS);
}

const TEMPLATES: Template[] = [
  {
    match: /\b(?:exam|test|quiz|paper|final|midterm|board|assessment)\b/i,
    title: "Exam preparation",
    steps: (ctx) => {
      const examName = ctx.examName ?? "the upcoming exam";
      const subject = ctx.weakTopics?.[0] ?? "";
      void subject;
      return examSteps(ctx, ctx.weakTopics?.join(", ") ?? "the syllabus", examName);
    },
  },
  {
    match: /\b(?:physics|chemistry|maths?|mathematics|biology|science)\b/i,
    title: "Subject mastery plan",
    steps: (ctx) => {
      const subject = ctx.weakTopics?.[0] ?? "the topic";
      return [
        { order: 1, title: `Map ${subject} fundamentals`, description: "List the core concepts and the order they build on each other.", estimateMinutes: 30, dependsOn: [] },
        { order: 2, title: "Learn theory in weak-topic-first order", description: "Tackle the weakest areas explicitly — never skip the shaky foundations.", estimateMinutes: 45, dependsOn: ["step-1"] },
        { order: 3, title: "Guided practice", description: "Solve problems in increasing difficulty, checking against notes.", estimateMinutes: 45, dependsOn: ["step-2"] },
        { order: 4, title: "Solo retrieval drill", description: "Redo problems without notes and score your recall honestly.", estimateMinutes: 30, dependsOn: ["step-3"] },
        { order: 5, title: "Spaced re-pass (2–3 days later)", description: "Return to the weak areas for a lighter second pass before moving on.", estimateMinutes: 25, dependsOn: ["step-4"] },
      ];
    },
  },
  {
    match: /\b(?:presentation|talk|speech|slide|pitch)\b/i,
    title: "Presentation preparation",
    steps: () => [
      { order: 1, title: "Define the audience and takeaway", description: "One sentence: what should the audience remember?", estimateMinutes: 15, dependsOn: [] },
      { order: 2, title: "Outline the story", description: "Problem → evidence → solution, 3–5 sections.", estimateMinutes: 30, dependsOn: ["step-1"] },
      { order: 3, title: "Draft the slides", description: "One idea per slide, notes in the speaker panel.", estimateMinutes: 60, dependsOn: ["step-2"] },
      { order: 4, title: "Rehearse aloud", description: "Time it, cut the filler, mark weak transitions.", estimateMinutes: 30, dependsOn: ["step-3"] },
      { order: 5, title: "Final run + backup plan", description: "Dry-run with a timer and prepare for a Q&A.", estimateMinutes: 25, dependsOn: ["step-4"] },
    ],
  },
  {
    match: /\b(?:fitness|workout|run|marathon|10k|5k|gym|training|exercise|weight)\b/i,
    title: "Fitness preparation",
    steps: () => [
      { order: 1, title: "Set a measurable baseline", description: "Pick a realistic target (distance, weight, frequency) for the plan horizon.", estimateMinutes: 15, dependsOn: [] },
      { order: 2, title: "Build the weekly schedule", description: "3–4 sessions/week with rest days; progression of +10% per week maximum.", estimateMinutes: 30, dependsOn: ["step-1"] },
      { order: 3, title: "Pre-training fundamentals", description: "Warm-up routine, hydration and sleep targets that make consistency possible.", estimateMinutes: 20, dependsOn: ["step-2"] },
      { order: 4, title: "First checkpoint", description: "After 1 week, measure against baseline and adjust the plan honestly.", estimateMinutes: 20, dependsOn: ["step-3"] },
    ],
  },
  {
    match: /\b(?:trip|travel|visit|tour|holiday|vacation|journey)\b/i,
    title: "Trip planning",
    steps: () => [
      { order: 1, title: "Decide dates and budget scope", description: "Fixed dates, rough budget bands and non-negotiables.", estimateMinutes: 20, dependsOn: [] },
      { order: 2, title: "Book transport and stay", description: "Lock the backbone (flights/train + accommodation) first.", estimateMinutes: 45, dependsOn: ["step-1"] },
      { order: 3, title: "Draft the day-by-day itinerary", description: "2–3 anchor activities per day with buffers for travel time.", estimateMinutes: 40, dependsOn: ["step-2"] },
      { order: 4, title: "Pre-departure essentials", description: "Documents, bookings confirmation file, packing list and offline maps.", estimateMinutes: 25, dependsOn: ["step-3"] },
    ],
  },
];

const DEFAULT_STEPS: PlanDraftStep[] = [
  { order: 1, title: "Clarify the goal", description: "Write the objective as one measurable sentence.", estimateMinutes: 15, dependsOn: [] },
  { order: 2, title: "Break the objective into milestones", description: "2–4 checkpoints that clearly define 'done enough to move on'.", estimateMinutes: 30, dependsOn: ["step-1"] },
  { order: 3, title: "Schedule time blocks", description: "Book the milestone work into the calendar in your timezone.", estimateMinutes: 30, dependsOn: ["step-2"] },
  { order: 4, title: "First execution pass", description: "Do the first milestone, then return and adjust the plan honestly.", estimateMinutes: 60, dependsOn: ["step-3"] },
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Builds a deterministic plan draft for an objective. Never claims completion
 * (every step starts pending) and never performs any external side effect.
 */
export function buildPlanDraft(
  objective: string,
  context: PlanSourceContext = {}
): PlanDraft {
  const cleanObjective = String(objective ?? "").trim() || "general preparation";
  const template = TEMPLATES.find((t) => t.match.test(cleanObjective)) ?? null;

  let steps: PlanDraftStep[];
  let title: string;
  if (template) {
    steps = template.steps(context);
    title = template.title;
  } else {
    steps = DEFAULT_STEPS.map((s) => ({ ...s }));
    title = "Structured plan";
  }

  const reasoning = [
    `Templates are deterministic: ${template ? "keyword match on the objective" : "generic goal breakdown"} (no LLM involved).`,
    "All steps start pending — the plan proposes and never claims any step is done; execution is tracked separately and honestly.",
    template && context.examName
      ? `Part of the plan is anchored to "${context.examName}".`
      : "No exam anchor found — steps stay generic until you add more context.",
  ];

  return {
    title,
    objective: cleanObjective,
    steps: steps.slice(0, PLAN_MAX_STEPS).map((s, index) => ({ ...s, order: index + 1 })),
    reasoning,
  };
}

/** Converts a draft into store payloads (dependencies as 1-based positions). */
export function draftToStepWrites(draft: PlanDraft): PlanStepWrite[] {
  return draft.steps.map((s, index) => ({
    title: s.title,
    description: s.description,
    position: index + 1,
    dependsOnPositions: s.dependsOn
      .map((ref) => Number(ref.replace(/^step-/, "")) + 1)
      .filter((p) => p > 0 && p <= draft.steps.length && p !== index + 1),
    estimatedMinutes: s.estimateMinutes,
    dueAt: null,
  }));
}