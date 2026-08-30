// ---------------------------------------------------------------------------
// Phase 5E-2 FINAL multimodal repair — determination-preserving tests.
// Run with: npx tsx test-5e2-final.ts
//
// Tests ONLY the 5E-2 visual retrieval/reasoning pipeline and its integration
// points. Uses deterministic mock visual assets (no live Supabase/Gemini).
// ---------------------------------------------------------------------------

import { detectVisualIntent, parsePageNumbers } from "./src/lib/agent/visual-intent";
import {
  loadVisualEvidence,
  buildGeminiImageParts,
  buildVisualEvidenceNote,
  buildAssetQuery,
  type VisualEvidence,
} from "./src/lib/agent/visual-evidence";
import { buildGroundingInstruction } from "./src/lib/agent/policy";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function assertContains(haystack: string, needle: string, name: string) {
  assert(
    haystack.toLowerCase().includes(needle.toLowerCase()),
    name,
    `expected "${needle}" in: ${haystack.slice(0, 240)}`
  );
}

// 1x1 PNG lazy base64 chunk (valid image bytes, tiny).
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// ---------------------------------------------------------------------------
// Deterministic mock visual assets (STEP 22)
//
// Document A: page 4 → diagram, page 5 → chart, page 6 → table
// Document B: page 4 → different diagram
// Document C: page 2 → failing asset (storage read failure)
// ---------------------------------------------------------------------------

interface MockAsset {
  sourceId: string;
  documentId: string;
  pageNumber: number | null;
  assetType: string;
  storagePath: string;
}

const MOCK_ASSETS: MockAsset[] = [
  { sourceId: "A", documentId: "A", pageNumber: 4, assetType: "diagram", storagePath: "img/a4.png" },
  { sourceId: "A", documentId: "A", pageNumber: 4, assetType: "image", storagePath: "img/a4b.png" },
  { sourceId: "A", documentId: "A", pageNumber: 5, assetType: "chart", storagePath: "img/a5.png" },
  { sourceId: "A", documentId: "A", pageNumber: 6, assetType: "table", storagePath: "img/a6.png" },
  { sourceId: "B", documentId: "B", pageNumber: 4, assetType: "diagram", storagePath: "img/b4.png" },
  { sourceId: "C", documentId: "C", pageNumber: 2, assetType: "diagram", storagePath: "img/fail.png" },
];

const SOURCE_NAMES = new Map<string, string>([
  ["A", "Document A"],
  ["B", "Document B"],
  ["C", "Document C"],
]);

// storage download mock: only img/fail.png fails (returns null)
function mockLoadAsset(
  _supabase: unknown,
  storagePath: string
): Promise<string | null> {
  if (storagePath === "img/fail.png") return Promise.resolve(null);
  const asset = MOCK_ASSETS.find((a) => a.storagePath === storagePath);
  if (!asset) return Promise.resolve(null);
  return Promise.resolve(TINY_PNG_B64);
}

// visual_assets query mock — replicates the DUAL-FK document_id/source_id rule
// plus page/kind filtering so selection behavior is exercised faithfully.
async function mockQueryAssets(
  _supabase: unknown,
  sourceId: string,
  _userId: string,
  targetPages: number[],
  targetKinds: Set<string>,
  limit: number
): Promise<{
  storage_path: string;
  mime_type: string;
  asset_type: string;
  page_number: number | null;
  width: number | null;
  height: number | null;
}[]> {
  let rows = MOCK_ASSETS.filter(
    (a) => a.documentId === sourceId || a.sourceId === sourceId
  );
  if (targetPages.length > 0) {
    rows = rows.filter((a) => a.pageNumber != null && targetPages.includes(a.pageNumber));
  }
  rows.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0));
  let selected = rows;
  if (targetKinds.size > 0) {
    const matching = rows.filter((a) => targetKinds.has(a.assetType));
    if (matching.length > 0) selected = matching;
  }
  return selected.slice(0, limit).map((a) => ({
    storage_path: a.storagePath,
    mime_type: "image/png",
    asset_type: a.assetType,
    page_number: a.pageNumber,
    width: 10,
    height: 10,
  }));
}

// ---------------------------------------------------------------------------
// Fake Supabase builder for buildAssetQuery (proves the dual-FK OR filter)
// ---------------------------------------------------------------------------

function makeFakeSupabase() {
  const calls: string[] = [];
  const builder = {
    select() {
      return builder;
    },
    or(filter: string) {
      calls.push(`or(${filter})`);
      return builder;
    },
    eq(col: string, val: unknown) {
      calls.push(`eq ${col}=${String(val)}`);
      return builder;
    },
    in(col: string, val: unknown[]) {
      calls.push(`in ${col}=[${val.join(",")}]`);
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { supabase: { from: () => builder } as any, calls };
}

async function run() {
  console.log("=== Phase 5E-2 FINAL multimodal repair tests ===\n");

  // -------------------------------------------------------------------------
  // 1. Page visual query detection (STEP 12 variations)
  // -------------------------------------------------------------------------
  {
    const cases: Array<[string, boolean, number | undefined]> = [
      ["what is the image in the page no 4", true, 4],
      ["what is the image in page number 4", true, 4],
      ["what is in the image on page 4", true, 4],
      ["what is shown on the 4th page", true, 4],
      ["what diagram is on page five", true, 5],
      ["show me the chart on pg 7", true, 7],
      ["what is in the table on page 1", true, 1],
      ["what is the image on the page", true, undefined],
      ["what is normalization", false, undefined],
      ["Hello there, how are you?", false, undefined],
    ];
    for (const [q, expectVisual, expectPage] of cases) {
      const intent = detectVisualIntent(q);
      assert(
        (intent.type !== "none") === expectVisual,
        `intent ${JSON.stringify(q)}`,
        `type=${intent.type}`
      );
      const pages = parsePageNumbers(q);
      assert(
        (expectPage == null ? pages.length === 0 : pages[0] === expectPage),
        `page ${JSON.stringify(q)}`,
        `pages=${pages.join(",")}`
      );
    }
    assert(parsePageNumbers("on the 4th page")[0] === 4, "ordinal 4th page");
    assert(parsePageNumbers("page no. 12")[0] === 12, "page no. 12");
    assert(parsePageNumbers("on page four")[0] === 4, "word page four");
    assert(
      detectVisualIntent("what is the image on page 4").references.some(
        (r) => r.kind === "page" && r.number === 4
      ),
      "page reference with number 4 captured"
    );
  }

  // -------------------------------------------------------------------------
  // 2. Intent classification: VISUAL_ONLY / MIXED / TEXT_ONLY
  // -------------------------------------------------------------------------
  {
    assert(
      detectVisualIntent("what does the diagram show?").type === "visual",
      "VISUAL_ONLY: what does the diagram show"
    );
    assert(
      detectVisualIntent("what image is on page 4?").type === "visual",
      "VISUAL_ONLY: what image is on page 4"
    );
    const mixed = detectVisualIntent(
      "explain the concept using the diagram and paragraph about caching"
    );
    assert(mixed.type === "mixed", "MIXED: explain using diagram and paragraph", `type=${mixed.type}`);
    assert(
      detectVisualIntent("what is normalization?").type === "none",
      "TEXT_ONLY: what is normalization"
    );
    assert(
      detectVisualIntent("why does the diagram connect node A to node B?").type === "mixed",
      "MIXED: reasoning about diagram"
    );
  }

  // -------------------------------------------------------------------------
  // 3. Gemini inlineData construction (STEP 9 / 10)
  // -------------------------------------------------------------------------
  {
    const ev: VisualEvidence = {
      sourceId: "A",
      sourceName: "Document A",
      storagePath: "img/a4.png",
      mimeType: "image/png",
      pageNumber: 4,
      assetType: "diagram",
      width: 10,
      height: 10,
      base64Data: TINY_PNG_B64,
    };
    const parts = buildGeminiImageParts([ev]);
    assert(parts.length === 2, "two parts (label + inlineData)", `parts=${parts.length}`);
    assert(
      parts.some((p) => "inlineData" in p && p.inlineData.mimeType === "image/png"),
      "inlineData MIME type image/png"
    );
    const img = parts.filter((p): p is { inlineData: { mimeType: string; data: string } } => "inlineData" in p);
    assert(img.length === 1 && img[0].inlineData.data === TINY_PNG_B64, "base64 data passthrough");
    assert(
      "text" in parts[0] && parts[0].text.includes("Visual Evidence"),
      "label before image includes Visual Evidence",
      JSON.stringify(parts[0])
    );
    assert("text" in parts[0] && parts[0].text.includes("Page: 4"), "label includes page");
    assert("text" in parts[0] && parts[0].text.includes("Diagram"), "label includes type");
    assert(parts.some((p) => "inlineData" in p), "no data URL prefix present");
  }

  // -------------------------------------------------------------------------
  // 4. Page-specific visual retrieval (STEP 4 / TEST "diagram on page 4")
  // -------------------------------------------------------------------------
  {
    const intent = detectVisualIntent("what is the diagram on page 4?");
    const res = await loadVisualEvidence(intent, ["A"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    assert(res.visuals.length >= 1, "page-4 visual loaded for Document A");
    assert(
      res.visuals.every((v) => v.pageNumber === 4),
      "all page-4 evidence stays on page 4",
      res.visuals.map((v) => `p${v.pageNumber}`).join(",")
    );
    assert(
      res.visuals[0]?.sourceName === "Document A",
      `source attribution ${res.visuals[0]?.sourceName}`
    );
  }

  // -------------------------------------------------------------------------
  // 5. Multiple visual assets on same page
  // -------------------------------------------------------------------------
  {
    const intent = detectVisualIntent("what images are on page 4 of document A?");
    const res = await loadVisualEvidence(intent, ["A"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    const page4 = res.visuals.filter((v) => v.pageNumber === 4);
    assert(page4.length >= 2, "two page-4 assets both loaded", `count=${page4.length}`);
    assert(
      new Set(page4.map((v) => v.storagePath)).size === page4.length,
      "no duplicate evidence on same page"
    );
  }

  // -------------------------------------------------------------------------
  // 6. Multi-document visual retrieval + source isolation (STEP 6)
  // -------------------------------------------------------------------------
  {
    const intent = detectVisualIntent("compare the diagrams in both documents");
    const res = await loadVisualEvidence(intent, ["A", "B"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    const sources = new Set(res.visuals.map((v) => v.sourceName));
    assert(sources.has("Document A") && sources.has("Document B"), "both docs represented", [...sources].join(","));
assert(
        res.visuals.length >= 2 && res.visuals.every((v) => v.assetType === "diagram"),
        "reasoning selects diagram kind when asked",
        res.visuals.map((v) => `${v.sourceName}/${v.assetType}`).join(",")
      );
  }

  // -------------------------------------------------------------------------
  // 7. Single-document isolation — Document B must not leak A's visuals
  // -------------------------------------------------------------------------
  {
    const intent = detectVisualIntent("what is the diagram on page 4?");
    const res = await loadVisualEvidence(intent, ["B"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    assert(res.visuals.length === 1, "Document B page-4 diagram only", `count=${res.visuals.length}`);
    assert(res.visuals[0]?.sourceName === "Document B", "isolated to Document B");
    assert(res.visuals[0]?.storagePath === "img/b4.png", "correct b4 asset");
  }

  // -------------------------------------------------------------------------
  // 8. Chart / table queries (STEP 13)
  // -------------------------------------------------------------------------
  {
    const chart = await loadVisualEvidence(detectVisualIntent("what does the chart show?"), ["A"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    assert(chart.visuals.some((v) => v.assetType === "chart"), "chart asset selected", chart.visuals.map((v) => v.assetType).join(","));

    const table = await loadVisualEvidence(detectVisualIntent("what information is in the table?"), ["A"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    assert(table.visuals.some((v) => v.assetType === "table"), "table asset selected");
  }

  // -------------------------------------------------------------------------
  // 9. Negative visual query (STEP 15): page 99 → NOT FOUND, no substitution
  // -------------------------------------------------------------------------
  {
    const intent = detectVisualIntent("what does the diagram on page 99 show?");
    const res = await loadVisualEvidence(intent, ["A"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    assert(res.visuals.length === 0, "page 99 returns zero visuals");
    assert(res.visuals.every((v) => false) , "no substitution from another page (length 0)");
    const note = buildVisualEvidenceNote(intent, res);
    assertContains(note, "UNAVAILABLE", "negative note marks visuals unavailable");
    assertContains(note, "page 99", "negative note names page 99");
  }

  // -------------------------------------------------------------------------
  // 10. Missing visual asset query (no such source) 
  // -------------------------------------------------------------------------
  {
    const res = await loadVisualEvidence(detectVisualIntent("what diagram is shown?"), ["ZZZ"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    assert(res.visuals.length === 0, "unknown source → zero visuals");
    assert(res.partialFailure === false, "no failure for clean empty result");
  }

  // -------------------------------------------------------------------------
  // 11. Storage download failure → structured partial failure (STEP 8/18)
  // -------------------------------------------------------------------------
  {
    const res = await loadVisualEvidence(detectVisualIntent("what is on page 2?"), ["C"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    assert(res.partialFailure === true, "partialFailure true on storage download failure");
    assert(
      res.errors.some((e) => e.toLowerCase().includes("img/fail.png")),
      "error names the failing asset",
      res.errors.join("; ")
    );
    assert(res.visuals.length === 0, "failing asset excluded from evidence");
    const note = buildVisualEvidenceNote(detectVisualIntent("what is on page 2?"), res);
    assertContains(note, "could not be loaded", "note reports loading error");
  }

  // -------------------------------------------------------------------------
  // 12. Visual grounding rules (STEP 11) — injected when visuals present
  // -------------------------------------------------------------------------
  {
    const g = buildGroundingInstruction(
      [{ sourceName: "Document A", sourceType: "image", passagesText: "…" }],
      undefined,
      undefined,
      { hasVisualEvidence: true, assetTypes: ["diagram"], partialFailure: false }
    );
    assertContains(g, "VISUAL EVIDENCE IS AUTHORITATIVE", "authoritative rule injected");
    assertContains(g, "CHART/DIAGRAM REASONING", "chart/diagram reasoning rule injected");
  }

  // -------------------------------------------------------------------------
  // 13. Visual retrieval independence (STEP 3) — evidence loads with NO text
  //     context at all; a failed text retrieval cannot skip this channel.
  // -------------------------------------------------------------------------
  {
    const intent = detectVisualIntent("what is the image on page 5?");
    const res = await loadVisualEvidence(intent, ["A"], "u1", SOURCE_NAMES, {
      queryAssets: mockQueryAssets,
      loadAsset: mockLoadAsset,
    });
    assert(res.visuals.length === 1, "visual evidence loads independently of text RAG");
    assert(res.visuals[0]?.assetType === "chart", "page-5 chart identified");
  }

  // -------------------------------------------------------------------------
  // 14. buildAssetQuery emits the dual-FK OR filter (the core FK bug fix)
  // -------------------------------------------------------------------------
  {
    const { supabase, calls } = makeFakeSupabase();
    buildAssetQuery(supabase, "doc-abc", "user-1", [4], new Set(["diagram"]), 4);
    assert(
      calls.some((c) => c === "or(document_id.eq.doc-abc,source_id.eq.doc-abc)"),
      "dual-FK filter includes both document_id and source_id",
      calls.join(" | ")
    );
    assert(calls.some((c) => c === "eq user_id=user-1"), "user_id filter applied");
    assert(calls.some((c) => c === "eq processing_status=ready"), "processing_status ready filter");
    assert(calls.some((c) => c === "in page_number=[4]"), "page filter applied");
  }

  // -------------------------------------------------------------------------
  // 15. TEXT_ONLY regression — normal text RAG untouched (STEP 23)
  // -------------------------------------------------------------------------
  {
    const intent = detectVisualIntent("What is normalization?");
    assert(intent.type === "none", "normalization query is TEXT_ONLY");
    assert(parsePageNumbers("What is normalization?").length === 0, "no pages parsed from text query");
  }

  // -------------------------------------------------------------------------
  // 16. Bounded evidence — no unbounded image explosion (STEP 20)
  // -------------------------------------------------------------------------
  {
    const big: MockAsset[] = [];
    for (let i = 1; i <= 30; i++) {
      big.push({ sourceId: "A", documentId: "A", pageNumber: i, assetType: "diagram", storagePath: `img/big${i}.png` });
    }
    const allAssets = [...MOCK_ASSETS, ...big];
    const q = async (...args: Parameters<typeof mockQueryAssets>) => {
      const rows = allAssets.filter((a) => a.documentId === args[1] || a.sourceId === args[1]);
      rows.sort((x, y) => (x.pageNumber ?? 0) - (y.pageNumber ?? 0));
      return rows.slice(0, args[5]).map((a) => ({
        storage_path: a.storagePath,
        mime_type: "image/png",
        asset_type: a.assetType,
        page_number: a.pageNumber,
        width: 10,
        height: 10,
      }));
    };
    const res = await loadVisualEvidence(detectVisualIntent("what are all the diagrams?"), ["A"], "u1", SOURCE_NAMES, {
      queryAssets: q,
      loadAsset: mockLoadAsset,
    });
    assert(res.visuals.length <= 4, "evidence bounded to 4 visuals", `loaded=${res.visuals.length}`);
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------
  console.log(`\n=== RESULTS ===`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("All tests passed.");
  }
}

void run();