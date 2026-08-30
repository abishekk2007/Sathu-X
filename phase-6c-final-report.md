# Phase 6C — Text → Image Generation: Final Report

**Status:** AUTOMATED ✅ · LIVE API ✅ (HF fallback now produces images; Gemini primary quota-blocked) · BROWSER 🔲 (PENDING)
**Date:** 2026-08-28

## 1. What shipped

New `IMAGE_GENERATION` route in the existing Phase 6B router. A server-only
image service composes a text prompt, runs ONE image-capable provider per
request (Gemini primary, Hugging Face Inference Providers router fallback),
validates the bytes, and streams a `data:` URL back to the chat UI as a JSON
image message.

- `src/lib/image-generation/` — `types.ts`, `intent.ts`, `prompt.ts`,
  `gemini-provider.ts`, `huggingface-provider.ts`, `service.ts`, `index.ts`
- Router: `src/lib/agent/query-router.ts` branch 4 (`IMAGE_GENERATION`,
  `imageIntent`, `requiresDocuments`), plan step `image`, `EXTENSION_POINTS.IMAGE_GENERATION`
- Chat flow: `src/app/api/chat/route.ts` — immediate dispatch for pure image
  turns; grounded dispatch for document-based image turns (evidence only)
- Frontend: `src/types/index.ts` (`ChatImageAttachment` + `ChatMessage.image`),
  `chat-workspace.tsx` (JSON `image_message` branch), `assistant-message.tsx`
  (renders the validated data URL), `thinking-indicator.tsx` (label prop)
- Tests: `test-phase6c.ts` (164 assertions, provider-mock based, no network/keys),
  `test-phase6c-hf.ts` (67 assertions, mocked-fetch HF transport suite)

## 2. Tier 1 — AUTOMATED (all green, run 2026-08-28)

| Gate | Result |
|---|---|
| `npx tsx test-phase6c.ts` | **164 passed, 0 failed** |
| `npx tsx test-phase6c-hf.ts` | **67 passed, 0 failed** (HF transport: router URL, taxonomy, token hygiene, one-attempt semantics) |
| `npx tsx test-phase6b.ts` | **309 passed, 0 failed** |
| `npx tsx test-phase6a.ts` | **224 passed, 0 failed** |
| `npx tsx test-phase5h.ts` / `5f` / `5g` | 13 / 54 / passed |
| `npx tsx test-5e2-final.ts` / `-multimodal` | 69 / 84 passed |
| `npx tsx test-structural-fix.ts` / `test-visual-processing.ts` | 80 / 114 passed |
| `npx tsc --noEmit` | **clean** |
| `npm run lint` | 0 errors, 12 warnings (all pre-existing, none from 6C) |
| `npm run build` | **Compiled successfully** |

Suite coverage highlights: intent matrix + negatives, router priority
(including the C4 hybrid vs C4b image-verb-lead split), refinements,
fallback matrix (incl. the never-fallback codes `safety_blocked`/
`provider_auth`), output validation, config parse, 60s timeout policy,
RAG-grounding gate, prompt caps (≤900 chars, ≤600 evidence chars),
no-keys safety, caption semantics, payload shape, execution plans,
extension points.

## 3. Tier 2 — LIVE API (✅ HF fallback produces real images; Gemini primary quota-blocked)

Real `GEMINI_API_KEY` and `HF_TOKEN` (37 chars) are present in `.env.local`.
Driven end-to-end through the exact chat flow (`generateImage` →
`resolveProviderOrder()` → `[gemini, huggingface]`), the fallback chain
**produced a validated PNG through the live Hugging Face Inference Providers
router on 2026-08-28**:

```
Generate an image of the water cycle  (mode: general)
→ provider=gemini  failed code=rate_limited — trying next
→ provider=huggingface  ok
→ kind=image  elapsed=5482ms  message="Here's the image you asked for."
   provider=huggingface  mimeType=image/png  width=1024  height=1024
   fileSizeBytes=960925  dataUrl=data:image/png;base64,iVBORw0KGgoAAAANSU…
```

### Why the original HF integration failed (root cause)

The original transport targeted the **legacy REST host**
`https://api-inference.huggingface.co/models/{model}`. That host is
**decommissioned / does not resolve on this network** (`getaddrinfo ENOTFOUND`,
DNS returns SOA-only records), so every HF fallback attempt died in
`provider_unavailable` before authentication.

### The fix — current HF transport

`src/lib/image-generation/huggingface-provider.ts` now mirrors the official
`@huggingface/inference` SDK architecture and calls the current **Inference
Providers router** with token-only auth (provider keys stay server-side):

- `POST https://router.huggingface.co/nscale/v1/images/generations` (docker
  format: `{prompt, width, height, negative_prompt, response_format:"b64_json",
  model}`) — default, verified live.
  - default provider **`nscale`** = what HF "auto" routing resolves for
    `black-forest-labs/FLUX.1-schnell` (`inferenceProviderMapping[0]`; docs
    `providersMapping` agrees)
  - HTTP contract: 200 → `application/json` `{data:[{b64_json}]}` → decoded →
    magic-sniffed as `image/png` by `validateImage`
- Alt opt-in `HF_INFERENCE_PROVIDER=hf-inference` → `POST
  https://router.huggingface.co/hf-inference/models/{model}` with the tasks
  `{inputs, parameters}` contract (raw `image/*` bytes) for models actually
  served there (e.g. `stabilityai/stable-diffusion-3-medium-diffusers`).
- Status taxonomy: 401/403/**402**→`provider_auth` (never-fallback), 408→`timeout`,
  429→`rate_limited`, 500/502/503/504→`provider_unavailable`, other 4xx→`provider_invalid_response`;
  missing token→`provider_auth`, unsupported provider→`misconfigured`.
- Abort safety: external signal **or** an internal 55s `AbortController` ceiling
  (service budget stays 60s — fetch is guaranteed to abort, no double wait).
- Logging: only provider/model/status/code/elapsed; the token is never logged
  (asserted in the suite).

> Note: HF Inference Providers bill in **monthly free credits** — they are not
> "free unlimited". The live call above consumed account credit. When credits
> run out the router returns 402 → mapped `provider_auth` (never-fallback) →
> safe decline message; that is a **billing/provider limitation**, reported
> honestly, never faked.

### Gemini primary (live, current key)

All six image models (`gemini-3.1-flash-image(-preview)`, `-flash-lite-image`,
`gemini-3-pro-image(-preview)`, `gemini-2.5-flash-image`) decline on this key:
previous run = HTTP 429 with free-tier `...limit: 0`; today = instant soft
"Image generation is temporarily unavailable. Please try again." (verified with
`IMAGE_PROVIDERS=gemini` so HF cannot mask the result). No Gemini image pixels
are obtainable without a billing-enabled key. The taxonomy path is correct:
a real eligible failure (`rate_limited`) triggered exactly the fallback tested
above.

> **Note:** the SDK's `models.generateImages()` path is deprecated and throws a
> client-side deprecation error in `@google/genai` 2.18.0; the provider uses
> the supported `generateContent` + image modality API instead. The installed
> `ImageConfig` type exposes no `negativePrompt`, so Gemini sends aspect ratio
> only; HF receives it as docker `negative_prompt`.

## 4. Tier 3 — BROWSER (🔲 PENDING)

No browser-automation tooling is available in this environment, and there is
no signed-in Supabase session to drive the chat UI. The frontend wiring is
covered by tsc, lint, and the build, but **not** by an end-to-end smoke test.

Manual checklist for a reviewer with a browser + billing-enabled key:
1. Chat → "draw a castle" → expect a "generating an image" status then an
   inline `<figure>` image + caption (pure turn, no memory fetch).
2. Attach a PDF/notes → "Draw a flowchart based on my notes" → image grounded
   in retrieved evidence (no grounding evidence ⇒ safe refusal message).
3. After an image, send "make it night" → refinement prompt + "Here's your
   updated image." caption.
4. Kill `GEMINI_API_KEY` server-side → rerun → safe unavailable message, no
   crash, chat history intact.
5. Switch `GEMINI_IMAGE_MODEL` env → different registered model.

## 5. Trade-offs and limitations (honest)

- **C4 vs C4b:** "According to my PDF, what is the weather in Chennai?" →
  HYBRID (realtime question). "Draw a chart of the weather in Delhi from my
  PDF" → IMAGE_GENERATION with `requiresDocuments: true` (image-verb lead;
  no confirmable realtime) — the grounding gate applies. Both documented in
  the 6C suite.
- Gemini's flagship image model is being declined on the available key (free
  tier, no billing); a paid tier is required for the Gemini pixel assertion.
- Logic is now fully live-verified on the HF side (router 200, PNG validated,
  E2E fallback chain produced an image); only the Gemini-side pixel assertion
  and the browser tier remain marketable/credential-blocked.
- HF image generation consumes **Inference Providers credits**, not "free
  unlimited": 402 (credits exhausted) → `provider_auth` → safe decline; refill
  credits or add billing to restore.
- Windows `node.exe` prints a libuv `Assertion failed …` line after the live
  probes exit (known on-exit race); cosmetic, probe exit codes are reliable.
- Browser tier is genuinely unverified; automation entrants will close it.
- `_probe-image-models.ts`, `_probe-phase6c-live.ts` (Gemini-only, pinned
  `IMAGE_PROVIDERS=gemini`), `_probe-hf-live.ts` (full Gemini→HF chain) are
  the documented live harnesses (kept intentionally; `GET /`–free, never imported).

## 6. Files changed / added (this phase)

- New: `src/lib/image-generation/*` (7 files), `test-phase6c.ts`,
  `test-phase6c-hf.ts`, `_probe-phase6c-live.ts`, `_probe-hf-live.ts`
- Changed: `src/lib/agent/query-router.ts`, `src/lib/agent/index.ts`,
  `src/app/api/chat/route.ts`, `src/types/index.ts`,
  `src/components/chat/chat-workspace.tsx`, `assistant-message.tsx`,
  `thinking-indicator.tsx`, `test-phase6b.ts`, `.env.example`,
  `src/lib/image-generation/huggingface-provider.ts` (legacy REST → Inference
  Providers router), `src/lib/image-generation/index.ts` (config exports)

## 7. Gate commands

```
npx tsx test-phase6c.ts
npx tsx test-phase6c-hf.ts
npx tsx test-phase6b.ts
npx tsc --noEmit
npm run lint
npm run build
# live Gemini-probe (Gemini quota only):
npx tsx _probe-phase6c-live.ts
# live full fallback chain (Gemini → HF, expect provider=huggingface PNG):
npx tsx _probe-hf-live.ts
```