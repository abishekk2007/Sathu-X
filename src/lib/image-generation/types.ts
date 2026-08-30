// ---------------------------------------------------------------------------
// Phase 6C — Text → Image generation types
//
// Provider-agnostic contracts shared by the intent detector, prompt builder,
// providers (Gemini primary, Hugging Face fallback), and the orchestrating
// service. Everything here is server-side only — keys and raw bytes never
// leave the API route except as a validated data URL for the signed-in user.
//
// Phase 6E — Document → Visual generation reuses the same provider
// abstraction, fallback policy, and output contract. Its request carries
// STRUCTURED evidence items (never raw retrieval dumps) and honest metadata
// (`sourceGrounded`, `visualType`) on the produced image.
// ---------------------------------------------------------------------------

import type { DocumentVisualEvidenceItem } from "./document-visual-evidence";
import type { DocumentVisualType } from "./document-visual-types";

/** Supported output MIME types (validated from magic bytes). */
export type GeneratedImageMime = "image/png" | "image/jpeg" | "image/webp";

/** Supported aspect ratios (Gemini image config language). */
export type ImageAspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9";

/** Providers that can be enabled/ordered server-side. */
export type ImageProviderId = "gemini" | "huggingface";

/** A validated, normalized generated image ready for the client. */
export interface GeneratedImage {
  provider: ImageProviderId;
  mimeType: GeneratedImageMime;
  /** data:{mime};base64,<bytes> — safe to render in an <img> by the client. */
  dataUrl: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  /** The effective prompt actually sent to the provider. */
  prompt: string;
  /** Provider-reported rewritten prompt (Gemini enhance) if available. */
  enhancedPrompt?: string;
  /** Phase 6D: present when this image is an edit/regeneration result. */
  mode?: ImageEditKind;
  /** Phase 6D: key of the source image this edit was derived from. */
  editSourceKey?: string;
  /** Phase 6E: true when the visuals were grounded in retrieved document evidence. */
  sourceGrounded?: boolean;
  /** Phase 6E: closed-taxonomy visual type (informational metadata only). */
  visualType?: string | null;
}

/** Phase 6D — how the image was produced when it is not a fresh generation. */
export type ImageEditKind = "edit" | "regenerate";

/** Input a chat turn provides to the image pipeline (server-built only). */
export interface ImageGenerationRequest {
  /** The user's message (the image subject). */
  message: string;
  /** Chat mode — "student" activates educational-diagram hints. */
  mode?: string;
  /** Optional explicit style hint ("watercolor", "photorealistic", …). */
  style?: string;
  aspectRatio?: ImageAspectRatio;
  /** Optional default negative prompt (never user-controlled). */
  negativePrompt?: string;
  /**
   * Retrieved, verified evidence used ONLY to ground the prompt. When
   * `groundedRequired` is true and this is null/empty, generation is refused —
   * an image is never built from unverified document claims.
   */
  evidence?: string | null;
  /** True when the turn required RAG grounding (sources were attached). */
  groundedRequired?: boolean;
  /** Prior user turn (for "make it at night" refinement answers). */
  priorUserMessage?: string | null;
  abortSignal?: AbortSignal;
}

/**
 * Phase 6E — input the chat route provides to a document-visual generation.
 * Evidence travels as BOUNDED, DEDUPLICATED ITEMS — never raw retrieval dumps
 * and never the raw document. The service builds the structured visual spec,
 * enforces the chart numeric gate, guards refinement claims, and refuses when
 * no usable evidence exists (grounding is THE gate).
 */
export interface DocumentVisualGenerationRequest {
  /** The user's message (the visual ask, e.g. "Create an infographic from my PDF"). */
  message: string;
  /** Chat mode — "student" activates educational-diagram hints. */
  mode?: string;
  /** Optional explicit style hint ("watercolor", "minimalist", …). */
  style?: string;
  aspectRatio?: ImageAspectRatio;
  /** Optional default negative prompt (never user-controlled). */
  negativePrompt?: string;
  /** Verified evidence items from retrieval — MUST be non-empty to generate. */
  evidence: DocumentVisualEvidenceItem[];
  /** Closed-taxonomy visual type (from the deterministic intent detector). */
  requestedVisualType?: DocumentVisualType | null;
  /** Prior user turn (refinement base when present). */
  priorUserMessage?: string | null;
  /** When set, this turn is a refinement of the prior document-visual turn. */
  refinementOf?: string | null;
  abortSignal?: AbortSignal;
}

/**
 * Outcome of one image request. Either a real image, or an explainer message
 * (safe copy the user sees; never internal error detail).
 */
export type ImageOutcome =
  | { kind: "image"; message: string; image: GeneratedImage }
  | { kind: "message"; message: string };

/** Raw provider output before normalization/validation. */
export interface ProviderImageOutput {
  /** Raw image bytes. */
  data: Buffer;
  /** Declared MIME (often absent — always re-validated from bytes). */
  mimeType?: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  enhancedPrompt?: string;
}

/** Work a provider executes (prompt already composed by the service). */
export interface ProviderGenerationParams {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: ImageAspectRatio;
  abortSignal?: AbortSignal;
}

/**
 * Phase 6D — a conversation image reference. Metadata only: the full bytes
 * travel ONCE per edit request (never duplicated across history), from the
 * client's own copy of an image it rendered. Selection is server-authoritative
 * (conversation context + the user's language); the client matches bytes to a
 * key.
 */
export interface ImageContextRef {
  /** Stable client-supplied identifier for this image within the conversation. */
  key: string;
  provider?: string;
  mimeType?: string;
  prompt?: string;
  width?: number;
  height?: number;
}

/**
 * Phase 6D — input a chat turn provides to the image-edit pipeline. The route
 * decodes and validates `sourceImage.bytes` (magic bytes, size, dimensions)
 * BEFORE this reaches the service — client-declared MIME is never trusted.
 */
export interface ImageEditRequest {
  /** The user's editing instruction ("make the sky sunset"). */
  message: string;
  /** Chat mode — "student" activates educational-diagram hints. */
  mode?: string;
  /** Optional explicit style hint ("watercolor", "photorealistic", …). */
  style?: string;
  aspectRatio?: ImageAspectRatio;
  /** Optional default negative prompt (never user-controlled). */
  negativePrompt?: string;
  /** The source image to edit (validated by the route). */
  sourceImage: { bytes: Buffer; mimeType: string };
  /**
   * Optional mask region for inpainting. Left as an extension point: no current
   * provider path consumes it, so the service ignores it until one does.
   */
  mask?: { bytes: Buffer; mimeType: string };
  /**
   * Retrieved, verified evidence — reused exactly like IMAGE_GENERATION: when
   * `groundedRequired` is true and this is null/empty, the edit is refused.
   */
  evidence?: string | null;
  /** True when the edit required RAG grounding (sources were attached). */
  groundedRequired?: boolean;
  /** Prior user turn (for refinement/turn context). */
  priorUserMessage?: string | null;
  /** "regenerate" stamps the result as a regeneration (caption/labels). */
  kind?: ImageEditKind;
  /** Key of the conversation image this edit derives from (stamping only). */
  sourceKey?: string;
  abortSignal?: AbortSignal;
}

/** Work a provider executes for an edit (source image + instruction). */
export interface ProviderEditParams {
  /** Validated source image bytes + server-sniffed MIME. */
  sourceImage: { bytes: Buffer; mimeType: string };
  /** Composed edit instruction (the user's words + optional framing). */
  instruction: string;
  negativePrompt?: string;
  /** Optional; omitted for edits unless the caller explicitly chose a new ratio. */
  aspectRatio?: ImageAspectRatio;
  abortSignal?: AbortSignal;
}

/** A provider capable of producing image bytes from a text prompt. */
export interface ImageProvider {
  id: ImageProviderId;
  generate(params: ProviderGenerationParams): Promise<ProviderImageOutput>;
  /**
   * Phase 6D — optional image editing (source image + instruction → new image).
   * Providers that do NOT genuinely support reference-image editing simply do
   * not implement it; the service filters them out of the edit provider list.
   */
  edit?(params: ProviderEditParams): Promise<ProviderImageOutput>;
}

/**
 * Internal failure taxonomy. Codes mapped to public copy by the service:
 *  - eligible-for-fallback: timeout, rate_limited, provider_unavailable,
 *    provider_invalid_response  → try the next provider, then a safe message.
 *  - never-fallback: safety_blocked (user content, not a provider fault),
 *    provider_auth (config), invalid_request, misconfigured.
 */
export type ImageFailureCode =
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_invalid_response"
  | "safety_blocked"
  | "provider_auth"
  | "invalid_request"
  | "misconfigured";

/** Thrown by providers; the service decides fallback from `code`. */
export class ImageFailure extends Error {
  readonly code: ImageFailureCode;
  constructor(code: ImageFailureCode, message: string) {
    super(message);
    this.name = "ImageFailure";
    this.code = code;
  }
}

/** Human copy shown to the user for a fully-failed generation. */
export const SAFE_UNAVAILABLE_MESSAGE =
  "Image generation is temporarily unavailable. Please try again.";

/** Copy shown when RAG grounding was required but nothing verifiable matched. */
export const SAFE_NO_GROUNDING_MESSAGE =
  "I couldn't find enough information in your document to create that image. " +
  "Try asking again once a matching section is attached.";

/** Phase 6D — safe copy when an edit could not be completed. */
export const SAFE_EDIT_UNAVAILABLE_MESSAGE =
  "I couldn't edit the image right now. Please try again.";

/** Phase 6D — an edit was requested but no image exists to edit. */
export const SAFE_EDIT_NO_IMAGE_MESSAGE =
  "I don't have an image to edit yet. Ask me to generate one first (for example, " +
  "\"draw a castle\"), or upload an image, and then tell me how you'd like it changed.";

/** Phase 6D — multiple images, unresolvable reference; ask once, edit nothing. */
export const SAFE_EDIT_CLARIFY_MESSAGE =
  "Which image would you like me to edit? Mention the one you mean (for example, " +
  "\"edit the second image\").";

/** Phase 6D — the selected source image failed server-side validation. */
export const SAFE_EDIT_INVALID_SOURCE_MESSAGE =
  "I couldn't read that image. Please try a different image.";

/** Phase 6E — a document visual was requested but no document is attached. */
export const SAFE_DOC_VISUAL_NO_DOC_MESSAGE =
  "That needs your document. Attach the PDF or notes you'd like me to work from, then ask me again.";

/** Phase 6E — a chart was requested but the evidence has no numerical values. */
export const SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE =
  "I can only draw charts from documents that actually contain numerical data, " +
  "and I didn't find usable numbers to visualise. I'd be happy to make a diagram " +
  "or an infographic from what the document does say instead.";

/** Phase 6E — a refinement tried to introduce facts the evidence cannot support. */
export const SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE =
  "I can't add that to the visual — it isn't supported by your document's content, " +
  "and I won't put unverified facts into a document-grounded visual.";

/** Default negative prompt (guidance only; never user-controlled). */
export const DEFAULT_NEGATIVE_PROMPT =
  "blurry, low quality, distorted anatomy, twisted or garbled text, " +
  "watermark, signature, extra limbs, jpeg artifacts, oversaturated, duplicate content";