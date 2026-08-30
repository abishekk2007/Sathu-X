// ---------------------------------------------------------------------------
// Phase 6D — Existing image → edited/regenerated image intent detection
//
// Deterministic, pure detection (no LLM, no network) so the router can slot
// IMAGE_EDIT into its priority ladder without surprises. Mirrors the 6A/6C
// style: rule-based, conservative, exhaustively tested.
//
// CRITICAL RULES
//   - Every edit needs a SOURCE image. "Make it more colorful." alone is
//     ambiguous, but after "Generate an image of a water cycle." + [image] it
//     is an unambiguous edit of the previous image.
//   - Visual UNDERSTANDING turns ("what does this image show?", "explain this
//     diagram") are NEVER edits — they stay on their normal routes.
//   - Fresh generation ("generate an image of a cat", "create a futuristic
//     city") is NEVER an edit.
//   - With NO image in context, an edit turn still routes to IMAGE_EDIT but as
//     a CLARIFICATION (selectionKey null) so the chat route replies with a
//     safe no-image message and NEVER calls an image provider.
//   - With multiple images, selection resolves only from explicit language
//     (ordinals, "previous/last", deictics) — otherwise it is a clarification,
//     never an arbitrary pick.
// ---------------------------------------------------------------------------

import type { ImageContextRef } from "./types";

/** Result of running the image-edit detector on a turn. */
export interface ImageEditIntent {
  detected: boolean;
  /** Heuristic 0..1. Guidance only. */
  confidence: number;
  /** Server-side rationale (never shown to the client). */
  reason: string;
  /** "edit" for modifications, "regenerate" for redo/new-version requests. */
  requestKind?: "edit" | "regenerate";
  /**
   * Key of the image this turn edits (from the conversation image context).
   * Null when nothing could be resolved: the route must either ask which image
   * (multiple/unresolved) or tell the user no image exists yet — and MUST NOT
   * call a provider.
   */
  selectionKey?: string | null;
  /** True when the route should answer with a clarification, editing nothing. */
  requiresClarification?: boolean;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Explicit image-modification verbs. */
const EDIT_VERB_RE =
  /\b(?:edit(?:s|ed|ing)?|modif(?:y|ies|ied)|change(?:s|d)?|alter(?:s|ed)?|transform(?:s|ed)?|restyle(?:d)?|recolor(?:s|ed)?|recolour(?:s|ed)?|re-color|re-colour|adjust(?:s|ed)?|redraw(?:\s+it)?|re-draw|redo|remake|recreate|re-create|remix|reimagine|reimaged|replace|convert|transform|update|tweak(?:ed)?|enhance(?:d)?|improve(?:d)?|brighten|darken|sharpen|soften|blur|flip|invert|crop|erase|extend|remove|delete|add|label(?:led|ling|s)?|annotate(?:s|d)?|take\s+out|take\s+away|make|turn|set|style)\b/i;

/** Deictic references to a specific image. */
const DEICTIC_IMAGE_REF_RE =
  /\b(?:this\s+image|that\s+image|the\s+(?:last|previous|latest|most\s+recent)\s+image|the\s+(?:first|second|third|fourth|fifth)\s+image|(?:first|second|third|fourth|fifth)\s*(?:st|nd|rd|th)?\s+image|the\s+(?:image|picture|photo|diagram)\s+(?:above|below)|my\s+(?:image|picture|photo)|the\s+(?:last|previous|latest|most\s+recent)\s+(?:one|image\s+generated)|previous\s+(?:image|picture|photo|diagram)|last\s+(?:image|picture|photo|diagram))\b/i;

/** Image nouns (for "regenerate this image", "edit the diagram", …). */
const IMAGE_NOUN_RE =
  /\b(?:image|picture|photo|photograph|diagram|chart|graph|illustration|artwork|painting|drawing|sketch|logo|meme|poster|infographic)\b/i;

/** Cheap deictic pronouns — only meaningful WITH an edit signal + image. */
const DEICTIC_PRONOUN_RE = /\b(?:it|this|that|these|those)\b/i;

/**
 * Structural edit frame: "make the sky sunset", "change the background to a
 * beach", "turn the car red", "set the lighting warmer".
 */
const SURFACE_FRAME_RE =
  /\b(?:make|change|turn|set|convert|recolor|recolour)(?:\s+the|\s+this|\s+that|\s+my|\s+its)?\s+(?:background|foreground|sky|colors?|colours?|palette|lighting|style|theme|scene|composition|car|tree|object|subject)\b/i;

/** Style / appearance modifiers that anchor an edit to an existing image. */
const STYLE_HINT_RE =
  /\b(?:cartoon|watercolor(?:s)?|watercolour(?:s)?|anime|oil\s+painting|sketch(?:ed)?|photorealistic|realistic|minimalist|manga|comic|pixel\s+art|3d\s+render|isometric|flat\s+design|impressionist|art\s+nouveau|cyberpunk|steampunk|vintage|modern|cleaner|simpler|clearer|brighter|darker|more\s+realistic|more\s+colorful|more\s+colourful|more\s+detailed|more\s+educational|easier\s+for\s+students|suitable\s+for\s+students|looks?\s+like|look\s+like|in\s+the\s+style\s+of|as\s+a\s+(?:painting|sketch|cartoon)|make\s+it\s+look)\b/i;

/** Regeneration requests ("regenerate this", "redo", "try again"). */
const REGENERATE_RE =
  /\b(?:regenerate|re-generate|redo|re-do|try\s+again|do\s+(?:it|that|this)\s+again|another\s+(?:version|take|one)|one\s+more\s+(?:version|time)|new\s+version|newer\s+version|variant|render\s+(?:it|this|that)\s+again)\b/i;

/** Ordinal selectors: "first/second/third/… image", "1st/2nd/3rd image". */
const ORDINAL_RE =
  /\b(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\s*(?:image|picture|photo|diagram|one)\b/i;

/** Negative signals never edits: visual understanding + concept definitions. */
const UNDERSTANDING_RE =
  /\b(?:what(?:'s|s|\s+is|\s+does|\s+do)?\s*(?:the\s+)?(?:this|that|your|my|the)?\s*(?:image|picture|photo|photograph|diagram|chart|graph|figure|map|visual)\s*(?:show|mean|contain|depict|represent|tell|say|about)|explain\s+(?:to\s+me\s+)?(?:this|the|that|my)\s*(?:image|picture|diagram|chart|graph|figure|map|visual)|describe\s+(?:this|the|that|my)\s*(?:image|picture|diagram|chart|graph|figure|map|visual)|analyse?|analy(?:se|ze)|identif(?:y|ies|ied)|interpret|read\s+(?:this|that|the)\s*(?:image|diagram)|what's\s+in|is\s+there\s+an?\s+image|which\s+image|what\s+is\s+(?:in|the\s+content\s+of)\s+(?:this|that|the)\s*(?:image|picture|photo|diagram))(?![\w-])/i;

const DEFINITION_RE =
  /^(?:what|define|explain)\s+(?:is\s+)?(?:an\s+|a\s+|the\s+)?(?:image|picture|photo|diagram|chart|graph|visual|illustration)(?:\s|$)/i;

/** Fresh-generation lead verbs — a new subject is NOT an edit. */
const FRESH_GENERATION_LEAD_RE =
  /^(?:please\s+)?(?:generate|create|draw|paint|render|visuali[sz]e|illustrate|design|produce|sketch|compose)\b/i;

/** Social/acknowledgement filler — never edits. */
const CHITCHAT_RE =
  /^(?:ok(?:ay)?|sure|great|nice|good|thanks?|thank\s+you|alright|yes|no|yep|nope|perfect|cool|awesome|got\s*it)[!.\s]*$/i;

// ---------------------------------------------------------------------------
// Selection resolution
// ---------------------------------------------------------------------------

const ORDINAL_MAP: Record<string, number> = {
  first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2,
  fourth: 3, "4th": 3, fifth: 4, "5th": 4, sixth: 5, "6th": 5,
  seventh: 6, "7th": 6, eighth: 7, "8th": 7, ninth: 8, "9th": 8,
  tenth: 9, "10th": 9,
};

function resolveSelectionKey(
  message: string,
  images: ImageContextRef[]
): { key: string | null; clarify: boolean; reason: string } {
  if (images.length === 0) {
    return { key: null, clarify: true, reason: "No image context to select from." };
  }
  if (images.length === 1) {
    return { key: images[0].key, clarify: false, reason: "Single image in context." };
  }

  const text = message.trim().replace(/\s+/g, " ").toLowerCase();

  // Explicit ordinal: "edit the second image".
  const ordinalMatch = text.match(ORDINAL_RE);
  if (ordinalMatch) {
    const noun = ordinalMatch[0].trim();
    const word = noun.replace(/^the\s+/, "").replace(/\s*(?:image|picture|photo|diagram|one)\b.*$/, "");
    const index = ORDINAL_MAP[word];
    if (index !== undefined) {
      if (index < images.length) {
        return { key: images[index].key, clarify: false, reason: `Ordinal "${word}" image.` };
      }
      return {
        key: null,
        clarify: true,
        reason: `Ordinal "${word}" is beyond the ${images.length} image(s) in context.`,
      };
    }
  }

  // "previous/last/latest/most recent".
  if (/\b(?:previous|last|latest|most\s+recent)\b/.test(text)) {
    return { key: images[images.length - 1].key, clarify: false, reason: "Most recent image." };
  }

  // Deictic "this/that/it/my/the image" → most recent relevant image.
  if (
    DEICTIC_IMAGE_REF_RE.test(text) ||
    (DEICTIC_PRONOUN_RE.test(text) && !/^the\b/.test(text))
  ) {
    return { key: images[images.length - 1].key, clarify: false, reason: "Deictic reference to the most recent image." };
  }

  // Subject match against the recorded prompt when metadata carries it.
  const subjectTokens = (text.match(/\b[a-z]{3,}\b/g) ?? []).filter(
    (w) => !["the", "and", "with", "for", "edit", "image", "picture", "photo", "remove", "change", "make", "please", "this", "that", "from", "on", "in", "to"].includes(w)
  );
  if (subjectTokens.length > 0) {
    let bestIndex = -1;
    let bestScore = 0;
    images.forEach((img, i) => {
      const prompt = `${img.prompt ?? ""}`.toLowerCase();
      let score = 0;
      for (const token of subjectTokens) {
        if (prompt.includes(token)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });
    if (bestScore >= 2) {
      return { key: images[bestIndex].key, clarify: false, reason: "Subject matched against image prompts." };
    }
  }

  return {
    key: null,
    clarify: true,
    reason: "Multiple images and no explicit reference that resolves.",
  };
}

// ---------------------------------------------------------------------------
// Public detector
// ---------------------------------------------------------------------------

/**
 * Detects an edit/regeneration of an EXISTING image. Returns a clarification
 * (selectionKey null) when the language clearly edits an image but no image —
 * or no unique image — is available. Conversational deictics only count when
 * an image is actually present ("make it more colorful" after a generation is
 * an edit; standing alone it is ordinary chat).
 */
export function detectImageEditIntent(
  message: string,
  images: ImageContextRef[] = []
): ImageEditIntent {
  const text = message.trim().replace(/\s+/g, " ");
  if (!text) {
    return { detected: false, confidence: 0, reason: "Empty message." };
  }

  if (CHITCHAT_RE.test(text) || DEFINITION_RE.test(text) || UNDERSTANDING_RE.test(text)) {
    return {
      detected: false,
      confidence: 0,
      reason: "Understanding / definition / chit-chat — not an image edit.",
    };
  }

  const hasEditVerb = EDIT_VERB_RE.test(text);
  const hasDeicticImageRef = DEICTIC_IMAGE_REF_RE.test(text);
  const hasPronoun = DEICTIC_PRONOUN_RE.test(text);
  const hasSurfaceFrame = SURFACE_FRAME_RE.test(text);
  const hasStyleHint = STYLE_HINT_RE.test(text);
  const hasRegenerate = REGENERATE_RE.test(text);
  const hasImageNoun = IMAGE_NOUN_RE.test(text);

  // A fresh generation lead with a real subject and NO image reference is NOT
  // an edit ("draw a castle", "generate an image of a cat"). Explicit
  // regenerate/deictic phrasing overrides generation leads ("generate the same
  // image with a sunset" still names no deictic, but "render it again" does).
  if (FRESH_GENERATION_LEAD_RE.test(text) && !hasDeicticImageRef && !hasPronoun && !hasRegenerate) {
    return {
      detected: false,
      confidence: 0,
      reason: "Fresh generation request with a new subject — not an edit.",
    };
  }

  if (images.length > 0) {
    const hasSignal = hasEditVerb || hasDeicticImageRef || hasSurfaceFrame || hasRegenerate ||
      (hasPronoun && (hasStyleHint || hasRegenerate || hasSurfaceFrame)) ||
      (hasStyleHint && (hasDeicticImageRef || hasPronoun || hasImageNoun || hasEditVerb));
    if (!hasSignal) {
      return {
        detected: false,
        confidence: 0,
        reason: "No image-edit signal against the conversation image context.",
      };
    }
    const selection = resolveSelectionKey(text, images);
    const requestKind: "edit" | "regenerate" =
      hasRegenerate && !hasSurfaceFrame ? "regenerate" : "edit";
    return {
      detected: true,
      confidence: selection.key ? 0.95 : 0.8,
      reason: selection.reason + (hasRegenerate && !hasSurfaceFrame ? " (regeneration)." : ""),
      requestKind,
      selectionKey: selection.key,
      requiresClarification: selection.clarify,
    };
  }

  // No image in context: ONLY unmistakable image-reference phrasing is a
  // (clarifying) edit request — the route answers with SAFE_EDIT_NO_IMAGE and
  // never calls a provider. Everything weaker stays ordinary chat. A structural
  // edit frame ("make the sky sunset", "turn the car red") counts too: the
  // user clearly describes a modification of something that does not exist
  // yet, so the correct reply is guidance, not a silent general answer.
  const unmistakable =
    (hasEditVerb && hasDeicticImageRef) ||
    (hasRegenerate && hasDeicticImageRef) ||
    (hasEditVerb && hasPronoun && /(?:edit|modify|redo|regenerate|change|alter|transform|recolor|recolour|restyle|remake)\s+(?:it|this|that)/i.test(text)) ||
    /(?:edit|modify|regenerate)\s+(?:the\s+image|the\s+picture|my\s+image)/i.test(text) ||
    hasSurfaceFrame;
  if (unmistakable) {
    return {
      detected: true,
      confidence: 0.75,
      reason: "Explicit image-edit request but no image exists in context.",
      requestKind: hasRegenerate && !hasEditVerb ? "regenerate" : "edit",
      selectionKey: null,
      requiresClarification: true,
    };
  }

  return {
    detected: false,
    confidence: 0,
    reason: "No image in context and no unambiguous image reference.",
  };
}

/** Convenience: true when a turn requests an image EDIT (any form). */
export function isImageEditRequest(message: string, images: ImageContextRef[] = []): boolean {
  return detectImageEditIntent(message, images).detected;
}