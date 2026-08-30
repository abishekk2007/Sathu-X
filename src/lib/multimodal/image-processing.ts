// ---------------------------------------------------------------------------
// Image processing — validation, metadata extraction, content hashing,
// and storage preparation for Phase 5E-1 visual pipeline.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type {
  SupportedImageMime,
  VisualAssetType,
  ImageValidationResult,
  ImageMetadata,
  VisualProcessingStatus,
} from "./visual-types";
import { isSupportedImageMime, detectVisualAssetType } from "./visual-types";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// MIME detection from magic bytes (for images)
// ---------------------------------------------------------------------------

/**
 * Detect image MIME type from magic bytes.
 * Returns null if bytes don't match any supported image format.
 */
export function detectImageMime(buffer: Buffer): SupportedImageMime | null {
  if (buffer.length < 12) return null;

  const sig = buffer.subarray(0, 12);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff) {
    return "image/jpeg";
  }

  // WebP: RIFF....WEBP
  if (
    sig.subarray(0, 4).toString("ascii") === "RIFF" &&
    sig.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Image dimension reading (from headers, no full decode)
// ---------------------------------------------------------------------------

interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read image dimensions from header bytes without full decode.
 * Supports PNG, JPEG, and WebP.
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 24) return null;

  // PNG: IHDR chunk at offset 16 contains width (4 bytes BE) and height (4 bytes BE)
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    if (buffer.length < 24) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0 && width <= 100000 && height <= 100000) {
      return { width, height };
    }
    return null;
  }

  // JPEG: scan for SOF marker
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return readJpegDimensions(buffer);
  }

  // WebP: VP8 or VP8L chunk
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return readWebpDimensions(buffer);
  }

  return null;
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];

    // SOF markers: C0-C3, C5-C7, C9-CB, CD-CF
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (offset + 9 < buffer.length) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) return { width, height };
      }
      return null;
    }

    // Skip to next marker
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
    } else if (offset + 3 < buffer.length) {
      const segmentLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
    } else {
      break;
    }
  }
  return null;
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 30) return null;

  const chunk = buffer.subarray(12, 16).toString("ascii");

  // VP8 lossy
  if (chunk === "VP8 " && buffer.length >= 30) {
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    if (width > 0 && height > 0) return { width, height };
  }

  // VP8L lossless
  if (chunk === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (width > 0 && height > 0) return { width, height };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a buffer. Used for duplicate detection.
 */
export function computeContentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Image validation
// ---------------------------------------------------------------------------

/**
 * Validate an image buffer. Checks:
 * - Supported MIME type (magic bytes)
 * - File size within limits
 * - Image dimensions within limits
 * - Readable image headers
 */
export function validateImage(
  buffer: Buffer,
  declaredMimeType: string,
  config: { maxImageSizeBytes: number; maxImageDimension: number } = {
    maxImageSizeBytes: 25 * 1024 * 1024,
    maxImageDimension: 10000,
  }
): ImageValidationResult {
  // Check buffer is not empty
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: "Image file is empty." };
  }

  // Check file size
  if (buffer.length > config.maxImageSizeBytes) {
    const maxMB = Math.round(config.maxImageSizeBytes / (1024 * 1024));
    return { ok: false, error: `Image exceeds the ${maxMB} MB limit.` };
  }

  // Detect actual MIME from magic bytes
  const detectedMime = detectImageMime(buffer);
  if (!detectedMime) {
    return { ok: false, error: "Unsupported image format. Supported: PNG, JPEG, WebP." };
  }

  // Cross-check with declared MIME if provided
  if (declaredMimeType && isSupportedImageMime(declaredMimeType) && declaredMimeType !== detectedMime) {
    console.warn(
      `[ImageValidation] declared_mime=%s detected_mime=%s — using detected`,
      declaredMimeType,
      detectedMime
    );
  }

  // Read dimensions
  const dims = readImageDimensions(buffer);
  if (!dims) {
    return { ok: false, error: "Unable to read image dimensions. The file may be corrupted." };
  }

  // Check dimensions
  if (dims.width > config.maxImageDimension || dims.height > config.maxImageDimension) {
    return {
      ok: false,
      error: `Image dimensions (${dims.width}x${dims.height}) exceed the ${config.maxImageDimension}px limit.`,
    };
  }

  return {
    ok: true,
    mimeType: detectedMime,
    width: dims.width,
    height: dims.height,
  };
}

// ---------------------------------------------------------------------------
// Image metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extract metadata from a validated image buffer.
 * Must only be called after validateImage succeeds.
 */
export function extractImageMetadata(
  buffer: Buffer,
  mimeType: SupportedImageMime
): ImageMetadata {
  const dims = readImageDimensions(buffer);
  const contentHash = computeContentHash(buffer);

  return {
    mimeType,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    fileSize: buffer.length,
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// Filename sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a filename for safe storage. Removes path traversal,
 * control characters, and limits length.
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[\/\\]/g, "_") // Replace path separators
    .replace(/\.\./g, "_") // Replace dots sequences
    .replace(/[\x00-\x1f\x7f]/g, "") // Remove control chars
    .replace(/[^a-zA-Z0-9._-]/g, "_") // Keep only safe chars
    .replace(/_{2,}/g, "_") // Collapse underscores
    .replace(/^[._-]+/, "") // Remove leading dots/dashes
    .slice(0, 200) // Limit length
    || "image"; // Fallback
}

// ---------------------------------------------------------------------------
// Storage path generation
// ---------------------------------------------------------------------------

/**
 * Generate a safe storage path for an uploaded image.
 * Format: {user_id}/images/{source_id}/{sanitized_filename}
 */
export function generateImageStoragePath(
  userId: string,
  sourceId: string,
  filename: string
): string {
  const safe = sanitizeFilename(filename);
  return `${userId}/images/${sourceId}/${safe}`;
}

// ---------------------------------------------------------------------------
// Standalone image → visual asset creation
// ---------------------------------------------------------------------------

/**
 * Create a visual_assets record for an uploaded image context source.
 * Called after the image is stored in Supabase Storage and the context_source
 * record exists. This makes the image visible to the visual retrieval pipeline.
 */
export async function createImageVisualAsset(opts: {
  userId: string;
  sourceId: string;
  storagePath: string;
  mimeType: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  contentHash: string;
  filename?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<{ ok: boolean; assetId?: string; error?: string }> {
  try {
    const supabase = await getSupabaseServerClient();

    const assetType: VisualAssetType = detectVisualAssetType(
      opts.filename,
      opts.metadata
    );

    const assetId = crypto.randomUUID();

    const { error } = await supabase.from("visual_assets").insert({
      id: assetId,
      user_id: opts.userId,
      source_id: opts.sourceId,
      asset_type: assetType,
      storage_path: opts.storagePath,
      mime_type: opts.mimeType,
      width: opts.width,
      height: opts.height,
      file_size_bytes: opts.fileSizeBytes,
      content_hash: opts.contentHash,
      processing_status: "ready" satisfies VisualProcessingStatus,
    });

    if (error) {
      console.error(
        "[ImageProcessing] createImageVisualAsset insert failed: %s",
        error.message
      );
      return { ok: false, error: error.message };
    }

    console.log(
      "[ImageProcessing] created visual_asset=%s source=%s type=%s",
      assetId,
      opts.sourceId,
      assetType
    );

    return { ok: true, assetId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("[ImageProcessing] createImageVisualAsset crashed: %s", msg);
    return { ok: false, error: msg };
  }
}
