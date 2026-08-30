// ---------------------------------------------------------------------------
// Phase 6C — LIVE end-to-end image-generation probe (Gemini PRIMARY → HF FALLBACK)
//
// Mirrors exactly what the chat route does for "Generate an image ...":
//   generateImage({ message, mode })
//     → resolveProviderOrder()  =>  [gemini, huggingface]
//     → Gemini primary (may fail rate_limited on the free tier)
//     → Hugging Face fallback via the CURRENT Inference Providers router
//     → normalizeOutput (validateImage)  =>  data URL image_message payload
//
// SAFE OUTPUT ONLY: provider, model, status, mime type, byte size, elapsed ms,
// success/failure taxonomy. The token is never printed. No secrets are written
// to disk.
// ---------------------------------------------------------------------------

import { generateImage } from "./src/lib/image-generation";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

function loadEnv(tokenVar: string): string {
  const raw = readFileSync(".env.local", "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${tokenVar}=`));
  return line ? line.slice(tokenVar.length + 1).trim() : "";
}

async function main(): Promise<void> {
  const geminiKey = loadEnv("GEMINI_API_KEY");
  const hfToken = loadEnv("HF_TOKEN");
  if (hfToken) process.env.HF_TOKEN = hfToken;
  if (geminiKey) process.env.GEMINI_API_KEY = geminiKey;

  console.log(`[probe] GEMINI_API_KEY present=${Boolean(geminiKey)} HF_TOKEN present=${Boolean(hfToken)} (values never printed)`);
  if (!hfToken) {
    console.log("[probe] RESULT: HF_TOKEN missing — no fallback possible; ABORT");
    process.exit(1);
  }

  const started = performance.now();
  const outcome = await generateImage({
    message:
      "Generate an image of the water cycle",
    mode: "general",
  });
  const elapsed = Math.round(performance.now() - started);

  console.log(`[probe] kind=${outcome.kind} elapsed=${elapsed}ms message="${outcome.message}"`);
  if (outcome.kind !== "image") {
    console.log("[probe] RESULT: FAILED — no image produced. Taxonomy above; see server logs (safe).");
    process.exit(1);
  }

  const img = outcome.image;
  console.log("[probe] provider:", img.provider);
  console.log("[probe] mimeType:", img.mimeType);
  console.log("[probe] width:", img.width, "height:", img.height);
  console.log("[probe] fileSizeBytes:", img.fileSizeBytes);
  console.log("[probe] dataUrlPrefix:", img.dataUrl.slice(0, 40) + "…");
  console.log("[probe] model (from HF_IMAGE_MODEL):", process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell (default)");

  const valid =
    img.provider === "huggingface" &&
    img.mimeType.startsWith("image/") &&
    img.fileSizeBytes > 0 &&
    img.dataUrl.startsWith(`data:${img.mimeType};base64,`);

  console.log(valid ? "[probe] RESULT: LIVE HF FALLBACK OK" : "[probe] RESULT: image payload invalid");
  process.exit(valid ? 0 : 1);
}

main().catch((e) => {
  console.log("[probe] error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});