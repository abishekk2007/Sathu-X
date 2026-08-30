// ---------------------------------------------------------------------------
// Phase 6E — LIVE end-to-end document-visual probe
//
// Drives the REAL server code path (provider order gemini → huggingface, same
// as the chat route) for the DOCUMENT_VISUAL_GENERATION route. Uses a tiny
// deterministic retrieval fixture so the evidence is real but the run is
// self-contained. Reports honestly whichever provider produced the result, or
// the safe-copy taxonomy when the quota/credits are exhausted — NEVER fabricates
// a success.
//
// SAFE OUTPUT ONLY: provider, model/mode, mime type, byte size, visual type,
// grounded flag, elapsed ms, success/failure taxonomy. Never printed: keys,
// image data, raw evidence, or the composed provider prompt.
// ---------------------------------------------------------------------------

import { generateDocumentVisual, SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE } from "./src/lib/image-generation";
import { resolveProviderOrder } from "./src/lib/image-generation";
import type { DocumentVisualEvidenceItem } from "./src/lib/image-generation";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

function loadEnv(tokenVar: string): string {
  const raw = readFileSync(".env.local", "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${tokenVar}=`));
  return line ? line.slice(tokenVar.length + 1).trim() : "";
}

const EVIDENCE: DocumentVisualEvidenceItem[] = [
  {
    sourceName: "probe-annual.pdf",
    page: 2,
    text: "Revenue grew 40% in 2024 to $520 million. Costs stayed flat at $120 million during the same year.",
  },
];

async function main(): Promise<void> {
  const geminiKey = loadEnv("GEMINI_API_KEY");
  const hfToken = loadEnv("HF_TOKEN");
  if (hfToken) process.env.HF_TOKEN = hfToken;
  if (geminiKey) process.env.GEMINI_API_KEY = geminiKey;

  console.log(`[probe] GEMINI_API_KEY present=${Boolean(geminiKey)} HF_TOKEN present=${Boolean(hfToken)} (values never printed)`);
  delete process.env.IMAGE_PROVIDERS;
  console.log("[probe] provider order:", resolveProviderOrder().join(","));

  // ---- (1) Grounded infographic ------------------------------------------
  console.log("\n[probe] ---- (1) chart visual from numeric doc evidence ----");
  const t1 = performance.now();
  const out1 = await generateDocumentVisual({
    message: "Create a chart from my annual report",
    evidence: EVIDENCE,
    requestedVisualType: "chart",
  });
  const ms1 = Math.round(performance.now() - t1);
  console.log(`[probe] out1 kind=${out1.kind} elapsed=${ms1}ms message="${out1.message}"`);
  if (out1.kind === "image") {
    console.log("[probe] provider:", out1.image.provider, "mime:", out1.image.mimeType, "size:", out1.image.fileSizeBytes);
    console.log("[probe] width:", out1.image.width, "height:", out1.image.height, "visualType:", out1.image.visualType, "sourceGrounded:", out1.image.sourceGrounded);
    const ok = out1.image.visualType === "chart" && out1.image.sourceGrounded === true && out1.image.mimeType.startsWith("image/");
    resultSummary("grounded-chart", ok ? "live-ok" : "invalid-payload", ms1);
  } else {
    resultSummary("grounded-chart", out1.message === SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE ? "guard-blocked" : "provider-unavailable", ms1);
  }

  // ---- (2) Refinement claim guard (no network, server-side refuse) --------
  console.log("\n[probe] ---- (2) refinement claiming an unsupported fact ----");
  const t2 = performance.now();
  const out2 = await generateDocumentVisual({
    message: "mention that revenue hit $999 trillion",
    refinementOf: "Create a chart from my annual report",
    evidence: EVIDENCE,
    requestedVisualType: "chart",
  });
  const ms2 = Math.round(performance.now() - t2);
  const guarded = out2.kind === "message" && out2.message === SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE;
  console.log(`[probe] out2 kind=${out2.kind} elapsed=${ms2}ms (guarded=${guarded})`);
  resultSummary("refinement-guard", guarded ? "refused-honestly" : "unexpected", ms2);

  console.log("\n[probe] done.");
  process.exit(0);
}

function resultSummary(probe: string, status: string, ms: number): void {
  console.log(`[probe] RESULT ${probe}=${status} elapsed=${ms}ms`);
}

main().catch((e) => {
  console.log("[probe] error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});