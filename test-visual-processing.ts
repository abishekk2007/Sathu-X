// ---------------------------------------------------------------------------
// Automated tests for Phase 5E-1 visual processing layer.
// Run with: npx tsx test-visual-processing.ts
//
// TEST A: VisualAssetType values — all 11 types present
// TEST B: detectVisualAssetType heuristic detection
// TEST C: isValidVisualAssetType runtime check
// TEST D: VISUAL_QUERY_SIGNALS regex patterns
// TEST E: Image validation — empty buffer
// TEST F: Image MIME detection — PNG/JPEG/WebP
// TEST G: Image dimension reading — PNG header
// TEST H: Filename sanitization
// TEST I: Storage path generation
// TEST J: detectVisualAugmentation query→asset matching
// ---------------------------------------------------------------------------

import {
  VISUAL_ASSET_TYPE_VALUES,
  VISUAL_QUERY_SIGNALS,
  isValidVisualAssetType,
  detectVisualAssetType,
} from "./src/lib/multimodal/visual-types";
import {
  detectImageMime,
  readImageDimensions,
  sanitizeFilename,
  generateImageStoragePath,
  validateImage,
} from "./src/lib/multimodal/image-processing";

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

// ============================================================================
// TEST A: VisualAssetType values — all 11 types present
// ============================================================================
console.log("\n=== TEST A: VisualAssetType values ===");

{
  const expected = [
    "page_image",
    "slide_image",
    "thumbnail",
    "image",
    "figure",
    "diagram",
    "chart",
    "table",
    "screenshot",
    "scanned_page",
    "unknown",
  ];
  assertEqual(VISUAL_ASSET_TYPE_VALUES.length, 11, "11 visual asset types defined");
  for (const t of expected) {
    assert(
      (VISUAL_ASSET_TYPE_VALUES as readonly string[]).includes(t),
      `VISUAL_ASSET_TYPE_VALUES includes "${t}"`
    );
  }
}

// ============================================================================
// TEST B: detectVisualAssetType heuristic detection
// ============================================================================
console.log("\n=== TEST B: detectVisualAssetType heuristic ===");

{
  assertEqual(detectVisualAssetType("scan_001.png"), "scanned_page", "scan_001.png → scanned_page");
  assertEqual(detectVisualAssetType("Figure 3.2.jpg"), "figure", "Figure 3.2.jpg → figure");
  assertEqual(detectVisualAssetType("fig_2.png"), "figure", "fig_2.png → figure");
  assertEqual(detectVisualAssetType("flowchart.png"), "diagram", "flowchart.png → diagram");
  assertEqual(detectVisualAssetType("diagram_1.png"), "diagram", "diagram_1.png → diagram");
  assertEqual(detectVisualAssetType("chart_bar.png"), "chart", "chart_bar.png → chart");
  assertEqual(detectVisualAssetType("revenue_graph.jpg"), "chart", "revenue_graph.jpg → chart");
  assertEqual(detectVisualAssetType("table_1.png"), "table", "table_1.png → table");
  assertEqual(detectVisualAssetType("screenshot_2024.png"), "screenshot", "screenshot_2024.png → screenshot");
  assertEqual(detectVisualAssetType("screen-shot.png"), "screenshot", "screen-shot.png → screenshot");
  assertEqual(detectVisualAssetType("slide_3.png"), "slide_image", "slide_3.png → slide_image");
  assertEqual(detectVisualAssetType("presentation.pptx"), "slide_image", "presentation.pptx → slide_image");
  assertEqual(detectVisualAssetType("random_file.bin"), "unknown", "random_file.bin → unknown");
  assertEqual(detectVisualAssetType(null), "unknown", "null filename → unknown");
  assertEqual(detectVisualAssetType(undefined), "unknown", "undefined filename → unknown");
}

{
  // Metadata-based detection
  assertEqual(
    detectVisualAssetType(null, { type: "scanned" }),
    "scanned_page",
    "metadata {type: scanned} → scanned_page"
  );
  assertEqual(
    detectVisualAssetType(null, { description: "bar chart of Q4 results" }),
    "chart",
    "metadata description → chart"
  );
  assertEqual(
    detectVisualAssetType("photo.jpg", { type: "figure" }),
    "figure",
    "filename + metadata → figure (metadata wins)"
  );
}

// ============================================================================
// TEST C: isValidVisualAssetType runtime check
// ============================================================================
console.log("\n=== TEST C: isValidVisualAssetType ===");

{
  assert(isValidVisualAssetType("page_image"), "page_image is valid");
  assert(isValidVisualAssetType("slide_image"), "slide_image is valid");
  assert(isValidVisualAssetType("thumbnail"), "thumbnail is valid");
  assert(isValidVisualAssetType("image"), "image is valid");
  assert(isValidVisualAssetType("figure"), "figure is valid");
  assert(isValidVisualAssetType("diagram"), "diagram is valid");
  assert(isValidVisualAssetType("chart"), "chart is valid");
  assert(isValidVisualAssetType("table"), "table is valid");
  assert(isValidVisualAssetType("screenshot"), "screenshot is valid");
  assert(isValidVisualAssetType("scanned_page"), "scanned_page is valid");
  assert(isValidVisualAssetType("unknown"), "unknown is valid");
  assert(!isValidVisualAssetType("invalid_type"), "invalid_type is NOT valid");
  assert(!isValidVisualAssetType(""), "empty string is NOT valid");
  assert(!isValidVisualAssetType("PAGE_IMAGE"), "uppercase PAGE_IMAGE is NOT valid");
  assert(!isValidVisualAssetType("pdf"), "pdf is NOT a visual asset type");
}

// ============================================================================
// TEST D: VISUAL_QUERY_SIGNALS regex patterns
// ============================================================================
console.log("\n=== TEST D: VISUAL_QUERY_SIGNALS ===");

{
  // Page references
  assert(VISUAL_QUERY_SIGNALS.pageRef.test("What is on page 5?"), "pageRef matches 'page 5'");
  assert(VISUAL_QUERY_SIGNALS.pageRef.test("See pg 12"), "pageRef matches 'pg 12'");
  assert(VISUAL_QUERY_SIGNALS.pageRef.test("p.3 has the formula"), "pageRef matches 'p.3'");
  assert(!VISUAL_QUERY_SIGNALS.pageRef.test("What is the page?"), "pageRef does NOT match 'the page'");

  // Figure references
  assert(VISUAL_QUERY_SIGNALS.figureRef.test("Explain Figure 2.1"), "figureRef matches 'Figure 2.1'");
  assert(VISUAL_QUERY_SIGNALS.figureRef.test("See fig 3"), "figureRef matches 'fig 3'");
  assert(!VISUAL_QUERY_SIGNALS.figureRef.test("figure out the answer"), "figureRef does NOT match 'figure out'");

  // Diagram references
  assert(VISUAL_QUERY_SIGNALS.diagramRef.test("What does diagram 1 show?"), "diagramRef matches 'diagram 1'");
  assert(VISUAL_QUERY_SIGNALS.diagramRef.test("flowchart 2 is complex"), "diagramRef matches 'flowchart 2'");

  // Chart references
  assert(VISUAL_QUERY_SIGNALS.chartRef.test("Analyze chart 4"), "chartRef matches 'chart 4'");
  assert(VISUAL_QUERY_SIGNALS.chartRef.test("What does graph 1 show?"), "chartRef matches 'graph 1'");
  assert(VISUAL_QUERY_SIGNALS.chartRef.test("Look at plot 3"), "chartRef matches 'plot 3'");

  // Table references
  assert(VISUAL_QUERY_SIGNALS.tableRef.test("In table 2, what is the value?"), "tableRef matches 'table 2'");
  assert(VISUAL_QUERY_SIGNALS.tableRef.test("tbl 1 shows data"), "tableRef matches 'tbl 1'");

  // Image references
  assert(VISUAL_QUERY_SIGNALS.imageRef.test("What is in image 1?"), "imageRef matches 'image 1'");
  assert(VISUAL_QUERY_SIGNALS.imageRef.test("See img 3"), "imageRef matches 'img 3'");
  assert(VISUAL_QUERY_SIGNALS.imageRef.test("Look at picture 2"), "imageRef matches 'picture 2'");
  assert(VISUAL_QUERY_SIGNALS.imageRef.test("The photo 1 shows"), "imageRef matches 'photo 1'");

  // Scanned/OCR references
  assert(VISUAL_QUERY_SIGNALS.scannedRef.test("This is a scanned document"), "scannedRef matches 'scanned'");
  assert(VISUAL_QUERY_SIGNALS.scannedRef.test("OCR the image"), "scannedRef matches 'OCR'");
  assert(VISUAL_QUERY_SIGNALS.scannedRef.test("scan this page"), "scannedRef matches 'scan'");
  assert(VISUAL_QUERY_SIGNALS.scannedRef.test("scan the barcode"), "scannedRef matches 'scan the barcode' (contains standalone 'scan')");
  assert(!VISUAL_QUERY_SIGNALS.pageRef.test("What is the page?"), "pageRef does NOT match 'the page'");

  // Extracted numbers
  const pageMatch = "page 7".match(VISUAL_QUERY_SIGNALS.pageRef);
  assertEqual(pageMatch?.[1], "7", "pageRef extracts number 7");

  const figMatch = "Figure 12.3".match(VISUAL_QUERY_SIGNALS.figureRef);
  assertEqual(figMatch?.[1], "12", "figureRef extracts number 12");

  const chartMatch = "chart 5".match(VISUAL_QUERY_SIGNALS.chartRef);
  assertEqual(chartMatch?.[1], "5", "chartRef extracts number 5");
}

// ============================================================================
// TEST E: Image validation — empty buffer
// ============================================================================
console.log("\n=== TEST E: Image validation — edge cases ===");

{
  const emptyResult = validateImage(Buffer.alloc(0), "image/png");
  assert(!emptyResult.ok, "Empty buffer → not ok");
  assert(emptyResult.error?.includes("empty") ?? false, "Error mentions 'empty'");
}

{
  const oversized = validateImage(Buffer.alloc(30 * 1024 * 1024), "image/png", {
    maxImageSizeBytes: 25 * 1024 * 1024,
    maxImageDimension: 10000,
  });
  assert(!oversized.ok, "30MB buffer with 25MB limit → not ok");
  assert(oversized.error?.includes("25 MB") ?? false, "Error mentions size limit");
}

{
  const tooSmall = validateImage(Buffer.alloc(4), "image/png");
  assert(!tooSmall.ok, "4-byte buffer → not ok (too small for headers)");
}

// ============================================================================
// TEST F: Image MIME detection — PNG/JPEG/WebP
// ============================================================================
console.log("\n=== TEST F: Image MIME detection ===");

{
  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assertEqual(detectImageMime(pngHeader), "image/png", "PNG header → image/png");
}

{
  // JPEG magic bytes: FF D8 FF
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assertEqual(detectImageMime(jpegHeader), "image/jpeg", "JPEG header → image/jpeg");
}

{
  // WebP magic bytes: RIFF....WEBP
  const webpHeader = Buffer.alloc(12);
  webpHeader.write("RIFF", 0, "ascii");
  webpHeader.write("WEBP", 8, "ascii");
  assertEqual(detectImageMime(webpHeader), "image/webp", "WebP header → image/webp");
}

{
  // Unknown format
  const bmpHeader = Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assertEqual(detectImageMime(bmpHeader), null, "BMP header → null (unsupported)");
}

{
  // Too small
  assertEqual(detectImageMime(Buffer.alloc(4)), null, "4-byte buffer → null");
}

// ============================================================================
// TEST G: Image dimension reading — PNG header
// ============================================================================
console.log("\n=== TEST G: Image dimension reading ===");

{
  // Create minimal PNG IHDR: width=100, height=200 at offset 16
  const pngBuf = Buffer.alloc(24);
  pngBuf[0] = 0x89;
  pngBuf[1] = 0x50;
  pngBuf[2] = 0x4e;
  pngBuf[3] = 0x47;
  pngBuf.writeUInt32BE(100, 16); // width
  pngBuf.writeUInt32BE(200, 20); // height
  const dims = readImageDimensions(pngBuf);
  assert(dims !== null, "PNG dimensions read successfully");
  assertEqual(dims?.width, 100, "PNG width = 100");
  assertEqual(dims?.height, 200, "PNG height = 200");
}

{
  // Zero dimensions
  const pngBuf = Buffer.alloc(24);
  pngBuf[0] = 0x89;
  pngBuf[1] = 0x50;
  pngBuf[2] = 0x4e;
  pngBuf[3] = 0x47;
  pngBuf.writeUInt32BE(0, 16);
  pngBuf.writeUInt32BE(0, 20);
  const dims = readImageDimensions(pngBuf);
  assertEqual(dims, null, "Zero dimensions → null");
}

{
  // Too small buffer
  const dims = readImageDimensions(Buffer.alloc(10));
  assertEqual(dims, null, "10-byte buffer → null (too small)");
}

// ============================================================================
// TEST H: Filename sanitization
// ============================================================================
console.log("\n=== TEST H: Filename sanitization ===");

{
  assertEqual(sanitizeFilename("photo.jpg"), "photo.jpg", "Simple filename preserved");
  assertEqual(sanitizeFilename("../../../etc/passwd"), "etc_passwd", "Path traversal stripped");
  assertEqual(sanitizeFilename("my file (copy).png"), "my_file_copy_.png", "Special chars replaced");
  assertEqual(sanitizeFilename("a".repeat(300) + ".jpg"), "a".repeat(200), "Length limited to 200 chars total");
  assertEqual(sanitizeFilename(""), "image", "Empty → 'image'");
  assertEqual(sanitizeFilename("...---..."), "image", "Only dots/dashes → 'image'");
  assertEqual(sanitizeFilename("file name with spaces.jpg"), "file_name_with_spaces.jpg", "Spaces → underscores");
}

// ============================================================================
// TEST I: Storage path generation
// ============================================================================
console.log("\n=== TEST I: Storage path generation ===");

{
  const path = generateImageStoragePath("user-123", "src-456", "photo.jpg");
  assertEqual(path, "user-123/images/src-456/photo.jpg", "Standard path format");
}

{
  const path = generateImageStoragePath("user-123", "src-456", "../../../etc/passwd");
  assert(!path.includes(".."), "Path traversal not in generated path");
  assert(path.startsWith("user-123/images/src-456/"), "Path starts with user prefix");
}

{
  const path = generateImageStoragePath("u1", "s1", "");
  assert(path.includes("image"), "Empty filename defaults to 'image'");
}

// ============================================================================
// TEST J: detectVisualAugmentation query→asset matching
// (Tests the regex patterns and matching logic indirectly via VISUAL_QUERY_SIGNALS)
// ============================================================================
console.log("\n=== TEST J: Visual query detection patterns ===");

{
  // Complex queries with multiple visual references
  const q1 = "What is the difference between Figure 1 on page 3 and Figure 2 on page 5?";
  const pageMatches = q1.match(VISUAL_QUERY_SIGNALS.pageRef);
  const figMatches = q1.match(VISUAL_QUERY_SIGNALS.figureRef);
  assert(pageMatches !== null, "Complex query has page reference");
  assert(figMatches !== null, "Complex query has figure reference");
  assertEqual(pageMatches?.[1], "3", "First page reference is 3");
  assertEqual(figMatches?.[1], "1", "First figure reference is 1");
}

{
  // Query with no visual references
  const q2 = "What is the main topic of this document?";
  assert(!VISUAL_QUERY_SIGNALS.pageRef.test(q2), "No page ref in general query");
  assert(!VISUAL_QUERY_SIGNALS.figureRef.test(q2), "No figure ref in general query");
  assert(!VISUAL_QUERY_SIGNALS.diagramRef.test(q2), "No diagram ref in general query");
  assert(!VISUAL_QUERY_SIGNALS.chartRef.test(q2), "No chart ref in general query");
  assert(!VISUAL_QUERY_SIGNALS.tableRef.test(q2), "No table ref in general query");
  assert(!VISUAL_QUERY_SIGNALS.imageRef.test(q2), "No image ref in general query");
  assert(!VISUAL_QUERY_SIGNALS.scannedRef.test(q2), "No scanned ref in general query");
}

{
  // Query with scanned/OCR intent but no page number
  const q3 = "Can you read the text from this scanned document?";
  assert(VISUAL_QUERY_SIGNALS.scannedRef.test(q3), "scannedRef matches 'scanned document'");
  assert(!VISUAL_QUERY_SIGNALS.pageRef.test(q3), "No page number in scanned query");
}

{
  // Table with tbl abbreviation
  const q4 = "What does tbl 7 show?";
  const tableMatch = q4.match(VISUAL_QUERY_SIGNALS.tableRef);
  assert(tableMatch !== null, "tbl abbreviation matches tableRef");
  assertEqual(tableMatch?.[1], "7", "tbl 7 extracts number 7");
}

{
  // Diagram with flowchart keyword
  const q5 = "Explain flowchart 2";
  const diagMatch = q5.match(VISUAL_QUERY_SIGNALS.diagramRef);
  assert(diagMatch !== null, "flowchart keyword matches diagramRef");
  assertEqual(diagMatch?.[1], "2", "flowchart 2 extracts number 2");
}

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(60));
console.log(`Visual processing tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
}
