// ---------------------------------------------------------------------------
// Visual query intent detection — Phase 5E-2
// Determines whether a query requires visual evidence, text evidence, or both.
// Uses VISUAL_QUERY_SIGNALS from 5E-1 but adds structured intent classification.
// ---------------------------------------------------------------------------

import { VISUAL_QUERY_SIGNALS } from "@/lib/multimodal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VisualIntentType = "none" | "visual" | "mixed";

export interface VisualQueryIntent {
  type: VisualIntentType;
  /** Specific visual reference types detected. */
  references: VisualReference[];
  /** Whether the query also contains substantial textual/analytical content. */
  hasTextualAnalysis: boolean;
}

export interface VisualReference {
  kind:
    | "page"
    | "figure"
    | "diagram"
    | "chart"
    | "table"
    | "image"
    | "scanned";
  /** Extracted number, if any (e.g. "8" from "page 8"). */
  number?: number;
  /** The raw matched string. */
  raw: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Classify the visual intent of a user query.
 *
 * Returns:
 * - "none"   → purely text query, no visual evidence needed
 * - "visual" → query is primarily about visual content (diagram, chart, etc.)
 * - "mixed"  → query references visual content AND asks for textual analysis
 */
export function detectVisualIntent(query: string): VisualQueryIntent {
  const references: VisualReference[] = [];

  // Collect all visual references from the query
  collectReferences(query, references);

  if (references.length === 0) {
    return { type: "none", references: [], hasTextualAnalysis: false };
  }

  // Determine if the query also has substantial textual/analytical content
  // beyond just the visual reference.
  const hasTextualAnalysis = detectTextualAnalysis(query, references);

  // If there are visual references and textual analysis → mixed
  // If visual references dominate with minimal text → visual
  const type: VisualIntentType = hasTextualAnalysis ? "mixed" : "visual";

  return { type, references, hasTextualAnalysis };
}

// ---------------------------------------------------------------------------
// Reference collection
// ---------------------------------------------------------------------------

// Word → number map for "page four", "on page seven", etc.
const PAGE_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

const PAGE_NUMERIC_RE = /\b(?:page|pg\.?|pp\.?)\s*(?:no\.?\s*|number\s*)?(\d{1,4})\b/gi;
const PAGE_ORDINAL_RE = /\b(?:the\s+)?(\d{1,4})(?:st|nd|rd|th)\s+(?:page|pg\.?)\b/gi;
const PAGE_WORD_RE = /\b(?:page|pg\.?|pp\.?)\s*(?:no\.?\s*|number\s*)?([a-z]{3,}(?:-[a-z]+)?)\b/gi;

/**
 * Parse ALL page numbers referenced by a query regardless of phrasing.
 * Handles: "page 4", "page no 4", "page number 4", "page no. 4", "pg 4",
 * "on the 4th page", "on page four", "pages 7 and 9".
 */
export function parsePageNumbers(query: string): number[] {
  const pages = new Set<number>();

  const numeric = query.matchAll(PAGE_NUMERIC_RE);
  for (const m of numeric) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isInteger(n) && n >= 1 && n <= 9999) pages.add(n);
  }

  const ordinal = query.matchAll(PAGE_ORDINAL_RE);
  for (const m of ordinal) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isInteger(n) && n >= 1 && n <= 9999) pages.add(n);
  }

  const word = query.matchAll(PAGE_WORD_RE);
  for (const m of word) {
    const w = m[1].toLowerCase();
    const n = PAGE_WORDS[w];
    if (n != null) pages.add(n);
  }

  // Deduplicate against base words mangling ("pagepage") — nothing to do.
  return [...pages].sort((a, b) => a - b);
}

/**
 * Parse the FIRST page number referenced by a query (or undefined).
 */
export function parseFirstPageNumber(query: string): number | undefined {
  const pages = parsePageNumbers(query);
  return pages.length > 0 ? pages[0] : undefined;
}

function collectReferences(query: string, refs: VisualReference[]): void {
  // Page references — supports "page 4", "page no 4", "page number 4",
  // "on the 4th page", "on page four". Numbered first, then the rest.
  for (const number of parsePageNumbers(query)) {
    if (!refs.some((r) => r.kind === "page" && r.number === number)) {
      refs.push({ kind: "page", number, raw: `page ${number}` });
    }
  }

  // Figure references
  let match: RegExpMatchArray | null;
  match = query.match(VISUAL_QUERY_SIGNALS.figureRef);
  if (match) {
    refs.push({
      kind: "figure",
      number: Number.parseInt(match[1], 10),
      raw: match[0],
    });
  }

  // Diagram references
  match = query.match(VISUAL_QUERY_SIGNALS.diagramRef);
  if (match) {
    refs.push({
      kind: "diagram",
      number: Number.parseInt(match[1], 10),
      raw: match[0],
    });
  }

  // Chart references
  match = query.match(VISUAL_QUERY_SIGNALS.chartRef);
  if (match) {
    refs.push({
      kind: "chart",
      number: Number.parseInt(match[1], 10),
      raw: match[0],
    });
  }

  // Table references
  match = query.match(VISUAL_QUERY_SIGNALS.tableRef);
  if (match) {
    refs.push({
      kind: "table",
      number: Number.parseInt(match[1], 10),
      raw: match[0],
    });
  }

  // Image references
  match = query.match(VISUAL_QUERY_SIGNALS.imageRef);
  if (match) {
    refs.push({
      kind: "image",
      number: Number.parseInt(match[1], 10),
      raw: match[0],
    });
  }

  // Scanned/OCR references (no number)
  match = query.match(VISUAL_QUERY_SIGNALS.scannedRef);
  if (match) {
    refs.push({
      kind: "scanned",
      raw: match[0],
    });
  }

  // Generic visual keywords without specific references:
  // "the diagram", "the chart", "shown above", "in the figure", etc.
  addGenericVisualReferences(query, refs);
}

/**
 * Detect generic visual references that don't match the specific patterns
 * (e.g. "the diagram", "the chart shown above", "this figure").
 */
function addGenericVisualReferences(
  query: string,
  refs: VisualReference[]
): void {
  // Avoid duplicates: if we already found a specific reference of this kind,
  // skip the generic version.
  const existingKinds = new Set(refs.map((r) => r.kind));

  if (
    !existingKinds.has("diagram") &&
    /(?<![a-z])(?:the|this|that|a)\s+(?:diagrams?|flowcharts?|mindmaps?|architecture)\b/i.test(query)
  ) {
    refs.push({ kind: "diagram", raw: "diagram reference" });
  }

  if (
    !existingKinds.has("chart") &&
    /(?<![a-z])(?:the|this|that|a)\s+(?:charts?|graphs?|plots?|histograms?)\b/i.test(query)
  ) {
    refs.push({ kind: "chart", raw: "chart reference" });
  }

  if (
    !existingKinds.has("table") &&
    /(?<![a-z])(?:the|this|that|a)\s+(?:tables?|spreadsheets?)\b/i.test(query)
  ) {
    refs.push({ kind: "table", raw: "table reference" });
  }

  if (
    !existingKinds.has("figure") &&
    /(?<![a-z])(?:the|this|that|a)\s+(?:figures?|illustrations?|pictures?|images?)\b/i.test(query)
  ) {
    refs.push({ kind: "figure", raw: "figure reference" });
  }

  // "shown above/below", "in the image", "from the picture"
  if (
    !existingKinds.has("figure") &&
    /\b(?:shown|depicted|illustrated|displayed)\s+(?:above|below|here|in)\b/i.test(query)
  ) {
    refs.push({ kind: "figure", raw: "visual reference" });
  }
}

// ---------------------------------------------------------------------------
// Textual analysis detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the query contains substantial textual/analytical content
 * beyond just referencing visual elements.
 *
 * "What does the diagram show?" → visual (minimal text analysis)
 * "According to the diagram, why does X connect to Y?" → mixed (reasoning)
 * "Compare the chart on page 4 with the text on page 5" → mixed (comparison)
 */
function detectTextualAnalysis(
  query: string,
  refs: VisualReference[]
): boolean {
  const lower = query.toLowerCase();

  // Strong textual analysis indicators
  const analysisPatterns = [
    /\b(?:why|how|explain|reason|because|cause|effect)\b/i,
    /\b(?:compare|contrast|difference|similar|relate)\b/i,
    /\b(?:according to|based on|from)\b.*\b(?:text|paragraph|section|passage|content)\b/i,
    /\b(?:what does|what do)\s+(?:the\s+)?(?:text|paragraph|section|passage|content)\s+(?:say|state|mention|describe)\b/i,
    /\b(?:summarize|analyse|analyze|interpret|describe)\b.*\b(?:text|content|passage|section)\b/i,
    /\b(?:and|plus|also|additionally|furthermore|moreover)\b.*\b(?:text|content|passage|explanation|description)\b/i,
    /\b(?:what|which|who|when|where)\s+(?:is|are|was|were)\s+(?:the|this|that)\b.*\b(?:about|regarding|concerning)\b/i,
  ];

  // Check if any analysis patterns match
  const hasAnalysisIntent = analysisPatterns.some((p) => p.test(query));

  // Check if the query has significant text beyond visual references
  let strippedQuery = lower;
  for (const ref of refs) {
    strippedQuery = strippedQuery.replace(ref.raw.toLowerCase(), "");
  }
  // Remove common stop words and visual keywords
  strippedQuery = strippedQuery
    .replace(
      /\b(?:the|a|an|this|that|what|does|do|show|showing|shown|depicted|illustrated|displayed|in|on|of|for|from|about|above|below|here|please|can|you|could|would|explain|describe|tell|me|look|at|see|find)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  // If substantial text remains after stripping visual references → mixed
  const hasSignificantText = strippedQuery.split(" ").filter(Boolean).length >= 4;

  return hasAnalysisIntent || hasSignificantText;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the target page numbers from visual references.
 * Returns unique page numbers sorted ascending.
 */
export function getTargetPages(refs: VisualReference[]): number[] {
  const pages = new Set<number>();
  for (const ref of refs) {
    if (ref.number != null && ref.kind === "page") {
      pages.add(ref.number);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Get the target visual kinds from references.
 */
export function getTargetVisualKinds(
  refs: VisualReference[]
): Set<string> {
  const kinds = new Set<string>();
  for (const ref of refs) {
    if (ref.kind !== "page") kinds.add(ref.kind);
  }
  return kinds;
}
