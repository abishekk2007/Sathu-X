# Phase 6D — Existing Image → Edited/Regenerated Image: Final Report

**Status:** AUTOMATED ✅ · LIVE API ⚠️ (HF edit leg LIVE-VERIFIED; Gemini edit quota-blocked; full Gemini→HF loop fired live, then the account's fal-ai billing cap refused further edits — COMPLETE WITH LIVE VALIDATION REQUIRED) · BROWSER 🔲 (PENDING)
**Date:** 2026-08-29

## 1. What shipped

A real `IMAGE_EDIT` capability extended **onto** the Phase 6C text→image
architecture (no second image stack): after a generated/uploaded image exists,
"make the sky sunset" becomes SOURCE IMAGE + EDIT INSTRUCTION → EDITED IMAGE
through the same provider abstraction, validation, and bounded fallback policy.
Provider capability is never faked: Gemini implements `edit()` on the
live-tested `generateContent` code path; Hugging Face **now implements a real
`edit()`** through the Inference Providers router's image-to-image models
(fal-ai / replicate / wavespeed) — an edit ALWAYS embeds the validated source
bytes, so a text-only re-render that would silently discard the image is
impossible. The text-to-image-only nscale provider is never an edit provider.

- `src/lib/image-generation/edit-intent.ts` (NEW) — deterministic
  `detectImageEditIntent(message, images)`:
  - edit verbs / deictic refs / structural frames ("make the sky sunset",
    "turn the car red") / style hints / regeneration phrasing
  - never fires on visual understanding ("what does this image show?",
    "explain this diagram"), definitions, chitchat, or fresh generation
    ("draw a castle", "generate an image of a cat")
  - selection: previous image, uploaded image (`"upload"`), ordinals
    ("edit the second image"), subject-vs-prompt match; ambiguous multi-image
    or out-of-range ordinal ⇒ clarification, **never an arbitrary pick**
  - WITH an image: "make it more colorful" ⇒ edit of that image
  - WITHOUT an image: explicit edit phrasing ⇒ `SAFE_EDIT_*` no-image copy,
    **no provider call**; ordinary chat unaffected ("make me a pizza")
- `src/lib/image-generation/prompt.ts` — `buildImageEditPrompt`: user words
  are the edit (never rewritten), student hint, evidence block, caps shared
  with generation (≤900 chars / ≤600 evidence chars)
- `src/lib/image-generation/gemini-provider.ts` — `edit()` via the SDK's
  documented, non-deprecated `models.generateContent` +
  `responseModalities:["IMAGE"]` with the reference image as an `inlineData`
  part (same client, model resolver, and safety→`safety_blocked` mapping as
  6C generation). The deprecated `models.editImage`/`ReferenceImage` API is
  **not** used, so no `GEMINI_IMAGE_EDIT_MODEL` var is invented.
- `src/lib/image-generation/huggingface-provider.ts` — **real `edit()`
  (Phase 6D-HF)** on the Inference Providers router (REST, no SDK):
  - config: `HF_IMAGE_EDIT_MODEL` (default `Qwen/Qwen-Image-Edit`, alt
    `black-forest-labs/FLUX.1-Kontext-dev`), `HF_IMAGE_EDIT_PROVIDER`
    (default `fal-ai`; also `replicate`, `wavespeed`), bounded poll
    `HF_IMAGE_EDIT_POLL_MS`/`HF_IMAGE_EDIT_MAX_POLLS`; independent of
    generation (`HF_IMAGE_MODEL`/`HF_INFERENCE_PROVIDER=nscale` — nscale is
    text-to-image only and is REJECTED as an edit provider → `misconfigured`)
  - transport mirrors the actual `huggingface_hub` provider helpers one-for-one:
    fal-ai = queue-submit `?subdomain=queue` (data-URL `image_url`) → status poll
    → result; replicate = `v1/models/{id}/predictions` + `Prefer: wait`; wavespeed
    = `api/v3/{id}` → poll → completed output; `editImageBytes` re-validates via
    magic bytes; `402→provider_auth`, `408→timeout`, `429→rate_limited`,
    `5xx→provider_unavailable`, other 4xx/malformed→`provider_invalid_response`
  - `HAS_HF_IMAGE_EDIT = true`; the edit request ALWAYS carries the source
    image bytes (data URL); tokens/bodies never logged
- `src/lib/image-generation/service.ts` — `editImageWithProviders` /
  `editImage`: RAG grounding gate first, provider filter
  (`typeof provider.edit === "function"`), 60s budget, magic-byte output
  revalidation, `mode`/`editSourceKey` stamping, eligible-fallback taxonomy
  only (`timeout/rate_limited/provider_unavailable/provider_invalid_response`),
  terminal `SAFE_EDIT_UNAVAILABLE_MESSAGE` on anything else — Hugging Face is
  now IN the eligible set for edits, each provider max once per request
- Router: `src/lib/agent/query-router.ts` — `IMAGE_EDIT` branch **before**
  `IMAGE_GENERATION` (after all 6A/6B/6C hybrid/understanding guards),
  `imageEditIntent` on the decision, clarification/document-stand-off
  semantics, `EXTENSION_POINTS.IMAGE_EDITING`, `imgedit=` in `describeQueryRoute`
- Chat route: `src/app/api/chat/route.ts` — schema (`images` metadata,
  `editImage` with `sourceKey`+`dataUrl`, `uploadedImage`), `decodeDataUrl` +
  `validateSourceImage` (magic-byte MIME re-sniff, 10 MB cap, client MIME never
  trusted), `handleImageEditTurn` (re-derives intent, demands the selected key's
  bytes, no-image/ambiguous ⇒ `SAFE_EDIT_*` copy, invalid source ⇒
  `SAFE_EDIT_INVALID_SOURCE`), backward-compatible `image` payload with
  optional `mode`/`editSourceKey`
- Frontend: `chat-workspace.tsx` — `collectImageContext` (metadata only, no
  base64), single `editImage` byte payload chosen per turn (bytes travel once,
  never duplicated across history), tri-state thinking label
- Tests: `test-phase6d.ts` (147 assertions, A–Y sections, mock providers) +
  **`test-phase6d-hf.ts`** (NEW, 103 assertions, A–R, mocked fetch incl. exact
  Gemini→HF call counts and §9 mapping)
- `.env.example`: `HF_IMAGE_EDIT_MODEL` / `HF_IMAGE_EDIT_PROVIDER` /
  `HF_IMAGE_EDIT_POLL_MS` / `HF_IMAGE_EDIT_MAX_POLLS` documented server-only

## 2. Tier 1 — AUTOMATED (all green, run 2026-08-29)

| Gate | Result |
|---|---|
| `npx tsx test-phase6d.ts` | **147 passed, 0 failed** (M1/M2 legitimately flipped: `HAS_HF_IMAGE_EDIT` now `true`, real HF `edit()` present; no test weakened/deleted) |
| `npx tsx test-phase6d-hf.ts` | **103 passed, 0 failed** (NEW — HF edit contract + fallback, mocked fetch) |
| `npx tsx test-phase6c.ts` | **164 passed, 0 failed** |
| `npx tsx test-phase6c-hf.ts` | **67 passed, 0 failed** |
| `npx tsx test-phase6b.ts` | **310 passed, 0 failed** (G7 updated for image-edit extension) |
| `npx tsx test-phase6a.ts` | **224 passed, 0 failed** |
| `npx tsx test-phase5h.ts` / `5f` / `5g` | 13 / 54 / passed |
| `npx tsc --noEmit` | **clean** |
| `npm run lint` | 0 errors, 12 warnings (all pre-existing, none new) |
| `npm run build` | **Compiled successfully** |

Suite coverage (A–Y): edit-intent matrix (verbs/deictics/surface frames),
GEN-vs-EDIT-vs-VISUAL three-way, no-image clarification (never a provider call),
previous-image selection, uploaded `"upload"` selection, multi-image ambiguity
+ ordinals (incl. out-of-range ⇒ clarify), context-aware toggle, Gemini success,
timeout/rate-limit/provider-unavailable fallback, safety-block no-fallback,
source validation via `validateImage` magic bytes, malformed-output fallback,
normalization stamping, caption semantics, regeneration kind, student mode,
RAG-grounded edit, no-grounding refusal, key security (no keys/secrets/base64
echo, metadata key never sent to providers), one-attempt policy, router
regression, describe/routing transparency.

`test-phase6d-hf.ts` (A–R) additionally proves the HF rename-independent
contract with a mocked fetch: defaults/unstructured, auth + misconfigured
(nscale→not-an-edit-provider), fal-ai success with the **source data URL embedded
in the request body** and prompt/negative_prompt forwarding, the §9 status map
(401/403/402/408/429/500/502/503/504 plus other-4xx→`provider_invalid_response`),
malformed JSON, missing `response_url`, bounded never-completes timeout with
**exact submit+status call counts**, empty result/download, replicate
`Prefer: wait` + null-output→timeout, wavespeed poll + failed, service-level
fallback with exact counts (`rate_limited`→HF exactly once; `safety_blocked`/
`provider_auth`→HF never called), `_subdomain_` timestamp correctness, token
never logged while the Bearer header is present, router-only hosts, and
replicate/FLUX aspect-ratio mapping (1:1→1024, 16:9→1344×768 fal-ai
`image_size` / replicate `target_size`).

## 3. Tier 2 — LIVE API (⚠️ HF edit leg LIVE-VERIFIED; Gemini edit quota-blocked)

Real `GEMINI_API_KEY` and `HF_TOKEN` are present in `.env.local`. Driven
end-to-end through the exact chat flow (`generateImage` + `editImage`).

**Gemini primary (pinned, isolated) — quota-blocked, as before:**

```
[probe] gemini edit kind=message elapsed=799ms
[image-generation] edit provider=gemini failed code=rate_limited — trying next
[probe] RESULT gemini-edit=blocked-or-unavailable ⚠️ free-tier rate_limited
```

**Hugging Face real edit (pinned, real source bytes) — LIVE-VERIFIED:**

```
[probe] HF config: baseUrl=https://router.huggingface.co editProvider=fal-ai editModel=Qwen/Qwen-Image-Edit
[probe] ---- (2) HF real edit: "Make the sky sunset." ----
[probe] edited provider: huggingface mime: image/png size: 930530
[probe] dims: 1024 x 1024 mode: edit editSourceKey: hf-probe-source
[probe] bytes differ from source: true
[probe] RESULT hf-edit-live=live-ok elapsed=16406ms
[probe] ---- (3) chained edit from HF output: "now add a red bird on the ridge" ----
[probe] RESULT hf-edit-chain=live-ok elapsed=17393ms
```

**Gemini→HF fallback loop (default order) — fired live; billing cap then honest:**

```
[probe] default provider order: gemini,huggingface
[image-generation] edit provider=gemini failed code=rate_limited — trying next
[image-generation] HF edit provider=fal-ai model=Qwen/Qwen-Image-Edit status=402 code=provider_auth elapsed=2008ms
[probe] RESULT fallback-edit=both-providers-unavailable  ⚠️ 402 = account billing cap after success
```

- **Source generation** remains live-verified through the full order
  (Gemini `rate_limited` → HF PNG fallback).
- **HF edit leg is COMPLETE**: real `Qwen/Qwen-Image-Edit` via fal-ai on the
  router returned a real 1024×1024 PNG, `provider=huggingface`, bytes differ,
  passes server validation, and a chained edit from the HF output also
  succeeded. `.env.example` documents the new edit vars.
- **Gemini EDIT** cannot be pixel-verified on the available key (free-tier
  `rate_limited`); the transport is byte-identical to the live-verified 6C
  generate path, so only the pixel byte-diff proof is missing.
- **Full Gemini→HF edit fallback** is structurally verified live (Gemini
  `rate_limited` ⇒ HF edit attempted). After the initial successes, the
  account's paid-credit allowance was exhausted and the router returned
  deterministic `402` — mapped **correctly** to `provider_auth` per §9
  (never retried further, safe copy returned, nothing leaked). The same token
  had succeeded minutes earlier, so this is **real quota/billing**, reported
  honestly — no fake success is claimed. Live loop re-verify is pending
  credits.

## 4. Hugging Face Image Edit Fallback (Phase 6D-HF)

### Model & provider defaults
- Model `Qwen/Qwen-Image-Edit` (alternative `black-forest-labs/FLUX.1-Kontext-dev`),
  router provider `fal-ai` (also `replicate`, `wavespeed`) — chosen because the
  router's actual `image-to-image` mapping serves this model on exactly those
  three providers; `nscale` serves only FLUX.1-schnell text-to-image and is
  **never** an edit provider.
- Generation keeps its independent `HF_IMAGE_MODEL`/`HF_INFERENCE_PROVIDER`
  (`nscale`) configuration and transport.

### Endpoint architecture (mirrors `huggingface_hub` REST, no SDK)
- Base `https://router.huggingface.co`, `Authorization: Bearer {HF_TOKEN}`.
- fal-ai: `POST {router}/fal-ai/fal-ai/qwen-image-edit?_subdomain=queue` with
  `{ image_url: <source data URL>, image_urls:[…], prompt, negative_prompt?,
  image_size? }` → `response_url` pathname → poll
  `{router}{path}/status?_subdomain=queue` until `COMPLETED` → GET result
  `{images:[{url}]}` → download/revalidate bytes.
- replicate: `POST {router}/replicate/v1/models/qwen/qwen-image-edit/predictions`
  `{input:{image, images, input_image, input_images, prompt, negative_prompt?,
  target_size?}}` + `Prefer: wait`; null/empty `output` ⇒ `timeout` (mirrors the
  HF client's TimeoutError).
- wavespeed: `POST {router}/wavespeed/api/v3/wavespeed-ai/qwen-image/edit`
  `{image, prompt, negative_prompt?, target_size?}` → poll
  `{router}{data.urls.get path}`; `completed` ⇒ `data.outputs[0]`, `failed` ⇒
  `provider_invalid_response`.
- Polls are bounded (`HF_IMAGE_EDIT_MAX_POLLS`, default 90 · 500 ms ≈ 45 s,
  inside the 60 s service budget); output bytes are re-detected by magic bytes.

### Request integrity — no fake edits
The HF edit request ALWAYS embeds the validated source image bytes as a data
URL (`image`/`image_url`/`images`). There is no text-only re-render path; a
"fake edit" that silently discards the source is structurally impossible.

### Fallback taxonomy (spec §9, enforced)
- HF reached only for `timeout`/`rate_limited`/`provider_unavailable`/
  `provider_invalid_response`; **never** for `safety_blocked`/`provider_auth`/
  `misconfigured`/`invalid_request`; each provider max ONCE per request; bounded
  polls, no infinite retries; 401/403/402→`provider_auth`, 408→`timeout`,
  429→`rate_limited`, 500/502/503/504→`provider_unavailable`, other 4xx/malformed
  /empty bytes→`provider_invalid_response`. Tokens/headers/raw bodies never logged.

### Security
Same discipline as generation: Bearer header present, token and base64 payloads
never logged, server-side magic-byte validation of source AND output, 60 s
budget, client MIME never trusted.

### Tests
`test-phase6d-hf.ts` (103 assertions, mocked fetch): full contract above plus
exact Gemini→HF call counts and the never-called assertions.

### Live results (2026-08-29)
Real edits succeeded (see §3); after the account's credit allowance was spent
the router returned `402`, handled honestly as `provider_auth`.

### Billing limitation
fal-ai image-to-image consumes the HF-Token Router's paid credits. A
zero-balance account returns `402 Payment Required` — the client sees the safe
unavailable copy, never a billing key, and never a fake image.

### Browser status
🔲 PENDING — no browser automation in this environment; the frontend is covered
by tsc/lint/build and its wiring is exercised by `test-phase6d-hf.ts` at the
service level.

## 5. Tier 3 — BROWSER (🔲 PENDING)

No browser-automation tooling and no signed-in Supabase session are available
in this environment; the frontend wiring is covered by tsc, lint, and the
build, but not by an end-to-end smoke test.

Manual checklist for a reviewer with a browser + billing-enabled key:
1. Chat → "draw a castle" → image appears in a `<figure>`. Then send
   "make the sky sunset" → "Spidey Bot is editing the image" label, then an
   edited image with "Here's your edited image." caption.
2. "regenerate it" → "Here's the regenerated image." caption, new bytes.
3. Send "edit it" with NO prior image → guidance copy
   ("I don't have an image to edit yet…"), never an image or a crash.
4. Generate two images, then "edit the second image" → only image #2 changes.
5. Upload an image, "make it more colorful" → edits the uploaded one.
6. Kill `GEMINI_API_KEY` server-side → edit rerun → Gemini drops out, HF
   picks it up (billing-enabled key) → edited image from the SAME source
   bytes. With `HF_IMAGE_EDIT_PROVIDER=nscale` → safe unavailable copy, never
   a fake text→image "edit".

## 6. Trade-offs and limitations (honest)

- **Gemini edge deferral is deliberate:** the SDK's `models.editImage`
  (Imagen-style `ReferenceImage`) is deprecated (removal flagged next major
  release) and its deprecation warning points at `generateContent`; 6D reuses
  the ONE verified, live-tested image path for both generation and editing.
- **HF edits use a different router service than generation.** Only
  image-to-image-capable providers (fal-ai/replicate/wavespeed) are edit
  providers; nscale (generation) must never be an edit provider. `Qwen/Qwen-Image-Edit`
  is the default because the router's live mapping serves it on all three
  edit providers. Paid credits are required — see §4 Billing limitation; the
  `402` refusal is honored as a terminal, honest result, never a fake image.
- **Selection bytes travel once per edit request** from the client's own copy
  of the most-recent assistant image message; history carries metadata only.
  Server demand-checks `sourceKey === selectionKey`.
- **Live Gemini edit pixel-assertion is credential/cost-blocked**, not
  code-blocked; the byte-diff assertion in `_probe-6d-live.ts` will green with
  a billing key. The HF edit leg is byte-asserted live (see §3).
- The Gemini→HF fallback loop was live-verified structurally; a full
  end-to-end success inside one request session is pending account credits.
- Browser tier is genuinely unverified; an automation entrant with a signed-in
  session will close it.
- Windows `node.exe` may print a libuv on-exit assertion line after live probes
  (known cosmetic race); probe exit codes are reliable.

## 7. Files changed / added (this phase)

- New: `src/lib/image-generation/edit-intent.ts`, `test-phase6d.ts`,
  `test-phase6d-hf.ts`, `_probe-6d-live.ts`, `_probe-6d-hf-live.ts`
- Changed: `src/lib/image-generation/types.ts` (edit types/messages),
  `service.ts` (edit pipeline + HF in eligible set),
  `prompt.ts` (`buildImageEditPrompt`),
  `gemini-provider.ts` (`edit()`),
  `huggingface-provider.ts` (**real `edit()`, `HAS_HF_IMAGE_EDIT=true`, extended
  resolver + edit constants/helpers/maps**),
  `index.ts` (barrel), `src/lib/agent/query-router.ts` (`IMAGE_EDIT` branch),
  `src/app/api/chat/route.ts` (schema + edit turn),
  `src/types/index.ts` (`ChatImageAttachment.mode`/`editSourceKey`,
  `ChatImageContextItem`), `src/components/chat/chat-workspace.tsx`
  (context + label), `test-phase6b.ts` (G7 extension-point expectation),
  `.env.example` (edit model/provider/poll vars)

## 8. Gate commands

```
npx tsx test-phase6d.ts
npx tsx test-phase6d-hf.ts
npx tsx test-phase6c.ts
npx tsx test-phase6c-hf.ts
npx tsx test-phase6b.ts
npx tsc --noEmit
npm run lint
npm run build
# live probes (require real keys in .env.local; HF edit consumes paid credits):
npx tsx _probe-6d-hf-live.ts     # pinned HF real edit + chained edit
npx tsx _probe-6d-live.ts        # Gemini edit → Gemini→HF fallback loop → honest config
```