// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: A–Z automated tests.
// Run with: npx tsx test-phase6g.ts
//
// Mocks only, no network / no Supabase / no Gemini. Covers:
//   TEST 1 — deterministic task intent matrix (+ guards vs image/doc/definition)
//   TEST 2 — deterministic plan intent matrix (+ guards)
//   TEST 3 — timezone-aware due resolution (relative/weekday/clock/DST/end-of-day)
//   TEST 4 — validation, status transitions and security fences
//   TEST 5 — deterministic plan engine (templates, order, dependencies)
//   TEST 6 — task store CRUD (RLS-scoped: no user_id ever written)
//   TEST 7 — plan + step store (dependency resolution, step status)
//   TEST 8 — chat handler end-to-end (create/list/complete/plan/honest failures)
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  detectTaskCommand,
  detectPlanCommand,
  _INTENT_HELPERS,
  resolveDuePhrase,
  nextRecurrenceDue,
  formatDueLabel,
  wallClockToInstant,
  validateTitle,
  validatePriority,
  validateRecurrence,
  validateTags,
  validateDueAt,
  validateStepCount,
  normalizeMetadata,
  isUuidLike,
  TASK_TRANSITIONS,
  canTransitionTask,
  canTransitionStep,
  assertTaskTransition,
  assertStepTransition,
  assertOwnIncoming,
  assertSafeTextField,
  assertSqlSafeBound,
  listTasks,
  getTask,
  countTasksByStatus,
  findTaskByTitle,
  createTask,
  updateTask,
  deleteTask,
  listPlanSteps,
  getPlanWithSteps,
  createPlan,
  addPlanStep,
  setStepStatus,
  buildTaskDigest,
  isTaskOverdue,
} from "./src/lib/tasks";
import { buildPlanDraft, draftToStepWrites } from "./src/lib/planning";
import { handleTaskCommand } from "./src/lib/tasks/chat-handler";
import { routeQuery } from "./src/lib/agent";
import type {
  $Plan,
  $PlanStep,
  $Task,
} from "./src/lib/tasks";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function assertEqual<T>(actual: T, expected: T, name: string) {
  const same =
    actual !== null && expected !== null &&
    typeof actual === "object" && typeof expected === "object"
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected;
  assert(
    same,
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function assertContains(haystack: string, needle: string, name: string) {
  assert(
    haystack.includes(needle),
    name,
    `expected "${needle}" in: ${haystack.slice(0, 240)}`
  );
}

function assertNotContains(haystack: string, needle: string, name: string) {
  assert(
    !haystack.includes(needle),
    name,
    `expected "${needle}" to be ABSENT from: ${haystack.slice(0, 240)}`
  );
}

function throws(call: () => unknown, name: string) {
  try {
    call();
    assert(false, name, "expected a throw, none happened");
  } catch {
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Mock Supabase (scriptable, recording, fail-open default)
// ---------------------------------------------------------------------------

type MockScript = { data: unknown; error?: unknown };

interface RecordedCall {
  table: string;
  method: "select" | "insert" | "update" | "delete";
  columns?: string;
  filters: Array<[string, unknown]>;
  body?: Record<string, unknown>;
}

function makeSupabaseMock(
  opts: { scripts?: Record<string, MockScript[]>; defaults?: Record<string, unknown> } = {}
) {
  const calls: RecordedCall[] = [];
  const scripts: Record<string, MockScript[]> = opts.scripts ?? {};
  const defaults: Record<string, unknown> = opts.defaults ?? { "*:select": [] };

  const take = (table: string, method: string) => {
    const script = scripts[`${table}:${method}`]?.shift();
    if (script !== undefined) {
      return { data: script.data, error: script.error ?? null };
    }
    return {
      data: defaults[`${table}:${method}`] ?? defaults["*:select"] ?? null,
      error: null,
    };
  };

  interface Sink {
    select(columns?: string): Sink;
    order(): Sink;
    limit(): Sink;
    eq(column: string, value: unknown): Sink;
    in(column: string, value: unknown): Sink;
    gte(column: string, value: unknown): Sink;
    lte(column: string, value: unknown): Sink;
    ilike(column: string, value: unknown): Sink;
    maybeSingle(): Sink;
    single(): Sink;
    update(body: Record<string, unknown>): Sink;
    insert(body: Record<string, unknown>): Sink;
    delete(): Sink;
    then(resolve: (value: unknown) => unknown): Promise<unknown>;
    _method: "select" | "insert" | "update" | "delete";
    _filters: Array<[string, unknown]>;
    _columns: string | undefined;
    _body: Record<string, unknown> | undefined;
  }

  const sink = (table: string): Sink => {
    const s: Sink = {
      _method: "select",
      _filters: [],
      _columns: undefined,
      _body: undefined,
      then(resolve: (value: unknown) => unknown) {
        calls.push({
          table,
          method: s._method,
          columns: s._columns,
          filters: s._filters,
          body: s._body,
        });
        return Promise.resolve(resolve(take(table, s._method)));
      },
      select(columns?: string) { s._columns = columns; return s; },
      order() { return s; },
      limit() { return s; },
      eq(column: string, value: unknown) { s._filters.push([column, value]); return s; },
      in(column: string, value: unknown) { s._filters.push([column, value]); return s; },
      gte(column: string, value: unknown) { s._filters.push([column, value]); return s; },
      lte(column: string, value: unknown) { s._filters.push([column, value]); return s; },
      ilike(column: string, value: unknown) { s._filters.push([column, value]); return s; },
      maybeSingle() { return s; },
      single() { return s; },
      update(body: Record<string, unknown>) { s._method = "update"; s._body = body; return s; },
      insert(body: Record<string, unknown>) { s._method = "insert"; s._body = body; return s; },
      delete() { s._method = "delete"; return s; },
    };
    return s;
  };

  return {
    supabase: { from: (table: string) => sink(table) } as unknown as SupabaseClient,
    calls,
  };
}

let seq = 0;
function taskFixture(partial: Partial<$Task> = {}): $Task {
  seq += 1;
  return {
    id: partial.id ?? `task-${seq}`,
    userId: "user-1",
    title: partial.title ?? `Task ${seq}`,
    description: partial.description ?? null,
    status: partial.status ?? "pending",
    priority: partial.priority ?? "medium",
    category: partial.category ?? "General",
    dueAt: partial.dueAt ?? null,
    completedAt: partial.completedAt ?? null,
    cancelledAt: partial.cancelledAt ?? null,
    recurrence: partial.recurrence ?? "none",
    tags: partial.tags ?? [],
    source: partial.source ?? "chat",
    planId: partial.planId ?? null,
    metadata: partial.metadata ?? {},
    createdAt: partial.createdAt ?? "2026-08-29T10:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-08-29T10:00:00.000Z",
  };
}

function taskRow(partial: Partial<$Task> = {}): Record<string, unknown> {
  const t = taskFixture(partial);
  return {
    id: t.id, user_id: t.userId, title: t.title, description: t.description,
    status: t.status, priority: t.priority, category: t.category, due_at: t.dueAt,
    completed_at: t.completedAt, cancelled_at: t.cancelledAt, recurrence: t.recurrence,
    tags: t.tags, source: t.source, plan_id: t.planId, metadata: t.metadata,
    created_at: t.createdAt, updated_at: t.updatedAt,
  };
}

function planFixture(partial: Partial<$Plan> = {}): $Plan {
  seq += 1;
  return {
    id: partial.id ?? `plan-${seq}`,
    userId: "user-1",
    title: partial.title ?? "Study plan",
    objective: partial.objective ?? "prepare for the exam",
    description: partial.description ?? null,
    status: partial.status ?? "active",
    dueAt: partial.dueAt ?? null,
    source: partial.source ?? "chat",
    createdAt: partial.createdAt ?? "2026-08-29T10:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-08-29T10:00:00.000Z",
  };
}

function planRow(partial: Partial<$Plan> = {}): Record<string, unknown> {
  const p = planFixture(partial);
  return {
    id: p.id, user_id: p.userId, title: p.title, objective: p.objective,
    description: p.description, status: p.status, due_at: p.dueAt, source: p.source,
    created_at: p.createdAt, updated_at: p.updatedAt,
  };
}

function stepFixture(partial: Partial<$PlanStep> = {}): $PlanStep {
  seq += 1;
  return {
    id: partial.id ?? `step-${seq}`,
    planId: partial.planId ?? "plan-1",
    userId: "user-1",
    title: partial.title ?? `Step ${seq}`,
    description: partial.description ?? null,
    position: partial.position ?? 1,
    status: partial.status ?? "pending",
    dependsOn: partial.dependsOn ?? [],
    taskId: partial.taskId ?? null,
    estimatedMinutes: partial.estimatedMinutes ?? 30,
    dueAt: partial.dueAt ?? null,
    completedAt: partial.completedAt ?? null,
    createdAt: partial.createdAt ?? "2026-08-29T10:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-08-29T10:00:00.000Z",
  };
}

function stepRow(partial: Partial<$PlanStep> = {}): Record<string, unknown> {
  const s = stepFixture(partial);
  return {
    id: s.id, plan_id: s.planId, user_id: s.userId, title: s.title,
    description: s.description, position: s.position, status: s.status,
    depends_on: s.dependsOn, task_id: s.taskId, estimated_minutes: s.estimatedMinutes,
    due_at: s.dueAt, completed_at: s.completedAt, created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

// ---------------------------------------------------------------------------

(async () => {
  // ===========================================================================
  // TEST 1 — TASK INTENT MATRIX
  // ===========================================================================
  console.log("\nTEST 1 — TASK INTENT MATRIX");
  {
    const cases: Array<[string, string]> = [
      ["remind me to call mom at 6pm", "TASK_CREATE"],
      ["remind me that I have a lab on Friday", "TASK_CREATE"],
      ["don't forget to water the plants", "TASK_CREATE"],
      ["add a task: finish physics notes", "TASK_CREATE"],
      ["please create a reminder to pay the bill", "TASK_CREATE"],
      ["set a task to revise unit 2", "TASK_CREATE"],
      ["show me my tasks", "TASK_LIST"],
      ["what's due today?", "TASK_LIST"],
      ["are there any tasks due?", "TASK_LIST"],
      ["complete the task read ch 3", "TASK_COMPLETE"],
      ["mark the reminder laundry as done", "TASK_COMPLETE"],
      ["cancel the reminder water the plants", "TASK_CANCEL"],
      ["delete the task old notes", "TASK_DELETE"],
      ["reschedule the task run to tomorrow at 6pm", "TASK_RESCHEDULE"],
      ["change the task call mom", "TASK_UPDATE"],
    ];
    for (const [message, expected] of cases) {
      assertEqual(detectTaskCommand(message).intent, expected, `task intent "${message}"`);
    }

    const guards: Array<[string, string]> = [
      ["generate an image of my gantt chart", "image verb"],
      ["create a picture of a study board", "image noun"],
      ["according to my PDF, complete the task list", "document ref"],
      ["read the file and make a reminder", "document word"],
      ["what is a task?", "definition frame"],
      ["what is a reminder", "definition frame"],
    ];
    for (const [message, note] of guards) {
      assertEqual(detectTaskCommand(message).intent, "TASK_NONE", `guard "${message}" (${note})`);
    }

    const ordinary: string[] = [
      "I have an exam tomorrow",
      "I should study more",
      "The dog ran away",
      "make dinner",
      "hello",
      "create",
      "remind me",
    ];
    for (const message of ordinary) {
      assertEqual(detectTaskCommand(message).intent, "TASK_NONE", `ordinary "${message}"`);
    }

    const create1 = detectTaskCommand("remind me to call mom at 6pm");
    assertEqual(create1.title, "call mom", "title strips lead-in");
    assertEqual(create1.rawDue, "6pm", "raw due captured");
    assertEqual(create1.priority, "medium", "default priority medium");

    const create2 = detectTaskCommand("set a high priority reminder to revise #physics for Friday");
    assertEqual(create2.priority, "high", "priority parsed");
    assert(create2.tags.includes("physics"), "hashtag parsed");
    assertEqual(create2.rawDue, "Friday", "due phrase split before connector");

    const resched = detectTaskCommand("reschedule the task run to tomorrow at 6pm");
    assertEqual(resched.target, "run", "reschedule target");
    assertEqual(resched.rescheduleTo, "tomorrow at 6pm", "reschedule To phrase");

    assertEqual(_INTENT_HELPERS.cleanTitle("  make  tea #study  "), "make tea", "cleanTitle collapses whitespace");
  }

  // ===========================================================================
  // TEST 2 — PLAN INTENT MATRIX
  // ===========================================================================
  console.log("\nTEST 2 — PLAN INTENT MATRIX");
  {
    const p1 = detectPlanCommand("create a study plan for my physics exam");
    assertEqual(p1.intent, "PLAN_CREATE", "create study plan for X");
    assertEqual(p1.objective, "my physics exam", "objective = for-phrase");
    assertEqual(p1.title, "Study plan for my physics exam", "title derived");

    const p2 = detectPlanCommand("make a 2-week revision plan for chemistry");
    assertEqual(p2.intent, "PLAN_CREATE", "make revision plan");
    assertEqual(p2.objective, "chemistry", "objective captured");

    const p3 = detectPlanCommand("plan my week");
    assertEqual(p3.intent, "PLAN_CREATE", "thematic plan my week");
    assertEqual(p3.objective, "plan week", "thematic objective");

    const p4 = detectPlanCommand("show me my plans");
    assertEqual(p4.intent, "PLAN_STATUS", "plan list");

    const p5 = detectPlanCommand("update my study plan");
    assertEqual(p5.intent, "PLAN_STATUS", "plan refinement surfaces status");

    const p6 = detectPlanCommand("draw an infographic of a study plan");
    assertEqual(p6.intent, "PLAN_NONE", "image guard");

    const p7 = detectPlanCommand("according to my PDF make a plan");
    assertEqual(p7.intent, "PLAN_NONE", "document guard");

    const p8 = detectPlanCommand("what is a study plan?");
    assertEqual(p8.intent, "PLAN_NONE", "definition guard");

    for (const msg of ["I have a physics exam", "I should write a plan soon", "hello"]) {
      assertEqual(detectPlanCommand(msg).intent, "PLAN_NONE", `plan ordinary "${msg}"`);
    }
  }

  // ===========================================================================
  // TEST 3 — TIMEZONE-AWARE DUE RESOLUTION
  // ===========================================================================
  console.log("\nTEST 3 — DUE RESOLUTION");
  {
    const now = new Date("2026-08-29T10:00:00.000Z");

    const tomorrow9 = resolveDuePhrase("tomorrow at 9am", { now, timezone: "Asia/Kolkata" });
    assertEqual(tomorrow9.dueAt, "2026-08-30T03:30:00.000Z", "tomorrow 9am IST -> true UTC (5:30 offset)");
    assert(tomorrow9.hasExactTime, "tomorrow 9am has exact time");

    const tomorrow = resolveDuePhrase("tomorrow", { now, timezone: "UTC" });
    assertEqual(tomorrow.dueAt, "2026-08-30T23:59:00.000Z", "bare tomorrow -> end of LOCAL day");

    const nextMon = resolveDuePhrase("next monday", { now, timezone: "UTC" });
    assertEqual(nextMon.dueAt, "2026-08-31T23:59:00.000Z", "next monday from Saturday");

    const rel3 = resolveDuePhrase("in 3 days", { now, timezone: "UTC" });
    assertEqual(rel3.dueAt, "2026-09-01T10:00:00.000Z", "in 3 days keeps wall instant");

    const un = resolveDuePhrase("whenever", { now, timezone: "UTC" });
    assertEqual(un.dueAt, null, "unresolvable -> dueAt null (never guessed)");
    assertEqual(un.hasExactTime, false, "unresolvable hasExactTime false");

    const bad = resolveDuePhrase("tomorrow at 9am", { now, timezone: "Not/AZone" });
    assert(bad.dueAt !== null, "invalid zone falls back to the default zone, still resolves");

    const fallBack = wallClockToInstant("America/New_York", 2026, 11, 1, 1, 30);
    assertEqual(new Date(fallBack).toISOString(), "2026-11-01T05:30:00.000Z", "DST fall-back resolves deterministically");

    const summer = wallClockToInstant("America/New_York", 2026, 7, 15, 12, 0);
    assertEqual(new Date(summer).toISOString(), "2026-07-15T16:00:00.000Z", "summer EDT offset -4h");
    const winter = wallClockToInstant("America/New_York", 2026, 1, 15, 12, 0);
    assertEqual(new Date(winter).toISOString(), "2026-01-15T17:00:00.000Z", "winter EST offset -5h");

    const base = "2026-08-29T10:00:00.000Z";
    const after = Date.parse(base);
    assertEqual(nextRecurrenceDue("none", base, after), null, "none never recurs");
    assertEqual(nextRecurrenceDue("daily", base, after), "2026-08-30T10:00:00.000Z", "daily next");
    assertEqual(nextRecurrenceDue("weekly", base, after), "2026-09-05T10:00:00.000Z", "weekly next");
    assertEqual(nextRecurrenceDue("monthly", base, after), "2026-09-28T10:00:00.000Z", "monthly next (30d)");

    const label = formatDueLabel("2026-08-30T03:30:00.000Z", "Asia/Kolkata");
    assertContains(label, "9:00", "due label renders local 9:00");
    assertEqual(formatDueLabel(null, "UTC"), "", "null due -> empty label");

    assert(isTaskOverdue(taskFixture({ dueAt: "2020-01-01T00:00:00.000Z" }), new Date()), "old pending is overdue");
    assert(!isTaskOverdue(taskFixture({ status: "completed", dueAt: "2020-01-01T00:00:00.000Z" }), new Date()), "completed never overdue");
    assert(!isTaskOverdue(taskFixture({ dueAt: null }), new Date()), "no due never overdue");
  }

  // ===========================================================================
  // TEST 4 — VALIDATION, TRANSITIONS AND SECURITY
  // ===========================================================================
  console.log("\nTEST 4 — VALIDATION + SECURITY");
  {
    assertEqual(validateTitle("  read ch 3  "), "read ch 3", "title trimmed");
    throws(() => validateTitle(""), "empty title throws");
    throws(() => validateTitle("x".repeat(201)), "title over 200 throws");
    assertEqual(validatePriority("HIGH"), "high", "priority normalized lowercase");
    throws(() => validatePriority("extreme"), "bad priority throws");
    assertEqual(validateRecurrence("daily"), "daily", "recurrence daily ok");
    throws(() => validateRecurrence("yearly"), "bad recurrence throws");
    assertEqual(validateTags([" Study ", "study", "physics", 5]), ["study", "physics"], "tags deduped and types filtered");
    const nineTags = Array.from({ length: 9 }, (_, i) => `tag${i}`);
    assertEqual(validateTags(nineTags).length, 8, "tags capped at 8");
    assertEqual(validateDueAt("2026-08-30T03:30:00.000Z"), "2026-08-30T03:30:00.000Z", "valid due ISO normalized");
    throws(() => validateDueAt("9999-01-01T00:00:00.000Z"), "year 9999 throws");
    throws(() => validateDueAt("garbage"), "bad date throws");
    throws(() => validateStepCount(0), "0 steps throws");
    throws(() => validateStepCount(9), "9 steps throws");
    assert(validateStepCount(3) === undefined, "3 steps ok");

    const meta = normalizeMetadata({
      note: "hello",
      count: 3,
      flag: true,
      deep: { a: { b: { c: { d: "too deep" } } } },
      arr8: [1, 2, 3, 4, 5, 6, 7, 8],
      arr9: Array.from({ length: 9 }, (_, i) => i),
      long: "x".repeat(401),
    });
    assertEqual(meta.note, "hello", "string kept");
    assertEqual(meta.count, 3, "number kept");
    assertEqual(meta.flag, true, "boolean kept");
    assertEqual((meta.arr8 as unknown[]).length, 8, "small array kept");
    assertEqual(meta.arr9, undefined, "array over 8 dropped entirely");
    assertEqual(meta.long, undefined, "string over 400 skipped");
    assertEqual(meta.deep, undefined, "depth 4 dropped entirely");

    assertEqual(canTransitionTask("pending", "completed"), true, "pending -> completed");
    assertEqual(canTransitionTask("completed", "cancelled"), false, "completed -> cancelled denied");
    assertEqual(canTransitionTask("cancelled", "pending"), true, "cancelled -> pending reopens");
    assertEqual(canTransitionTask("completed", "completed"), true, "same status is a no-op");
    assertEqual(canTransitionStep("completed", "pending"), true, "step completed -> pending");
    assertEqual(canTransitionStep("pending", "failed" as never), false, "steps have no failed state");
    assertEqual(TASK_TRANSITIONS.pending.length, 4, "pending leaves 4 ways");
    assert(assertTaskTransition("pending", "in_progress") === "in_progress", "assertTaskTransition ok");
    throws(() => assertTaskTransition("completed", "cancelled"), "assertTaskTransition invalid throws");
    throws(() => assertStepTransition("pending", "failed" as never), "assertStepTransition invalid throws");

    assertEqual(
      assertOwnIncoming("user-1", { userId: "user-1" } as { userId: string }, "update task").userId,
      "user-1",
      "owned row passes"
    );
    throws(() => assertOwnIncoming("user-1", { userId: "user-2" } as { userId: string }, "update task"), "foreign row throws");

    assertEqual(assertSafeTextField("safe text", "title"), "safe text", "plain text ok");
    throws(() => assertSafeTextField("bad\u0007text", "title"), "BEL control char throws");
    const bounded = assertSqlSafeBound("x".repeat(2000), "q", 200);
    assertEqual(bounded.length, 200, "sql bound truncates to max");
    throws(() => assertSqlSafeBound(42, "q", 200), "non-string bound throws");
    assert(isUuidLike("123e4567-e89b-12d3-a456-426614174000"), "uuid-like accepted");
    assert(!isUuidLike("task-1"), "plain id rejected");
  }

  // ===========================================================================
  // TEST 5 — DETERMINISTIC PLAN ENGINE
  // ===========================================================================
  console.log("\nTEST 5 — PLAN ENGINE");
  {
    const exam = buildPlanDraft("prepare for my physics exam on Friday", {
      daysUntilExam: 5,
      weakTopics: ["atomic structure", "waves"],
      examName: "Midterm (Physics)",
    });
    assertEqual(exam.title, "Exam preparation", "exam template title");
    assert(exam.steps.length >= 4 && exam.steps.length <= 8, "step count in bounds");
    assertEqual(exam.steps[0].dependsOn, [], "first step has no dependencies");
    assertEqual(exam.steps[1].dependsOn, ["step-1"], "second step depends on first");
    for (const [index, step] of exam.steps.entries()) {
      assertEqual(step.order, index + 1, `step ${index + 1} order sequential`);
      assert(step.estimateMinutes > 0, "every step has a positive estimate");
    }
    assert(exam.reasoning.length >= 2, "reasoning recorded");
    assertContains(exam.reasoning[1], "never", "never claims completion");
    assertContains(exam.reasoning[1], "pending", "steps start pending");

    const subject = buildPlanDraft("learn physics");
    assertEqual(subject.title, "Subject mastery plan", "subject template");
    assertEqual(subject.steps.length, 5, "subject has 5 steps");

    const pres = buildPlanDraft("build slides for my pitch");
    assertEqual(pres.title, "Presentation preparation", "presentation template");
    assertEqual(pres.steps.length, 5, "presentation has 5 steps");

    const fitness = buildPlanDraft("train for a 10k");
    assertEqual(fitness.title, "Fitness preparation", "fitness template");
    assertEqual(fitness.steps.length, 4, "fitness has 4 steps");

    const trip = buildPlanDraft("trip to goa");
    assertEqual(trip.title, "Trip planning", "trip template");
    assertEqual(trip.steps.length, 4, "trip has 4 steps");

    const generic = buildPlanDraft("get better at chess");
    assertEqual(generic.title, "Structured plan", "generic default");
    assertEqual(generic.steps.length, 4, "default has 4 steps");

    const writes = draftToStepWrites(exam);
    assertEqual(writes.length, exam.steps.length, "one write per step");
    for (const [index, write] of writes.entries()) {
      assertEqual(write.position, index + 1, `write ${index + 1} position`);
      for (const dep of write.dependsOnPositions ?? []) {
        assert(dep > 0 && dep <= writes.length, "dependency points to a real sibling");
        assert(dep !== index + 1, "no self dependency");
      }
    }
    const seen = new Set<string>();
    for (const write of writes) {
      assert(!seen.has(write.title), "no duplicate step titles");
      seen.add(write.title);
    }
  }

  // ===========================================================================
  // TEST 6 — TASK STORE (mocked DB, RLS-scoped)
  // ===========================================================================
  console.log("\nTEST 6 — TASK STORE");
  {
    // createTask: insertion never carries user_id; status forced pending.
    {
      const row = taskRow({ id: "t1", title: "call mom", dueAt: "2026-08-30T03:30:00.000Z", priority: "high" });
      const mock = makeSupabaseMock({ scripts: { "tasks:insert": [{ data: row }] } });
      const created = await createTask(mock.supabase, {
        title: "call mom",
        priority: "high",
        dueAt: "2026-08-30T03:30:00.000Z",
        recurrence: "weekly",
        tags: ["family"],
        category: "Personal",
        source: "chat",
      });
      assert(created !== null, "createTask returns row");
      if (created) {
        assertEqual(created.title, "call mom", "created title");
        assertEqual(created.status, "pending", "created status pending");
        assertEqual(created.priority, "high", "created priority");
      }
      const insertCall = mock.calls.find((c) => c.method === "insert");
      assert(insertCall?.body !== undefined, "insert recorded");
      assert(insertCall?.body?.user_id === undefined, "NO user_id ever written on insert");
      assertEqual(insertCall?.body?.status, "pending", "status forced pending on insert");
    }

    // listTasks: filters compose; overdue is applied read-side.
    {
      const rows = [taskRow({ id: "t1", title: "old", dueAt: "2020-01-01T00:00:00.000Z", status: "pending" })];
      const mock = makeSupabaseMock({
        scripts: { "tasks:select": [{ data: rows }] },
        defaults: { "*:select": [] },
      });
      const overdue = await listTasks(mock.supabase, { status: "pending", overdue: true, search: "old", limit: 10 });
      assertEqual(overdue.length, 1, "overdue filter keeps old pending tasks");
      const selectCall = mock.calls.find((c) => c.method === "select");
      assert(selectCall !== undefined && selectCall.filters.some(([col]) => col === "status"), "status eq fired");
      assert(selectCall !== undefined && selectCall.filters.some(([col]) => col === "title"), "search ilike fired");

      const none = await listTasks(mock.supabase, { overdue: true, limit: 10 });
      assertEqual(none.length, 0, "overdue filter drops future tasks");
    }

    // getTask: uuid gate protects the query; missing row -> null.
    {
      const mock = makeSupabaseMock();
      const bad = await getTask(mock.supabase, "not-a-uuid");
      assertEqual(bad, null, "getTask non-uuid -> null with NO db call");
      assertEqual(mock.calls.length, 0, "no db call for malformed id");
    }

    // updateTask: transition-aware; completed -> cancelled rejected.
    {
      const T2_ID = "123e4567-e89b-12d3-a456-426614174000";
      const current = taskRow({ id: T2_ID, title: "run", status: "completed" });
      const mock = makeSupabaseMock({
        scripts: {
          "tasks:select": [{ data: current }, { data: null }],
          "tasks:update": [{ data: taskRow({ id: T2_ID, title: "run", status: "completed", cancelledAt: null }) }],
        },
      });
      const same = await updateTask(mock.supabase, T2_ID, { priority: "low" });
      assertEqual(same?.status, "completed", "valid same-status edit kept");
      const cancelled = await updateTask(mock.supabase, T2_ID, { status: "cancelled" });
      assertEqual(cancelled, null, "completed -> cancelled rejected (returns null)");
    }

    // deleteTask: uuid gate.
    {
      const mock = makeSupabaseMock({ scripts: { "tasks:delete": [{ data: [] }] } });
      assertEqual(await deleteTask(mock.supabase, "nope"), false, "delete non-uuid false");
      assertEqual(await deleteTask(mock.supabase, "123e4567-e89b-12d3-a456-426614174000"), true, "delete uuid ok");
    }

    // findTaskByTitle: exact -> startsWith -> includes; completed/cancelled excluded from fuzzy.
    {
      const rows = [
        taskRow({ id: "a", title: "run" }),
        taskRow({ id: "b", title: "run 5k", status: "completed" }),
        taskRow({ id: "c", title: "morning run 5k" }),
        taskRow({ id: "d", title: "old task", status: "cancelled" }),
      ];
      const mock = makeSupabaseMock({
        defaults: { "tasks:select": rows, "*:select": [] },
      });
      const exact = await findTaskByTitle(mock.supabase, "run");
      assertEqual(exact?.id, "a", "exact match wins");
      const fuzzy = await findTaskByTitle(mock.supabase, "morning");
      assertEqual(fuzzy?.id, "c", "includes match works");
      const oldExact = await findTaskByTitle(mock.supabase, "old task");
      assertEqual(oldExact?.id, "d", "exact match still targets the titled row");
    }

    // countTasksByStatus + digest.
    {
      const rows = [
        taskRow({ id: "a", title: "due soon", status: "pending", dueAt: "2026-08-30T00:00:00.000Z" }),
        taskRow({ id: "b", title: "done today", status: "completed", completedAt: "2026-08-29T09:00:00.000Z" }),
        taskRow({ id: "c", title: "done yesterday", status: "completed", completedAt: "2026-08-28T09:00:00.000Z" }),
      ];
      const mock = makeSupabaseMock({ scripts: { "tasks:select": [{ data: rows }, { data: rows }] } });
      const counts = await countTasksByStatus(mock.supabase);
      assertEqual(counts.pending, 1, "count pending");
      assertEqual(counts.completed, 2, "count completed");
      const digest = await buildTaskDigest(mock.supabase, new Date("2026-08-29T10:00:00.000Z"));
      assertEqual(digest.totalOpen, 1, "digest total open");
      assertEqual(digest.completedToday, 1, "digest completed today");
      assertEqual(digest.overdue.length, 0, "digest no overdue");
    }
  }

  // ===========================================================================
  // TEST 7 — PLAN + STEP STORE (mocked DB)
  // ===========================================================================
  console.log("\nTEST 7 — PLAN + STEP STORE");
  {
    // createPlan: plan + steps inserted, dependencies resolved to REAL ids.
    {
      const plan = planRow({ id: "plan-1", title: "Study plan", objective: "my physics exam" });
      const steps = [
        stepRow({ id: "s1", planId: "plan-1", title: "Assessment pass", position: 1 }),
        stepRow({ id: "s2", planId: "plan-1", title: "Build notes", position: 2, dependsOn: [] }),
      ];
      const writes: Array<{ title: string; position: number; dependsOnPositions: number[]; dependsOn?: string[] }> = [
        { title: "Assessment pass", position: 1, dependsOnPositions: [] },
        { title: "Build notes", position: 2, dependsOnPositions: [1] },
      ];
      const mock = makeSupabaseMock({
        scripts: {
          "plans:insert": [{ data: plan }],
          "plan_steps:insert": [{ data: steps }],
          "plan_steps:update": [{ data: null }],
        },
      });
      const created = await createPlan(
        mock.supabase,
        { title: "Study plan", objective: "my physics exam", source: "chat" },
        writes as never
      );
      assert(created !== null, "createPlan returns result");
      if (created) {
        assertEqual(created.plan.id, "plan-1", "plan mapped");
        assertEqual(created.plan.status, "active", "plan starts active");
        assertEqual(created.steps.length, 2, "steps returned");
        const s2 = created.steps.find((s) => s.id === "s2");
        const depUpdate = mock.calls.find((c) => c.table === "plan_steps" && c.method === "update");
        assertEqual(s2?.dependsOn, [], "returned step deps still empty (refs were position-based)");
        assertEqual(depUpdate?.body?.depends_on, ["s1"], "dependency update resolves position 1 -> real id s1");
        for (const step of created.steps) assertEqual(step.status, "pending", "every step starts pending");
      }
      const planInsert = mock.calls.find((c) => c.table === "plans" && c.method === "insert");
      assert(planInsert?.body?.user_id === undefined, "plan insert never writes user_id");
      assert(created !== null, "plan+steps created together");
    }

    // addPlanStep + setStepStatus (transition-aware).
    {
      const mock = makeSupabaseMock({
        scripts: {
          "plan_steps:insert": [{ data: stepRow({ id: "s9", planId: "plan-1", title: "Drill", position: 2 }) }],
        },
      });
      const added = await addPlanStep(mock.supabase, "plan-1", { title: "Drill", position: 2 });
      assertEqual(added?.status, "pending", "added step pending");
      const addedInsert = mock.calls.find((c) => c.table === "plan_steps" && c.method === "insert");
      assertEqual(addedInsert?.body?.plan_id, "plan-1", "step bound to plan");

      const transitionMock = makeSupabaseMock({
        scripts: {
          "plan_steps:select": [{ data: stepRow({ id: "s10", planId: "plan-1", title: "Drill", position: 2, status: "pending" }) }],
          "plan_steps:update": [{ data: stepRow({ id: "s10", planId: "plan-1", title: "Drill", position: 2, status: "completed", completedAt: "2026-08-29T10:00:00.000Z" }) }],
        },
      });
      const done = await setStepStatus(transitionMock.supabase, "s10", "completed");
      assertEqual(done?.status, "completed", "step completed");

      const invalidMock = makeSupabaseMock({
        scripts: { "plan_steps:select": [{ data: stepRow({ id: "s10", status: "completed" }) }] },
      });
      const invalid = await setStepStatus(invalidMock.supabase, "s10", "cancelled");
      assertEqual(invalid, null, "step completed -> cancelled rejected");
    }

    // getPlanWithSteps composes plan + steps.
    {
      const PLAN9_ID = "123e4567-e89b-12d3-a456-426614174001";
      const mock = makeSupabaseMock({
        scripts: {
          "plans:select": [{ data: planRow({ id: PLAN9_ID, title: "P" }) }],
          "plan_steps:select": [{ data: [stepRow({ id: "p1", planId: PLAN9_ID, position: 1 })] }],
        },
      });
      const detail = await getPlanWithSteps(mock.supabase, PLAN9_ID);
      assert(detail?.plan.id === PLAN9_ID && detail?.steps.length === 1, "getPlanWithSteps composes");
    }

    // listPlanSteps rejects nothing but returns rows in position order.
    {
      const mock = makeSupabaseMock({
        scripts: { "plan_steps:select": [{ data: [stepRow({ id: "x", position: 2 }), stepRow({ id: "y", position: 1 })] }] },
      });
      const steps = await listPlanSteps(mock.supabase, "plan-1");
      assertEqual(steps.length, 2, "both steps returned");
    }
  }

  // ===========================================================================
  // TEST 8 — CHAT HANDLER END-TO-END (mocked DB)
  // ===========================================================================
  console.log("\nTEST 8 — CHAT HANDLER");
  {
    // CREATE success: intent -> store -> honest reply.
    {
      const createdRow = taskRow({ id: "t1", title: "call mom", priority: "high", dueAt: "2026-08-29T12:30:00.000Z", recurrence: "none" });
      const mock = makeSupabaseMock({ scripts: { "tasks:insert": [{ data: createdRow }] } });
      const reply = await handleTaskCommand({
        supabase: mock.supabase,
        taskIntent: detectTaskCommand("remind me to call mom at 6pm"),
        message: "remind me to call mom at 6pm",
        timezone: "Asia/Kolkata",
      });
      assertContains(reply, "Task created:", "create reply header");
      assertContains(reply, "call mom", "create reply title");
      assertContains(reply, "Status: pending", "create reply status");
    }

    // CREATE without a resolvable due -> honest "no due date".
    {
      const createdRow = taskRow({ id: "t2", title: "stretch", dueAt: null });
      const mock = makeSupabaseMock({ scripts: { "tasks:insert": [{ data: createdRow }] } });
      const reply = await handleTaskCommand({
        supabase: mock.supabase,
        taskIntent: detectTaskCommand("remind me to stretch"),
        message: "remind me to stretch",
        timezone: "Asia/Kolkata",
      });
      assertContains(reply, "no due date", "no-due honesty");
    }

    // CREATE failure: never claims success.
    {
      const mock = makeSupabaseMock({
        scripts: { "tasks:insert": [{ data: null, error: new Error("boom") }] },
      });
      const reply = await handleTaskCommand({
        supabase: mock.supabase,
        taskIntent: detectTaskCommand("remind me to pay the bill"),
        message: "remind me to pay the bill",
      });
      assertContains(reply, "couldn't create", "failed create is honest");
      assertNotContains(reply, "created:", "failed create never says created");
    }

    // LIST empty + list with data.
    {
      const emptyMock = makeSupabaseMock();
      const empty = await handleTaskCommand({
        supabase: emptyMock.supabase,
        taskIntent: detectTaskCommand("show me my tasks"),
        message: "show me my tasks",
        timezone: "UTC",
      });
      assertContains(empty, "no open tasks", "empty list reply");

      const todayUtc = new Date().toISOString().slice(0, 10);
      const rows = [
        taskRow({ id: "a", title: "revise unit 2", status: "pending", dueAt: "2026-09-01T10:00:00.000Z", priority: "high" }),
        taskRow({ id: "b", title: "done", status: "completed", completedAt: `${todayUtc}T09:00:00.000Z` }),
      ];
      const dataMock = makeSupabaseMock({ scripts: { "tasks:select": [{ data: rows }, { data: rows }] } });
      const list = await handleTaskCommand({
        supabase: dataMock.supabase,
        taskIntent: detectTaskCommand("show me my tasks"),
        message: "show me my tasks",
        timezone: "UTC",
      });
      assertContains(list, "Open tasks (1):", "list reply header");
      assertContains(list, "revise unit 2", "list reply includes title");
      assertContains(list, "Completed today: 1", "list reply includes today's completion");
    }

    // COMPLETE: find by title -> transition -> reply.
    {
      const A_ID = "123e4567-e89b-12d3-a456-426614174000";
      const current = taskRow({ id: A_ID, title: "revise unit 2", status: "pending", dueAt: "2026-09-01T10:00:00.000Z" });
      const updated = taskRow({ id: A_ID, title: "revise unit 2", status: "completed", dueAt: "2026-09-01T10:00:00.000Z", completedAt: "2026-08-29T11:00:00.000Z" });
      const mock = makeSupabaseMock({
        scripts: {
          "tasks:select": [{ data: [current] }, { data: current }],
          "tasks:update": [{ data: updated }],
        },
      });
      const reply = await handleTaskCommand({
        supabase: mock.supabase,
        taskIntent: detectTaskCommand("complete the task revise unit 2"),
        message: "complete the task revise unit 2",
        timezone: "UTC",
      });
      assertContains(reply, "Done:", "complete reply");
      assertContains(reply, "revise unit 2", "complete reply title");
      assertContains(reply, "no push notification exists", "NO_PUSH_NOTE honesty");
    }

    // COMPLETE not found: never fabricates a completion.
    {
      const mock = makeSupabaseMock(); // tasks:select -> []
      const reply = await handleTaskCommand({
        supabase: mock.supabase,
        taskIntent: detectTaskCommand("complete the task ghost"),
        message: "complete the task ghost",
      });
      assertContains(reply, "couldn't find a task", "not-found reply");
      assertNotContains(reply, "completed", "not-found never claims completion");
    }

    // PLAN create end-to-end: context (fail-open) + template + persist.
    {
      const plan = planRow({ id: "plan-1", title: "Exam preparation", objective: "my physics exam" });
      const steps = [1, 2, 3, 4, 5].map((i) =>
        stepRow({ id: `step-${i}`, planId: "plan-1", title: `Step ${i}`, position: i, dependsOn: i > 1 ? [`step-${i - 1}`] : [] })
      );
      const mock = makeSupabaseMock({
        scripts: {
          "plans:insert": [{ data: plan }],
          "plan_steps:insert": [{ data: steps }],
        },
      });
      const reply = await handleTaskCommand({
        supabase: mock.supabase,
        planIntent: detectPlanCommand("create a study plan for my physics exam"),
        message: "create a study plan for my physics exam",
        timezone: "Asia/Kolkata",
      });
      assertContains(reply, "Plan created:", "plan reply header");
      assertContains(reply, "Exam preparation", "plan reply title");
      assertContains(reply, "All steps start pending", "plan never claims done");
      assertContains(reply, "1. Step 1", "plan lists steps");
      assertContains(reply, "[after step", "plan shows dependencies");
    }

    // Router 6b: task + plan language -> the 6G routes, real-time stays out.
    {
      const d = routeQuery({
        userId: "test-user",
        message: "remind me to water the plants at 9pm",
        hasSources: false,
      });
      assertEqual(d.primaryRoute, "TASK_MANAGEMENT", "router: create reminder -> TASK_MANAGEMENT");
      assertEqual(d.taskIntent?.intent, "TASK_CREATE", "router: taskIntent attached");
      assert(!d.requiresRealtime, "router: task command never hits real-time");
      assert(!d.requiresGeneralReasoning, "router: task command never hits Gemini");

      const d2 = routeQuery({
        userId: "test-user",
        message: "what's due today?",
        hasSources: false,
      });
      assertEqual(d2.primaryRoute, "TASK_QUERY", "router: due question -> TASK_QUERY");

      const d3 = routeQuery({
        userId: "test-user",
        message: "create a study plan for my physics exam",
        hasSources: false,
      });
      assertEqual(d3.primaryRoute, "PLAN_GENERATION", "router: plan create -> PLAN_GENERATION");
      assertEqual(d3.planIntent?.intent, "PLAN_CREATE", "router: planIntent attached");
    }
  }

  console.log("\n============================================================");
  console.log(`Phase 6G tests: ${passed} passed, ${failed} failed`);
  console.log("============================================================");
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();