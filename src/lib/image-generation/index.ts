// ---------------------------------------------------------------------------
// Phase 6C — Text → Image generation (barrel exports)
//
// Server-side only. The chat route calls `generateImage`; tests exercise
// `generateImageWithProviders` with mock providers (no network, no keys).
//
// Phase 6D — adds image EDITING alongside generation: the deterministic
// edit-intent detector, the edit prompt builder, and a service/pipeline that
// reuse generation's provider abstraction, validation, and fallback policy.
//
// Phase 6E — adds DOCUMENT→VISUAL generation as an orchestration layer on top
// of the SAME providers: a deterministic document-visual intent detector, a
// structured evidence/visual-spec layer that providers never see as raw RAG,
// grounded prompt composition with per-type anti-hallucination instructions,
// and strict no-grounding safety.
// ---------------------------------------------------------------------------

export {
  generateImage,
  generateImageWithProviders,
  editImage,
  editImageWithProviders,
  generateDocumentVisual,
  generateDocumentVisualWithProviders,
  resolveProviderOrder,
  PROVIDER_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
} from "./service";

export {
  detectImageGenerationIntent,
  detectImageGenerationRefinement,
  resolveImageGenerationIntent,
  grantsGrounding,
  looksLikeDiagramRequest,
  type ImageGenerationIntent,
} from "./intent";

export {
  detectImageEditIntent,
  isImageEditRequest,
  type ImageEditIntent,
} from "./edit-intent";

// Phase 6E exports — document → visual generation
export {
  detectDocumentVisualIntent,
  detectDocumentVisualRefinement,
  resolveDocumentVisualIntent,
  isDocumentVisualRequest,
  hasDocumentContext,
  inferDocumentVisualType,
  type DocumentVisualIntent,
} from "./document-visual-intent";

export {
  DOCUMENT_VISUAL_TYPES,
  DOCUMENT_VISUAL_LABELS,
  isDocumentVisualType,
  type DocumentVisualType,
} from "./document-visual-types";

export {
  normalizeEvidence,
  hasNumericEvidence,
  extractNumericTokens,
  buildEvidenceContext,
  MAX_EVIDENCE_CHARS,
  MAX_EVIDENCE_ITEMS,
  type DocumentVisualEvidenceItem,
} from "./document-visual-evidence";

export {
  buildDocumentVisualSpec,
  buildDocumentVisualPrompt,
  guardRefinementClaims,
  DOC_VISUAL_PROMPT_MAX_CHARS,
  type DocumentVisualSpec,
} from "./document-visual-prompt";

export {
  buildImagePrompt,
  buildImageEditPrompt,
  normalizeAspectRatio,
  PROMPT_MAX_CHARS,
  type ComposedEditPrompt,
} from "./prompt";

export { geminiImageProvider, resolveGeminiImageModel, DEFAULT_GEMINI_IMAGE_MODEL } from "./gemini-provider";

export {
  huggingfaceImageProvider,
  resolveHuggingFaceConfig,
  DEFAULT_HF_IMAGE_MODEL,
  DEFAULT_HF_BASE_URL,
  DEFAULT_HF_PROVIDER,
  HAS_HF_IMAGE_EDIT,
} from "./huggingface-provider";

export type {
  GeneratedImage,
  GeneratedImageMime,
  ImageAspectRatio,
  ImageContextRef,
  ImageEditKind,
  ImageEditRequest,
  DocumentVisualGenerationRequest,
  ImageFailureCode,
  ImageGenerationRequest,
  ImageOutcome,
  ImageProvider,
  ImageProviderId,
  ProviderEditParams,
  ProviderGenerationParams,
  ProviderImageOutput,
} from "./types";

export {
  ImageFailure,
  SAFE_UNAVAILABLE_MESSAGE,
  SAFE_NO_GROUNDING_MESSAGE,
  SAFE_EDIT_UNAVAILABLE_MESSAGE,
  SAFE_EDIT_NO_IMAGE_MESSAGE,
  SAFE_EDIT_CLARIFY_MESSAGE,
  SAFE_EDIT_INVALID_SOURCE_MESSAGE,
  SAFE_DOC_VISUAL_NO_DOC_MESSAGE,
  SAFE_DOC_VISUAL_CHART_NO_NUMBERS_MESSAGE,
  SAFE_DOC_VISUAL_REFINEMENT_GUARD_MESSAGE,
  DEFAULT_NEGATIVE_PROMPT,
} from "./types";