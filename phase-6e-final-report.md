# Phase 6E — Document → Visual Generation: Final Report

**Status:** AUTOMATED ✅ · LIVE API ✅ (real grounded chart image produced live; Gemini rate_limited → Hugging Face generation fallback is the live production path, exact same as 6C/6D; refinement guard refuses unsupported facts client-free) · BROWSER 🔲 (PENDING)
**Date:** 2026-08-29

## 1. What shipped

A `DOCUMENT_VISUAL_GENERATION` capability layered **onto** the Phase 6C/6D
image architecture (no second image stack, no duplicate validation/fallback):
a deterministic document-visual intent detector routes "Draw a chart of the
weather in Delhi from my PDF" to RAG retrieval → bounded evidence → structured
visual spec → grounded prompt → the SAME Gemini→HF provider pipeline with a
strict grounding gate. A visual is only ever produced from the attached
document's evidence — never from memory.

- `src/lib/image-generation/document-visual-types.ts` (NEW) — closed taxonomy
  of 10 visual types (`DOCUMENT_VISUAL_TYPES`, priority-ordered, labels,
  `isDocumentVisualType`).
- `src/lib/image-generation/document-visual-intent.ts` (NEW) — deterministic
  `detectDocumentVisualIntent` / `detectDocumentVisualRefinement` /
  `resolveDocumentVisualIntent` / `hasDocumentContext` / `inferDocumentVisualType`:
  - a document/source reference PLUS a visual-generation signal (action verb +
    visual noun, "turn … into …", or an unmissable visual verb) is required;
    grounding is THE gate — no document ⇒ refusal, memory never substitutes
  - "Show me the diagram in my PDF" (reading/referencing) is NOT detected;
    "what does the chart show?" / "explain this chart" (understanding) is
    REJECTED and never routes here; pure "draw a diagram of photosynthesis"
    stays IMAGE_GENERATION; "summarize my PDF" stays DOCUMENT_RAG
  - `visualType` is inferred ONLY when wording is unambiguous ("an infographic
    or a timeline" ⇒ null, generic grounded instruction, never contradicting)
  - refinements: presentation-only signals ("make it simpler", max 8 words)
    of a prior document-visual turn carry `refinementOf` + the prior type;
    questions, chit-chat, understanding, and fresh doc-visual asks are never
    refinements
- `src/lib/image-generation/document-visual-evidence.ts` (NEW) —
  `normalizeEvidence` (dedup, `MAX_EVIDENCE_ITEMS=20`,
  `MAX_EVIDENCE_ITEM_CHARS=3000`, `MAX_EVIDENCE_CHARS=12000`; legacy
  `{text,page,score}` retrieval chunks accepted), `extractNumericTokens` (fixed
  `$520`/`40%`/`2024` boundaries), `hasNumericEvidence` (the chart gate),
  `buildEvidenceContext`.
- `src/lib/image-generation/document-visual-prompt.ts` (NEW) — structured
  `DocumentVisualSpec` (keyFacts/relationships/sequence/entities/numbers/
  sourceReferences/groundingText) + `buildDocumentVisualPrompt` with per-type
  anti-hallucination instructions + `VERIFICATION_RULES`, bounded to
  `DOC_VISUAL_PROMPT_MAX_CHARS=14000` (evidence block ≤ 9000); `guardRefinementClaims`
  blocks refinement-introduced numbers/years absent from the evidence.
- `src/lib/image-generation/service.ts` — refactored the 6C/6D fallback loop
  into ONE shared `runWithPolicy<P extends ImageProvider>` generic used by
  generate/edit/document-visual (no behavioral change, no duplicated logic);
  `generateDocumentVisualWithProviders`/`generateDocumentVisual` enforce: no
  evidence → `SAFE_NO_GROUNDING_MESSAGE`, chart-without-numbers →
  `SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE`, unsupported refinement claim →
  `SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE`, then the grounded prompt →
  provider fallback policy (eligible codes only, provider max once) → output
  with `sourceGrounded=true` + `visualType` stamped.
- Router: `src/lib/agent/query-router.ts` — `DOCUMENT_VISUAL_GENERATION` as
  branch 4b (BELOW `IMAGE_EDIT`/4 so "edit the diagram from my PDF" stays an
  edit, ABOVE `IMAGE_GENERATION`/4c), `documentVisualIntent` on the decision,
  `EXTENSION_POINTS.DOCUMENT_VISUAL_GENERATION` (7 slots now),
  `dv=0/1` in `describeQueryRoute`; no-sources ⇒ routes here with
  `requiresDocuments` so the chat route refuses before any provider call.
- Chat route: `src/app/api/chat/route.ts` — `isDocumentVisual` flag,
  `retrievalMessage` (uses the ORIGINAL prior ask when a turn is a refinement so
  evidence always matches the mother request), evidence capture in both legacy
  and agent retrieval paths, `handleDocumentVisualTurn`, `sourceGrounded`/
  `visualType` emitted into the `image_message` JSON, `extractRetryMs` binding
  fixed.
- Frontend: `src/types/index.ts` (`ChatImageAttachment.sourceGrounded`/
  `visualType`) + `assistant-message.tsx` ("Based on your document · <type>"
  figcaption only when grounded).
- Tests: `test-phase6e.ts` (NEW, 160 assertions, A–L, mocked providers, no
  network) + 6B G5–G7 (7 extension slots) + 6C C4b/C5/C6 flipped to
  `DOCUMENT_VISUAL_GENERATION` for the three doc-image turns.
- No new environment variables (6E reuses `GEMINI_API_KEY`/`HF_TOKEN`/
  `HF_IMAGE_MODEL`/`HF_INFERENCE_PROVIDER`).

## 2. Tier 1 — AUTOMATED (all green, run 2026-08-29)

| Gate | Result |
|---|---|
| `npx tsx test-phase6e.ts` | **160 passed, 0 failed** (NEW — A–L) |
| `npx tsx test-phase6c.ts` | **164 passed, 0 failed** (C4b/C5/C6 flipped to DOCUMENT_VISUAL_GENERATION; O2 shows `img=1 imgedit=0 dv=0`) |
| `npx tsx test-phase6c-hf.ts` | **67 passed, 0 failed** |
| `npx tsx test-phase6d.ts` | **147 passed, 0 failed** |
| `npx tsx test-phase6d-hf.ts` | **103 passed, 0 failed** |
| `npx tsx test-phase6b.ts` | **311 passed, 0 failed** (G5–G7: 7 extension slots) |
| `npx tsx test-phase6a.ts` | **224 passed, 0 failed** |
| `npx tsx test-phase5h.ts` | 13 passed, 0 failed |
| `npx tsx test-phase5f.ts` | 54 passed, 0 failed |
| `npx tsx test-phase5g.ts` | Retrieval reliability: ALL cases passed |
| `npx tsx test-5e2-final.ts` | 69 passed, 0 failed |
| `npx tsx test-5e2-multimodal.ts` | 84 passed, 0 failed |
| `npx tsx test-structural-fix.ts` | 80 passed, 0 failed |
| `npx tsx test-visual-processing.ts` | 114 passed, 0 failed |
| `npx tsc --noEmit` | **clean** |
| `npm run lint` | 0 errors, 13 warnings (all pre-existing, none new) |
| `npm run build` | **Compiled successfully** |

Suite coverage (A–L): direct intent detection (doc+visual gate, reading/
understanding/definition/chit-chat rejection, adjective modifiers "my annual
report", "summarize … into an infographic"), refinement detection (presentation
signals, questions/understanding/chit-chat/fresh-asks never a refinement),
router priority vs IMAGE_EDIT/IMAGE_GENERATION/DOCUMENT_RAG/HYBRID/GENERAL +
no-sources refusal route, evidence normalization (dedup, bounded items/total,
legacy shape, page/relevance), numeric extraction (`$520`→`520`, `40%`, `2024`),
chart gate, spec+grounded prompt building (facts/relationships/sequence/entities/
numbers/source refs, per-type rules, prompt bounds), service grounding gate
(no-evidence, chart-no-numbers, refinement guard) with provider-once assertions,
fallback policy (eligible vs never-fallback codes, exact call counts), output
validation (bad/oversize bytes → fallback/message), server-only secrets + safe
logs (no `NEXT_PUBLIC_`, no `process.browser`, no keys/evidence/prompt echoed),
execution plan (RAG-before-image budget ≤ 4), describeQueryRoute transparency,
no-keys safety (safe copy without crash/leak), mocked end-to-end (router →
spec → prompt → image; refusal path).

## 3. Tier 2 — LIVE API (✅ real grounded image produced)

Real `GEMINI_API_KEY` and `HF_TOKEN` are present in `.env.local`. Driven
end-to-end through the exact service path (`generateDocumentVisual` = same
provider order as the chat route: gemini → huggingface). Deterministic evidence
fixture (annual-report passage with real numbers); no retrieval network needed
for the proof.

**Grounded chart — LIVE-VERIFIED (Gemini rate_limited → HF generation fallback):**

```
[probe] GEMINI_API_KEY present=true HF_TOKEN present=true
[probe] provider order: gemini,huggingface
[image-generation] provider=gemini failed code=rate_limited — trying next
[image-generation] document-visual route=DOCUMENT_VISUAL_GENERATION type=chart evidence=1 outcome=image
[probe] out1 kind=image elapsed=5448ms
[probe] provider: huggingface mime: image/png size: 664133
[probe] width: 1024 height: 1024 visualType: chart sourceGrounded: true
[probe] RESULT grounded-chart=live-ok elapsed=5448ms
```

A real 1024×1024 PNG (664 KB, HF FLUX.1-schnell generation, the 6C
production leg) came back with `visualType=chart` and `sourceGrounded=true`
stamped. The live account's Gemini key is free-tier `rate_limited` (consistent
with 6C/6D); the Gemini→HF fallback is the live production path and fired
exactly as designed.

**Refinement claim guard — refused honestly (server-side, no network):**

```
[probe] out2 kind=message elapsed=1ms (guarded=true)
[probe] RESULT refinement-guard=refused-honestly elapsed=1ms
[image-generation] document-visual refinement guard blocked: Refinement references values absent from the evidence: 999.
```

The refinement "mention that revenue hit $999 trillion" was refused with the
safe copy because `999` is absent from the evidence — proving the guard can
never smuggle an unsupported fact into a grounded image.

Note: `$999 trillion`'s "999" was caught by the numeric tokenizer and the
composed prompt was never sent to any provider (1 ms, no provider call).

## 4. Fallback & grounding design (recap)

- **One shared fallback loop** (`runWithPolicy`) now serves generate, edit, and
  document-visual: eligible fallback codes only (`timeout`, `rate_limited`,
  `provider_unavailable`, `provider_invalid_response`); terminal for
  `safety_blocked`/`provider_auth`/`misconfigured`/`invalid_request`; each
  provider max once per request. No duplicated policy code.
- **Grounding is the gate:** no evidence ⇒ `SAFE_NO_GROUNDING_MESSAGE`; chart
  with non-numeric evidence ⇒ chart-refusal; refinement references a number/
  year not in evidence ⇒ guard-blocked. All before any provider is touched.
- **The provider never sees raw RAG dumps — only the composed grounded prompt**
  whose factual core is the bounded evidence block + explicit derived numbers/
  facts/relationships/sequences + per-type anti-hallucination instructions.
- **`sourceGrounded`/`visualType` metadata** flows through `GeneratedImage` →
  `image_message` JSON → `ChatImageAttachment` → frontend "Based on your document"
  badge; the log line is `route=DOCUMENT_VISUAL_GENERATION type=… evidence=N outcome=…`
  and never echoes keys, evidence, or the composed prompt.

## 5. Tier 3 — BROWSER (🔲 PENDING)

No browser-automation tooling and no signed-in Supabase session are available
in this environment; the frontend wiring is covered by tsc, lint, and the build,
but not by an end-to-end smoke test.

Manual checklist for a reviewer with a browser + billing-enabled key:
1. Chat → upload/attach a PDF → "Draw a chart of the revenue numbers from my PDF"
   → a grounded chart image appears with "Based on your document · chart" above
   the provider caption.
2. "Make it simpler" → a refinement of THAT chart (retrieval evidence from the
   original ask), updated image, refinement caption.
3. Send "Draw an infographic from my PDF" with NO document attached → safe copy
   ("I need a document/source attached…”), never a memory-based image.
4. Send "Summarize my PDF into an infographic" (document attached) → grounded
   infographic; "summarize my PDF" alone → text document answer (no image).
5. "What does the chart in my PDF show?" → normal document answer, never a
   generated image; "edit the diagram from my PDF" → image-edit behavior, not 6E.
6. With `GEMINI_API_KEY` present but rate-limited → image still arrives via the
   HF generation fallback with the grounded badge.

## 6. Trade-offs and limitations (honest)

- **Intent detection is heuristic, not LLM.** It is deliberately conservative:
  ambiguous type ⇒ generic grounded visual; no doc ref ⇒ pure generation. Some
  edge phrasings may miss (e.g. visual asks that name neither an action verb nor
  a visual noun are not detected); the contract is "never misroute an understanding
  turn or fabricate", favored over recall.
- **"my annual report"/"summarize X into a visual"** were real gaps found by the
  6E suite and fixed (adjective slot in the doc-context regex; `summari[sz]e` as
  a visual action) — documented here because they were deterministic false
  negatives caught by tests, not by guessing.
- **Chart gate is structural:** the evidence's numeric tokens are the only thing
  that unlocks a chart; a document with no numbers is refused (`SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE`),
  never approximated.
- **Live Gemini generation remains quota-blocked** (`rate_limited`) on this
  account — the 6C production leg (HF FLUX.1-schnell) produced the live proof.
  A billing-enabled Gemini key would exercise the primary path unchanged.
- **Refinements re-retrieve using the original ask** so evidence matches the
  mother request; a refinement can only reference facts already in evidence.
- Browser tier is genuinely unverified; an automation entrant with a signed-in
  session will close it.
- Windows `node.exe` may print a libuv on-exit assertion line after live probes
  (known cosmetic race); probe exit codes are reliable.

## 7. Files changed / added (this phase)

- New: `src/lib/image-generation/document-visual-types.ts`,
  `document-visual-intent.ts`, `document-visual-evidence.ts`,
  `document-visual-prompt.ts`, `test-phase6e.ts`, `_probe-6e-live.ts`
- Changed: `src/lib/image-generation/service.ts` (shared `runWithPolicy` +
  6E entries), `types.ts` (`DocumentVisualGenerationRequest`, `GeneratedImage.
  sourceGrounded`/`visualType`, three `SAFE_DOC_VISUAL_*` messages), `index.ts`
  (barrel), `src/lib/agent/query-router.ts` (branch 4b + intent + `dv=` marker),
  `src/lib/agent/index.ts` (`DocumentVisualIntent` type), `src/app/api/chat/
  route.ts` (6E turn, retrievalMessage, evidence capture, image JSON fields),
  `src/types/index.ts` + `src/components/chat/assistant-message.tsx` (grounded
  badge), `test-phase6b.ts` (G5–G7), `test-phase6c.ts` (C4b/C5/C6 flips)

## 8. Gate commands

```
npx tsx test-phase6e.ts
npx tsx test-phase6c.ts
npx tsx test-phase6c-hf.ts
npx tsx test-phase6d.ts
npx tsx test-phase6d-hf.ts
npx tsx test-phase6b.ts
npx tsx test-phase6a.ts
npx tsc --noEmit
npm run lint
npm run build
# live probe (requires real keys in .env.local; HF generation consumes quota):
npx tsx _probe-6e-live.ts
```