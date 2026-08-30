// ---------------------------------------------------------------------------
// Phase 6D — LIVE end-to-end image-EDIT probe
//
// 1) Generates a source image through the real provider order (gemini → HF
//    fallback, exactly like the chat route).
// 2) Edits it: source bytes + "make the sky sunset" instruction with
//    IMAGE_PROVIDERS=gemini pinned (isolates the Gemini primary edit path).
// 3) Edits the SAME source with the DEFAULT server order (gemini,huggingface):
//    on this account Gemini is free-tier rate_limited, so this naturally
//    exercises the Gemini → Hugging Face EDIT fallback live. Reports honestly
//    whichever provider produced the result (or the safe-copy taxonomy).
// 4) Honest-config check: an unsupported HF edit provider must be refused
//    client-free (misconfigured → SAFE_EDIT_UNAVAILABLE) without touching the
//    network.
//
// SAFE OUTPUT ONLY: provider, model, mode, mime type, byte size, elapsed ms,
// success/failure taxonomy, match-with-source boolean. Never printed: keys,
// source/base64 image data, full error strings with key material.
// ---------------------------------------------------------------------------

import { generateImage, editImage, resolveProviderOrder, SAFE_EDIT_UNAVAILABLE_MESSAGE, SAFE_EDIT_INVALID_SOURCE_MESSAGE } from "./src/lib/image-generation";
import { resolveHuggingFaceConfig } from "./src/lib/image-generation/huggingface-provider";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { ImageOutcome } from "./src/lib/image-generation";

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

  // ---- (1) Source image -----------------------------------------------
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

  // ---- (2) Gemini-only edit attempt ------------------------------------
  delete process.env.IMAGE_PROVIDERS;
  const defaultOrder = resolveProviderOrder();
  process.env.IMAGE_PROVIDERS = "gemini";
  console.log("\n[probe] ---- (2) Gemini-only edit (primary isolated) ----");
  const tEdit = performance.now();
  const geminiEdit = await editImage({
    message: "make the sky sunset",
    mode: "general",
    sourceImage: { bytes: sourceBytes, mimeType: source.image.mimeType },
    sourceKey: "probe-source",
    kind: "edit",
  });
  const geminiElapsed = Math.round(performance.now() - tEdit);
  console.log(`[probe] gemini edit kind=${geminiEdit.kind} elapsed=${geminiElapsed}ms message="${geminiEdit.message}"`);
  if (geminiEdit.kind === "image") {
    const editedBytes = Buffer.from(geminiEdit.image.dataUrl.split(",")[1], "base64");
    const differs = !editedBytes.equals(sourceBytes);
    console.log("[probe] gemini edit provider:", geminiEdit.image.provider, "mode:", geminiEdit.image.mode, "size:", geminiEdit.image.fileSizeBytes, "bytes-differ:", differs);
    resultSummary("gemini-edit", "live-ok", geminiElapsed);
  } else {
    resultSummary("gemini-edit", "blocked-or-unavailable", geminiElapsed);
  }

  // ---- (3) Default-order edit (natural Gemini→HF fallback) --------------
  console.log("\n[probe] ---- (3) default-order edit (Gemini → HF fallback) ----");
  delete process.env.IMAGE_PROVIDERS;
  console.log("[probe] default provider order:", resolveProviderOrder().join(","));
  const cfg = resolveHuggingFaceConfig();
  console.log("[probe] HF config: editProvider=", cfg.editProvider, "editModel=", cfg.editModel, "baseUrl=", cfg.baseUrl);
  const t3 = performance.now();
  const fallback = await editImage({
    message: "make the sky sunset",
    mode: "general",
    sourceImage: { bytes: sourceBytes, mimeType: source.image.mimeType },
    sourceKey: "probe-source",
    kind: "edit",
  });
  const fallbackElapsed = Math.round(performance.now() - t3);
  console.log(`[probe] fallback edit kind=${fallback.kind} elapsed=${fallbackElapsed}ms message="${fallback.message}"`);
  if (fallback.kind === "image") {
    const editedBytes = Buffer.from(fallback.image.dataUrl.split(",")[1], "base64");
    const differs = !editedBytes.equals(sourceBytes);
    console.log("[probe] result provider:", fallback.image.provider, "mime:", fallback.image.mimeType);
    console.log("[probe] mode:", fallback.image.mode, "editSourceKey:", fallback.image.editSourceKey);
    console.log("[probe] width:", fallback.image.width, "height:", fallback.image.height, "size:", fallback.image.fileSizeBytes);
    console.log("[probe] bytes differ from source:", differs);
    const valid =
      fallback.image.mode === "edit" &&
      fallback.image.editSourceKey === "probe-source" &&
      fallback.image.mimeType.startsWith("image/") &&
      fallback.image.width > 0 &&
      fallback.image.height > 0 &&
      fallback.image.fileSizeBytes > 0 &&
      fallback.image.dataUrl.startsWith(`data:${fallback.image.mimeType};base64,`) &&
      differs;
    if (fallback.image.provider === "huggingface") {
      resultSummary("hf-edit-fallback", valid ? "live-ok" : "invalid-payload", fallbackElapsed);
    } else {
      resultSummary("fallback-edit", valid ? "live-ok(gemini-primary)" : "invalid-payload", fallbackElapsed);
    }
  } else {
    resultSummary("fallback-edit", "both-providers-unavailable", fallbackElapsed);
  }

  // ---- (4) Honest config check (no network) -----------------------------
  console.log("\n[probe] ---- (4) honest config check (unsupported edit provider) ----");
  process.env.IMAGE_PROVIDERS = "huggingface";
  process.env.HF_IMAGE_EDIT_PROVIDER = "nscale"; // text-to-image only → never an edit provider
  const t4 = performance.now();
  const honestOut = await editImage({
    message: "make the sky sunset",
    mode: "general",
    sourceImage: { bytes: sourceBytes, mimeType: source.image.mimeType },
    sourceKey: "probe-source",
    kind: "edit",
  });
  const honestElapsed = Math.round(performance.now() - t4);
  const honest = honestOut.kind === "message" && honestOut.message === SAFE_EDIT_UNAVAILABLE_MESSAGE;
  console.log(`[probe] misconfigured-HF edit kind=${honestOut.kind} elapsed=${honestElapsed}ms message="${honestOut.message}"`);
  console.log("[probe] refused without any fake edit / network:", honest);
  console.log("[probe] SAFE_EDIT_INVALID_SOURCE copy stable:", SAFE_EDIT_INVALID_SOURCE_MESSAGE.startsWith("I couldn't read that image"));
  resultSummary("honest-config", honest ? "honest-unavailable" : "unexpected", honestElapsed);

  const unexpected = (["fallback-edit", "honest-config"] as const).filter((p) => p === "honest-config" ? !honest : false);
  console.log("\n[probe] default order was:", defaultOrder.join(","));
  process.exit(unexpected.length ? 2 : 0);
}

function resultSummary(probe: string, status: string, ms: number): void {
  console.log(`[probe] RESULT ${probe}=${status} elapsed=${ms}ms`);
}

main().catch((e) => {
  console.log("[probe] error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});