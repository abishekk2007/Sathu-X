// ---------------------------------------------------------------------------
// Phase 6E — Document → Visual generation: evidence normalization
//
// Turns raw retrieved passages (agent `RetrievalResult[]` or legacy
// `retrieveDocumentChunks` chunks) into a bounded, deduplicated set of
// `DocumentVisualEvidenceItem`s that the visual spec + prompt builder may use.
// All facts, numbers, relationships, sequences, dates, and statistics carried
// into the visual prompt come from HERE — never from the model, never from
// memory. The `hasNumericEvidence` guard is the chart gate: a chart visual is
// only produced when the evidence actually contains numerical values.
// ---------------------------------------------------------------------------

/** One bounded, verifiable passage used to ground a document visual. */
export interface DocumentVisualEvidenceItem {
  /** Owning source id (when retrieval was agent-based). */
  sourceId?: string;
  /** Human-facing source name (file name / document name). */
  sourceName?: string;
  /** Page number within the source, when retrieval recorded one. */
  page?: number | null;
  /** Section/heading, when retrieval recorded one. */
  section?: string | null;
  /** The verified passage text. */
  text: string;
  /** Retrieval relevance score (0..1), when available. */
  relevance?: number | null;
}

/** Hard cap on total evidence characters forwarded into the visual prompt. */
export const MAX_EVIDENCE_CHARS = 12_000;

/** Hard cap on the number of distinct evidence items used. */
export const MAX_EVIDENCE_ITEMS = 20;

/** Max characters for one item (the prompt budget is shared beyond this). */
export const MAX_EVIDENCE_ITEM_CHARS = 3_000;

function cleanText(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_EVIDENCE_ITEM_CHARS);
}

function dedupeKey(text: string): string {
  return text.toLowerCase().replace(/\b(?:the|a|an)\b/g, "").replace(/\s+/g, " ").slice(0, 120);
}

/** Normalizes mixed-shaped retrieval output into bounded evidence items. */
export function normalizeEvidence(
  input: Array<
    | DocumentVisualEvidenceItem
    | { text: string; page?: number | null; score?: number | null }
  >
): DocumentVisualEvidenceItem[] {
  const seen = new Set<string>();
  const items: DocumentVisualEvidenceItem[] = [];
  let totalChars = 0;

  for (const raw of input) {
    if (!raw || !raw.text) continue;
    const text = cleanText(raw.text);
    if (!text) continue;

    const key = dedupeKey(text);
    if (seen.has(key)) continue;
    seen.add(key);

    if (totalChars + text.length > MAX_EVIDENCE_CHARS) break;
    if (items.length >= MAX_EVIDENCE_ITEMS) break;
    totalChars += text.length;

    const item = raw as DocumentVisualEvidenceItem;
    items.push({
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      page: item.page ?? (raw as { page?: number | null }).page ?? null,
      section: item.section ?? null,
      text,
      relevance: item.relevance ?? (raw as { score?: number | null }).score ?? null,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Numeric-evidence detection (the chart gate + spec numbers field)
// ---------------------------------------------------------------------------

/** Loose-but-sensible numeric patterns that mean actual measured values. */
const NUMERIC_TOKEN_RE =
  /(?<!\w)[₹$€£¥]\s?\d[\d,.]*|\d[\d,.]*\s?%(?![\w])|\d[\d,.]*\s?(?:percent|pp\b|bps\b|million|billion|thousand|usd|inr|eur|gbp|cny|jpy)\b|\b\d{2,}(?:[.,]\d+)*\b|\b\d{1,2}\.\d+\b/g;

/** Extracts normalized numeric tokens from a text fragment. */
export function extractNumericTokens(text: string): string[] {
  const tokens = (String(text).match(NUMERIC_TOKEN_RE) ?? [])
    .map((t) => t.trim().toLowerCase().replace(/^[₹$€£¥]\s?/, "").replace(/s$/, ""))
    .filter(Boolean);
  return [...new Set(tokens)];
}

/** True when the evidence contains at least one usable numerical value. */
export function hasNumericEvidence(items: DocumentVisualEvidenceItem[]): boolean {
  return items.some((item) => extractNumericTokens(item.text).length > 0);
}

/** Joins bounded evidence items into a single grounding block. */
export function buildEvidenceContext(items: DocumentVisualEvidenceItem[]): string {
  return items
    .map((item) => {
      const header =
        item.sourceName || item.page
          ? `[${[item.sourceName, item.page ? `page ${item.page}` : null]
              .filter(Boolean)
              .join(" · ")}] `
          : "";
      return `${header}${item.text}`;
    })
    .join("\n\n");
}