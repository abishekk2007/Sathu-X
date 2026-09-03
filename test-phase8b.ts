// ---------------------------------------------------------------------------
// Automated tests for Phase 8B — Agentic Planning (pure, deterministic).
// Run with: npx tsx test-phase8b.ts
//
// 8B consumes the Phase 8A AgentRouteResult and produces an ordered,
// dependency-aware AgentPlan. It never executes anything. This suite proves:
//
//   A–B  CHAT planning (simple + reasoning)
//   C–E  DOCUMENT_RAG / WEB_RESEARCH / HYBRID_RAG_WEB
//   F    IMAGE_UNDERSTANDING (fresh image + visual reference)
//   G    IMAGE_GENERATION (generate / edit / document_visual)
//   H    VOICE
//   I    LOCATION
//   J    MAPS (with + without a shared location — nothing fabricated)
//   K    MULTIMODAL (image+web / visual+textual)
//   L    REALTIME
//   M    HYBRID
//   N    TASK_MANAGEMENT
//   O    CLARIFICATION
//   P–Q  UNKNOWN / empty-invalid
//   R–S  Multi-step ordering + explicit dependencies
//   T–V  Determinism / stable ids / no duplicate steps
//   W–X  Closed execution types / no tool execution (everything PLANNED)
//   Y–Z  Offline purity / the exact 8A route is preserved
//
// No live network / Supabase / Gemini calls.
// ---------------------------------------------------------------------------

import {
  classifyAgentRoute,
  createAgentPlan,
  PLAN_EXECUTION_TYPES,
  type AgentPlan,
  type AgentRoute,
  type AgentRouteMetadata,
  type AgentRouteResult,
  type PlanExecutionType,
  type QueryRouteDecision,
} from "./src/lib/agent";
import type { SharedLocation } from "./src/lib/location";

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
  assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

interface Req {
  message: string;
  hasSources?: boolean;
  sourceCount?: number;
  images?: Array<{ key: string }>;
  inputModality?: "text" | "voice";
  location?: SharedLocation | null;
  freshUploadedImage?: boolean;
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
  mode?: string;
}

function classify(req: Req): AgentRouteResult {
  return classifyAgentRoute({
    userId: "u1",
    message: req.message,
    mode: req.mode ?? "general",
    hasSources: Boolean(req.hasSources),
    ...(req.sourceCount != null ? { sourceCount: req.sourceCount } : {}),
    ...(req.images ? { images: req.images } : {}),
    ...(req.priorTurns ? { priorTurns: req.priorTurns } : {}),
    location: req.location ?? null,
    inputModality: req.inputModality,
    freshUploadedImage: req.freshUploadedImage,
  });
}

function planFor(req: Req): AgentPlan {
  return createAgentPlan(classify(req), { message: req.message });
}

/** Hand-built 8A result for routes that need exact underlying signals. */
function fixture(
  route: AgentRoute,
  opts: {
    primaryRoute?: QueryRouteDecision["primaryRoute"];
    requiresDocuments?: boolean;
    requiresWeb?: boolean;
    metadata?: Partial<AgentRouteMetadata>;
  } = {}
): AgentRouteResult {
  const primary = opts.primaryRoute ?? route;
  const underlying: QueryRouteDecision = {
    primaryRoute: primary as QueryRouteDecision["primaryRoute"],
    routes: [primary as QueryRouteDecision["primaryRoute"], "GENERAL"],
    confidence: 0.85,
    confidenceLabel: "high",
    requiresDocuments: Boolean(opts.requiresDocuments),
    requiresRealtime: false,
    requiresVisualEvidence: false,
    requiresGeneralReasoning: true,
    requiresClarification: false,
    requiresWeb: Boolean(opts.requiresWeb),
    reason: "fixture",
  };
  return {
    route,
    confidence: 0.85,
    confidenceLabel: "high",
    signals: ["fixture"],
    reason: "fixture",
    metadata: { hasFreshUploadedImage: false, ...opts.metadata },
    underlying,
  };
}

const LOCATION: SharedLocation = { latitude: 28.61, longitude: 77.21 };

function allExecutionTypes(plan: AgentPlan): PlanExecutionType[] {
  return plan.steps.map((s) => s.executionType);
}

function everyDepResolvable(plan: AgentPlan): boolean {
  const ids = new Set(plan.steps.map((s) => s.id));
  for (const s of plan.steps) {
    for (const dep of s.dependencyIds) {
      if (!ids.has(dep)) return false;
      if (!/^step-\d+$/.test(dep)) return false;
    }
  }
  return true;
}

function noForwardDeps(plan: AgentPlan): boolean {
  for (const s of plan.steps) {
    for (const dep of s.dependencyIds) {
      const depOrder = Number(dep.replace("step-", ""));
      if (depOrder >= s.order) return false;
    }
  }
  return true;
}

// ===========================================================================
// A. Simple CHAT planning
// ===========================================================================
{
  const plan = planFor({ message: "hello" });
  assertEqual(plan.route, "CHAT", "A_ROUTE");
  assertEqual(plan.complexity, "SIMPLE", "A_COMPLEXITY");
  assertEqual(plan.steps.length, 1, "A_ONE_STEP");
  assertEqual(plan.steps[0].executionType, "INTERNAL_REASONING", "A_STEP_TYPE");
  assertEqual(plan.status, "PLANNED", "A_STATUS");
}

// ===========================================================================
// B. Student/general chat — reasoning only, never web/rag/map
// ===========================================================================
{
  const plan = planFor({ message: "Can you explain the water cycle?", mode: "student" });
  assertEqual(plan.route, "CHAT", "B_ROUTE");
  assertEqual(plan.steps.length, 3, "B_THREE_STEPS");
  const forbidden = ["DOCUMENT_RETRIEVAL", "WEB_RESEARCH", "MAP_LOOKUP", "IMAGE_GENERATION"];
  const leaked = allExecutionTypes(plan).filter((t) => forbidden.includes(t));
  assertEqual(leaked.length, 0, "B_NO_CAPABILITY_STEPS");
}

// ===========================================================================
// C. DOCUMENT_RAG plan
// ===========================================================================
{
  const plan = planFor({
    message: "What does my notes say about photosynthesis?",
    hasSources: true,
    sourceCount: 2,
  });
  assertEqual(plan.route, "DOCUMENT_RAG", "C_ROUTE");
  assertEqual(plan.steps[0].executionType, "DOCUMENT_RETRIEVAL", "C_RETRIEVE_STEP");
  assertEqual(plan.steps[plan.steps.length - 1].executionType, "RESPONSE_SYNTHESIS", "C_SYNTHESIS_STEP");
  assertEqual(plan.steps[1].dependencyIds[0], "step-1", "C_DEP_CHAIN");
}

// ===========================================================================
// D. WEB_RESEARCH plan
// ===========================================================================
{
  const plan = planFor({ message: "What is the latest React version?" });
  assertEqual(plan.route, "WEB_RESEARCH", "D_ROUTE");
  assert(plan.steps.some((s) => s.executionType === "WEB_RESEARCH"), "D_RESEARCH_STEP");
  assertEqual(plan.steps.length, 5, "D_FIVE_STEPS");
  assertEqual(plan.complexity, "MODERATE", "D_COMPLEXITY");
}

// ===========================================================================
// E. HYBRID_RAG_WEB plan
// ===========================================================================
{
  const plan = planFor({
    message: "Summarize what my notes say and check the latest research on the topic",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(plan.route, "HYBRID_RAG_WEB", "E_ROUTE");
  assertEqual(plan.complexity, "COMPLEX", "E_COMPLEXITY");
  assertEqual(plan.steps.length, 6, "E_SIX_STEPS");
  const compare = plan.steps.find((s) => s.purpose === "comparison");
  assert(compare !== undefined, "E_HAS_COMPARISON");
  assertEqual(JSON.stringify(compare!.dependencyIds), JSON.stringify(["step-1", "step-2"]), "E_COMPARE_DEPS");
}

// ===========================================================================
// F. IMAGE_UNDERSTANDING plan (fresh image + visual reference)
// ===========================================================================
{
  const fresh = planFor({ message: "what is this?", freshUploadedImage: true });
  assertEqual(fresh.route, "IMAGE_UNDERSTANDING", "F_ROUTE");
  assertEqual(fresh.steps[0].executionType, "IMAGE_UNDERSTANDING", "F_IMAGE_STEP");
  assertEqual(fresh.steps[2].executionType, "RESPONSE_SYNTHESIS", "F_SYNTHESIS_STEP");

  const visual = createAgentPlan(fixture("IMAGE_UNDERSTANDING", { primaryRoute: "VISUAL" }), {
    message: "look at the figure on page 5",
  });
  assertEqual(visual.steps[0].executionType, "DOCUMENT_RETRIEVAL", "F_VISUAL_RETRIEVE");
}

// ===========================================================================
// G. IMAGE_GENERATION plan (generate / edit / document_visual)
// ===========================================================================
{
  const gen = planFor({ message: "draw a red bicycle" });
  assertEqual(gen.route, "IMAGE_GENERATION", "G_ROUTE");
  assertEqual(gen.complexity, "SIMPLE", "G_SIMPLE");
  assertEqual(gen.steps[2].executionType, "IMAGE_GENERATION", "G_GENERATE_STEP");

  const edit = planFor({ message: "make the sky sunset in the image", images: [{ key: "img-1" }] });
  assertEqual(edit.route, "IMAGE_GENERATION", "G_EDIT_ROUTE");
  assertEqual(edit.metadata.complexitySignals[0], "reference-image-edit", "G_EDIT_SIGNAL");
  assertEqual(edit.steps[2].executionType, "IMAGE_GENERATION", "G_EDIT_APPLY");

  const docVis = createAgentPlan(
    fixture("IMAGE_GENERATION", {
      primaryRoute: "DOCUMENT_VISUAL_GENERATION",
      requiresDocuments: true,
      metadata: { imageOperation: "document_visual" },
    }),
    { message: "create an infographic from my notes" }
  );
  assertEqual(docVis.steps[0].executionType, "DOCUMENT_RETRIEVAL", "G_DOCVIS_RETRIEVE");
  assertEqual(docVis.steps.length, 4, "G_DOCVIS_FOUR_STEPS");
  assertEqual(docVis.metadata.complexitySignals[0], "document-grounded-visual", "G_DOCVIS_SIGNAL");
}

// ===========================================================================
// H. VOICE plan
// ===========================================================================
{
  const plan = planFor({ message: "tell me a joke", inputModality: "voice" });
  assertEqual(plan.route, "VOICE", "H_ROUTE");
  assertEqual(plan.steps[0].executionType, "VOICE_PROCESSING", "H_VOICE_STEP");
  assertEqual(plan.complexity, "SIMPLE", "H_COMPLEXITY");
}

// ===========================================================================
// I. LOCATION plan
// ===========================================================================
{
  const plan = planFor({ message: "what's around here?", location: LOCATION });
  assertEqual(plan.route, "LOCATION", "I_ROUTE");
  assertEqual(plan.steps[0].executionType, "LOCATION_LOOKUP", "I_LOCATION_STEP");
  assertEqual(plan.metadata.usesSharedLocation, true, "I_USES_LOCATION");
}

// ===========================================================================
// J. MAPS plan — with location; never fabricated without one
// ===========================================================================
{
  const withLoc = planFor({ message: "find hospitals near me", location: LOCATION });
  assertEqual(withLoc.route, "MAPS", "J_ROUTE");
  assertEqual(withLoc.metadata.usesSharedLocation, true, "J_USES_LOCATION");
  assertEqual(withLoc.steps.length, 4, "J_FOUR_STEPS");
  assertEqual(withLoc.steps[2].executionType, "MAP_LOOKUP", "J_MAP_STEP");
  assert(withLoc.goal.includes("hospitals"), "J_GOAL_QUERY");

  // Defensive: MAPS without a location → the plan asks for it, never pretends.
  const noLoc = createAgentPlan(
    fixture("MAPS", { metadata: { mapQuery: "hospitals" } }),
    { message: "find hospitals near me" }
  );
  assertEqual(noLoc.metadata.usesSharedLocation, false, "J_NO_LOCATION_FLAG");
  assertEqual(noLoc.steps[0].executionType, "LOCATION_LOOKUP", "J_REQUEST_LOCATION");
  assert(noLoc.steps[0].description.startsWith("Request the user's shared location"), "J_ASK_NOT_FABRICATE");

  // Real 8A: no shared location on a map ask → CHAT, and the plan stays clean.
  const realNoLoc = planFor({ message: "find hospitals near me", location: null });
  assertEqual(realNoLoc.route, "CHAT", "J_REAL_NO_LOCATION_CHAT");
  assert(!allExecutionTypes(realNoLoc).includes("MAP_LOOKUP"), "J_REAL_NO_LOCATION_NO_MAP");
}

// ===========================================================================
// K. MULTIMODAL plan (image+web / visual+textual)
// ===========================================================================
{
  const imgWeb = planFor({ message: "Where can I buy this product online?", freshUploadedImage: true });
  assertEqual(imgWeb.route, "MULTIMODAL", "K_ROUTE");
  assertEqual(imgWeb.complexity, "COMPLEX", "K_COMPLEXITY");
  assertEqual(JSON.stringify(imgWeb.steps[2].dependencyIds), JSON.stringify(["step-1", "step-2"]), "K_FUSION_DEPS");
  assert(imgWeb.steps.some((s) => s.executionType === "WEB_RESEARCH"), "K_HAS_WEB");
  assert(imgWeb.steps.some((s) => s.executionType === "IMAGE_UNDERSTANDING"), "K_HAS_IMAGE");

  const visText = createAgentPlan(fixture("MULTIMODAL", { primaryRoute: "MULTIMODAL" }), {
    message: "compare the chart on page 3 with the table on page 9",
  });
  assertEqual(visText.steps.length, 5, "K_FIVE_STEPS");
  assertEqual(JSON.stringify(visText.steps[3].dependencyIds), JSON.stringify(["step-2", "step-3"]), "K_VIS_TEXT_DEPS");
}

// ===========================================================================
// L. REALTIME plan
// ===========================================================================
{
  const plan = planFor({ message: "what is the weather in chennai" });
  assertEqual(plan.route, "REALTIME", "L_ROUTE");
  assertEqual(plan.complexity, "SIMPLE", "L_COMPLEXITY");
  assert(plan.steps.some((s) => s.executionType === "REALTIME_LOOKUP"), "L_REALTIME_STEP");
  assertEqual(plan.steps.length, 4, "L_FOUR_STEPS");
}

// ===========================================================================
// M. HYBRID plan (realtime + document fusion)
// ===========================================================================
{
  const plan = planFor({
    message: "According to my PDF, what is the weather in Chennai?",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(plan.route, "HYBRID", "M_ROUTE");
  assertEqual(plan.complexity, "COMPLEX", "M_COMPLEXITY");
  assertEqual(plan.steps.length, 4, "M_FOUR_STEPS");
  assertEqual(JSON.stringify(plan.steps[2].dependencyIds), JSON.stringify(["step-1", "step-2"]), "M_FUSION_DEPS");
}

// ===========================================================================
// N. TASK_MANAGEMENT plan
// ===========================================================================
{
  const plan = planFor({ message: "remind me to call mom at 9pm" });
  assertEqual(plan.route, "TASK_MANAGEMENT", "N_ROUTE");
  assert(plan.steps.some((s) => s.executionType === "TASK_MANAGEMENT"), "N_TASK_STEP");
  assertEqual(plan.steps.length, 3, "N_THREE_STEPS");
  assertEqual(plan.complexity, "MODERATE", "N_COMPLEXITY");
}

// ===========================================================================
// O. CLARIFICATION plan
// ===========================================================================
{
  const plan = planFor({
    message: "what about it?",
    priorTurns: [{ role: "user", content: "I bought a used car yesterday." }],
  });
  assertEqual(plan.route, "CLARIFICATION", "O_ROUTE");
  assertEqual(plan.steps.length, 2, "O_TWO_STEPS");
  assertEqual(plan.steps[1].dependencyIds[0], "step-1", "O_DEP");
  const allowed = new Set<PlanExecutionType>(["INTERNAL_REASONING", "RESPONSE_SYNTHESIS"]);
  assert(allExecutionTypes(plan).every((t) => allowed.has(t)), "O_NO_TOOL_STEPS");
}

// ===========================================================================
// P–Q. UNKNOWN / empty-invalid — minimal safe fallback plan
// ===========================================================================
{
  const unk = planFor({ message: "        " });
  assertEqual(unk.route, "UNKNOWN", "P_ROUTE");
  assertEqual(unk.steps.length, 1, "P_ONE_STEP");
  assertEqual(unk.complexity, "SIMPLE", "P_SIMPLE");

  const empty = createAgentPlan(planFor({ message: "" }).route === "UNKNOWN" ? classify({ message: "" }) : classify({ message: "" }), {
    message: "",
  });
  assertEqual(empty.route, "UNKNOWN", "Q_EMPTY_ROUTE");
  assertEqual(empty.steps[0].executionType, "RESPONSE_SYNTHESIS", "Q_FALLBACK_STEP");
}

// ===========================================================================
// R–S. Multi-step ordering + explicit dependencies
// ===========================================================================
{
  const complex = planFor({
    message: "Compare my uploaded document with the latest information online.",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(complex.route, "HYBRID_RAG_WEB", "R_ROUTE");
  const orders = complex.steps.map((s) => s.order);
  assertEqual(JSON.stringify(orders), JSON.stringify([1, 2, 3, 4, 5, 6]), "R_ORDERED");
  const compare = complex.steps.find((s) => s.purpose === "comparison")!;
  assert(
    compare.dependencyIds.includes("step-1") && compare.dependencyIds.includes("step-2"),
    "S_COMPARISON_DEPENDS_ON_BOTH_STREAMS"
  );

  // Dependency invariant across a battery of plans: every id resolves, no
  // forward references, ids are the stable step-N form.
  const battery = [
    planFor({ message: "hi" }),
    planFor({ message: "explain the water cycle", mode: "student" }),
    planFor({ message: "what does my notes say about ww2", hasSources: true, sourceCount: 1 }),
    planFor({ message: "what is the latest react version" }),
    planFor({ message: "draw a cat" }),
    planFor({ message: "find hospitals near me", location: LOCATION }),
    planFor({ message: "what's around here?", location: LOCATION }),
    planFor({ message: "remind me to call mom at 9pm" }),
    planFor({ message: "tell me a joke", inputModality: "voice" }),
  ];
  for (const plan of battery) {
    assert(everyDepResolvable(plan), `S_DEPS_RESOLVABLE_${plan.route}`);
    assert(noForwardDeps(plan), `S_DEPS_NO_FORWARD_${plan.route}`);
  }
}

// ===========================================================================
// T–U. Determinism + stable step IDs
// ===========================================================================
{
  const req: Req = {
    message: "Compare my notes about climate with today's news",
    hasSources: true,
    sourceCount: 2,
  };
  const a = planFor(req);
  const b = planFor(req);
  assertEqual(JSON.stringify(a), JSON.stringify(b), "T_DETERMINISTIC_EQUAL");

  const ids = a.steps.map((s) => s.id);
  assertEqual(JSON.stringify(ids), JSON.stringify(["step-1", "step-2", "step-3", "step-4", "step-5", "step-6"]), "U_STABLE_IDS");
}

// ===========================================================================
// V. No duplicate steps
// ===========================================================================
{
  const battery = [
    planFor({ message: "hello" }),
    planFor({ message: "compare java and python" }),
    planFor({ message: "draw a red bicycle" }),
    planFor({ message: "find hospitals near me", location: LOCATION }),
    planFor({ message: "what is the weather in chennai" }),
  ];
  for (const plan of battery) {
    const ids = new Set(plan.steps.map((s) => s.id));
    assertEqual(ids.size, plan.steps.length, `V_UNIQUE_IDS_${plan.route}`);
    const signatures = plan.steps.map((s) => `${s.description}|${s.executionType}`);
    assertEqual(new Set(signatures).size, plan.steps.length, `V_NO_DUPLICATE_SIGNATURES_${plan.route}`);
  }
}

// ===========================================================================
// W–X. Closed execution types + no tool execution (nothing ever COMPLETED)
// ===========================================================================
{
  const battery = [
    planFor({ message: "hi" }),
    planFor({ message: "explain dna" }),
    planFor({ message: "what does my notes say", hasSources: true, sourceCount: 1 }),
    planFor({ message: "latest nvidia news" }),
    planFor({ message: "compare my notes with current news online", hasSources: true, sourceCount: 1 }),
    planFor({ message: "what is this", freshUploadedImage: true }),
    planFor({ message: "draw a castle" }),
    planFor({ message: "what's the time" }),
    planFor({ message: "where am I", location: LOCATION }),
    planFor({ message: "find ATMs near me", location: LOCATION }),
    planFor({ message: "find this product online", freshUploadedImage: true }),
    planFor({ message: "create a study plan for exams" }),
    planFor({ message: "tell me a story", inputModality: "voice" }),
  ];
  for (const plan of battery) {
    for (const s of plan.steps) {
      assert(PLAN_EXECUTION_TYPES.includes(s.executionType), `W_CLOSED_TYPE_${plan.route}_${s.id}`);
      assertEqual(s.status, "PLANNED", `X_NO_EXECUTION_${plan.route}_${s.id}`);
    }
    assertEqual(plan.status, "PLANNED", `X_PLAN_PLANNED_${plan.route}`);
  }
}

// ===========================================================================
// Y. Offline / purity — plans carry pure data only, no results or state
// ===========================================================================
{
  const plan = planFor({ message: "what is the latest react version?" });
  assertEqual((plan as unknown as { results?: unknown }).results, undefined, "Y_NO_RESULTS");
  assertEqual((plan as unknown as { artifacts?: unknown }).artifacts, undefined, "Y_NO_ARTIFACTS");
  assert(plan.steps.every((s) => !/executed|completed/i.test(s.description)), "Y_NO_EXECUTED_LANGUAGE");
}

// ===========================================================================
// Z. The exact 8A route is preserved — plans never re-classify
// ===========================================================================
{
  const samples: Req[] = [
    { message: "hello" },
    { message: "explain the water cycle", mode: "student" },
    { message: "compare java vs python" },
    { message: "what does my notes say about ww2", hasSources: true, sourceCount: 1 },
    { message: "what is the latest react version" },
    { message: "draw a red bicycle" },
    { message: "what is the weather in chennai" },
    { message: "find hospitals near me", location: LOCATION },
    { message: "what's around here?", location: LOCATION },
    { message: "remind me to call mom at 9pm" },
    { message: "where can I buy this product online?", freshUploadedImage: true },
  ];
  for (const sample of samples) {
    const rr = classify(sample);
    const plan = createAgentPlan(rr, { message: sample.message });
    assertEqual(plan.route, rr.route, `Z_ROUTE_PRESERVED_${rr.route}`);
  }
}

// ===========================================================================
// Planning-quality: no unnecessary web/rag/map steps for plain questions
// ===========================================================================
{
  const java = planFor({ message: "What is Java inheritance?" });
  assertEqual(java.route, "CHAT", "PQ_JAVA_ROUTE");
  const quality = allExecutionTypes(java);
  assert(
    quality.every((t) => t === "INTERNAL_REASONING" || t === "RESPONSE_SYNTHESIS"),
    "PQ_JAVA_NO_CAPABILITY_STEPS"
  );

  // Agent-keyword noise must not invent tools.
  const noise = planFor({ message: "use the gemini api to search tavily about nominatim maps" });
  const toolWords = noise.steps.flatMap((s) =>
    /\b(tavily|nominatim|gemini|openai|api\s+key|secret)\b/i.test(s.description) ? [s.description] : []
  );
  assertEqual(toolWords.length, 0, "PQ_NO_INVENTED_TOOLS");

  // "Find hospitals near me" without a location must not fabricate a map.
  const noLoc = planFor({ message: "find hospitals near me" });
  assertEqual(noLoc.route, "CHAT", "PQ_NO_LOCATION_CHAT");
  assert(!allExecutionTypes(noLoc).includes("MAP_LOOKUP"), "PQ_NO_LOCATION_NO_MAP");
}

// Summary
console.log("--------------------------------------------------");
console.log(`Phase 8B tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Phase 8B test suite FAILED");
  process.exitCode = 1;
} else {
  console.log("Phase 8B test suite PASSED");
}