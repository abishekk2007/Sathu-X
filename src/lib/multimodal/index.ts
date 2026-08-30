// ---------------------------------------------------------------------------
// Multimodal visual processing — barrel exports
// Phase 5E-1/5E-2: Visual asset pipeline for images, PDFs, and PPTX.
//
// NOTE: pdf-page-renderer.ts is NOT re-exported here because it dynamically
// imports @napi-rs/canvas (native Node.js module) which is incompatible with
// Turbopack's ESM bundling. Import it directly:
//   const { renderPdfPages } = await import("@/lib/multimodal/pdf-page-renderer");
// ---------------------------------------------------------------------------

export {
  SUPPORTED_IMAGE_MIME_TYPES,
  isSupportedImageMime,
  DEFAULT_VISUAL_CONFIG,
  VISUAL_ASSET_TYPE_VALUES,
  VISUAL_QUERY_SIGNALS,
  isValidVisualAssetType,
  detectVisualAssetType,
  type SupportedImageMime,
  type VisualAssetType,
  type VisualProcessingStatus,
  type ImageValidationResult,
  type ImageMetadata,
  type ProcessedImage,
  type VisualAssetRecord,
  type PdfPageRenderResult,
  type VisualProcessingConfig,
} from "./visual-types";

export {
  detectImageMime,
  readImageDimensions,
  computeContentHash,
  validateImage,
  extractImageMetadata,
  sanitizeFilename,
  generateImageStoragePath,
  createImageVisualAsset,
} from "./image-processing";
