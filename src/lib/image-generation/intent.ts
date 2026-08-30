// ---------------------------------------------------------------------------
// Phase 6C — Text → Image generation intent detection
//
// Deterministic, pure detection (no LLM, no network) so the router can slot
// IMAGE_GENERATION into its priority ladder without surprises, and the
// chat route can reuse the result later. Mirrors the intent shape used by the
// 6A real-time detectors: rule-based, conservative, and exhaustively tested.
//
// Strict gates prevent false positives:
//   - a visual-OBJECT noun must follow a generation ACTION verb, and
//   - visual underSTANDING turns ("what does this image show?", "explain
//     this diagram", "how does image generation work?") are explicitly
//     rejected — they stay VISUAL/MULTIMODAL/GENERAL.
// ---------------------------------------------------------------------------

/** Result of running the image-generation detector on a turn. */
export interface ImageGenerationIntent {
  detected: boolean;
  /** Heuristic 0..1. Guidance only. */
  confidence: number;
  /** Server-side rationale (never shown to the client). */
  reason: string;
  /**
   * When non-null, this turn is a refinement of a previous image request
   * ("make it at night" after "draw a castle"). The prompt is composed by
   * re-running the deterministic prompt builder on the prior message and
   * appending the current refinement wording.
   */
  refinementOf?: string | null;
}

/** Action verbs that request creating an image. */
const IMAGE_ACTION_RE =
  /\b(?:generate|create|generates?|make|makes?|draw|render|visuali[sz]e|illustrate|design|produce|sketch|paint|compose|craf)\b/i;

/** Actual visual artifacts the action must point at to be a generation turn. */
const IMAGE_NOUN_RE =
  /\b(?:images?|pictures?|photos?|photographs?|diagrams?|illustrations?|illustrative\s+visuals?|visuals?|artworks?|paintings?|drawings?|sketches?|icons?|logos?|banners?|posters?|charts?|graphs?|infographics?|memes?|avatars?|thumbnails?|wallpapers?|scenes?|storyboards?|cartoons?|maps?|graphics?|figures?|schemas?|blueprints?|mind\s*maps?|flowcharts?|timelines?|collages?)\b/i;

/**
 * Visual UNDERSTANDING phrasing. These are reading/analyzing turns — the
 * opposite of generation — and must never route to the image tool.
 */
const IMAGE_UNDERSTANDING_RE =
  /\b(?:what(?:'s|s| is| does| do)?\s*(?:the\s+)?(?:this|that)?\s*(?:image|picture|photo|photograph|diagram|chart|graph|visual|figure|map|infographic|illustration)?\s*(?:show|mean|contain|depict|represent|tell|say|about)|explain(?: to me)?\s+(?:this|the|that)?\s*(?:image|picture|diagram|chart|graph|figure|map|infographic|visual)|describe\s+(?:this|the|that|my|the\s+attached)\s*(?:image|picture|diagram|chart|graph|figure|map|infographic|visual)|analyse?|analyze|identify|recogni[sz]e|interpret|this\s+image\s+shows|the\s+image\s+shows|in\s+this\s+image|in\s+the\s+image|what's\s+in|is\s+there\s+an?\s+image|which\s+image|where\s+is\s+the\s+image|which\s+one)(?![a-z])/i;

/** Semantic questions about images themselves ("what is an image?"). */
const IMAGE_CONCEPT_DEFINITION_RE =
  /^(?:what|define|explain)\s+(?:is\s+)?(?:an\s+|a\s+|the\s+)?(?:image|picture|photo|diagram|chart|graph|visual|illustration)(?:\s|$)/i;

/** A diagram/chart-family noun signals a document-grounded diagram request. */
const DIAGRAM_NOUN_RE =
  /\b(?:diagrams?|charts?|graphs?|infographics?|flowcharts?|schematics?|schemas?|mind\s*maps?|timelines?|blueprints?|maps?|figures?|visuals?|illustrations?)\b/i;

/** Explicitly ties the request to an attached document. */
const DOC_REFERENCE_PHRASE_RE =
  /\b(?:based\s+on|from\s+my|using\s+my|for\s+my|on\s+my|my\s+(?:document|notes|notes?|pdf|paper|file|upload|doc|document))\b/i;

/**
 * Follow-up refinement verbs ("make it at night", "change the color to blue",
 * "add a moon", "redraw it bigger").
 */
const REFINEMENT_VERB_RE =
  /\b(?:change|modify|update|alter|adjust|redraw|re-draw|edit|revis[ei]|customi[sz]e|recre?ate|remake|reimagine|recolor|recolour|colour|color|add|remove|without|including|excluding|make\s+it|make\s+this|now\s+with|with\s+a|with\s+an)\b/i;

/** Refinements are almost always short (a single instruction). */
const REFINEMENT_MAX_WORDS = 5;

/** Quick classifier for diagnostic logging only. */
export function looksLikeDiagramRequest(message: string): boolean {
  return DIAGRAM_NOUN_RE.test(message);
}

/**
 * True when the turn is a clear diagram/chart-family request that should be
 * grounded in whatever document is attached (RAG+image).
 */
export function grantsGrounding(message: string): boolean {
  return DIAGRAM_NOUN_RE.test(message) || DOC_REFERENCE_PHRASE_RE.test(message);
}

/**
 * Detects a direct image-generation request: generation verb + visual noun,
 * with understanding/definition phrasing rejected first. Pure and
 * deterministic — deliberately NOT fired by "what is an image?" or "which
 * image shows X?".
 */
export function detectImageGenerationIntent(message: string): ImageGenerationIntent {
  const text = message.trim().replace(/\s+/g, " ");
  if (!text) {
    return { detected: false, confidence: 0, reason: "Empty message." };
  }

  if (IMAGE_CONCEPT_DEFINITION_RE.test(text) || IMAGE_UNDERSTANDING_RE.test(text)) {
    return {
      detected: false,
      confidence: 0,
      reason: "Visual understanding / definition phrasing — not a generation request.",
    };
  }

  const hasAction = IMAGE_ACTION_RE.test(text);
  const hasNoun = IMAGE_NOUN_RE.test(text);

  // A pure VISUAL verb with a real subject is an unambiguous generation ask
  // even without an artifact noun: "draw a castle", "paint a sunset", "sketch
  // my dog", "render the scene". draw/paint/sketch/render/visualize/illustrate
  // never describe text production — unlike generate/create/make/design, which
  // still require an artifact noun so "generate a report" stays GENERAL.
  const hasUnambiguousVisualVerb =
    /^(?:please\s+)?(?:draw|paint|sketch|render|visuali[sz]e|illustrate)\b/i.test(
      text
    ) && text.split(/\s+/).length >= 2;

  if (!hasAction || (!hasNoun && !hasUnambiguousVisualVerb)) {
    return {
      detected: false,
      confidence: 0,
      reason: !hasNoun && !hasUnambiguousVisualVerb
        ? "No visual artifact noun or unambiguous visual verb (" +
          (IMAGE_ACTION_RE.test(text) ? "action but no image noun" : "no signal") +
          ")."
        : "No generation action verb.",
    };
  }

  // Imperative start ("draw a …") is the strongest signal.
  const imperative = /^(?:please\s+)?(?:generate|create|make\s+me|make|draw|render|visuali[sz]e|illustrate|design|produce|sketch|paint|compose)/i.test(
    text
  );
  const confidence = imperative ? 0.95 : 0.85;

  return {
    detected: true,
    confidence,
    reason: `Image generation request (${hasAction ? "action verb" : "noun"}+noun).`,
  };
}

/**
 * Detects a follow-up refinement of a previous image request: the PRIOR user
 * turn generated an image and the current short turn only edits it. Returns
 * an intent carrying `refinementOf` = the prior message so the prompt builder
 * can compose `priorPrompt + refinement`.
 */
export function detectImageGenerationRefinement(
  message: string,
  priorUserMessage: string | null | undefined
): ImageGenerationIntent | null {
  if (!priorUserMessage) return null;
  const prior = detectImageGenerationIntent(priorUserMessage);
  if (!prior.detected) return null;

  const text = message.trim().replace(/\s+/g, " ").replace(/[?!.]+\s*$/, "");
  if (!text) return null;

  // Understanding/definition turns and social chit-chat are NEVER refinements
  // of the previous image ("what does this image show?", "Thanks!").
  if (IMAGE_CONCEPT_DEFINITION_RE.test(text) || IMAGE_UNDERSTANDING_RE.test(text)) {
    return null;
  }
  if (
    /^(?:ok(?:ay)?|sure|great|nice|good|thanks?|thank\s+you|alright|yes|no|yep|nope|perfect|cool|done|awesome|got\s*it|fine)[!.\s]*$/i.test(
      text
    )
  ) {
    return null;
  }

  const words = text.split(/\s+/).length;
  const hasRefinementVerb = REFINEMENT_VERB_RE.test(text);
  // A very short instruction is always treated as a refinement of the last
  // image ("at night", "bigger", "without the hat").
  const isShort = words <= REFINEMENT_MAX_WORDS;

  if (!hasRefinementVerb && !isShort) return null;

  // Refuse to hijack turns that carry a NEW generation subject or fail the
  // noun/verb gates (they should be normal routing).
  const freshIntent = detectImageGenerationIntent(text);
  if (freshIntent.detected) return null;

  return {
    detected: true,
    confidence: 0.72,
    reason: `Refinement of the previous image request ("${priorUserMessage}").`,
    refinementOf: priorUserMessage,
  };
}

/**
 * Resolves the effective image-generation signal for a turn, combining a
 * direct request with (failing that) a refinement of the prior image turn.
 */
export function resolveImageGenerationIntent(
  message: string,
  priorUserMessage: string | null | undefined
): ImageGenerationIntent {
  const direct = detectImageGenerationIntent(message);
  if (direct.detected) return direct;
  const refinement = detectImageGenerationRefinement(message, priorUserMessage);
  if (refinement) return refinement;
  return { detected: false, confidence: 0, reason: "No image-generation signal." };
}