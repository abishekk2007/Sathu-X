// ---------------------------------------------------------------------------
// Phase 6C — Prompt composition
//
// Deterministic prompt builder. The user's words are the subject — never
// rewritten — with a bounded educational-diagram hint added in student mode
// and, ONLY when retrieved evidence was actually found, a strict grounding
// block that the image model must follow exactly (no fabricated facts).
// ---------------------------------------------------------------------------

import type { ImageAspectRatio } from "./types";
import { DEFAULT_NEGATIVE_PROMPT } from "./types";
import { detectImageGenerationIntent } from "./intent";

/** Hard cap on the effective prompt length (characters). */
export const PROMPT_MAX_CHARS = 900;

/** Hard cap on the grounded-evidence block (characters). */
export const EVIDENCE_MAX_CHARS = 600;

/** Educational hint for student mode — keeps diagrams labelled and simple. */
const EDUCATIONAL_HINT =
  "This is a study aid. Keep it educational: clean labels, accurate subject " +
  "matters, readable text, simple and visually clear layout.";

const DEFAULT_ASPECT: ImageAspectRatio = "1:1";

const VALID_ASPECTS: readonly ImageAspectRatio[] = [
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
];

export function normalizeAspectRatio(value: unknown): ImageAspectRatio {
  return VALID_ASPECTS.includes(value as ImageAspectRatio)
    ? (value as ImageAspectRatio)
    : DEFAULT_ASPECT;
}

function cleanSubject(message: string): string {
  return message.trim().replace(/\s+/g, " ").replace(/[?!.]+$/, "").slice(0, PROMPT_MAX_CHARS);
}

/** Result of prompt composition. */
export interface ComposedPrompt {
  /** Full effective prompt sent to the provider. */
  prompt: string;
  negativePrompt: string;
  aspectRatio: ImageAspectRatio;
}

export function buildImagePrompt(input: {
  message: string;
  mode?: string;
  style?: string;
  aspectRatio?: ImageAspectRatio;
  negativePrompt?: string;
  evidence?: string | null;
  priorUserMessage?: string | null;
}): ComposedPrompt {
  const subject = cleanSubject(input.message);
  const aspectRatio = normalizeAspectRatio(input.aspectRatio);
  const negativePrompt = input.negativePrompt
    ? String(input.negativePrompt).slice(0, 400)
    : DEFAULT_NEGATIVE_PROMPT;

  const parts: string[] = [];

  const subjectPortion = input.priorUserMessage && !detectImageGenerationIntent(subject).detected
    ? // Refinement turn: recompose the prior subject deterministically and
      // append the editing instruction, so "make it at night" keeps the
      // dragon's original description as its base.
      `${cleanSubject(input.priorUserMessage)}; refinement: ${subject}`
    : subject;

  parts.push(subjectPortion || "a clean, simple illustration");

  if (input.style && input.style.trim()) {
    parts.push(`Style: ${input.style.trim().slice(0, 200)}.`);
  }

  if (input.mode === "student") {
    parts.push(EDUCATIONAL_HINT);
  }

  if (input.evidence && input.evidence.trim()) {
    const evidenceText = input.evidence
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, EVIDENCE_MAX_CHARS);
    parts.push(
      `Ground the image ONLY in these verified facts and add nothing unverified:\n${evidenceText}`
    );
  }

  const prompt = parts.join("\n").slice(0, PROMPT_MAX_CHARS);

  return { prompt, negativePrompt, aspectRatio };
}

// ---------------------------------------------------------------------------
// Phase 6D — edit instruction composition
// ---------------------------------------------------------------------------

/**
 * Result of edit-prompt composition. The instruction (the user's words, plus
 * optional framing) is passed to the edit provider alongside the source image
 * bytes — the provider is responsible for combining them.
 */
export interface ComposedEditPrompt {
  /** Effective edit instruction sent to the provider. */
  instruction: string;
  negativePrompt: string;
  /** Optional; omitted unless the caller explicitly chose a new ratio. */
  aspectRatio?: ImageAspectRatio;
}

/**
 * Builds the instruction for an image edit. The user's words are the edit —
 * never rewritten — plus bounded educational/writing framing that must not
 * distort them, and a strict grounding block ONLY when retrieved evidence
 * exists (the edit service refuses when grounding was required but empty).
 */
export function buildImageEditPrompt(input: {
  message: string;
  mode?: string;
  style?: string;
  aspectRatio?: ImageAspectRatio;
  negativePrompt?: string;
  evidence?: string | null;
  /** "regenerate" requests a redo/new-version of the same reference image. */
  kind?: "edit" | "regenerate";
}): ComposedEditPrompt {
  const instruction = cleanSubject(input.message) || "adjust the image";
  const negativePrompt = input.negativePrompt
    ? String(input.negativePrompt).slice(0, 400)
    : DEFAULT_NEGATIVE_PROMPT;
  const aspectRatio = input.aspectRatio
    ? normalizeAspectRatio(input.aspectRatio)
    : undefined;

  const parts: string[] = [];

  if (input.kind === "regenerate") {
    parts.push(`Regenerate the provided reference image:`);
  } else {
    parts.push(`Edit the provided reference image according to this instruction:`);
  }
  parts.push(instruction);

  if (input.style && input.style.trim()) {
    parts.push(`Style: ${input.style.trim().slice(0, 200)}.`);
  }

  if (input.mode === "student") {
    parts.push(EDUCATIONAL_HINT);
  }

  if (input.evidence && input.evidence.trim()) {
    const evidenceText = input.evidence
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, EVIDENCE_MAX_CHARS);
    parts.push(
      `Ground the edited image ONLY in these verified facts and add nothing unverified:\n${evidenceText}`
    );
  }

  return {
    instruction: parts.join("\n").slice(0, PROMPT_MAX_CHARS),
    negativePrompt,
    aspectRatio,
  };
}