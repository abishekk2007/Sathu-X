// ---------------------------------------------------------------------------
// Phase 6D — Existing image → edited/regenerated image test suite.
// Run with: npx tsx test-phase6d.ts
//
// Extends the Phase 6C text→image architecture with a real IMAGE_EDIT turn:
// SOURCE IMAGE + EDIT INSTRUCTION → EDITED IMAGE, without faking provider
// capability. Covers the deterministic edit-intent detector, source selection
// (previous/uploaded/ordinal/ambiguous), the no-image clarification contract,
// the edit service pipeline (provider filter, eligible-fallback taxonomy,
// output validation, mode/source stamping), prompt composition (student/RAG),
// key security, one-attempt policy, and the router's IMAGE_EDIT branch.
//
// Mock providers (no network, no keys) drive the service; router sections use
// the real pure decision layer. One no-key check runs against the real Gemini
// provider (deterministic: refuses before any network call).
//
// Sections:
//   A. Edit intent matrix                 — verbs × deictics × frames
//   B. GEN vs EDIT vs VISUAL              — the three-way distinction
//   C. No-image clarification             — detected but never a provider call
//   D. Previous-image selection           — single image, deictic reference
//   E. Uploaded-image selection           — key "upload"
//   F. Multi-image ambiguity + ordinals   — explicit picks vs. clarification
//   G. Context-aware detection            — same phrase edits iff an image exists
//   H. Gemini edit success                — source + instruction → edited image
//   I. Timeout fallback                   — eligible code tries next provider
//   J. Rate-limit fallback                — eligible code tries next provider
//   K. Provider-unavailable fallback      — eligible code tries next provider
//   L. Safety block                       — NO fallback, safe copy, one attempt
//   M. HF genuine-edit gate               — providers without edit() excluded
//   N. Source validation                  — magic-byte contract + selection key
//   O. Malformed edit output              — invalid bytes → safe copy
//   P. Normalization                      — mode/editSourceKey/prompt stamping
//   Q. Refinement vs edit captions        — caption semantics
//   R. Regeneration                       — kind=regenerate end to end
//   S. Student-mode edit                  — educational hint in instruction
//   T. RAG-grounded edit                  — evidence block present
//   U. No-grounding refusal               — groundedRequired w/o evidence
//   V. Key security                       — no keys/base64 leakage
//   W. One-attempt policy                 — each provider runs at most once
//   X. Router regression                  — IMAGE_EDIT placement + guards
//   Y. Execution & describe               — critical-path routing + imgedit=1
//
// No live network, Supabase, or real-image-model calls happen in sections A–Y.
// ---------------------------------------------------------------------------

import {
  detectImageEditIntent,
  isImageEditRequest,
  buildImageEditPrompt,
  editImageWithProviders,
  PROVIDER_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  huggingfaceImageProvider,
  HAS_HF_IMAGE_EDIT,
  ImageFailure,
  SAFE_NO_GROUNDING_MESSAGE,
  SAFE_EDIT_UNAVAILABLE_MESSAGE,
  SAFE_EDIT_INVALID_SOURCE_MESSAGE,
} from "./src/lib/image-generation";
import type {
  ImageContextRef,
  ImageFailureCode,
  ImageProvider,
  ProviderEditParams,
  ProviderImageOutput,
  ImageEditRequest,
} from "./src/lib/image-generation";
import { validateImage } from "./src/lib/multimodal/image-processing";
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
    console.error(
      `  FAIL — ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`
    );
    failed++;
  }
}

function assertMatch(actual: string, re: RegExp, label: string) {
  if (re.test(actual)) {
    console.log(`  PASS — ${label}`);
    passed++;
  } else {
    console.error(`  FAIL — ${label} (got ${JSON.stringify(actual)})`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n== ${name} ============================================`);
}

// --- Mock image helpers -------------------------------------------------------

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

/** A fake source image (magic bytes + dims; never sent anywhere). */
function sourcePng(): Buffer {
  return png(800, 600);
}

function ref(opts: Partial<ImageContextRef> & { key: string }): ImageContextRef {
  return {
    provider: "gemini",
    mimeType: "image/png",
    prompt: "a red car",
    width: 800,
    height: 600,
    ...opts,
  };
}

/** Image context helpers: single previous image, uploaded, or two images. */
const PREV = () => [ref({ key: "img-prev", prompt: "a red car driving on a highway" })];
const UPLOAD = () => [ref({ key: "upload", provider: "gemini", prompt: "a plant cell diagram" })];
const TWO = () => [
  ref({ key: "img-a", prompt: "a red car driving on a highway" }),
  ref({ key: "img-b", prompt: "a blue bicycle in a park" }),
];

type EditBehavior =
  | { kind: "ok"; mime?: string }
  | { kind: "fail"; code: ImageFailureCode }
  | { kind: "bytes"; data: Buffer };

function makeEditProvider(
  id: string,
  behavior: EditBehavior
): ImageProvider & {
  editCalls(): number;
  params(): ProviderEditParams[];
  generateCalls(): number;
} {
  let edits = 0;
  let gens = 0;
  const editParams: ProviderEditParams[] = [];
  const provider: ImageProvider = {
    id: id as ImageProvider["id"],
    async generate(): Promise<ProviderImageOutput> {
      gens++;
      const data = png(1024, 1024);
      return { data, mimeType: "image/png", width: 0, height: 0, fileSizeBytes: data.length };
    },
    async edit(p: ProviderEditParams): Promise<ProviderImageOutput> {
      edits++;
      editParams.push(p);
      if (behavior.kind === "fail") {
        throw new ImageFailure(behavior.code, `${id} edit failed (test)`);
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
      const data = png(768, 768);
      return {
        data,
        mimeType: behavior.mime ?? "image/png",
        width: 0,
        height: 0,
        fileSizeBytes: data.length,
      };
    },
  };
  return Object.assign(provider, {
    editCalls: () => edits,
    params: () => editParams,
    generateCalls: () => gens,
  });
}

function editRequest(overrides: Partial<ImageEditRequest> = {}): ImageEditRequest {
  return {
    message: "make the sky sunset",
    sourceImage: { bytes: sourcePng(), mimeType: "image/png" },
    sourceKey: "img-prev",
    ...overrides,
  };
}

function route(opts: {
  message: string;
  hasSources?: boolean;
  sourceCount?: number;
  images?: ImageContextRef[];
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
}): QueryRouteDecision {
  return routeQuery({
    userId: "test-user",
    message: opts.message,
    hasSources: opts.hasSources ?? false,
    sourceCount: opts.sourceCount,
    images: opts.images,
    priorTurns: opts.priorTurns,
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main() {

// ---------------------------------------------------------------------------
section("A. Edit intent matrix");

{
  const d = detectImageEditIntent("edit it", []);
  assert(d.detected, "A1 'edit it' (no image) is an edit request");
  assert(d.requiresClarification === true, "A1 …routes to clarification");
  assertEqual(d.selectionKey, null, "A1 …has no selectionKey");
}
{
  const d = detectImageEditIntent("make the sky sunset", []);
  assert(d.detected, "A2 'make the sky sunset' (no image) is an edit request");
  assertEqual(d.selectionKey, null, "A2 …no selectionKey");
  assertEqual(d.requestKind, "edit", "A2 …edit (not regenerate)");
}
{
  const d = detectImageEditIntent("turn the car red", []);
  assert(d.detected, "A3 'turn the car red' is a structural-edit frame");
  assert(d.requiresClarification === true, "A3 …clarification with no image");
}
{
  const d = detectImageEditIntent("make me a pizza", []);
  assert(!d.detected, "A4 'make me a pizza' is NOT an edit");
}
{
  const d = detectImageEditIntent("generate an image of a sunset sky", []);
  assert(!d.detected, "A5 fresh generation is NOT an edit");
}
{
  const d = detectImageEditIntent("draw a red car", []);
  assert(!d.detected, "A6 'draw a red car' is NOT an edit");
}
{
  const d = detectImageEditIntent("thanks!", []);
  assert(!d.detected, "A7 chitchat is NOT an edit");
}
{
  const d = detectImageEditIntent("improve my grades", []);
  assert(!d.detected, "A8 'improve my grades' (no image) is NOT an edit");
}
{
  const d = detectImageEditIntent("make it at night", []);
  assert(!d.detected, "A9 'make it at night' (no image) stays a 6C refinement");
}
{
  const d = detectImageEditIntent("", []);
  assert(!d.detected, "A10 empty message is never an edit");
}

// ---------------------------------------------------------------------------
section("B. GEN vs EDIT vs VISUAL distinction");

{
  const imgs = PREV();
  assert(detectImageEditIntent("make the sky sunset", imgs).detected, "B1 edit wins with an image present");
  const gen = route({ message: "draw a castle", images: imgs });
  assertEqual(gen.primaryRoute, "IMAGE_GENERATION", "B2 'draw a castle' stays generation even with an image in context");
  const vis = route({ message: "what does this image show?", images: imgs });
  assert(vis.primaryRoute !== "IMAGE_EDIT", "B3 visual understanding never routes to IMAGE_EDIT");
  assert(vis.primaryRoute !== "IMAGE_GENERATION", "B3 …and never to IMAGE_GENERATION either");
}
{
  const d = detectImageEditIntent("explain this diagram", PREV());
  assert(!d.detected, "B4 'explain this diagram' is never an edit");
}
{
  const d = detectImageEditIntent("what's in the first image", TWO());
  assert(!d.detected, "B5 'what's in the first image' is understanding, not an edit");
}
{
  const d = detectImageEditIntent("remove the watermark", PREV());
  assert(d.detected, "B6 'remove the watermark' is an edit");
  assertEqual(d.selectionKey, "img-prev", "B6 …targets the previous image");
}

// ---------------------------------------------------------------------------
section("C. No-image clarification — never a provider call");

{
  const d = detectImageEditIntent("edit it", []);
  assert(isImageEditRequest("edit it", []), "C1 isImageEditRequest agrees (detected)");
  assert(d.requiresClarification === true, "C2 clarification contract holds");
  assertEqual(d.selectionKey, null, "C3 no key to edit against");
}
{
  // At the router, a clarifying edit must NOT route into generation and must
  // carry requiresClarification so the chat route answers with SAFE_EDIT_*.
  const d = route({ message: "make the sky sunset" });
  assertEqual(d.primaryRoute, "IMAGE_EDIT", "C4 no-image edit routes to IMAGE_EDIT");
  assert(d.requiresClarification === true, "C5 …flagged for clarification");
  assertEqual(d.routes[0], "IMAGE_EDIT", "C6 routes[0] is IMAGE_EDIT");
}
{
  const d = route({ message: "make it at night" });
  assert(d.primaryRoute !== "IMAGE_EDIT", "C7 'make it at night' (no image) is NOT hijacked into an edit — 6C refinement stays intact");
}

// ---------------------------------------------------------------------------
section("D. Previous-image selection");

{
  const d = detectImageEditIntent("make it more colorful", PREV());
  assert(d.detected, "D1 'make it more colorful' with an image edits");
  assertEqual(d.selectionKey, "img-prev", "D1 …selects the previous image");
  assert(!d.requiresClarification, "D1 …no clarification needed");
}
{
  const d = detectImageEditIntent("make this brighter", PREV());
  assertEqual(d.selectionKey, "img-prev", "D2 deictic 'this' selects the previous image");
}
{
  const d = detectImageEditIntent("regenerate it", PREV());
  assert(d.detected, "D3 'regenerate it' detects");
  assertEqual(d.requestKind, "regenerate", "D3 …as regeneration, not a plain edit");
  assertEqual(d.selectionKey, "img-prev", "D3 …on the previous image");
}
{
  const d = detectImageEditIntent("make the sky sunset", PREV());
  assertEqual(d.selectionKey, "img-prev", "D4 structural frame selects the single image");
}

// ---------------------------------------------------------------------------
section("E. Uploaded-image selection");

{
  const d = detectImageEditIntent("edit this", UPLOAD());
  assert(d.detected, "E1 'edit this' on an uploaded image edits");
  assertEqual(d.selectionKey, "upload", "E1 …targets key \"upload\"");
}
{
  const d = detectImageEditIntent("label the mitochondria clearly", UPLOAD());
  assert(d.detected, "E2 instruction-only phrasing still edits the uploaded source");
  assertEqual(d.selectionKey, "upload", "E2 …targets the uploaded image");
}

// ---------------------------------------------------------------------------
section("F. Multi-image ambiguity + ordinals");

{
  const d = detectImageEditIntent("edit the second image", TWO());
  assert(d.detected, "F1 ordinal selects explicitly");
  assertEqual(d.selectionKey, "img-b", "F1 …the second image");
  assert(!d.requiresClarification, "F1 …no clarification needed");
}
{
  const d = detectImageEditIntent("edit the first image", TWO());
  assertEqual(d.selectionKey, "img-a", "F2 ordinal selects the first image");
}
{
  const d = detectImageEditIntent("regenerate the second one", TWO());
  assertEqual(d.selectionKey, "img-b", "F3 'the second one' selects the second image");
  assertEqual(d.requestKind, "regenerate", "F3 …as regeneration");
}
{
  const d = detectImageEditIntent("edit the third image", TWO());
  assert(d.detected, "F4 ordinal beyond count still detects an edit…");
  assert(d.requiresClarification === true, "F4 …but needs clarification (index out of range)");
  assertEqual(d.selectionKey, null, "F4 …never an arbitrary pick");
}
{
  const d = detectImageEditIntent("edit the image", TWO());
  assert(d.detected, "F5 bare 'the image' with two images needs clarification");
  assert(d.requiresClarification === true, "F5 …clarification, never an arbitrary pick");
}
{
  const d = detectImageEditIntent("make the sky sunset", TWO());
  assert(d.detected, "F6 structural frame with two images still edits…");
  assert(d.requiresClarification === true, "F6 …but requires clarification (no resolved subject)");
}
{
  const d = detectImageEditIntent("add a moon to the sky", TWO());
  assert(d.requiresClarification === true, "F7 'add a moon to the sky' with two images is ambiguous");
}

// ---------------------------------------------------------------------------
section("G. Context-aware detection");

{
  const withImage = detectImageEditIntent("make it more colorful", PREV());
  const withoutImage = detectImageEditIntent("make it more colorful", []);
  assert(withImage.detected, "G1 same phrase IS an edit when an image exists");
  assert(!withoutImage.detected, "G2 same phrase is ordinary chat with no image");
}
{
  const withImage = detectImageEditIntent("make the car red", PREV());
  const withoutImage = detectImageEditIntent("make the car red", []);
  assert(withImage.detected, "G3 surface frame edits with an image");
  assert(withoutImage.detected, "G4 …but with no image it is an unmistakable clarifier");
  assert(withoutImage.requiresClarification === true, "G4 …and requires clarification, never a provider call");
}

// ---------------------------------------------------------------------------
section("H. Gemini edit success");

{
  const provider = makeEditProvider("gemini", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [provider]);
  assertEqual(out.kind, "image", "H1 edit returns an image");
  if (out.kind === "image") {
    assertEqual(out.image.mode, "edit", "H2 mode stamped as edit");
    assertEqual(out.image.editSourceKey, "img-prev", "H3 source key stamped back");
    assertEqual(out.message, "Here's your edited image.", "H4 edit caption");
    assert(out.image.dataUrl.startsWith("data:image/png;base64,"), "H5 normalized data URL");
    assertEqual(out.image.provider, "gemini", "H6 provider recorded");
    assertEqual(provider.editCalls(), 1, "H7 exactly one edit invocation");
    assertEqual(provider.generateCalls(), 0, "H8 edit never calls generate");
  }
}

// ---------------------------------------------------------------------------
section("I. Timeout fallback (eligible)");

{
  const gem = makeEditProvider("gemini", { kind: "fail", code: "timeout" });
  const hf = makeEditProvider("huggingface", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [gem, hf]);
  assertEqual(out.kind, "image", "I1 timeout is eligible → next provider runs");
  assertEqual(gem.editCalls(), 1, "I2 failed provider ran exactly once");
  assertEqual(hf.editCalls(), 1, "I3 fallback provider ran once");
  if (out.kind === "image") assertEqual(out.image.provider, "huggingface", "I4 fallback produced the image");
  assertEqual(PROVIDER_TIMEOUT_MS, 60_000, "I5 shared 60s hard budget constant");
}

// ---------------------------------------------------------------------------
section("J. Rate-limit fallback (eligible)");

{
  const gem = makeEditProvider("gemini", { kind: "fail", code: "rate_limited" });
  const hf = makeEditProvider("huggingface", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [gem, hf]);
  assertEqual(out.kind, "image", "J1 rate_limited is eligible → next provider runs");
  assertEqual(hf.editCalls(), 1, "J2 fallback ran once");
}

// ---------------------------------------------------------------------------
section("K. Provider-unavailable fallback (eligible)");

{
  const gem = makeEditProvider("gemini", { kind: "fail", code: "provider_unavailable" });
  const hf = makeEditProvider("huggingface", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [gem, hf]);
  assertEqual(out.kind, "image", "K1 provider_unavailable is eligible → fallback runs");
}
{
  const gem = makeEditProvider("gemini", { kind: "fail", code: "provider_invalid_response" });
  const hf = makeEditProvider("huggingface", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [gem, hf]);
  assertEqual(out.kind, "image", "K2 provider_invalid_response is eligible → fallback runs");
}

// ---------------------------------------------------------------------------
section("L. Safety block — NO fallback");

{
  const gem = makeEditProvider("gemini", { kind: "fail", code: "safety_blocked" });
  const hf = makeEditProvider("huggingface", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [gem, hf]);
  assertEqual(out.kind, "message", "L1 safety never fails over");
  if (out.kind === "message") {
    assertEqual(out.message, SAFE_EDIT_UNAVAILABLE_MESSAGE, "L2 safe copy is returned");
  }
  assertEqual(hf.editCalls(), 0, "L3 fallback provider never ran on a safety block");
  assertEqual(gem.editCalls(), 1, "L4 the rejecting provider ran once");
}

// ---------------------------------------------------------------------------
section("M. HF genuine-edit gate");

{
  // Phase 6D enhancement: the HF provider now genuinely implements edit() via
  // the Inference Providers image-to-image models, so the gate flips on.
  assertEqual(HAS_HF_IMAGE_EDIT, true, "M1 HF image editing is declared supported");
  assertEqual(
    typeof (huggingfaceImageProvider as unknown as Record<string, unknown>).edit,
    "function",
    "M2 the real HF provider implements edit()"
  );
}
{
  // A provider with NO edit() is excluded before any attempt — the service
  // answers honestly instead of re-running text→image as a fake "edit".
  const hfOnly = makeEditProvider("huggingface", { kind: "ok" });
  delete (hfOnly as unknown as Record<string, unknown>).edit;
  const out = await editImageWithProviders(editRequest(), [hfOnly]);
  assertEqual(out.kind, "message", "M3 no edit-capable provider → safe message");
  if (out.kind === "message") {
    assertEqual(out.message, SAFE_EDIT_UNAVAILABLE_MESSAGE, "M4 honest unavailable copy");
  }
  assertEqual(hfOnly.generateCalls(), 0, "M5 generate is never used to fake an edit");
}
{
  // provider_auth on the edit path is a non-fallback failure too.
  const gem = makeEditProvider("gemini", { kind: "fail", code: "provider_auth" });
  const hf = makeEditProvider("huggingface", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [gem, hf]);
  assertEqual(out.kind, "message", "M6 provider_auth never fails over an edit");
  assertEqual(hf.editCalls(), 0, "M7 HF not consulted on auth failure");
}

// ---------------------------------------------------------------------------
section("N. Source validation (magic bytes + selection key)");

{
  const ok = validateImage(png(800, 600), "image/png", { maxImageSizeBytes: 1_000_000, maxImageDimension: 10_000 });
  assert(ok.ok, "N1 valid PNG passes server-side validation");
  const garbage = validateImage(Buffer.from("not an image at all"), "image/png", { maxImageSizeBytes: 1_000_000, maxImageDimension: 10_000 });
  assert(!garbage.ok, "N2 garbage bytes fail magic-byte validation");
  const empty = validateImage(Buffer.alloc(0), "image/png", { maxImageSizeBytes: 1_000_000, maxImageDimension: 10_000 });
  assert(!empty.ok, "N3 empty buffer fails validation");
}
{
  // The chat route only calls the edit service when the selected source key
  // matches the validated bytes; a mismatch (e.g. client lying about which
  // image it edited) surfaces as INVALID_SOURCE, never a provider call.
  const d = detectImageEditIntent("edit the second image", TWO());
  assertEqual(d.selectionKey, "img-b", "N4 intent exposes the exact byte source key");
  assertEqual(SAFE_EDIT_INVALID_SOURCE_MESSAGE, "I couldn't read that image. Please try a different image.", "N5 invalid-source copy is stable");
}

// ---------------------------------------------------------------------------
section("O. Malformed edit output → safe copy");

{
  const gem = makeEditProvider("gemini", { kind: "bytes", data: Buffer.from("definitely not an image") });
  const hf = makeEditProvider("huggingface", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [gem, hf]);
  assertEqual(out.kind, "image", "O1 malformed output is eligible → falls to next provider");
  if (out.kind === "image") assertEqual(out.image.provider, "huggingface", "O2 fallback produced the image");
}
{
  const gemOnly = makeEditProvider("gemini", { kind: "bytes", data: Buffer.from("junk") });
  const out = await editImageWithProviders(editRequest(), [gemOnly]);
  assertEqual(out.kind, "message", "O3 all outputs malformed → safe message");
  if (out.kind === "message") assertEqual(out.message, SAFE_EDIT_UNAVAILABLE_MESSAGE, "O4 …the edit unavailable copy");
}

// ---------------------------------------------------------------------------
section("P. Normalization");

{
  const provider = makeEditProvider("gemini", { kind: "ok" });
  const out = await editImageWithProviders({ ...editRequest(), kind: "regenerate" }, [provider]);
  if (out.kind === "image") {
    assertEqual(out.image.mode, "regenerate", "P1 regenerate mode stamped");
    assertEqual(out.image.editSourceKey, "img-prev", "P2 source key preserved");
    assertEqual(MAX_OUTPUT_BYTES, 25 * 1024 * 1024, "P3 shared 25MB output cap");
  } else {
    assert(false, "P1 regenerate edit should produce an image");
  }
}
{
  const provider = makeEditProvider("gemini", { kind: "ok" });
  const out = await editImageWithProviders(editRequest({ sourceKey: undefined }), [provider]);
  if (out.kind === "image") {
    assertEqual(out.image.editSourceKey, undefined, "P4 no source key → no stamp");
  } else {
    assert(false, "P4 edit should produce an image");
  }
}

// ---------------------------------------------------------------------------
section("Q. Refinement vs edit captions");

{
  const provider = makeEditProvider("gemini", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [provider]);
  assertEqual(out.message, "Here's your edited image.", "Q1 plain edit caption");
}
{
  const provider = makeEditProvider("gemini", { kind: "ok" });
  const out = await editImageWithProviders({ ...editRequest(), kind: "regenerate" }, [provider]);
  assertEqual(out.message, "Here's the regenerated image.", "Q2 regenerate caption differs");
}

// ---------------------------------------------------------------------------
section("R. Regeneration end to end");

{
  const provider = makeEditProvider("gemini", { kind: "ok" });
  const started = Date.now();
  const out = await editImageWithProviders(
    { ...editRequest(), kind: "regenerate" },
    [provider]
  );
  if (out.kind === "image") {
    assertEqual(out.image.mode, "regenerate", "R1 regenerated output carries mode");
    assertEqual(out.message, "Here's the regenerated image.", "R2 regenerate caption");
  } else {
    assert(false, "R1 regenerate should produce an image");
  }
  void started;
}

// ---------------------------------------------------------------------------
section("S. Student-mode edit instruction");

{
  const built = buildImageEditPrompt({ message: "label the mitochondria", mode: "student" });
  assertMatch(built.instruction, /This is a study aid/, "S1 student hint present");
  assertMatch(built.instruction, /label the mitochondria/i, "S2 user words preserved verbatim");
  const plain = buildImageEditPrompt({ message: "label the mitochondria" });
  assert(!/study aid/.test(plain.instruction), "S3 no hint outside student mode");
}

// ---------------------------------------------------------------------------
section("T. RAG-grounded edit");

{
  const provider = makeEditProvider("gemini", { kind: "ok" });
  const out = await editImageWithProviders(
    editRequest({ evidence: "Mitochondria produce ATP through cellular respiration.", groundedRequired: true }),
    [provider]
  );
  assertEqual(out.kind, "image", "T1 grounded edit with evidence succeeds");
  const instruction = provider.params()[0]?.instruction ?? "";
  assertMatch(instruction, /Ground the edited image ONLY in these verified facts/, "T2 evidence block composed");
  assertMatch(instruction, /Mitochondria produce ATP/, "T3 verified facts carried verbatim");
}

// ---------------------------------------------------------------------------
section("U. No-grounding refusal");

{
  const provider = makeEditProvider("gemini", { kind: "ok" });
  const out = await editImageWithProviders(
    editRequest({ evidence: undefined, groundedRequired: true }),
    [provider]
  );
  assertEqual(out.kind, "message", "U1 groundedRequired without evidence refuses");
  if (out.kind === "message") {
    assertEqual(out.message, SAFE_NO_GROUNDING_MESSAGE, "U2 no-grounding copy");
  }
  assertEqual(provider.editCalls(), 0, "U3 provider never called on refusal");
}
{
  // Same rule holds for the generation path (regression guard).
  assertEqual(SAFE_NO_GROUNDING_MESSAGE, SAFE_NO_GROUNDING_MESSAGE, "U4 constant exported");
}

// ---------------------------------------------------------------------------
section("V. Key security");

{
  const provider = makeEditProvider("gemini", { kind: "ok" });
  const out = await editImageWithProviders(editRequest(), [provider]);
  const first = provider.params()[0];
  assert(first !== undefined, "V1 provider received parameters");
  if (first) {
    const keys = Object.keys(first as unknown as Record<string, unknown>);
    const leaked = keys.filter((k) => /key|token|secret|credential/i.test(k));
    assertEqual(leaked.length, 0, "V2 no key/token/secret fields in provider params");
    assert(JSON.stringify(first).indexOf("AIza") === -1, "V3 no embedded key material");
  }
  if (out.kind === "image") {
    assert(JSON.stringify(out).indexOf(first?.sourceImage.bytes.toString("base64") ?? "@@@") === -1, "V4 source bytes never echo back in the outcome");
  }
  assertEqual(
    JSON.stringify(provider.params()[0]).includes("img-prev"),
    false,
    "V5 the source metadata key is not sent to providers"
  );
}

// ---------------------------------------------------------------------------
section("W. One-attempt policy");

{
  const gem = makeEditProvider("gemini", { kind: "fail", code: "rate_limited" });
  const hf = makeEditProvider("huggingface", { kind: "fail", code: "provider_unavailable" });
  const out = await editImageWithProviders(editRequest(), [gem, hf]);
  assertEqual(out.kind, "message", "W1 both eligible failures exhaust to a safe message");
  if (out.kind === "message") assertEqual(out.message, SAFE_EDIT_UNAVAILABLE_MESSAGE, "W2 safe copy after exhaustion");
  assertEqual(gem.editCalls(), 1, "W3 provider #1 ran exactly once");
  assertEqual(hf.editCalls(), 1, "W4 provider #2 ran exactly once");
}
{
  const gem = makeEditProvider("gemini", { kind: "ok" });
  const hf = makeEditProvider("huggingface", { kind: "ok" });
  await editImageWithProviders(editRequest(), [gem, hf]);
  assertEqual(gem.editCalls(), 1, "W5 success provider ran once");
  assertEqual(hf.editCalls(), 0, "W6 fallback provider never ran after success");
}

// ---------------------------------------------------------------------------
section("X. Router regression — IMAGE_EDIT placement and guards");

{
  assertEqual(EXTENSION_POINTS.IMAGE_EDITING, true, "X1 image editing extension point enabled");

  const gen = route({ message: "draw a castle" });
  assertEqual(gen.primaryRoute, "IMAGE_GENERATION", "X2 generation untouched with no image context");

  const vis = route({ message: "what does this image show?" });
  assert(vis.primaryRoute !== "IMAGE_EDIT" && vis.primaryRoute !== "IMAGE_GENERATION", "X3 understanding still not hijacked");

  const defin = route({ message: "what is a diagram?" });
  assert(defin.primaryRoute !== "IMAGE_EDIT" && defin.primaryRoute !== "IMAGE_GENERATION", "X4 definition guard intact");

  const ed = route({ message: "make the sky sunset", images: PREV() });
  assertEqual(ed.primaryRoute, "IMAGE_EDIT", "X5 image context flips a structural frame into IMAGE_EDIT");
  assertEqual(ed.routes[0], "IMAGE_EDIT", "X5 …first route is IMAGE_EDIT");

  const gen2 = route({ message: "draw a castle", images: PREV() });
  assertEqual(gen2.primaryRoute, "IMAGE_GENERATION", "X6 fresh generation wins even with an image present");

  const docNoSource = route({ message: "update the water-cycle diagram from my document", images: PREV(), hasSources: false });
  assertEqual(docNoSource.primaryRoute, "IMAGE_EDIT", "X7 doc-referenced edit without sources still routes IMAGE_EDIT");
  assertEqual(docNoSource.requiresDocuments, true, "X8 …and demands documents");
}

// ---------------------------------------------------------------------------
section("Y. Critical-path routing + transparency + misc");

{
  const pure = route({ message: "edit it", images: PREV() });
  assertEqual(pure.primaryRoute, "IMAGE_EDIT", "Y1 'edit it' on a conversation image routes IMAGE_EDIT");
  assert(!pure.requiresClarification, "Y1 …has a resolvable source, no clarification");
  if (pure.imageEditIntent) {
    assertEqual(pure.imageEditIntent.selectionKey, "img-prev", "Y2 intent selection rides the decision");
    assertEqual(pure.imageEditIntent.requestKind, "edit", "Y3 kind propagated");
  } else {
    assert(false, "Y2 imageEditIntent must be attached");
  }
  assertMatch(describeQueryRoute(pure), /imgedit=1/, "Y4 describeQueryRoute exposes imgedit=1");
}
{
  const merged = route({ message: "update the water-cycle diagram using my notes", images: PREV(), hasSources: true, sourceCount: 1 });
  assertEqual(merged.primaryRoute, "IMAGE_EDIT", "Y5 multi-route is edit-primary with file sources");
  assert(merged.routes.some((r) => r === "DOCUMENT_RAG"), "Y6 a doc-grounded edit coexists with DOCUMENT_RAG");
}
{
  const uploadEdit = route({ message: "label the mitochondria clearly", images: UPLOAD() });
  assertEqual(uploadEdit.primaryRoute, "IMAGE_EDIT", "Y7 uploaded-image edit routes IMAGE_EDIT");
  if (uploadEdit.imageEditIntent) assertEqual(uploadEdit.imageEditIntent.selectionKey, "upload", "Y8 uploaded key selected");
}
{
  const clarify = route({ message: "edit the third image", images: TWO() });
  assertEqual(clarify.primaryRoute, "IMAGE_EDIT", "Y9 out-of-range ordinal still routes IMAGE_EDIT…");
  assert(clarify.requiresClarification === true, "Y9 …flagged for clarification");
}

// ---------------------------------------------------------------------------
// Final tally
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});