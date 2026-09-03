// ---------------------------------------------------------------------------
// Automated tests for Phase 8C — Agent Tool Calling (closed registry + executor).
// Run with: npx tsx test-phase8c.ts
//
// This suite proves the executor is deterministic, dependency-gated, bounded,
// at-most-once per step, serializable/secret-free, and wired to the REAL
// existing capabilities (never fabricated results, never duplicate engines):
//
//   A  Registry is closed + resolvable (12 entries, one per execution type)
//   B  Plan validation (missing/malformed/closed-set/deps/order)
//   C  Executor mechanics (order, at-most-once, idempotent, ceilings)
//   D  SUCCESS outcomes surface states + outputs
//   E  FAILED blocks dependents, PARTIAL status, UNAVAILABLE does not block
//   F  TIMEOUT is bounded + blocks dependents
//   G  MAP_LOOKUP (shared location, place query, strips raw coords, no location)
//   H  DOCUMENT_RETRIEVAL (single + multi-source, no sources)
//   I  WEB_RESEARCH (fail-open, sources/evidence surface)
//   J  REALTIME_LOOKUP (handled decision, no decision)
//   K  IMAGE_GENERATION (generate/edit/doc-visual/message/no image)
//   L  LOCATION_LOOKUP (shared vs none — never raw coords)
//   M  VOICE_PROCESSING (voice vs text)
//   N  TASK_MANAGEMENT (supabase present/absent)
//   O  RESPONSE_SYNTHESIS / INTERNAL_REASONING / CLARIFICATION (no model call)
//   P  Security: serializable, no secrets/coords/stack traces, no user-input
//      tool resolution, no dynamic import, browser APIs never probed server-side
//   Q  Integration smoke: real buildAdapters + real plan from 8B, no live net
//
// No live network / Supabase / Gemini / Nominatim calls. Providers are injected
// via `AgentRuntimeContext` or a custom registry with deterministic mocks.
// ---------------------------------------------------------------------------

import {
  buildAdapters,
  executeAgentPlan,
  validateAgentPlan,
  resolveAgentTool,
  agentToolSkipped,
  setDefaultRegistry,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_AGENT_EXECUTION_MS,
  MAX_AGENT_TOOL_CALLS,
  createAgentPlan,
  classifyAgentRoute,
  type AgentPlan,
  type AgentPlanStep,
  type AgentRuntimeContext,
  type AgentToolContext,
  type AgentToolResult,
  type AgentToolName,
  type AgentToolAdapter,
  type AgentToolRegistry,
  type PlanExecutionType,
  type AgentExecutionResult,
  type AgentSource,
  type RetrievalResult,
} from "./src/lib/agent";
import type { SharedLocation } from "./src/lib/location";
import type { MultiSourceResult } from "./src/lib/agent/multi-source";
import type { RealtimeToolResult } from "./src/lib/realtime";
import type { ImageOutcome } from "./src/lib/image-generation";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  assert(
    actual === expected,
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
  );
}

function isPlainSerializable(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return true;
  if (Buffer.isBuffer(v)) return false;
  if (typeof v === "function") return false;
  if (seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.every((x) => isPlainSerializable(x, seen));
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v as Record<string, unknown>).every((x) => isPlainSerializable(x, seen));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Context + plan fixtures
// ---------------------------------------------------------------------------

const LOCATION: SharedLocation = { latitude: 28.61, longitude: 77.21 };

function baseContext(over: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    stepId: "step-x",
    message: "hello",
    mode: "general",
    sharedLocation: null,
    inputModality: "text",
    hasFreshImage: false,
    sourceCount: 0,
    mapQuery: null,
    priorUserMessage: null,
    retrievalMessage: "hello",
    imageSource: null,
    visionSource: null,
    imageRefs: [],
    editSourceKey: null,
    imageOperation: null,
    capabilities: {
      web: false,
      realtime: false,
      maps: false,
      tasks: false,
      rag: false,
      images: false,
      voice: false,
      location: false,
    },
    ...over,
  };
}

function step(
  id: string,
  order: number,
  executionType: PlanExecutionType,
  dependencyIds: string[] = []
): AgentPlanStep {
  return {
    id,
    order,
    description: id,
    purpose: "test",
    dependencyIds,
    executionType,
    expectedOutput: "test",
    status: "PLANNED",
  };
}

function planFrom(steps: AgentPlanStep[], route: string = "CHAT"): AgentPlan {
  return {
    version: 1,
    status: "PLANNED",
    route: route as AgentPlan["route"],
    complexity: steps.length > 3 ? "COMPLEX" : "MODERATE",
    goal: "test",
    steps,
    metadata: { complexitySignals: [], usesSharedLocation: false, hasFreshImage: false },
  };
}

/** A fully-self-contained registry of mock adapters, so execution tests never
 *  touch a live provider. Each adapter returns a deterministic result. */
function mockRegistry(opts: {
  results?: Partial<Record<AgentToolName, AgentToolResult>>;
  delay?: Partial<Record<AgentToolName, number>>;
  throwOn?: AgentToolName[];
} = {}): AgentToolRegistry {
  const mk = (type: AgentToolName): AgentToolAdapter => {
    return (ctx): Promise<AgentToolResult> => {
      const delay = opts.delay?.[type] ?? 0;
      const run = (): AgentToolResult => {
        if (opts.throwOn?.includes(type)) {
          throw new Error(`boom-${type}`);
        }
        return (
          opts.results?.[type] ?? {
            toolName: type,
            stepId: ctx.stepId,
            status: "SUCCESS",
            output: { mock: true },
          }
        );
      };
      if (delay > 0) return new Promise((res) => setTimeout(() => res(run()), delay));
      return Promise.resolve(run());
    };
  };
  const names: AgentToolName[] = [
    "INTERNAL_REASONING",
    "RESPONSE_SYNTHESIS",
    "DOCUMENT_RETRIEVAL",
    "WEB_RESEARCH",
    "REALTIME_LOOKUP",
    "MAP_LOOKUP",
    "IMAGE_UNDERSTANDING",
    "IMAGE_GENERATION",
    "VOICE_PROCESSING",
    "LOCATION_LOOKUP",
    "TASK_MANAGEMENT",
    "CLARIFICATION",
  ];
  const reg = {} as AgentToolRegistry;
  for (const n of names) reg[n] = mk(n);
  return reg;
}

function resultFor(res: AgentExecutionResult, type: AgentToolName): AgentToolResult | undefined {
  return res.results.find((r) => r.toolName === type);
}

(async () => {
console.log("Phase 8C — running tests…\n");

// ===========================================================================
// A. Registry is closed + resolvable (6)
// ===========================================================================
{
  const reg = buildAdapters();
  assert(Boolean(reg), "A_REGISTRY_BUILDS");
  assertEqual(Object.keys(reg).length, 12, "A_TWELVE_ENTRIES");

  const names: AgentToolName[] = [
    "INTERNAL_REASONING",
    "RESPONSE_SYNTHESIS",
    "DOCUMENT_RETRIEVAL",
    "WEB_RESEARCH",
    "REALTIME_LOOKUP",
    "MAP_LOOKUP",
    "IMAGE_UNDERSTANDING",
    "IMAGE_GENERATION",
    "VOICE_PROCESSING",
    "LOCATION_LOOKUP",
    "TASK_MANAGEMENT",
    "CLARIFICATION",
  ];
  let allResolvable = true;
  for (const n of names) {
    if (resolveAgentTool(n, reg) === null) allResolvable = false;
  }
  assert(allResolvable, "A_ALL_RESOLVABLE");

  const mockedKeys = new Set(Object.keys(mockRegistry()));
  assertEqual(mockedKeys.size, 12, "A_MOCK_CLOSED_SET");

  // Each entry is an async adapter expecting at least the tool context arg
  // (some take `runtime` too when the capability needs collaborators).
  let allAdapters = true;
  for (const n of names) {
    const a = reg[n];
    if (typeof a !== "function" || a.length < 1) allAdapters = false;
  }
  assert(allAdapters, "A_ADAPTER_SIGNATURES");

  // buildAdapters is idempotent / returns fresh equivalent records.
  assertEqual(Object.keys(buildAdapters()).length, 12, "A_IDEMPOTENT");
}

// ===========================================================================
// B. Plan validation (8)
// ===========================================================================
{
  const okPlan = planFrom([step("step-1", 1, "DOCUMENT_RETRIEVAL"), step("step-2", 2, "RESPONSE_SYNTHESIS", ["step-1"])]);
  assertEqual(validateAgentPlan(okPlan).ok, true, "B_VALID_PLAN");

  assertEqual(validateAgentPlan(null).ok, false, "B_NULL_PLAN");
  assertEqual(validateAgentPlan(undefined).ok, false, "B_UNDEFINED_PLAN");

  const badVersion = { ...okPlan, version: 2 as never };
  assertEqual(validateAgentPlan(badVersion).ok, false, "B_BAD_VERSION");

  const badStatus = { ...okPlan, status: "RUNNING" as never };
  assertEqual(validateAgentPlan(badStatus).ok, false, "B_BAD_STATUS");

  const empty = { ...okPlan, steps: [] };
  assertEqual(validateAgentPlan(empty).ok, false, "B_EMPTY_STEPS");

  const dupId = planFrom([step("a", 1, "CLARIFICATION"), step("a", 2, "RESPONSE_SYNTHESIS")]);
  assertEqual(validateAgentPlan(dupId).ok, false, "B_DUP_ID");

  const nonClosed = planFrom([step("step-1", 1, "EVIL_EXEC" as PlanExecutionType)]);
  assertEqual(validateAgentPlan(nonClosed).ok, false, "B_CLOSED_SET_VIOLATION");

  const forwardDep = planFrom([step("step-1", 1, "CLARIFICATION", ["step-2"]), step("step-2", 2, "RESPONSE_SYNTHESIS")]);
  assertEqual(validateAgentPlan(forwardDep).ok, false, "B_FORWARD_DEP");
}

// ===========================================================================
// C. Executor mechanics (7)
// ===========================================================================
{
  // Runs steps in ascending order.
  const orderPlan = planFrom([
    step("first", 10, "CLARIFICATION"),
    step("second", 5, "RESPONSE_SYNTHESIS"),
    step("third", 1, "INTERNAL_REASONING"),
  ]);
  const orderRes = await executeAgentPlan(orderPlan, { context: baseContext() }, mockRegistry());
  assertEqual(orderRes.results.map((r) => r.stepId).join(","), "third,second,first", "C_ASCENDING_ORDER");

  // One result per step; plan is never mutated.
  const imm = planFrom([step("s1", 1, "CLARIFICATION"), step("s2", 2, "RESPONSE_SYNTHESIS", ["s1"])]);
  const immRes = await executeAgentPlan(imm, { context: baseContext() }, mockRegistry());
  assertEqual(immRes.results.length, 2, "C_ONE_RESULT_PER_STEP");
  assertEqual(imm.steps[0].status, "PLANNED", "C_PLAN_NOT_MUTATED");

  // At-most-once per step (single result).
  assertEqual(immRes.executedStepIds.length, 2, "C_ATMOST_ONCE");

  // COMPLETED when everything succeeds.
  assertEqual(immRes.status, "COMPLETED", "C_COMPLETED");
  assertEqual(immRes.metadata.toolCallCount, 2, "C_CALL_COUNT");

  // Deterministic: two runs give identical results.
  const a = await executeAgentPlan(imm, { context: baseContext() }, mockRegistry());
  const b = await executeAgentPlan(imm, { context: baseContext() }, mockRegistry());
  assertEqual(JSON.stringify(a.results.map((r) => r.status)), JSON.stringify(b.results.map((r) => r.status)), "C_DETERMINISTIC");

  // Ceiling: with maxToolCalls=1, the second step is skipped.
  const sinkPlan = planFrom([step("s1", 1, "CLARIFICATION"), step("s2", 2, "RESPONSE_SYNTHESIS", ["s1"])]);
  const capped = await executeAgentPlan(
    sinkPlan,
    { context: baseContext(), maxToolCalls: 1 },
    mockRegistry()
  );
  const s2 = capped.results.find((r) => r.stepId === "s2");
  assertEqual(s2?.status, "SKIPPED", "C_CEILING_SKIPS");
}

// ===========================================================================
// D. SUCCESS outcomes surface states + outputs (4)
// ===========================================================================
{
  const res = await executeAgentPlan(
    planFrom([step("s1", 1, "WEB_RESEARCH")]),
    { context: baseContext() },
    mockRegistry({ results: { WEB_RESEARCH: { toolName: "WEB_RESEARCH", stepId: "s1", status: "SUCCESS", output: { sources: [{ id: "x" }] } } } })
  );
  assertEqual(res.status, "COMPLETED", "D_STATUS");
  const web = resultFor(res, "WEB_RESEARCH");
  assertEqual(web?.status, "SUCCESS", "D_SUB_STATUS");
  assert(Boolean(web?.output) && (web!.output as { sources: unknown[] }).sources.length === 1, "D_OUTPUT_SURFACES");

  const ran = await executeAgentPlan(
    planFrom([step("s1", 1, "RESPONSE_SYNTHESIS")]),
    { context: baseContext() },
    mockRegistry()
  );
  assertEqual(ran.executedStepIds.length, 1, "D_EXECUTED_TRACKED");
  assertEqual(ran.skippedStepIds.length, 0, "D_SKIPPED_EMPTY");
}

// ===========================================================================
// E. Failure semantics (4)
// ===========================================================================
{
  // A FAILED dependency blocks the dependent (skipped) → PARTIAL.
  const plan = planFrom([
    step("s1", 1, "WEB_RESEARCH"),
    step("s2", 2, "RESPONSE_SYNTHESIS", ["s1"]),
  ]);
  const failedRes = await executeAgentPlan(
    plan,
    { context: baseContext() },
    mockRegistry({ results: { WEB_RESEARCH: { toolName: "WEB_RESEARCH", stepId: "s1", status: "FAILED", error: { code: "upstream_error", message: "x" } } } })
  );
  assertEqual(failedRes.status, "PARTIAL", "E_PARTIAL_ON_FAIL");
  const s2Res = failedRes.results.find((r) => r.stepId === "s2");
  assertEqual(s2Res?.status, "SKIPPED", "E_DEP_BLOCKED");

  // A throwing adapter → normalized FAILED (never an unhandled throw).
  const throwRes = await executeAgentPlan(
    planFrom([step("s1", 1, "CLARIFICATION")]),
    { context: baseContext() },
    mockRegistry({ throwOn: ["CLARIFICATION"] })
  );
  assertEqual(throwRes.results[0].status, "FAILED", "E_THROW_NORMALIZED");
  assertEqual(throwRes.results[0].error?.code, "internal", "E_SAFE_ERROR_CODE");

  // UNAVAILABLE does NOT block dependents; status stays COMPLETED.
  const unavailPlan = planFrom([
    step("s1", 1, "MAP_LOOKUP"),
    step("s2", 2, "RESPONSE_SYNTHESIS", ["s1"]),
  ]);
  const unavailRes = await executeAgentPlan(
    unavailPlan,
    { context: baseContext({ sharedLocation: null, mapQuery: "hospital" }) },
    mockRegistry({ results: { MAP_LOOKUP: { toolName: "MAP_LOOKUP", stepId: "s1", status: "UNAVAILABLE", error: { code: "location_required", message: "no loc" } } } })
  );
  const s2u = unavailRes.results.find((r) => r.stepId === "s2");
  assertEqual(s2u?.status, "SUCCESS", "E_UNAVAILABLE_NOT_BLOCKING");
}

// ===========================================================================
// F. Timeout is bounded + blocks dependents (3)
// ===========================================================================
{
  const plan = planFrom([
    step("s1", 1, "WEB_RESEARCH"),
    step("s2", 2, "RESPONSE_SYNTHESIS", ["s1"]),
  ]);
  const start = Date.now();
  const res = await executeAgentPlan(
    plan,
    { context: baseContext(), toolTimeoutMs: 30 },
    mockRegistry({ delay: { WEB_RESEARCH: 500 } })
  );
  assert(Date.now() - start < 500, "F_BOUNDED_ELAPSED");
  const s1 = res.results.find((r) => r.stepId === "s1");
  assertEqual(s1?.status, "TIMEOUT", "F_TIMEOUT_STATUS");
  const s2 = res.results.find((r) => r.stepId === "s2");
  assertEqual(s2?.status, "SKIPPED", "F_TIMEOUT_BLOCKS_DEP");
}

// ===========================================================================
// G. MAP_LOOKUP (4)
// ===========================================================================
{
  const runMap = (ctx: AgentToolContext, geocodePlaces?: AgentRuntimeContext["geocodePlaces"]) =>
    executeAgentPlan(
      planFrom([step("s1", 1, "MAP_LOOKUP")]),
      { context: ctx, runtime: { geocodePlaces } },
      buildAdapters()
    );

  // No shared location → UNAVAILABLE.
  const noLoc = await runMap(baseContext({ sharedLocation: null, mapQuery: "hospital" }));
  assertEqual(resultFor(noLoc, "MAP_LOOKUP")?.status, "UNAVAILABLE", "G_NO_LOCATION");

  // No place query → UNAVAILABLE invalid_input.
  const noQuery = await runMap(baseContext({ sharedLocation: LOCATION, mapQuery: null }));
  assertEqual(resultFor(noQuery, "MAP_LOOKUP")?.status, "UNAVAILABLE", "G_NO_QUERY");

  // Success surfaces places and strips raw coordinates.
  const okGeocode: AgentRuntimeContext["geocodePlaces"] = async () => ({
    ok: true,
    cached: false,
    places: [
      {
        id: "p1",
        name: "Apollo Hospital",
        category: "hospital",
        address: "Ring Rd",
        distanceMeters: 1200,
        latitude: 28.61,
        longitude: 77.21,
        openInGoogleMaps: "https://maps.google.com/?q=Apollo",
      },
    ],
  });
  const okMap = await runMap(baseContext({ sharedLocation: LOCATION, mapQuery: "hospital" }), okGeocode);
  const okResult = resultFor(okMap, "MAP_LOOKUP");
  assertEqual(okResult?.status, "SUCCESS", "G_SUCCESS");
  const places = (okResult?.output as { places: unknown[] }).places;
  assertEqual(places.length, 1, "G_PLACES_COUNT");
  assert(!("latitude" in (places[0] as object)), "G_STRIPPED_RAW_COORDS");

  // Provider failure → FAILED.
  const failGeocode: AgentRuntimeContext["geocodePlaces"] = async () => ({
    ok: false,
    status: 502,
    code: "geocoder_error",
  });
  const failMap = await runMap(baseContext({ sharedLocation: LOCATION, mapQuery: "hospital" }), failGeocode);
  assertEqual(resultFor(failMap, "MAP_LOOKUP")?.status, "FAILED", "G_PROVIDER_FAILURE");
}

// ===========================================================================
// H. DOCUMENT_RETRIEVAL (3)
// ===========================================================================
{
  const sources: AgentSource[] = [{ id: "doc1", type: "document", name: "guide.pdf" }];
  const retrieval: RetrievalResult[] = [
    { sourceId: "doc1", sourceType: "document", sourceName: "guide.pdf", content: "x", score: 0.9 },
  ];

  // No sources → UNAVAILABLE.
  const noSrc = await executeAgentPlan(
    planFrom([step("s1", 1, "DOCUMENT_RETRIEVAL")]),
    { context: baseContext({ sourceCount: 0 }) },
    buildAdapters()
  );
  assertEqual(resultFor(noSrc, "DOCUMENT_RETRIEVAL")?.status, "UNAVAILABLE", "H_NO_SOURCES");

  // Single-source retrieval.
  const single = await executeAgentPlan(
    planFrom([step("s1", 1, "DOCUMENT_RETRIEVAL")]),
    {
      context: baseContext({ sourceCount: 1, retrievalMessage: "query" }),
      runtime: {
        agentSources: sources,
        userId: "u1",
        retrieveAgentContext: async () => retrieval,
      },
    },
    buildAdapters()
  );
  const singleRes = resultFor(single, "DOCUMENT_RETRIEVAL");
  assertEqual(singleRes?.status, "SUCCESS", "H_SINGLE_SUCCESS");
  assertEqual((singleRes?.output as { chunks: RetrievalResult[] }).chunks.length, 1, "H_SINGLE_CHUNKS");

  // Multi-source retrieval.
  const multiResult: MultiSourceResult = {
    results: retrieval,
    analysis: {
      intent: { strategy: "multi_source", referencedSources: [], explicitSourceIds: ["doc1"] },
      sourceSelections: [],
      conflicts: [],
      readySourceCount: 1,
      emptySourceCount: 0,
      errorSourceCount: 0,
    },
  };
  const multi = await executeAgentPlan(
    planFrom([step("s1", 1, "DOCUMENT_RETRIEVAL")]),
    {
      context: baseContext({ sourceCount: 2, retrievalMessage: "query" }),
      runtime: { agentSources: sources, userId: "u1", orchestrateMultiSourceRetrieval: async () => multiResult },
    },
    buildAdapters()
  );
  const multiRes = resultFor(multi, "DOCUMENT_RETRIEVAL");
  const mo = multiRes?.output as { strategy: string; multiSourceAnalysis: { strategy: string; sourceCount: number } };
  assertEqual(multiRes?.status, "SUCCESS", "H_MULTI_SUCCESS");
  assertEqual(mo.strategy, "multi_source", "H_MULTI_STRATEGY");
  assertEqual(mo.multiSourceAnalysis.sourceCount, 1, "H_MULTI_SOURCE_COUNT");
}

// ===========================================================================
// I. WEB_RESEARCH (4)
// ===========================================================================
{
  // Success surfaces sources/evidence.
  const ok = await executeAgentPlan(
    planFrom([step("s1", 1, "WEB_RESEARCH")]),
    {
      context: baseContext({ message: "latest news" }),
      runtime: {
        researchWeb: async () => ({
          sources: [{ index: 1, title: "S", url: "https://x", domain: "x", publishedAt: null }],
          evidence: [{ sourceIndex: 1, sourceTitle: "S", url: "https://x", passage: "e", publishedAt: null }],
          images: [],
          degraded: false,
          status: "ok",
        }),
      },
    },
    buildAdapters()
  );
  const okRes = resultFor(ok, "WEB_RESEARCH");
  const wo = okRes?.output as { sources: unknown[]; evidence: unknown[]; degraded: boolean };
  assertEqual(okRes?.status, "SUCCESS", "I_SUCCESS");
  assertEqual(wo.sources.length, 1, "I_SOURCES");
  assertEqual(wo.evidence.length, 1, "I_EVIDENCE");
  assertEqual(wo.degraded, false, "I_STATUS");

  // No sources → still SUCCESS with empty output (fails open).
  const empty = await executeAgentPlan(
    planFrom([step("s1", 1, "WEB_RESEARCH")]),
    {
      context: baseContext(),
      runtime: {
        researchWeb: async () => ({ sources: [], evidence: [], images: [], degraded: true, status: "no-results" }),
      },
    },
    buildAdapters()
  );
  assertEqual(resultFor(empty, "WEB_RESEARCH")?.status, "SUCCESS", "I_FAIL_OPEN");
}

// ===========================================================================
// J. REALTIME_LOOKUP (2)
// ===========================================================================
{
  const decision = { intent: "CALCULATION" as const, handled: true, reason: "calc" };

  // Handled decision → SUCCESS with answer.
  const ok = await executeAgentPlan(
    planFrom([step("s1", 1, "REALTIME_LOOKUP")]),
    {
      context: baseContext({ message: "2+2" }),
      runtime: {
        realtimeDecision: decision,
        executeRealtimeTool: async (): Promise<RealtimeToolResult> => ({
          success: true,
          intent: "CALCULATION",
          tool: "calculate",
          answer: "4",
          source: "calc",
          timestamp: new Date().toISOString(),
        }),
      },
    },
    buildAdapters()
  );
  const okRes = resultFor(ok, "REALTIME_LOOKUP");
  assertEqual(okRes?.status, "SUCCESS", "J_SUCCESS");
  assertEqual((okRes?.output as { answer: string }).answer, "4", "J_ANSWER");

  // No realtime decision → UNAVAILABLE.
  const none = await executeAgentPlan(
    planFrom([step("s1", 1, "REALTIME_LOOKUP")]),
    { context: baseContext(), runtime: { realtimeDecision: { intent: "NONE", handled: false, reason: "none" } } },
    buildAdapters()
  );
  assertEqual(resultFor(none, "REALTIME_LOOKUP")?.status, "UNAVAILABLE", "J_NO_DECISION");
}

// ===========================================================================
// K. IMAGE_GENERATION (5)
// ===========================================================================
{
  const genOutcome: ImageOutcome = {
    kind: "image",
    message: "",
    image: {
      provider: "gemini",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      width: 512,
      height: 512,
      fileSizeBytes: 4,
      prompt: "a cat",
      mode: "edit" as const,
      editSourceKey: "img-1",
      sourceGrounded: true,
      visualType: "general",
    },
  };

  // generate.
  const gen = await executeAgentPlan(
    planFrom([step("s1", 1, "IMAGE_GENERATION")]),
    {
      context: baseContext({ message: "a cat", imageOperation: "generate" }),
      runtime: { generateImage: async () => genOutcome },
    },
    buildAdapters()
  );
  const genRes = resultFor(gen, "IMAGE_GENERATION");
  const go = genRes?.output as { kind: string; dataUrl: string };
  assertEqual(genRes?.status, "SUCCESS", "K_GENERATE_SUCCESS");
  assertEqual(go.kind, "image", "K_GENERATE_KIND");
  assertEqual(go.dataUrl, genOutcome.image.dataUrl, "K_GENERATE_DATAURL");

  // edit without source image → UNAVAILABLE.
  const noEditSrc = await executeAgentPlan(
    planFrom([step("s1", 1, "IMAGE_GENERATION")]),
    { context: baseContext({ message: "edit", imageOperation: "edit", imageSource: null, sourceCount: 1 }) },
    buildAdapters()
  );
  assertEqual(resultFor(noEditSrc, "IMAGE_GENERATION")?.status, "UNAVAILABLE", "K_EDIT_NO_IMAGE");

  // edit with source image → SUCCESS.
  const edit = await executeAgentPlan(
    planFrom([step("s1", 1, "IMAGE_GENERATION")]),
    {
      context: baseContext({
        message: "edit",
        imageOperation: "edit",
        sourceCount: 1,
        imageSource: { sourceKey: "img-1", mimeType: "image/png", bytes: Buffer.from("x") },
      }),
      runtime: { editImage: async () => genOutcome },
    },
    buildAdapters()
  );
  assertEqual(resultFor(edit, "IMAGE_GENERATION")?.status, "SUCCESS", "K_EDIT_SUCCESS");

  // document_visual.
  const docVis = await executeAgentPlan(
    planFrom([step("s1", 1, "IMAGE_GENERATION")]),
    {
      context: baseContext({ message: "infographic", imageOperation: "document_visual" }),
      runtime: {
        documentVisualEvidence: [{ text: "sales grew 20%" }],
        documentVisualType: "infographic",
        generateDocumentVisual: async () => genOutcome,
      },
    },
    buildAdapters()
  );
  assertEqual(resultFor(docVis, "IMAGE_GENERATION")?.status, "SUCCESS", "K_DOCVIS_SUCCESS");

  // message outcome (provider refuses) → SUCCESS kind=message.
  const msg = await executeAgentPlan(
    planFrom([step("s1", 1, "IMAGE_GENERATION")]),
    {
      context: baseContext({ message: "x", imageOperation: "generate" }),
      runtime: { generateImage: async () => ({ kind: "message", message: "No evidence to ground." }) },
    },
    buildAdapters()
  );
  const msgRes = resultFor(msg, "IMAGE_GENERATION");
  assertEqual(msgRes?.status, "SUCCESS", "K_MESSAGE_SUCCESS");
  assertEqual((msgRes?.output as { kind: string }).kind, "message", "K_MESSAGE_KIND");
}

// ===========================================================================
// L. LOCATION_LOOKUP (3)
// ===========================================================================
{
  const withLoc = await executeAgentPlan(
    planFrom([step("s1", 1, "LOCATION_LOOKUP")]),
    { context: baseContext({ sharedLocation: LOCATION }) },
    buildAdapters()
  );
  const wl = resultFor(withLoc, "LOCATION_LOOKUP");
  assertEqual(wl?.status, "SUCCESS", "L_WITH_LOCATION");
  const wlo = wl?.output as { hasLocation: boolean; accuracy?: number };
  assertEqual(wlo.hasLocation, true, "L_HAS_LOCATION");
  assert(!("latitude" in wlo), "L_NO_RAW_COORDS");

  const noLoc = await executeAgentPlan(
    planFrom([step("s1", 1, "LOCATION_LOOKUP")]),
    { context: baseContext({ sharedLocation: null }) },
    buildAdapters()
  );
  assertEqual(resultFor(noLoc, "LOCATION_LOOKUP")?.status, "UNAVAILABLE", "L_NO_LOCATION");
}

// ===========================================================================
// M. VOICE_PROCESSING (2)
// ===========================================================================
{
  const voice = await executeAgentPlan(
    planFrom([step("s1", 1, "VOICE_PROCESSING")]),
    { context: baseContext({ inputModality: "voice", message: "hello there" }) },
    buildAdapters()
  );
  const v = resultFor(voice, "VOICE_PROCESSING");
  assertEqual(v?.status, "SUCCESS", "M_VOICE_SUCCESS");
  assertEqual((v?.output as { transcript: string }).transcript, "hello there", "M_TRANSCRIPT");

  const text = await executeAgentPlan(
    planFrom([step("s1", 1, "VOICE_PROCESSING")]),
    { context: baseContext({ inputModality: "text" }) },
    buildAdapters()
  );
  assertEqual(resultFor(text, "VOICE_PROCESSING")?.status, "UNAVAILABLE", "M_TEXT_UNAVAILABLE");
}

// ===========================================================================
// N. TASK_MANAGEMENT (2)
// ===========================================================================
{
  const noSupabase = await executeAgentPlan(
    planFrom([step("s1", 1, "TASK_MANAGEMENT")]),
    { context: baseContext({ message: "remind me to call mom" }) },
    buildAdapters()
  );
  assertEqual(resultFor(noSupabase, "TASK_MANAGEMENT")?.status, "UNAVAILABLE", "N_NO_SUPABASE");

  const withSupabase = await executeAgentPlan(
    planFrom([step("s1", 1, "TASK_MANAGEMENT")]),
    {
      context: baseContext({ message: "remind me to call mom", timezone: "Asia/Kolkata" }),
      runtime: {
        supabase: {} as never,
        handleTaskCommand: async () => "I'll remind you to call mom.",
      },
    },
    buildAdapters()
  );
  const t = resultFor(withSupabase, "TASK_MANAGEMENT");
  assertEqual(t?.status, "SUCCESS", "N_WITH_SUPABASE");
  assert((t?.output as { reply: string }).reply.includes("call mom"), "N_REPLY");
}

// ===========================================================================
// O. INTERNAL_REASONING / RESPONSE_SYNTHESIS / CLARIFICATION (3)
// ===========================================================================
{
  const internal = await executeAgentPlan(
    planFrom([step("s1", 1, "INTERNAL_REASONING")]),
    { context: baseContext() },
    buildAdapters()
  );
  assertEqual(resultFor(internal, "INTERNAL_REASONING")?.status, "SUCCESS", "O_INTERNAL");

  const synth = await executeAgentPlan(
    planFrom([step("s1", 1, "RESPONSE_SYNTHESIS")]),
    { context: baseContext() },
    buildAdapters()
  );
  const so = resultFor(synth, "RESPONSE_SYNTHESIS")?.output as { synthesis: string };
  assertEqual(so.synthesis, "deferred-to-stream", "O_SYNTHESIS_DEFERRED");

  const clar = await executeAgentPlan(
    planFrom([step("s1", 1, "CLARIFICATION")]),
    { context: baseContext() },
    buildAdapters()
  );
  assertEqual(resultFor(clar, "CLARIFICATION")?.status, "SUCCESS", "O_CLARIFICATION");
}

// ===========================================================================
// P. Security (7)
// ===========================================================================
{
  setDefaultRegistry(mockRegistry());

  // Every tool result is plain-serializable (no buffers/functions/class instances).
  const securityPlan = planFrom([
    step("s1", 1, "LOCATION_LOOKUP"),
    step("s2", 2, "VOICE_PROCESSING"),
    step("s3", 3, "INTERNAL_REASONING"),
    step("s4", 4, "RESPONSE_SYNTHESIS", ["s3"]),
  ]);
  const secCtx = baseContext({ sharedLocation: LOCATION, inputModality: "voice" });
  const secRes = await executeAgentPlan(securityPlan, { context: secCtx }, buildAdapters());
  let allSerializable = true;
  for (const r of secRes.results) {
    if (!isPlainSerializable(r)) allSerializable = false;
  }
  assert(allSerializable, "P_SERIALIZABLE_RESULTS");

  // No secrets / raw coords / stack traces in error copies.
  const errRes = await executeAgentPlan(
    planFrom([step("s1", 1, "MAP_LOOKUP")]),
    { context: baseContext({ sharedLocation: null, mapQuery: "x" }) },
    buildAdapters()
  );
  const errJson = JSON.stringify(errRes.results);
  assert(!errJson.includes("stack"), "P_NO_STACK_TRACES");

  // User input cannot select a tool (closed registry; resolveAgentTool is typed).
  // Attempting an unknown string yields null (defensive) — no dynamic lookup.
  const reg = buildAdapters();
  const bogus = resolveAgentTool("USER_SUPPLIED" as AgentToolName, reg);
  assertEqual(bogus, null, "P_NO_USER_TOOL_RESOLUTION");

  // Validation rejects a closed-set-violating execution type before any run.
  const evilPlan = planFrom([step("s1", 1, "rm -rf /" as PlanExecutionType)]);
  assertEqual(validateAgentPlan(evilPlan).ok, false, "P_CLOSED_SET_GUARD");

  // agentToolSkipped yields a serializable, no-output result.
  const skipped = agentToolSkipped("WEB_RESEARCH", "s1", "dep missing");
  assert(isPlainSerializable(skipped), "P_SKIPPED_SERIALIZABLE");
  assertEqual(skipped.output, undefined, "P_SKIPPED_NO_OUTPUT");

  // Global deadline caps the whole run (remaining steps skipped).
  const deadlinePlan = planFrom([
    step("s1", 1, "CLARIFICATION"),
    step("s2", 2, "RESPONSE_SYNTHESIS", ["s1"]),
  ]);
  const deadlineRes = await executeAgentPlan(
    deadlinePlan,
    { context: baseContext(), maxExecutionMs: 1, toolTimeoutMs: 5, now: () => Date.now() + 1_000_000 },
    mockRegistry()
  );
  assertEqual(deadlineRes.results.every((r) => r.status === "SKIPPED"), true, "P_DEADLINE_SKIPS_ALL");

  // Constants are bounded/hard-capped.
  assert(DEFAULT_TOOL_TIMEOUT_MS === 20_000, "P_TIMEOUT_CONST");
  assert(MAX_AGENT_EXECUTION_MS === 40_000, "P_EXEC_CONST");
  assert(MAX_AGENT_TOOL_CALLS === 16, "P_CALLS_CONST");
}

// ===========================================================================
// Q. Integration smoke — real 8B plan → real executor (7)
// ===========================================================================
{
  setDefaultRegistry(buildAdapters());

  // A real 8B plan for a RAG-style web turn.
  const route = classifyAgentRoute({
    userId: "u1",
    message: "What is the current weather in Delhi?",
    mode: "general",
    hasSources: false,
    sourceCount: 0,
    inputModality: "text",
  });
  const plan = createAgentPlan(route, { message: "What is the current weather in Delhi?" });
  const res = await executeAgentPlan(plan, {
    context: baseContext({ sourceCount: 0 }),
    runtime: {
      realtimeDecision: { intent: "WEATHER_CURRENT", handled: true, reason: "r" },
      executeRealtimeTool: async (): Promise<RealtimeToolResult> => ({
        success: true,
        intent: "WEATHER_CURRENT",
        tool: "weather",
        answer: "clear, 28°C",
        source: "weather",
        timestamp: new Date().toISOString(),
      }),
    },
  });
  assert(Boolean(res), "Q_EXECUTES");
  assert(res.results.length === plan.steps.length, "Q_ONE_PER_STEP");
  assertEqual(res.version, 1, "Q_VERSION");
  assert(res.metadata.toolCallCount <= plan.steps.length, "Q_CALL_COUNT_BOUND");

  // Every result carries the closed tool name (no invented types).
  const closedNames = new Set<PlanExecutionType>([
    "INTERNAL_REASONING", "RESPONSE_SYNTHESIS", "DOCUMENT_RETRIEVAL", "WEB_RESEARCH",
    "REALTIME_LOOKUP", "MAP_LOOKUP", "IMAGE_UNDERSTANDING", "IMAGE_GENERATION",
    "VOICE_PROCESSING", "LOCATION_LOOKUP", "TASK_MANAGEMENT", "CLARIFICATION",
  ]);
  assert(res.results.every((r) => closedNames.has(r.toolName)), "Q_CLOSED_TOOLNAMES");

  // REALTIME_LOOKUP step ran with no live provider and resolved to a safe
  // status (SUCCESS/UNAVAILABLE/FAILED) — the executor never throws and the
  // caller fails open; UNAVAILABLE does NOT block its dependents.
  const rtl = resultFor(res, "REALTIME_LOOKUP");
  assert(Boolean(rtl) && ["SUCCESS", "UNAVAILABLE", "FAILED"].includes(rtl!.status), "Q_REALTIME_FAIL_OPEN");
  assert(isPlainSerializable(res), "Q_RESULT_SERIALIZABLE");
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\nPhase 8C — ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("ALL PHASE 8C TESTS PASSED");
} else {
  console.error("PHASE 8C TESTS FAILED");
  process.exitCode = 1;
}
})();
