// ---------------------------------------------------------------------------
// Phase 6E — Document → Visual generation test suite.
// Run with: npx tsx test-phase6e.ts
//
// Covers the deterministic document-visual intent detector, the visual-type
// taxonomy/inference, evidence normalization (dedup + bounds + numeric gate),
// the structured spec + grounded prompt builder, the service's grounding gate
// (no-doc / no-evidence / chart-without-numbers / refinement claim guard),
// the shared fallback policy (eligible vs never-fallback, provider-once),
// output validation, router priority vs IMAGE_EDIT / IMAGE_GENERATION /
// DOCUMENT_RAG / HYBRID / GENERAL, server-only token sourcing, safe logging,
// and a mocked end-to-end path. Mock providers only — no live network.
//
// Sections:
//   A. Direct intent detection          — doc-ref must pair with visual ask
//   B. Refinement detection             — presentation vs new ask / facts
//   C. Deterministic routing (router)   — 6E branch 4b placement + edges
//   D. Evidence layer                   — normalize, dedup, bounds, numbers
//   E. Spec + grounded prompt builder   — structured spec, per-type rules
//   F. Service grounding gate           — refusal paths + provider-once
//   G. Fallback policy                  — eligible vs never-fallback codes
//   H. Output validation                — bad/oversize bytes
//   I. Server-only secrets + safe logs  — env sourcing + no key leakage
//   J. Execution plan (router)          — retrieval-before-generation budget
//   K. No-keys safety                   — safe message with env keys blanked
//   L. Mocked end-to-end                — router → spec → prompt → image
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import {
  detectDocumentVisualIntent,
  resolveDocumentVisualIntent,
  inferDocumentVisualType,
  generateDocumentVisualWithProviders,
  generateDocumentVisual,
  normalizeEvidence,
  hasNumericEvidence,
  extractNumericTokens,
  buildDocumentVisualSpec,
  buildDocumentVisualPrompt,
  guardRefinementClaims,
  DOCUMENT_VISUAL_TYPES,
  DOC_VISUAL_PROMPT_MAX_CHARS,
  ImageFailure,
  SAFE_NO_GROUNDING_MESSAGE,
  SAFE_UNAVAILABLE_MESSAGE,
  SAFE_DOC_VISUAL_NO_DOC_MESSAGE,
  SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE,
  SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE,
} from "./src/lib/image-generation";
import type {
  DocumentVisualEvidenceItem,
  DocumentVisualType,
  ImageFailureCode,
  ImageProvider,
  ImageProviderId,
  ProviderGenerationParams,
  ProviderImageOutput,
} from "./src/lib/image-generation";
import { routeQuery, describeQueryRoute } from "./src/lib/agent";
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
    console.error(`  FAIL — ${label} (expected "${expected}", got "${actual}")`);
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
  images?: Array<{ key: string }>;
}): QueryRouteDecision {
  return routeQuery({
    userId: "test-user",
    message: opts.message,
    hasSources: opts.hasSources ?? false,
    sourceCount: opts.sourceCount,
    priorTurns: opts.priorTurns,
    images: opts.images,
  });
}

async function main(): Promise<void> {

/** Deterministic non-numeric evidence fixtures (water cycle). */
const WATER_CYCLE_EVIDENCE: DocumentVisualEvidenceItem[] = [
  {
    sourceName: "science-notes.txt",
    text: "First, sunlight heats the water in lakes and oceans. Next, it evaporates and rises as vapour. Finally, it condenses into clouds and falls as rain.",
  },
];

/** Deterministic numeric evidence (annual report). */
const NUMERIC_EVIDENCE: DocumentVisualEvidenceItem[] = [
  {
    sourceName: "annual.pdf",
    page: 3,
    text: "Revenue grew 40% in 2024 to $520 million. Costs stayed flat at $120 million during the same year.",
  },
];

const EMPTY_PROVIDERS: ImageProvider[] = [];

// ---------------------------------------------------------------------------
// A. Direct intent detection
// ---------------------------------------------------------------------------
section("A. Direct intent detection");

{
  const d = detectDocumentVisualIntent("Create an infographic from my PDF");
  assert(d.detected, "A1 'Create an infographic from my PDF' detected");
  assertEqual(d.visualType, "infographic", "A1 visualType infographic");
  assert(d.requiresDocuments, "A1 grounding always required");
}

{
  const d = detectDocumentVisualIntent("Generate a flowchart based on my uploaded notes");
  assert(d.detected, "A2 'flowchart based on my uploaded notes' detected");
  assertEqual(d.visualType, "flowchart", "A2 visualType flowchart");
}

{
  const d = detectDocumentVisualIntent("Make a timeline from this report");
  assert(d.detected, "A3 'timeline from this report' detected");
  assertEqual(d.visualType, "timeline", "A3 visualType timeline");
}

{
  const d = detectDocumentVisualIntent("Draw a concept map of the chapter in my textbook");
  assert(d.detected, "A4 'concept map … my textbook' detected");
  assertEqual(d.visualType, "concept_map", "A4 visualType concept_map");
}

{
  const d = detectDocumentVisualIntent("Visualize the statistics in this report");
  assert(d.detected, "A5 'Visualize the statistics in this report' detected");
}

{
  const d = detectDocumentVisualIntent("Create a visual summary of chapter 3 from my notes");
  assert(d.detected, "A6 'visual summary of chapter 3 from my notes' detected");
  assertEqual(d.visualType, "visual_summary", "A6 visualType visual_summary");
}

{
  // Document reference + visual noun but NO generation verb is NOT a visual ask
  // ("show me the diagram", "the chart in chapter 4" are reading/referencing).
  const d = detectDocumentVisualIntent("Show me the diagram in my PDF");
  assert(!d.detected, "A7 reading/referencing phrasing not detected");
}

{
  // NO document reference → NOT a document visual (memory never substitutes).
  const d = detectDocumentVisualIntent("Diagram of photosynthesis");
  assert(!d.detected, "A8 no doc reference → not detected");
  assert(d.reason.toLowerCase().includes("document"), "A8 reason names the missing document grounding");
}

{
  const d = detectDocumentVisualIntent("Draw a diagram of photosynthesis");
  assert(!d.detected, "A9 pure generation without doc → not a document visual");
}

{
  // Visual UNDERSTANDING turns are the OPPOSITE of generation.
  const d = detectDocumentVisualIntent("What does the diagram on page 4 show?");
  assert(!d.detected, "A10 'what does the diagram show' rejected");
}

{
  const d = detectDocumentVisualIntent("Explain the chart in my report");
  assert(!d.detected, "A11 'explain the chart in my report' rejected");
}

{
  // An explicit image EDIT is NOT a fresh document visual — the router's
  // IMAGE_EDIT branch owns it (checked before 6E).
  const d = detectDocumentVisualIntent("Edit the diagram from my PDF");
  assert(!d.detected, "A12 'edit the diagram from my PDF' not a 6E ask");
}

{
  const d = detectDocumentVisualIntent("Summarize my PDF into an infographic");
  assert(d.detected, "A13 summarise-then-into a visual detected");
  assertEqual(d.visualType, "infographic", "A13 visualType infographic");
}

{
  // Ambiguous type ("an infographic or a timeline") never guesses.
  const d = detectDocumentVisualIntent("Make an infographic or a timeline from my notes");
  assert(d.detected, "A14 ambiguous type still detected");
  assertEqual(d.visualType, null, "A14 visualType null (ambiguous, no contradiction)");
  assertEqual(inferDocumentVisualType("Make an infographic or a timeline from my notes"), null, "A14 inference refuses ambiguity");
}

{
  // Closed taxonomy: every inferred type is one of the ten DOCUMENT_VISUAL_TYPES.
  const probes = [
    "Create an infographic from my PDF",
    "Draw a flowchart from my notes",
    "Draw a timeline from my notes",
    "Draw a concept map from my notes",
    "Make a process diagram from the report",
    "Build a comparison visual from the data",
    "Make a chart from the report",
    "Create a visual summary from my notes",
    "Create an educational diagram from the textbook",
    "Draw an illustration from the chapter",
  ];
  for (const p of probes) {
    const t = inferDocumentVisualType(p);
    assert(t === null || DOCUMENT_VISUAL_TYPES.includes(t as DocumentVisualType), `A15 inferred type in taxonomy for "${p}"`);
  }
}

// ---------------------------------------------------------------------------
// B. Refinement detection
// ---------------------------------------------------------------------------
section("B. Refinement detection");

{
  const ref = resolveDocumentVisualIntent(
    "make it simpler",
    "Create an infographic from my PDF"
  );
  assert(ref.detected, "B1 'make it simpler' refines a prior document visual");
  assertEqual(ref.refinementOf, "Create an infographic from my PDF", "B1 refinementOf = prior ask");
  assertEqual(ref.visualType, "infographic", "B1 prior visual type carried through");
}

{
  const ref = resolveDocumentVisualIntent(
    "use a darker color palette",
    "Create a timeline from my report"
  );
  assert(ref.detected, "B2 presentation refinement detected");
  assertEqual(ref.refinementOf, "Create a timeline from my report", "B2 refinementOf set");
}

{
  // Chit-chat and understanding turns are NEVER refinements.
  const ref = resolveDocumentVisualIntent("Thanks!", "Create an infographic from my PDF");
  assert(!ref.detected, "B3 chit-chat not a refinement");
  const ref2 = resolveDocumentVisualIntent("what does it show?", "Create an infographic from my PDF");
  assert(!ref2.detected, "B3 understanding not a refinement");
}

{
  // A fresh document-visual ask after a prior one is a NEW request.
  const ref = resolveDocumentVisualIntent(
    "Create a timeline from chapter 5 instead",
    "Create an infographic from my PDF"
  );
  assert(!ref.detected || ref.refinementOf == null, "B4 fresh doc-visual ask is not a refinement");
}

{
  // No prior document-visual turn → nothing to refine.
  const ref = resolveDocumentVisualIntent("make it simpler", "Draw a castle");
  assert(!ref.detected, "B5 no prior doc-visual → no refinement");
}

// ---------------------------------------------------------------------------
// C. Deterministic routing (router) — branch 4b
// ---------------------------------------------------------------------------
section("C. Deterministic routing (router)");

{
  const d = route({
    message: "Create an infographic from my PDF",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(d.primaryRoute, "DOCUMENT_VISUAL_GENERATION", "C1 doc + visual ask + sources → DOCUMENT_VISUAL_GENERATION");
  assert(d.requiresDocuments, "C1 grounding required");
  assert(d.routes.includes("DOCUMENT_RAG"), "C1 DOCUMENT_RAG listed (retrieval before generation)");
  assertEqual(d.documentVisualIntent?.visualType, "infographic", "C1 documentVisualIntent attached with type");
}

{
  const d = route({ message: "Create an infographic from my PDF", hasSources: false });
  assertEqual(d.primaryRoute, "DOCUMENT_VISUAL_GENERATION", "C2 doc + visual ask, no sources → refusal route");
  assert(d.requiresDocuments, "C2 grounding gate marked (chat route refuses)");
  assert(!d.requiresClarification, "C2 deliberate refusal, not a clarification");
}

{
  // Pure generation with NO document reference stays IMAGE_GENERATION.
  const d = route({ message: "Draw a diagram of photosynthesis", hasSources: false });
  assertEqual(d.primaryRoute, "IMAGE_GENERATION", "C3 no-doc generation keeps IMAGE_GENERATION");
  assert(!d.documentVisualIntent, "C3 no document-visual intent");
}

{
  // Memory can never substitute for an attached document: a doc-referenced
  // visual with no sources stays grounded-required (6E refusal), never GENERAL.
  const d = route({
    message: "Create an infographic based on what you remember about my PDF",
    hasSources: false,
  });
  assertEqual(d.primaryRoute, "DOCUMENT_VISUAL_GENERATION", "C4 memory substitution refused → 6E");
  assert(d.requiresDocuments, "C4 grounding required (memory never substitutes)");
}

{
  // IMAGE_EDIT wins over 6E ("edit the diagram from my PDF").
  const d = route({
    message: "Edit the diagram from my PDF",
    hasSources: true,
    sourceCount: 1,
    images: [{ key: "img-1" }],
  });
  assertEqual(d.primaryRoute, "IMAGE_EDIT", "C5 'edit the diagram from my PDF' stays IMAGE_EDIT");
}

{
  // Summarize my PDF is READING, not a document visual.
  const d = route({ message: "Summarize my PDF", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "DOCUMENT_RAG", "C6 'summarize my PDF' → DOCUMENT_RAG");
}

{
  // Strong real-time + doc hybrid is never stolen by 6E.
  const d = route({
    message: "According to my PDF, what is the weather in Chennai?",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(d.primaryRoute, "HYBRID", "C7 real-time+doc hybrid still wins");
}

{
  // Visual understanding of document CONTENT never routes to 6E.
  const d = route({ message: "What does the chart in my PDF show?", hasSources: true, sourceCount: 1 });
  assert(d.primaryRoute !== "DOCUMENT_VISUAL_GENERATION", "C8 understanding never routes to document visual");
}

{
  // Refinement turn routes to 6E and carries the prior ask for retrieval/facts.
  const d = route({
    message: "make it simpler",
    hasSources: true,
    sourceCount: 1,
    priorTurns: [{ role: "user", content: "Create an infographic from my PDF" }],
  });
  assertEqual(d.primaryRoute, "DOCUMENT_VISUAL_GENERATION", "C9 refinement → DOCUMENT_VISUAL_GENERATION");
  assertEqual(d.documentVisualIntent?.refinementOf, "Create an infographic from my PDF", "C9 refinementOf carried");
}

// ---------------------------------------------------------------------------
// D. Evidence layer
// ---------------------------------------------------------------------------
section("D. Evidence layer");

{
  const items = normalizeEvidence([
    { text: "  The   water cycle.  " },
    { text: "The water cycle." },
    { text: "Condensation forms clouds." },
    { text: "Condensation forms clouds." },
    { text: "" },
  ]);
  assertEqual(items.length, 2, "D1 whitespace-collapse, dedup, empties dropped");
}

{
  const many = normalizeEvidence(
    Array.from({ length: 30 }, (_, i) => ({ text: `Fact number ${i + 1}.` }))
  );
  assert(many.length <= 20, "D2 evidence items bounded to 20");
  const big = normalizeEvidence([{ text: "x".repeat(20_000) }]);
  assert(big.length === 1 && big[0].text.length <= 3_000, "D3 single item bounded");
  const total = normalizeEvidence(
    Array.from({ length: 10 }, () => ({ text: "y".repeat(3_000) }))
  );
  assert(
    total.reduce((sum, item) => sum + item.text.length, 0) <= 12_000,
    "D4 total evidence bounded to 12000 chars"
  );
}

{
  assert(hasNumericEvidence(NUMERIC_EVIDENCE), "D5 numeric evidence detected");
  assert(!hasNumericEvidence(WATER_CYCLE_EVIDENCE), "D5 non-numeric evidence rejected");
  const tokens = extractNumericTokens("revenue hit $520 million and grew 40% in 2024");
  assert(tokens.some((t) => t === "40%"), "D6 percentage token extracted");
  assert(tokens.some((t) => t === "2024"), "D6 year token extracted");
  assert(tokens.some((t) => t === "520"), "D6 currency amount normalized to bare digit");
}

{
  const items = normalizeEvidence([{ text: "Revenue grew 40% in 2024.", page: 3, score: 0.9 }]);
  assertEqual(items[0].page, 3, "D7 page preserved from legacy retrieval shape");
  assertEqual(items[0].relevance, 0.9, "D7 score mapped to relevance");
}

// ---------------------------------------------------------------------------
// E. Spec + grounded prompt builder
// ---------------------------------------------------------------------------
section("E. Spec + grounded prompt builder");

{
  const spec = buildDocumentVisualSpec("chart", NUMERIC_EVIDENCE);
  assert(spec.hasNumericEvidence, "E1 chart spec sees numeric evidence");
  assert(Boolean(spec.numbers?.some((n) => n.includes("40%"))), "E1 numbers extracted");
  assert(spec.sourceReferences.includes("annual.pdf · page 3"), "E1 source reference carries page");
  assert(spec.keyFacts.length >= 1, "E1 key facts derived");
}

{
  const spec = buildDocumentVisualSpec("flowchart", WATER_CYCLE_EVIDENCE);
  assert((spec.sequence?.length ?? 0) >= 3, "E2 ordered steps captured in sequence");
}

{
  const spec = buildDocumentVisualSpec("concept_map", [
    { text: "Higher temperatures lead to faster growth. The sun causes evaporation." },
  ]);
  assert(spec.relationships.length >= 2, "E3 explicit relationships only (lead to, causes)");
}

{
  const spec = buildDocumentVisualSpec("chart", NUMERIC_EVIDENCE);
  const composed = buildDocumentVisualPrompt({ spec });
  assert(composed.prompt.includes("data chart"), "E4 chart label used");
  assert(
    composed.prompt.includes("Visualize ONLY the numerical values explicitly present in the evidence."),
    "E4 chart anti-hallucination instruction"
  );
  assert(composed.prompt.includes("Verification rules — follow EXACTLY:"), "E4 verification rules block");
  assert(composed.prompt.includes("Revenue grew 40% in 2024"), "E4 evidence reflected");
  assert(composed.prompt.length <= DOC_VISUAL_PROMPT_MAX_CHARS, "E4 prompt bounded");
}

{
  const spec = buildDocumentVisualSpec("flowchart", WATER_CYCLE_EVIDENCE);
  const student = buildDocumentVisualPrompt({ spec, mode: "student" });
  assert(student.prompt.includes("study aid"), "E5 student mode adds the educational hint");
  assert(student.prompt.includes("Show the steps and branches exactly as the evidence sequences them"), "E5 flowchart instruction");
}

{
  // Refinement presentation passes the claim guard; unsupported facts fail.
  const spec = buildDocumentVisualSpec("infographic", WATER_CYCLE_EVIDENCE);
  assert(guardRefinementClaims("make it simpler", spec).okay, "E6 presentation refinement passes");
  assert(
    !guardRefinementClaims("add the 2024 revenue statistic", spec).okay,
    "E6 unsupported year/fact refinement blocked"
  );
  assert(
    !guardRefinementClaims("add a $300 million cost bar", spec).okay,
    "E6 unsupported number refinement blocked"
  );
}

// ---------------------------------------------------------------------------
// F. Service grounding gate + provider-once
// ---------------------------------------------------------------------------
section("F. Service grounding gate + provider-once");

{
  const gem = makeProvider("gemini", { kind: "ok" });
  const hf = makeProvider("huggingface", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    { message: "Create an infographic from my PDF", evidence: [] },
    [gem, hf]
  );
  assertEqual(out.kind, "message", "F1 empty evidence → message");
  if (out.kind === "message") {
    assertEqual(out.message, SAFE_NO_GROUNDING_MESSAGE, "F1 SAFE_NO_GROUNDING_MESSAGE");
  }
  assertEqual(gem.called(), 0, "F1 gemini NOT called (grounding gate first)");
  assertEqual(hf.called(), 0, "F1 HF NOT called");
}

{
  // Chart without numerical evidence → honest refusal, never fabricated numbers.
  const gem = makeProvider("gemini", { kind: "ok" });
  const hf = makeProvider("huggingface", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    { message: "Create a chart from my notes", evidence: WATER_CYCLE_EVIDENCE, requestedVisualType: "chart" },
    [gem, hf]
  );
  assertEqual(out.kind, "message", "F2 chart-without-numbers → message");
  if (out.kind === "message") {
    assertEqual(out.message, SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE, "F2 SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE");
  }
  assertEqual(gem.called(), 0, "F2 no provider called for a refused chart");
  assertEqual(hf.called(), 0, "F2 no provider called for a refused chart");
}

{
  // Chart WITH numerical evidence generates and stamps honest metadata.
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    {
      message: "Create a chart from my annual report",
      evidence: NUMERIC_EVIDENCE,
      requestedVisualType: "chart",
    },
    [gem]
  );
  assertEqual(out.kind, "image", "F3 numeric chart → image");
  if (out.kind === "image") {
    assertEqual(out.image.visualType, "chart", "F3 visualType metadata");
    assertEqual(out.image.sourceGrounded, true, "F3 sourceGrounded metadata");
    assert(out.message.toLowerCase().includes("document"), "F3 caption acknowledges document grounding");
    const prompt = (gem.params[0]?.prompt ?? "") as string;
    assert(prompt.includes("Visualize ONLY the numerical values"), "F3 chart constraint present");
    assert(prompt.includes("40%"), "F3 exact numbers in prompt");
  }
}

{
  // Grounded generation on valid evidence; provider receives the composed
  // grounded prompt (with evidence + verification rules), nothing raw.
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    {
      message: "Create an infographic from my PDF",
      evidence: WATER_CYCLE_EVIDENCE,
      requestedVisualType: "infographic",
    },
    [gem]
  );
  assertEqual(out.kind, "image", "F4 valid grounded generation → image");
  if (out.kind === "image") {
    assertEqual(out.image.sourceGrounded, true, "F4 sourceGrounded true");
    const prompt = (gem.params[0]?.prompt ?? "") as string;
    assert(prompt.includes("infographic"), "F4 provider prompt names the visual type");
    assert(prompt.includes("sunlight heats the water"), "F4 grounded fact present");
    assert(prompt.includes("never fill gaps from general knowledge"), "F4 no-fabrication rule present");
    assert(!prompt.includes("RAW_RETRIEVAL_DUMP"), "F4 provider never sees raw dump markers");
  }
}

{
  // Refinement that introduces unsupported facts is REFUSED without a call.
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    {
      message: "add the 2024 revenue statistic",
      evidence: WATER_CYCLE_EVIDENCE,
      requestedVisualType: "infographic",
      refinementOf: "Create an infographic from my PDF",
      priorUserMessage: "Create an infographic from my PDF",
    },
    [gem]
  );
  assertEqual(out.kind, "message", "F5 unsupported refinement → message");
  if (out.kind === "message") {
    assertEqual(out.message, SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE, "F5 refinement guard message");
  }
  assertEqual(gem.called(), 0, "F5 provider never called for an unverifiable refinement");
}

{
  // Presentation refinement is verified against evidence and proceeds.
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    {
      message: "make it simpler",
      evidence: WATER_CYCLE_EVIDENCE,
      requestedVisualType: "infographic",
      refinementOf: "Create an infographic from my PDF",
      priorUserMessage: "Create an infographic from my PDF",
    },
    [gem]
  );
  assertEqual(out.kind, "image", "F6 presentation refinement proceeds");
  if (out.kind === "image") {
    const prompt = (gem.params[0]?.prompt ?? "") as string;
    assert(prompt.includes("Refinement"), "F6 refinement composed into the prompt");
  }
}

{
  // Provider-once: with two healthy providers only the first runs.
  const gem = makeProvider("gemini", { kind: "ok" });
  const hf = makeProvider("huggingface", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    { message: "Create an infographic from my PDF", evidence: WATER_CYCLE_EVIDENCE },
    [gem, hf]
  );
  assertEqual(out.kind, "image", "F7 two providers → image");
  assertEqual(gem.called(), 1, "F7 gemini ran exactly once");
  assertEqual(hf.called(), 0, "F7 HF not reached when the primary succeeds");
}

// ---------------------------------------------------------------------------
// G. Fallback policy
// ---------------------------------------------------------------------------
section("G. Fallback policy");

{
  // Eligible failure (rate_limited) falls back to the next provider.
  const gem = makeProvider("gemini", { kind: "fail", code: "rate_limited" });
  const hf = makeProvider("huggingface", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    { message: "Create an infographic from my PDF", evidence: WATER_CYCLE_EVIDENCE },
    [gem, hf]
  );
  assertEqual(out.kind, "image", "G1 rate_limited falls back");
  if (out.kind === "image") {
    assertEqual(out.image.provider, "huggingface", "G1 fallback provider won");
    assertEqual(out.image.sourceGrounded, true, "G1 fallback result still grounded metadata");
  }
  assertEqual(hf.called(), 1, "G1 HF ran once");
}

{
  // NEVER fall back on safety/auth/invalid-request — surface the safe copy.
  const gem = makeProvider("gemini", { kind: "fail", code: "safety_blocked" });
  const hf = makeProvider("huggingface", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    { message: "Create an infographic from my PDF", evidence: WATER_CYCLE_EVIDENCE },
    [gem, hf]
  );
  assertEqual(out.kind, "message", "G2 safety_blocked never falls back");
  if (out.kind === "message") {
    assertEqual(out.message, SAFE_UNAVAILABLE_MESSAGE, "G2 SAFE_UNAVAILABLE_MESSAGE");
  }
  assertEqual(hf.called(), 0, "G2 HF NOT called after a safety block");
}

{
  const gem = makeProvider("gemini", { kind: "fail", code: "provider_auth" });
  const hf = makeProvider("huggingface", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    { message: "Create an infographic from my PDF", evidence: WATER_CYCLE_EVIDENCE },
    [gem, hf]
  );
  assertEqual(out.kind, "message", "G3 provider_auth is a config gap, no fallback");
  assertEqual(hf.called(), 0, "G3 HF NOT called after auth failure");
}

{
  // Both providers fail eligible codes → safe message, each runs once.
  const gem = makeProvider("gemini", { kind: "fail", code: "provider_unavailable" });
  const hf = makeProvider("huggingface", { kind: "fail", code: "timeout" });
  const out = await generateDocumentVisualWithProviders(
    { message: "Create an infographic from my PDF", evidence: WATER_CYCLE_EVIDENCE },
    [gem, hf]
  );
  assertEqual(out.kind, "message", "G4 all eligible failures → message");
  assertEqual(gem.called(), 1, "G4 gemini ran once");
  assertEqual(hf.called(), 1, "G4 HF ran once");
}

// ---------------------------------------------------------------------------
// H. Output validation
// ---------------------------------------------------------------------------
section("H. Output validation");

{
  // Garbage bytes = provider_invalid_response (eligible) → next provider.
  const gem = makeProvider("gemini", { kind: "bytes", data: Buffer.from("not-an-image") });
  const hf = makeProvider("huggingface", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    { message: "Create an infographic from my PDF", evidence: WATER_CYCLE_EVIDENCE },
    [gem, hf]
  );
  assertEqual(out.kind, "image", "H1 invalid primary bytes fall back");
  if (out.kind === "image") {
    assertEqual(out.image.provider, "huggingface", "H1 HF produced the valid image");
  }
}

{
  // Both providers return garbage → safe message, no crash.
  const gem = makeProvider("gemini", { kind: "bytes", data: Buffer.from("nope") });
  const hf = makeProvider("huggingface", { kind: "bytes", data: Buffer.from("also-nope") });
  const out = await generateDocumentVisualWithProviders(
    { message: "Create an infographic from my PDF", evidence: WATER_CYCLE_EVIDENCE },
    [gem, hf]
  );
  assertEqual(out.kind, "message", "H2 all invalid bytes → safe message");
}

// ---------------------------------------------------------------------------
// I. Server-only secrets + safe logs
// ---------------------------------------------------------------------------
section("I. Server-only secrets + safe logs");

{
  // Provider/config modules must read API keys ONLY from process.env — never
  // from NEXT_PUBLIC_* (which ships to the browser).
  const base = path.join(__dirname, "src", "lib", "image-generation");
  const files = [
    path.join(base, "gemini-provider.ts"),
    path.join(base, "huggingface-provider.ts"),
    path.join(base, "service.ts"),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert(!source.includes("NEXT_PUBLIC_"), `I1 ${path.basename(file)} has no NEXT_PUBLIC_ token references`);
    assert(!source.includes("process.browser"), `I1 ${path.basename(file)} never reads process.browser`);
  }
}

{
  // Logs built by the 6E path never echo configured secrets or raw evidence.
  const secret = "SUPER-SECRET-KEY-VALUE-9f7d";
  const prev = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = secret;
  const captured: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    captured.push(parts.join(" "));
    original(...parts);
  };
  try {
    const gem = makeProvider("gemini", { kind: "fail", code: "provider_unavailable" });
    const hf = makeProvider("huggingface", { kind: "fail", code: "provider_unavailable" });
    await generateDocumentVisualWithProviders(
      {
        message: "Create an infographic from my PDF",
        evidence: [{ text: "CONFIDENTIAL_EVIDENCE_XYZ" }],
      },
      [gem, hf]
    );
    const joined = captured.join("\n");
    assert(!joined.includes(secret), "I2 logs never echo the API key");
    assert(!joined.includes("CONFIDENTIAL_EVIDENCE_XYZ"), "I2 logs never echo raw evidence");
    assert(!joined.includes(hf.params[0]?.prompt ?? "@@none@@"), "I2 logs never echo the composed provider prompt");
  } finally {
    console.error = original;
    if (prev === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prev;
  }
}

// ---------------------------------------------------------------------------
// J. Execution plan (router)
// ---------------------------------------------------------------------------
section("J. Execution plan (router)");

{
  const d = route({
    message: "Create an infographic from my PDF",
    hasSources: true,
    sourceCount: 1,
  });
  const steps = d.executionPlan?.steps ?? [];
  const maxExternalCalls = d.executionPlan?.maxExternalCalls ?? 0;
  const ragStep = steps.find((s) => s.kind === "rag");
  const imageStep = steps.find((s) => s.kind === "image");
  assert(ragStep !== undefined, "J1 doc-visual plan grabs RAG evidence first");
  assert(imageStep !== undefined, "J1 image step present");
  assertEqual(imageStep?.maxCalls, 1, "J1 exactly one image call");
  assert(
    Boolean(ragStep && imageStep && imageStep.dependsOn.includes(ragStep.id)),
    "J1 image step depends on retrieval (retrieval BEFORE generation)"
  );
  assert(maxExternalCalls <= 4, "J1 external-call budget ≤ 4");
}

{
  const d = route({
    message: "Create an infographic from my PDF",
    hasSources: true,
    sourceCount: 1,
  });
  const log = describeQueryRoute(d);
  assert(log.includes("route=DOCUMENT_VISUAL_GENERATION"), "J2 describeQueryRoute marks the route");
  assert(log.includes("dv=1"), "J2 describeQueryRoute flags document-visual intent");
  assert(log.includes("doc=true"), "J2 description carries the doc requirement");
}

{
  // The honest log marker never leaks secrets.
  const d = route({ message: "draw a castle" });
  const log = describeQueryRoute(d);
  assert(log.includes("dv=0"), "J3 pure image turn has no document-visual marker");
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
    const out = await generateDocumentVisual({
      message: "Create an infographic from my PDF",
      evidence: WATER_CYCLE_EVIDENCE,
    });
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
  // The safe copies are honest and must not claim verification.
  assert(
    !SAFE_DOC_VISUAL_NO_DOC_MESSAGE.toLowerCase().includes("100% accurate"),
    "K2 no-doc copy never overclaims"
  );
  assert(
    !SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE.toLowerCase().includes("fact checked"),
    "K2 chart-no-numbers copy never overclaims"
  );
  assert(
    !SAFE_NO_GROUNDING_MESSAGE.toLowerCase().includes("100% accurate"),
    "K2 no-grounding copy never overclaims"
  );
}

// ---------------------------------------------------------------------------
// L. Mocked end-to-end
// ---------------------------------------------------------------------------
section("L. Mocked end-to-end");

{
  // Full path: document-visual turn → router → intent → provider.
  const d = route({ message: "Create an infographic from my annual report", hasSources: true, sourceCount: 1 });
  assertEqual(d.primaryRoute, "DOCUMENT_VISUAL_GENERATION", "L1 router picks document visual");
  const gem = makeProvider("gemini", { kind: "ok" });
  const out = await generateDocumentVisualWithProviders(
    {
      message: d.documentVisualIntent ? "Create an infographic from my annual report" : "",
      evidence: NUMERIC_EVIDENCE,
      requestedVisualType: d.documentVisualIntent?.visualType ?? null,
    },
    [gem]
  );
  assertEqual(out.kind, "image", "L1 generation succeeds");
  if (out.kind === "image") {
    assertEqual(out.image.sourceGrounded, true, "L1 grounded metadata");
    assertEqual(out.image.visualType, "infographic", "L1 visual type metadata");
    const prompt = (gem.params[0]?.prompt ?? "") as string;
    assert(prompt.includes("infographic"), "L1 composed diag prompt");
    assert(prompt.includes("Revenue grew 40% in 2024"), "L1 evidence grounded");
  }
}

{
  // Mocked end-to-end refusal: chart request, non-numeric doc.
  const d = route({ message: "Chart my schedule from my notes", hasSources: true, sourceCount: 1 });
  const out = await generateDocumentVisualWithProviders(
    {
      message: "Chart my schedule from my notes",
      evidence: WATER_CYCLE_EVIDENCE,
      requestedVisualType: d.documentVisualIntent?.visualType ?? "chart",
    },
    EMPTY_PROVIDERS
  );
  assertEqual(out.kind, "message", "L2 chart-without-numbers refused");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nPhase 6E: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Phase 6E has FAILING assertions.");
  process.exit(1);
}
}

main().catch((error) => {
  console.error("Phase 6E crashed:", error);
  process.exit(1);
});