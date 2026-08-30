// ---------------------------------------------------------------------------
// Phase 6C — Text → Image orchestration service
//
// Server-controlled provider order (Gemini primary, Hugging Face fallback).
// The client can never influence which provider runs, and the request only
// ever carries the user's words + mode — never keys, never raw errors.
//
// Fallback policy (bounded):
//   - Eligible failures (timeout / rate_limited / provider_unavailable /
//     provider_invalid_response) try the NEXT provider in the resolved order.
//   - safety_blocked, provider_auth, invalid_request, misconfigured stop
//     immediately — they are never "fixed" by switching providers.
//   - Each provider runs ONCE per request (no infinite retries).
//
// Phase 6D — image EDITING shares the same provider abstraction and policy.
// A provider genuinely supports editing only when it implements `edit()`;
// the edit pipeline filters providers to those, so an unavailable edit
// capability is reported honestly rather than faked by re-using text→image.
// ---------------------------------------------------------------------------

import { validateImage } from "@/lib/multimodal/image-processing";
import { detectImageGenerationIntent } from "./intent";
import { buildImageEditPrompt, buildImagePrompt } from "./prompt";
import { normalizeEvidence } from "./document-visual-evidence";
import {
  buildDocumentVisualPrompt,
  buildDocumentVisualSpec,
  guardRefinementClaims,
} from "./document-visual-prompt";
import type {
  DocumentVisualGenerationRequest,
  GeneratedImage,
  ImageEditRequest,
  ImageFailureCode,
  ImageGenerationRequest,
  ImageOutcome,
  ImageProvider,
  ImageProviderId,
  ProviderImageOutput,
} from "./types";
import {
  ImageFailure,
  SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE,
  SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE,
  SAFE_EDIT_UNAVAILABLE_MESSAGE,
  SAFE_NO_GROUNDING_MESSAGE,
  SAFE_UNAVAILABLE_MESSAGE,
} from "./types";
import { geminiImageProvider } from "./gemini-provider";
import { huggingfaceImageProvider } from "./huggingface-provider";

const KNOWN_PROVIDER_IDS: readonly ImageProviderId[] = ["gemini", "huggingface"];
const DEFAULT_PROVIDER_ORDER: readonly ImageProviderId[] = [
  "gemini",
  "huggingface",
];
const PROVIDER_INDEX: Record<ImageProviderId, ImageProvider> = {
  gemini: geminiImageProvider,
  huggingface: huggingfaceImageProvider,
};

/**
 * Server-controlled provider order. Env IMAGE_PROVIDERS is the ONLY input;
 * invalid/unknown ids are dropped and duplicates removed. Never client input.
 */
export function resolveProviderOrder(): ImageProviderId[] {
  const raw = process.env.IMAGE_PROVIDERS?.trim();
  if (!raw) return [...DEFAULT_PROVIDER_ORDER];
  const seen = new Set<ImageProviderId>();
  const order: ImageProviderId[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim() as ImageProviderId;
    if (KNOWN_PROVIDER_IDS.includes(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  return order.length > 0 ? order : [...DEFAULT_PROVIDER_ORDER];
}

/** Hard ceiling for a single provider call (wall clock). */
export const PROVIDER_TIMEOUT_MS = 60_000;

/** Maximum generated-image size accepted from a provider. */
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

/** Failure codes that justify trying the next provider. */
const ELIGIBLE_FALLBACK_CODES: readonly ImageFailureCode[] = [
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "provider_invalid_response",
];

function isEligibleForFallback(code: ImageFailureCode): boolean {
  return ELIGIBLE_FALLBACK_CODES.includes(code);
}

/**
 * One provider attempt with the shared bounded policy: each provider runs at
 * most once, eligible failures (timeout / rate_limited / provider_unavailable /
 * provider_invalid_response) move to the next provider, and anything else
 * (safety, auth, config, bad requests) stops immediately with the safe copy.
 */
async function runWithPolicy<P extends ImageProvider>(flip: {
  providers: P[];
  invoke: (provider: P) => Promise<ProviderImageOutput>;
  normalize: (provider: P, output: ProviderImageOutput, composed: string) => GeneratedImage;
  composedText: string;
  caption: string;
  unavailableMessage: string;
}): Promise<ImageOutcome> {
  for (const provider of flip.providers) {
    try {
      const output = await withTimeout(flip.invoke(provider), PROVIDER_TIMEOUT_MS);
      const image = flip.normalize(provider, output, flip.composedText);
      return { kind: "image", message: flip.caption, image };
    } catch (error) {
      const code =
        error instanceof ImageFailure
          ? error.code
          : "provider_unavailable";
      if (!isEligibleForFallback(code)) {
        // Safety blocks, auth/config failures, invalid requests — do NOT
        // shift to another provider. Surface the safe copy and stop.
        return { kind: "message", message: flip.unavailableMessage };
      }
      console.error(
        `[image-generation] provider=${provider.id} failed code=${code} — trying next`
      );
    }
  }

  return { kind: "message", message: flip.unavailableMessage };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("provider call exceeded the time budget");
      err.name = "AbortError";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Validates provider bytes and builds the normalized result. Throws
 * ImageFailure("provider_invalid_response") when bytes aren't a usable image.
 */
function normalizeOutput(
  provider: ImageProvider,
  output: Awaited<ReturnType<ImageProvider["generate"]>>,
  effectivePrompt: string
): GeneratedImage {
  const validation = validateImage(output.data, output.mimeType ?? "", {
    maxImageSizeBytes: MAX_OUTPUT_BYTES,
    maxImageDimension: 10_000,
  });
  if (!validation.ok || !validation.mimeType) {
    throw new ImageFailure(
      "provider_invalid_response",
      validation.error || "generated image failed validation"
    );
  }

  return {
    provider: provider.id,
    mimeType: validation.mimeType,
    dataUrl: `data:${validation.mimeType};base64,${output.data.toString("base64")}`,
    width: validation.width ?? 0,
    height: validation.height ?? 0,
    fileSizeBytes: output.data.length,
    prompt: effectivePrompt,
    enhancedPrompt: output.enhancedPrompt,
  };
}

function captionFor(outcome: { grounded: boolean; refined: boolean }): string {
  if (outcome.refined) return "Here's your updated image.";
  if (outcome.grounded) return "Here's an image grounded in your attached document.";
  return "Here's the image you asked for.";
}

/**
 * Runs image generation through an explicit provider list (testable without
 * network/keys). The provider order is resolved by the caller; the service
 * enforces the fallback policy and output validation.
 */
export async function generateImageWithProviders(
  request: ImageGenerationRequest,
  providers: ImageProvider[]
): Promise<ImageOutcome> {
  // RAG-grounding gate: NEVER build an image from unverified (or no) evidence
  // when the turn required the attached document as the source of truth.
  if (request.groundedRequired && !request.evidence?.trim()) {
    return { kind: "message", message: SAFE_NO_GROUNDING_MESSAGE };
  }

  const composed = buildImagePrompt({
    message: request.message,
    mode: request.mode,
    style: request.style,
    aspectRatio: request.aspectRatio,
    negativePrompt: request.negativePrompt,
    evidence: request.evidence,
    priorUserMessage: request.priorUserMessage,
  });

  const params = {
    prompt: composed.prompt,
    negativePrompt: composed.negativePrompt,
    aspectRatio: composed.aspectRatio,
    abortSignal: request.abortSignal,
  };

  // Refinement captions only apply when the prompt builder actually composed
  // `prior; refinement: <turn>` — a fresh generation request with an unrelated
  // prior user turn still gets the plain caption.
  const refined =
    Boolean(request.priorUserMessage) &&
    !detectImageGenerationIntent(request.message.trim()).detected;

  return runWithPolicy({
    providers,
    invoke: (provider) => provider.generate(params),
    normalize: (provider, output, composedText) => normalizeOutput(provider, output, composedText),
    composedText: composed.prompt,
    caption: captionFor({ grounded: Boolean(request.evidence?.trim()), refined }),
    unavailableMessage: SAFE_UNAVAILABLE_MESSAGE,
  });
}

/**
 * Public entry point used by the API route. Resolves the server-controlled
 * provider order, then delegates to generateImageWithProviders.
 */
export async function generateImage(request: ImageGenerationRequest): Promise<ImageOutcome> {
  const order = resolveProviderOrder();
  const providers = order.map((id) => PROVIDER_INDEX[id]).filter(Boolean);
  return generateImageWithProviders(request, providers);
}

// ---------------------------------------------------------------------------
// Phase 6D — image editing
// ---------------------------------------------------------------------------

function captionForEdit(kind?: "edit" | "regenerate"): string {
  return kind === "regenerate" ? "Here's the regenerated image." : "Here's your edited image.";
}

/**
 * Runs an image edit (source image + instruction) through the providers that
 * genuinely implement `edit()`. Everything else mirrors the generation path:
 * the RAG-grounding gate, the composed prompt, per-provider attempts with the
 * shared failure taxonomy, and magic-byte output validation. Providers that do
 * NOT support editing are excluded up front, so an unavailable edit capability
 * never degrades into a text→image "fake edit".
 */
export async function editImageWithProviders(
  request: ImageEditRequest,
  providers: ImageProvider[]
): Promise<ImageOutcome> {
  if (request.groundedRequired && !request.evidence?.trim()) {
    return { kind: "message", message: SAFE_NO_GROUNDING_MESSAGE };
  }

  const composed = buildImageEditPrompt({
    message: request.message,
    mode: request.mode,
    style: request.style,
    aspectRatio: request.aspectRatio,
    negativePrompt: request.negativePrompt,
    evidence: request.evidence,
    kind: request.kind,
  });

  const params = {
    sourceImage: {
      bytes: request.sourceImage.bytes,
      mimeType: request.sourceImage.mimeType,
    },
    instruction: composed.instruction,
    negativePrompt: composed.negativePrompt,
    ...(composed.aspectRatio ? { aspectRatio: composed.aspectRatio } : {}),
    abortSignal: request.abortSignal,
  };

  const editProviders = providers.filter(
    (provider): provider is ImageProvider & { edit: NonNullable<ImageProvider["edit"]> } =>
      typeof provider.edit === "function"
  );

  return runWithPolicy({
    providers: editProviders,
    invoke: (provider) => provider.edit(params),
    normalize: (provider, output, composedText) => {
      const image: GeneratedImage = {
        ...normalizeOutput(provider, output, composedText),
        mode: request.kind ?? "edit",
        ...(request.sourceKey ? { editSourceKey: request.sourceKey } : {}),
      };
      return image;
    },
    composedText: composed.instruction,
    caption: captionForEdit(request.kind),
    unavailableMessage: SAFE_EDIT_UNAVAILABLE_MESSAGE,
  });
}

/**
 * Public entry point for image edits. Resolves the server-controlled provider
 * order and delegates to editImageWithProviders (which excludes providers that
 * do not implement editing).
 */
export async function editImage(request: ImageEditRequest): Promise<ImageOutcome> {
  const order = resolveProviderOrder();
  const providers = order.map((id) => PROVIDER_INDEX[id]).filter(Boolean);
  return editImageWithProviders(request, providers);
}

// ---------------------------------------------------------------------------
// Phase 6E — document → visual generation
// ---------------------------------------------------------------------------

/**
 * Runs document-grounded visual generation through an explicit provider list
 * (testable without network/keys). THE GROUNDING GATE: with no usable evidence
 * the service refuses — an image is NEVER built from unverified (or no)
 * document content. Chart request without numerical evidence is refused with
 * an honest copy. Refinements are claim-guarded so a follow-up can change
 * presentation but never smuggle in unsupported facts. One eligible failure →
 * next provider; safety/auth/config failures stop immediately.
 */
export async function generateDocumentVisualWithProviders(
  request: DocumentVisualGenerationRequest,
  providers: ImageProvider[]
): Promise<ImageOutcome> {
  const items = normalizeEvidence(request.evidence ?? []);
  if (items.length === 0) {
    return { kind: "message", message: SAFE_NO_GROUNDING_MESSAGE };
  }

  const spec = buildDocumentVisualSpec(request.requestedVisualType ?? null, items);

  if (spec.visualType === "chart" && !spec.hasNumericEvidence) {
    return { kind: "message", message: SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE };
  }

  const refinement = request.refinementOf ? request.message : null;
  if (refinement) {
    const guard = guardRefinementClaims(refinement, spec);
    if (!guard.okay) {
      console.error(`[image-generation] document-visual refinement guard blocked: ${guard.reason}`);
      return { kind: "message", message: SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE };
    }
  }

  const composed = buildDocumentVisualPrompt({
    spec,
    mode: request.mode,
    style: request.style,
    refinement,
    aspectRatio: request.aspectRatio,
    negativePrompt: request.negativePrompt,
  });

  const params = {
    prompt: composed.prompt,
    negativePrompt: composed.negativePrompt,
    aspectRatio: composed.aspectRatio,
    abortSignal: request.abortSignal,
  };

  const caption = refinement
    ? "Here's your updated document-grounded visual, based on the relevant sections of your document."
    : "Here's a document-grounded visual based on the relevant sections of your document.";

  const outcome = await runWithPolicy({
    providers,
    invoke: (provider) => provider.generate(params),
    normalize: (provider, output, composedText) => {
      const image = normalizeOutput(provider, output, composedText);
      image.sourceGrounded = true;
      image.visualType = spec.visualType;
      return image;
    },
    composedText: composed.prompt,
    caption,
    unavailableMessage: SAFE_UNAVAILABLE_MESSAGE,
  });
  console.log(
    `[image-generation] document-visual route=DOCUMENT_VISUAL_GENERATION type=${spec.visualType ?? "generic"} evidence=${items.length} outcome=${outcome.kind}`
  );
  return outcome;
}

/**
 * Public entry point for document-visual generation (used by the API route).
 * Resolves the server-controlled provider order, then delegates to
 * generateDocumentVisualWithProviders.
 */
export async function generateDocumentVisual(
  request: DocumentVisualGenerationRequest
): Promise<ImageOutcome> {
  const order = resolveProviderOrder();
  const providers = order.map((id) => PROVIDER_INDEX[id]).filter(Boolean);
  return generateDocumentVisualWithProviders(request, providers);
}

export { PROVIDER_INDEX, KNOWN_PROVIDER_IDS };