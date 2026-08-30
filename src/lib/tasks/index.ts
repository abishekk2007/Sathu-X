// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: public surface.
//
// The chat route, API routes and UI layers import ONLY from this barrel —
// everything is grouped into one stable, testable module. No user_id is ever
// accepted or written here; ownership derives from the session (auth.uid()).
// ---------------------------------------------------------------------------

export * from "./types";
export { detectTaskCommand, detectPlanCommand, _INTENT_HELPERS } from "./intent";
export {
  resolveDuePhrase,
  nextRecurrenceDue,
  formatDueLabel,
  wallClockToInstant,
  type DueResolution,
} from "./schedule";
export {
  UUID_PATTERN,
  ValidationError,
  validateTitle,
  validateTaskDescription,
  validatePriority,
  validateRecurrence,
  validateTags,
  validateCategory,
  validateDueAt,
  validatePlanObjective,
  validateStepCount,
  normalizeMetadata,
  isUuidLike,
} from "./validation";
export {
  TASK_TRANSITIONS,
  STEP_TRANSITIONS,
  canTransitionTask,
  canTransitionStep,
  assertTaskTransition,
  assertStepTransition,
  assertOwnIncoming,
  assertSafeTextField,
  assertSqlSafeBound,
} from "./security";

export {
  listTasks,
  getTask,
  countTasksByStatus,
  findTaskByTitle,
  createTask,
  setTaskStatus,
  completeTask,
  cancelTask,
  updateTask,
  rescheduleTask,
  deleteTask,
  listPlans,
  getPlan,
  getPlanWithSteps,
  listPlanSteps,
  createPlan,
  updatePlan,
  deletePlan,
  addPlanStep,
  setStepStatus,
  buildTaskDigest,
  type TaskListFilter,
  type TaskCountFilter,
  type TaskDigest,
} from "./store";