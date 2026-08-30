// ---------------------------------------------------------------------------
// Phase 6D-HF — LIVE probe of the Hugging Face image-EDIT fallback
//
// 1) Generates a real source image through the production provider order
//    (gemini → HF fallback).
// 2) Dials IMAGE_PROVIDERS=huggingface (HF pinned) and runs a genuine
//    image-to-image edit on the real source bytes: "Make the sky sunset."
// 3) Verifies server-side contract: provider=huggingface, model, dims,
//    bytes-differ, mode/editSourceKey stamps, data-URL prefix.
// 4) Attempts one CHAINED edit from the edited output ("now add a red bird")
//    to prove successive edits stay on real HF output.
// 5) Reports the real quota/billing result HONESTLY — a paid-credit refusal
//    (401/402) or timeout is reported as blocked, never faked as success.
//
// SAFE OUTPUT ONLY: provider, model, mime, dims, byte size, elapsed ms,
// success/taxonomy, bytes-differ booleans. Never printed: keys, base64 data,
// raw error bodies.
// ---------------------------------------------------------------------------

import { generateImage, editImage } from "./src/lib/image-generation";
import { resolveHuggingFaceConfig, HAS_HF_IMAGE_EDIT } from "./src/lib/image-generation/huggingface-provider";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { ImageOutcome } from "./src/lib/image-generation";

const PROBE_TIMEOUT_MS = 75_000;

function loadEnv(tokenVar: string): string {
  const raw = readFileSync(".env.local", "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${tokenVar}=`));
  return line ? line.slice(tokenVar.length + 1).trim() : "";
}

async function main(): Promise<void> {
  process.env.HF_TOKEN = loadEnv("HF_TOKEN");
  process.env.GEMINI_API_KEY = loadEnv("GEMINI_API_KEY");
  console.log(`[probe] HF_TOKEN present=${Boolean(process.env.HF_TOKEN)} GEMINI_API_KEY present=${Boolean(process.env.GEMINI_API_KEY)} (values never printed)`);

  const cfg = resolveHuggingFaceConfig();
  console.log("[probe] HF config: baseUrl=", cfg.baseUrl, "editProvider=", cfg.editProvider, "editModel=", cfg.editModel);
  console.log("[probe] HAS_HF_IMAGE_EDIT =", HAS_HF_IMAGE_EDIT);

  // ---- (1) source image through the production order --------------------
  let source: ImageOutcome;
  try {
    const t = performance.now();
    source = await generateImage({ message: "Generate an image of a mountain at sunrise", mode: "general" });
    console.log(`[probe] source kind=${source.kind} elapsed=${Math.round(performance.now() - t)}ms`);
  } catch (e) {
    console.log("[probe] RESULT: source generation threw", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  if (source.kind !== "image") {
    console.log(`[probe] RESULT: no source image (message="${source.message}") — cannot live-verify an edit without a source.`);
    process.exit(1);
  }
  const sourceBytes = Buffer.from(source.image.dataUrl.split(",")[1], "base64");
  console.log("[probe] source provider:", source.image.provider, "mime:", source.image.mimeType, "size:", source.image.fileSizeBytes);

  // ---- (2) HUGGING FACE real edit on real source -------------------------
  console.log("\n[probe] ---- (2) HF real edit: \"Make the sky sunset.\" ----");
  process.env.IMAGE_PROVIDERS = "huggingface"; // HF pinned — no Gemini
  const tEdit = performance.now();
  let out: ImageOutcome;
  try {
    out = await editImage({
      message: "Make the sky sunset.",
      mode: "general",
      sourceImage: { bytes: sourceBytes, mimeType: source.image.mimeType },
      sourceKey: "hf-probe-source",
      kind: "edit",
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    console.log("[probe] RESULT hf-edit-live=threw", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const elapsed = Math.round(performance.now() - tEdit);

  if (out.kind !== "image") {
    console.log(`[probe] RESULT hf-edit-live=blocked-kind=${out.kind} elapsed=${elapsed}ms`);
    console.log(`[probe] summary: "${out.message}"`);
    console.log("[probe] This is an HONEST external-side failure (quota/billing/enabled-models) — reported, not faked.");
    process.exit(3);
  }

  const im = out.image;
  const editedBytes = Buffer.from(im.dataUrl.split(",")[1], "base64");
  const differs = !editedBytes.equals(sourceBytes);
  console.log("[probe] edited provider:", im.provider, "mime:", im.mimeType, "size:", im.fileSizeBytes);
  console.log("[probe] dims:", im.width, "x", im.height, "mode:", im.mode, "editSourceKey:", im.editSourceKey);
  console.log("[probe] bytes differ from source:", differs);
  console.log("[probe] dataUrlPrefix:", im.dataUrl.slice(0, 40) + "…");

  const valid =
    im.provider === "huggingface" &&
    im.mode === "edit" &&
    im.editSourceKey === "hf-probe-source" &&
    im.mimeType.startsWith("image/") &&
    im.width > 0 &&
    im.height > 0 &&
    im.fileSizeBytes > 0 &&
    im.dataUrl.startsWith(`data:${im.mimeType};base64,`) &&
    differs;

  if (!valid) {
    resultSummary("hf-edit-live", "invalid-payload", elapsed);
    process.exit(2);
  }
  resultSummary("hf-edit-live", "live-ok", elapsed);

  // ---- (3) CHAINED edit from the HF output -------------------------------
  console.log("\n[probe] ---- (3) chained edit from HF output: \"now add a red bird on the ridge\" ----");
  process.env.IMAGE_PROVIDERS = "huggingface";
  const tChain = performance.now();
  let chained: ImageOutcome;
  try {
    chained = await editImage({
      message: "now add a red bird on the ridge",
      mode: "general",
      sourceImage: { bytes: editedBytes, mimeType: im.mimeType },
      sourceKey: "hf-probe-chain",
      kind: "edit",
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    console.log("[probe] chained edit threw", e instanceof Error ? e.message : String(e));
    resultSummary("hf-edit-chain", "threw", Math.round(performance.now() - tChain));
    process.exit(1);
  }
  const chainElapsed = Math.round(performance.now() - tChain);
  if (chained.kind !== "image") {
    console.log(`[probe] RESULT hf-edit-chain=blocked-kind=${chained.kind} message="${chained.message}"`);
    resultSummary("hf-edit-chain", "blocked", chainElapsed);
  } else {
    const chainBytes = Buffer.from(chained.image.dataUrl.split(",")[1], "base64");
    const chainDiffers = !chainBytes.equals(editedBytes);
    const chainedOk =
      chained.image.provider === "huggingface" &&
      chained.image.mode === "edit" &&
      chained.image.editSourceKey === "hf-probe-chain" &&
      chained.image.width > 0 &&
      chained.image.height > 0 &&
      chainDiffers;
    console.log("[probe] chained provider:", chained.image.provider, "size:", chained.image.fileSizeBytes, "dims:", chained.image.width, "x", chained.image.height, "differs-from-prev:", chainDiffers);
    resultSummary("hf-edit-chain", chainedOk ? "live-ok" : "invalid-payload", chainElapsed);
  }

  console.log("\n[probe] first-leg result is the gate: hf-edit-live=live-ok");
  process.exit(valid ? 0 : 2);
}

function resultSummary(probe: string, status: string, ms: number): void {
  console.log(`[probe] RESULT ${probe}=${status} elapsed=${ms}ms`);
}

main().catch((e) => {
  console.log("[probe] error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});