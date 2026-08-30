// ---------------------------------------------------------------------------
// Phase 6E — Document → Visual generation: visual spec + grounded prompt
//
// The Provider NEVER receives raw retrieval dumps. Instead this module builds a
// structured `DocumentVisualSpec` (key facts, explicit relationships, ordered
// sequence, exact numbers, source references) from the bounded evidence, and
// then composes a grounded prompt whose factual core is the evidence alone.
// Every type ships a strict anti-hallucination instruction; the chart gate
// (`hasNumericEvidence`) lives in the evidence layer and is enforced by the
// service, so a chart can never be fabricated from documents with no numbers.
// ---------------------------------------------------------------------------

import {
  buildEvidenceContext,
  extractNumericTokens,
  hasNumericEvidence,
  normalizeEvidence,
  type DocumentVisualEvidenceItem,
} from "./document-visual-evidence";
import { DOCUMENT_VISUAL_LABELS, type DocumentVisualType } from "./document-visual-types";
import type { ComposedPrompt } from "./prompt";
import { normalizeAspectRatio } from "./prompt";
import type { ImageAspectRatio } from "./types";
import { DEFAULT_NEGATIVE_PROMPT } from "./types";

/** Hard cap on the composed document-visual prompt (characters). */
export const DOC_VISUAL_PROMPT_MAX_CHARS = 14_000;

/** Cap on the source-material block inside the composed prompt. */
export const DOC_VISUAL_EVIDENCE_BLOCK_CHARS = 9_000;

/** Cap on each derived fact/relationship/sequence snippet. */
const SNIPPET_MAX_CHARS = 240;

/** Max derived entities kept in the spec. */
const MAX_ENTITIES = 12;

/** Max source references kept in the spec. */
const MAX_SOURCE_REFERENCES = 8;

const EDUCATIONAL_HINT =
  "This is a study aid. Keep it educational: clean labels, accurate subject " +
  "matters, readable text, simple and visually clear layout.";

const DEFAULT_ASPECT: ImageAspectRatio = "1:1";

/** Explicit relationship markers — only these imply a stated connection. */
const RELATION_MARKERS_RE =
  /\b(?:because|leads?\s+to|lead\s+to|result(?:s|ing)?\s+in|result\s+of|caused?\s+by|causes?|depends?\s+on|part\s+of|contain|contains?|includ(?:es|ing)|compared?\s+to|due\s+to|therefore|thus|as\s+a\s+result|higher\s+than|lower\s+than|contributes?\s+to|based\s+on|produced?\s+by|followed\s+by|preceded\s+by)\b/i;

/** Ordered-step markers that make a passage a sequence. */
const SEQUENCE_MARKERS_RE =
  /^(?:first|second|third|fourth|fifth|next|then|finally|last|afterwards|afterward|step\s*\d+|stage\s*\d+|phase\s*\d+|\d+[.)]|1\.|2\.|3\.|4\.|5\.)/i;

/** Capitalized phrases candidate entities (stopword-filtered below). */
const ENTITY_TOKEN_RE = /[A-Z][A-Za-z0-9'’]+(?:\s+[A-Z]?[a-z0-9'’-]{1,24}){0,4}/g;

const ENTITY_STOPWORDS = new Set([
  "the", "this", "that", "these", "those", "chapter", "section", "page", "figure",
  "table", "figure", "introduction", "conclusion", "appendix", "part", "refer", "see",
  "e.g.", "i.e.", "etc.", "based", "using", "according", "from", "with", "when", "their",
]);

// ---------------------------------------------------------------------------
// Structured spec
// ---------------------------------------------------------------------------

export interface DocumentVisualSpec {
  /** Closed-taxonomy type (null = generic grounded instruction). */
  visualType: DocumentVisualType | null;
  /** Short, evidence-derived title (first key fact wrapped). */
  title?: string;
  /** Bounded list of facts from the evidence (first sentence of each item). */
  keyFacts: string[];
  /** Only relationships explicitly stated in the evidence. */
  relationships: string[];
  /** Ordered steps/dates the evidence explicitly sequences. */
  sequence?: string[];
  /** Notable capitalized entities present in the evidence. */
  entities?: string[];
  /** Exact numerical values present in the evidence. */
  numbers?: string[];
  /** "[sourceName · page N]" markers from the retrieval record. */
  sourceReferences: string[];
  /** Presentation-only style instructions (refinement additions). */
  styleInstructions: string[];
  /** Bounded, deduplicated source material block. */
  groundingText: string;
  /** True when the evidence contains usable numerical values. */
  hasNumericEvidence: boolean;
}

/** Splits a passage into bounded sentence-ish snippets. */
function snippets(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 6)
    .map((s) => s.slice(0, SNIPPET_MAX_CHARS));
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Derives the structured spec from bounded, deduplicated evidence. */
export function buildDocumentVisualSpec(
  visualType: DocumentVisualType | null,
  evidence: DocumentVisualEvidenceItem[]
): DocumentVisualSpec {
  const items = normalizeEvidence(evidence);
  const groundingText = buildEvidenceContext(items);

  const numbers = new Set<string>();
  const relationships = new Set<string>();
  const sequence = new Set<string>();
  const entities = new Set<string>();
  const keyFacts: string[] = [];
  const sourceReferences: string[] = [];

  for (const item of items) {
    for (const sentence of splitSentences(item.text)) {
      if (RELATION_MARKERS_RE.test(sentence) && relationships.size < 10) {
        relationships.add(sentence.slice(0, SNIPPET_MAX_CHARS));
      }
      if (SEQUENCE_MARKERS_RE.test(sentence) && sequence.size < 10) {
        sequence.add(sentence.slice(0, SNIPPET_MAX_CHARS));
      }
    }
    for (const token of extractNumericTokens(item.text)) numbers.add(token);
    for (const m of item.text.matchAll(ENTITY_TOKEN_RE)) {
      const phrase = m[0].trim();
      const core = phrase.split(/\s+/)[0].replace(/[^A-Za-z]/g, "");
      if (core.length < 2 || ENTITY_STOPWORDS.has(core.toLowerCase())) continue;
      entities.add(phrase);
      if (entities.size >= MAX_ENTITIES) break;
    }
    const first = snippets(item.text)[0];
    if (first && keyFacts.length < 12) keyFacts.push(first);
    if (item.sourceName || item.page) {
      const ref = [item.sourceName, item.page ? `page ${item.page}` : null]
        .filter(Boolean)
        .join(" · ");
      if (ref && !sourceReferences.includes(ref) && sourceReferences.length < MAX_SOURCE_REFERENCES) {
        sourceReferences.push(ref);
      }
    }
  }

  return {
    visualType,
    title: keyFacts[0] ? `Based on: ${keyFacts[0]}` : undefined,
    keyFacts,
    relationships: [...relationships],
    sequence: sequence.size > 0 ? [...sequence] : undefined,
    entities: entities.size > 0 ? [...entities] : undefined,
    numbers: [...numbers].slice(0, 16),
    sourceReferences,
    styleInstructions: [],
    groundingText,
    hasNumericEvidence: hasNumericEvidence(items),
  };
}

// ---------------------------------------------------------------------------
// Per-type anti-hallucination instructions
// ---------------------------------------------------------------------------

const TYPE_INSTRUCTIONS: Record<DocumentVisualType, string> = {
  infographic:
    "Every factual element, number, and label must be directly supported by the supplied evidence. Do not fill gaps with general knowledge.",
  educational_diagram:
    "Show each labelled component exactly as the evidence describes it. Use clean, accurate labels and keep the layout simple and legible.",
  flowchart:
    "Show the steps and branches exactly as the evidence sequences them, in the same order. Only branch when the evidence explicitly describes alternatives.",
  timeline:
    "Order events along the timeline exactly as dated in the evidence. Never add or reorder events that are not present.",
  concept_map:
    "Connect concepts and terms ONLY with relationship labels explicitly stated in the evidence (for example, 'leads to', 'part of'). Never invent missing relationships.",
  process_diagram:
    "Depict each stage in the exact order the evidence gives, with every participant and condition stated. Omit any step the evidence does not contain.",
  comparison_visual:
    "Compare ONLY the attributes explicitly present in the evidence, side by side. Never add attributes from general knowledge.",
  chart:
    "Visualize ONLY the numerical values explicitly present in the evidence. Use the exact numbers; never interpolate, extrapolate, or add data points.",
  visual_summary:
    "Summarize ONLY what the evidence states, preserving numbers, names, dates, and terminology exactly.",
  illustration:
    "Illustrate the described subject faithfully; any annotation must come directly from the evidence.",
};

const VERIFICATION_RULES =
  "Verification rules — follow EXACTLY:\n" +
  "- Every factual element, number, name, date, and relationship must come from the Source material below. Never invent facts, values, or connections.\n" +
  "- Preserve the exact numbers, order, sequence, and terminology of the source.\n" +
  "- If the source does not mention something, omit it — never fill gaps from general knowledge.";

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/** Builds the effective provider prompt from a spec. */
export function buildDocumentVisualPrompt(input: {
  spec: DocumentVisualSpec;
  mode?: string;
  style?: string;
  refinement?: string | null;
  aspectRatio?: ImageAspectRatio;
  negativePrompt?: string;
}): ComposedPrompt {
  const { spec } = input;
  const aspectRatio = normalizeAspectRatio(input.aspectRatio);
  const negativePrompt = input.negativePrompt
    ? String(input.negativePrompt).slice(0, 400)
    : DEFAULT_NEGATIVE_PROMPT;

  const label =
    spec.visualType != null ? DOCUMENT_VISUAL_LABELS[spec.visualType] : "clear, well-labelled visual";
  const parts: string[] = [];

  parts.push(`Create a ${label} based ONLY on the verified source material below.`);
  parts.push(DOCUMENT_VISUAL_LABELS[spec.visualType ?? "illustration"] ? "" : "");

  if (input.style && input.style.trim()) {
    parts.push(`Style: ${input.style.trim().slice(0, 200)}.`);
  }

  if (input.mode === "student") {
    parts.push(EDUCATIONAL_HINT);
  }

  if (spec.visualType != null) {
    parts.push(TYPE_INSTRUCTIONS[spec.visualType]);
  }

  if (spec.keyFacts.length > 0) {
    parts.push("Key facts that MUST be reflected:\n" + spec.keyFacts.map((f) => `- ${f}`).join("\n"));
  }
  if (spec.relationships.length > 0) {
    parts.push(
      "Explicit relationships (only those stated in the source):\n" +
        spec.relationships.map((r) => `- ${r}`).join("\n")
    );
  }
  if (spec.sequence && spec.sequence.length > 0) {
    parts.push(
      "Sequence/steps (in the exact source order):\n" + spec.sequence.map((s) => `- ${s}`).join("\n")
    );
  }
  if (spec.numbers && spec.numbers.length > 0) {
    parts.push(
      "Numerical values (use exactly as stated):\n" + spec.numbers.map((n) => `- ${n}`).join("\n")
    );
  }
  if (spec.sourceReferences.length > 0) {
    parts.push("Source references:\n" + spec.sourceReferences.map((r) => `- ${r}`).join("\n"));
  }

  parts.push(VERIFICATION_RULES);

  if (spec.groundingText.trim()) {
    parts.push(
      "Source material (authoritative — do not add anything not stated here):\n" +
        spec.groundingText.slice(0, DOC_VISUAL_EVIDENCE_BLOCK_CHARS)
    );
  }

  const allStyleInstructions = [
    ...spec.styleInstructions,
    ...(input.refinement && input.refinement.trim()
      ? [`Refinement (retain the grounding above): ${input.refinement.trim().slice(0, 300)}`]
      : []),
  ].filter(Boolean);
  if (allStyleInstructions.length > 0) {
    parts.push(allStyleInstructions.join("\n"));
  }

  const prompt = parts.filter(Boolean).join("\n").slice(0, DOC_VISUAL_PROMPT_MAX_CHARS);
  return { prompt, negativePrompt, aspectRatio };
}

// ---------------------------------------------------------------------------
// Refinement claim guard
// ---------------------------------------------------------------------------

/**
 * Rejects a refinement that would introduce unsupported facts (for example,
 * "add the 2024 revenue" when the evidence contains no 2024 revenue). Numbers,
 * years, and explicit factual leads mentioned in the refinement MUST already
 * exist in the evidence. Presentation-only refinements always pass.
 */
export function guardRefinementClaims(
  refinement: string,
  spec: DocumentVisualSpec
): { okay: boolean; reason?: string } {
  const text = refinement.trim().replace(/\s+/g, " ");
  if (!text) {
    return { okay: true };
  }
  if (!spec.groundingText.trim()) {
    return { okay: false, reason: "No evidence to verify the refinement against." };
  }

  const refinementNumbers = extractNumericTokens(text);
  const evidenceNumbers = new Set(extractNumericTokens(spec.groundingText));
  const unsupportedNumbers = refinementNumbers.filter((n) => !evidenceNumbers.has(n));
  if (unsupportedNumbers.length > 0) {
    return {
      okay: false,
      reason: `Refinement references values absent from the evidence: ${unsupportedNumbers.join(", ")}.`,
    };
  }

  const refinementYears = text.match(/\b20\d{2}\b/g) ?? [];
  const evidenceYears = new Set(spec.groundingText.match(/\b20\d{2}\b/g) ?? []);
  const unsupportedYears = refinementYears.filter((y) => !evidenceYears.has(y));
  if (unsupportedYears.length > 0) {
    return {
      okay: false,
      reason: `Refinement references years absent from the evidence: ${unsupportedYears.join(", ")}.`,
    };
  }

  return { okay: true };
}