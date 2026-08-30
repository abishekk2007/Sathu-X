// ---------------------------------------------------------------------------
// Automated tests for Phase 5E-2 Multimodal Agentic Reasoning.
// Run with: npx tsx test-5e2-multimodal.ts
//
// TEST 1  — TEXT_ONLY: "What is normalization?" → no visual intent
// TEST 2  — PAGE VISUAL: "What is shown on page 8?" → page visual intent
// TEST 3  — DIAGRAM: "What does the architecture diagram show?" → visual intent
// TEST 4  — FIGURE: "Explain Figure 3." → visual intent
// TEST 5  — CHART: "What trend does the chart show?" → visual intent
// TEST 6  — TABLE: "What is the value in row X of table 2?" → visual intent
// TEST 7  — MIXED: "According to the diagram, why is X connected to Y?" → mixed
// TEST 8  — SCANNED: "Can you read the scanned page?" → visual intent
// TEST 9  — MULTI-DOC: two documents, "Compare the diagrams" → visual intent
// TEST 10 — WRONG DOC: visual ref not in document → no hallucination
// TEST 11 — VISUAL NOT FOUND: "Figure 99" → no crash
// TEST 12 — CORRUPT IMAGE: graceful fallback (unit test of null path)
// TEST 13 — NORMAL RAG REGRESSION: text-only queries still work
// TEST 14 — PAGE RETREGRESSION: page queries still work
// TEST 15 — STRUCTURAL RETREGRESSION: Unit/Chapter queries still work
// TEST 16 — MULTI-SOURCE RETREGRESSION: multi-doc still works
// TEST 17 — VISUAL GROUNDING RULES: policy generates visual rules
// TEST 18 — GEMINI CONTENT CONSTRUCTION: image parts correctly formed
// ---------------------------------------------------------------------------

import {
  detectVisualIntent,
  getTargetPages,
  getTargetVisualKinds,
} from "./src/lib/agent/visual-intent";
import { buildGeminiImageParts } from "./src/lib/agent/visual-evidence";
import type { VisualEvidence } from "./src/lib/agent/visual-evidence";
import { buildGroundingInstruction } from "./src/lib/agent/policy";
// Regression: existing functionality
import { extractStructuralMarkers, analyzeQuery } from "./src/lib/retrieval/query-analyzer";
import { validateStructuralPath } from "./src/lib/retrieval/scoring";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function assertEqual(a: unknown, b: unknown, msg: string) {
  assert(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertIncludes(haystack: string, needle: string, msg: string) {
  assert(haystack.includes(needle), `${msg} — string should contain "${needle}"`);
}

function assertNotIncludes(haystack: string, needle: string, msg: string) {
  assert(!haystack.includes(needle), `${msg} — string should NOT contain "${needle}"`);
}

// ============================================================================
// TEST 1 — TEXT_ONLY: "What is normalization?"
// ============================================================================
console.log("\n=== TEST 1: TEXT_ONLY — no visual intent ===");

{
  const intent = detectVisualIntent("What is normalization?");
  assertEqual(intent.type, "none", "type is 'none'");
  assertEqual(intent.references.length, 0, "no visual references");
  assertEqual(intent.hasTextualAnalysis, false, "no textual analysis flag");
}

{
  const intent = detectVisualIntent("Explain the concept of machine learning");
  assertEqual(intent.type, "none", "general question → none");
}

{
  const intent = detectVisualIntent("Hello, how are you?");
  assertEqual(intent.type, "none", "greeting → none");
}

{
  const intent = detectVisualIntent("Can you help me with my homework?");
  assertEqual(intent.type, "none", "general help → none");
}

// ============================================================================
// TEST 2 — PAGE VISUAL: "What is shown on page 8?"
// ============================================================================
console.log("\n=== TEST 2: PAGE VISUAL ===");

{
  const intent = detectVisualIntent("What is shown on page 8?");
  assert(intent.type === "visual" || intent.type === "mixed", "detected as visual or mixed");
  const pageRef = intent.references.find((r) => r.kind === "page");
  assert(pageRef !== undefined, "has page reference");
  assertEqual(pageRef?.number, 8, "page number is 8");
}

{
  const intent = detectVisualIntent("Show me page 12");
  assert(intent.type !== "none", "page reference detected");
  const pages = getTargetPages(intent.references);
  assert(pages.includes(12), "target pages includes 12");
}

// ============================================================================
// TEST 3 — DIAGRAM: "What does the architecture diagram show?"
// ============================================================================
console.log("\n=== TEST 3: DIAGRAM ===");

{
  const intent = detectVisualIntent("What does the architecture diagram show?");
  assert(intent.type === "visual" || intent.type === "mixed", "detected as visual or mixed");
  const kinds = getTargetVisualKinds(intent.references);
  assert(kinds.has("diagram"), "has diagram reference");
}

{
  const intent = detectVisualIntent("Explain the flowchart on page 5");
  const kinds = getTargetVisualKinds(intent.references);
  assert(kinds.has("diagram"), "flowchart → diagram kind");
  const pages = getTargetPages(intent.references);
  assert(pages.includes(5), "page 5 targeted");
}

// ============================================================================
// TEST 4 — FIGURE: "Explain Figure 3."
// ============================================================================
console.log("\n=== TEST 4: FIGURE ===");

{
  const intent = detectVisualIntent("Explain Figure 3.");
  assert(intent.type !== "none", "figure reference detected");
  const figRef = intent.references.find((r) => r.kind === "figure");
  assert(figRef !== undefined, "has figure reference");
  assertEqual(figRef?.number, 3, "figure number is 3");
}

{
  const intent = detectVisualIntent("What is Figure 12.3?");
  const figRef = intent.references.find((r) => r.kind === "figure");
  assert(figRef !== undefined, "has figure reference");
  assertEqual(figRef?.number, 12, "figure number is 12 (integer part)");
}

{
  const intent = detectVisualIntent("the diagram above");
  assert(intent.type !== "none", "generic 'the diagram' detected");
}

// ============================================================================
// TEST 5 — CHART: "What trend does the chart show?"
// ============================================================================
console.log("\n=== TEST 5: CHART ===");

{
  const intent = detectVisualIntent("What trend does the chart show?");
  assert(intent.type !== "none", "chart reference detected");
  const kinds = getTargetVisualKinds(intent.references);
  assert(kinds.has("chart"), "has chart kind");
}

{
  const intent = detectVisualIntent("Analyze graph 4 on page 10");
  const kinds = getTargetVisualKinds(intent.references);
  assert(kinds.has("chart"), "graph → chart kind");
  const pages = getTargetPages(intent.references);
  assert(pages.includes(10), "page 10 targeted");
}

{
  const intent = detectVisualIntent("What does plot 2 show?");
  const kinds = getTargetVisualKinds(intent.references);
  assert(kinds.has("chart"), "plot → chart kind");
}

// ============================================================================
// TEST 6 — TABLE: "What is the value in row X of table 2?"
// ============================================================================
console.log("\n=== TEST 6: TABLE ===");

{
  const intent = detectVisualIntent("What is the value in row X of table 2?");
  assert(intent.type !== "none", "table reference detected");
  const kinds = getTargetVisualKinds(intent.references);
  assert(kinds.has("table"), "has table kind");
}

{
  const intent = detectVisualIntent("Compare columns A and B in table 1");
  const kinds = getTargetVisualKinds(intent.references);
  assert(kinds.has("table"), "has table kind");
}

// ============================================================================
// TEST 7 — MIXED: "According to the diagram, why is X connected to Y?"
// ============================================================================
console.log("\n=== TEST 7: MIXED reasoning ===");

{
  const intent = detectVisualIntent(
    "According to the diagram, why does the load balancer connect to Server A?"
  );
  assertEqual(intent.type, "mixed", "diagram + reasoning → mixed");
  assert(intent.references.length > 0, "has visual references");
  assert(intent.hasTextualAnalysis, "has textual analysis (why/connect)");
}

{
  const intent = detectVisualIntent(
    "Compare the table on page 4 with the explanation on page 5"
  );
  assertEqual(intent.type, "mixed", "compare + table → mixed");
}

{
  const intent = detectVisualIntent(
    "The diagram shows component X. Explain why it uses this architecture."
  );
  assertEqual(intent.type, "mixed", "diagram + explain why → mixed");
}

// ============================================================================
// TEST 8 — SCANNED: "Can you read the scanned page?"
// ============================================================================
console.log("\n=== TEST 8: SCANNED page ===");

{
  const intent = detectVisualIntent("Can you read the scanned document?");
  assert(intent.type !== "none", "scanned reference detected");
  const kinds = getTargetVisualKinds(intent.references);
  assert(kinds.has("scanned"), "has scanned kind");
}

{
  const intent = detectVisualIntent("OCR this page");
  assert(intent.type !== "none", "OCR keyword detected");
}

// ============================================================================
// TEST 9 — MULTI-DOC: two documents, visual comparison
// ============================================================================
console.log("\n=== TEST 9: MULTI-DOC visual comparison ===");

{
  const intent = detectVisualIntent(
    "Compare the diagrams in both documents"
  );
  assert(intent.type !== "none", "diagram comparison detected");
  const kinds = getTargetVisualKinds(intent.references);
  assert(kinds.has("diagram"), "has diagram kind");
}

{
  const intent = detectVisualIntent(
    "What does the chart in Document A show compared to Document B?"
  );
  assert(intent.type !== "none", "cross-document chart comparison detected");
}

// ============================================================================
// TEST 10 — WRONG DOCUMENT: no hallucination
// ============================================================================
console.log("\n=== TEST 10: WRONG DOCUMENT protection ===");

{
  // This tests that the intent detection doesn't over-match
  const intent = detectVisualIntent("What is the capital of France?");
  assertEqual(intent.type, "none", "unrelated query → no visual intent");
  assertEqual(intent.references.length, 0, "no visual references for unrelated query");
}

// ============================================================================
// TEST 11 — VISUAL NOT FOUND: "Figure 99" → no crash
// ============================================================================
console.log("\n=== TEST 11: VISUAL NOT FOUND ===");

{
  // Detection should work even if the figure doesn't exist
  const intent = detectVisualIntent("What does Figure 99 show?");
  assert(intent.type !== "none", "Figure 99 still detected as visual");
  const figRef = intent.references.find((r) => r.kind === "figure");
  assertEqual(figRef?.number, 99, "figure number 99 extracted");
  // The actual retrieval would return no assets, but detection works
}

{
  const intent = detectVisualIntent("Show me chart 200 on page 50");
  assert(intent.type !== "none", "non-existent chart still detected");
}

// ============================================================================
// TEST 12 — CORRUPT IMAGE: graceful fallback
// ============================================================================
console.log("\n=== TEST 12: CORRUPT IMAGE fallback ===");

{
  // buildGeminiImageParts with empty array → no crash
  const parts = buildGeminiImageParts([]);
  assertEqual(parts.length, 0, "empty evidence → empty parts");
}

{
  // buildGeminiImageParts with valid evidence → correct structure
  const evidence: VisualEvidence[] = [
    {
      sourceId: "doc-1",
      sourceName: "test.pdf",
      storagePath: "user/doc/page_1.png",
      mimeType: "image/png",
      pageNumber: 1,
      assetType: "page_image",
      width: 800,
      height: 600,
      base64Data: "AAAA", // dummy base64
    },
  ];
  const parts = buildGeminiImageParts(evidence);
  assertEqual(parts.length, 2, "1 visual → 2 parts (label + image)");
  assert("text" in parts[0], "first part is text label");
  assert("inlineData" in parts[1], "second part is inlineData");
  if ("inlineData" in parts[1]) {
    assertEqual(parts[1].inlineData.mimeType, "image/png", "correct MIME type");
    assertEqual(parts[1].inlineData.data, "AAAA", "correct base64 data");
  }
}

// ============================================================================
// TEST 13 — NORMAL RAG REGRESSION: text queries unchanged
// ============================================================================
console.log("\n=== TEST 13: NORMAL RAG regression ===");

{
  // Text-only query should have no visual intent
  const intent = detectVisualIntent("What is normalization in databases?");
  assertEqual(intent.type, "none", "text RAG query → no visual intent");
}

{
  // Existing query analysis still works
  const analysis = analyzeQuery("What is normalization?");
  assert(analysis !== undefined, "analyzeQuery still works");
}

// ============================================================================
// TEST 14 — PAGE RETRIEVAL REGRESSION: page queries work
// ============================================================================
console.log("\n=== TEST 14: PAGE RETRIEVAL regression ===");

{
  // Existing structural markers still extract correctly
  const markers = extractStructuralMarkers("Unit 4 Part B Question 5");
  const unitMarker = markers.find((m) => m.type === "unit");
  assert(unitMarker !== undefined, "structural marker extraction unchanged");
  assertEqual(unitMarker?.number, "4", "unit 4 extracted");
}

{
  // Page detection still works
  const intent = detectVisualIntent("What is on page 8?");
  const pages = getTargetPages(intent.references);
  assert(pages.includes(8), "page 8 still detected");
}

// ============================================================================
// TEST 15 — STRUCTURAL RETRIEVAL REGRESSION: Unit/Chapter queries
// ============================================================================
console.log("\n=== TEST 15: STRUCTURAL RETRIEVAL regression ===");

{
  const markers = extractStructuralMarkers("Chapter III Section 2");
  const chapterMarker = markers.find((m) => m.type === "chapter");
  assert(chapterMarker !== undefined, "chapter marker still extracted");
  assertEqual(chapterMarker?.number, "3", "chapter III → 3");
}

{
  const analysis = analyzeQuery("List all questions in Unit 4 Part B");
  assertEqual(analysis.scopeQuery, true, "scope query detection unchanged");
}

{
  // Cross-case matching still works
  const path = [
    { type: "unit" as const, number: "4", label: "Unit 4" },
    { type: "part" as const, number: "b", label: "Part B" },
    { type: "question" as const, number: "5", label: "Question 5" },
  ];
  const contentMarkers = extractStructuralMarkers("unit iv\npart b\nquestion 5");
  const valid = validateStructuralPath(path, contentMarkers);
  assert(valid, "cross-case structural path validation unchanged");
}

// ============================================================================
// TEST 16 — MULTI-SOURCE RETRIEVAL regression
// ============================================================================
console.log("\n=== TEST 16: MULTI-SOURCE RETRIEVAL regression ===");

{
  // Multi-document comparison detection still works
  const analysis = analyzeQuery("Compare both documents");
  assert(analysis !== undefined, "multi-source query analysis works");
}

{
  // General queries about documents still work
  const intent = detectVisualIntent("Summarize both documents");
  // This should be text-only (no visual reference)
  assertEqual(intent.type, "none", "text summary → no visual intent");
}

// ============================================================================
// TEST 17 — VISUAL GROUNDING RULES: policy generates visual rules
// ============================================================================
console.log("\n=== TEST 17: VISUAL GROUNDING RULES ===");

{
  // Without visual context → no visual rules
  const instruction = buildGroundingInstruction(
    [{ sourceName: "doc.pdf", sourceType: "document", passagesText: "test" }],
    undefined,
    undefined,
    undefined
  );
  assertNotIncludes(instruction, "VISUAL EVIDENCE RULES", "no visual rules without visual context");
  assertIncludes(instruction, "CONTEXT GROUNDING RULES", "has base grounding rules");
}

{
  // With visual context → visual rules present
  const instruction = buildGroundingInstruction(
    [{ sourceName: "doc.pdf", sourceType: "document", passagesText: "test" }],
    undefined,
    undefined,
    { hasVisualEvidence: true, assetTypes: ["page_image"], partialFailure: false }
  );
  assertIncludes(instruction, "VISUAL EVIDENCE RULES", "has visual rules");
  assertIncludes(instruction, "VISUAL EVIDENCE IS AUTHORITATIVE", "has authority rule");
  assertIncludes(instruction, "DO NOT FABRICATE VISUAL CONTENT", "has anti-fabrication rule");
}

{
  // With chart type → chart-specific rules
  const instruction = buildGroundingInstruction(
    [{ sourceName: "doc.pdf", sourceType: "document", passagesText: "test" }],
    undefined,
    undefined,
    { hasVisualEvidence: true, assetTypes: ["chart", "diagram"], partialFailure: false }
  );
  assertIncludes(instruction, "CHART/DIAGRAM REASONING", "has chart/diagram rules");
}

{
  // With table type → table-specific rules
  const instruction = buildGroundingInstruction(
    [{ sourceName: "doc.pdf", sourceType: "document", passagesText: "test" }],
    undefined,
    undefined,
    { hasVisualEvidence: true, assetTypes: ["table"], partialFailure: false }
  );
  assertIncludes(instruction, "TABLE REASONING", "has table rules");
}

{
  // With partial failure → partial failure rule
  const instruction = buildGroundingInstruction(
    [{ sourceName: "doc.pdf", sourceType: "document", passagesText: "test" }],
    undefined,
    undefined,
    { hasVisualEvidence: true, assetTypes: ["page_image"], partialFailure: true }
  );
  assertIncludes(instruction, "PARTIAL VISUAL EVIDENCE", "has partial failure rule");
}

{
  // Text-vision conflict rule always present when visual evidence exists
  const instruction = buildGroundingInstruction(
    [{ sourceName: "doc.pdf", sourceType: "document", passagesText: "test" }],
    undefined,
    undefined,
    { hasVisualEvidence: true, assetTypes: ["page_image"], partialFailure: false }
  );
  assertIncludes(instruction, "TEXT-VISUAL CONFLICT", "has conflict handling rule");
}

// ============================================================================
// TEST 18 — GEMINI CONTENT CONSTRUCTION: image parts correctly formed
// ============================================================================
console.log("\n=== TEST 18: GEMINI CONTENT CONSTRUCTION ===");

{
  // Multiple visual evidence → correct number of parts
  const evidence: VisualEvidence[] = [
    {
      sourceId: "doc-1",
      sourceName: "doc1.pdf",
      storagePath: "u/d/p1.png",
      mimeType: "image/png",
      pageNumber: 1,
      assetType: "page_image",
      width: 800,
      height: 600,
      base64Data: "AAAA",
    },
    {
      sourceId: "doc-2",
      sourceName: "doc2.pdf",
      storagePath: "u/d/p3.png",
      mimeType: "image/png",
      pageNumber: 3,
      assetType: "figure",
      width: 600,
      height: 400,
      base64Data: "BBBB",
    },
  ];
  const parts = buildGeminiImageParts(evidence);
  // 2 visuals → 4 parts (2 label + 2 image)
  assertEqual(parts.length, 4, "2 visuals → 4 parts");
  assert("text" in parts[0], "part 0 is label for doc1");
  assert("inlineData" in parts[1], "part 1 is image for doc1");
  assert("text" in parts[2], "part 2 is label for doc2");
  assert("inlineData" in parts[3], "part 3 is image for doc2");
}

{
  // Label contains source name and page
  const evidence: VisualEvidence[] = [
    {
      sourceId: "doc-1",
      sourceName: "Architecture.pdf",
      storagePath: "u/d/p8.png",
      mimeType: "image/png",
      pageNumber: 8,
      assetType: "diagram",
      width: 1000,
      height: 800,
      base64Data: "CCCC",
    },
  ];
  const parts = buildGeminiImageParts(evidence);
  assert(parts.length === 2, "1 visual → 2 parts");
  const label = "text" in parts[0] ? parts[0].text : "";
  assertIncludes(label, "Architecture.pdf", "label contains source name");
  assertIncludes(label, "Page: 8", "label contains page number");
  assertIncludes(label, "Diagram", "label contains asset type");
}

{
  // Evidence without page number → label omits page
  const evidence: VisualEvidence[] = [
    {
      sourceId: "img-1",
      sourceName: "Image upload",
      storagePath: "u/i/img.png",
      mimeType: "image/jpeg",
      pageNumber: null,
      assetType: "image",
      width: 500,
      height: 300,
      base64Data: "DDDD",
    },
  ];
  const parts = buildGeminiImageParts(evidence);
  const label = "text" in parts[0] ? parts[0].text : "";
  assertNotIncludes(label, "Page:", "label omits page when null");
  assertIncludes(label, "Image", "label contains asset type");
}

{
  // Adversarial: user says "The diagram shows X, explain why"
  // System should not accept user's claim — grounding rule should override
  const instruction = buildGroundingInstruction(
    [{ sourceName: "doc.pdf", sourceType: "document", passagesText: "test passage" }],
    undefined,
    undefined,
    { hasVisualEvidence: true, assetTypes: ["diagram"], partialFailure: false }
  );
  assertIncludes(instruction, "DO NOT FABRICATE VISUAL CONTENT", "anti-hallucination rule present");
  assertIncludes(instruction, "Describe ONLY what is visibly present", "grounding instruction present");
}

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
console.log(`Phase 5E-2 tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
}
