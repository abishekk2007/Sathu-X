// ---------------------------------------------------------------------------
// Phase 5G — RAG Evaluation + Reliability test suite
// Run with: npx tsx test-phase5g.ts
//
// Purpose:
//   Verify Spidey Bot's EXISTING RAG system reliably retrieves the correct
//   evidence from ANY arbitrary document type at ANY location, without
//   hallucinating. This is an OBSERVATIONAL evaluation of the production
//   retrieval functions — it does not modify production code.
//
// Categories covered (Steps A–T):
//   semantic, topic, page, section, unit, part, exact_question,
//   arbitrary_location, cross_chunk, long_document, negative,
//   structural_negative, similar_content, multi_document,
//   multi_document_negative, visual, text_visual_fusion, source_attribution,
//   follow_up, general_chat, structural_path, hallucination, query_analysis
// ---------------------------------------------------------------------------

import { buildFullDataset } from "./src/lib/evaluation/dataset";
import { runEvaluationSuite } from "./src/lib/evaluation/regression-suite";
import { verifyAttribution } from "./src/lib/evaluation/source-evaluator";
import {
  evaluateRetrieval,
  evaluateMultiDoc,
} from "./src/lib/evaluation/retrieval-evaluator";
import { detectVisualIntent } from "./src/lib/agent/visual-intent";
import { buildGeminiImageParts, loadVisualEvidence } from "./src/lib/agent/visual-evidence";
import type { EvaluationReport } from "./src/lib/evaluation/evaluation-types";

const nanos = process.hrtime.bigint();

function report(rep: EvaluationReport) {
  const { metricsByCategory, overall, cases } = rep;

  console.log("\n================================================================");
  console.log("PHASE 5G — RAG EVALUATION + RELIABILITY REPORT");
  console.log("================================================================");

  console.log("\n### Overall");
  console.log(`Total cases: ${overall.total}`);
  console.log(`Passed:      ${overall.passed}`);
  console.log(`Failed:      ${overall.failed}`);
  console.log(`Unmeasurable:${overall.unmeasurable}`);
  console.log(`Precision@1: ${fmt(overall.precisionAt1)}`);
  console.log(`Precision@3: ${fmt(overall.precisionAt3)}`);
  console.log(`Recall@K:    ${fmt(overall.recallAtK)}`);
  console.log(`Hit Rate:    ${fmt(overall.hitRate)}`);
  console.log(`MRR:         ${fmt(overall.mrr)}`);
  console.log(`Structural:  ${fmt(overall.structuralAccuracy)}`);
  console.log(`Page Acc:    ${fmt(overall.pageAccuracy)}`);
  console.log(`Negative Acc:${fmt(overall.negativeAccuracy)}`);
  console.log(`Visual Acc:  ${fmt(overall.visualAccuracy)}`);

  console.log("\n### Per-category metrics");
  console.log("Category            | Tot | Pass | Fail | P@1    | Recall | MRR    | Neg | Struct | Page");
  console.log("--------------------|-----|------|------|--------|--------|--------|-----|--------|-----");
  for (const m of metricsByCategory) {
    console.log(
      `${m.category.padEnd(19) }| ${String(m.total).padStart(3)} | ${String(m.passed).padStart(4)} | ${String(m.failed).padStart(4)} | ${fmt(m.precisionAt1)} | ${fmt(m.recallAtK)} | ${fmt(m.mrr)} | ${fmt(m.negativeAccuracy)} | ${fmt(m.structuralAccuracy)} | ${fmt(m.pageAccuracy)}`
    );
  }

  console.log("\n### Total assertions (test results incl. sub-checks)");
  const subChecks = countSubChecks(cases);
  console.log(`Total result rows: ${cases.length}`);
  console.log(`Including sub-assertions from structural/query-analysis: ${subChecks}`);

  if (overall.failed > 0) {
    console.log("\n### FAILED TESTS (classified)");
    console.log("Test | Category | Expected | Observed | Classification | Stage");
    console.log("---- | ---------|----------|----------|----------------|------");
    for (const c of cases) {
      if (c.status === "fail") {
        console.log(
          `${c.id} | ${c.category} | relevant=${c.relevant} missing=${c.missingEvidence.join(";")} | structural=${c.structuralMatch} | ${c.classification ?? "?"} | ${c.pipelineStage ?? "?"}`
        );
      }
    }
  } else {
    console.log("\n### No failed tests.");
  }
}

function fmt(v: number | null): string {
  return v === null ? "UNM" : (v * 100).toFixed(0) + "%";
}

function countSubChecks(cases: Array<{ id: string }>): number {
  // Structural path cases and query-analysis cases are counted as assertions.
  return cases.filter((c) => c.id.startsWith("path-") || c.id.startsWith("qa-")).length;
}

// ---------------------------------------------------------------------------
// Extra observational checks (visual intent, attribution, no-regression guard)
// ---------------------------------------------------------------------------

function runAuxiliaryChecks(rep: EvaluationReport) {
  console.log("\n### Auxiliary observational checks");

  const vis1 = detectVisualIntent("What does the chart show?");
  const vis2 = detectVisualIntent("Explain Figure 2");
  const vis3 = detectVisualIntent("Summarize page 5");
  console.log(`detectVisualIntent('the chart') = ${vis1.type} (refs=${vis1.references.map(r=>r.kind).join(",")})`);
  console.log(`detectVisualIntent('Figure 2')   = ${vis2.type} (refs=${vis2.references.map(r=>r.kind + ":" + r.number).join(",")})`);
  console.log(`detectVisualIntent('page 5')     = ${vis3.type} (refs=${vis3.references.map(r=>r.kind).join(",")})`);

  const ds = buildFullDataset();
  const attribution = verifyAttribution(ds.docs);
  console.log(`Attribution preserved: docs=${attribution.documentPreserved} pages=${attribution.pagePreserved} structural=${attribution.structuralPreserved} sources=${attribution.sourceCount}`);

  // Gemini image parts builder (pure) - no network
  const parts = buildGeminiImageParts([
    { sourceId: "s", sourceName: "doc", storagePath: "p", mimeType: "image/png", pageNumber: 2, assetType: "figure", width: 100, height: 200, base64Data: "AA==" },
  ]);
  console.log(`buildGeminiImageParts produced ${parts.length} parts; first is ${parts[0] && "text" in parts[0] ? "label text" : "?"}`);

  // loadVisualEvidence requires Supabase - should not be callable here; verify export only.
  console.log(`loadVisualEvidence exported: ${typeof loadVisualEvidence === "function"}`);

  return attribution;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const ds = buildFullDataset();
  console.log(`Built dataset: ${ds.docs.length} documents, ${ds.cases.length} cases.`);

  const rep = runEvaluationSuite(ds.docs, ds.cases, { recallDepth: 8 });

  const start = process.hrtime.bigint();
  // Warm-up + measure a representative retrieval to detect perf regression
  const warm = evaluateRetrieval(ds.docs[0], "What is normalization?");
  const end = process.hrtime.bigint();
  const elapsedMs = Number(end - start) / 1e6;

  report(rep);
  const attribution = runAuxiliaryChecks(rep);

  console.log("\n### Performance")
  console.log(`Representative single retrieval (incl warm-up): ${elapsedMs.toFixed(2)}ms, returned ${warm.chunks.length} chunks`);

  console.log("\n### Conclusion");
  if (rep.overall.failed === 0) {
    console.log("RETRIEVAL RELIABILITY: ALL EVALUATION CASES PASSED");
  } else {
    console.log(`RETRIEVAL RELIABILITY: ${rep.overall.failed} case(s) FAILED — see classifications above.`);
  }
  console.log(`Attribution check: ${attribution.documentPreserved ? "OK" : "FAILED"}`);

  // Final non-zero exit if any fail
  if (rep.overall.failed > 0) {
    process.exitCode = 1;
  }
}

main();
void nanos;
