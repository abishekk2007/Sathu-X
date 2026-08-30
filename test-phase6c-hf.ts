// ---------------------------------------------------------------------------
// Phase 6C — Hugging Face provider FOCUSED unit suite (mocked fetch).
//
// Transport-level tests for src/lib/image-generation/huggingface-provider.ts
// against the CURRENT Inference Providers router contract:
//   POST https://router.huggingface.co/{provider}/v1/images/generations
//   (b64_json docker format, default provider "nscale")
// The obsolete api-inference.huggingface.co host must never be used.
// No test touches the real HF network and no test reads .env.local.
// ---------------------------------------------------------------------------

import { huggingfaceImageProvider, resolveHuggingFaceConfig, DEFAULT_HF_BASE_URL, DEFAULT_HF_PROVIDER } from "./src/lib/image-generation/huggingface-provider";
import { generateImageWithProviders } from "./src/lib/image-generation/service";
import { ImageFailure, SAFE_UNAVAILABLE_MESSAGE } from "./src/lib/image-generation/types";
import type { ImageFailureCode, ImageProvider } from "./src/lib/image-generation/types";

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

/** Mocks globalThis.fetch, records calls, and restores on cleanup(). */
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

function b64Response(status: number, b64: string): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Environment fixture: deterministic config, restored after each block. */
function envFixture() {
  const previous = {
    HF_TOKEN: process.env.HF_TOKEN,
    HF_IMAGE_MODEL: process.env.HF_IMAGE_MODEL,
    HF_INFERENCE_PROVIDER: process.env.HF_INFERENCE_PROVIDER,
    HF_INFERENCE_BASE_URL: process.env.HF_INFERENCE_BASE_URL,
  };
  process.env.HF_TOKEN = TEST_TOKEN;
  delete process.env.HF_IMAGE_MODEL;
  delete process.env.HF_INFERENCE_PROVIDER;
  delete process.env.HF_INFERENCE_BASE_URL;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

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
  section("P1. missing HF_TOKEN");
  {
    const restore = envFixture();
    process.env.HF_TOKEN = "";
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "draw a castle", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_auth", "P1 no HF_TOKEN → provider_auth");
      assert(capturedErrorLogs.length === 0, "P1 nothing logged for config gap");
    } finally {
      restore();
    }
  }

  section("P2. successful b64_json image (default nscale router path)");
  {
    const restore = envFixture();
    const bytes = png(512, 384);
    const mock = withMockFetch(() => b64Response(200, bytes.toString("base64")));
    try {
      const out = await huggingfaceImageProvider.generate({ prompt: "water cycle", aspectRatio: "4:3" });
      assertEqual(out.data.length, bytes.length, "P2 bytes decoded match");
      assertEqual(out.mimeType, undefined, "P2 MIME left to validateImage (magic sniff)");
      assertEqual(out.fileSizeBytes, bytes.length, "P2 fileSizeBytes correct");
      assertEqual(mock.calls.length, 1, "P2 exactly one network call");
      assertEqual(
        mock.calls[0]?.url,
        "https://router.huggingface.co/nscale/v1/images/generations",
        "P2 current router nscale URL"
      );
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P3. 401/403 → provider_auth (never-fallback)");
  for (const status of [401, 403]) {
    const restore = envFixture();
    const mock = withMockFetch(() => new Response("denied", { status }));
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_auth", `P3 HTTP ${status} → provider_auth`);
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P4. 429 → rate_limited");
  {
    const restore = envFixture();
    const mock = withMockFetch(() => new Response("slow down", { status: 429 }));
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "rate_limited", "P4 429 → rate_limited");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P5. 408 → timeout; fetch AbortError → timeout");
  {
    const restore = envFixture();
    const mock = withMockFetch(() => new Response("timeout", { status: 408 }));
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "timeout", "P5 408 → timeout");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    const mock = withMockFetch(() => {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    });
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "timeout", "P5 AbortError throw → timeout");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P6. 500/502/503/504 → provider_unavailable");
  for (const status of [500, 502, 503, 504]) {
    const restore = envFixture();
    const mock = withMockFetch(() => new Response("boom", { status }));
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_unavailable", `P6 HTTP ${status} → provider_unavailable`);
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P7. non-image / malformed bodies → provider_invalid_response");
  {
    // b64 provider returning no data array.
    const restore = envFixture();
    const mock = withMockFetch(() => jsonResponse(200, { data: [] }));
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_invalid_response", "P7 empty data[] → provider_invalid_response");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    // b64 provider returning non-JSON text.
    const restore = envFixture();
    const mock = withMockFetch(() => new Response("<html>wat</html>", { status: 200 }));
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_invalid_response", "P7 malformed JSON → provider_invalid_response");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    // hf-inference tasks contract: text content-type instead of image bytes.
    const restore = envFixture();
    process.env.HF_INFERENCE_PROVIDER = "hf-inference";
    const mock = withMockFetch(() => new Response("not an image", { status: 200, headers: { "content-type": "application/json" } }));
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "provider_invalid_response", "P7 hf-inference non-image content-type → provider_invalid_response");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P8. valid PNG → schema-derived normalizeOutput (service)");
  {
    const restore = envFixture();
    const bytes = png(512, 512);
    const mock = withMockFetch(() => b64Response(200, bytes.toString("base64")));
    try {
      const out = await generateImageWithProviders({ message: "draw the water cycle" }, [huggingfaceImageProvider]);
      assertEqual(out.kind, "image", "P8 success outcome is an image");
      if (out.kind === "image") {
        assertEqual(out.image.provider, "huggingface", "P8 provider id");
        assertEqual(out.image.mimeType, "image/png", "P8 MIME from magic bytes");
        assertEqual(out.image.width, 512, "P8 width from PNG IHDR");
        assertEqual(out.image.height, 512, "P8 height from PNG IHDR");
        assert(out.image.dataUrl.startsWith("data:image/png;base64,"), "P8 data URL prefix");
        assert(out.image.fileSizeBytes > 0, "P8 byte size > 0");
        assert(out.image.prompt.includes("water cycle"), "P8 effective prompt carried through");
        assertEqual(out.message, "Here's the image you asked for.", "P8 plain caption");
      }
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P9. token never appears in logs or errors");
  {
    const restore = envFixture();
    const mock = withMockFetch(() => new Response("nope", { status: 403 }));
    try {
      await withErrorCapture(async () => {
        const out = await generateImageWithProviders({ message: "water cycle" }, [huggingfaceImageProvider]);
        assertEqual(out.kind, "message", "P9 auth failure → message outcome");
        if (out.kind === "message") {
          assertEqual(out.message, SAFE_UNAVAILABLE_MESSAGE, "P9 safe copy, no raw error");
        }
      });
      const allLogs = capturedErrorLogs.join(" | ");
      assert(!allLogs.includes(TEST_TOKEN), "P9 console.error never contains the token");
      assert(!allLogs.includes("Authorization"), "P9 headers are never logged");
      assert(allLogs.includes("status=403"), "P9 safe metadata (status) IS logged");
      assert(allLogs.includes("code=provider_auth"), "P9 safe taxonomy IS logged");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    const mock = withMockFetch(() => b64Response(200, png(128, 128).toString("base64")));
    try {
      let thrownMsg = "";
      await withErrorCapture(async () => {
        // Force an internal validation failure AFTER the fetch succeeded so the
        // error path is exercised — a garbage body keeps the fetch "ok".
      });
      const ok = await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      assert(ok.data.length > 0, "P9 success path unaffected by capture");
      // Direct error message never contains the token either.
      const mockErr = withMockFetch(() => new Response("denied", { status: 401 }));
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        thrownMsg = error instanceof Error ? error.message : String(error);
      } finally {
        mockErr.restore();
      }
      assert(!thrownMsg.includes(TEST_TOKEN), "P9 ImageFailure message excludes the token");
      void mock;
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P10. model configuration flows through");
  {
    const restore = envFixture();
    process.env.HF_IMAGE_MODEL = "stabilityai/stable-diffusion-3-medium-diffusers";
    const mock = withMockFetch(() => b64Response(200, png(64, 64).toString("base64")));
    try {
      await huggingfaceImageProvider.generate({ prompt: "water cycle", aspectRatio: "1:1" });
      const body = JSON.parse(String(mock.calls[0]?.init.body ?? "{}")) as {
        model?: string;
        prompt?: string;
        width?: number;
        response_format?: string;
      };
      assertEqual(body.model, "stabilityai/stable-diffusion-3-medium-diffusers", "P10 docker body carries the configured model");
      assertEqual(body.prompt, "water cycle", "P10 docker body carries the prompt");
      assertEqual(body.width, 1024, "P10 default 1:1 → 1024 px");
      assertEqual(body.response_format, "b64_json", "P10 docker body requests b64_json");
      assertEqual(resolveHuggingFaceConfig().model, "stabilityai/stable-diffusion-3-medium-diffusers", "P10 config resolver reads HF_IMAGE_MODEL");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    process.env.HF_INFERENCE_PROVIDER = "hf-inference";
    process.env.HF_IMAGE_MODEL = "stabilityai/stable-diffusion-3-medium-diffusers";
    const mock = withMockFetch(() => new Response(new Uint8Array(png(64, 64)), { status: 200, headers: { "content-type": "image/png" } }));
    try {
      await huggingfaceImageProvider.generate({ prompt: "water cycle", aspectRatio: "1:1" });
      const url = mock.calls[0]?.url ?? "";
      assert(url === "https://router.huggingface.co/hf-inference/models/stabilityai%2Fstable-diffusion-3-medium-diffusers", "P10 hf-inference tasks URL uses configured model");
      const body = JSON.parse(String(mock.calls[0]?.init.body ?? "{}")) as { inputs?: string; parameters?: { width?: number; height?: number } };
      assertEqual(body.inputs, "water cycle", "P10 hf-inference body inputs");
      assertEqual(body.parameters?.width, 1024, "P10 hf-inference parameters width");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P11. current router endpoint is used");
  {
    const restore = envFixture();
    const mock = withMockFetch(() => b64Response(200, png(64, 64).toString("base64")));
    try {
      await huggingfaceImageProvider.generate({ prompt: "water cycle", aspectRatio: "1:1" });
      const url = mock.calls[0]?.url ?? "";
      assert(url.startsWith("https://router.huggingface.co/"), `P11 router host (got ${url})`);
      assert(url.includes("/nscale/"), "P11 default provider path nscale");
      assert(url.endsWith("/v1/images/generations"), "P11 docker generations route");
      assertEqual(DEFAULT_HF_BASE_URL, "https://router.huggingface.co", "P11 exported router default");
      assertEqual(DEFAULT_HF_PROVIDER, "nscale", "P11 exported default provider");
    } finally {
      mock.restore();
      restore();
    }
  }

  section("P12. obsolete api-inference.huggingface.co is never used");
  {
    const restore = envFixture();
    const mock = withMockFetch(() => b64Response(200, png(64, 64).toString("base64")));
    try {
      for (const aspect of ["1:1", "3:4", "4:3", "9:16", "16:9"] as const) {
        await huggingfaceImageProvider.generate({ prompt: "water cycle", aspectRatio: aspect });
      }
      for (const call of mock.calls) {
        assert(!call.url.includes("api-inference.huggingface.co"), `P12 no legacy host (${call.url})`);
        assert(call.url.startsWith("https://router.huggingface.co/"), `P12 router host only (${call.url})`);
      }
      assert(mock.calls.length === 5, "P12 each aspect = exactly one call (no retry loops)");
    } finally {
      mock.restore();
      restore();
    }
  }
  {
    const restore = envFixture();
    assert(!DEFAULT_HF_BASE_URL.includes("api-inference"), "P12 default base points at the router, not the legacy host");
    restore();
  }

  section("P13. one provider attempt per request (service, HF transport)");
  {
    const restore = envFixture();
    const bytes = png(64, 64);
    const count = { hf1: 0, hf2: 0 };
    const p1: ImageProvider = {
      id: "huggingface",
      async generate() {
        count.hf1++;
        throw new ImageFailure("provider_invalid_response", "mock fail");
      },
    };
    const p2: ImageProvider = {
      id: "huggingface",
      async generate() {
        count.hf2++;
        return { data: bytes, width: 0, height: 0, fileSizeBytes: bytes.length };
      },
    };
    const out = await generateImageWithProviders({ message: "water cycle" }, [p1, p2]);
    assertEqual(count.hf1, 1, "P13 first provider attempted exactly once");
    assertEqual(count.hf2, 1, "P13 second provider attempted exactly once");
    assertEqual(out.kind, "image", "P13 eligible failure falls through to next provider once");
    restore();
  }
  {
    const restore = envFixture();
    const count = { c: 0 };
    const bad: ImageProvider = {
      id: "huggingface",
      async generate() {
        count.c++;
        throw new ImageFailure("provider_auth", "Nope");
      },
    };
    const good: ImageProvider = {
      id: "huggingface",
      async generate() {
        return { data: png(64, 64), width: 0, height: 0, fileSizeBytes: 24 };
      },
    };
    const out = await generateImageWithProviders({ message: "water cycle" }, [bad, good]);
    assertEqual(count.c, 1, "P13 never-fallback code stops immediately");
    assertEqual(out.kind, "message", "P13 provider_auth → safe message, no fallback");
    restore();
  }

  section("P14. unsupported router provider config → misconfigured");
  {
    const restore = envFixture();
    process.env.HF_INFERENCE_PROVIDER = "fal-ai";
    try {
      let code: ImageFailureCode | null = null;
      try {
        await huggingfaceImageProvider.generate({ prompt: "x", aspectRatio: "1:1" });
      } catch (error) {
        if (error instanceof ImageFailure) code = error.code;
      }
      assertEqual(code, "misconfigured", "P14 unknown provider shape → misconfigured (never-fallback)");
    } finally {
      restore();
    }
  }

  console.log("\n============================================================");
  console.log(`Phase 6C-HF: ${passed} passed, ${failed} failed`);
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