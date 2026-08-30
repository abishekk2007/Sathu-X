// ---------------------------------------------------------------------------
// Automated test for structural marker case normalization fix.
// Run with: npx tsx test-structural-fix.ts
// ---------------------------------------------------------------------------

import { extractStructuralMarkers, analyzeQuery } from "./src/lib/retrieval/query-analyzer";
import { validateStructuralPath, scoreHierarchicalStructural } from "./src/lib/retrieval/scoring";

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
// TEST 1: extractStructuralMarkers — case normalization
// ============================================================================
console.log("\n=== TEST 1: extractStructuralMarkers case normalization ===");

{
  // Query uses uppercase "Part B"
  const queryMarkers = extractStructuralMarkers("list all questions in Unit 4 Part B");
  const partMarker = queryMarkers.find((m) => m.type === "part");
  assert(partMarker !== undefined, "Part marker found in query");
  assertEqual(partMarker?.number, "b", "Part marker number is lowercase");
  
  const unitMarker = queryMarkers.find((m) => m.type === "unit");
  assert(unitMarker !== undefined, "Unit marker found in query");
  assertEqual(unitMarker?.number, "4", "Unit marker number is 4");
}

{
  // Content uses lowercase "part b"
  const contentMarkers = extractStructuralMarkers("unit iv\npart b\nquestion 5");
  const partMarker = contentMarkers.find((m) => m.type === "part");
  assert(partMarker !== undefined, "Part marker found in content");
  assertEqual(partMarker?.number, "b", "Part marker number is lowercase (content)");
}

{
  // Mixed case: "PART B" in query
  const markers = extractStructuralMarkers("PART B of UNIT IV");
  const partMarker = markers.find((m) => m.type === "part");
  assertEqual(partMarker?.number, "b", "PART B → lowercase 'b'");
  const unitMarker = markers.find((m) => m.type === "unit");
  assertEqual(unitMarker?.number, "4", "UNIT IV → '4'");
}

{
  // Uppercase roman numeral
  const markers = extractStructuralMarkers("Chapter III");
  const chMarker = markers.find((m) => m.type === "chapter");
  assertEqual(chMarker?.number, "3", "Chapter III → '3'");
}

// ============================================================================
// TEST 2: Scope query detection
// ============================================================================
console.log("\n=== TEST 2: Scope query detection ===");

{
  const analysis = analyzeQuery("list all questions in Unit 4 Part B");
  assert(analysis.scopeQuery === true, "scopeQuery=true for 'list all questions in Unit 4 Part B'");
  assertEqual(analysis.entities.unitNumber, "4", "unitNumber extracted");
  // Note: entities.partLabel comes from extractEntities() which uses its own regex
  // and doesn't normalize. This is acceptable because the scope query path uses
  // structuralPath (which IS normalized) for scope extraction and filtering.
  const partPath = analysis.entities.structuralPath.find((m) => m.type === "part");
  assertEqual(partPath?.number, "b", "structuralPath part is lowercase");
}

{
  const analysis = analyzeQuery("Unit 4 Question 5 Part B");
  assert(analysis.scopeQuery === false, "scopeQuery=false for exact lookup");
  assertEqual(analysis.entities.questionNumber, "5", "questionNumber extracted (5, not 4 from Unit 4)");
  assertEqual(analysis.entities.unitNumber, "4", "unitNumber extracted");
}

{
  const analysis = analyzeQuery("What is normalization?");
  assert(analysis.scopeQuery === false, "scopeQuery=false for semantic query");
}

{
  const analysis = analyzeQuery("list all questions in Chapter 3");
  assert(analysis.scopeQuery === true, "scopeQuery=true for chapter enumeration");
}

// ============================================================================
// TEST 3: validateStructuralPath — cross-case matching
// ============================================================================
console.log("\n=== TEST 3: validateStructuralPath cross-case matching ===");

{
  // Query markers (from raw query): unit=4, part=B
  // Content markers (from lowercased content): unit=4, part=b, question=5
  const queryMarkers = extractStructuralMarkers("Unit 4 Part B Question 5");
  const contentMarkers = extractStructuralMarkers("unit 4\npart b\nquestion 5");
  const result = validateStructuralPath(queryMarkers, contentMarkers);
  assert(result === true, "validateStructuralPath passes with cross-case (Unit 4 Part B Question 5)");
}

{
  // Wrong unit
  const queryMarkers = extractStructuralMarkers("Unit 3 Part B Question 5");
  const contentMarkers = extractStructuralMarkers("unit 4\npart b\nquestion 5");
  const result = validateStructuralPath(queryMarkers, contentMarkers);
  assert(result === false, "validateStructuralPath fails with wrong unit");
}

{
  // Wrong part
  const queryMarkers = extractStructuralMarkers("Unit 4 Part A Question 5");
  const contentMarkers = extractStructuralMarkers("unit 4\npart b\nquestion 5");
  const result = validateStructuralPath(queryMarkers, contentMarkers);
  assert(result === false, "validateStructuralPath fails with wrong part");
}

{
  // Correct path — just unit and part
  const queryMarkers = extractStructuralMarkers("Unit 4 Part B");
  const contentMarkers = extractStructuralMarkers("unit 4\npart b\nquestion 5");
  const result = validateStructuralPath(queryMarkers, contentMarkers);
  assert(result === true, "validateStructuralPath passes for Unit 4 Part B in context");
}

// ============================================================================
// TEST 4: scoreHierarchicalStructural — cross-case matching
// ============================================================================
console.log("\n=== TEST 4: scoreHierarchicalStructural cross-case matching ===");

{
  // Query: "Unit 4 Part B Question 5" (uppercase Part B)
  // Content: "unit 4\npart b\nquestion 5" (lowercase)
  // Preceding: "unit 4\npart b" (lowercase)
  const queryMarkers = extractStructuralMarkers("Unit 4 Part B Question 5");
  const contentLower = "unit 4\npart b\nquestion 5: what is the difference?";
  const precedingLower = "unit 4\npart a\nquestion 1\npart b";
  const result = scoreHierarchicalStructural(queryMarkers, contentLower, precedingLower);
  assert(result.score > 0, `scoreHierarchicalStructural returns > 0 (got ${result.score})`);
  assertEqual(result.matchLevel, "full", "matchLevel is full");
}

{
  // Query: "Unit 4 Part B Question 5"
  // Content from WRONG unit: "unit 3\npart b\nquestion 5"
  const queryMarkers = extractStructuralMarkers("Unit 4 Part B Question 5");
  const contentLower = "unit 3\npart b\nquestion 5: something else";
  const precedingLower = "unit 3\npart b";
  const result = scoreHierarchicalStructural(queryMarkers, contentLower, precedingLower);
  assertEqual(result.score, 0, "score=0 for wrong unit");
}

// ============================================================================
// TEST 5: Scope filter simulation
// ============================================================================
console.log("\n=== TEST 5: Scope filter simulation ===");

{
  // Simulate what buildStructuralContextMap produces (lowercased content)
  // and what the query scope extraction produces
  const scope: { unit?: string | null; part?: string | null } = {};
  const structuralPath = extractStructuralMarkers("list all questions in Unit 4 Part B");
  for (const marker of structuralPath) {
    if (marker.type === "unit") scope.unit = marker.number;
    if (marker.type === "part") scope.part = marker.number;
  }
  assertEqual(scope.unit, "4", "scope.unit = '4'");
  assertEqual(scope.part, "b", "scope.part = 'b' (from query)");

  // Simulate context map entry (from lowercased content)
  const ctx = { unit: "4", part: "b", chapter: null, module: null, section: null, subsection: null };
  
  // Scope filter comparison
  const unitMatch = scope.unit != null ? ctx.unit === scope.unit : true;
  const partMatch = scope.part != null ? ctx.part === scope.part : true;
  assert(unitMatch && partMatch, "Scope filter passes for Unit 4 Part B");
}

// ============================================================================
// TEST 6: Negative cases
// ============================================================================
console.log("\n=== TEST 6: Negative cases ===");

{
  const analysis = analyzeQuery("Unit 4 Question 999 Part B");
  assert(analysis.entities.questionNumber === "999", `Question 999 detected (got ${analysis.entities.questionNumber})`);
  assert(analysis.scopeQuery === false, "Exact lookup, not scope query");
}

// ============================================================================
// TEST 7: General document queries (non-structural)
// ============================================================================
console.log("\n=== TEST 7: General document queries ===");

{
  const analysis = analyzeQuery("what is normalization?");
  assert(analysis.scopeQuery === false, "Semantic query not detected as scope");
  assertEqual(analysis.intent, "definition", "Intent is definition");
}

{
  const analysis = analyzeQuery("explain the definition of functional dependency");
  assert(analysis.scopeQuery === false, "Explanation query not scope");
}

{
  const analysis = analyzeQuery("what does the document say about authentication?");
  assert(analysis.scopeQuery === false, "General content query not scope");
}

// ============================================================================
// TEST 8: Multiple structural formats
// ============================================================================
console.log("\n=== TEST 8: Multiple structural formats ===");

{
  const markers = extractStructuralMarkers("Section 2.1 Subsection 1");
  const secMarker = markers.find((m) => m.type === "section");
  assertEqual(secMarker?.number, "2.1", "Section 2.1 extracted");
  const subsecMarker = markers.find((m) => m.type === "subsection");
  assertEqual(subsecMarker?.number, "1", "Subsection 1 extracted");
}

{
  // Known ambiguity: "Part X" — X is a valid Roman numeral (10).
  // The regex tries Roman numerals first, so "X" → 10.
  // This is acceptable because most documents use "Part A/B/C" for labels
  // and "Part I/II/III/IV" for Roman numerals. "Part X" is ambiguous.
  const markers = extractStructuralMarkers("Part X");
  const partMarker = markers.find((m) => m.type === "part");
  assertEqual(partMarker?.number, "10", "Part X → '10' (X is Roman numeral for 10)");
  
  // But "Part Y" is NOT a Roman numeral, so it should be treated as a label
  const markers2 = extractStructuralMarkers("Part Y");
  const partMarker2 = markers2.find((m) => m.type === "part");
  // "Y" is not in the Roman numeral pattern [ivxlcdm], so it falls through to [a-z]
  // Actually, "y" IS in [ivxlcdm]? No — the pattern is [ivxlcdm] which doesn't include y.
  // Wait, let me check: [ivxlcdm] = i,v,x,l,c,d,m. "y" is NOT in this set.
  // So "Part Y" → letter group [a-z] → "y"
  assertEqual(partMarker2?.number, "y", "Part Y → 'y' (Y is not a Roman numeral)");
}

{
  const markers = extractStructuralMarkers("Exercise 10");
  const exMarker = markers.find((m) => m.type === "exercise");
  assertEqual(exMarker?.number, "10", "Exercise 10 extracted");
}

// ============================================================================
// TEST 10: Exact question lookup — query analysis
// ============================================================================
console.log("\n=== TEST 10: Exact question lookup — query analysis ===");

{
  // "Unit 4 Question 5 Part B" should extract questionNumber=5, unitNumber=4, partLabel=B
  const a = analyzeQuery("Unit 4 Question 5 Part B");
  assertEqual(a.entities.questionNumber, "5", "questionNumber = '5'");
  assertEqual(a.entities.unitNumber, "4", "unitNumber = '4'");
  assertEqual(a.entities.partLabel, "B", "partLabel = 'B'");
  assertEqual(a.scopeQuery, false, "scopeQuery = false (has questionNumber)");
  assertEqual(a.intent, "question_number_lookup", "intent = question_number_lookup");
  // Structural path should have 3 markers
  assertEqual(a.entities.structuralPath.length, 3, "structuralPath has 3 markers");
  // All markers should have lowercase numbers
  const unitM = a.entities.structuralPath.find((m) => m.type === "unit");
  const partM = a.entities.structuralPath.find((m) => m.type === "part");
  const qM = a.entities.structuralPath.find((m) => m.type === "question");
  assertEqual(unitM?.number, "4", "structuralPath unit number = '4'");
  assertEqual(partM?.number, "b", "structuralPath part number = 'b' (lowercase)");
  assertEqual(qM?.number, "5", "structuralPath question number = '5'");
}

{
  // "Q5 Unit IV Part B" — Roman numeral unit
  const a = analyzeQuery("Q5 Unit IV Part B");
  assertEqual(a.entities.questionNumber, "5", "questionNumber = '5'");
  assertEqual(a.entities.unitNumber, "4", "roman unit IV normalized to '4'");
  // structuralPath should have unit iv → 4, question 5, part b
  const unitM = a.entities.structuralPath.find((m) => m.type === "unit");
  assertEqual(unitM?.number, "4", "structuralPath unit number = '4' (from IV)");
  const partM = a.entities.structuralPath.find((m) => m.type === "part");
  assertEqual(partM?.number, "b", "structuralPath part = 'b'");
}

{
  // "5th question in Unit 4 Part B" — ordinal
  const a = analyzeQuery("5th question in Unit 4 Part B");
  assertEqual(a.entities.questionNumber, "5", "questionNumber = '5' from '5th question'");
  assertEqual(a.entities.unitNumber, "4", "unitNumber = '4'");
  assertEqual(a.entities.partLabel, "B", "partLabel = 'B'");
  assertEqual(a.scopeQuery, false, "scopeQuery = false (has questionNumber)");
}

// ============================================================================
// TEST 11: Exact question lookup — structural path validation at distance
// ============================================================================
console.log("\n=== TEST 11: Structural path validation — parent markers at distance ===");

{
  // Simulate: chunk content has "question 5" but NOT "unit 4" or "part b"
  // Preceding context (4K window) has "unit 4" and "part b"
  // Path should be valid
  const qMarkers = extractStructuralMarkers("Unit 4 Question 5 Part B");
  const chunkContent = "question 5: what is the difference between normalization and denormalization?";
  const precedingContent = "unit 4\npart b\nquestion 1\nquestion 2\nquestion 3\nquestion 4";

  const result = scoreHierarchicalStructural(qMarkers, chunkContent.toLowerCase(), precedingContent.toLowerCase());
  assert(result.matchLevel === "full", "Path valid when preceding has unit+part (scoreHierarchicalStructural)");
  assert(result.score > 0, `Score > 0 when path valid (got ${result.score})`);
}

{
  // Simulate: chunk content has "question 5" but preceding window has LOST "unit 4" and "part b"
  // (window too far from Unit 4 header) — OLD CODE would fail, but exact question path bypasses this
  const qMarkers = extractStructuralMarkers("Unit 4 Question 5 Part B");
  const chunkContent = "question 5: what is the difference?";
  const precedingContent = "question 3\nquestion 4"; // No unit/part in window

  const result = scoreHierarchicalStructural(qMarkers, chunkContent.toLowerCase(), precedingContent.toLowerCase());
  assert(result.matchLevel === "none", "Path INVALID when preceding lacks unit+part (demonstrates the bug)");
  assertEqual(result.score, 0, "Score = 0 when path invalid (the sliding-window bug)");
}

{
  // validateStructuralPath — full path in allContextMarkers
  const qMarkers = extractStructuralMarkers("Unit 4 Question 5 Part B");
  const allMarkers = [
    { type: "unit" as const, number: "4" },
    { type: "part" as const, number: "b" },
    { type: "question" as const, number: "5" },
  ];
  assert(validateStructuralPath(qMarkers, allMarkers), "validateStructuralPath passes with full path in markers");
}

{
  // validateStructuralPath — missing part marker
  const qMarkers = extractStructuralMarkers("Unit 4 Question 5 Part B");
  const allMarkers = [
    { type: "unit" as const, number: "4" },
    { type: "question" as const, number: "5" },
  ];
  assert(!validateStructuralPath(qMarkers, allMarkers), "validateStructuralPath fails when part marker missing");
}

// ============================================================================
// TEST 12: Exact question lookup — context map path matching logic
// ============================================================================
console.log("\n=== TEST 12: Context map path matching logic ===");

{
  // Simulate context map scenario: chunks spread across Unit 4, Part A, Part B
  const chunks = [
    { chunk_index: 0, content: "Unit 4\nDatabase Design Principles" },
    { chunk_index: 1, content: "Part A\nIntroduction to Databases" },
    { chunk_index: 2, content: "Question 1: What is a database?" },
    { chunk_index: 3, content: "Question 2: What is normalization?" },
    { chunk_index: 4, content: "Part B\nAdvanced Topics" },
    { chunk_index: 5, content: "Question 5: What is the difference between?" },
    { chunk_index: 6, content: "Normalization and denormalization?" },
    { chunk_index: 7, content: "Question 6: Explain ACID properties." },
  ];

  // Build context map (same logic as buildStructuralContextMap in document-retrieval.ts)
  const map = new Map();
  const current: Record<string, string | null> = { unit: null, module: null, chapter: null, section: null, subsection: null, part: null };
  for (const chunk of chunks) {
    const markers = extractStructuralMarkers(chunk.content.toLowerCase());
    for (const marker of markers) {
      if (marker.type in current) {
        current[marker.type] = marker.number;
      }
    }
    map.set(chunk.chunk_index, { ...current });
  }

  // Chunk 5 (Question 5) should have unit=4, part=b
  const ctx5 = map.get(5);
  assertEqual(ctx5?.unit, "4", "Context map: chunk 5 unit = '4'");
  assertEqual(ctx5?.part, "b", "Context map: chunk 5 part = 'b'");

  // Chunk 2 (Question 1 in Part A) should have unit=4, part=a
  const ctx2 = map.get(2);
  assertEqual(ctx2?.unit, "4", "Context map: chunk 2 unit = '4'");
  assertEqual(ctx2?.part, "a", "Context map: chunk 2 part = 'a'");

  // Path match for "Unit 4 Part B" — chunk 5 matches, chunk 2 doesn't
  function isPathMatch(ctx: { unit: string | null; part: string | null; chapter: string | null; module: string | null; section: string | null; subsection: string | null }, required: Record<string, string>): boolean {
    for (const [type, value] of Object.entries(required)) {
      if (value && ctx[type as keyof typeof ctx] !== value) return false;
    }
    return true;
  }

  const requiredPath = { unit: "4", part: "b" };
  assert(isPathMatch(ctx5, requiredPath), "Chunk 5 matches Unit 4 Part B");
  assert(!isPathMatch(ctx2, requiredPath), "Chunk 2 does NOT match Unit 4 Part B (part is 'a')");

  // Simulate exact question lookup: find "Question 5" and validate path
  const questionRe = /\b(?:question|q\.?)\s*(?:no\.?\s*)?5\b/i;
  let found = false;
  let foundCtx = null;
  for (const chunk of chunks) {
    if (questionRe.test(chunk.content)) {
      const ctx = map.get(chunk.chunk_index);
      if (ctx && isPathMatch(ctx, requiredPath)) {
        found = true;
        foundCtx = ctx;
        break;
      }
    }
  }
  assert(found, "Exact question lookup found Question 5 in Unit 4 Part B via context map");
  assertEqual(foundCtx?.unit, "4", "Found chunk has unit = '4'");
  assertEqual(foundCtx?.part, "b", "Found chunk has part = 'b'");

  // Verify Question 1 in Part A is NOT returned
  const q1Re = /\b(?:question|q\.?)\s*(?:no\.?\s*)?1\b/i;
  let foundQ1 = false;
  for (const chunk of chunks) {
    if (q1Re.test(chunk.content)) {
      const ctx = map.get(chunk.chunk_index);
      if (ctx && isPathMatch(ctx, requiredPath)) {
        foundQ1 = true;
        break;
      }
    }
  }
  assert(!foundQ1, "Question 1 in Part A does NOT match Unit 4 Part B path");
}

// ============================================================================
// TEST 13: Question block collection stops at next question
// ============================================================================
console.log("\n=== TEST 13: Question block collection stops at next question ===");

{
  const chunks = [
    { chunk_index: 10, content: "Some context before" },
    { chunk_index: 11, content: "Part B\nAdvanced Topics" },
    { chunk_index: 12, content: "Question 5: What is normalization?" },
    { chunk_index: 13, content: "Normalization is the process of..." },
    { chunk_index: 14, content: "organizing data to reduce redundancy." },
    { chunk_index: 15, content: "Question 6: What is ACID?" },
    { chunk_index: 16, content: "ACID stands for Atomicity..." },
  ];

  const questionRe = /\b(?:question|q\.?)\s*(?:no\.?\s*)?5\b/i;
  const anyQuestionRe = /\b(?:question|q\.?)\s*\d+/i;

  const collected = [];
  let insideBlock = false;
  for (const chunk of chunks) {
    if (insideBlock) {
      if (anyQuestionRe.test(chunk.content)) break;
      collected.push(chunk);
    } else if (questionRe.test(chunk.content)) {
      collected.push(chunk);
      insideBlock = true;
    }
  }

  assertEqual(collected.length, 3, "Collected 3 chunks: Q5 start + 2 continuation (stops before Q6)");
  assertEqual(collected[0].chunk_index, 12, "First chunk is chunk 12 (Question 5)");
  assertEqual(collected[2].chunk_index, 14, "Last chunk is chunk 14 (before Q6)");
}

// ============================================================================
// TEST 14: QUESTION_NUM_RE — does NOT match "4" from "Unit 4" before "Question 5"
// ============================================================================
console.log("\n=== TEST 14: QUESTION_NUM_RE — no false match from 'Unit 4' ===");

{
  const re = /(?:(?:question(?:\s+(?:no\.?|number))?|q\.?)\s*(\d{1,4})|(?<!\b(?:unit|chapter|section|module|part|page)\s+)(\d{1,4})(?:st|nd|rd|th)?\s+(?:question|q))\b/i;
  
  const m1 = re.exec("Unit 4 Question 5 Part B");
  assertEqual(m1?.[1], "5", "Unit 4 Question 5 → captures '5' from Question, not '4' from Unit");
  assertEqual(m1?.[2], undefined, "Second group (ordinal) not matched");
  
  const m2 = re.exec("5th question in Unit 4");
  assertEqual(m2?.[1], undefined, "5th question → first group (question prefix) not matched");
  assertEqual(m2?.[2], "5", "5th question → captures '5' from ordinal");

  const m3 = re.exec("Q5 Unit IV");
  assertEqual(m3?.[1], "5", "Q5 → captures '5'");
  
  const m4 = re.exec("Unit 4 Part B");
  assertEqual(m4, null, "Unit 4 Part B → no question number match");
}

// ============================================================================
// SUMMARY
// ============================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  process.exit(1);
}
