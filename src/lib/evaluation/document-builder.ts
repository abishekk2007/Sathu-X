// ---------------------------------------------------------------------------
// Phase 5G — Synthetic document builder
//
// Builds arbitrary documents for evaluation (Step 7). A document is a list of
// chunks with structural markers and page numbers. Raising/generators here are
// GENERIC — nothing is hard-coded to a specific filename, unit, page, or topic.
// The caller supplies topic names, structural layout, and content.
// ---------------------------------------------------------------------------

import type { EvalChunk, SyntheticDocument } from "./evaluation-types";

// ---------------------------------------------------------------------------
// Deterministic pseudo-random id / topic helpers (no external RNG dependency)
// ---------------------------------------------------------------------------

let _idCounter = 0;
function nextId(prefix: string): string {
  _idCounter++;
  return `${prefix}-${_idCounter.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Normalize a structural number for matching (lowercase). */
export function normNum(n: string | number): string {
  return String(n).toLowerCase().trim();
}

/**
 * Build a chunk boundary string. Structural markers are embedded as plain
 * text headings so that the production `extractStructuralMarkers()` picks them
 * up — exactly like real extracted document text.
 */
export interface SyntheticChunkSpec {
  /** Runs of text (paragraphs/headings) inside this chunk. */
  parts: string[];
  page: number | null;
}

export interface BuildDocOptions {
  id?: string;
  name: string;
  displayName: string;
  type: "pdf" | "docx" | "pptx" | "txt" | "md" | "image" | "mixed";
  /** Chunk specs in document order. */
  chunks: SyntheticChunkSpec[];
}

/**
 * Build a SyntheticDocument from raw chunk specs. Splits long chunks-ish but
 * keeps them as provided (the caller controls granularity to emulate real
 * chunking output).
 */
export function buildDocument(opts: BuildDocOptions): SyntheticDocument {
  const chunks: EvalChunk[] = opts.chunks.map((spec, i) => ({
    id: `${opts.id ?? "doc"}-${i}`,
    content: spec.parts.join("\n").trim(),
    chunk_index: i,
    page_number: spec.page,
  }));
  return {
    id: opts.id ?? nextId(opts.name.toLowerCase().replace(/[^a-z0-9]/g, "-")),
    name: opts.name,
    displayName: opts.displayName,
    type: opts.type,
    chunks,
  };
}

// ---------------------------------------------------------------------------
// Convenience builders for common evaluation shapes
// ---------------------------------------------------------------------------

export interface QuestionEntry {
  number: number;
  text: string;
  answerEvidence: string[];
}

export interface QuestionBankUnit {
  unit: number;
  part?: { label: string; questions: QuestionEntry[] };
  questions?: QuestionEntry[];
}

/**
 * Build a question-bank style document — but structured generically from the
 * provided layout. Used to evaluate exact structural location retrieval.
 * The evaluator never assumes question numbering is universal; it compares
 * against the ACTUAL structure supplied here (Step 4G).
 */
export function buildQuestionBankDoc(
  name: string,
  displayName: string,
  units: QuestionBankUnit[],
  pagePerParent = 2
): SyntheticDocument {
  const chunks: SyntheticChunkSpec[] = [];
  let chunkIndexPayload: EvalChunk[] = [];
  let page = 1;

  for (const unit of units) {
    // Unit heading chunk
    chunks.push({
      parts: [`UNIT ${unit.unit}`, `Unit ${unit.unit} covers this ${displayName}.`],
      page,
    });
    page += pagePerParent;

    if (unit.part) {
      const part = unit.part;
      chunks.push({
        parts: [`Part ${part.label}`, `PART ${part.label}`],
        page,
      });
      page += 1;
      for (const q of part.questions) {
        chunks.push({
          parts: [`Question ${q.number}`, `Question No. ${q.number}`, q.text],
          page,
        });
        page += 1;
        for (const ev of q.answerEvidence) {
          chunks.push({ parts: [ev], page });
          page += 1;
        }
      }
    }

    for (const q of unit.questions ?? []) {
      chunks.push({
        parts: [`Question ${q.number}`, q.text],
        page,
      });
      page += 1;
      for (const ev of q.answerEvidence) {
        chunks.push({ parts: [ev], page });
        page += 1;
      }
    }
  }

  const doc = buildDocument({
    name,
    displayName,
    type: "pdf",
    chunks,
  });
  // Rebuild chunk_index explicitly (buildDocument already does this).
  doc.chunks = chunks.map((c, i) => ({
    id: `${doc.id}-${i}`,
    content: c.parts.join("\n").trim(),
    chunk_index: i,
    page_number: c.page,
  }));
  chunkIndexPayload = doc.chunks;
  void chunkIndexPayload;
  return doc;
}

export interface ExactBankUnit {
  number: number;
  /** Optional named divisions (e.g. Part A/B) under this unit. */
  parts?: Array<{
    label: string;
    questions: QuestionEntry[];
  }>;
  /** Questions directly under the unit (no part). */
  questions?: QuestionEntry[];
}

export interface ExactBankOptions {
  /** Generic filler chunks inserted between a parent heading and its questions,
   *  so the heading chunk and the question chunk are separated (cross-chunk
   *  ancestry). Filler never contains question markers. */
  fillerPerHeading?: number;
  pagePerParent?: number;
}

/**
 * Build a question-bank document for EXACT question-number retrieval across many
 * parent units, where each question number appears under every unit with a
 * DISTINCT answer. The parent heading chunk is separated from the question chunk
 * by filler text (cross-chunk hierarchy). Nothing is hard-coded to a specific
 * unit/question number.
 */
export function buildExactQuestionBankDoc(
  name: string,
  displayName: string,
  units: ExactBankUnit[],
  opts: ExactBankOptions = {}
): SyntheticDocument {
  const fillerPerHeading = opts.fillerPerHeading ?? 2;
  const pagePerParent = opts.pagePerParent ?? 2;
  const chunks: SyntheticChunkSpec[] = [];
  let page = 1;

  for (const unit of units) {
    // Unit heading chunk
    chunks.push({
      parts: [`UNIT ${unit.number}`, `Unit ${unit.number} covers ${displayName} topics here.`],
      page,
    });
    page += pagePerParent;
    chunks.push(...filler(page, fillerPerHeading));
    page += fillerPerHeading;

    // Bare questions FIRST so an exact "Unit N Question K" lookup (no part)
    // resolves to the unit-level question, never to a part-nested one.
    for (const q of unit.questions ?? []) {
      chunks.push({ parts: [`Question ${q.number}`, q.text], page });
      page += 1;
      for (const ev of q.answerEvidence) {
        chunks.push({ parts: [ev], page });
        page += 1;
      }
    }

    for (const part of unit.parts ?? []) {
      chunks.push({ parts: [`Part ${part.label}`, `PART ${part.label}`], page });
      page += 1;
      chunks.push(...filler(page, fillerPerHeading));
      page += fillerPerHeading;
      for (const q of part.questions) {
        chunks.push({ parts: [`Question ${q.number}`, `Question No. ${q.number}`, q.text], page });
        page += 1;
        for (const ev of q.answerEvidence) {
          chunks.push({ parts: [ev], page });
          page += 1;
        }
      }
    }
  }

  const doc = buildDocument({ name, displayName, type: "pdf", chunks });
  doc.chunks = chunks.map((c, i) => ({
    id: `${doc.id}-${i}`,
    content: c.parts.join("\n").trim(),
    chunk_index: i,
    page_number: c.page,
  }));
  return doc;
}

function filler(startPage: number, count: number): SyntheticChunkSpec[] {
  const out: SyntheticChunkSpec[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ parts: [`Introductory passage ${i + 1} setting the scene here.`], page: startPage + i });
  }
  return out;
}

/**
 * Build a generic prose document (research paper, resume, PPTX dump, etc.)
 * with numbered sections and pages. Content is arbitrary — not a question bank.
 */
export function buildProseDocument(
  name: string,
  displayName: string,
  type: BuildDocOptions["type"],
  sections: Array<{
    heading: string;
    marker?: { type: string; number: string };
    paragraphs: string[];
    page: number;
  }>
): SyntheticDocument {
  const chunks: SyntheticChunkSpec[] = [];
  for (const s of sections) {
    const parts: string[] = [];
    if (s.marker) {
      parts.push(`${capitalize(s.marker.type)} ${s.marker.number}`);
    }
    parts.push(s.heading);
    parts.push(...s.paragraphs);
    chunks.push({ parts, page: s.page });
  }
  return buildDocument({ name, displayName, type, chunks });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build a long document (Step J) with many pages so we can test whether
 * retrieval is biased toward the beginning/middle/end.
 */
export function buildLongDocument(
  name: string,
  displayName: string,
  pages: number,
  pageTopics: Record<number, string[]>
): SyntheticDocument {
  const chunks: SyntheticChunkSpec[] = [];
  for (let p = 1; p <= pages; p++) {
    const topics = pageTopics[p] ?? [`Generic page ${p} content.`];
    chunks.push({ parts: topics, page: p });
  }
  return buildDocument({ name, displayName, type: "pdf", chunks });
}

// ---------------------------------------------------------------------------
// Similar-content confusion builder (Step M)
// ---------------------------------------------------------------------------

export interface ConfusionSlot {
  marker: { type: string; number: string };
  heading: string;
  body: string[];
  page: number;
  /** Unique signal token that must win for this slot when explicitly addressed. */
  uniqueToken: string;
}

/**
 * Build a document where two (or more) slots are semantically similar but at
 * different structural locations. Explicit structural references must win.
 */
export function buildConfusionDocument(
  name: string,
  displayName: string,
  slots: ConfusionSlot[]
): SyntheticDocument {
  const chunks: SyntheticChunkSpec[] = slots.map((s) => ({
    parts: [
      `${capitalize(s.marker.type)} ${s.marker.number}`,
      s.heading,
      ...s.body,
      s.uniqueToken,
    ],
    page: s.page,
  }));
  return buildDocument({ name, displayName, type: "pdf", chunks });
}
