// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: security, isolation and safe-operations tests.
// Run with: npx tsx test-phase6f-security.ts
//
// Mocks only, no network. Focuses on what the main suite only touches lightly:
//   TEST 1 — secret detection corpus (labels + value shapes + safe passes)
//   TEST 2 — safe logging (sanitizeForLog / describeMemoryForLog never echo a
//            credential; ids/timestamps never logged)
//   TEST 3 — security-first policy (a secret is refused even on an explicit
//            request; even when a merge would otherwise run)
//   TEST 4 — defense-in-depth in the context block + list + extraction
//   TEST 5 — deletion authorization & honest failure (no user_id anywhere,
//            RLS-scoped filters, error ⇒ null not 0)
//   TEST 6 — resilience: DB failures degrade memory, never chat semantics
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

import { looksSensitive, sanitizeForLog, describeMemoryForLog } from "./src/lib/memory/security";
import { evaluateSave, evaluateDelete } from "./src/lib/memory/policy";
import { parseMemoryCandidate } from "./src/lib/memory/extractor";
import { buildMemoryContextBlock, summarizeMemories } from "./src/lib/memory/context";
import {
  deleteMemory,
  deleteAllMemories,
  upsertMemory,
  isMemoryEnabled,
  retrieveRelevantMemories,
} from "./src/lib/memory";
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

function assertContains(haystack: string, needle: string, name: string) {
  assert(
    haystack.includes(needle),
    name,
    `expected "${needle}" in: ${haystack.slice(0, 160)}`
  );
}

function assertNotContains(haystack: string, needle: string, name: string) {
  assert(
    !haystack.includes(needle),
    name,
    `expected "${needle}" ABSENT from: ${haystack.slice(0, 160)}`
  );
}

function assertEqual<T>(actual: T, expected: T, name: string) {
  assert(
    actual === expected,
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

// ---------------------------------------------------------------------------
// Mock Supabase (recording)
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
      then(resolve: (v: unknown) => unknown) {
        calls.push({
          table,
          method: s._method,
          columns: s._columns,
          filters: s._filters,
          body: s._body,
        });
        return Promise.resolve(resolve(take(table, s._method)));
      },
      select(cols?: string) { s._columns = cols; return s; },
      order() { return s; },
      limit() { return s; },
      eq(c: string, v: unknown) { s._filters.push([c, v]); return s; },
      in(c: string, v: unknown) { s._filters.push([c, v]); return s; },
      gte(c: string, v: unknown) { s._filters.push([c, v]); return s; },
      maybeSingle() { return s; },
      single() { return s; },
      update(b: Record<string, unknown>) { s._method = "update"; s._body = b; return s; },
      insert(b: Record<string, unknown>) { s._method = "insert"; s._body = b; return s; },
      delete() { s._method = "delete"; return s; },
    };
    return s;
  };
  return {
    supabase: { from: (t: string) => sink(t) } as unknown as SupabaseClient,
    calls,
  };
}

function rowFixture(partial: Partial<$UserMemory> = {}): Record<string, unknown> {
  const base: $UserMemory = {
    id: partial.id ?? "mem-1",
    key: partial.key ?? "",
    content: partial.content ?? "The user prefers concise answers.",
    type: partial.type ?? "preference",
    source: partial.source ?? "explicit",
    confidence: partial.confidence ?? "high",
    importance: partial.importance ?? 3,
    enabled: partial.enabled ?? true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    lastUsedAt: "2026-08-25T00:00:00.000Z",
  };
  return {
    id: base.id,
    key: base.key,
    content: base.content,
    memory_type: base.type,
    source: base.source,
    confidence: base.confidence,
    importance: base.importance,
    enabled: base.enabled,
    created_at: base.createdAt,
    updated_at: base.updatedAt,
    last_used_at: base.lastUsedAt,
  };
}

/** True when a recorded call referenced the client-supplied user_id anywhere. */
function referencesUserId(calls: RecordedCall[]): boolean {
  for (const call of calls) {
    if (call.body && "user_id" in call.body) return true;
    if (call.filters.some(([column]) => column === "user_id")) return true;
  }
  return false;
}

(async () => {
  // ===========================================================================
  // TEST 1 — SECRET DETECTION CORPUS
  // ===========================================================================
  console.log("\nTEST 1 — SECRET DETECTION");
  {
    const labelledSecrets = [
      "my password is swordfish",
      "the passcode is 4839",
      "her passphrase is hello-world",
      "my passkey is stored in the vault",
      "the API key for the project",
      "use apikey value here",
      "API_KEY=ABC",
      "the access token expired",
      "auth token for the gateway",
      "a bearer token sits in the header",
      "my jwt from the login flow",
      "these credentials were rotated",
      "the secret is hidden",
      "my private key lives in ~/.ssh",
      "the secret key was backed up",
      "client secret for the web app",
      "a refresh token to renew",
      "my otp is 482910",
      "one-time password was sent",
      "the verification code is 123456",
      "cvv on the back of the card",
      "cvc recall",
      "my pin is 4321",
      "credit card used for billing",
      "debit card number",
      "card number 4111 1111 1111 1111",
      "pan number is withheld",
      "security question answer",
      "recovery code 0000",
      "2fa code 8A2F",
      "two-factor backup",
      "mfa device",
      "the connection string to the db",
      "database url in the config",
      "the dsn points to prod",
    ];
    for (const text of labelledSecrets) {
      assert(looksSensitive(text), `label-secret flagged: "${text.slice(0, 40)}"`);
    }

    const valueSecrets = [
      "AIzaSyA1234567890123456789012345678901234567890",
      "key begins sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP",
      "xoxb-1234567890-abcdefghijkl",
      "AKIAIOSFODNN7EXAMPLE",
      "ASIARKKKKKKKKKKKKKKK",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----",
      "postgres://user:pass@db.example.com:5432/prod",
      "mysql://root:secret@host/db",
      "redis://default:redispw@cache:6379",
      "mongodb+srv://user:pass@cluster.mongodb.net/db",
      "jdbc:postgresql://db:5432/app",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "key=H4sIAAAAAAAAAAdamXjfjSxk5Yk8RgVvVQ20m3yNqdKvZCZp7rdfpnOjmouY9qlvAAAA",
      "1234 5678 9012 3456",
      "4111111111111111",
    ];
    for (const secret of valueSecrets) {
      assert(looksSensitive(secret), `value-secret flagged: "${secret.slice(0, 30)}"`);
    }

    const safePasses = [
      "The user prefers concise answers.",
      "I am from Chennai and study Computer Science.",
      "The project deadline is on Friday.",
      "my favourite programming language is python",
      "I play chess every evening.",
      "call me tomorrow at 10",
      "the room temperature is comfortable",
      "my roll number is 2024CS0101",
      "the exam date is 2026-08-29",
      "I measured it as 12 inches",
      "spinning top, coffee shop, pineapple",
    ];
    for (const text of safePasses) {
      assert(!looksSensitive(text), `safe text passes: "${text.slice(0, 40)}"`);
    }
  }

  // ===========================================================================
  // TEST 2 — SAFE LOGGING
  // ===========================================================================
  console.log("\nTEST 2 — SAFE LOGGING");
  {
    const secretBlob = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const cleaned = sanitizeForLog(`user stored value ${secretBlob} and moved on`);
    assertNotContains(cleaned, secretBlob, "log redacts sk- keys");

    const aiza = "AIzaSyA1234567890123456789012345678901234567890";
    assertNotContains(sanitizeForLog(`key=${aiza}`), aiza, "log redacts AIza keys");
    assertContains(sanitizeForLog(`key=${aiza}`), "[REDACTED]", "redaction marker present");

    const labelled = sanitizeForLog("password is swordfish");
    assertNotContains(labelled, "swordfish", "labelled value redacted");
    assertContains(labelled, "password", "label survives for diagnostics");

    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEowIBAAK\n-----END PRIVATE KEY-----";
    const pemCleaned = sanitizeForLog(pem);
    assertNotContains(pemCleaned, "MIIEowIBAAK", "PEM block redacted");

    const wrapped = sanitizeForLog(
      "connection string postgres://alice:super-secret@h:5432/db job done"
    );
    assertNotContains(wrapped, "super-secret", "connection-string password redacted");

    const described = describeMemoryForLog({
      type: "goal",
      content: "password is swordfish",
      source: "explicit",
      confidence: "high",
    });
    assertContains(described, "type=goal", "describe tags type");
    assertContains(described, "source=explicit", "describe tags source");
    assertContains(described, "confidence=high", "describe tags confidence");
    assertNotContains(described, "swordfish", "describe redacts secret value");

    const normalDesc = describeMemoryForLog({
      type: "fact",
      content: "The user owns a blue car.",
    });
    assertContains(normalDesc, "blue car", "describe keeps ordinary content");
    assert(
      !/id\s*=/i.test(normalDesc) && !/created/i.test(normalDesc),
      "describe never logs identity/timestamps"
    );
  }

  // ===========================================================================
  // TEST 3 — SECURITY-FIRST POLICY
  // ===========================================================================
  console.log("\nTEST 3 — SECURITY-FIRST POLICY");
  {
    const enabled = { memoryEnabled: true };
    for (const secret of ["my password is swordfish", "api key=AIzaSyA1234567890123456789012345678901234567890"]) {
      const verdict = evaluateSave({
        content: secret,
        source: "explicit",
        existing: null,
        context: enabled,
      });
      assert(verdict.action === "deny" && verdict.reason === "secret", `secret refused on explicit request (${secret.slice(0, 20)})`);
    }

    // Even when an existing row would be merged, the secret veto wins.
    const existing: $UserMemory = {
      id: "row-1",
      key: "preference:creds",
      content: "The user stores the api key in vault",
      type: "preference",
      source: "explicit",
      confidence: "high",
      importance: 3,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      lastUsedAt: "",
    };
    const mergeVerdict = evaluateSave({
      content: "my token = abcdefghijklmnopqrstuvwxyzABCDEFGH",
      source: "explicit",
      existing,
      context: enabled,
    });
    assert(mergeVerdict.action === "deny" && mergeVerdict.reason === "secret", "secret veto beats existing-row merge");

    const parsed = parseMemoryCandidate("remember that my password is swordfish");
    assertEqual(parsed.kind, "secret", "extraction vetos labelled secret");

    const parsedValue = parseMemoryCandidate("remember that my api key is sk-proj-abcdefghijklmnopqrstuvwxyz1234567890");
    assertEqual(parsedValue.kind, "secret", "extraction vetos secret-shaped value");

    const verdict2 = evaluateDelete({ matchedCount: 1, memoryEnabled: true });
    assert(verdict2.action === "allow", "delete of an owned row allowed");
    const verdict3 = evaluateDelete({ matchedCount: 0, memoryEnabled: true });
    assert(verdict3.reason === "no_match", "delete of foreign/missing row denied (no_match)");
  }

  // ===========================================================================
  // TEST 4 — DEFENSE-IN-DEPTH IN RENDERING
  // ===========================================================================
  console.log("\nTEST 4 — RENDER-TIME DEFENSE");
  {
    const sneaky: $UserMemory = {
      id: "sec-1",
      key: "",
      content: "password is swordfish",
      type: "fact",
      source: "inferred",
      confidence: "low",
      importance: 3,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      lastUsedAt: "",
    };
    const block = buildMemoryContextBlock([sneaky], null, "");
    assert(block === null || !block.includes("swordfish"), "secret memory never surfaces in context");

    const summary = summarizeMemories([sneaky]);
    assert(summary === null || !summary.join("\n").includes("swordfish"), "secret memory never surfaces in list");

    // A legit memory still renders fine next to a malicious one.
    const good: $UserMemory = { ...sneaky, id: "ok-1", content: "The user prefers concise answers.", type: "preference", key: "" };
    const mixed = buildMemoryContextBlock([sneaky, good], null, "");
    assert(mixed !== null && mixed.includes("concise answers"), "good memory survives, bad memory dropped");
    assert(mixed !== null && !mixed.includes("swordfish"), "bad memory excluded from mixed block");
  }

  // ===========================================================================
  // TEST 5 — DELETION AUTHZ + HONEST FAILURE
  // ===========================================================================
  console.log("\nTEST 5 — DELETION AUTHZ");
  {
    const mock = makeSupabaseMock({ scripts: { "memories:delete": [{ data: [{ id: "r1" }] }] } });
    const deleted = await deleteMemory(mock.supabase, ["r1"]);
    assertEqual(deleted, 1, "delete returns count");
    assert(!referencesUserId(mock.calls), "single delete never mentions user_id (RLS owns identity)");

    const allMock = makeSupabaseMock({ scripts: { "memories:delete": [{ data: [{ id: "a" }, { id: "b" }] }] } });
    const allDeleted = await deleteAllMemories(allMock.supabase);
    assertEqual(allDeleted, 2, "delete-all returns count");
    assert(!referencesUserId(allMock.calls), "delete-all never mentions user_id");
    const deleteCall = allMock.calls.find((c) => c.method === "delete");
    assert(
      deleteCall!.filters.some(([c, v]) => c === "created_at" && v === "1970-01-01T00:00:00.000Z"),
      "delete-all uses the always-true gte predicate (PostgREST requires a filter)"
    );

    // Foreign / missing row → RLS yields zero → 0 reported, not an error.
    const noneMock = makeSupabaseMock({ scripts: { "memories:delete": [{ data: [] }] } });
    const noneDeleted = await deleteMemory(noneMock.supabase, ["foreign-id"]);
    assertEqual(noneDeleted, 0, "foreign id deletes 0 rows");

    // DB failure → null (honest), never a fake success.
    const errMock = makeSupabaseMock({ scripts: { "memories:delete": [{ data: null, error: { message: "db down" } }] } });
    const errDeleted = await deleteMemory(errMock.supabase, ["r1"]);
    assert(errDeleted === null, "delete error yields null (not 0) — honest failure");

    // Inserts also never carry user_id.
    const insMock = makeSupabaseMock({
      scripts: {
        "memories:select": [{ data: [] }],
        "memories:insert": [{ data: rowFixture({ id: "new", content: "The user prefers tea." }) }],
      },
    });
    await upsertMemory(insMock.supabase, { content: "The user prefers tea.", source: "explicit" });
    assert(!referencesUserId(insMock.calls), "insert never mentions user_id");
  }

  // ===========================================================================
  // TEST 6 — RESILIENCE (memory failure ≠ chat failure)
  // ===========================================================================
  console.log("\nTEST 6 — RESILIENCE");
  {
    const broken = makeSupabaseMock({ scripts: { "memories:select": [{ data: null, error: { message: "outage" } }] } });
    const listed = await retrieveRelevantMemories(broken.supabase, "hello");
    assert(Array.isArray(listed), "retrieval degrades to array on outage");

    const forgotten = await isMemoryEnabled(broken.supabase);
    assert(forgotten === true, "master switch fails open (true) so chat never stalls");

    const failInsert = makeSupabaseMock({
      scripts: {
        "memories:select": [{ data: [] }],
        "memories:insert": [{ data: null, error: { message: "outage" } }],
      },
    });
    const saveResult = await upsertMemory(failInsert.supabase, { content: "The user prefers tea.", source: "explicit" });
    assert(saveResult.kind === "error", "failed save reports error — never claims success");
  }

  console.log("\n============================================================");
  console.log(`Phase 6F security tests: ${passed} passed, ${failed} failed`);
  console.log("============================================================");
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();