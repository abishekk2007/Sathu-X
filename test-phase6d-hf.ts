// ---------------------------------------------------------------------------
// Phase 6D — Hugging Face IMAGE-EDIT fallback focused unit suite (mocked fetch).
//
// Tests src/lib/image-generation/huggingface-provider.ts edit() against the
// LIVE Inference Providers image-to-image contracts (verified via the Hub
// model API, task "image-to-image"):
//   fal-ai    POST https://router.huggingface.co/fal-ai/{providerModelId}?_subdomain=queue
//   replicate POST https://router.huggingface.co/replicate/v1/models/{providerModelId}/predictions
//   wavespeed POST https://router.huggingface.co/wavespeed/api/v3/{providerModelId}
// plus the service-level Gemini → HF fallback policy (exact call counts).
// The obsolete api-inference.huggingface.co host must never be used, edits
// must ALWAYS embed the source image bytes (never a text-only re-render), and
// the token must never leak into logs or responses.
// No test touches the real HF network and no test reads .env.local.
// ---------------------------------------------------------------------------

import { huggingfaceImageProvider, resolveHuggingFaceConfig, DEFAULT_HF_BASE_URL, DEFAULT_HF_EDIT_MODEL, DEFAULT_HF_EDIT_PROVIDER, HAS_HF_IMAGE_EDIT } from "./src/lib/image-generation/huggingface-provider";
import { editImageWithProviders } from "./src/lib/image-generation/service";
import { ImageFailure } from "./src/lib/image-generation/types";
import type { ImageFailureCode, ImageProvider, ProviderEditParams } from "./src/lib/image-generation/types";

// --- Tiny assertion harness (CJS-compatible: no top-level await) -------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (Object.is(actual, expected)) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function section(name: string): void {
  console.log(`\n[${name}]`);
}

/** Minimal PNG header ($89PNG\r\n\x1a\n + IHDR length/dims) — enough for validateImage. */
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

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Mocks globalThis.fetch, records calls, restores on cleanup(). */
function withMockFetch(
  handler: (input: string, init: RequestInit) => Promise<Response> | Response
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const TEST_TOKEN = "hf_test_token_abcdef1234567890";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function imageResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

/** Environment fixture: deterministic config, restored after each block. */
function envFixture() {
  const previous = {
    HF_TOKEN: process.env.HF_TOKEN,
    HF_IMAGE_EDIT_MODEL: process.env.HF_IMAGE_EDIT_MODEL,
    HF_IMAGE_EDIT_PROVIDER: process.env.HF_IMAGE_EDIT_PROVIDER,
    HF_IMAGE_EDIT_POLL_MS: process.env.HF_IMAGE_EDIT_POLL_MS,
    HF_IMAGE_EDIT_MAX_POLLS: process.env.HF_IMAGE_EDIT_MAX_POLLS,
    HF_INFERENCE_PROVIDER: process.env.HF_INFERENCE_PROVIDER,
  };
  process.env.HF_TOKEN = TEST_TOKEN;
  delete process.env.HF_IMAGE_EDIT_MODEL;
  delete process.env.HF_IMAGE_EDIT_PROVIDER;
  process.env.HF_IMAGE_EDIT_POLL_MS = "1";
  delete process.env.HF_IMAGE_EDIT_MAX_POLLS;
  delete process.env.HF_INFERENCE_PROVIDER;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Fal-ai success flow (submit → one status poll → result → download). */
function falAiSuccessHandler(output: Buffer) {
  return (url: string, init: RequestInit): Response => {
    const method = init.method ?? "GET";
    if (method === "POST") {
      // submit
      return jsonResponse(200, {
        request_id: "req-1",
        status: "IN_QUEUE",
        response_url: "https://router.huggingface.co/fal-ai/fal-ai/qwen-image-edit",
      });
    }
    if (url.includes("/status")) {
      return jsonResponse(200, { status: "COMPLETED" });
    }
    if (url.endsWith("?_subdomain=queue")) {
      // result (same URL as the POST, differentiated by method)
      return jsonResponse(200, { images: [{ url: "https://cdn.fal.ai/out.png" }] });
    }
    if (url === "https://cdn.fal.ai/out.png") return imageResponse(output);
    throw new Error(`unexpected fal-ai URL: ${url}`);
  };
}

/** Capture console.error for token-hygiene checks. */
let capturedErrorLogs: string[] = [];
function withErrorCapture(run: () => Promise<void>): Promise<void> {
  const original = console.error;
  capturedErrorLogs = [];
  console.error = (...args: unknown[]) => {
    capturedErrorLogs.push(args.map(String).join(" "));
  };
  return run().finally(() => {
    console.error = original;
  });
}

async function main(): Promise<void> {
  section("A. exports: edit capability + defaults are truthful");
  {
    assertEqual(HAS_HF_IMAGE_EDIT, true, "A HAS_HF_IMAGE_EDIT is true");
    assertEqual(DEFAULT_HF_EDIT_MODEL, "Qwen/Qwen-Image-Edit", "A default edit model");
    assertEqual(DEFAULT_HF_EDIT_PROVIDER, "fal-ai", "A default edit provider");
    assertEqual(DEFAULT_HF_BASE_URL, "https://router.huggingface.co", "A router base");
    const restore = envFixture();
    try {
      const cfg = resolveHuggingFaceConfig();
      assertEqual(cfg.editModel, "Qwen/Qwen-Image-Edit", "A resolver default edit model");
      assertEqual(cfg.editProvider, "fal-ai", "A resolver default edit provider");
      assertEqual(cfg.editPollMs, 1, "A poll ms read from env override");
      assertEqual(cfg.editMaxPolls, 90, "A max polls default");
      assertEqual(cfg.provider, "nscale", "A generation provider unaffected (nscale default)");
    } finally {
      restore();
    }
  }

  section("B. missing HF_TOKEN → provider_auth");
  {
    const restore = envFixture();
    process.env.HF_TOKEN = "";
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "make the sky sunset",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_auth", "B no HF_TOKEN → provider_auth");
    } finally {
      restore();
    }
  }

  section("C. unsupported edit provider → misconfigured (generation unaffected)");
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_PROVIDER = "nscale";
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "make the sky sunset",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "misconfigured", "C nscale is not an edit provider");
    } finally {
      restore();
    }
  }

  section("E. fal-ai end-to-end success (provider level)");
  {
    const restore = envFixture();
    const output = png(640, 480);
    const mock = withMockFetch(falAiSuccessHandler(output));
    try {
      const out = await huggingfaceImageProvider.edit?.({
        sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
        instruction: "make the sky sunset",
      });
      assert(out !== undefined, "E edit() is implemented");
      assertEqual(out?.data.length, output.length, "E bytes downloaded match");
      assertEqual(out?.fileSizeBytes, output.length, "E fileSizeBytes correct");
      const urls = mock.calls.map((c) => c.url);
      assertEqual(
        urls[0],
        "https://router.huggingface.co/fal-ai/fal-ai/qwen-image-edit?_subdomain=queue",
        "E fal-ai submit URL (router, provider-qualified model)"
      );
      assert(urls.some((u) => u.endsWith("/status?_subdomain=queue")), "E status polled");
      assert(urls[urls.length - 1] === "https://cdn.fal.ai/out.png", "E final image downloaded");
      assert(mock.calls.length >= 3, "E submit + poll + download sequence (one attempt overall)");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("F. source bytes are embedded (never a text-only re-render) + prompt forwarding");
  {
    const restore = envFixture();
    const source = png(400, 300);
    const mock = withMockFetch(falAiSuccessHandler(png(640, 480)));
    try {
      await huggingfaceImageProvider.edit?.({
        sourceImage: { bytes: source, mimeType: "image/png" },
        instruction: "Turn the cat into a tiger",
        negativePrompt: "cartoon, low quality",
      });
      const body = JSON.parse(String(mock.calls[0]?.init.body ?? "{}")) as {
        image_url?: string;
        image_urls?: string[];
        prompt?: string;
        negative_prompt?: string;
      };
      const expectedData = `data:image/png;base64,${source.toString("base64")}`;
      assertEqual(body.image_url, expectedData, "F image_url carries the source PNG data URL");
      assertEqual(body.image_urls?.[0], expectedData, "F image_urls carries the source PNG data URL");
      assert(!expectedData.includes("tiger"), "F source data URL is NOT the prompt text");
      assertEqual(body.prompt, "Turn the cat into a tiger", "F instruction forwarded as prompt");
      assertEqual(body.negative_prompt, "cartoon, low quality", "F negative_prompt forwarded");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("G. fal-ai submit status mapping (spec §9)");
  {
    for (const [status, expected] of [
      [401, "provider_auth"],
      [403, "provider_auth"],
      [402, "provider_auth"],
      [408, "timeout"],
      [429, "rate_limited"],
      [500, "provider_unavailable"],
      [502, "provider_unavailable"],
      [503, "provider_unavailable"],
      [504, "provider_unavailable"],
      [400, "provider_invalid_response"],
    ] as const) {
      const restore = envFixture();
      const mock = withMockFetch(() => new Response("nope", { status }));
      try {
        let code: ImageFailureCode | null = null;
        try {
          await huggingfaceImageProvider.edit?.({
            sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
            instruction: "make the sky sunset",
          });
        } catch (error) {
          if (error instanceof ImageFailure) code = error.code;
        }
        assertEqual(code, expected, `G HTTP ${status} → ${expected}`);
        assertEqual(mock.calls.length, 1, `G status ${status}: exactly one attempt`);
      } finally {
        mock.restore();
        restore();
      }
    }
  }

  section("H. malformed submit JSON / missing response_url / never-completes → mapped");
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_MAX_POLLS = "3";
    const mock = withMockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "x",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_invalid_response", "H malformed submit JSON → provider_invalid_response");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_MAX_POLLS = "3";
    const mock = withMockFetch(() => jsonResponse(200, { request_id: "r1" }));
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "x",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_invalid_response", "H missing response_url → provider_invalid_response");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_MAX_POLLS = "3";
    const mock = withMockFetch((url) => {
      if (url.endsWith("?_subdomain=queue") && !url.includes("/status")) {
        return jsonResponse(200, {
          request_id: "r1",
          response_url: "https://router.huggingface.co/fal-ai/fal-ai/qwen-image-edit",
        });
      }
      return jsonResponse(200, { status: "IN_QUEUE" });
    });
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "x",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "timeout", "H never-COMPLETED after max polls → timeout");
      assertEqual(mock.calls.length, 4, "H submit + exactly 3 status polls (bounded, no infinite loop)");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("I. missing result image URL / empty download → provider_invalid_response");
  {
    const restore = envFixture();
    const mock = withMockFetch((url, init) => {
      const method = init.method ?? "GET";
      if (method === "POST") {
        return jsonResponse(200, {
          request_id: "r1",
          response_url: "https://router.huggingface.co/fal-ai/fal-ai/qwen-image-edit",
        });
      }
      if (url.includes("/status")) return jsonResponse(200, { status: "COMPLETED" });
      return jsonResponse(200, { images: [] });
    });
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "x",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_invalid_response", "I images[].url missing → provider_invalid_response");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    const mock = withMockFetch((url, init) => {
      const method = init.method ?? "GET";
      if (method === "POST") {
        return jsonResponse(200, {
          request_id: "r1",
          response_url: "https://router.huggingface.co/fal-ai/fal-ai/qwen-image-edit",
        });
      }
      if (url.includes("/status")) return jsonResponse(200, { status: "COMPLETED" });
      if (url === "https://cdn.fal.ai/out.png") return new Response("", { status: 200 });
      return jsonResponse(200, { images: [{ url: "https://cdn.fal.ai/out.png" }] });
    });
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "x",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_invalid_response", "I empty downloaded bytes → provider_invalid_response");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("J. replicate contract (Prefer: wait, prediction output URLs)");
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_PROVIDER = "replicate";
    const output = png(512, 512);
    const mock = withMockFetch((url) => {
      if (url === "https://router.huggingface.co/replicate/v1/models/qwen/qwen-image-edit/predictions") {
        return jsonResponse(200, { id: "p1", output: "https://replicate.delivery/out.png" });
      }
      if (url === "https://replicate.delivery/out.png") return imageResponse(output);
      throw new Error(`unexpected replicate URL: ${url}`);
    });
    try {
      const out = await huggingfaceImageProvider.edit?.({
        sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
        instruction: "make the sky sunset",
      });
      assertEqual(out?.data.length, output.length, "J replicate output bytes");
      const headers = (mock.calls[0]?.init.headers ?? {}) as Record<string, string>;
      assertEqual(headers.Prefer, "wait", "J Prefer: wait header on the prediction call");
      const body = JSON.parse(String(mock.calls[0]?.init.body ?? "{}")) as {
        input?: { image?: string; images?: string[]; input_image?: string; input_images?: string[]; prompt?: string };
      };
      assert(typeof body.input?.image === "string" && body.input.image.includes(";base64,"), "J input.image is a data URL");
      assertEqual(body.input?.images?.[0], body.input?.image, "J images alias mirrors the source");
      assertEqual(body.input?.input_image, body.input?.image, "J input_image alias mirrors the source");
      assertEqual(body.input?.input_images?.[0], body.input?.image, "J input_images alias mirrors the source");
      assertEqual(body.input?.prompt, "make the sky sunset", "J prompt forwarded");
      assertEqual(mock.calls.length, 2, "J submit + download (no polling)");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_PROVIDER = "replicate";
    const mock = withMockFetch((url) => {
      if (url.endsWith("/predictions")) return jsonResponse(200, { id: "p1", output: null });
      return new Response("", { status: 200 });
    });
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "x",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "timeout", "J null output → timeout (mirrors huggingface_hub TimeoutError)");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("K. wavespeed contract (submit → poll result → output URL)");
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_PROVIDER = "wavespeed";
    const output = png(512, 768);
    let statusCalls = 0;
    const mock = withMockFetch((url) => {
      if (url === "https://router.huggingface.co/wavespeed/api/v3/wavespeed-ai/qwen-image/edit") {
        return jsonResponse(200, { data: { urls: { get: "/api/v3/tasks/abc" } } });
      }
      if (url === "https://router.huggingface.co/wavespeed/api/v3/tasks/abc") {
        statusCalls++;
        return jsonResponse(200, {
          data: { status: statusCalls === 1 ? "processing" : "completed", outputs: ["https://cdn.wavespeed.ai/out.png"] },
        });
      }
      if (url === "https://cdn.wavespeed.ai/out.png") return imageResponse(output);
      throw new Error(`unexpected wavespeed URL: ${url}`);
    });
    try {
      const out = await huggingfaceImageProvider.edit?.({
        sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
        instruction: "make the sky sunset",
      });
      assertEqual(out?.data.length, output.length, "K wavespeed output bytes");
      const body = JSON.parse(String(mock.calls[0]?.init.body ?? "{}")) as { image?: string; prompt?: string };
      assert(typeof body.image === "string" && body.image.startsWith("data:image/png;base64,"), "K image is a source data URL");
      assertEqual(body.prompt, "make the sky sunset", "K prompt forwarded");
      assertEqual(statusCalls, 2, "K polled until completed");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_PROVIDER = "wavespeed";
    const mock = withMockFetch((url) => {
      if (url.endsWith("/wavespeed/api/v3/wavespeed-ai/qwen-image/edit")) {
        return jsonResponse(200, { data: { urls: { get: "/api/v3/tasks/abc" } } });
      }
      return jsonResponse(200, { data: { status: "failed", error: "the model rejected the input" } });
    });
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "x",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_invalid_response", "K wavespeed failed task → provider_invalid_response");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("L. service fallback taxonomy — Gemini → HF with exact call counts");
  {
    const restore = envFixture();
    const output = png(640, 480);
    const mock = withMockFetch(falAiSuccessHandler(output));
    try {
      let geminiEdits = 0;
      const geminiProvider: ImageProvider = {
        id: "gemini",
        async generate() {
          throw new ImageFailure("provider_auth", "nope");
        },
        async edit() {
          geminiEdits++;
          throw new ImageFailure("rate_limited", "free tier");
        },
      };
      const out = await editImageWithProviders(
        {
          message: "make the sky sunset",
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          sourceKey: "img-1",
        },
        [geminiProvider, huggingfaceImageProvider]
      );
      assertEqual(geminiEdits, 1, "L gemini edit attempted exactly once");
      assertEqual(out.kind, "image", "L eligible fallback succeeds via HF");
      if (out.kind === "image") {
        assertEqual(out.image.provider, "huggingface", "L provider stamped huggingface");
        assertEqual(out.image.mode, "edit", "L mode stamped edit");
        assertEqual(out.image.editSourceKey, "img-1", "L editSourceKey stamped");
        assertEqual(out.image.width, 640, "L output dims validated (640)");
        assertEqual(out.image.height, 480, "L output dims validated (480)");
        assert(out.image.prompt.length > 0, "L composed instruction carried as prompt");
        assertEqual(out.message, "Here's your edited image.", "L edit caption");
        // One HF attempt = submit + poll + result + download sequence, started exactly once.
        const hfCalls = mock.calls.filter((c) => c.url.startsWith("https://router.huggingface.co/fal-ai/"));
        assertEqual(hfCalls.length, 3, "L one HF attempt (submit, status, result) — no retry loops");
      }
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    // safety_blocked must NEVER shift providers.
    const restore = envFixture();
    const mock = withMockFetch(() => imageResponse(png(64, 64)));
    try {
      let geminiEdits = 0;
      const geminiProvider: ImageProvider = {
        id: "gemini",
        async generate() {
          throw new ImageFailure("provider_auth", "nope");
        },
        async edit() {
          geminiEdits++;
          throw new ImageFailure("safety_blocked", "user content");
        },
      };
      const out = await editImageWithProviders(
        { message: "make it gory", sourceImage: { bytes: png(400, 300), mimeType: "image/png" } },
        [geminiProvider, huggingfaceImageProvider]
      );
      assertEqual(geminiEdits, 1, "L gemini attempted once");
      assertEqual(mock.calls.length, 0, "L safety_blocked → HF NEVER called");
      assertEqual(out.kind, "message", "L safety_blocked stops with a safe message");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    // provider_auth (config gap) must also never shift providers.
    const restore = envFixture();
    const mock = withMockFetch(() => imageResponse(png(64, 64)));
    try {
      const geminiProvider: ImageProvider = {
        id: "gemini",
        async generate() {
          throw new ImageFailure("provider_auth", "key missing");
        },
        async edit() {
          throw new ImageFailure("provider_auth", "key missing");
        },
      };
      const out = await editImageWithProviders(
        { message: "make the sky sunset", sourceImage: { bytes: png(400, 300), mimeType: "image/png" } },
        [geminiProvider, huggingfaceImageProvider]
      );
      assertEqual(mock.calls.length, 0, "L provider_auth → HF NEVER called");
      assertEqual(out.kind, "message", "L provider_auth → safe message, no fallback");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("M. pixel-difference: edited output differs from the source image");
  {
    const restore = envFixture();
    const source = png(400, 300);
    const edited = png(640, 480);
    const mock = withMockFetch(falAiSuccessHandler(edited));
    try {
      const out = await huggingfaceImageProvider.edit?.({
        sourceImage: { bytes: source, mimeType: "image/png" },
        instruction: "make the sky sunset",
      });
      assert(out !== undefined && !out.data.equals(source), "M edited bytes differ from (are not) the source");
      assert(out !== undefined && out.data.equals(edited), "M edited bytes ARE the provider output");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("N. token never appears in logs or errors; Bearer header is sent");
  {
    const restore = envFixture();
    const mock = withMockFetch(() => new Response("denied", { status: 403 }));
    try {
      await withErrorCapture(async () => {
        try {
          await huggingfaceImageProvider.edit?.({
            sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
            instruction: "make the sky sunset",
          });
        } catch {
          /* expected */
        }
      });
      const allLogs = capturedErrorLogs.join(" | ");
      assert(!allLogs.includes(TEST_TOKEN), "N console.error never contains the token");
      assert(!allLogs.includes("Authorization"), "N headers are never logged");
      assert(allLogs.includes("status=403"), "N safe metadata (status) IS logged");
      assert(allLogs.includes("code=provider_auth"), "N safe taxonomy IS logged");
      const headers = (mock.calls[0]?.init.headers ?? {}) as Record<string, string>;
      assertEqual(headers.Authorization, `Bearer ${TEST_TOKEN}`, "N Authorization: Bearer sent on the request");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("O. router only — legacy api-inference host is never used");
  {
    const restore = envFixture();
    const mock = withMockFetch(falAiSuccessHandler(png(64, 64)));
    try {
      await huggingfaceImageProvider.edit?.({
        sourceImage: { bytes: png(64, 64), mimeType: "image/png" },
        instruction: "make the sky sunset",
      });
      for (const call of mock.calls) {
        assert(!call.url.includes("api-inference.huggingface.co"), `O no legacy host (${call.url})`);
        assert(call.url.startsWith("https://router.huggingface.co/") || call.url.startsWith("https://cdn."), `O current hosts only (${call.url})`);
      }
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P. provider/model config flows: replicate + FLUX.1-Kontext-dev + aspect ratio mapping");
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_PROVIDER = "replicate";
    process.env.HF_IMAGE_EDIT_MODEL = "black-forest-labs/FLUX.1-Kontext-dev";
    const mock = withMockFetch((url) => {
      if (url.endsWith("/predictions")) return jsonResponse(200, { output: "https://cdn.example/out.png" });
      if (url === "https://cdn.example/out.png") return imageResponse(png(32, 32));
      throw new Error(`unexpected URL: ${url}`);
    });
    try {
      const cfg = resolveHuggingFaceConfig();
      assertEqual(cfg.editProvider, "replicate", "P editProvider reads env");
      assertEqual(cfg.editModel, "black-forest-labs/FLUX.1-Kontext-dev", "P editModel reads env");
      await huggingfaceImageProvider.edit?.({
        sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
        instruction: "make the sky sunset",
        aspectRatio: "1:1",
      });
      assertEqual(
        mock.calls[0]?.url,
        "https://router.huggingface.co/replicate/v1/models/black-forest-labs/flux-kontext-dev/predictions",
        "P replicate FLUX providerModelId URL"
      );
      const body = JSON.parse(String(mock.calls[0]?.init.body ?? "{}")) as {
        input?: { target_size?: { width: number; height: number } };
      };
      assertEqual(body.input?.target_size?.width, 1024, "P aspectRatio 1:1 → target_size width 1024");
      assertEqual(body.input?.target_size?.height, 1024, "P aspectRatio 1:1 → target_size height 1024");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_MODEL = "black-forest-labs/FLUX.1-Kontext-dev";
    const mock = withMockFetch(falAiSuccessHandler(png(64, 64)));
    try {
      await huggingfaceImageProvider.edit?.({
        sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
        instruction: "make the sky sunset",
      });
      assertEqual(
        mock.calls[0]?.url,
        "https://router.huggingface.co/fal-ai/fal-ai/flux-kontext/dev?_subdomain=queue",
        "P fal-ai FLUX providerModelId URL"
      );
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    const mock = withMockFetch(falAiSuccessHandler(png(64, 64)));
    try {
      await huggingfaceImageProvider.edit?.({
        sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
        instruction: "make the sky sunset",
        aspectRatio: "16:9",
      });
      const body = JSON.parse(String(mock.calls[0]?.init.body ?? "{}")) as {
        image_size?: { width: number; height: number };
      };
      assertEqual(body.image_size?.width, 1344, "P fal-ai aspectRatio 16:9 → image_size width 1344");
      assertEqual(body.image_size?.height, 768, "P fal-ai aspectRatio 16:9 → image_size height 768");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("Q. unsupported model for a supported provider → misconfigured");
  {
    const restore = envFixture();
    process.env.HF_IMAGE_EDIT_MODEL = "stabilityai/stable-diffusion-xl-base-1.0";
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.edit?.({
          sourceImage: { bytes: png(400, 300), mimeType: "image/png" },
          instruction: "make the sky sunset",
        });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "misconfigured", "Q unverified edit model → misconfigured (never falls back)");
    } finally {
      restore();
    }
  }

  section("R. edit() is present and sources raw provider params");
  {
    const restore = envFixture();
    const editFn = huggingfaceImageProvider.edit as ((p: ProviderEditParams) => Promise<unknown>) | undefined;
    assert(typeof editFn === "function", "R provider exposes edit()");
    restore();
  }

  console.log("\n============================================================");
  console.log(`Phase 6D-HF: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failed labels:");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("============================================================\n");
}

void (async () => {
  await main();
  if (failed > 0) process.exit(1);
})();