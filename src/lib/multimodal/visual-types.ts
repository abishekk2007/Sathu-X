// ---------------------------------------------------------------------------
// Visual processing types — Phase 5E-1
// ---------------------------------------------------------------------------

/** Supported image MIME types for direct upload. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

/** Check if a MIME type is a supported image. */
export function isSupportedImageMime(mime: string): mime is SupportedImageMime {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/** Visual asset types stored in the visual_assets table. */
export type VisualAssetType =
  | "page_image"
  | "slide_image"
  | "thumbnail"
  | "image"
  | "figure"
  | "diagram"
  | "chart"
  | "table"
  | "screenshot"
  | "scanned_page"
  | "unknown";

/** Processing status for visual assets. */
export type VisualProcessingStatus = "pending" | "processing" | "ready" | "failed";

/** Result of image validation. */
export interface ImageValidationResult {
  ok: boolean;
  error?: string;
  mimeType?: SupportedImageMime;
  width?: number;
  height?: number;
}

/** Metadata extracted from an uploaded image. */
export interface ImageMetadata {
  mimeType: SupportedImageMime;
  width: number;
  height: number;
  fileSize: number;
  contentHash: string;
}

/** Result of processing an image for storage. */
export interface ProcessedImage {
  storagePath: string;
  mimeType: SupportedImageMime;
  width: number;
  height: number;
  fileSize: number;
  contentHash: string;
}

/** A visual asset record from the visual_assets table. */
export interface VisualAssetRecord {
  id: string;
  userId: string;
  documentId: string | null;
  sourceId: string | null;
  assetType: VisualAssetType;
  storagePath: string;
  mimeType: string;
  pageNumber: number | null;
  slideNumber: number | null;
  width: number | null;
  height: number | null;
  fileSizeBytes: number | null;
  contentHash: string | null;
  processingStatus: VisualProcessingStatus;
  processingError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Result of PDF page rendering. */
export interface PdfPageRenderResult {
  pageNumber: number;
  storagePath: string;
  width: number;
  height: number;
  fileSize: number;
}

/** Configuration for visual processing limits. */
export interface VisualProcessingConfig {
  maxImageSizeBytes: number;
  maxImageDimension: number;
  pdfRenderScale: number;
  pdfMaxPages: number;
}

/** Default processing configuration. */
export const DEFAULT_VISUAL_CONFIG: VisualProcessingConfig = {
  maxImageSizeBytes: 25 * 1024 * 1024, // 25 MB
  maxImageDimension: 10000, // 10000px per side
  pdfRenderScale: 2.0, // 2x for readability
  pdfMaxPages: 100, // safety limit
};

// ---------------------------------------------------------------------------
// Runtime validation & helpers
// ---------------------------------------------------------------------------

/** All valid VisualAssetType values for runtime checks. */
export const VISUAL_ASSET_TYPE_VALUES: readonly VisualAssetType[] = [
  "page_image",
  "slide_image",
  "thumbnail",
  "image",
  "figure",
  "diagram",
  "chart",
  "table",
  "screenshot",
  "scanned_page",
  "unknown",
];

/** Check if a string is a valid VisualAssetType. */
export function isValidVisualAssetType(v: string): v is VisualAssetType {
  return (VISUAL_ASSET_TYPE_VALUES as readonly string[]).includes(v);
}

/**
 * Heuristic detection of visual asset type from filename or content context.
 * Returns "unknown" when type cannot be reliably determined — never guess.
 *
 * Uses negative lookbehind/lookahead instead of \b because filenames commonly
 * use underscores as word separators (e.g. "scan_001.png", "fig_2.jpg") and
 * \b treats underscore as a word character, failing to match at boundaries.
 */
export function detectVisualAssetType(
  filename?: string | null,
  metadata?: Record<string, unknown> | null
): VisualAssetType {
  const source = (
    (filename ?? "") +
    " " +
    JSON.stringify(metadata ?? {})
  ).toLowerCase();

  // (?<![a-z]) = not preceded by letter (underscore is OK — filenames use _ as separator)
  // (?![a-z])  = not followed by letter (underscore is OK)
  if (/(?<![a-z])(?:scanned|scan)(?![a-z])/.test(source)) return "scanned_page";
  if (/(?<![a-z])(?:figure|fig)(?![a-z])/.test(source)) return "figure";
  if (/(?<![a-z])(?:diagram|flowchart|mindmap)(?![a-z])/.test(source)) return "diagram";
  if (/(?<![a-z])(?:chart|graph|plot|histogram)(?![a-z])/.test(source)) return "chart";
  if (/(?<![a-z])(?:table|spreadsheet|grid)(?![a-z])/.test(source)) return "table";
  if (/(?<![a-z])(?:screenshot|screen[-_]?shot|capture)(?![a-z])/.test(source)) return "screenshot";
  if (/(?<![a-z])(?:slide|pptx|presentation)(?![a-z])/.test(source)) return "slide_image";

  return "unknown";
}

/**
 * Queries that reference visual elements by name.
 * Used by agent context to decide whether to load visual evidence.
 */
export const VISUAL_QUERY_SIGNALS = {
  pageRef: /(?:page|pg|p\.?)\s*(\d+)/i,
  figureRef: /(?:figure|fig\.?)\s*(\d+)/i,
  diagramRef: /(?:diagram|flowchart)\s*(\d+)/i,
  chartRef: /(?:chart|graph|plot)\s*(\d+)/i,
  tableRef: /(?:table|tbl\.?)\s*(\d+)/i,
  imageRef: /(?:image|img\.?|picture|photo)\s*(\d+)/i,
  scannedRef: /(?:scan(?:ned)?|ocr)\b/i,
} as const;
