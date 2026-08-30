// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: security, isolation and safe-operations tests.
// Run with: npx tsx test-phase6g-security.ts
//
// Mocks only, no network. Focuses on what the main 6G suite touches lightly:
//   TEST 1 — transition matrix security (task + step; failed-state semantics)
//   TEST 2 — ownership by construction (no user_id ever written; foreign rows
//            throw at the fence; RLS owns the rest)
//   TEST 3 — injection + payload fences (control chars, length caps, whitelists,
//            metadata budget)
//   TEST 4 — uuid gates + honest DB failure (no query on malformed ids; DB
//            failure → null/[]/false, never a fake success)
//   TEST 5 — authz boundary (RSL-scoped reads hide rows → fail-open null)
//   TEST 6 — chat honesty + resilience under failure
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createTask,
  updateTask,
  deleteTask,
  createPlan,
  addPlanStep,
  setStepStatus,
  listTasks,
  listPlans,
  buildTaskDigest,
  getPlan,
  getTask,
  deletePlan,
  validateTitle,
  validateDueAt,
  validatePriority,
  validateRecurrence,
  validateTags,
  validateCategory,
  validateStepCount,
  normalizeMetadata,
  assertOwnIncoming,
  assertSafeTextField,
  assertSqlSafeBound,
  assertTaskTransition,
  assertStepTransition,
  canTransitionTask,
  canTransitionStep,
  STEP_TRANSITIONS,
  TASK_TRANSITIONS,
  resolveDuePhrase,
  nextRecurrenceDue,
} from "./src/lib/tasks";
import { handleTaskCommand } from "./src/lib/tasks/chat-handler";
import { detectTaskCommand, detectPlanCommand } from "./src/lib/tasks";
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
    `expected "${needle}" ABSENT from: ${haystack.slice(0, 240)}`
  );
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
function taskRow(partial: Partial<$Task> = {}): Record<string, unknown> {
  seq += 1;
  const t: $Task = {
    id: partial.id ?? `task-${seq}`,
    userId: partial.userId ?? "user-1",
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
  return {
    id: t.id, user_id: t.userId, title: t.title, description: t.description,
    status: t.status, priority: t.priority, category: t.category, due_at: t.dueAt,
    completed_at: t.completedAt, cancelled_at: t.cancelledAt, recurrence: t.recurrence,
    tags: t.tags, source: t.source, plan_id: t.planId, metadata: t.metadata,
    created_at: t.createdAt, updated_at: t.updatedAt,
  };
}

function planRow(partial: Partial<$Plan> = {}): Record<string, unknown> {
  seq += 1;
  const p: $Plan = {
    id: partial.id ?? `plan-${seq}`,
    userId: partial.userId ?? "user-1",
    title: partial.title ?? "Study plan",
    objective: partial.objective ?? "prepare for the exam",
    description: partial.description ?? null,
    status: partial.status ?? "active",
    dueAt: partial.dueAt ?? null,
    source: partial.source ?? "chat",
    createdAt: partial.createdAt ?? "2026-08-29T10:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-08-29T10:00:00.000Z",
  };
  return {
    id: p.id, user_id: p.userId, title: p.title, objective: p.objective,
    description: p.description, status: p.status, due_at: p.dueAt, source: p.source,
    created_at: p.createdAt, updated_at: p.updatedAt,
  };
}

function stepRow(partial: Partial<$PlanStep> = {}): Record<string, unknown> {
  seq += 1;
  const s: $PlanStep = {
    id: partial.id ?? `step-${seq}`,
    planId: partial.planId ?? "plan-1",
    userId: partial.userId ?? "user-1",
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
  return {
    id: s.id, plan_id: s.planId, user_id: s.userId, title: s.title,
    description: s.description, position: s.position, status: s.status,
    depends_on: s.dependsOn, task_id: s.taskId, estimated_minutes: s.estimatedMinutes,
    due_at: s.dueAt, completed_at: s.completedAt, created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

/** True when any recorded call carried a client-supplied user_id or filter. */
function referencesUserId(calls: RecordedCall[]): boolean {
  for (const call of calls) {
    if (call.body && "user_id" in call.body) return true;
    if (call.filters.some(([column]) => column === "user_id")) return true;
  }
  return false;
}

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

(async () => {
  // ===========================================================================
  // TEST 1 — TRANSITION MATRIX (task + step)
  // ===========================================================================
  console.log("\nTEST 1 — TRANSITION MATRIX");
  {
    assertEqual(canTransitionTask("pending", "in_progress"), true, "pending -> in_progress");
    assertEqual(canTransitionTask("pending", "completed"), true, "pending -> completed");
    assertEqual(canTransitionTask("pending", "cancelled"), true, "pending -> cancelled");
    assertEqual(canTransitionTask("pending", "failed"), true, "pending -> failed (system only)");
    assertEqual(canTransitionTask("in_progress", "completed"), true, "in_progress -> completed");
    assertEqual(canTransitionTask("completed", "pending"), true, "completed -> pending reopens");
    assertEqual(canTransitionTask("cancelled", "pending"), true, "cancelled -> pending reopens");
    assertEqual(canTransitionTask("failed", "pending"), true, "failed -> pending retry");

    assertEqual(canTransitionTask("completed", "cancelled"), false, "completed -> cancelled denied");
    assertEqual(canTransitionTask("cancelled", "completed"), false, "cancelled -> completed denied");
    assertEqual(canTransitionTask("cancelled", "failed"), false, "cancelled -> failed denied");
    assertEqual(canTransitionTask("completed", "in_progress"), false, "completed -> in_progress denied");
    assertEqual(canTransitionTask("pending", "pending"), true, "same status is a no-op");
    assertEqual(canTransitionTask("failed", "failed"), true, "same status is a no-op");
    assertEqual(TASK_TRANSITIONS.pending.length, 4, "pending leaves 4 ways");
    assertEqual(TASK_TRANSITIONS.completed.length, 1, "terminal completed opens only to pending");

    assert(assertTaskTransition("pending", "in_progress") === "in_progress", "assertTaskTransition ok");
    assert(assertTaskTransition("pending", "pending") === "pending", "assertTaskTransition no-op ok");
    throws(() => assertTaskTransition("completed", "cancelled"), "assertTaskTransition denies completed->cancelled");
    throws(() => assertTaskTransition("cancelled", "completed"), "assertTaskTransition denies cancelled->completed");

    // Steps: 4 states, NO failed state anywhere.
    assertEqual(STEP_TRANSITIONS.pending.length, 3, "step pending leaves 3 ways");
    assertEqual(canTransitionStep("pending", "completed"), true, "step pending -> completed");
    assertEqual(canTransitionStep("completed", "pending"), true, "step completed -> pending");
    assertEqual(canTransitionStep("completed", "cancelled"), false, "step completed -> cancelled denied");
    assertEqual(canTransitionStep("pending", "failed" as never), false, "steps have no failed state");
    throws(() => assertStepTransition("pending", "failed" as never), "assertStepTransition rejects failed");
    throws(() => assertStepTransition("completed", "cancelled"), "assertStepTransition denies completed->cancelled");
  }

  // ===========================================================================
  // TEST 2 — OWNERSHIP BY CONSTRUCTION
  // ===========================================================================
  console.log("\nTEST 2 — OWNERSHIP BY CONSTRUCTION");
  {
    const owned = { userId: "user-1" };
    const foreign = { userId: "user-2" };
    assert(assertOwnIncoming("user-1", owned, "update task").userId === "user-1", "owned row passes");
    throws(() => assertOwnIncoming("user-1", foreign, "update task"), "foreign row throws");
    throws(() => assertOwnIncoming("user-1", { userId: "" }, "update task"), "empty owner throws");

    // No user_id ever written — inserts carry only RLS-owned content.
    const taskMock = makeSupabaseMock({
      scripts: { "tasks:insert": [{ data: taskRow({ id: "t1", title: "call mom" }) }] },
    });
    await createTask(taskMock.supabase, {
      title: "call mom", priority: "high", dueAt: "2026-08-30T03:30:00.000Z",
      recurrence: "weekly", tags: ["family"], category: "Personal", source: "chat",
    });
    const taskInsert = taskMock.calls.find((c) => c.method === "insert");
    assert(taskInsert?.body?.user_id === undefined, "task insert never writes user_id");
    assert(taskInsert?.body?.status === "pending", "status is server-forced pending");

    const planMock = makeSupabaseMock({
      scripts: {
        "plans:insert": [{ data: planRow({ id: "plan-1", objective: "my physics exam" }) }],
        "plan_steps:insert": [{ data: [stepRow({ id: "s1", planId: "plan-1", position: 1 })] }],
      },
    });
    await createPlan(
      planMock.supabase,
      { title: "Exam prep", objective: "my physics exam", source: "chat" },
      [{ title: "Assessment pass", position: 1, dependsOnPositions: [] }]
    );
    assert(!referencesUserId(planMock.calls), "plan+step inserts never write user_id");

    // A step may only link to owned tasks: non-uuid taskId is dropped to null.
    const stepMock = makeSupabaseMock({
      scripts: { "plan_steps:select": [{ data: [] }], "plan_steps:insert": [{ data: stepRow({ id: "s9", planId: "plan-1", position: 2 }) }] },
    });
    const added = await addPlanStep(stepMock.supabase, "plan-1", {
      title: "Drill", position: 2, taskId: "not-a-uuid",
    });
    const stepInsert = stepMock.calls.find((c) => c.method === "insert");
    assert(added?.taskId === null, "bad task link becomes null");
    assert(stepInsert?.body?.task_id === null, "task_id gated by uuid at the store");
    assert(stepInsert?.body?.user_id === undefined, "add step never writes user_id");

    // Updates carry only whitelisted patch fields.
    const updMock = makeSupabaseMock({
      scripts: {
        "tasks:select": [{ data: taskRow({ id: "u", title: "x", status: "in_progress" }) }],
        "tasks:update": [{ data: taskRow({ id: "u", title: "x", status: "completed" }) }],
      },
    });
    await updateTask(updMock.supabase, "u", { status: "completed", title: "y" } as never);
    const updCall = updMock.calls.find((c) => c.method === "update");
    assert(updCall?.body?.user_id === undefined, "update never writes user_id");
    const extra = Object.keys(updCall?.body ?? {}).filter((k) => ![
      "title", "description", "priority", "category", "due_at", "recurrence",
      "tags", "metadata", "status", "completed_at", "cancelled_at",
    ].includes(k));
    assertEqual(extra.length, 0, "update body contains only known columns");

    const delMock = makeSupabaseMock({ scripts: { "tasks:delete": [{ data: [] }] } });
    await deleteTask(delMock.supabase, "123e4567-e89b-12d3-a456-426614174000");
    assert(!referencesUserId(delMock.calls), "delete filters only by id (RLS owns identity)");

    const stepTransitionMock = makeSupabaseMock({
      scripts: {
        "plan_steps:select": [{ data: stepRow({ id: "s10", status: "pending" }) }],
        "plan_steps:update": [{ data: stepRow({ id: "s10", status: "completed" }) }],
      },
    });
    await setStepStatus(stepTransitionMock.supabase, "s10", "completed");
    assert(!referencesUserId(stepTransitionMock.calls), "step status update never writes user_id");
  }

  // ===========================================================================
  // TEST 3 — INJECTION + PAYLOAD FENCES
  // ===========================================================================
  console.log("\nTEST 3 — INJECTION + PAYLOAD FENCES");
  {
    assertEqual(assertSafeTextField("safe text", "title"), "safe text", "plain text ok");
    throws(() => assertSafeTextField("bad\u0007text", "title"), "BEL control char throws");
    throws(() => assertSafeTextField("line\u0000feed", "objective"), "NUL control char throws");
    throws(() => assertSafeTextField("tab\there\u001fsep", "title"), "unit-separator control throws");

    const bounded = assertSqlSafeBound(`x`.repeat(500), "title", 200);
    assertEqual(bounded.length, 200, "sql-bound truncates to the column cap");
    throws(() => assertSqlSafeBound(12345, "title", 200), "sql-bound rejects non-strings");

    throws(() => validateTitle(""), "empty title throws");
    throws(() => validateTitle("x".repeat(201)), "over-limit title throws");
    assertEqual(validateTitle("  call mom  "), "call mom", "title trims");
    assertEqual(validateTitle("x".repeat(200)).length, 200, "exactly-limit title passes");

    throws(() => validateDueAt("not-a-date"), "garbage due throws");
    throws(() => validateDueAt("1999-01-01T00:00:00.000Z"), "year <2000 throws");
    throws(() => validateDueAt("2300-01-01T00:00:00.000Z"), "year >2200 throws");
    assertEqual(validateDueAt(null), null, "null due is fine");
    assertEqual(validateDueAt("2026-08-30T03:30:00.000Z"), "2026-08-30T03:30:00.000Z", "iso due passes");

    throws(() => validatePriority("urgent"), "bad priority throws");
    assertEqual(validatePriority("HIGH"), "high", "priority lowercased");
    assertEqual(validatePriority(undefined), "medium", "missing priority defaults medium");
    throws(() => validateRecurrence("never"), "bad recurrence throws");
    assertEqual(validateRecurrence("Weekly"), "weekly", "recurrence lowercased");
    assertEqual(validateRecurrence(undefined), "none", "missing recurrence defaults none");

    assertEqual(validateTags(["  Study ", "study", "physics"]) as string[], ["study", "physics"], "tags dedupe+trim");
    assertEqual(validateTags(["a", "b", "c", "d", "e", "f", "g", "h", "i"]).length, 8, "tags capped at 8");
    assertEqual(validateTags(["ok", 5, null, "x".repeat(31)]), ["ok"], "non-strings and over-limit dropped");
    assertEqual(validateTags([1, 2]), [], "non-string array yields empty tags");
    throws(() => validateTags("not-an-array"), "tag non-array throws");
    assertEqual(validateCategory("x".repeat(51)), "General", "over-limit category falls back");
    assertEqual(validateCategory("School"), "School", "category passes");
    throws(() => validateStepCount(0), "zero steps throws");
    throws(() => validateStepCount(9), "9 steps throws (cap 8)");
    validateStepCount(4);
    assert(true, "4 steps ok");

    // Metadata budget: deep nesting, oversized arrays and blobs are dropped.
    assertEqual(normalizeMetadata({ ok: "yes" }), { ok: "yes" }, "plain metadata kept");
    assertEqual(normalizeMetadata({ arr: [1, 2, 3] }), { arr: [1, 2, 3] }, "small arrays kept");
    assertEqual(normalizeMetadata({ arr9: [1, 2, 3, 4, 5, 6, 7, 8, 9] }), {}, "array >8 dropped entirely");
    assertEqual(
      normalizeMetadata({ bad: { deep: { deeper: { deepest: { x: 1 } } } } }),
      {},
      "depth >3 dropped entirely"
    );
    assertEqual(normalizeMetadata({ long: "x".repeat(401) }), {}, "string >400 dropped");
    assertEqual(normalizeMetadata("scalar", 0, 16), {}, "non-object dropped");
  }

  // ===========================================================================
  // TEST 4 — UUID GATES + HONEST DB FAILURE
  // ===========================================================================
  console.log("\nTEST 4 — UUID GATES + HONEST DB FAILURE");
  {
    const gate = makeSupabaseMock();
    assertEqual(await getTask(gate.supabase, "t1"), null, "getTask non-uuid -> null");
    assertEqual(await updateTask(gate.supabase, "t1", { priority: "high" }), null, "updateTask non-uuid -> null");
    assertEqual(await deleteTask(gate.supabase, "nope"), false, "deleteTask non-uuid -> false");
    assertEqual(await getPlan(gate.supabase, "plan-1"), null, "getPlan non-uuid -> null");
    assertEqual(await deletePlan(gate.supabase, "plan-1"), false, "deletePlan non-uuid -> false");
    assertEqual(gate.calls.length, 0, "malformed ids never reach the DB");

    const failInsert = makeSupabaseMock({
      scripts: { "tasks:insert": [{ data: null, error: { message: "check violation" } }] },
    });
    const none = await createTask(failInsert.supabase, { title: "call mom" });
    assertEqual(none, null, "insert violation -> null, never a fake row");

    const outage = makeSupabaseMock({
      scripts: { "tasks:select": [{ data: null, error: { message: "outage" } }] },
    });
    const listed = await listTasks(outage.supabase, { limit: 10 });
    assert(Array.isArray(listed) && listed.length === 0, "list tasks degrades to [] on outage");
    const plansOutage = makeSupabaseMock({
      scripts: { "plans:select": [{ data: null, error: { message: "outage" } }] },
    });
    assertEqual((await listPlans(plansOutage.supabase)).length, 0, "list plans degrades to []");
    const digest = await buildTaskDigest(outage.supabase);
    assert(
      Array.isArray(digest.dueSoon) && digest.completedToday === 0 && digest.totalOpen === 0,
      "digest never throws on outage — honest zeros"
    );

    // Rule CHECK violations surface the same way through the honest chat reply.
    const forced = makeSupabaseMock({
      scripts: { "tasks:insert": [{ data: null, error: { message: "RLS policies for tasks" } }] },
    });
    const reply = await handleTaskCommand({
      supabase: forced.supabase,
      taskIntent: detectTaskCommand("remind me to file the report"),
      message: "remind me to file the report",
    });
    assertContains(reply, "couldn't create", "RLS violation -> honest create failure");
    assertNotContains(reply, "Task created:", "RLS violation never claims success");
  }

  // ===========================================================================
  // TEST 5 — AUTHZ BOUNDARY (RLS-scoped reads stay fail-open)
  // ===========================================================================
  console.log("\nTEST 5 — AUTHZ BOUNDARY");
  {
    // RLS hides a foreign row: reads collapse to null and stores report null.
    const hiddenMock = makeSupabaseMock({
      scripts: { "tasks:select": [{ data: null }] },
    });
    const foreign = await updateTask(hiddenMock.supabase, U2, { status: "cancelled" });
    assertEqual(foreign, null, "foreign task update -> null (RLS hid the row)");
    assertEqual(await getTask(makeSupabaseMock({ scripts: { "tasks:select": [{ data: null }] } }).supabase, U1), null, "missing due to RLS -> null");

    const hiddenStep = makeSupabaseMock({
      scripts: { "plan_steps:select": [{ data: null }] },
    });
    assertEqual(await setStepStatus(hiddenStep.supabase, U2, "completed"), null, "foreign step -> null");

    // Even an owned read is refused unless the transition is legal.
    const badTransitionMock = makeSupabaseMock({
      scripts: {
        "tasks:select": [{ data: taskRow({ id: "t1", status: "completed" }) }],
      },
    });
    const refused = await updateTask(badTransitionMock.supabase, "123e4567-e89b-12d3-a456-426614174000", { status: "cancelled" });
    assertEqual(refused, null, "illegal transition -> null (never a silent downgrade)");

    // Ownership fences are enforced in the chat reply, never sniffed from text.
    const delForeign = makeSupabaseMock({
      scripts: {
        "tasks:select": [
          { data: [taskRow({ id: "t9", title: "ghost" })] },
          { data: null },
        ],
        "tasks:delete": [{ data: null, error: { message: "RLS" } }],
      },
    });
    const delReply = await handleTaskCommand({
      supabase: delForeign.supabase,
      taskIntent: detectTaskCommand("delete the task ghost"),
      message: "delete the task ghost",
    });
    assertContains(delReply, "the delete failed", "RLS delete failure stays honest");
    assertNotContains(delReply, "was deleted", "RLS delete never claims success");
  }

  // ===========================================================================
  // TEST 6 — CHAT HONESTY + RESILIENCE
  // ===========================================================================
  console.log("\nTEST 6 — CHAT HONESTY + RESILIENCE");
  {
    // Complete failure after the read succeeds.
    const completeFail = makeSupabaseMock({
      scripts: {
        "tasks:select": [
          { data: [taskRow({ id: "c1", title: "revise unit 2" })] },
          { data: taskRow({ id: "c1", title: "revise unit 2" }) },
        ],
        "tasks:update": [{ data: null, error: { message: "boom" } }],
      },
    });
    const completeReply = await handleTaskCommand({
      supabase: completeFail.supabase,
      taskIntent: detectTaskCommand("complete the task revise unit 2"),
      message: "complete the task revise unit 2",
      timezone: "UTC",
    });
    assertContains(completeReply, "couldn't complete", "complete failure honest");
    assertContains(completeReply, "nothing was recorded", "complete failure admits no record");
    assertNotContains(completeReply, "Done:", "complete failure never says Done");

    // Plan save failure.
    const planFail = makeSupabaseMock({
      scripts: { "plans:insert": [{ data: null, error: { message: "boom" } }] },
    });
    const planReply = await handleTaskCommand({
      supabase: planFail.supabase,
      planIntent: detectPlanCommand("create a study plan for my physics exam"),
      message: "create a study plan for my physics exam",
    });
    assertContains(planReply, "couldn't create the plan", "plan failure honest");
    assertContains(planReply, "save failed", "plan failure admits no record");
    assertNotContains(planReply, "Plan created:", "plan failure never claims creation");

    // Reschedule with an unresolvable new time guesses nothing.
    const reschedMock = makeSupabaseMock({
      scripts: { "tasks:select": [{ data: [taskRow({ id: "r1", title: "call mom" })] }] },
    });
    const reschedReply = await handleTaskCommand({
      supabase: reschedMock.supabase,
      taskIntent: detectTaskCommand("reschedule the task call mom to sometime far off"),
      message: "reschedule the task call mom to sometime far off",
    });
    assertContains(reschedReply, "couldn't read a clear new time", "unresolvable due is not guessed");

    // resolveDuePhrase on garbage stays null (truthful non-guess).
    const junk = resolveDuePhrase("sometime next blue moon", { timezone: "Asia/Kolkata" });
    assertEqual(junk.dueAt, null, "garbage due phrase -> null (never guesses)");
    assertEqual(junk.hasExactTime, false, "garbage due phrase not exact");
    assertEqual(resolveDuePhrase("", { timezone: "UTC" }).dueAt, null, "empty phrase -> null");

    // nextRecurrenceDue on bad anchors yields null.
    assertEqual(nextRecurrenceDue("daily", "not-a-date", Date.now()), null, "bad anchor -> null");
    assertEqual(nextRecurrenceDue("none", "2026-08-30T00:00:00.000Z", Date.now()), null, "none recurrence -> null");
    const next = nextRecurrenceDue("daily", "2026-08-29T10:00:00.000Z", new Date("2026-08-29T11:00:00.000Z").getTime());
    assert(next !== null && new Date(next).getTime() > new Date("2026-08-29T11:00:00.000Z").getTime(), "next due is strictly after");

    // A complete outage on list still yields a friendly, truthful reply.
    const listOutage = makeSupabaseMock({
      scripts: {
        "tasks:select": [
          { data: null, error: { message: "outage" } },
          { data: null, error: { message: "outage" } },
        ],
      },
    });
    const listReply = await handleTaskCommand({
      supabase: listOutage.supabase,
      taskIntent: detectTaskCommand("show me my tasks"),
      message: "show me my tasks",
    });
    assertContains(listReply, "no open tasks", "list outage degrades to empty, never crashes");
  }

  console.log("\n============================================================");
  console.log(`Phase 6G security tests: ${passed} passed, ${failed} failed`);
  console.log("============================================================");
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();