// ---------------------------------------------------------------------------
// Phase 6E — Document → Visual generation intent detection
//
// Deterministic, pure detection (no LLM, no network) so the router can slot
// DOCUMENT_VISUAL_GENERATION into its priority ladder and the chat route can
// reuse the result. Mirrors the 6A/6C/6D style: rule-based, conservative,
// exhaustively tested.
//
// CRITICAL RULES
//   - Grounding is THE gate. A document visual REQUIRES an explicit document/
//     source reference AND a visual-generation signal. Memory can never
//     substitute for an attached document, so a turn with a visual ask but no
//     document reference is NOT detected here (it belongs to IMAGE_GENERATION).
//   - Visual UNDERSTANDING turns ("what does the diagram on page 4 show?",
//     "explain this chart") are NEVER document visuals.
//   - Refinements ("make it simpler", "use a darker style") of a previous
//     document-visual turn stay grounded and carry `refinementOf`; the service
//     re-verifies claims so a refinement can never smuggle in unsupported facts.
//   - `visualType` is inferred ONLY when the user's wording is unambiguous.
//     Never inferred against the user's explicit request (ambiguous phrasing →
//     null, generic grounded instruction).
// ---------------------------------------------------------------------------

import type { DocumentVisualType } from "./document-visual-types";

/** Result of running the document-visual detector on a turn. */
export interface DocumentVisualIntent {
  detected: boolean;
  /** Heuristic 0..1. Guidance only. */
  confidence: number;
  /** Server-side rationale (never shown to the client). */
  reason: string;
  /** Grounding is always required for a document visual. */
  requiresDocuments: boolean;
  /**
   * Visual type from the closed taxonomy when the user's wording resolves
   * unambiguously; null when unspecified or ambiguous (generic grounding).
   */
  visualType?: DocumentVisualType | null;
  /**
   * When non-null, this turn is a presentation refinement of a previous
   * document-visual turn ("make it simpler" after "create an infographic
   * from my PDF").
   */
  refinementOf?: string | null;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Document/source references that make a document real and attachable. */
const DOCUMENT_TERM =
  "(?:pdfs?|documents?|docs?|files?|notes?|chapters?|reports?|papers?|books?|textbooks?|manuals?|slides?|decks?|handouts?|guides?|theses?|attachments?|materials?|readings?|sources?)";

/** Optional possessives/demonstratives, then up to two modifier words
 *  ("annual report", "quarterly financial report" still count as a
 *  document reference). */
const DOC_PREFIX = "(?:(?:the|this|that|my|our|your)\\s+)?(?:[a-z0-9'-]+\\s+){0,2}";

const DOC_CONTEXT_RE = new RegExp(
  "\\b(?:based\\s+on|according\\s+to|using|from|of|in|for|about|around|on|with)\\s+" +
    DOC_PREFIX + "(" + DOCUMENT_TERM + ")\\b" +
    "|\\b(?:my|our|your|the|this|that)\\s+(?:[a-z0-9'-]+\\s+){0,2}(" + DOCUMENT_TERM + ")\\b" +
    "|\\b(?:uploaded|attached|selected|pasted|provided|submitted)\\s+(" + DOCUMENT_TERM + ")\\b",
  "i"
);

/** True when the message explicitly references an attached document/source. */
export function hasDocumentContext(message: string): boolean {
  return DOC_CONTEXT_RE.test(message);
}

/** Visual-generation action verbs. */
const VISUAL_ACTION_RE =
  /\b(?:creat(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|mak(?:e|es|ing)|made|design(?:s|ed|ing)?|draw(?:s|ing)?|drew|craf(?:t|ts|ted|ting)|produc(?:e|es|ed|ing)|build(?:s|ing)?|built|compos(?:e|es|ed|ing)|render(?:s|ed|ing)?|sketch(?:es|ed|ing)?|develop(?:s|ed|ing)?|prepar(?:e|es|ed|ing)|visuali[sz](?:e|es|ed|ing)|illustrat(?:e|es|ed|ing)|summari[sz](?:e|es|ed|ing))\b/i;

/** Visual artifacts a document visual may produce (generation taxonomy). */
const VISUAL_NOUN_RE =
  /\b(?:infographics?|educational\s+diagrams?|diagrams?|flowcharts?|flow\s+charts?|timelines?|time\s+lines?|concept\s+maps?|mind\s+maps?|process\s+diagrams?|process\s+flows?|schematics?|comparison\s+(?:visuals?|charts?|graphs?|diagrams?)|charts?|bar\s+charts?|pie\s+charts?|line\s+charts?|graphs?|bar\s+graphs?|line\s+graphs?|visual\s+summar(?:y|ies)|visual\s+(?:overviews?|representations?)|illustrations?|visuals?|graphics?|posters?|figures?|visuali[sz]ations?)\b/i;

/** "turn … into a <visual>" explicitly creates a visual from a document. */
const TURN_INTO_RE =
  /\bturn(?:ing|s|ed)?\s+.{1,120}?\s+into\s+(?:an\s+|a\s+)?(?:infographic|diagram|flowchart|timeline|concept\s+map|chart|graph|illustration|visual\s+summary|poster)\b/i;

/** Unambiguous visual verbs that create from a subject even without a noun. */
const UNMISSABLE_VISUAL_VERB_RE = /^(?:please\s+)?(?:visuali[sz]e|visualise|illustrate)\b/i;

/** Reading/understanding phrasing that is the OPPOSITE of generation. */
const UNDERSTANDING_RE =
  /\b(?:what(?:'s|s|\s+is|\s+does|\s+do|\s+are)?\s*(?:the\s+)?(?:this|that)?\s*(?:document|pdf|file|notes|report|chapter|diagram|chart|graph|infographic|timeline|flowchart|figure|visual)\s*(?:show|mean|contain|depict|represent|tell|say|about)|explain\s+(?:to\s+me\s+)?(?:this|the|that|my)\s*(?:document|diagram|chart|graph|infographic|flowchart|timeline|figure|visual)|describe\s+(?:this|the|that|my)\s*(?:document|diagram|chart|graph|flowchart|infographic|timeline|report)|anal[ys][a-z]*\s+(?:the|this|my)?\s*(?:document|report|pdf|notes|diagram|chart|graph)|(?:read|interpret|inspect)\s+(?:this|that|the)\s*(?:document|pdf|diagram|chart|graph)|what\s+does\s+(?:the|this|my)?\s*(?:document|pdf|report|notes)\s+say|what(?:'s| is)\s+in\s+(?:my|the|this)\s+(?:pdf|document|file|notes|report)|what's\s+on\s+(?:page|p\.?)\s*\d+)(?![\w-])/i;

/** Concept-definition phrasing about visuals/docs themselves. */
const DEFINITION_RE =
  /^(?:what|define|explain)\s+(?:is\s+)?(?:an\s+|a\s+|the\s+)?(?:infographic|diagram|chart|graph|flowchart|timeline|concept\s+map|visual|illustration|document|pdf)(?:\s|$)/i;

/** Social/acknowledgement filler — never a visual generation turn. */
const CHITCHAT_RE =
  /^(?:ok(?:ay)?|sure|great|nice|good|thanks?|thank\s+you|alright|yes|no|yep|nope|perfect|cool|awesome|got\s*it|done|fine)[!.\s]*$/i;

/** Presentation-only refinement signals that never introduce new facts. */
const PRESENTATION_REFINE_RE =
  /\b(?:simpler|simplif(?:y|ied)|add(?:ing)?\s+labels?|clearer|cleaner|labell?ed|label(?:s|l?ed)?|student|study|style|styled|layout|bigger|smaller|larger|more\s+visual|legible|readable|bold|light|dark|theme|minimal|more\s+detailed|colorful|colourful|color|colour|darker|brighter|redraw|redesign|restyle|make\s+it|make\s+this|change\s+(?:the\s+)?(?:style|colors?|colours?|look|design|layout)|educational|easier\s+for\s+students)\b/i;

/** Max words for a bare refinement instruction (like 6C's REFINEMENT_MAX_WORDS). */
const REFINEMENT_MAX_WORDS = 8;

// ---------------------------------------------------------------------------
// Visual-type inference (safe, never contradicting the user)
// ---------------------------------------------------------------------------

interface TypePattern {
  type: DocumentVisualType;
  re: RegExp;
  specific: boolean;
}

const TYPE_PATTERNS: TypePattern[] = [
  { type: "flowchart", re: /\b(?:flowcharts?|flow\s+charts?)\b/i, specific: true },
  { type: "timeline", re: /\b(?:timelines?|time\s+lines?)\b/i, specific: true },
  { type: "concept_map", re: /\b(?:concept\s+maps?|mind\s+maps?)\b/i, specific: true },
  { type: "process_diagram", re: /\b(?:process\s+diagrams?|process\s+flows?|schematics?)\b/i, specific: true },
  { type: "comparison_visual", re: /\bcomparison\s+(?:visuals?|charts?|graphs?|diagrams?)\b/i, specific: true },
  { type: "chart", re: /\b(?:charts?|graphs?|bar\s+charts?|pie\s+charts?|line\s+charts?)\b/i, specific: true },
  { type: "visual_summary", re: /\bvisual\s+(?:summar(?:y|ies)|overviews?|representations?)\b/i, specific: true },
  { type: "infographic", re: /\binfographics?\b/i, specific: true },
  { type: "educational_diagram", re: /\beducational\s+diagrams?\b/i, specific: true },
  { type: "illustration", re: /\b(?:illustrations?|posters?|visuals?|graphics?|figures?)\b/i, specific: false },
  { type: "educational_diagram", re: /\bdiagrams?\b/i, specific: false },
];

/**
 * Infers the visual type ONLY when the user's wording is unambiguous. Returns
 * null when nothing matched, or when distinct specific types conflict ("an
 * infographic or a timeline") — guessing would contradict the request.
 */
export function inferDocumentVisualType(message: string): DocumentVisualType | null {
  const specific = new Set<DocumentVisualType>();
  let genericFallback: DocumentVisualType | null = null;

  for (const { type, re, specific: isSpecific } of TYPE_PATTERNS) {
    if (re.test(message)) {
      if (isSpecific) specific.add(type);
      else genericFallback = type;
    }
  }

  if (specific.size > 1) return null;
  if (specific.size === 1) return [...specific][0];
  return genericFallback;
}

// ---------------------------------------------------------------------------
// Direct detection
// ---------------------------------------------------------------------------

/**
 * Detects a direct document→visual request: an explicit document reference
 * PLUS a visual-generation signal (action verb + visual noun, "turn … into …",
 * or an unmistakeable visual verb). Understanding/definition phrasing is
 * rejected first. Never fires for pure generation turns with no document
 * reference, and never for visual understanding turns.
 */
export function detectDocumentVisualIntent(message: string): DocumentVisualIntent {
  const text = message.trim().replace(/\s+/g, " ");
  if (!text) {
    return { detected: false, confidence: 0, requiresDocuments: true, reason: "Empty message." };
  }

  if (DEFINITION_RE.test(text) || UNDERSTANDING_RE.test(text) || CHITCHAT_RE.test(text)) {
    return {
      detected: false,
      confidence: 0,
      requiresDocuments: true,
      reason: "Visual understanding / definition / chit-chat — not a document visual.",
    };
  }

  const hasDoc = hasDocumentContext(text);
  if (!hasDoc) {
    return {
      detected: false,
      confidence: 0,
      requiresDocuments: true,
      reason: "No explicit document/source reference — memory can never substitute for an attached document.",
    };
  }

  const hasNoun = VISUAL_NOUN_RE.test(text);
  const hasAction = VISUAL_ACTION_RE.test(text);
  const hasTurnInto = TURN_INTO_RE.test(text);
  const hasUnmissableVerb = UNMISSABLE_VISUAL_VERB_RE.test(text);

  if (!((hasAction && hasNoun) || hasTurnInto || hasUnmissableVerb)) {
    return {
      detected: false,
      confidence: 0,
      requiresDocuments: true,
      reason:
        hasNoun && !hasAction
          ? "Document reference + visual noun but no generation request (could be reading/editing phrasing)."
          : "Document reference but no visual-generation signal.",
    };
  }

  const visualType = inferDocumentVisualType(text);
  const imperative = /^(?:please\s+)?(?:create|generate|make|design|draw|visuali[sz]e|illustrate)/i.test(text);
  const confidence = imperative ? 0.95 : 0.85;

  return {
    detected: true,
    confidence,
    requiresDocuments: true,
    visualType,
    reason: `Document-grounded visual request (${hasDoc ? "document reference" : "visual"}${visualType ? `, type=${visualType}` : ", type unspecified/ambiguous"}).`,
  };
}

// ---------------------------------------------------------------------------
// Refinement detection
// ---------------------------------------------------------------------------

/**
 * Detects a presentation refinement of a previous document-visual turn. The
 * prior turn must itself have been a detected document-visual request. Only
 * presentation signals count ("make it simpler", "darker style"); a fresh
 * document-visual request or any new-fact wording returns null (the new ask
 * routes normally; unsupported facts are refused by the service).
 */
export function detectDocumentVisualRefinement(
  message: string,
  priorUserMessage: string | null | undefined
): DocumentVisualIntent | null {
  if (!priorUserMessage) return null;
  const prior = detectDocumentVisualIntent(priorUserMessage);
  if (!prior.detected) return null;

  const text = message.trim().replace(/\s+/g, " ").replace(/[?!.]+\s*$/, "");
  if (!text) return null;

  // A question is never a refinement — "what does it show?" is understanding,
  // "can you make it simpler?" is a question, not an instruction.
  const isQuestion =
    /\?\s*$/.test(message) ||
    /^\s*(?:what|how|why|when|where|which|who|is|are|was|were|does|do|did|can|could|would|should|will)\b/i.test(text);
  if (isQuestion) return null;

  if (CHITCHAT_RE.test(text) || DEFINITION_RE.test(text) || UNDERSTANDING_RE.test(text)) {
    return null;
  }

  // A fresh document-visual ask is a new request, not a refinement.
  const fresh = detectDocumentVisualIntent(text);
  if (fresh.detected) return null;

  const words = text.split(/\s+/).length;
  const hasPresentation = PRESENTATION_REFINE_RE.test(text);
  const isShort = words <= REFINEMENT_MAX_WORDS;

  if (!hasPresentation && !isShort) return null;

  return {
    detected: true,
    confidence: 0.74,
    requiresDocuments: true,
    reason: `Presentation refinement of the previous document visual ("${priorUserMessage}").`,
    refinementOf: priorUserMessage,
    visualType: prior.visualType,
  };
}

/**
 * Resolves the effective document-visual signal for a turn, combining a direct
 * request with (failing that) a refinement of the prior document-visual turn.
 */
export function resolveDocumentVisualIntent(
  message: string,
  priorUserMessage: string | null | undefined
): DocumentVisualIntent {
  const direct = detectDocumentVisualIntent(message);
  if (direct.detected) return direct;
  const refinement = detectDocumentVisualRefinement(message, priorUserMessage);
  if (refinement) return refinement;
  return {
    detected: false,
    confidence: 0,
    requiresDocuments: true,
    reason: "No document-visual signal.",
  };
}

/** Convenience: true when a turn requests a document-grounded visual. */
export function isDocumentVisualRequest(message: string): boolean {
  return detectDocumentVisualIntent(message).detected;
}