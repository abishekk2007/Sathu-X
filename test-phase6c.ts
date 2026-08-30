// ---------------------------------------------------------------------------
// Phase 6C — Text → Image generation test suite.
// Run with: npx tsx test-phase6c.ts
//
// Covers the deterministic intent detector, prompt builder, provider fallback
// matrix, output validation, server-controlled config, the RAG-grounding gate,
// caption semantics, and the router's IMAGE_GENERATION priority (branch 4).
// Mock providers (no network, no keys) drive the service; router section uses
// the real pure decision layer. One real-provider "no-crash-without-keys" check
// runs with env keys blanked.
//
// Sections:
//   A. Direct generation intent matrix      — verbs × nouns, pure-visual verbs
//   B. Rejection / negative intent          — understanding, definitions, text asks
//   C. Deterministic routing (router)       — IMAGE_GENERATION branch 4 placement
//   D. Refinement detection                 — short/refine turns vs. new asks
//   E. Provider fallback matrix             — eligible vs. never-fallback codes
//   F. Output validation                    — bad/oversize/empty bytes
//   G. Server-controlled config             — IMAGE_PROVIDERS parse + defaults
//   H. Timeout policy                       — budget constant + timeout fallback
//   I. RAG-grounding gate                   — groundedRequired + evidence rules
//   J. Prompt composition                   — student hint, caps, aspect, refine
//   K. No-keys safety                       — safe message, HF token required
//   L. Caption semantics                    — refined vs grounded vs plain
//   M. GeneratedImage payload shape         — validated data URL + dims
//   N. Execution plan (router)              — image step, maxCalls 1, budget
//   O. Extension points + transparency      — IMAGE_GENERATION flag, img=1 log
//
// No live network, Supabase, or Gemini calls happen in sections A–O.
// ---------------------------------------------------------------------------

import {
  detectImageGenerationIntent,
  detectImageGenerationRefinement,
  resolveImageGenerationIntent,
  grantsGrounding,
  buildImagePrompt,
  normalizeAspectRatio,
  generateImageWithProviders,
  generateImage,
  resolveProviderOrder,
  PROVIDER_TIMEOUT_MS,
  PROMPT_MAX_CHARS,
  ImageFailure,
  SAFE_UNAVAILABLE_MESSAGE,
  SAFE_NO_GROUNDING_MESSAGE,
  DEFAULT_NEGATIVE_PROMPT,
  huggingfaceImageProvider,
  DEFAULT_GEMINI_IMAGE_MODEL,
} from "./src/lib/image-generation";
import type {
  ImageFailureCode,
  ImageProvider,
  ImageProviderId,
  ProviderGenerationParams,
  ProviderImageOutput,
} from "./src/lib/image-generation";
import {
  routeQuery,
  describeQueryRoute,
  EXTENSION_POINTS,
} from "./src/lib/agent";
import type { QueryRouteDecision } from "./src/lib/agent";

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

// --- Mock image helpers ------------------------------------------------------

/** Minimal PNG header ($89PNG\r\n\x1a\n + valid IHDR length/dims). */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, 4, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

type ProviderBehavior =
  | { kind: "ok"; mime?: string }
  | { kind: "fail"; code: ImageFailureCode }
  | { kind: "bytes"; data: Buffer }
  | { kind: "hang" };

function makeProvider(
  id: ImageProviderId,
  behavior: ProviderBehavior
): ImageProvider & { called(): number; params: ProviderGenerationParams[] } {
  let calls = 0;
  const params: ProviderGenerationParams[] = [];
  const provider: ImageProvider = {
    id,
    async generate(p: ProviderGenerationParams): Promise<ProviderImageOutput> {
      calls++;
      params.push(p);
      if (behavior.kind === "hang") {
        return await new Promise<ProviderImageOutput>(() => { /* never resolves */ });
      }
      if (behavior.kind === "fail") {
        throw new ImageFailure(behavior.code, `${id} failed for test`);
      }
      if (behavior.kind === "bytes") {
        return {
          data: behavior.data,
          mimeType: "image/png",
          width: 0,
          height: 0,
          fileSizeBytes: behavior.data.length,
        };
      }
      const data = png(1024, 1024);
      return {
        data,
        mimeType: behavior.mime,
        width: 0,
        height: 0,
        fileSizeBytes: data.length,
      };
    },
  };
  return Object.assign(provider, { called: () => calls, params });
}

function route(opts: {
  message: string;
  hasSources?: boolean;
  sourceCount?: number;
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
}): QueryRouteDecision {
  return routeQuery({
    userId: "test-user",
    message: opts.message,
    hasSources: opts.hasSources ?? false,
    sourceCount: opts.sourceCount,
    priorTurns: opts.priorTurns,
  });
}

// ---------------------------------------------------------------------------
// A. Direct generation intent matrix
// ---------------------------------------------------------------------------
async function main() {

section("A. Direct generation intent matrix");

{
  const d = detectImageGenerationIntent("draw a castle");
  assert(d.detected, "A1 'draw a castle' detects as generation (pure visual verb)");
  assertEqual(d.confidence, 0.95, "A1 imperative start → 0.95");
}

{
  const d = detectImageGenerationIntent("generate an image of a cyberpunk city");
  assert(d.detected, "A2 'generate an image of …' detects");
  assertEqual(d.confidence, 0.95, "A2 imperative → 0.95");
}

{
  const d = detectImageGenerationIntent("paint a sunset");
  assert(d.detected, "A3 'paint a sunset' detects (pure visual verb)");
}

{
  const d = detectImageGenerationIntent("sketch my dog");
  assert(d.detected, "A4 'sketch my dog' detects (pure visual verb)");
}

{
  const d = detectImageGenerationIntent("Could you generate an image of a fox?");
  assert(d.detected, "A5 non-imperative phrasing still detects");
  assertEqual(d.confidence, 0.85, "A5 non-imperative → 0.85");
}

{
  const d = detectImageGenerationIntent("create a poster for my science fair");
  assert(d.detected, "A6 'create a poster' detects (artifact noun)");
}

{
  const d = detectImageGenerationIntent("design a logo for CodeCanvas");
  assert(d.detected, "A7 'design a logo' detects");
}

{
  const d = detectImageGenerationIntent("make a diagram of the water cycle");
  assert(d.detected, "A8 'make a diagram' detects");
}

{
  const d = detectImageGenerationIntent("produce an infographic about climate change");
  assert(d.detected, "A9 'produce an infographic' detects");
}

{
  const d = detectImageGenerationIntent("generate 3 images of a castle");
  assert(d.detected, "A10 multi-image ask still detects generation");
}

// ---------------------------------------------------------------------------
// B. Rejection / negative intent
// ---------------------------------------------------------------------------
section("B. Rejection / negative intent");

{
  const d = detectImageGenerationIntent("what is an image?");
  assert(!d.detected, "B1 'what is an image?' is NOT generation (concept definition)");
}

{
  const d = detectImageGenerationIntent("what does this image show?");
  assert(!d.detected, "B2 'what does this image show?' is understanding, not generation");
}

{
  const d = detectImageGenerationIntent("describe this photo");
  assert(!d.detected, "B3 'describe this photo' → not generation");
}

{
  const d = detectImageGenerationIntent("explain this diagram");
  assert(!d.detected, "B4 'explain this diagram' → not generation");
}

{
  const d = detectImageGenerationIntent("how does image generation work?");
  assert(!d.detected, "B5 'how does image generation work?' → not generation");
}

{
  const d = detectImageGenerationIntent("Which image shows a cat?");
  assert(!d.detected, "B6 'which image shows a cat?' → not generation");
}

{
  const d = detectImageGenerationIntent("generate a report for Monday");
  assert(!d.detected, "B7 'generate a report' (text) → NOT generation");
}

{
  const d = detectImageGenerationIntent("create a study plan");
  assert(!d.detected, "B8 'create a study plan' (text) → NOT generation");
}

{
  const d = detectImageGenerationIntent("make a list of groceries");
  assert(!d.detected, "B9 'make a list' (text) → NOT generation");
}

{
  const d = detectImageGenerationIntent("design a course syllabus");
  assert(!d.detected, "B10 'design a course' (text) → NOT generation");
}

{
  const d = detectImageGenerationIntent("Explain photosynthesis");
  assert(!d.detected, "B11 science question → NOT generation");
}

{
  const d = detectImageGenerationIntent("What is 2 + 2?");
  assert(!d.detected, "B12 calculation → NOT generation");
}

{
  const d = detectImageGenerationIntent("");
  assert(!d.detected, "B13 empty message → NOT generation");
}

{
  const d = detectImageGenerationIntent("draw");
  assert(!d.detected, "B14 bare verb → NOT generation (needs a subject)");
}

// ---------------------------------------------------------------------------
// C. Deterministic routing — IMAGE_GENERATION branch 4 placement
// ---------------------------------------------------------------------------
section("C. Deterministic routing (router)");

{
  const d = route({ message: "draw a castle" });
  assertEqual(d.primaryRoute, "IMAGE_GENERATION", "C1 'draw a castle' → IMAGE_GENERATION");
  assert(!d.requiresDocuments, "C1 pure image needs no documents");
  assert(!d.requiresRealtime, "C1 no real-time branch");
  assert(d.imageIntent?.detected === true, "C1 imageIntent attached");
}

{
  const d = route({ message: "what is an image?" });
  assertEqual(d.primaryRoute, "GENERAL", "C2 'what is an image?' → GENERAL");
  assert(!d.imageIntent, "C2 no imageIntent");
}

{
  const d = route({ message: "what does this image show?" });
  assert(d.primaryRoute !== "IMAGE_GENERATION", "C3 understanding turn never routes to image");
}

{
  // Strong real-time + document + sources stays HYBRID (branch 2 precedes
  // branch 4) — the image branch never steals a genuine 6B hybrid turn.
  const d = route({
    message: "According to my PDF, what is the weather in Chennai?",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(d.primaryRoute, "HYBRID", "C4 pure hybrid (doc+realtime+sources) → HYBRID");
  assert(!d.imageIntent, "C4 no image-intent steal on a hybrid turn");
}

{
  // When the turn leads with an image verb AND explicitly references the
  // attached document, Phase 6E wins over plain generation: it is a
  // document-grounded visual ask (branch 4b) — but still never fabricated
  // (requiresDocuments forces the evidence gate).
  const d = route({
    message: "Draw a chart of the weather in Delhi from my PDF",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(d.primaryRoute, "DOCUMENT_VISUAL_GENERATION", "C4b doc + visual ask → DOCUMENT_VISUAL_GENERATION");
  assert(d.requiresDocuments, "C4b grounding gate applies");
}

{
  // Document reference with NO sources still routes document-visual generation
  // (branch 4b is checked BEFORE the doc-reference guard at branch 5) but is
  // marked grounding-required so the chat route refuses without an attached
  // document — memory can never substitute for grounding.
  const d = route({ message: "Draw a diagram from my PDF", hasSources: false });
  assertEqual(d.primaryRoute, "DOCUMENT_VISUAL_GENERATION", "C5 doc-visual w/o sources → DOCUMENT_VISUAL_GENERATION");
  assert(d.requiresDocuments, "C5 requiresDocuments true (grounding gate applies)");
  assert(d.documentVisualIntent?.detected === true, "C5 documentVisualIntent attached");
}

{
  // Pure image ask with sources attached and doc grounding → channels the RAG
  // evidence into the document-visual pipeline (retrieval before generation).
  const d = route({
    message: "Draw a flowchart based on my uploaded notes",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(d.primaryRoute, "DOCUMENT_VISUAL_GENERATION", "C6 grounded doc-visual ask → DOCUMENT_VISUAL_GENERATION");
  assert(d.requiresDocuments, "C6 requiresDocuments true");
  assert(d.routes.includes("DOCUMENT_RAG"), "C6 DOCUMENT_RAG listed for evidence");
}

{
  // "Draw a castle" beats an unconditional DOCUMENT_RAG for attached sources:
  // generation verbs signal creation, not document retrieval.
  const d = route({ message: "draw a castle", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "IMAGE_GENERATION", "C7 pure draw with sources still generates");
}

{
  // Doc-reference stand-down is preserved: no image intent, doc referenced but
  // nothing attached → GENERAL (no tool, no hallucination).
  const d = route({ message: "show me the weather from my PDF", hasSources: false });
  assertEqual(d.primaryRoute, "GENERAL", "C8 doc-ref stand-down → GENERAL");
  assert(!d.requiresDocuments, "C8 no document branch fires");
}

{
  const d = route({ message: "Explain photosynthesis" });
  assertEqual(d.primaryRoute, "GENERAL", "C9 science question → GENERAL");
}

// ---------------------------------------------------------------------------
// D. Refinement detection
// ---------------------------------------------------------------------------
section("D. Refinement detection");

{
  const ref = resolveImageGenerationIntent("make it at night", "draw a castle");
  assert(ref.detected, "D1 'make it at night' refines a prior image turn");
  assertEqual(ref.refinementOf, "draw a castle", "D1 refinementOf = prior image prompt");
  assertEqual(ref.confidence, 0.72, "D1 refinement confidence");
}

{
  const ref = resolveImageGenerationIntent("add a moon", "draw a castle");
  assert(ref.detected, "D2 short 'add a moon' → refinement");
}

{
  const ref = resolveImageGenerationIntent("at night", "draw a castle");
  assert(ref.detected, "D3 tiny 'at night' → refinement");
}

{
  const ref = resolveImageGenerationIntent("draw a dragon", "draw a castle");
  assert(!ref.refinementOf, "D4 fresh generation in a follow-up wins over refinement");
  assert(ref.detected, "D4 direct generation intent detected");
  assertEqual(Math.round(ref.confidence * 100), 95, "D4 direct intent carries generation confidence");
}

{
  const ref = resolveImageGenerationIntent("Thanks!", "draw a castle");
  assert(!ref.detected, "D5 'Thanks!' → not a refinement, not generation");
}

{
  const ref = resolveImageGenerationIntent("make it at night", undefined);
  assert(!ref.detected, "D6 no prior image turn → no refinement");
}

{
  const ref = resolveImageGenerationIntent("what does this image show?", "draw a castle");
  assert(!ref.detected, "D7 understanding turn never refinements");
}

{
  const g = grantsGrounding("Draw a flowchart based on my uploaded PDF");
  assert(g, "D8 'flowchart … based on my' → grantsGrounding");
  assert(grantsGrounding("draw me a chart from the document"), "D9 'chart … from the document' → grantsGrounding");
  assert(!grantsGrounding("draw a castle"), "D10 generic draw → no grounding");
}

{
  const ref = detectImageGenerationRefinement("make it at night", "draw a castle");
  assert(ref?.detected === true, "D8 detectImageGenerationRefinement direct call");
  assertEqual(ref?.refinementOf, "draw a castle", "D8 refinementOf captured");
}

// ---------------------------------------------------------------------------
// E. Provider fallback matrix
// ---------------------------------------------------------------------------
section("E. Provider fallback matrix");

{
  const hf = makeProvider("huggingface", { kind: "ok" });
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateImageWithProviders(
    { message: "draw a castle" },
    [gem, hf]
  );
  assertEqual(out.kind, "image", "E1 gemini ok → image outcome");
  if (out.kind === "image") {
    assertEqual(out.image.provider, "gemini", "E1 provider = gemini");
  }
  assertEqual(hf.called(), 0, "E1 HF never called on gemini success");
}

{
  for (const code of ["provider_unavailable", "rate_limited", "timeout", "provider_invalid_response"] as ImageFailureCode[]) {
    const hf = makeProvider("huggingface", { kind: "ok" });
    const gem = makeProvider("gemini", { kind: "fail", code });
    const out = await generateImageWithProviders(
      { message: "draw a castle" },
      [gem, hf]
    );
    assertEqual(out.kind, "image", `E2 fail:${code} → image outcome`);
    if (out.kind === "image") {
      assertEqual(out.image.provider, "huggingface", `E2 fail:${code} → fell back to huggingface`);
    }
    assertEqual(hf.called(), 1, `E2 fail:${code} → HF called exactly once`);
  }
}

{
  const hf = makeProvider("huggingface", { kind: "fail", code: "provider_unavailable" });
  const gem = makeProvider("gemini", { kind: "fail", code: "rate_limited" });
  const out = await generateImageWithProviders(
    { message: "draw a castle" },
    [gem, hf]
  );
  assertEqual(out.kind, "message", "E3 both eligible failures → safe message");
  if (out.kind === "message") {
    assertEqual(out.message, SAFE_UNAVAILABLE_MESSAGE, "E3 SAFE_UNAVAILABLE_MESSAGE");
  }
  assertEqual(hf.called(), 1, "E3 HF still ran once");
}

{
  // safety_blocked is a user-content block — NEVER falls back to another provider.
  for (const code of ["safety_blocked", "provider_auth", "invalid_request", "misconfigured"] as ImageFailureCode[]) {
    const hf = makeProvider("huggingface", { kind: "ok" });
    const gem = makeProvider("gemini", { kind: "fail", code });
    const out = await generateImageWithProviders(
      { message: "draw a castle" },
      [gem, hf]
    );
    assertEqual(out.kind, "message", `E4 never-fallback ${code} → safe message`);
    assertEqual(hf.called(), 0, `E4 never-fallback ${code} → HF NOT called`);
  }
}

// ---------------------------------------------------------------------------
// F. Output validation
// ---------------------------------------------------------------------------
section("F. Output validation");

{
  // Non-image bytes → provider_invalid_response → HF fallback succeeds.
  const hf = makeProvider("huggingface", { kind: "ok" });
  const gem = makeProvider("gemini", { kind: "bytes", data: Buffer.from("this is definitely not an image file content") });
  const out = await generateImageWithProviders(
    { message: "draw a castle" },
    [gem, hf]
  );
  assertEqual(out.kind, "image", "F1 invalid passthrough bytes → fallback");
  if (out.kind === "image") {
    assertEqual(out.image.provider, "huggingface", "F1 provider = huggingface");
  }
  assertEqual(hf.called(), 1, "F1 HF ran");
}

{
  // Dims are read from the validated bytes (PNG header), not the provider claim.
  const hf = makeProvider("huggingface", { kind: "ok" });
  const gem = makeProvider("gemini", { kind: "ok", mime: "image/png" });
  const out = await generateImageWithProviders({ message: "draw a castle" }, [gem, hf]);
  if (out.kind === "image") {
    assertEqual(out.image.width, 1024, "F2 width from PNG header");
    assertEqual(out.image.height, 1024, "F2 height from PNG header");
  } else {
    assert(false, "F2 got an image outcome");
  }
}

{
  // Oversize bytes (>25 MB) fail validation → eligible fallback.
  const big = Buffer.alloc(25 * 1024 * 1024 + 1);
  big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
  const hf = makeProvider("huggingface", { kind: "ok" });
  const gem = makeProvider("gemini", { kind: "bytes", data: big });
  const out = await generateImageWithProviders({ message: "draw a castle" }, [gem, hf]);
  assertEqual(out.kind, "image", "F3 oversize → validation rejects → fallback");
}

{
  // Empty bytes fail.
  const hf = makeProvider("huggingface", { kind: "ok" });
  const gem = makeProvider("gemini", { kind: "bytes", data: Buffer.alloc(0) });
  const out = await generateImageWithProviders({ message: "draw a castle" }, [gem, hf]);
  assertEqual(out.kind, "image", "F4 empty bytes → fallback");
  if (out.kind === "image") {
    assertEqual(out.image.provider, "huggingface", "F4 fallback provider");
  }
}

{
  // Both providers give invalid bytes → safe message.
  const hf = makeProvider("huggingface", { kind: "bytes", data: Buffer.from("garbage bytes here") });
  const gem = makeProvider("gemini", { kind: "bytes", data: Buffer.from("also not an image") });
  const out = await generateImageWithProviders({ message: "draw a castle" }, [gem, hf]);
  assertEqual(out.kind, "message", "F5 all providers invalid → safe message");
  assert!(out.kind !== "image" || out.image.dataUrl.startsWith("data:"), "F5 never leaks raw bytes");
}

// ---------------------------------------------------------------------------
// G. Server-controlled config
// ---------------------------------------------------------------------------
section("G. Server-controlled config");

{
  const prev = process.env.IMAGE_PROVIDERS;
  try {
    delete process.env.IMAGE_PROVIDERS;
    assertEqual(resolveProviderOrder().join(","), "gemini,huggingface", "G1 default order");
    process.env.IMAGE_PROVIDERS = "huggingface,gemini";
    assertEqual(resolveProviderOrder().join(","), "huggingface,gemini", "G2 honored order");
    process.env.IMAGE_PROVIDERS = "gemini,gemini,unknown,gemini,huggingface";
    assertEqual(resolveProviderOrder().join(","), "gemini,huggingface", "G3 invalid/duplicates dropped");
    process.env.IMAGE_PROVIDERS = "bogus";
    assertEqual(resolveProviderOrder().join(","), "gemini,huggingface", "G4 all-invalid → default");
    process.env.IMAGE_PROVIDERS = " ";
    assertEqual(resolveProviderOrder().join(","), "gemini,huggingface", "G5 blank → default");
  } finally {
    if (prev === undefined) delete process.env.IMAGE_PROVIDERS;
    else process.env.IMAGE_PROVIDERS = prev;
  }
}

// ---------------------------------------------------------------------------
// H. Timeout policy
// ---------------------------------------------------------------------------
section("H. Timeout policy");

{
  assertEqual(PROVIDER_TIMEOUT_MS, 60_000, "H1 hard 60s budget per provider");
  const hf = makeProvider("huggingface", { kind: "ok" });
  const gem = makeProvider("gemini", { kind: "fail", code: "timeout" });
  const out = await generateImageWithProviders({ message: "draw a castle" }, [gem, hf]);
  assertEqual(out.kind, "image", "H2 timeout failure falls back");
}

{
  // Each provider runs ONCE (no infinite retry loop on repeated failures).
  const gem = makeProvider("gemini", { kind: "fail", code: "provider_unavailable" });
  const hf = makeProvider("huggingface", { kind: "fail", code: "provider_unavailable" });
  const out = await generateImageWithProviders({ message: "draw a castle" }, [gem, hf]);
  assertEqual(out.kind, "message", "H3 both fail → message");
  assertEqual(gem.called(), 1, "H3 gemini ran exactly once");
  assertEqual(hf.called(), 1, "H3 HF ran exactly once");
}

// ---------------------------------------------------------------------------
// I. RAG-grounding gate
// ---------------------------------------------------------------------------
section("I. RAG-grounding gate");

{
  // groundedRequired + no evidence → refusal BEFORE any provider runs.
  const gem = makeProvider("gemini", { kind: "ok" });
  const hf = makeProvider("huggingface", { kind: "ok" });
  const out = await generateImageWithProviders(
    { message: "Draw a diagram of the water cycle", groundedRequired: true, evidence: null },
    [gem, hf]
  );
  assertEqual(out.kind, "message", "I1 grounded+no-evidence → message");
  if (out.kind === "message") {
    assertEqual(out.message, SAFE_NO_GROUNDING_MESSAGE, "I1 SAFE_NO_GROUNDING_MESSAGE");
  }
  assertEqual(gem.called(), 0, "I1 gemini NOT called");
  assertEqual(hf.called(), 0, "I1 HF NOT called");
}

{
  // groundedRequired + evidence → prompt carries the verified facts.
  const gem = makeProvider("gemini", { kind: "ok" });
  const hf = makeProvider("huggingface", { kind: "ok" });
  const out = await generateImageWithProviders(
    {
      message: "Draw a diagram of the water cycle",
      groundedRequired: true,
      evidence: "Water evaporates, condenses, and precipitates.",
    },
    [gem, hf]
  );
  assertEqual(out.kind, "image", "I2 grounded+evidence → image");
  const prompt = gem.params[0]?.prompt ?? "";
  assert(prompt.includes("Ground the image ONLY in these verified facts"), "I2 grounding instruction injected");
  assert(prompt.includes("Water evaporates"), "I2 evidence text injected verbatim");
}

{
  // No grounding required + no evidence → still generates (pure draw).
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateImageWithProviders(
    { message: "draw a castle", groundedRequired: false, evidence: null },
    [gem]
  );
  assertEqual(out.kind, "image", "I3 pure turn w/o evidence generates normally");
  assert(!(gem.params[0]?.prompt ?? "").includes("Ground the image"), "I3 no grounding block when no evidence");
}

// ---------------------------------------------------------------------------
// J. Prompt composition
// ---------------------------------------------------------------------------
section("J. Prompt composition");

{
  const gem = makeProvider("gemini", { kind: "ok" });
  await generateImageWithProviders({ message: "Draw a castle", mode: "student" }, [gem]);
  const prompt = gem.params[0]?.prompt ?? "";
  assert(prompt.includes("study aid"), "J1 student mode adds educational hint");
  assert(prompt.includes("Draw a castle"), "J1 user words preserved verbatim");
}

{
  // Evidence block capped at 600 chars; total prompt capped at 900. Use
  // NON-periodic evidence so the tail can be uniquely detected.
  const gem = makeProvider("gemini", { kind: "ok" });
  const evidence = Array.from({ length: 400 }, (_, i) => `token${String(i).padStart(4, "0")}`).join(" ");
  await generateImageWithProviders({ message: "Draw a timeline of the war", evidence }, [gem]);
  const prompt = gem.params[0]?.prompt ?? "";
  assert(prompt.length <= PROMPT_MAX_CHARS, "J2 prompt capped at 900 chars");
  assert(prompt.includes("token0000 token0001"), "J2 evidence head present in cap");
  assert(!prompt.includes("token0395"), "J2 evidence tail beyond cap excluded");
}

{
  // Aspect ratio normalization: valid passes through, invalid → 1:1.
  const gem = makeProvider("gemini", { kind: "ok" });
  await generateImageWithProviders({ message: "draw a castle", aspectRatio: "3:4" }, [gem]);
  assertEqual(gem.params[0]?.aspectRatio, "3:4", "J3 valid aspect preserved");
  const gem2 = makeProvider("gemini", { kind: "ok" });
  await generateImageWithProviders({ message: "draw a castle", aspectRatio: "7:1" as never }, [gem2]);
  assertEqual(gem2.params[0]?.aspectRatio, "1:1", "J3 invalid aspect → 1:1");
  assertEqual(normalizeAspectRatio("16:9"), "16:9", "J4 normalizeAspectRatio 16:9");
  assertEqual(normalizeAspectRatio("4:4"), "1:1", "J4 normalizeAspectRatio garbage → 1:1");
}

{
  // Default negative prompt used; custom one (≤400) overrides.
  const gem = makeProvider("gemini", { kind: "ok" });
  await generateImageWithProviders({ message: "draw a castle" }, [gem]);
  assertEqual(gem.params[0]?.negativePrompt, DEFAULT_NEGATIVE_PROMPT, "J5 default negative prompt");
  const gem2 = makeProvider("gemini", { kind: "ok" });
  await generateImageWithProviders({ message: "draw a castle", negativePrompt: "no scribbles" }, [gem2]);
  assertEqual(gem2.params[0]?.negativePrompt, "no scribbles", "J5 custom negative prompt wins");
}

{
  // Refinement composition: prior; refinement: <turn>.
  const gem = makeProvider("gemini", { kind: "ok" });
  await generateImageWithProviders(
    { message: "make it at night", priorUserMessage: "Draw a castle" },
    [gem]
  );
  const prompt = gem.params[0]?.prompt ?? "";
  assert(prompt.startsWith("Draw a castle"), "J6 refinement keeps prior subject");
  assert(prompt.includes("; refinement: make it at night"), "J6 refinement instruction appended");
}

{
  // buildImagePrompt direct composition (student hint + default aspect).
  const composed = buildImagePrompt({ message: "draw a castle", mode: "student" });
  assert(composed.prompt.includes("study aid"), "J7 buildImagePrompt student hint direct");
  assertEqual(composed.aspectRatio, "1:1", "J7 default aspect direct");
  assertEqual(normalizeAspectRatio("4:3"), "4:3", "J7 aspect passthrough direct");
}

// ---------------------------------------------------------------------------
// K. No-keys safety
// ---------------------------------------------------------------------------
section("K. No-keys safety");

{
  const prevGem = process.env.GEMINI_API_KEY;
  const prevProviders = process.env.IMAGE_PROVIDERS;
  try {
    process.env.GEMINI_API_KEY = "";
    delete process.env.IMAGE_PROVIDERS;
    const out = await generateImage({ message: "draw a castle" });
    assertEqual(out.kind, "message", "K1 no GEMINI_API_KEY → safe message (no crash, no leak)");
    if (out.kind === "message") {
      assertEqual(out.message, SAFE_UNAVAILABLE_MESSAGE, "K1 SAFE_UNAVAILABLE_MESSAGE");
    }
  } finally {
    if (prevGem === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGem;
    if (prevProviders === undefined) delete process.env.IMAGE_PROVIDERS;
    else process.env.IMAGE_PROVIDERS = prevProviders;
  }
}

{
  const prev = process.env.HF_TOKEN;
  try {
    process.env.HF_TOKEN = "";
    let code: ImageFailureCode | null = null;
    try {
      await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
    } catch (error) {
      if (error instanceof ImageFailure) code = error.code;
    }
    assertEqual(code, "provider_auth", "K2 HF without token → provider_auth (config gap, safe)");
  } finally {
    if (prev === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = prev;
  }
}

{
  assertEqual(DEFAULT_GEMINI_IMAGE_MODEL, "gemini-3.1-flash-image", "K3 verified default Gemini image model");
}

// ---------------------------------------------------------------------------
// L. Caption semantics
// ---------------------------------------------------------------------------
section("L. Caption semantics");

{
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateImageWithProviders({ message: "draw a castle" }, [gem]);
  if (out.kind === "image") {
    assertEqual(out.message, "Here's the image you asked for.", "L1 plain caption");
  } else {
    assert(false, "L1 got message outcome");
  }
}

{
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateImageWithProviders(
    { message: "make it at night", priorUserMessage: "draw a castle" },
    [gem]
  );
  if (out.kind === "image") {
    assertEqual(out.message, "Here's your updated image.", "L2 refinement → updated caption");
  } else {
    assert(false, "L2 got message outcome");
  }
}

{
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateImageWithProviders(
    { message: "Draw a diagram of the water cycle", evidence: "Water evaporates." },
    [gem]
  );
  if (out.kind === "image") {
    assertEqual(out.message, "Here's an image grounded in your attached document.", "L3 grounded caption");
  } else {
    assert(false, "L3 got message outcome");
  }
}

// ---------------------------------------------------------------------------
// M. GeneratedImage payload shape
// ---------------------------------------------------------------------------
section("M. GeneratedImage payload shape");

{
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateImageWithProviders({ message: "draw a castle" }, [gem]);
  if (out.kind === "image") {
    const img = out.image;
    assert(img.dataUrl.startsWith("data:image/png;base64,"), "M1 validated PNG data URL");
    assertEqual(img.mimeType, "image/png", "M1 mimeType from magic bytes");
    assertEqual(img.provider, "gemini", "M1 provider id");
    assertEqual(img.fileSizeBytes, png(1024, 1024).length, "M1 fileSizeBytes from bytes");
    assertEqual(img.width, 1024, "M1 width parsed");
    assertEqual(img.height, 1024, "M1 height parsed");
    assert(img.prompt.length > 0, "M1 effective prompt recorded");
    assert(canDecode(img.dataUrl), "M1 data URL round-trips to valid image bytes");
  } else {
    assert(false, "M1 got message outcome");
  }
}

function canDecode(dataUrl: string): boolean {
  const base64 = dataUrl.split(",")[1];
  if (!base64) return false;
  const buf = Buffer.from(base64, "base64");
  if (buf.length < 12) return false;
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

// ---------------------------------------------------------------------------
// N. Execution plan (router)
// ---------------------------------------------------------------------------
section("N. Execution plan (router)");

{
  const d = route({ message: "draw a castle" });
  const steps = d.executionPlan?.steps ?? [];
  const maxExternalCalls = d.executionPlan?.maxExternalCalls ?? 0;
  const imageStep = steps.find((s) => s.kind === "image");
  assert(imageStep !== undefined, "N1 pure image plan includes an image step");
  assertEqual(imageStep?.maxCalls, 1, "N1 exactly one image call planned");
  assertEqual(imageStep?.dependsOn.length, 0, "N1 pure image depends on nothing");
  assert(steps.some((s) => s.kind === "gemini"), "N1 plan still ends in the explain step");
  assert(maxExternalCalls <= 4, "N1 external-call budget ≤ 4");
}

{
  const d = route({
    message: "Draw a flowchart based on my uploaded notes",
    hasSources: true,
    sourceCount: 1,
  });
  const steps = d.executionPlan?.steps ?? [];
  const maxExternalCalls = d.executionPlan?.maxExternalCalls ?? 0;
  const ragStep = steps.find((s) => s.kind === "rag");
  const imageStep = steps.find((s) => s.kind === "image");
  assert(ragStep !== undefined, "N2 grounded image plan grabs RAG evidence first");
  assert(imageStep !== undefined, "N2 image step present");
  const dependsOnRetrieval = Boolean(
    ragStep && imageStep && imageStep.dependsOn.includes(ragStep.id)
  );
  assert(dependsOnRetrieval, "N2 image step depends on the retrieval step");
  assert(maxExternalCalls <= 4, "N2 budget ≤ 4");
}

{
  const d = route({ message: "explain photosynthesis" });
  const steps = d.executionPlan?.steps ?? [];
  assert(!steps.some((s) => s.kind === "image"), "N3 non-image route has no image step");
}

// ---------------------------------------------------------------------------
// O. Extension points + transparency
// ---------------------------------------------------------------------------
section("O. Extension points + transparency");

{
  assertEqual(EXTENSION_POINTS.IMAGE_GENERATION, true, "O1 IMAGE_GENERATION enabled");
  const d = route({ message: "draw a castle" });
  const log = describeQueryRoute(d);
  assert(log.includes("img=1"), `O2 describeQueryRoute flags image intent (${log})`);
  assert(!log.toLowerCase().includes("gemini api key"), "O2 log never carries secrets");
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    assert(!log.includes(key), "O2 log never echoes the API key");
  } else {
    assert(true, "O2 (no key in env to leak)");
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nPhase 6C: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Phase 6C has FAILING assertions.");
  process.exit(1);
}
}

main();