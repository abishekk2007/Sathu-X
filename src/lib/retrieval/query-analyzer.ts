// ---------------------------------------------------------------------------
// Query Analyzer — normalization, intent detection, entity extraction.
// Phase 5C + Phase 5D.1: Universal Structural Retrieval
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stop words
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below", "between",
  "out", "off", "over", "under", "again", "further", "then", "once", "here",
  "there", "when", "where", "why", "how", "all", "both", "each", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "because", "if", "it", "its",
  "this", "that", "these", "those", "what", "which", "who", "whom", "i",
  "me", "my", "we", "our", "you", "your", "he", "him", "his", "she", "her",
  "they", "them", "their", "about", "also", "please", "tell", "give",
  "show", "let", "make", "like", "want", "know", "think",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryIntent =
  | "factual_lookup"
  | "explanation"
  | "summary"
  | "comparison"
  | "definition"
  | "example"
  | "list"
  | "procedure"
  | "question_number_lookup"
  | "section_lookup"
  | "page_lookup"
  | "broad_topic_search";

export interface ExtractedEntities {
  questionNumber: string | null;
  sectionNumber: string | null;
  chapterNumber: string | null;
  unitNumber: string | null;
  pageNumber: string | null;
  partLabel: string | null;
  exampleNumber: string | null;
  moduleNumber: string | null;
  topicName: string | null;
  figureNumber: string | null;
  tableNumber: string | null;
  quotedPhrases: string[];
  headingPhrases: string[];
  /** Hierarchical structural path extracted from the query. */
  structuralPath: StructuralMarker[];
}

/**
 * A detected structural marker in query or content.
 * Type + number uniquely identify a location in the document hierarchy.
 */
export interface StructuralMarker {
  type: StructuralMarkerType;
  number: string;
  /** Raw matched text for heading/title references. */
  rawText?: string;
}

export type StructuralMarkerType =
  | "unit"
  | "module"
  | "chapter"
  | "section"
  | "subsection"
  | "part"
  | "question"
  | "exercise"
  | "problem"
  | "example"
  | "theorem"
  | "definition"
  | "figure"
  | "table"
  | "topic"
  | "page";

export interface QueryAnalysis {
  originalQuery: string;
  normalizedQuery: string;
  importantTokens: string[];
  allTokens: string[];
  intent: QueryIntent;
  entities: ExtractedEntities;
  /** True when the query asks for ALL items of a type within a structural scope (e.g., "questions in Unit 4 Part B"). */
  scopeQuery: boolean;
}

// ---------------------------------------------------------------------------
// Query normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a user query for retrieval purposes.
 * Preserves meaning while removing noise.
 */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/–|—/g, "-")
    .replace(/…/g, "...")
    .replace(/[^a-z0-9\s\-_.']/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

export function tokenizeImportant(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

export function tokenizeAll(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

// ---------------------------------------------------------------------------
// Roman numeral support
// ---------------------------------------------------------------------------

const ROMAN_VALUES: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9,
  x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17,
  xviii: 18, xix: 19, xx: 20, xxi: 21, xxii: 22, xxiii: 23, xxiv: 24, xxv: 25,
};

/** Convert Roman numeral string to Arabic number. Returns null if not a valid Roman numeral. */
function romanToArabic(roman: string): string | null {
  const lower = roman.toLowerCase();
  const val = ROMAN_VALUES[lower];
  return val !== undefined ? String(val) : null;
}

/** Ordinal words to number mapping. */
const ORDINAL_WORDS: Record<string, string> = {
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5",
  sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10",
  eleventh: "11", twelfth: "12", thirteenth: "13", fourteenth: "14", fifteenth: "15",
  sixteenth: "16", seventeenth: "17", eighteenth: "18", nineteenth: "19", twentieth: "20",
};

/** Convert ordinal word to number. Returns null if not an ordinal word. */
function ordinalToNumber(word: string): string | null {
  return ORDINAL_WORDS[word.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Structural marker extraction (from any text)
// ---------------------------------------------------------------------------

/**
 * Regex patterns for structural markers.
 * Each pattern captures the number/label after the structural keyword.
 * Supports: Arabic numerals, Roman numerals, ordinal words, and alphanumeric labels.
 */
const STRUCTURAL_PATTERNS: Array<{ type: StructuralMarkerType; re: RegExp }> = [
  { type: "unit",       re: /\b(?:unit)\s+(?:([ivxlcdm]{1,10})|(\d{1,3})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "module",     re: /\b(?:module)\s+(?:([ivxlcdm]{1,10})|(\d{1,3})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "chapter",    re: /\b(?:chapter|ch\.?)\s+(?:([ivxlcdm]{1,10})|(\d{1,3})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "section",    re: /\b(?:section|sec\.?)\s+(?:([ivxlcdm]{1,10})|(\d{1,3}(?:\.\d{1,3})?)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "subsection", re: /\b(?:subsection|sub-section|sub\.?\s*section)\s+(?:([ivxlcdm]{1,10})|(\d{1,3}(?:\.\d{1,3})?)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "part",       re: /\b(?:part)\s+(?:([ivxlcdm]{1,10})|([a-z])|(\d{1,3})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "question",   re: /\b(?:(?:question(?:\s+(?:no\.?|number))?|q\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))|(?<!\b(?:unit|chapter|section|module|part|page)\s+)(?:([ivxlcdm]{1,10})|(\d{1,4})(?:st|nd|rd|th)?|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\s+(?:question|q))\b/ig },
  { type: "exercise",   re: /\b(?:exercise|ex\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "problem",    re: /\b(?:problem|prb\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "example",    re: /\b(?:example|ex\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "theorem",    re: /\b(?:theorem|thm\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "definition", re: /\b(?:definition|def\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "figure",     re: /\b(?:figure|fig\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "table",      re: /\b(?:table|tbl\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "topic",      re: /\b(?:topic)\s+(?:([ivxlcdm]{1,10})|(\d{1,3}(?:\.\d{1,3})?)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
  { type: "page",       re: /\b(?:page|pg\.?|p\.)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/ig },
];

/**
 * Extract all structural markers from a text string.
 * Returns markers in order of appearance.
 */
export function extractStructuralMarkers(text: string): StructuralMarker[] {
  const markers: StructuralMarker[] = [];
  const seen = new Set<string>();

  for (const { type, re } of STRUCTURAL_PATTERNS) {
    for (const match of text.matchAll(re)) {
      let number: string | null = null;

      // Try Roman numeral group
      if (match[1]) number = romanToArabic(match[1]);
      else if (match[4]) number = romanToArabic(match[4]);
      
      // Try Arabic numeral group
      if (!number && match[2]) number = match[2];
      else if (!number && match[5]) number = match[5];
      
      // Try ordinal word group
      if (!number && match[3]) number = ordinalToNumber(match[3]);
      else if (!number && match[6]) number = ordinalToNumber(match[6]);

      if (number) {
        // Normalize to lowercase so markers are consistent regardless of
        // input case.  Roman numerals and ordinal words already return
        // lowercase/digits from their helper functions, but letter-based
        // labels (e.g. part "B") are captured raw and must be lowered.
        number = number.toLowerCase();
        const key = `${type}:${number}`;
        if (!seen.has(key)) {
          seen.add(key);
          markers.push({ type, number, rawText: match[0] });
        }
      }
    }
  }

  // Sort by position in original text
  markers.sort((a, b) => {
    const aIdx = text.toLowerCase().indexOf(`${a.type} ${a.number}`) ?? 0;
    const bIdx = text.toLowerCase().indexOf(`${b.type} ${b.number}`) ?? 0;
    return aIdx - bIdx;
  });

  return markers;
}

// ---------------------------------------------------------------------------
// Legacy entity extraction (preserved for backward compatibility)
// ---------------------------------------------------------------------------

const QUESTION_NUM_RE = /(?:(?:question(?:\s+(?:no\.?|number))?|q\.?)\s*(\d{1,4})|(?<!\b(?:unit|chapter|section|module|part|page)\s+)(\d{1,4})(?:st|nd|rd|th)?\s+(?:question|q))\b/i;
const SECTION_NUM_RE = /(?:section|sec\.?)\s*(\d{1,3}(?:\.\d{1,3})?)\b/i;
const CHAPTER_NUM_RE = /(?:chapter|ch\.?)\s*(\d{1,3})\b/i;
const UNIT_NUM_RE = /(?:unit)\s*(\d{1,3})\b/i;
const PAGE_NUM_RE = /(?:page|pg\.?|p\.)\s*(\d{1,4})\b/i;
const QUOTED_RE = /"([^"]{2,80})"/g;
const SINGLE_QUOTED_RE = /'([^']{2,80})'/g;

export function extractEntities(query: string): ExtractedEntities {
  const questionMatch = QUESTION_NUM_RE.exec(query);
  const sectionMatch = SECTION_NUM_RE.exec(query);
  const chapterMatch = CHAPTER_NUM_RE.exec(query);
  const unitMatch = UNIT_NUM_RE.exec(query);
  const pageMatch = PAGE_NUM_RE.exec(query);

  // Extended structural entities
  const partMatch = /\bpart\s+(?:([ivxlcdm]{1,10})|([a-z])|(\d{1,3})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/i.exec(query);
  const exampleMatch = /\b(?:example|ex\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/i.exec(query);
  const moduleMatch = /\bmodule\s+(?:([ivxlcdm]{1,10})|(\d{1,3})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/i.exec(query);
  const topicMatch = /\btopic\s+(?:([ivxlcdm]{1,10})|(\d{1,3}(?:\.\d{1,3})?)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/i.exec(query);
  const figureMatch = /\b(?:figure|fig\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/i.exec(query);
  const tableMatch = /\b(?:table|tbl\.?)\s*(?:([ivxlcdm]{1,10})|(\d{1,4})|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))\b/i.exec(query);

  const quotedPhrases: string[] = [];
  for (const m of query.matchAll(QUOTED_RE)) {
    quotedPhrases.push(m[1].toLowerCase());
  }
  for (const m of query.matchAll(SINGLE_QUOTED_RE)) {
    quotedPhrases.push(m[1].toLowerCase());
  }

  // Heading phrases: "Section 2: Normalization", "Chapter 3 - Indexing", etc.
  const headingPhrases: string[] = [];
  const headingRe = /(?:section|sec\.?|chapter|ch\.?|unit|part|module|topic)\s+\d+(?:\.\d+)?\s*[-:.]?\s+([A-Z][a-zA-Z\s]{2,40})/gi;
  for (const m of query.matchAll(headingRe)) {
    headingPhrases.push(m[1].toLowerCase().trim());
  }

  // Extract the full hierarchical structural path from the query
  const structuralPath = extractStructuralMarkers(query);

  // Helper: first normalized number from the structural path for a type.
  // The path markers are roman/ordinal aware (extractStructuralMarkers), so
  // "Chapter III", "Section II", "Unit IV", "fifth question" all normalize to
  // arabic here — the legacy numeric regexes below are kept as fallbacks.
  function pathNum(type: StructuralMarkerType): string | null {
    return structuralPath.find((m) => m.type === type)?.number ?? null;
  }

  // Helper to extract number from match groups
  function extractNum(m: RegExpExecArray | null): string | null {
    if (!m) return null;
    if (m[1]) return romanToArabic(m[1]);
    if (m[2]) return m[2];
    if (m[3]) return ordinalToNumber(m[3]);
    return null;
  }

  return {
    questionNumber: pathNum("question") ?? questionMatch?.[1] ?? questionMatch?.[2] ?? null,
    sectionNumber: pathNum("section") ?? sectionMatch?.[1] ?? null,
    chapterNumber: pathNum("chapter") ?? chapterMatch?.[1] ?? null,
    unitNumber: pathNum("unit") ?? unitMatch?.[1] ?? null,
    pageNumber: pathNum("page") ?? pageMatch?.[1] ?? null,
    partLabel: extractNum(partMatch),
    exampleNumber: extractNum(exampleMatch),
    moduleNumber: extractNum(moduleMatch),
    topicName: topicMatch?.[0] ?? null,
    figureNumber: extractNum(figureMatch),
    tableNumber: extractNum(tableMatch),
    quotedPhrases,
    headingPhrases,
    structuralPath,
  };
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

function detectIntent(query: string, entities: ExtractedEntities): QueryIntent {
  const q = query.toLowerCase();

  // Explicit structural references (priority order)
  if (entities.questionNumber) return "question_number_lookup";
  if (entities.pageNumber) return "page_lookup";
  if (
    entities.sectionNumber || entities.chapterNumber ||
    entities.unitNumber || entities.partLabel ||
    entities.exampleNumber || entities.moduleNumber ||
    entities.figureNumber || entities.tableNumber
  ) {
    return "section_lookup";
  }

  // Explicit patterns
  if (/(?:^|\s)(?:compare|comparison|difference|differ|versus|vs\.?)\b/.test(q)) {
    return "comparison";
  }
  if (/(?:^|\s)(?:summar(?:ize|ise|ization)|give me (?:a )?summary)\b/.test(q)) {
    return "summary";
  }
  if (/(?:^|\s)(?:defin(?:e|ition)|what (?:is|are) (?:a |an |the )?)\b/.test(q)) {
    return "definition";
  }
  if (/(?:^|\s)(?:example|instance|illustration|sample)\b/.test(q)) {
    return "example";
  }
  if (/(?:^|\s)(?:list|enumerate|name all|what are (?:all )?(?:the )?(?:types|kinds|forms|methods|ways|approaches))\b/.test(q)) {
    return "list";
  }
  if (/(?:^|\s)(?:how (?:do|does|to|can)|step[s]?|procedure|process|workflow)\b/.test(q)) {
    return "procedure";
  }
  if (/(?:^|\s)(?:explain|describe|tell me about|discuss|elaborate)\b/.test(q)) {
    return "explanation";
  }

  return "factual_lookup";
}

// ---------------------------------------------------------------------------
// Scope query detection (structural enumeration)
// ---------------------------------------------------------------------------

/**
 * Detects scope queries: requests for ALL items of a type within a structural
 * scope. These bypass the normal TOP-K scoring pipeline and instead collect
 * all matching chunks within the structural range.
 *
 * Examples:
 *   "what are questions in part b unit 4" → scopeQuery = true
 *   "list all questions in Unit 4" → scopeQuery = true
 *   "Unit 4 Question 5" → scopeQuery = false (exact lookup)
 *   "What is normalization?" → scopeQuery = false (semantic query)
 */
function detectScopeQuery(query: string, entities: ExtractedEntities): boolean {
  const q = query.toLowerCase();

  // Must have structural parent markers (unit, part, chapter, etc.)
  const hasParent =
    entities.unitNumber || entities.partLabel || entities.chapterNumber ||
    entities.moduleNumber || entities.sectionNumber;
  if (!hasParent) return false;

  // Must NOT have a specific question number (exact lookup, not enumeration)
  if (entities.questionNumber) return false;

  // Must signal interest in enumerable items (questions, exercises, etc.)
  return /\b(?:questions?|exercises?|problems?|examples?)\b/.test(q);
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

/**
 * Analyzes a user query and returns structured information for retrieval.
 */
export function analyzeQuery(query: string): QueryAnalysis {
  const normalized = normalizeQuery(query);
  const entities = extractEntities(query);
  const intent = detectIntent(query, entities);
  const importantTokens = tokenizeImportant(normalized);
  const allTokens = tokenizeAll(normalized);
  const scopeQuery = detectScopeQuery(query, entities);

  return {
    originalQuery: query,
    normalizedQuery: normalized,
    importantTokens,
    allTokens,
    intent,
    entities,
    scopeQuery,
  };
}
