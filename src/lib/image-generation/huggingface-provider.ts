// ---------------------------------------------------------------------------
// Phase 6C — Hugging Face image provider (FALLBACK)
//
// Used ONLY when the Gemini provider reports a genuine provider failure
// (timeout / rate limit / unavailable / invalid response). Never used as a
// fallback for safety blocks — those are the user's content, not a provider's
// fault.
//
// CURRENT TRANSPORT — Hugging Face Inference Providers router (no SDK):
//   POST https://router.huggingface.co/{provider}/... with the HF token.
// The legacy api-inference.huggingface.co host is decommissioned and no longer
// resolves in DNS; "black-forest-labs/FLUX.1-schnell" is served by the router
// via provider "nscale" (the provider HF's "auto" routing selects for this
// model), so the default request uses the docker-style contract:
//
//   POST https://router.huggingface.co/nscale/v1/images/generations
//   { prompt, width, height, negative_prompt?, response_format:"b64_json",
//     model: "black-forest-labs/FLUX.1-schnell" }
//   200 → { data: [{ b64_json }] }   (image bytes, MIME re-detected by magic)
//
// Setting HF_INFERENCE_PROVIDER=hf-inference switches to the tasks contract:
//   POST https://router.huggingface.co/hf-inference/models/{model}
//   { inputs, parameters:{ width, height } }   → raw image bytes
// (only valid for models actually served by hf-inference, e.g.
//  stabilityai/stable-diffusion-3-medium-diffusers).
//
// PHASE 6D — IMAGE EDITING (implemented — HF image-to-image fallback).
// Editing is a DIFFERENT Hugging Face service from generation: the providers
// above are TEXT-TO-IMAGE only, but the Inference Providers router also serves
// reference-image models for task "image-to-image". Verified live via the Hub
// model API (?expand=inferenceProviderMapping) that exactly these providers
// serve the configured edit models (nscale — the generation provider — is
// text-to-image only and is NOT in this list):
//
//   Qwen/Qwen-Image-Edit (default, HF_IMAGE_EDIT_MODEL)
//     fal-ai    → providerId "fal-ai/qwen-image-edit"
//     replicate → providerId "qwen/qwen-image-edit"
//     wavespeed → providerId "wavespeed-ai/qwen-image/edit"
//   black-forest-labs/FLUX.1-Kontext-dev (alt, same env var)
//     fal-ai    → providerId "fal-ai/flux-kontext/dev"
//     replicate → providerId "black-forest-labs/flux-kontext-dev"
//     wavespeed → providerId "wavespeed-ai/flux-kontext-dev"
//
// An edit request ALWAYS carries the validated SOURCE image bytes (as a data
// URL inside the provider body) plus the edit instruction — the provider only
// ever receives a real image, never a text-only re-render. Transports mirror
// the huggingface_hub provider helpers exactly:
//   fal-ai    POST {base}/fal-ai/{providerModelId}?_subdomain=queue
//             { image_url, image_urls, prompt, ... } → poll /status →
//             GET result { images:[{url}] } → download bytes
//   replicate POST {base}/replicate/v1/models/{providerModelId}/predictions
//             { input:{ image, images, input_image, input_images, prompt } }
//             (Prefer: wait) → { output: url | [url] } → download bytes
//   wavespeed POST {base}/wavespeed/api/v3/{providerModelId}
//             { image, prompt } → poll data.urls.get → outputs[0] → download
//
// The default edit provider is fal-ai (override: HF_IMAGE_EDIT_PROVIDER);
// generation remains on its own HF_INFERENCE_PROVIDER (default nscale) — the
// two never share a provider, since nscale feeds no edit model. Output is
// validated from magic bytes by the service like generation; HF_TOKEN is
// server-side only and never logged.
//
// Server-side HF_TOKEN only. The token is never logged, and the router keeps
// provider credentials server-side — we never hold a third-party provider key.
// ---------------------------------------------------------------------------

import type {
  ImageAspectRatio,
  ImageFailureCode,
  ImageProvider,
  ProviderEditParams,
  ProviderGenerationParams,
  ProviderImageOutput,
} from "./types";
import { ImageFailure } from "./types";

/** Default fallback image model. Override with HF_IMAGE_MODEL. */
export const DEFAULT_HF_IMAGE_MODEL = "black-forest-labs/FLUX.1-schnell";

/** Current Hugging Face Inference Providers router. Override with HF_INFERENCE_BASE_URL. */
export const DEFAULT_HF_BASE_URL = "https://router.huggingface.co";

/**
 * Default router provider. Override with HF_INFERENCE_PROVIDER.
 * "nscale" is the provider Hugging Face "auto" routing selects for
 * black-forest-labs/FLUX.1-schnell (verified live: 200 + PNG bytes).
 * "hf-inference" uses the same router but the {inputs} tasks contract.
 */
export const DEFAULT_HF_PROVIDER = "nscale";

/**
 * Phase 6D — whether this provider genuinely supports reference-image editing.
 * TRUE: the router serves Qwen/Qwen-Image-Edit (and FLUX.1-Kontext-dev) for
 * image-to-image via fal-ai/replicate/wavespeed (verified live; see header).
 */
export const HAS_HF_IMAGE_EDIT = true as const;

/** Default HF image-edit model. Override with HF_IMAGE_EDIT_MODEL. */
export const DEFAULT_HF_EDIT_MODEL = "Qwen/Qwen-Image-Edit";

/**
 * Optional alternative edit model (FLUX Kontext). Most code never reads this —
 * it documents the second supported value for HF_IMAGE_EDIT_MODEL.
 */
export const DEFAULT_HF_EDIT_MODEL_ALT = "black-forest-labs/FLUX.1-Kontext-dev";

/**
 * Default router provider for image editing. Override with HF_IMAGE_EDIT_PROVIDER.
 * Generation stays on its own provider (nscale) — an edit provider must serve
 * an image-to-image model, which nscale does not.
 */
export const DEFAULT_HF_EDIT_PROVIDER = "fal-ai";

/**
 * Internal per-request ceiling for the HF network call. The service still
 * enforces the overall 60 s budget (PROVIDER_TIMEOUT_MS); this guarantees the
 * underlying fetch is aborted (not just timed-out at the promise level) even
 * when the route passes no AbortSignal.
 */
const HF_REQUEST_TIMEOUT_MS = 55_000;

/** Aspect ratios → pixel dimensions the router pipelines accept. */
const ASPECT_DIMS: Record<ImageAspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "3:4": { width: 864, height: 1152 },
  "4:3": { width: 1152, height: 864 },
  "9:16": { width: 768, height: 1344 },
  "16:9": { width: 1344, height: 768 },
};

/** Providers this provider knows how to speak to on the router. */
const SUPPORTED_PROVIDERS: readonly string[] = ["nscale", "hf-inference"];

/**
 * Providers serving the image-edit task on the router. Verified live via the
 * Hub model API — do NOT add nscale here (text-to-image only for FLUX.1-schnell).
 */
const EDIT_SUPPORTED_PROVIDERS: readonly string[] = ["fal-ai", "replicate", "wavespeed"];

/**
 * HF model id → provider-side model id, per edit provider. Verified live from
 * ?expand=inferenceProviderMapping (task "image-to-image", status "live").
 */
const EDIT_PROVIDER_MODELS: Record<string, Record<string, string>> = {
  "fal-ai": {
    "Qwen/Qwen-Image-Edit": "fal-ai/qwen-image-edit",
    "black-forest-labs/FLUX.1-Kontext-dev": "fal-ai/flux-kontext/dev",
  },
  replicate: {
    "Qwen/Qwen-Image-Edit": "qwen/qwen-image-edit",
    "black-forest-labs/FLUX.1-Kontext-dev": "black-forest-labs/flux-kontext-dev",
  },
  wavespeed: {
    "Qwen/Qwen-Image-Edit": "wavespeed-ai/qwen-image/edit",
    "black-forest-labs/FLUX.1-Kontext-dev": "wavespeed-ai/flux-kontext-dev",
  },
};

function mapHfStatus(status: number): ImageFailureCode {
  if (status === 401 || status === 403) return "provider_auth";
  // 402 Payment Required — account credits/balance, an account-level state,
  // never a transient provider fault: do not fall back past it.
  if (status === 402) return "provider_auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return "provider_unavailable";
  }
  // 4xx (400/404/415/422/…): a request/model mismatch to try elsewhere.
  return "provider_invalid_response";
}

export function resolveHuggingFaceConfig(): {
  token: string | null;
  model: string;
  provider: string;
  baseUrl: string;
  editModel: string;
  editProvider: string;
  editPollMs: number;
  editMaxPolls: number;
} {
  return {
    token: process.env.HF_TOKEN?.trim() || null,
    model: process.env.HF_IMAGE_MODEL?.trim() || DEFAULT_HF_IMAGE_MODEL,
    provider: process.env.HF_INFERENCE_PROVIDER?.trim() || DEFAULT_HF_PROVIDER,
    baseUrl: process.env.HF_INFERENCE_BASE_URL?.trim() || DEFAULT_HF_BASE_URL,
    editModel: process.env.HF_IMAGE_EDIT_MODEL?.trim() || DEFAULT_HF_EDIT_MODEL,
    editProvider: process.env.HF_IMAGE_EDIT_PROVIDER?.trim() || DEFAULT_HF_EDIT_PROVIDER,
    editPollMs: intFromEnv(process.env.HF_IMAGE_EDIT_POLL_MS, EDIT_POLL_MS),
    editMaxPolls: intFromEnv(process.env.HF_IMAGE_EDIT_MAX_POLLS, EDIT_MAX_POLLS),
  };
}

/** Builds the router request for the configured provider (single POST each). */
function buildRequest(
  config: ReturnType<typeof resolveHuggingFaceConfig>,
  params: ProviderGenerationParams
): { url: string; body: string; output: "bytes" | "b64_json"; accept: string } {
  const provider = config.provider;
  const dims = ASPECT_DIMS[params.aspectRatio];

  if (provider === "hf-inference") {
    return {
      url: `${config.baseUrl}/${provider}/models/${encodeURIComponent(config.model)}`,
      body: JSON.stringify({
        inputs: params.prompt,
        parameters: {
          width: dims.width,
          height: dims.height,
          ...(params.negativePrompt ? { negative_prompt: params.negativePrompt } : {}),
        },
      }),
      output: "bytes",
      accept: "image/*",
    };
  }

  // docker-style contract (default: nscale).
  return {
    url: `${config.baseUrl}/${provider}/v1/images/generations`,
    body: JSON.stringify({
      prompt: params.prompt,
      width: dims.width,
      height: dims.height,
      ...(params.negativePrompt ? { negative_prompt: params.negativePrompt } : {}),
      response_format: "b64_json",
      model: config.model,
    }),
    output: "b64_json",
    accept: "*/*",
  };
}

/** Aborts on the external signal OR the internal deadline; never double-waits. */
function createAbort(external?: AbortSignal, ms: number = HF_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onExternal = () => controller.abort();
  external?.addEventListener("abort", onExternal, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternal);
    },
  };
}

// --- Phase 6D: image-edit transport helpers (router → provider contracts) ---

/** Poll cadence and ceiling for the queue-style edit providers. */
const EDIT_POLL_MS = 500;
const EDIT_MAX_POLLS = 90; // 45 s ceiling comfortably inside the 60 s service budget.

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Int-parse an env override, falling back on any invalid value. */
function intFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEditJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ImageFailure(
      "provider_invalid_response",
      "Hugging Face edit returned malformed JSON."
    );
  }
}

/** One step of the edit request: fetch + status mapping (safe metadata logged). */
async function editStep(
  url: string,
  init: RequestInit,
  rejectStep: (status: number) => never
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ImageFailure("timeout", "Hugging Face edit call aborted.");
    }
    throw new ImageFailure("provider_unavailable", "Hugging Face edit network failure.");
  }
  if (!res.ok) rejectStep(res.status);
  return res;
}

/** GET→JSON step. */
async function editJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  rejectStep: (status: number) => never
): Promise<unknown> {
  const res = await editStep(url, { method: "GET", headers, signal }, rejectStep);
  return parseEditJson(await res.text());
}

/** POST→JSON step. */
async function editPostJson(
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  signal: AbortSignal,
  rejectStep: (status: number) => never
): Promise<unknown> {
  const res = await editStep(
    url,
    { method: "POST", headers, body: JSON.stringify(payload), signal },
    rejectStep
  );
  return parseEditJson(await res.text());
}

/** Download the edited image bytes from the provider/CDN step. */
async function editImageBytes(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  rejectStep: (status: number) => never
): Promise<Buffer> {
  const res = await editStep(url, { method: "GET", headers, signal }, rejectStep);
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length) {
    throw new ImageFailure("provider_invalid_response", "Hugging Face edit downloaded empty bytes.");
  }
  return data;
}

/**
 * Runs one image-edit request against the configured provider contract. Each
 * provider mirrors huggingface_hub's provider helper exactly; the source image
 * is ALWAYS embedded as a data URL — never a text-only re-render.
 */
async function editWithProvider(config: {
  baseUrl: string;
  editProvider: string;
  providerModelId: string;
  sourceDataUrl: string;
  instruction: string;
  negativePrompt?: string;
  targetSize?: { width: number; height: number };
  headers: Record<string, string>;
  signal: AbortSignal;
  pollMs: number;
  maxPolls: number;
  rejectStep: (status: number) => never;
}): Promise<Buffer> {
  const {
    baseUrl,
    editProvider,
    providerModelId,
    sourceDataUrl,
    instruction,
    negativePrompt,
    targetSize,
    headers,
    signal,
    pollMs,
    maxPolls,
    rejectStep,
  } = config;

  if (editProvider === "fal-ai") {
    const submitUrl = `${baseUrl}/fal-ai/${providerModelId}?_subdomain=queue`;
    const submit = (await editPostJson(
      submitUrl,
      {
        image_url: sourceDataUrl,
        image_urls: [sourceDataUrl],
        prompt: instruction,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        ...(targetSize ? { image_size: targetSize } : {}),
      },
      headers,
      signal,
      rejectStep
    )) as { response_url?: string };
    if (typeof submit?.response_url !== "string") {
      throw new ImageFailure(
        "provider_invalid_response",
        "Hugging Face edit response is missing response_url."
      );
    }
    let modelPath: string;
    try {
      modelPath = new URL(submit.response_url).pathname;
    } catch {
      modelPath = submit.response_url;
    }
    const pollBase = `${baseUrl}/fal-ai${modelPath}`;
    let result: { images?: Array<{ url?: string }> } | undefined;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollMs);
      const status = (await editJson(
        `${pollBase}/status?_subdomain=queue`,
        headers,
        signal,
        rejectStep
      )) as { status?: string };
      if (status?.status === "COMPLETED") {
        result = (await editJson(
          `${pollBase}?_subdomain=queue`,
          headers,
          signal,
          rejectStep
        )) as { images?: Array<{ url?: string }> };
        break;
      }
    }
    if (!result) {
      throw new ImageFailure("timeout", "Hugging Face edit did not complete in time.");
    }
    const imageUrl = result.images?.[0]?.url;
    if (typeof imageUrl !== "string") {
      throw new ImageFailure(
        "provider_invalid_response",
        "Hugging Face edit result is missing image data."
      );
    }
    return editImageBytes(imageUrl, headers, signal, rejectStep);
  }

  if (editProvider === "replicate") {
    const submitUrl = `${baseUrl}/replicate/v1/models/${providerModelId}/predictions`;
    const submit = (await editPostJson(
      submitUrl,
      {
        input: {
          image: sourceDataUrl,
          images: [sourceDataUrl],
          input_image: sourceDataUrl,
          input_images: [sourceDataUrl],
          prompt: instruction,
          ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
          ...(targetSize ? { target_size: targetSize } : {}),
        },
      },
      { ...headers, Prefer: "wait" },
      signal,
      rejectStep
    )) as { output?: string | string[] | null };
    const output = submit?.output;
    if (output == null || (Array.isArray(output) && output.length === 0)) {
      // Mirrors huggingface_hub: a fully-waited prediction with no output is a
      // time-out (cold start / queue exhaustion), not a bad response.
      throw new ImageFailure("timeout", "Hugging Face edit did not complete in time.");
    }
    const imageUrl = Array.isArray(output) ? output[0] : output;
    if (typeof imageUrl !== "string" || !imageUrl) {
      throw new ImageFailure(
        "provider_invalid_response",
        "Hugging Face edit result has no image URL."
      );
    }
    return editImageBytes(imageUrl, headers, signal, rejectStep);
  }

  if (editProvider === "wavespeed") {
    const submitUrl = `${baseUrl}/wavespeed/api/v3/${providerModelId}`;
    const submit = (await editPostJson(
      submitUrl,
      {
        image: sourceDataUrl,
        prompt: instruction,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        ...(targetSize ? { target_size: targetSize } : {}),
      },
      headers,
      signal,
      rejectStep
    )) as { data?: { urls?: { get?: string } } };
    const getPath = submit?.data?.urls?.get;
    if (typeof getPath !== "string") {
      throw new ImageFailure(
        "provider_invalid_response",
        "Hugging Face edit response is missing a result URL."
      );
    }
    let resultPath: string;
    try {
      resultPath = new URL(getPath).pathname;
    } catch {
      resultPath = getPath;
    }
    const resultUrl = `${baseUrl}/wavespeed${resultPath}`;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollMs);
      const res = (await editJson(resultUrl, headers, signal, rejectStep)) as {
        data?: { status?: string; outputs?: string[]; error?: string };
      };
      const st = res?.data?.status;
      if (st === "completed") {
        const imageUrl = res?.data?.outputs?.[0];
        if (typeof imageUrl !== "string") {
          throw new ImageFailure(
            "provider_invalid_response",
            "Hugging Face edit completed without an output URL."
          );
        }
        return editImageBytes(imageUrl, headers, signal, rejectStep);
      }
      if (st === "failed") {
        throw new ImageFailure(
          "provider_invalid_response",
          `Hugging Face edit failed: ${res?.data?.error ?? "no detail"}.`
        );
      }
    }
    throw new ImageFailure("timeout", "Hugging Face edit did not complete in time.");
  }

  throw new ImageFailure(
    "misconfigured",
    `Hugging Face edit provider "${editProvider}" is not supported.`
  );
}

export const huggingfaceImageProvider: ImageProvider = {
  id: "huggingface",
  async generate(params: ProviderGenerationParams): Promise<ProviderImageOutput> {
    const config = resolveHuggingFaceConfig();
    if (!config.token) {
      // No key configured: the router rejects anonymous image requests. This
      // is a configuration gap, reported safely (never the raw detail).
      throw new ImageFailure("provider_auth", "HF_TOKEN is not configured on the server.");
    }
    if (!SUPPORTED_PROVIDERS.includes(config.provider)) {
      throw new ImageFailure(
        "misconfigured",
        `Hugging Face router provider "${config.provider}" is not supported.`
      );
    }

    const request = buildRequest(config, params);
    const abort = createAbort(params.abortSignal);
    let res: Response;
    const startedAt = Date.now();
    try {
      res = await fetch(request.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: request.accept,
          Authorization: `Bearer ${config.token}`,
        },
        body: request.body,
        signal: abort.signal,
      });
    } catch (error) {
      abort.cleanup();
      if (abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new ImageFailure("timeout", "Hugging Face call aborted.");
      }
      if (error instanceof TypeError) {
        throw new ImageFailure("provider_unavailable", "Hugging Face network failure.");
      }
      throw new ImageFailure("provider_unavailable", "Hugging Face call failed.");
    }
    abort.cleanup();

    if (!res.ok) {
      const code = mapHfStatus(res.status);
      const elapsed = Date.now() - startedAt;
      // Safe log: provider, model, status, taxonomy, duration. Never the token,
      // never the Authorization header, never the request/response bodies.
      console.error(
        `[image-generation] HF provider=${config.provider} model=${config.model} ` +
          `failed status=${res.status} code=${code} elapsed=${elapsed}ms`
      );
      throw new ImageFailure(code, `Hugging Face returned status ${res.status}.`);
    }

    if (request.output === "bytes") {
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!contentType.startsWith("image/")) {
        throw new ImageFailure(
          "provider_invalid_response",
          "Hugging Face returned a non-image response."
        );
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (!data.length) {
        throw new ImageFailure("provider_invalid_response", "Hugging Face returned empty bytes.");
      }
      return { data, mimeType: contentType || "image/png", width: 0, height: 0, fileSizeBytes: data.length };
    }

    // b64_json contract (nscale and friends).
    let payload: { data?: Array<{ b64_json?: string }> };
    try {
      payload = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    } catch {
      throw new ImageFailure(
        "provider_invalid_response",
        "Hugging Face returned malformed JSON."
      );
    }
    const b64 = payload.data?.[0]?.b64_json;
    if (!b64) {
      throw new ImageFailure(
        "provider_invalid_response",
        "Hugging Face image payload is missing image data."
      );
    }
    const data = Buffer.from(b64, "base64");
    if (!data.length) {
      throw new ImageFailure("provider_invalid_response", "Hugging Face returned empty bytes.");
    }
    // MIME is left to normalizeOutput/validateImage, which sniff the magic bytes
    // (the SDK's hardcoded "image/jpeg" assumption is wrong for PNG output).
    return { data, width: 0, height: 0, fileSizeBytes: data.length };
  },

  async edit(params: ProviderEditParams): Promise<ProviderImageOutput> {
    const config = resolveHuggingFaceConfig();
    if (!config.token) {
      throw new ImageFailure("provider_auth", "HF_TOKEN is not configured on the server.");
    }
    if (!EDIT_SUPPORTED_PROVIDERS.includes(config.editProvider)) {
      throw new ImageFailure(
        "misconfigured",
        `Hugging Face edit provider "${config.editProvider}" is not supported.`
      );
    }
    const providerModelId = EDIT_PROVIDER_MODELS[config.editProvider]?.[config.editModel];
    if (!providerModelId) {
      throw new ImageFailure(
        "misconfigured",
        `Edit model "${config.editModel}" is not served by provider "${config.editProvider}".`
      );
    }

    // The route validated these bytes (magic, size, dimensions) before the
    // service ran — embed them directly as the provider's source image.
    const sourceDataUrl = `data:${params.sourceImage.mimeType};base64,${params.sourceImage.bytes.toString("base64")}`;
    const targetSize = params.aspectRatio ? ASPECT_DIMS[params.aspectRatio] : undefined;

    const scope = createAbort(params.abortSignal);
    const startedAt = Date.now();
    const headers = {
      "Content-Type": "application/json",
      Accept: "*/*",
      Authorization: `Bearer ${config.token}`,
    };
    const rejectStep = (status: number): never => {
      const code = mapHfStatus(status);
      console.error(
        `[image-generation] HF edit provider=${config.editProvider} model=${config.editModel} ` +
          `providerModelId=${providerModelId} status=${status} code=${code} ` +
          `elapsed=${Date.now() - startedAt}ms`
      );
      throw new ImageFailure(code, `Hugging Face edit returned status ${status}.`);
    };

    try {
      const data = await editWithProvider({
        baseUrl: config.baseUrl,
        editProvider: config.editProvider,
        providerModelId,
        sourceDataUrl,
        instruction: params.instruction,
        negativePrompt: params.negativePrompt,
        targetSize,
        headers,
        signal: scope.signal,
        pollMs: config.editPollMs,
        maxPolls: config.editMaxPolls,
        rejectStep,
      });
      if (!data.length) {
        throw new ImageFailure(
          "provider_invalid_response",
          "Hugging Face edit returned empty bytes."
        );
      }
      // MIME is left to normalizeOutput/validateImage (magic-byte sniffing).
      return { data, width: 0, height: 0, fileSizeBytes: data.length };
    } finally {
      scope.cleanup();
    }
  },
};