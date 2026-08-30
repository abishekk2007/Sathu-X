// ---------------------------------------------------------------------------
// Phase 5G — RAG Evaluation: shared types
//
// The evaluation framework OBSERVES and SCORES the existing Spidey Bot RAG
// system. It does NOT re-implement retrieval. It drives the existing pure
// functions (analyzeQuery, scoreChunk, scoreHierarchicalStructural,
// validateStructuralPath, promoteStructuralMatches, validateStructuralMatch,
// filterDuplicates, boundContext, source selection, multi-source orchestration)
// against synthetic arbitrary documents and scores whether the correct
// evidence is retrieved at the correct location.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Evaluation dataset format (Step 3)
// ---------------------------------------------------------------------------

/**
 * Structural anchors available for a test query. All optional — a generic
 * document need not be a question bank. The evaluator only uses fields that
 * are actually present (Step 6 / Step 7).
 */
export interface ExpectedLocation {
  document?: string;
  page?: number;
  unit?: string;
  module?: string;
  chapter?: string;
  section?: string;
  subsection?: string;
  part?: string;
  question?: string;
  exercise?: string;
  problem?: string;
  example?: string;
  theorem?: string;
  definition?: string;
  figure?: string;
  table?: string;
  topic?: string;
}

/**
 * A single evaluation test case. Only `id`, `query`, and `category` are
 * required. Everything else is optional so that 5G supports arbitrary
 * document types (Step 3 / Step 7).
 */
export interface EvaluationCase {
  id: string;
  category: string;
  query: string;
  /** Expected source / document display names. */
  expectedSources?: string[];
  /** Expected exact structural path (Step 6). */
  expectedLocation?: ExpectedLocation;
  /** Keywords or phrases that MUST appear in the top retrieved evidence. */
  expectedAnswerEvidence?: string[];
  /** Keywords/phrases that the answer evidence must NOT contain. */
  forbiddenEvidence?: string[];
  /** Should the system retrieve evidence for this query? */
  shouldRetrieve?: boolean;
  /** Should the system refuse / decline to fabricate an answer? */
  shouldRefuse?: boolean;
  /** Multi-document expectation. */
  multiSource?: boolean;
  /** Visual expectation (chart/figure/table/diagram/image/scanned). */
  visual?: boolean;
  /** Optional free-text correctness note (e.g. is it a cross-chunk query). */
  note?: string;
}

export type EvaluationCategory =
  | "semantic"
  | "topic"
  | "page"
  | "section"
  | "unit"
  | "part"
  | "exact_question"
  | "arbitrary_location"
  | "cross_chunk"
  | "long_document"
  | "negative"
  | "structural_negative"
  | "similar_content"
  | "multi_document"
  | "multi_document_negative"
  | "visual"
  | "text_visual_fusion"
  | "source_attribution"
  | "follow_up"
  | "general_chat"
  | "structural_path"
  | "hallucination"
  | "regression";

// ---------------------------------------------------------------------------
// Evaluation outcome / metrics (Step 5, Step 8, Step 11)
// ---------------------------------------------------------------------------

/**
 * Failure classifications (Step 11). Exactly one primary classification per
 * failed test.
 */
export type FailureClassification =
  | "INGESTION_FAILURE"
  | "CHUNKING_FAILURE"
  | "QUERY_ANALYSIS_FAILURE"
  | "STRUCTURAL_RETRIEVAL_FAILURE"
  | "SEMANTIC_RETRIEVAL_FAILURE"
  | "RERANKING_FAILURE"
  | "SOURCE_SELECTION_FAILURE"
  | "MULTI_SOURCE_FAILURE"
  | "VISUAL_RETRIEVAL_FAILURE"
  | "GROUNDING_FAILURE"
  | "GENERATION_FAILURE"
  | "AUTH_FAILURE"
  | "CACHE_FAILURE"
  | "STREAMING_FAILURE"
  | "UNKNOWN";

export type TestStatus = "pass" | "fail" | "unmeasurable";

export interface TestResult {
  id: string;
  category: string;
  query: string;
  status: TestStatus;
  /** 0–1 relevance: did the correct evidence rank at the top? */
  relevant: boolean;
  /** Which expected evidence needles were found in retrieved chunks. */
  foundEvidence: string[];
  /** Expected evidence needles that were NOT found. */
  missingEvidence: string[];
  /** Structural path matches (exact/partial/none). */
  structuralMatch?: "exact" | "partial" | "none" | "n/a";
  /** Page accuracy (true when asked page matches retrieved page). */
  pageCorrect?: boolean;
  /** Classification when failed. */
  classification?: FailureClassification;
  /** Pipeline stage where the failure occurred. */
  pipelineStage?: string;
  /** File + function where the failure surfaced. */
  location?: string;
  /** Human-readable reproduction steps. */
  reproduction?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Synthetic document primitives (arbitrary document support, Step 7)
// ---------------------------------------------------------------------------

/**
 * A single chunk extracted from a synthetic document.
 * Mirrors the `document_chunks` row shape used by production retrieval.
 */
export interface EvalChunk {
  id: string;
  content: string;
  chunk_index: number;
  page_number: number | null;
}

/**
 * A synthetic document to evaluate against. Generic — may be a textbook,
 * research paper, resume, PPTX dump, DOCX dump, or any arbitrary text.
 */
export interface SyntheticDocument {
  id: string;
  name: string;
  /** Display name used for source attribution checks. */
  displayName: string;
  type: string;
  chunks: EvalChunk[];
}

// ---------------------------------------------------------------------------
// Metric bundle (Step 5)
// ---------------------------------------------------------------------------

export interface MetricsReport {
  category: string;
  total: number;
  passed: number;
  failed: number;
  unmeasurable: number;
  precisionAt1: number | null;
  precisionAt3: number | null;
  recallAtK: number | null;
  hitRate: number | null;
  mrr: number | null;
  structuralAccuracy: number | null;
  pageAccuracy: number | null;
  sourceAccuracy: number | null;
  negativeAccuracy: number | null;
  visualAccuracy: number | null;
}

export interface EvaluationReport {
  cases: TestResult[];
  metricsByCategory: MetricsReport[];
  overall: MetricsReport;
  before: number;
  after: number;
}
