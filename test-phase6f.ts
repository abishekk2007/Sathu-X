// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: A–Z automated tests.
// Run with: npx tsx test-phase6f.ts
//
// Mocks only, no network / no Supabase / no Gemini. Covers:
//   TEST 1  — deterministic intent matrix (save/update/delete/list/disable/
//             enable + knowledge-recall guard)
//   TEST 2  — deterministic extraction (verb-strip, typing, dedup keys,
//             normalization, secret veto)
//   TEST 3  — policy gates (allow / secret / disabled / no-match /
//             preserve-explicit / ambiguous / update-existing)
//   TEST 4  — store CRUD + dedup + ownership boundary + honest failures
//   TEST 5  — relevance-ranked retrieval + core-fact fallback
//   TEST 6  — bounded, leak-free context block + list summary
//   TEST 7  — command → policy → store end-to-end flow (mocked DB)
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

import { detectMemoryIntent, isMemoryCommand } from "./src/lib/memory/intent";
import {
  parseMemoryCandidate,
  normalizeContent,
  inferType,
  buildDedupKey,
  slugify,
  mapCategoryToType,
  deriveImportance,
} from "./src/lib/memory/extractor";
import {
  evaluateSave,
  evaluateRecall,
  evaluateDelete,
} from "./src/lib/memory/policy";
import {
  upsertMemory,
  deleteMemory,
  deleteAllMemories,
  isMemoryEnabled,
  setMemoryMode,
  patchMemory,
  resolveDeleteTarget,
  areMemoriesSimilar,
} from "./src/lib/memory/store";
import { retrieveRelevantMemories, rankMemories } from "./src/lib/memory/retrieval";
import { buildMemoryContextBlock, summarizeMemories } from "./src/lib/memory/context";
import type { $UserMemory } from "./src/lib/memory";

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
  assert(
    actual === expected,
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

// ---------------------------------------------------------------------------
// Mock Supabase (scriptable, recording)
// ---------------------------------------------------------------------------

type MockScript = { data: unknown; error?: unknown };

interface RecordedCall {
  table: string;
  method: "select" | "insert" | "update" | "delete";
  columns?: string;
  filters: Array<[string, unknown]>;
  body?: Record<string, unknown>;
}

function makeSupabaseMock(opts: { scripts?: Record<string, MockScript[]> } = {}) {
  const calls: RecordedCall[] = [];
  const scripts: Record<string, MockScript[]> = opts.scripts ?? {};

  const take = (table: string, method: string) => {
    const script = scripts[`${table}:${method}`]?.shift();
    return { data: script?.data ?? null, error: script?.error ?? null };
  };

  interface Sink {
    select(columns?: string): Sink;
    order(): Sink;
    limit(): Sink;
    eq(column: string, value: unknown): Sink;
    in(column: string, value: unknown): Sink;
    gte(column: string, value: unknown): Sink;
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
      select(columns?: string) {
        s._columns = columns;
        return s;
      },
      order() { return s; },
      limit() { return s; },
      eq(column: string, value: unknown) { s._filters.push([column, value]); return s; },
      in(column: string, value: unknown) { s._filters.push([column, value]); return s; },
      gte(column: string, value: unknown) { s._filters.push([column, value]); return s; },
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
function memoryFixture(partial: Partial<$UserMemory> = {}): $UserMemory {
  seq += 1;
  return {
    id: partial.id ?? `mem-${seq}`,
    key: partial.key ?? "",
    content: partial.content ?? "The user prefers concise answers.",
    type: partial.type ?? "preference",
    source: partial.source ?? "explicit",
    confidence: partial.confidence ?? "high",
    importance: partial.importance ?? 3,
    enabled: partial.enabled ?? true,
    createdAt: partial.createdAt ?? "2026-08-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-08-20T00:00:00.000Z",
    lastUsedAt: partial.lastUsedAt ?? "2026-08-25T00:00:00.000Z",
  };
}

function rowFixture(partial: Partial<$UserMemory> = {}): Record<string, unknown> {
  const m = memoryFixture(partial);
  return {
    id: m.id,
    key: m.key,
    content: m.content,
    memory_type: m.type,
    source: m.source,
    confidence: m.confidence,
    importance: m.importance,
    enabled: m.enabled,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    last_used_at: m.lastUsedAt,
  };
}

// ---------------------------------------------------------------------------

(async () => {
  // ===========================================================================
  // TEST 1 — INTENT MATRIX
  // ===========================================================================
  console.log("\nTEST 1 — INTENT MATRIX");
  {
    const cases: Array<[string, string, string]> = [
      // [message, intent, note]
      ["remember that I prefer concise answers", "MEMORY_SAVE", "plain save"],
      ["please remember my name is Abishek", "MEMORY_SAVE", "save with please"],
      ["keep in mind I drink black coffee", "MEMORY_SAVE", "keep in mind save"],
      ["remember to mention deadlines", "MEMORY_SAVE", "remember to save"],
      ["don't forget I work on spidey-bot", "MEMORY_SAVE", "don't forget save"],
      ["note that I'm preparing for GATE", "MEMORY_SAVE", "note that save"],
      ["update what you remember about my name", "MEMORY_UPDATE", "update"],
      ["correct your memory about my course", "MEMORY_UPDATE", "correct memory"],
      ["forget about the project timeline", "MEMORY_DELETE", "forget target"],
      ["delete the memory about python", "MEMORY_DELETE", "delete target"],
      ["erase the fact about my routine", "MEMORY_DELETE", "erase target"],
      ["forget everything you remember about me", "MEMORY_DELETE", "delete-all"],
      ["delete all your memories", "MEMORY_DELETE", "delete-all 2"],
      ["clear your memory", "MEMORY_DELETE", "clear-all"],
      ["what do you remember about me", "MEMORY_LIST", "list"],
      ["list your memories", "MEMORY_LIST", "list 2"],
      ["show me everything you have stored", "MEMORY_LIST", "list 3"],
      ["stop remembering anything", "MEMORY_DISABLE", "disable"],
      ["turn off your memory", "MEMORY_DISABLE", "disable 2"],
      ["pause your memory", "MEMORY_DISABLE", "disable 3"],
      ["turn your memory back on", "MEMORY_DISABLE", "enable"],
      ["resume remembering", "MEMORY_DISABLE", "enable 2"],
      // Knowledge recall — NOT commands.
      ["do you remember where the keys are?", "MEMORY_NONE", "recall guard"],
      ["remember when we first met", "MEMORY_NONE", "recall guard 2"],
      ["can you remember the date of the exam", "MEMORY_NONE", "recall guard 3"],
      ["forget", "MEMORY_NONE", "bare verb → not a command"],
      ["hello", "MEMORY_NONE", "garbage"],
      ["x", "MEMORY_NONE", "too short"],
    ];
    for (const [message, expected, note] of cases) {
      const result = detectMemoryIntent(message);
      assertEqual(result.intent, expected, `intent "${message}" (${note})`);
    }
    assert(
      isMemoryCommand("remember that I prefer concise answers"),
      "isMemoryCommand true for save"
    );
    assert(!isMemoryCommand("do you remember where the keys are?"), "isMemoryCommand false for recall");
    const del = detectMemoryIntent("forget about the project timeline");
    assert(del.target === "project timeline", `delete target extracted (got "${del.target}")`);
    const delAll = detectMemoryIntent("forget everything you remember about me");
    assertEqual(delAll.target, "__all__", "delete-all target is __all__");
    const disOff = detectMemoryIntent("stop remembering anything");
    assertEqual(disOff.mode, "off", "disable sets mode=off");
    const disOn = detectMemoryIntent("turn your memory back on");
    assertEqual(disOn.mode, "on", "enable sets mode=on");
  }

  // ===========================================================================
  // TEST 2 — DETERMINISTIC EXTRACTION
  // ===========================================================================
  console.log("\nTEST 2 — EXTRACTION");
  {
    const parsed = parseMemoryCandidate("remember that I prefer concise answers");
    assert(parsed.kind === "fact", "save verb-strip yields a fact");
    if (parsed.kind === "fact") {
      assert(
        parsed.content === "The user prefers concise answers",
        `third-person normalization (got "${parsed.content}")`
      );
      assertEqual(parsed.candidate.type, "preference", "type inferred as preference");
      assertEqual(parsed.candidate.source, "explicit", "source explicit");
      assertEqual(parsed.candidate.confidence, "high", "confidence high");
    }

    const prof = parseMemoryCandidate("remember that my name is Abishek");
    assert(prof.kind === "fact", "profile save verb-strip yields a fact");
    if (prof.kind === "fact") {
      assert(prof.content.includes("name is Abishek"), "profile content captured");
      assertEqual(prof.candidate.type, "profile", "type inferred as profile");
      assertEqual(prof.candidate.importance, 4, "profile importance=4");
    }

    const goal = parseMemoryCandidate("remember that I plan to crack GATE");
    if (goal.kind === "fact") assertEqual(goal.candidate.type, "goal", "type inferred as goal");

    const ins = parseMemoryCandidate("remember to always explain in Tamil");
    if (ins.kind === "fact") assertEqual(ins.candidate.type, "instruction", "type inferred as instruction");

    const project = parseMemoryCandidate("remember that I am building a chatbot called spidey");
    if (project.kind === "fact") assertEqual(project.candidate.type, "project", "type inferred as project");

    const secret = parseMemoryCandidate("remember my password is swordfish123");
    assertEqual(secret.kind, "secret", "labelled secret vetoed");

    const valueSecret = parseMemoryCandidate("remember my api key is sk-abcdefghijklmnopqrstuvwxyz123456");
    assertEqual(valueSecret.kind, "secret", "secret-shaped value vetoed");

    const empty = parseMemoryCandidate("remember that");
    assertEqual(empty.kind, "empty", "empty candidate");

    assertEqual(mapCategoryToType("work"), "project", "legacy work → project");
    assertEqual(mapCategoryToType("education"), "profile", "legacy education → profile");
    assertEqual(mapCategoryToType("general"), "fact", "legacy general → fact");
    assertEqual(mapCategoryToType("zzz"), "fact", "unknown category → fact");

    assertEqual(buildDedupKey("preference", "The user prefers concise answers"), "preference:concise-answers", "stable dedup key");
    assertEqual(buildDedupKey("preference", "The user prefers concise answers."), "preference:concise-answers", "punctuation-insensitive key");
    assert(slugify("preference") !== slugify(""), "slugify handles short input");

    assertEqual(normalizeContent("I live in Chennai"), "The user lives in Chennai", "I-live normalization");
    assertEqual(normalizeContent("I'm a final year student"), "The user is a final year student", "I'm normalization");

    assertEqual(inferType("The user wants to crack GATE this year"), "goal", "inferType goal");
    assertEqual(inferType("The user lives in Chennai"), "profile", "inferType profile");
    assertEqual(inferType("The user listens to Lofi while studying"), "workflow", "inferType workflow");
    assertEqual(inferType("The user prefers concise answers"), "preference", "inferType preference");
    assertEqual(inferType("The user drinks tea every morning"), "workflow", "inferType workflow (morning habit)");
    assertEqual(inferType("The user owns a blue car"), "fact", "inferType fact fallback");

    assertEqual(deriveImportance("profile", "The user lives in Chennai"), 4, "deriveImportance profile");
    assertEqual(deriveImportance("fact", "The user owns a blue car"), 3, "deriveImportance fact");
  }

  // ===========================================================================
  // TEST 3 — POLICY GATES
  // ===========================================================================
  console.log("\nTEST 3 — POLICY");
  {
    const enabledCtx = { memoryEnabled: true };
    const disabledCtx = { memoryEnabled: false };

    const allow = evaluateSave({
      content: "The user prefers concise answers.",
      source: "explicit",
      existing: null,
      context: enabledCtx,
    });
    assert(allow.action === "allow", "explicit save allowed when enabled");

    const secret = evaluateSave({
      content: "my password is swordfish",
      source: "explicit",
      existing: null,
      context: enabledCtx,
    });
    assert(secret.action === "deny" && secret.reason === "secret", "secret denied even on explicit request");
    const secretAgain = evaluateSave({
      content: "password is swordfish",
      source: "explicit",
      existing: memoryFixture(),
      context: enabledCtx,
    });
    assert(secretAgain.action === "deny" && secretAgain.reason === "secret", "secret veto beats existing-row merge");

    const ambiguous = evaluateSave({
      content: "",
      source: "explicit",
      existing: null,
      context: enabledCtx,
    });
    assert(ambiguous.action === "ask", "empty candidate asks for clarification");

    const disabled = evaluateSave({
      content: "The user prefers tea.",
      source: "explicit",
      existing: null,
      context: disabledCtx,
    });
    assert(disabled.action === "deny" && disabled.reason === "memory_disabled", "save denied when switch off");

    const duplicate = evaluateSave({
      content: "The user prefers concise answers.",
      source: "explicit",
      existing: memoryFixture({ id: "row-9" }),
      context: enabledCtx,
    });
    assert(duplicate.action === "update_existing" && duplicate.existingId === "row-9", "explicit restatement updates existing");

    const preserve = evaluateSave({
      content: "The user might like concise answers.",
      source: "inferred",
      existing: memoryFixture({ id: "row-10" }),
      context: enabledCtx,
    });
    assert(preserve.action === "deny" && preserve.reason === "preserve_explicit", "inferred never overwrites explicit");

    assert(evaluateRecall(enabledCtx).action === "allow", "recall allowed when enabled");
    assert(evaluateRecall(disabledCtx).action === "deny", "recall denied when disabled");

    assert(evaluateDelete({ matchedCount: 1, memoryEnabled: true }).action === "allow", "delete allowed on owned row");
    assert(evaluateDelete({ matchedCount: 0, memoryEnabled: true }).reason === "no_match", "delete of unknown row denied");
    assert(evaluateDelete({ matchedCount: 2, memoryEnabled: false }).reason === "memory_disabled", "delete denied when switch off");
  }

  // ===========================================================================
  // TEST 4 — STORE (mocked DB)
  // ===========================================================================
  console.log("\nTEST 4 — STORE");
  {
    // 4.1 create path: no user_id ever written, key derived.
    {
      const newRow = rowFixture({
        id: "new-1",
        key: "preference:concise-answers",
        content: "The user prefers concise answers.",
        type: "preference",
      });
      const mock = makeSupabaseMock({
        scripts: {
          "memories:select": [{ data: [] }],
          "memories:insert": [{ data: newRow }],
        },
      });
      const result = await upsertMemory(mock.supabase, {
        content: "The user prefers concise answers.",
        type: "preference",
        source: "explicit",
      });
      assertEqual(result.kind, "created", "upsert creates when nothing matches");
      const insertCall = mock.calls.find((c) => c.method === "insert");
      assert(!!insertCall, "insert call recorded");
      assert(
        insertCall!.body !== undefined && !("user_id" in insertCall!.body),
        "insert body never includes user_id"
      );
      assertEqual(insertCall!.body!.key, "preference:concise-answers", "derived dedup key on insert");
      assertEqual(insertCall!.body!.memory_type, "preference", "typed column written");
      assertEqual(insertCall!.body!.source, "explicit", "source column written");
    }

    // 4.2 exact-key merge.
    {
      const existing = rowFixture({ id: "row-k", key: "preference:concise-answers", content: "old phrasing" });
      const updated = { ...existing, content: "The user prefers concise answers.", updated_at: "2026-08-26T00:00:00.000Z" };
      const mock = makeSupabaseMock({
        scripts: {
          "memories:select": [{ data: [existing] }],
          "memories:update": [{ data: updated }],
        },
      });
      const result = await upsertMemory(mock.supabase, {
        content: "The user prefers concise answers.",
        type: "preference",
        source: "explicit",
      });
      assertEqual(result.kind, "updated", "same-key restatement merges");
      const updateCall = mock.calls.find((c) => c.method === "update");
      assert(updateCall!.filters.some(([c, v]) => c === "id" && v === "row-k"), "key-merge targets existing id");
      assert(updateCall!.body!.content === "The user prefers concise answers.", "key-merge persists new content");
      assert(updateCall!.body!.last_used_at !== undefined, "key-merge touches last_used_at");
    }

    // 4.3 similarity merge (near-duplicate content).
    {
      const existing = rowFixture({
        id: "row-s",
        key: "",
        content: "my favourite language is python it really is",
        type: "fact",
      });
      const updated = { ...existing, content: "my favourite language is python", updated_at: "2026-08-26T00:00:00.000Z" };
      const mock = makeSupabaseMock({
        scripts: {
          "memories:select": [{ data: [existing] }],
          "memories:update": [{ data: updated }],
        },
      });
      const result = await upsertMemory(mock.supabase, {
        content: "my favourite language is python",
        type: "fact",
        source: "explicit",
      });
      assertEqual(result.kind, "updated", "similar-content restatement merges");
      assert(
        areMemoriesSimilar("my favourite language is python it really is", "my favourite language is python"),
        "areMemoriesSimilar Jaccard/overlap rule"
      );
      assert(!areMemoriesSimilar("The user prefers concise answers", "The user owns a blue car"), "dissimilar content not merged");
    }

    // 4.4 insert failure reports {kind:"error"} — never pretend success.
    {
      const mock = makeSupabaseMock({
        scripts: {
          "memories:select": [{ data: [] }],
          "memories:insert": [{ data: null, error: { message: "db down" } }],
        },
      });
      const result = await upsertMemory(mock.supabase, {
        content: "The user prefers tea.",
        source: "explicit",
      });
      assertEqual(result.kind, "error", "insert error folds to {kind:error}");
    }

    // 4.5 empty write error.
    {
      const mock = makeSupabaseMock();
      const result = await upsertMemory(mock.supabase, { content: "   " });
      assertEqual(result.kind, "error", "empty content error");
      assertEqual(mock.calls.length, 0, "no DB calls for empty write");
    }

    // 4.6 delete by ids (scoped, counted).
    {
      const mock = makeSupabaseMock({
        scripts: { "memories:delete": [{ data: [{ id: "row-d1" }, { id: "row-d2" }] }] },
      });
      const deleted = await deleteMemory(mock.supabase, ["row-d1", "row-d2"]);
      assertEqual(deleted, 2, "delete returns actual count");
      const call = mock.calls.find((c) => c.method === "delete");
      assert(call!.filters.some(([c]) => c === "id"), "delete scoped by id (RLS owner via session)");
      assert(
        call!.body === undefined,
        "delete never sends user_id (ownership via RLS)"
      );
    }

    // 4.7 empty id list → no call.
    {
      const mock = makeSupabaseMock();
      const deleted = await deleteMemory(mock.supabase, []);
      assertEqual(deleted, 0, "empty id list deletes nothing");
      assertEqual(mock.calls.length, 0, "no DB call for empty id list");
    }

    // 4.8 delete failure → null (honest failure).
    {
      const mock = makeSupabaseMock({
        scripts: { "memories:delete": [{ data: null, error: { message: "db down" } }] },
      });
      const deleted = await deleteMemory(mock.supabase, ["row-x"]);
      assert(deleted === null, "delete error returns null (honest failure)");
    }

    // 4.9 delete-all uses the gte filter trick and returns count.
    {
      const mock = makeSupabaseMock({
        scripts: { "memories:delete": [{ data: [{ id: "a" }, { id: "b" }] }] },
      });
      const deleted = await deleteAllMemories(mock.supabase);
      assertEqual(deleted, 2, "delete-all returns count");
      const call = mock.calls.find((c) => c.method === "delete");
      assert(
        call!.filters.some(([c, v]) => c === "created_at" && v === "1970-01-01T00:00:00.000Z"),
        "delete-all uses always-true gte filter (RLS-scoped, no user_id)"
      );
    }

    // 4.10 isMemoryEnabled / setMemoryMode.
    {
      const offMock = makeSupabaseMock({ scripts: { "profiles:select": [{ data: { memory_enabled: false } }] } });
      assert(!(await isMemoryEnabled(offMock.supabase)), "isMemoryEnabled false when profile says off");
      const onMock = makeSupabaseMock({ scripts: { "profiles:select": [{ data: { memory_enabled: true } }] } });
      assert(await isMemoryEnabled(onMock.supabase), "isMemoryEnabled true when profile says on");
      const errMock = makeSupabaseMock({ scripts: { "profiles:select": [{ data: null, error: { message: "x" } }] } });
      assert(await isMemoryEnabled(errMock.supabase), "isMemoryEnabled fail-open true on error");

      const modeMock = makeSupabaseMock({ scripts: { "profiles:update": [{ data: null }] } });
      assert(await setMemoryMode(modeMock.supabase, false), "setMemoryMode(false) succeeds");
      const modeCall = modeMock.calls.find((c) => c.method === "update");
      assertEqual(modeCall!.body!.memory_enabled, false, "setMemoryMode writes memory_enabled");
      assert(
        modeCall!.filters.some(([c, v]) => c === "memory_enabled" && v === true),
        "setMemoryMode only matches the opposite state"
      );
    }

    // 4.11 patchMemory (typed fields)
    {
      const patched = rowFixture({ id: "row-p", type: "goal", enabled: false });
      const mock = makeSupabaseMock({ scripts: { "memories:update": [{ data: patched }] } });
      const result = await patchMemory(mock.supabase, "row-p", { type: "goal", enabled: false });
      assert(result !== null && result.type === "goal" && result.enabled === false, "patch applies typed fields");
      const call = mock.calls.find((c) => c.method === "update");
      assert(call!.filters.some(([c, v]) => c === "id" && v === "row-p"), "patch scoped by id");
      assertEqual(call!.body!.memory_type, "goal", "patch writes snake_case column");
      assertEqual(call!.body!.enabled, false, "patch writes enabled");
      const emptyMock = makeSupabaseMock();
      const emptyResult = await patchMemory(emptyMock.supabase, "row-p", {});
      assert(emptyResult === null, "empty patch returns null without touching DB");
      assertEqual(emptyMock.calls.length, 0, "no DB call for empty patch");
    }

    // 4.12 resolveDeleteTarget (pure).
    {
      const rows = [
        memoryFixture({ id: "r1", key: "preference:concise-answers", content: "The user prefers concise answers." }),
        memoryFixture({ id: "r2", key: "", content: "The user is preparing for GATE this year.", type: "goal" }),
        memoryFixture({ id: "r3", key: "", content: "The user works on spidey-bot.", type: "project" }),
      ];
      assertEqual(resolveDeleteTarget(rows, "__all__").length, 3, "delete-all resolves to every row");
      assertEqual(resolveDeleteTarget(rows, "preference:concise-answers")[0], "r1", "exact key resolves");
      assertEqual(resolveDeleteTarget(rows, "GATE")[0], "r2", "token overlap resolves");
      assertEqual(resolveDeleteTarget(rows, "gate")[0], "r2", "token overlap is case-insensitive");
      assertEqual(resolveDeleteTarget(rows, "zzzqqq").length, 0, "unknown target resolves to nothing");
    }

    // 4.13 listMemories enabled-only filter.
    {
      const mock = makeSupabaseMock({
        scripts: { "memories:select": [{ data: [rowFixture()] }] },
      });
      const listed = await retrieveRelevantMemories(mock.supabase, "anything");
      const selectCall = mock.calls.find((c) => c.method === "select");
      assert(
        selectCall!.filters.some(([c, v]) => c === "enabled" && v === true),
        "retrieval filters enabled=true"
      );
      assert(Array.isArray(listed), "retrieval returns array");
    }
  }

  // ===========================================================================
  // TEST 5 — RANKED RETRIEVAL
  // ===========================================================================
  console.log("\nTEST 5 — RETRIEVAL");
  {
    const rows = [
      memoryFixture({ id: "a", content: "The user prefers concise answers in Tamil.", type: "preference" }),
      memoryFixture({ id: "b", content: "The user is preparing for the GATE exam.", type: "goal", importance: 4 }),
      memoryFixture({ id: "c", content: "The user works on the spidey-bot project.", type: "project" }),
      memoryFixture({ id: "d", content: "The user owns a blue car.", type: "fact" }),
      memoryFixture({ id: "e", content: "The user prefers concise answers in English.", type: "preference", key: "preference:concise-answers" }),
      memoryFixture({ id: "f", content: "The user owns a yellow bike.", type: "fact", enabled: false }),
    ];

    const ranked = rankMemories(rows, "Do you like concise answers?");
    const top = ranked[0];
    assert(top !== undefined, "ranking returns results for matching query");
    assert(top !== undefined && top.relevance > 0, "top result has keyword relevance");
    assert(top !== undefined && top.score !== undefined, "top result carries a deterministic score");
    assert(ranked.every((r) => r.enabled), "disabled rows never rank");
    assert(ranked.some((r) => r.id === "a") || ranked.some((r) => r.id === "e"), "a concise-answer row ranked");

    // Key dedup: a and e share key preference:concise-answers → only one of them.
    const withBothKeys = [
      memoryFixture({ id: "a", key: "preference:concise-answers", content: "The user prefers concise answers in Tamil.", type: "preference" }),
      memoryFixture({ id: "e", key: "preference:concise-answers", content: "The user prefers concise answers in English.", type: "preference" }),
    ];
    const deduped = rankMemories(withBothKeys, "concise answers");
    const dedupedIds = deduped.map((r) => r.id);
    assert(dedupedIds.length === 1, `same-key rows collapse to best (got ${dedupedIds.join(",")})`);

    // Cap at MAX_MEMORIES_PER_REQUEST (10).
    const many = Array.from({ length: 25 }, (_, i) =>
      memoryFixture({ id: `m${i}`, content: `The user owns item number ${i}.`, key: `fact:item-${i}` })
    );
    const capped = rankMemories(many, "item number");
    assert(capped.length <= 10, `ranking caps at 10 (got ${capped.length})`);

    // Core-fact fallback when query has no keyword overlap.
    const noOverlap = rankMemories(
      [
        memoryFixture({ id: "x1", content: "The user lives in Chennai.", type: "profile", importance: 4 }),
        memoryFixture({ id: "x2", content: "The user enjoys chess.", type: "preference", importance: 3 }),
      ],
      "zzzqqq"
    );
    assert(noOverlap.length > 0 && noOverlap[0].id === "x1", "importance-4 fact surfaces when query matches nothing");

    // Empty memory set → [] from the DB-backed helper.
    const emptyMock = makeSupabaseMock({ scripts: { "memories:select": [{ data: [] }] } });
    const fetched = await retrieveRelevantMemories(emptyMock.supabase, "anything");
    assertEqual(fetched.length, 0, "no memories ⇒ no context input");

    // DB error → fail-open [].
    const errMock = makeSupabaseMock({ scripts: { "memories:select": [{ data: null, error: { message: "db down" } }] } });
    const failedFetch = await retrieveRelevantMemories(errMock.supabase, "anything");
    assertEqual(failedFetch.length, 0, "DB failure ⇒ empty retrieval (chat continues)");
  }

  // ===========================================================================
  // TEST 6 — CONTEXT BLOCK + LIST SUMMARY
  // ===========================================================================
  console.log("\nTEST 6 — CONTEXT + SUMMARY");
  {
    const profile = {
      fullName: "Abishek",
      college: "Anna University",
      bio: "Final year CSE",
      course: "CSE",
      year: "4",
    };

    const block = buildMemoryContextBlock(
      [
        memoryFixture({ id: "c1", content: "The user prefers concise answers.", type: "preference" }),
        memoryFixture({ id: "c2", content: "The user is preparing for GATE.", type: "goal", importance: 4 }),
      ],
      profile,
      "concise"
    );
    assert(block !== null, "context block built");
    if (block) {
      assertContains(block, "PERSISTENT MEMORY", "block has memory header");
      assertContains(block, "concise answers", "block includes typed memory");
      assertContains(block, "PROFILE FACTS", "block has profile header");
      assertContains(block, "Anna University", "block includes profile college");
      assertNotContains(block, "c1", "block never leaks ids");
      assertNotContains(block, "2026", "block never leaks timestamps");
      assertNotContains(block, "explicit", "block never leaks source field");
      assertNotContains(block, "confidence", "block never leaks confidence field");
      assert(block.length <= 1200, `block within char budget (${block.length} chars)`);
    }

    // Secret defense-in-depth: even if a memory slipped in, it is dropped.
    const sneaky = memoryFixture({ id: "sec1", content: "password is swordfish" });
    const guarded = buildMemoryContextBlock([sneaky], null, "");
    assert(guarded === null, "secret-shaped memory never reaches the block");

    // Budget enforcement with oversized memories.
    const long = memoryFixture({ id: "long1", content: "The user prefers quite very extremely long answers ".repeat(20), type: "preference" });
    const budgetBlock = buildMemoryContextBlock([long], null, "");
    assert(budgetBlock === null || budgetBlock.length <= 1200, "oversized memory stays within budget");

    // Empty → null.
    assert(buildMemoryContextBlock([], null, "") === null, "nothing ⇒ no context block");

    // Summary: grouped by type, truncated, honest.
    const summary = summarizeMemories([
      memoryFixture({ id: "s1", content: "The user prefers concise answers.", type: "preference" }),
      memoryFixture({ id: "s2", content: "The user is preparing for GATE.", type: "goal" }),
      memoryFixture({ id: "s3", content: "disabled row", type: "fact", enabled: false }),
    ]);
    assert(summary !== null, "summary returned");
    if (summary) {
      const text = summary.join("\n");
      assertContains(text, "Preference", "summary groups by type");
      assertContains(text, "Goal", "summary includes goals");
      assertNotContains(text, "disabled row", "disabled rows excluded from summary");
    }
    assert(summarizeMemories([]) === null, "empty summary is null");
  }

  // ===========================================================================
  // TEST 7 — COMMAND → POLICY → STORE E2E (mocked DB)
  // ===========================================================================
  console.log("\nTEST 7 — COMMAND E2E");
  {
    // SAVE: intent → parse → policy → store (create).
    {
      const message = "remember that I prefer concise answers";
      const intent = detectMemoryIntent(message);
      assertEqual(intent.intent, "MEMORY_SAVE", "e2e: save intent detected");

      const parsed = parseMemoryCandidate(message);
      assert(parsed.kind === "fact", "e2e: parse yields fact");
      if (parsed.kind === "fact") {
        const mock = makeSupabaseMock({
          scripts: {
            "memories:select": [{ data: [] }],
            "memories:insert": [{ data: rowFixture({ id: "e2e-1", content: parsed.content, type: parsed.candidate.type }, ) as unknown as Record<string, unknown> }],
          },
        });
        const decision = evaluateSave({
          content: parsed.content,
          source: parsed.candidate.source ?? "explicit",
          existing: null,
          context: { memoryEnabled: true },
        });
        assert(decision.action === "allow", "e2e: policy allows");
        const result = await upsertMemory(mock.supabase, parsed.candidate);
        assertEqual(result.kind, "created", "e2e: persisted as new row");
        const insertCall = mock.calls.find((c) => c.method === "insert");
        assert(insertCall!.body!.key === "preference:concise-answers", "e2e: stable key persisted");
      }
    }

    // DISABLE → setMemoryMode(false)
    {
      const intent = detectMemoryIntent("stop remembering anything");
      assertEqual(intent.mode, "off", "e2e: disable mode");
    }

    // DELETE single: intent → resolve → delete (owned rows only).
    {
      const intent = detectMemoryIntent("forget about the GATE prep");
      assertEqual(intent.intent, "MEMORY_DELETE", "e2e: delete intent");
      const owned = [
        memoryFixture({ id: "g1", content: "The user is preparing for GATE this year.", type: "goal" }),
        memoryFixture({ id: "g2", content: "The user prefers tea.", type: "preference" }),
      ];
      const targets = resolveDeleteTarget(owned, intent.target || "");
      assertEqual(targets.length, 1, "e2e: delete resolves one owned row");
      if (targets.length === 1) {
        const mock = makeSupabaseMock({ scripts: { "memories:delete": [{ data: [{ id: targets[0] }] }] } });
        const deleted = await deleteMemory(mock.supabase, targets);
        assertEqual(deleted, 1, "e2e: owned row deleted");
      }
    }

    // Secret refused through the full pipeline.
    {
      const parsed = parseMemoryCandidate("remember my password is swordfish");
      assertEqual(parsed.kind, "secret", "e2e: secret vetoed before any DB call");
    }
  }

  console.log("\n============================================================");
  console.log(`Phase 6F tests: ${passed} passed, ${failed} failed`);
  console.log("============================================================");
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();