// ---------------------------------------------------------------------------
// Automated tests for Phase 8A — Agent Controller (pure, deterministic).
// Run with: npx tsx test-phase8a.ts
//
// 8A is a classification layer ABOVE the Phase 6B central query router. It
// REUSES every existing detector (routeQuery, derivePlaceQuery, nearMePhrase)
// and only adds the signals routeQuery was never asked to see: a shared
// location and the turn's input modality. It NEVER executes anything — this
// suite locks down the taxonomy mapping only.
//
//   A. Basic chat            → CHAT
//   B. Student / general     → CHAT
//   C. Document questions    → DOCUMENT_RAG
//   D. Web research          → WEB_RESEARCH
//   E. Hybrid RAG + web      → HYBRID_RAG_WEB
//   F. Image understanding   → IMAGE_UNDERSTANDING
//   G. Image generation      → IMAGE_GENERATION (generate/edit/document_visual)
//   H. Voice input           → VOICE (modality never hijacks a capability)
//   I. Location-aware        → LOCATION
//   J. Maps                  → MAPS (only WITH a shared location)
//   K. Multimodal            → MULTIMODAL (image + web / visual + textual)
//   L. Ambiguous             → CLARIFICATION / CHAT (never a fabricated tool)
//   M. Empty/invalid         → UNKNOWN (low confidence, honest fallback)
//   N. Case variations       → same route regardless of casing
//   O. False-positive guard  → no fabricated maps/location/web/image
//   P. Fallback behaviour    → low confidence always resolves to an existing
//                              capability (execution drives the 6B decision)
//   Q. Detector compatibility → underlying decision === fresh routeQuery()
//
// No live network / Supabase / Gemini calls.
// ---------------------------------------------------------------------------

import {
  classifyAgentRoute,
  credibleMapQuery,
} from "./src/lib/agent";
import { routeQuery } from "./src/lib/agent";
import type { ImageContextRef } from "./src/lib/image-generation";
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
  images?: ImageContextRef[];
  inputModality?: "text" | "voice";
  location?: SharedLocation | null;
  freshUploadedImage?: boolean;
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
  subjectId?: string;
  topicId?: string;
  mode?: string;
}

function classify(req: Req) {
  return classifyAgentRoute({
    userId: "u1",
    message: req.message,
    mode: req.mode ?? "general",
    hasSources: Boolean(req.hasSources),
    ...(req.sourceCount != null ? { sourceCount: req.sourceCount } : {}),
    ...(req.images ? { images: req.images } : {}),
    ...(req.priorTurns ? { priorTurns: req.priorTurns } : {}),
    ...(req.subjectId ? { subjectId: req.subjectId } : {}),
    ...(req.topicId ? { topicId: req.topicId } : {}),
    location: req.location ?? null,
    inputModality: req.inputModality,
    freshUploadedImage: req.freshUploadedImage,
  });
}

const LOCATION: SharedLocation = { latitude: 28.61, longitude: 77.21 };

// ===========================================================================
// A. Basic chat
// ===========================================================================
{
  assertEqual(classify({ message: "hello" }).route, "CHAT", "A_HELLO_ROUTE");
  assertEqual(classify({ message: "thanks!" }).route, "CHAT", "A_THANKS_ROUTE");
}

// ===========================================================================
// B. Student / general questions (no sources, no web, no image)
// ===========================================================================
{
  const q1 = classify({ message: "Can you explain the water cycle?", mode: "student" });
  assertEqual(q1.route, "CHAT", "B_STUDENT_EXPLAIN_ROUTE");
  assertEqual(q1.underlying.primaryRoute, "GENERAL", "B_STUDENT_UNDERLYING");

  const q2 = classify({ message: "How do I solve a quadratic equation? " });
  assertEqual(q2.route, "CHAT", "B_MATH_ROUTE");
}

// ===========================================================================
// C. Document questions → DOCUMENT_RAG (sources attached)
// ===========================================================================
{
  const doc = classify({
    message: "What does my notes say about photosynthesis?",
    hasSources: true,
    sourceCount: 2,
  });
  assertEqual(doc.route, "DOCUMENT_RAG", "C_DOC_ROUTE");
  assert(doc.confidence >= 0.5, "C_DOC_CONFIDENCE");

  // Without sources the same wording must NOT fabricate a document read.
  assertEqual(
    classify({ message: "What does my notes say about photosynthesis?" }).route,
    "CHAT",
    "C_NO_SOURCES_NOT_RAG"
  );
}

// ===========================================================================
// D. Web research → WEB_RESEARCH (freshness, no sources)
// ===========================================================================
{
  const web = classify({ message: "What is the latest React version?" });
  assertEqual(web.route, "WEB_RESEARCH", "D_WEB_ROUTE");
  assertEqual(web.metadata.requiresWeb, true, "D_WEB_REQUIRES_WEB");
}

// ===========================================================================
// E. Hybrid RAG + web → HYBRID_RAG_WEB (document sources AND web research)
// ===========================================================================
{
  const hybrid = classify({
    message: "Summarize what my notes say and check the latest research on the topic",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(hybrid.route, "HYBRID_RAG_WEB", "E_HYBRID_ROUTE");
  assertEqual(hybrid.underlying.primaryRoute, "DOCUMENT_RAG", "E_HYBRID_UNDERLYING_DOC");
  assertEqual(hybrid.underlying.requiresWeb, true, "E_HYBRID_UNDERLYING_WEB");
}

// ===========================================================================
// F. Image understanding → IMAGE_UNDERSTANDING (fresh image or visual refs)
// ===========================================================================
{
  const upload = classify({ message: "what is this?", freshUploadedImage: true });
  assertEqual(upload.route, "IMAGE_UNDERSTANDING", "F_UPLOAD_IDENTIFY");

  const describe = classify({ message: "describe this photo", freshUploadedImage: true });
  assertEqual(describe.route, "IMAGE_UNDERSTANDING", "F_UPLOAD_DESCRIBE");

  const visualRef = classify({
    message: "Look at the figure on page 5 and summarize it",
    hasSources: true,
    sourceCount: 1,
  });
  const visualOkay =
    visualRef.route === "IMAGE_UNDERSTANDING" || visualRef.route === "MULTIMODAL";
  assert(visualOkay, "F_VISUAL_REF_ROUTE");

  // A fresh image is honoured across specialist routes only when sensible.
  const gen = classify({ message: "draw a cat", freshUploadedImage: false });
  assertEqual(gen.route, "IMAGE_GENERATION", "F_GEN_STAYS_GEN");
}

// ===========================================================================
// G. Image generation → IMAGE_GENERATION (generate / edit / document_visual)
// ===========================================================================
{
  const gen = classify({ message: "draw a red bicycle" });
  assertEqual(gen.route, "IMAGE_GENERATION", "G_GENERATE_ROUTE");
  assertEqual(gen.metadata.imageOperation, "generate", "G_GENERATE_OP");

  const edit = classify({
    message: "make the sky sunset in the image",
    images: [{ key: "img-1" }],
  });
  assertEqual(edit.route, "IMAGE_GENERATION", "G_EDIT_ROUTE");
  assertEqual(edit.metadata.imageOperation, "edit", "G_EDIT_OP");
  assertEqual(edit.underlying.primaryRoute, "IMAGE_EDIT", "G_EDIT_UNDERLYING");

  const docVisual = classify({
    message: "create an infographic from my notes",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(docVisual.route, "IMAGE_GENERATION", "G_DOC_VISUAL_ROUTE");
  assertEqual(docVisual.metadata.imageOperation, "document_visual", "G_DOC_VISUAL_OP");
}

// ===========================================================================
// H. Voice input → VOICE (modality never hijacks a real capability)
// ===========================================================================
{
  const voice = classify({ message: "tell me a joke", inputModality: "voice" });
  assertEqual(voice.route, "VOICE", "H_VOICE_ROUTE");
  assertEqual(voice.metadata.inputModality, "voice", "H_VOICE_METADATA");

  const typed = classify({ message: "tell me a joke", inputModality: "text" });
  assertEqual(typed.route, "CHAT", "H_TYPED_ROUTE");

  const voiceWeather = classify({
    message: "what is the weather in chennai",
    inputModality: "voice",
  });
  assertEqual(voiceWeather.route, "REALTIME", "H_VOICE_WEATHER_NOT_VOICE");
  assertEqual(voiceWeather.metadata.inputModality, "voice", "H_VOICE_MODALITY_RETAINED");

  const voiceImage = classify({
    message: "describe this photo",
    inputModality: "voice",
    freshUploadedImage: true,
  });
  assertEqual(voiceImage.route, "IMAGE_UNDERSTANDING", "H_VOICE_IMAGE_NOT_VOICE");
}

// ===========================================================================
// I. Location-aware → LOCATION (shared location + near-me wording, no map noun)
// ===========================================================================
{
  const around = classify({ message: "what's around here?", location: LOCATION });
  assertEqual(around.route, "LOCATION", "I_AROUND_HERE");

  const whereAmI = classify({ message: "where am I currently?", location: LOCATION });
  assertEqual(whereAmI.route, "LOCATION", "I_WHERE_AM_I");

  // Location alone is context; without near-me wording the turn stays CHAT.
  assertEqual(
    classify({ message: "tell me a fun fact", location: LOCATION }).route,
    "CHAT",
    "I_LOCATION_ISNOT_ASK"
  );
}

// ===========================================================================
// J. Maps → MAPS (shared location AND credible near-me place noun)
// ===========================================================================
{
  const hospitals = classify({ message: "find hospitals near me", location: LOCATION });
  assertEqual(hospitals.route, "MAPS", "J_HOSPITALS_ROUTE");
  assertEqual(hospitals.metadata.mapQuery, "hospitals", "J_HOSPITALS_QUERY");

  const coffee = classify({ message: "coffee shops around here", location: LOCATION });
  assertEqual(coffee.route, "MAPS", "J_COFFEE_ROUTE");
  assertEqual(coffee.metadata.mapQuery, "coffee shops", "J_COFFEE_QUERY");

  // The SAME turn without a shared location must NOT fabricate a map.
  const noLoc = classify({ message: "find hospitals near me", location: null });
  assertEqual(noLoc.route, "CHAT", "J_NO_LOCATION_NOT_MAPS");
}

// ===========================================================================
// K. Multimodal → MULTIMODAL (image + web fuse; visual + textual analysis)
// ===========================================================================
{
  const buyWeb = classify({
    message: "Where can I buy this product online?",
    freshUploadedImage: true,
  });
  assertEqual(buyWeb.route, "MULTIMODAL", "K_IMAGE_PLUS_WEB");
  assertEqual(buyWeb.underlying.primaryRoute, "WEB_RESEARCH", "K_IMAGE_PLUS_WEB_UNDERLYING");

  // The plain web-image request without an image stays WEB_RESEARCH.
  assertEqual(
    classify({ message: "show me images of cats" }).route,
    "WEB_RESEARCH",
    "K_WEB_IMAGE_NOT_MULTIMODAL"
  );
}

// ===========================================================================
// L. Ambiguous → CLARIFICATION (never a fabricated tool)
// ===========================================================================
{
  const amb = classify({ message: "explain that again" });
  assert(
    amb.route === "CLARIFICATION" || amb.route === "CHAT",
    "L_AMBIGUOUS_NO_FABRICATION"
  );
}

// ===========================================================================
// M. Empty / invalid → UNKNOWN (honest low-confidence fallback)
// ===========================================================================
{
  const empty = classify({ message: "" });
  assertEqual(empty.route, "UNKNOWN", "M_EMPTY_ROUTE");
  assertEqual(empty.confidenceLabel, "low", "M_EMPTY_LOW_CONFIDENCE");
  assert(empty.underlying.primaryRoute.length > 0, "M_EMPTY_STILL_EXECUTES");

  const whitespace = classify({ message: "    " });
  assertEqual(whitespace.route, "UNKNOWN", "M_WHITESPACE_ROUTE");
}

// ===========================================================================
// N. Case variations → identical classification regardless of casing
// ===========================================================================
{
  const upper = classify({ message: "FIND HOSPITALS NEAR ME", location: LOCATION });
  assertEqual(upper.route, "MAPS", "N_UPPER_MAPS_ROUTE");
  assertEqual(upper.metadata.mapQuery, "HOSPITALS", "N_UPPER_MAPS_QUERY");

  const gen = classify({ message: "Draw A Red Bicycle" });
  assertEqual(gen.route, "IMAGE_GENERATION", "N_UPPER_GENERATION_ROUTE");

  const web = classify({ message: "WHAT IS THE LATEST REACT VERSION?" });
  assertEqual(web.route, "WEB_RESEARCH", "N_UPPER_WEB_ROUTE");
}

// ===========================================================================
// O. False-positive prevention — nothing is ever fabricated
// ===========================================================================
{
  // Derived "place" that is really a real-time noun must NOT become a map.
  const weatherNearMe = classify({
    message: "show me the weather near me",
    location: LOCATION,
  });
  assert(weatherNearMe.route !== "MAPS", "O_WEATHER_NEAR_ME_NOT_MAPS");

  // No shared location → no LOCATION/MAPS classification of any kind.
  const whereNearMe = classify({ message: "find me somewhere nice nearby", location: null });
  assert(whereNearMe.route !== "MAPS" && whereNearMe.route !== "LOCATION", "O_NO_LOC_NO_MAP");

  // A fresh image alone with an explicit generation ask stays generation.
  const genWithImage = classify({
    message: "draw a castle",
    freshUploadedImage: true,
    images: [{ key: "img-1" }],
  });
  assertEqual(genWithImage.route, "IMAGE_GENERATION", "O_IMAGE_DOES_NOT_HIJACK_GEN");

  // credibleMapQuery guard itself.
  assertEqual(credibleMapQuery(null), false, "O_CREDIBLE_NULL");
  assertEqual(credibleMapQuery("what is weather"), false, "O_CREDIBLE_QUESTION_FRAG");
  assertEqual(credibleMapQuery("weather"), false, "O_CREDIBLE_REALTIME_NOUN");
  assertEqual(credibleMapQuery("hospitals"), true, "O_CREDIBLE_PLACE");
}

// ===========================================================================
// P. Fallback behaviour — UNKNOWN stays low-confidence; everything else
//    resolves to an existing capability and carries a usable 6B decision.
// ===========================================================================
{
  const unk = classify({ message: "          " });
  assertEqual(unk.route, "UNKNOWN", "P_FALLBACK_ROUTE");
  assertEqual(unk.confidence, 0.2, "P_FALLBACK_CONFIDENCE");

  const any = classify({ message: "hello there" });
  assert(any.route !== "UNKNOWN", "P_NORMAL_NOT_UNKNOWN");
  assert(any.underlying.primaryRoute.length > 0, "P_UNDERLYING_ALWAYS_PRESENT");

  // Every signal bucket stays within the closed taxonomy of existing routes.
  const routes = [
    "CHAT", "DOCUMENT_RAG", "WEB_RESEARCH", "HYBRID_RAG_WEB", "HYBRID",
    "IMAGE_UNDERSTANDING", "IMAGE_GENERATION", "VOICE", "LOCATION", "MAPS",
    "MULTIMODAL", "REALTIME", "TASK_MANAGEMENT", "CLARIFICATION", "UNKNOWN",
  ];
  const offenders = [
    classify({ message: "hi" }).route,
    classify({ message: "draw a dog" }).route,
    classify({ message: "what is the latest news", hasSources: true }).route,
  ].filter((r) => !routes.includes(r));
  assertEqual(offenders.length, 0, "P_TAXONOMY_CLOSED_OVER");
}

// ===========================================================================
// Q. Existing detector compatibility — the underlying decision is byte-for-byte
//    what routeQuery() itself would have returned for the same inputs.
// ===========================================================================
{
  const samples: Req[] = [
    { message: "hello" },
    { message: "What is the latest React version?" },
    { message: "What does my notes say about ww2?", hasSources: true, sourceCount: 1 },
    { message: "draw a blue car" },
    { message: "what is the weather in chennai" },
    { message: "Where can I buy this product online?", freshUploadedImage: true },
  ];

  for (const sample of samples) {
    const controlled = classify(sample);
    // Mirror the controller's upload-image normalization so the direct 6B
    // comparison sees the exact same image-context the controller passed.
    const directImages = [
      ...(sample.images ?? []),
      ...(sample.freshUploadedImage && !(sample.images ?? []).some((r) => r.key === "upload")
        ? [{ key: "upload" }]
        : []),
    ];
    const direct = routeQuery({
      userId: "u1",
      message: sample.message,
      mode: sample.mode ?? "general",
      hasSources: Boolean(sample.hasSources),
      ...(directImages.length > 0 ? { images: directImages } : {}),
    });
    assertEqual(
      controlled.underlying.primaryRoute,
      direct.primaryRoute,
      `Q_UNDERLYING_MATCH_${direct.primaryRoute}`
    );
    assertEqual(
      controlled.underlying.requiresWeb,
      direct.requiresWeb,
      `Q_UNDERLYING_WEB_MATCH_${direct.primaryRoute}`
    );
  }
}

// Summary
console.log("--------------------------------------------------");
console.log(`Phase 8A tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Phase 8A test suite FAILED");
  process.exitCode = 1;
} else {
  console.log("Phase 8A test suite PASSED");
}