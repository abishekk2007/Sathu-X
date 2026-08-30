// ---------------------------------------------------------------------------
// Phase 6B — Central Query Router test suite.
// Run with: npx tsx test-phase6b.ts
//
// The router is a pure, deterministic decision layer above Phases 1–6A. It
// composes — never duplicates — the existing detectors (detectRealtimeIntent,
// detectVisualIntent, analyzeQuery, classifySourceIntent, referencesDocument)
// and returns a route decision with a bounded execution plan.
//
// Sections:
//   A. Direct route matrix (STEP 37)      — single-intent routing (16 cases)
//   B. Document / visual / hybrid / guard — RAG, doc priority, HYBRID (12)
//   C. STEP 36 negatives                  — idiomatic chat never hits tools
//   D. Follow-up resolution               — weather/currency/time/doc anchors
//   E. Ambiguous deictics                 — clarification vs. fall-through
//   F. Execution-plan bounds              — maxDepth/maxExternalCalls/cycles
//   G. Transparency & extension points    — reasons never exposed, tools off
//   H. No-hallucination seam              — authoritative values only
//   I. Domain advisory routes (STEP 55)   — AGRICULTURE/MARINE/AVIATION/
//                                           SMART_CITY/TRAVEL/OUTDOOR routing
//   J. Location resolution                — explicit vs. never-invented
//   K. Follow-up inheritance              — single-location chain only
//   L. Document guard preserved           — doc priority over domain signals
//   M. Domain negatives                   — casual chat/knowledge never fires
//   N. Safety boundaries                  — no official approval/clearance
//
// No live network, Supabase, or Gemini calls — the router makes none.
// ---------------------------------------------------------------------------

import {
  routeQuery,
  describeQueryRoute,
  EXTENSION_POINTS,
  isRealtimeConceptDefinition,
} from "./src/lib/agent";
import type { QueryRouteDecision, QueryRoutingInput } from "./src/lib/agent";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS — ${label}`);
    passed++;
  } else {
    console.error(`  FAIL — ${label}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual === expected) {
    console.log(`  PASS — ${label}`);
    passed++;
  } else {
    console.error(`  FAIL — ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n== ${name} ============================================`);
}

interface RouteOpts {
  message: string;
  hasSources?: boolean;
  sourceCount?: number;
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
}

function route(opts: RouteOpts): QueryRouteDecision {
  const input: QueryRoutingInput = {
    userId: "test-user",
    message: opts.message,
    hasSources: opts.hasSources ?? false,
    sourceCount: opts.sourceCount,
    priorTurns: opts.priorTurns,
  };
  return routeQuery(input);
}

// ---------------------------------------------------------------------------
// A. Direct route matrix (STEP 37)
// ---------------------------------------------------------------------------
section("A. Direct route matrix");

{
  const d = route({ message: "Hello there" });
  assertEqual(d.primaryRoute, "GENERAL", "A1 plain greeting → GENERAL");
  assert(d.requiresGeneralReasoning, "A1 GENERAL uses Gemini pipeline");
  assert(!d.requiresRealtime, "A1 no real-time branch");
  assert(!d.requiresDocuments, "A1 no document branch");
  assert(!d.requiresClarification, "A1 no clarification");
  assertEqual(d.confidenceLabel, "high", "A1 confidence 0.95 → high");
}

{
  const d = route({ message: "What is photosynthesis?" });
  assertEqual(d.primaryRoute, "GENERAL", "A2 general knowledge → GENERAL");
  assert(d.requiresGeneralReasoning, "A2 routed to Gemini");
}

{
  const d = route({ message: "What is weather?" });
  assertEqual(d.primaryRoute, "GENERAL", "A3 definition question routes to GENERAL");
  assert(!d.requiresRealtime, "A3 definition never runs the weather tool");
  assert(isRealtimeConceptDefinition("What is weather?"), "A3 isRealtimeConceptDefinition true");
}

{
  const d = route({ message: "What is a forecast?" });
  assertEqual(d.primaryRoute, "GENERAL", "A4 'what is a forecast' → GENERAL");
}

{
  const d = route({ message: "Define exchange rate" });
  assertEqual(d.primaryRoute, "GENERAL", "A5 'Define exchange rate' → GENERAL");
  assert(!d.requiresRealtime, "A5 definition never hits the currency tool");
}

{
  const d = route({ message: "What is the weather in Chennai?" });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "A6 located weather → REALTIME_WEATHER");
  assert(d.requiresRealtime, "A6 requires the real-time layer");
  assert(!d.requiresGeneralReasoning, "A6 direct answer, no Gemini");
  assertEqual(d.realtimeDecision?.params?.location, "Chennai", "A6 location extracted verbatim");
  assertEqual(d.confidence, 0.96, "A6 strong weather → 0.96");
  assertEqual(d.confidenceLabel, "high", "A6 label high");
}

{
  const d = route({ message: "What is the weather?" });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "A7 no-location weather → REALTIME_WEATHER");
  assertEqual(d.realtimeDecision?.params?.location, "", "A7 empty location → tool prompts (never invented)");
  assertEqual(d.confidence, 0.8, "A7 location-prompt confidence 0.8");
  assertEqual(d.confidenceLabel, "medium", "A7 label medium");
}

{
  const d = route({ message: "What is the forecast for Tokyo tomorrow?" });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "A8 forecast → REALTIME_WEATHER");
  assertEqual(d.realtimeDecision?.intent, "WEATHER_FORECAST", "A8 forecast intent");
}

{
  const d = route({ message: "How hot is Chennai?" });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "A9 'how hot is Chennai' → REALTIME_WEATHER");
  assertEqual(d.realtimeDecision?.params?.location, "Chennai", "A9 location Chennai");
}

{
  const d = route({ message: "What is today's date?" });
  assertEqual(d.primaryRoute, "REALTIME_DATE", "A10 current date → REALTIME_DATE");
  assertEqual(d.realtimeDecision?.intent, "CURRENT_DATE", "A10 CURRENT_DATE intent");
  assert(!d.requiresGeneralReasoning, "A10 direct date answer");
}

{
  const d = route({ message: "What day is tomorrow?" });
  assertEqual(d.primaryRoute, "REALTIME_DATE", "A11 date-math → REALTIME_DATE");
  assertEqual(d.realtimeDecision?.intent, "DATE_QUERY", "A11 DATE_QUERY intent");
}

{
  const d = route({ message: "What time is it?" });
  assertEqual(d.primaryRoute, "REALTIME_TIME", "A12 current time → REALTIME_TIME");
  assertEqual(d.realtimeDecision?.intent, "CURRENT_TIME", "A12 CURRENT_TIME intent");
}

{
  const d = route({ message: "What time is it in Tokyo?" });
  assertEqual(d.primaryRoute, "REALTIME_TIME", "A13 timezone-aliased time → REALTIME_TIME");
}

{
  const d = route({ message: "How many EUR is 100 USD?" });
  assertEqual(d.primaryRoute, "REALTIME_CURRENCY", "A14 currency → REALTIME_CURRENCY");
  assertEqual(d.realtimeDecision?.params?.from, "USD", "A14 from USD");
  assertEqual(d.realtimeDecision?.params?.to, "EUR", "A14 to EUR");
  assertEqual(d.realtimeDecision?.params?.amount, 100, "A14 amount 100");
  assertEqual(d.confidence, 0.96, "A14 strong currency → 0.96");
}

{
  const d = route({ message: "Convert 50 INR to JPY" });
  assertEqual(d.primaryRoute, "REALTIME_CURRENCY", "A15 explicit conversion → REALTIME_CURRENCY");
  assertEqual(d.realtimeDecision?.params?.from, "INR", "A15 from INR");
  assertEqual(d.realtimeDecision?.params?.to, "JPY", "A15 to JPY");
}

{
  const d = route({ message: "What is 12 * 34" });
  assertEqual(d.primaryRoute, "CALCULATION", "A16 arithmetic → CALCULATION");
  assertEqual(d.realtimeDecision?.params?.expression, "12 * 34", "A16 expression captured");
  assert(d.requiresRealtime, "A16 calculator is part of the real-time layer");
  assert(!d.requiresGeneralReasoning, "A16 direct calculator result");
  assertEqual(d.confidence, 0.96, "A16 strong calculation → 0.96");
}

{
  const d = route({ message: "What is the capital of France?" });
  assertEqual(d.primaryRoute, "GENERAL", "A17 factual question → GENERAL (never auto-weather/date)");
}

// ---------------------------------------------------------------------------
// B. Document / visual / hybrid / doc-guard
// ---------------------------------------------------------------------------
section("B. Document / visual / hybrid / doc-guard");

{
  const d = route({ message: "According to my PDF, what does Unit 4 Question 5 Part B say?", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "DOCUMENT_RAG", "B1 structural question + sources → DOCUMENT_RAG");
  assertEqual(d.confidence, 0.97, "B1 structural signals raise confidence");
  assert(d.requiresDocuments, "B1 requires document retrieval");
  assert(d.requiresGeneralReasoning, "B1 answered via Gemini pipeline");
}

{
  const d = route({ message: "What is photosynthesis?", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "DOCUMENT_RAG", "B2 attached sources → DOCUMENT_RAG");
  assertEqual(d.confidence, 0.9, "B2 non-structural RAG confidence 0.9");
  assert(d.queryAnalysis != null, "B2 query analysis attached");
}

{
  const d = route({ message: "Compare the two documents", hasSources: true, sourceCount: 2 });
  assertEqual(d.primaryRoute, "DOCUMENT_RAG", "B3 multi-source → DOCUMENT_RAG");
  assert(d.multiSourceIntent != null, "B3 multi-source strategy attached");
}

{
  const d = route({ message: "What date does my PDF mention?" });
  assertEqual(d.primaryRoute, "GENERAL", "B4 PDF date mention (no sources) → GENERAL");
  assert(!d.requiresRealtime, "B4 PDF date never calls the date tool (6A guard)");
}

{
  const d = route({ message: "According to my PDF, what is today's date?" });
  assertEqual(d.primaryRoute, "GENERAL", "B5 PDF date question (no sources) → GENERAL");
  assert(!d.requiresRealtime, "B5 real-time stands down behind the doc reference");
}

{
  const d = route({ message: "According to my PDF, what is today's date?", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "DOCUMENT_RAG", "B6 PDF date with sources → DOCUMENT_RAG");
  assert(!d.requiresRealtime, "B6 real-time stands down even with sources");
}

{
  const d = route({ message: "According to my PDF, what is the weather in Chennai?", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "HYBRID", "B7 doc + strong real-time + sources → HYBRID");
  assert(d.routes.includes("DOCUMENT_RAG"), "B7 document branch runs");
  assert(d.routes.includes("REALTIME_WEATHER"), "B7 weather branch runs");
  assert(d.requiresDocuments && d.requiresRealtime, "B7 both branches required");
  assertEqual(d.realtimeDecision?.params?.location, "Chennai", "B7 weather probe found Chennai past the guard");
  assert(d.executionPlan?.parallelizable === true, "B7 hybrid branches are parallelizable");
}

{
  const d = route({ message: "According to my PDF, what is the weather in Chennai?" });
  assertEqual(d.primaryRoute, "GENERAL", "B8 doc + weather but NO sources → GENERAL (stand-down preserved)");
  assert(!d.requiresRealtime, "B8 no real-time branch without sources to ground the doc");
}

{
  const d = route({ message: "the chart — weather in Chennai?", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "HYBRID", "B9 visual + strong real-time + sources → HYBRID");
  // 6A/5E-2 classify this phrasing as mixed (chart + analysis prose), so the
  // visual branch is MULTIMODAL; the assertion only pins the shared contract.
  assert(d.routes.includes("MULTIMODAL") || d.routes.includes("VISUAL"), "B9 a visual route runs");
  assert(d.routes.includes("REALTIME_WEATHER"), "B9 weather branch runs");
  assert(d.requiresVisualEvidence && d.requiresRealtime, "B9 visual + real-time required");
  assertEqual(d.realtimeDecision?.params?.location, "Chennai", "B9 weather location Chennai");
}

{
  const d = route({ message: "What does the diagram on page 4 show?", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "VISUAL", "B10 page/diagram reference → VISUAL");
  assert(d.requiresVisualEvidence, "B10 requires visual evidence");
  assertEqual(d.visualIntent?.type, "visual", "B10 intent type visual");
}

{
  const d = route({ message: "Compare the chart on page 4 with the text on page 5", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "MULTIMODAL", "B11 chart + text comparison → MULTIMODAL");
  assert(d.requiresVisualEvidence, "B11 requires visual evidence");
  assertEqual(d.visualIntent?.type, "mixed", "B11 textual + visual → mixed");
}

{
  const d = route({ message: "What does the diagram on page 4 show?" });
  assertEqual(d.primaryRoute, "GENERAL", "B12 visual reference but NO sources → GENERAL");
  assert(!d.requiresVisualEvidence, "B12 no visual evidence without sources");
}

// ---------------------------------------------------------------------------
// C. STEP 36 negatives — idiomatic chat must never hit the tools
// ---------------------------------------------------------------------------
section("C. STEP 36 negatives");

{
  const d = route({ message: "The weather is nice today." });
  assertEqual(d.primaryRoute, "GENERAL", "C1 weather statement → GENERAL");
  assert(!d.requiresRealtime, "C1 never calls Open-Meteo");
}

{
  const d = route({ message: "Tell me a story about weather." });
  assertEqual(d.primaryRoute, "GENERAL", "C2 weather story request → GENERAL");
  assert(!d.requiresRealtime, "C2 never calls Open-Meteo");
}

{
  const d = route({ message: "What is Chennai?" });
  assertEqual(d.primaryRoute, "GENERAL", "C3 place-name question → GENERAL (not auto-weather)");
  assert(!d.requiresRealtime, "C3 no weather branch");
}

{
  // Phase 6G: "plan my <x>" is now deterministic planning language, owned by
  // the tasks+planning route — it must still NEVER become a date/real-time
  // query (the original C4 guard's intent is preserved).
  const d = route({ message: "plan my day for tomorrow" });
  assertEqual(d.primaryRoute, "PLAN_GENERATION", "C4 planning verb → PLAN_GENERATION (never a date query)");
  assert(!d.requiresRealtime, "C4 planning guard holds");
}

{
  const d = route({ message: "The date is set for Monday." });
  assertEqual(d.primaryRoute, "GENERAL", "C5 date-plain statement → GENERAL");
  assert(!d.requiresRealtime, "C5 no date tool");
}

{
  const d = route({ message: "We should meet tomorrow morning" });
  assertEqual(d.primaryRoute, "GENERAL", "C6 meeting/planning guard → GENERAL");
  assert(!d.requiresRealtime, "C6 never a date/time query");
}

// ---------------------------------------------------------------------------
// D. Follow-up resolution (anchored to the previous turn)
// ---------------------------------------------------------------------------
section("D. Follow-up resolution");

const WEATHER_PRIOR = [
  { role: "user" as const, content: "What is the weather in Chennai?" },
  { role: "assistant" as const, content: "It is 32°C in Chennai." },
];

{
  const d = route({ message: "what about tomorrow?", priorTurns: WEATHER_PRIOR });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "D1 bare temporal after weather → forecast for prior city");
  assertEqual(d.realtimeDecision?.intent, "WEATHER_FORECAST", "D1 forecast intent");
  assertEqual(d.realtimeDecision?.params?.location, "Chennai", "D1 anchored to Chennai");
  assertEqual(d.confidence, 0.9, "D1 anchored follow-up confidence");
}

{
  const d = route({ message: "what about tomorrow?" });
  assertEqual(d.primaryRoute, "REALTIME_DATE", "D2 no prior anchor → normal detection (DATE_QUERY) preserved");
}

{
  const d = route({ message: "and in Delhi?", priorTurns: WEATHER_PRIOR });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "D3 new-location weather follow-up → REALTIME_WEATHER");
  assertEqual(d.realtimeDecision?.params?.location, "Delhi", "D3 resolves to Delhi");
  assertEqual(d.confidence, 0.75, "D3 new-location confidence");
}

{
  const CURRENCY_PRIOR = [
    { role: "user" as const, content: "convert 100 USD to JPY" },
    { role: "assistant" as const, content: "100 USD is about 15,200 JPY." },
  ];
  const d = route({ message: "and in euros?", priorTurns: CURRENCY_PRIOR });
  assertEqual(d.primaryRoute, "REALTIME_CURRENCY", "D4 euro follow-up → REALTIME_CURRENCY");
  assertEqual(d.realtimeDecision?.params?.to, "EUR", "D4 'euros' → EUR (not a false 3-letter word)");
  assertEqual(d.confidence, 0.75, "D4 currency follow-up confidence");
}

{
  const TIME_PRIOR = [
    { role: "user" as const, content: "What time is it?" },
    { role: "assistant" as const, content: "It's 4:20 PM." },
  ];
  const d = route({ message: "and in Tokyo?", priorTurns: TIME_PRIOR });
  assertEqual(d.primaryRoute, "REALTIME_TIME", "D5 time follow-up with place → REALTIME_TIME");
  assertEqual(d.confidence, 0.75, "D5 time follow-up confidence");
}

{
  const DOC_PRIOR = [
    { role: "user" as const, content: "What does Unit 3 Question 2 say?" },
    { role: "assistant" as const, content: "It explains the water cycle." },
  ];
  const d = route({ message: "explain that more", priorTurns: DOC_PRIOR, hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "DOCUMENT_RAG", "D6 document follow-up → DOCUMENT_RAG");
  assert(d.requiresDocuments, "D6 requires the document branch");
  assertEqual(d.confidence, 0.9, "D6 document follow-up confidence");
}

{
  const d = route({ message: "explain that more", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "DOCUMENT_RAG", "D7 'explain that more' with sources (no prior) → DOCUMENT_RAG");
}

// ---------------------------------------------------------------------------
// E. Ambiguous deictics — clarification vs. safe fall-through
// ---------------------------------------------------------------------------
section("E. Ambiguous deictics");

{
  const d = route({ message: "what about that?", priorTurns: [{ role: "user", content: "hello there" }] });
  assertEqual(d.primaryRoute, "CLARIFICATION", "E1 unresolvable deictic → CLARIFICATION");
  assert(d.requiresClarification, "E1 clarification flag set");
  assert(d.requiresGeneralReasoning, "E1 Gemini still answers politely");
  assertEqual(d.confidenceLabel, "low", "E1 low confidence 0.55");
}

{
  const d = route({ message: "what about that?" });
  assertEqual(d.primaryRoute, "GENERAL", "E2 deictic without prior context → GENERAL (pre-6B fall-through)");
  assert(!d.requiresClarification, "E2 no clarification without context");
}

// ---------------------------------------------------------------------------
// F. Execution-plan bounds (no runaway routing)
// ---------------------------------------------------------------------------
section("F. Execution-plan bounds");

{
  const plans = [
    route({ message: "Hello there" }),
    route({ message: "What is the weather in Chennai?" }),
    route({ message: "What is 12 * 34?" }),
    route({ message: "What is photosynthesis?", hasSources: true, sourceCount: 1 }),
    route({ message: "What does the diagram on page 4 show?", hasSources: true, sourceCount: 1 }),
    route({ message: "According to my PDF, what is the weather in Chennai?", hasSources: true, sourceCount: 1 }),
    route({ message: "what about that?", priorTurns: [{ role: "user", content: "hello there" }] }),
  ];

  for (const d of plans) {
    const plan = d.executionPlan;
    assertEqual(plan?.maxDepth, 1, `F1 ${d.primaryRoute} maxDepth is 1 (router never re-enters)`);
    assert(plan != null && plan.maxExternalCalls >= 1 && plan.maxExternalCalls <= 4, `F2 ${d.primaryRoute} bounded external calls (${plan?.maxExternalCalls})`);
    assert(plan != null && plan.steps.length >= 1, `F3 ${d.primaryRoute} non-empty plan`);
    const hasGemini = plan?.steps.some((s) => s.kind === "gemini");
    assert(hasGemini === true, `F4 ${d.primaryRoute} plan always ends in the Gemini fusion step`);
    const noCycles = plan?.steps.every(
      (s) => s.dependsOn.every((dep) => plan.steps.findIndex((x) => x.id === dep) < plan.steps.indexOf(s))
    );
    assert(noCycles === true, `F5 ${d.primaryRoute} no dependency cycles`);
    assert(plan?.steps.every((s) => s.maxCalls >= 1) === true, `F6 ${d.primaryRoute} every step bounded`);
  }

  const hybrid = route({ message: "According to my PDF, what is the weather in Chennai?", hasSources: true, sourceCount: 1 });
  assert(hybrid.executionPlan?.parallelizable === true, "F7 HYBRID plan parallelizable");
  const realtimeStep = hybrid.executionPlan?.steps.find((s) => s.kind === "realtime");
  const geminiStep = hybrid.executionPlan?.steps.find((s) => s.kind === "gemini");
  assert(realtimeStep != null && geminiStep?.dependsOn.includes(realtimeStep.id) === true, "F8 hybrid Gemini depends on the real-time step");

  const general = route({ message: "Hello there" });
  assert(general.executionPlan?.parallelizable === false, "F9 single-route plan not parallelizable");
}

// ---------------------------------------------------------------------------
// G. Transparency & extension points
// ---------------------------------------------------------------------------
section("G. Transparency & extension points");

{
  const d = route({ message: "According to my PDF, what is the weather in Chennai?", hasSources: true, sourceCount: 1 });
  const desc = describeQueryRoute(d);
  assert(typeof desc === "string" && desc.includes("route=HYBRID"), "G1 describeQueryRoute reports HYBRID");
  assert(desc.includes("routes=") && desc.includes("conf="), "G2 describeQueryRoute is compact log text");
  assert(typeof d.reason === "string" && d.reason.length > 0, "G3 internal reason present (never sent to client)");
  assert(d.confidence >= 0 && d.confidence <= 1, "G4 confidence within [0,1]");
}

{
  const keys = Object.keys(EXTENSION_POINTS);
  assertEqual(keys.length, 7, "G5 seven extension slots");
  assert(
    keys.every((k) => ["IMAGE_GENERATION", "IMAGE_EDITING", "DOCUMENT_VISUAL_GENERATION", "WEB_SEARCH", "VOICE", "TASK", "MEMORY"].includes(k)),
    "G6 extension slot names match the taxonomy"
  );
  // Phase 6C activates IMAGE_GENERATION. Phase 6D adds IMAGE_EDITING.
  // Phase 6E adds DOCUMENT_VISUAL_GENERATION. Phase 6G adds TASK (chat-backed
  // task/planning commands). Every other extension slot stays declared-but-
  // inert (a future phase may light one up).
  assertEqual(EXTENSION_POINTS.IMAGE_GENERATION, true, "G7 IMAGE_GENERATION activated in 6C");
  assertEqual(EXTENSION_POINTS.IMAGE_EDITING, true, "G7 IMAGE_EDITING activated in 6D");
  assertEqual(
    EXTENSION_POINTS.DOCUMENT_VISUAL_GENERATION,
    true,
    "G7 DOCUMENT_VISUAL_GENERATION activated in 6E"
  );
  assertEqual(
    EXTENSION_POINTS.TASK,
    true,
    "G7 TASK activated in 6G (task/planning commands)"
  );
  assert(
    Object.entries(EXTENSION_POINTS)
      .filter(
        ([name]) =>
          name !== "IMAGE_GENERATION" &&
          name !== "IMAGE_EDITING" &&
          name !== "DOCUMENT_VISUAL_GENERATION" &&
          name !== "TASK"
      )
      .every(([, v]) => v === false),
    "G7 the other extension points stay declared but inert"
  );
}

{
  const d = route({ message: "What is the weather?" });
  assert(
    d.realtimeDecision?.reason != null && d.realtimeDecision.reason.length > 0,
    "G8 real-time decision rationale present internally"
  );
  assert(!d.requiresVisualEvidence, "G9 no accidental visual branch");
}

// ---------------------------------------------------------------------------
// H. Realtime tool result grounding is safe to fuse (no-hallucination seam)
// ---------------------------------------------------------------------------
section("H. No-hallucination seam");

{
  // The router carries the authoritative params; fusion happens via 6A's
  // buildRealtimeSystemInstruction at execution time, not by inventing values.
  const d = route({ message: "How many EUR is 100 USD?" });
  const p = d.realtimeDecision?.params;
  assertEqual(p?.from, "USD", "H1 authoritative from");
  assertEqual(p?.to, "EUR", "H1 authoritative to");
  assertEqual(p?.amount, 100, "H1 authoritative amount");

  const hybrid = route({ message: "According to my PDF, what is the weather in Chennai?", hasSources: true, sourceCount: 1 });
  assertEqual(hybrid.realtimeDecision?.params?.location, "Chennai", "H2 hybrid weather branch carries the verbatim location");

  const calc = route({ message: "What is 12 * 34" });
  assertEqual(calc.realtimeDecision?.params?.expression, "12 * 34", "H3 calculator carries the exact expression");
}

// ---------------------------------------------------------------------------
// I. Phase 6B Extended — domain advisory routes (STEP 55 EXACT phrasings)
// ---------------------------------------------------------------------------
section("I. Domain advisory routes (STEP 55)");

{
  const d = route({ message: "Can I spray pesticide in Coimbatore tomorrow?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "I1 pesticide spray → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "AGRICULTURE", "I1 agriculture domain");
  assertEqual(d.domainDecision?.location, "Coimbatore", "I1 location Coimbatore");
  assertEqual(d.domainDecision?.timeframe, "tomorrow", "I1 timeframe tomorrow");
  assert(d.requiresRealtime, "I1 rides the real-time layer");
  assert(!d.requiresGeneralReasoning, "I1 deterministic advisory, no Gemini");
}

{
  const d = route({ message: "Is tomorrow suitable for marine operations?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "I2 marine operations → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "MARINE", "I2 marine domain");
  assertEqual(d.domainDecision?.timeframe, "tomorrow", "I2 timeframe tomorrow");
}

{
  const d = route({ message: "What weather conditions are expected at Chennai airport?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "I3 airport question → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "AVIATION", "I3 aviation domain");
}

{
  const d = route({ message: "Is heavy rainfall expected tonight?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "I4 heavy rainfall → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "SMART_CITY", "I4 smart-city domain");
  assertEqual(d.domainDecision?.timeframe, "tonight", "I4 timeframe tonight");
}

{
  const d = route({ message: "Is tomorrow good for an outdoor event?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "I5 outdoor event → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "OUTDOOR", "I5 outdoor domain");
  assertEqual(d.domainDecision?.timeframe, "tomorrow", "I5 timeframe tomorrow");
}

{
  const d = route({ message: "Is tomorrow good for travelling to Chennai?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "I6 travelling → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "TRAVEL", "I6 travel domain");
  assertEqual(d.domainDecision?.timeframe, "tomorrow", "I6 timeframe tomorrow");
}

// ---------------------------------------------------------------------------
// J. Location resolution (STEP 55 — no hard-coded city in expectations)
// ---------------------------------------------------------------------------
section("J. Location resolution");

{
  const d = route({ message: "Should I water my crops in Coimbatore tomorrow?" });
  assertEqual(d.domainDecision?.domain, "AGRICULTURE", "J1 crop watering → AGRICULTURE");
  assertEqual(d.domainDecision?.location, "Coimbatore", "J1 explicit location extracted");
  assertEqual(d.domainDecision?.confidence, 0.94, "J1 explicit location raises confidence");
}

{
  const d = route({ message: "marine conditions near Chennai" });
  assertEqual(d.domainDecision?.domain, "MARINE", "J2 marine near Chennai → MARINE");
  assertEqual(d.domainDecision?.location, "Chennai", "J2 location near Chennai");
}

{
  const d = route({ message: "What weather conditions are expected at Chennai airport?" });
  assertEqual(d.domainDecision?.domain, "AVIATION", "J3 airport Chennai → AVIATION");
}

{
  const d = route({ message: "Will Chennai flood tonight?" });
  assertEqual(d.domainDecision?.domain, "SMART_CITY", "J4 Will Chennai flood → SMART_CITY");
  assertEqual(d.domainDecision?.location, "Chennai", "J4 subject-position location");
  assertEqual(d.domainDecision?.timeframe, "tonight", "J4 flood tonight");
}

{
  // Execution boundary: a domain message without a resolvable location is
  // routed, and the tool answers with a location-required prompt (never an
  // invented place). Verified synchronously through the decision shape.
  const d = route({ message: "Can I spray pesticide tomorrow?" });
  assertEqual(d.domainDecision?.location, null, "J5 no location assumed");
  assertEqual(d.domainDecision?.timeframe, "tomorrow", "J5 timeframe still resolved");
}

// ---------------------------------------------------------------------------
// K. Follow-up context inheritance (STEP 29/30 — location + timeframe)
// ---------------------------------------------------------------------------
section("K. Follow-up context inheritance");

{
  const prior = [
    { role: "user" as const, content: "What is the weather in Chennai?" },
    { role: "assistant" as const, content: "It's 32°C in Chennai." },
  ];
  const d = route({ message: "what about tomorrow?", priorTurns: prior });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "K1 what about tomorrow → REALTIME_WEATHER");
  assertEqual(d.realtimeDecision?.params?.location, "Chennai", "K1 inherited location");
}

{
  const prior = [
    { role: "user" as const, content: "What is the weather in Chennai?" },
    { role: "assistant" as const, content: "It's 32°C in Chennai." },
  ];
  const d = route({ message: "what about farming?", priorTurns: prior });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "K2 bare farming follow-up → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "AGRICULTURE", "K2 agriculture domain");
  assertEqual(d.domainDecision?.location, "Chennai", "K2 location inherited from prior turn");
}

{
  const prior = [
    { role: "user" as const, content: "What is the weather in Chennai tomorrow?" },
  ];
  const d = route({ message: "what about marine conditions?", priorTurns: prior });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "K3 marine follow-up → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "MARINE", "K3 marine domain");
  assertEqual(d.domainDecision?.location, "Chennai", "K3 marine location inherited");
  assertEqual(d.domainDecision?.timeframe, "tomorrow", "K3 marine timeframe inherited");
}

{
  // Multiple distinct locations → no inheritance → the tool asks (safe).
  const prior = [
    { role: "user" as const, content: "What is the weather in Chennai?" },
    { role: "user" as const, content: "What is the weather in Mumbai?" },
  ];
  const d = route({ message: "what about farming?", priorTurns: prior });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "K4 farming follow-up after two cities → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.location, null, "K4 no location inherited when ambiguous");
}

// ---------------------------------------------------------------------------
// L. Document guard (STEP 32 — document priority preserved)
// ---------------------------------------------------------------------------
section("L. Document guard preserved");

{
  const d = route({ message: "According to my PDF, when should I spray pesticide on crops?", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "HYBRID", "L1 doc + agriculture + sources → HYBRID");
  assert(d.routes.includes("DOCUMENT_RAG"), "L1 document branch in the plan");
  assert(d.routes.includes("DOMAIN_REALTIME"), "L1 domain branch in the plan");
  assertEqual(d.domainDecision?.domain, "AGRICULTURE", "L1 domain decision carried");
}

{
  const d = route({ message: "According to my PDF, when should I spray pesticide on crops?" });
  assertEqual(d.primaryRoute, "GENERAL", "L2 doc reference without sources → GENERAL");
  assertEqual(d.domainDecision, undefined, "L2 domain probe stands down with the document guard");
  assert(!d.requiresRealtime, "L2 no real-time branch without sources to ground the doc");
}

{
  const d = route({ message: "Compare the farming recommendations in my PDF with tomorrow's weather.", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "HYBRID", "L3 PDF vs weather compare → HYBRID");
  assert(d.routes.includes("DOCUMENT_RAG"), "L3 document retrieval runs");
  assert(d.routes.includes("DOMAIN_REALTIME"), "L3 agriculture advisory runs in parallel");
  assertEqual(d.domainDecision?.domain, "AGRICULTURE", "L3 domain decision");
}

{
  const d = route({ message: "According to my PDF, when should I spray pesticide on crops?", hasSources: true, sourceCount: 1 });
  assert(d.executionPlan?.parallelizable ?? false, "L4 hybrid branches are parallelizable");
}

// ---------------------------------------------------------------------------
// M. Negatives — casual chat / knowledge es never reaches a provider
// ---------------------------------------------------------------------------
section("M. Domain negatives");

{
  const d = route({ message: "The weather is nice." });
  assertEqual(d.primaryRoute, "GENERAL", "M1 weather statement → GENERAL");
  assertEqual(d.domainDecision, undefined, "M1 no domain probe fired");
}

{
  const d = route({ message: "Tell me a story about farming." });
  assertEqual(d.primaryRoute, "GENERAL", "M2 farming story → GENERAL");
  assertEqual(d.domainDecision, undefined, "M2 no domain probe fired");
}

{
  const d = route({ message: "Explain marine biology." });
  assertEqual(d.primaryRoute, "GENERAL", "M3 explain marine biology → GENERAL");
  assertEqual(d.domainDecision, undefined, "M3 knowledge request never hits the marine provider");
}

{
  const d = route({ message: "What is aviation?" });
  assertEqual(d.primaryRoute, "GENERAL", "M4 what is aviation → GENERAL");
  assertEqual(d.domainDecision, undefined, "M4 definition never fires the domain tool");
}

{
  const d = route({ message: "What does the word weather mean?" });
  assertEqual(d.primaryRoute, "GENERAL", "M5 what does weather mean → GENERAL");
}

{
  const d = route({ message: "What is the weather?" });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "M6 bare weather prompt still direct real-time");
}

// ---------------------------------------------------------------------------
// N. Safety boundaries (STEP 73 — never claim official approval/clearance)
// ---------------------------------------------------------------------------
section("N. Safety boundaries");

{
  // "100% safe" for a boat ride must never become a definitive safety grant.
  const d = route({ message: "Is it 100% safe to operate my boat tomorrow?" });
  assertEqual(d.primaryRoute, "REALTIME_DATE", "N1 boat ride tomorrow → date query, NOT a marine safety grant");
  assertEqual(d.domainDecision, undefined, "N1 no advisory axes a definitive safety answer");
}

{
  const d = route({ message: "Can I spray pesticide tomorrow?" });
  assertEqual(d.domainDecision?.domain, "AGRICULTURE", "N2 spray without location still a domain turn");
  assertEqual(d.domainDecision?.location, null, "N2 no location invented");
}

{
  const d = route({ message: "How can I tell if my crops are ready for harvest?" });
  assertEqual(d.primaryRoute, "GENERAL", "N3 harvest-knowledge question → GENERAL");
  assertEqual(d.domainDecision, undefined, "N3 no advisory for idle curiosity about harvest");
}

{
  const d = route({ message: "Is my flight to Delhi likely to land on time tomorrow?" });
  assertEqual(d.primaryRoute, "GENERAL", "N4 flight punctuality → GENERAL (not an aviation clearance)");
  assertEqual(d.domainDecision, undefined, "N4 aviation advisories answer WEATHER, not clearance");
}

// ---------------------------------------------------------------------------
// O. Location-extraction repair (regression for the Delhi-airport bug)
// ---------------------------------------------------------------------------
// Phase 6B browser validation exposed: after "What weather conditions are
// expected at Delhi airport?", the bot wrongly asked "Which location should
// I check?" even though the user had already given the location. Root cause
// was a leftmost-preposition tail regex in extractDomainLocation plus missing
// airport/phrase handling and no multi-sentence inspection. This section pins
// the fixed behavior.
section("O. Location-extraction repair");

{
  const d = route({ message: "What weather conditions are expected at Delhi airport?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O1 Delhi airport → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "AVIATION", "O1 aviation domain");
  assertEqual(d.domainDecision?.location, "Delhi", "O1 explicit location extracted (no location prompt)");
}

{
  const d = route({ message: "What's the weather at Chennai airport?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O2 Chennai airport → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "AVIATION", "O2 aviation domain");
  assertEqual(d.domainDecision?.location, "Chennai", "O2 'Chennai airport' resolves to Chennai");
}

{
  const d = route({ message: "What are the marine conditions near Mumbai?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O3 marine near Mumbai → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "MARINE", "O3 marine domain");
  assertEqual(d.domainDecision?.location, "Mumbai", "O3 location Mumbai (not the whole tail)");
}

{
  const d = route({ message: "Is tomorrow suitable for marine operations near Chennai?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O4 marine near Chennai → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "MARINE", "O4 marine domain");
  assertEqual(d.domainDecision?.location, "Chennai", "O4 location extracted past 'marine operations'");
  assertEqual(d.domainDecision?.timeframe, "tomorrow", "O4 timeframe tomorrow");
}

{
  const d = route({ message: "Is heavy rainfall expected tonight in Chennai?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O5 heavy rainfall Chennai → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "SMART_CITY", "O5 smart-city domain");
  assertEqual(d.domainDecision?.location, "Chennai", "O5 location Chennai");
  assertEqual(d.domainDecision?.timeframe, "tonight", "O5 timeframe tonight");
}

{
  const d = route({ message: "Is heavy rainfall expected tonight in Delhi?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O6 heavy rainfall Delhi → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "SMART_CITY", "O6 smart-city domain");
  assertEqual(d.domainDecision?.location, "Delhi", "O6 location Delhi");
}

{
  const d = route({ message: "Can I spray pesticide tomorrow in Coimbatore?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O7 pesticide Coimbatore → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "AGRICULTURE", "O7 agriculture domain");
  assertEqual(d.domainDecision?.location, "Coimbatore", "O7 location Coimbatore");
}

{
  const d = route({ message: "Is tomorrow good for outdoor activities in Bangalore?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O8 outdoor Bangalore → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "OUTDOOR", "O8 outdoor domain");
  assertEqual(d.domainDecision?.location, "Bangalore", "O8 location Bangalore (activities not captured)");
}

{
  const d = route({ message: "What weather conditions are expected at Delhi airport?\nIs heavy rainfall expected tonight?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O9 multi-sentence → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "AVIATION", "O9 primary aviation domain");
  assertEqual(d.domainDecision?.location, "Delhi", "O9 sentence 1's explicit location kept (no location prompt)");
  assertEqual(d.domainDecision?.timeframe, "tonight", "O9 sentence 2's timeframe 'tonight'");
  assert(d.domainDecision?.relatedDomains?.some((x) => x.domain === "SMART_CITY") ?? false, "O9 compound SMART_CITY branch carried");
}

{
  const d = route({ message: "What is the weather at Delhi airport and is heavy rainfall expected tonight?" });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O10 compound sentence → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "AVIATION", "O10 primary aviation domain");
  assertEqual(d.domainDecision?.location, "Delhi", "O10 compound location Delhi");
  assert(d.domainDecision?.relatedDomains?.some((x) => x.domain === "SMART_CITY") ?? false, "O10 compound SMART_CITY advisory carried");
  assertEqual(d.domainDecision?.relatedDomains?.find((x) => x.domain === "SMART_CITY")?.timeframe, "tonight", "O10 secondary timeframe tonight");
}

{
  const d = route({ message: "What is the weather?" });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "O11 bare weather prompt stays direct real-time");
  assertEqual(d.realtimeDecision?.params?.location, "", "O11 empty location → tool asks which location (unchanged)");
}

{
  const d = route({ message: "The weather is nice today." });
  assertEqual(d.primaryRoute, "GENERAL", "O12 weather statement → GENERAL");
  assertEqual(d.domainDecision, undefined, "O12 'nice' is not location extraction");
}

{
  const d = route({ message: "Tell me a story about Delhi." });
  assertEqual(d.primaryRoute, "GENERAL", "O13 story about Delhi → GENERAL");
  assertEqual(d.domainDecision, undefined, "O13 no domain probe from named place");
}

{
  const d = route({ message: "Explain Delhi's history." });
  assertEqual(d.primaryRoute, "GENERAL", "O14 Delhi's history → GENERAL");
  assertEqual(d.domainDecision, undefined, "O14 possessive city name never triggers advisory");
}

{
  const d = route({ message: "What does my PDF say about Delhi weather?", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "DOCUMENT_RAG", "O15 PDF about Delhi weather → DOCUMENT_RAG");
  assertEqual(d.realtimeDecision, undefined, "O15 document query alone never routes realtime");
}

{
  const d = route({ message: "Compare today's Delhi weather with my PDF.", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "HYBRID", "O16 compare Delhi weather with PDF → HYBRID");
  assert(d.routes.includes("DOCUMENT_RAG"), "O16 document branch in the plan");
  assert(d.routes.includes("REALTIME_WEATHER"), "O16 real-time branch in the plan");
  assertEqual(d.realtimeDecision?.params?.location, "Delhi", "O16 comparison location Delhi");
}

{
  const d = route({ message: "Compare today's Delhi weather with my PDF." });
  assertEqual(d.primaryRoute, "GENERAL", "O16b compare without sources → GENERAL");
}

{
  const prior = [
    { role: "user" as const, content: "What is the weather in Chennai?" },
    { role: "assistant" as const, content: "It's 32°C in Chennai." },
  ];
  const d = route({ message: "What about tomorrow?", priorTurns: prior });
  assertEqual(d.primaryRoute, "REALTIME_WEATHER", "O17 what about tomorrow → REALTIME_WEATHER");
  assertEqual(d.realtimeDecision?.params?.location, "Chennai", "O17 Chennai carried into next-day follow-up");
}

{
  const prior = [
    { role: "user" as const, content: "What is the weather in Chennai?" },
    { role: "assistant" as const, content: "It's 32°C in Chennai." },
    { role: "user" as const, content: "What about tomorrow?" },
    { role: "assistant" as const, content: "Tomorrow looks similar in Chennai." },
  ];
  const d = route({ message: "Is it suitable for farming?", priorTurns: prior });
  assertEqual(d.primaryRoute, "DOMAIN_REALTIME", "O18 farming follow-up → DOMAIN_REALTIME");
  assertEqual(d.domainDecision?.domain, "AGRICULTURE", "O18 agriculture domain");
  assertEqual(d.domainDecision?.location, "Chennai", "O18 Chennai never re-asked after earlier turn");
}

console.log(`\n============================================================`);
console.log(`Phase 6B results: ${passed} passed, ${failed} failed`);
console.log(`============================================================`);

if (failed > 0) {
  process.exitCode = 1;
}