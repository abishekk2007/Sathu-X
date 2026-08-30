// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: planning engine barrel.
//
// The chat route uses this to turn a PLAN_CREATE intent into a persisted,
// multi-step plan. Deterministic and side-effect free of its own — only the
// store performs writes.
// ---------------------------------------------------------------------------

export { buildPlanDraft, draftToStepWrites, type PlanDraft, type PlanDraftStep, type PlanSourceContext } from "./planner";
export { fetchPlannerContextForTasks } from "./context";