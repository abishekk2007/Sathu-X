// Phase 6C — LIVE test harness for the real Gemini image provider.
// Run with the key piped via env (npx tsx does NOT load .env.local):
//   $env:GEMINI_API_KEY = (Get-Content .env.local | Select-String '^GEMINI_API_KEY=').ToString().Split('=',2)[1]
//   npx tsx _probe-phase6c-live.ts
// Tries each candidate image model in turn. IMAGE_PROVIDERS is pinned to "gemini"
// so the live Hugging Face fallback does NOT mask the Gemini quota check — this
// probe measures the primary provider only. A decline can only mean quota exhaustion.

import { generateImage } from "./src/lib/image-generation";

async function main() {
  process.env.IMAGE_PROVIDERS = "gemini";
  const candidates = [
    process.env.GEMINI_IMAGE_MODEL,
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-image-preview",
    "gemini-3.1-flash-lite-image",
    "gemini-3-pro-image",
    "gemini-3-pro-image-preview",
    "gemini-2.5-flash-image",
  ].filter((x): x is string => Boolean(x));
  const unique = [...new Set(candidates)];

  for (const model of unique) {
    process.env.GEMINI_IMAGE_MODEL = model;
    const startedAt = performance.now();
    const outcome = await generateImage({
      message: "a cheerful red dragon flying over a castle at sunrise, simplistic",
      mode: "general",
    });
    const elapsed = Math.round(performance.now() - startedAt);
    console.log(`[live] ${model}: ${outcome.kind} in ${elapsed}ms — ${outcome.message}`);

    if (outcome.kind === "image") {
      const img = outcome.image;
      const provider = img.provider;
      console.log(`[live] provider=${provider}`);
      if (provider !== "gemini") {
        console.error("[live] RESULT: unexpected non-gemini provider — IMAGE_PROVIDERS pin failed");
        process.exit(1);
      }
      console.log(`[live] mimeType=${img.mimeType}`);
      console.log(`[live] fileSizeBytes=${img.fileSizeBytes}`);
      console.log(`[live] width=${img.width} height=${img.height}`);
      console.log(`[live] dataUrlPrefix=${img.dataUrl.slice(0, 60)}…`);
      console.log(`[live] prompt="${img.prompt}"`);
      if (img.dataUrl.startsWith("data:image/") && img.fileSizeBytes > 100) {
        console.log("[live] RESULT: LIVE GEMINI IMAGE GENERATION OK");
        process.exit(0);
      }
      console.error("[live] RESULT: image payload looks invalid");
      process.exit(1);
    }
  }

  console.error("[live] RESULT: no candidate model generated an image on this key (Gemini quota exhausted or key lacks image access)");
  process.exit(1);
}

main();