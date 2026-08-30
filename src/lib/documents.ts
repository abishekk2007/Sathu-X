import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPPORTED_MIME_TYPES } from "@/types";

const MAX_SIZE_MB_DEFAULT = 25;

/** Maximum upload size in bytes (configurable via MAX_DOCUMENT_SIZE_MB). */
export const getMaxDocumentSizeBytes = (): number => {
  const raw = process.env.MAX_DOCUMENT_SIZE_MB;
  const mb = raw ? Number.parseInt(raw, 10) : MAX_SIZE_MB_DEFAULT;
  return (Number.isFinite(mb) && mb > 0 ? mb : MAX_SIZE_MB_DEFAULT) * 1024 * 1024;
};

/** Supported MIME types for upload. */
export const SUPPORTED_MIME_SET = new Set<string>(SUPPORTED_MIME_TYPES);

/** Returns true if the MIME type is supported. */
export function isSupportedMimeType(mime: string): boolean {
  return SUPPORTED_MIME_SET.has(mime);
}

/**
 * Sanitizes an uploaded filename: strips path traversal, collapses
 * whitespace, and truncates to a safe length.
 */
export function sanitizeFilename(name: string): string {
  // Strip any directory components (path traversal prevention)
  const base = name.split(/[/\\]/).pop() ?? name;
  // Remove null bytes and control characters
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "");
  // Collapse whitespace
  const trimmed = cleaned.replace(/\s+/g, " ").trim();
  // Truncate to 200 chars max
  const truncated = trimmed.slice(0, 200);
  return truncated || "unnamed";
}

/**
 * Derives the MIME type label for display.
 */
export function mimeTypeLabel(mime: string): string {
  const labels: Record<string, string> = {
    "application/pdf": "PDF",
    "text/plain": "TXT",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "DOCX",
    "text/markdown": "MD",
    "image/png": "PNG",
    "image/jpeg": "JPG",
    "image/webp": "WEBP",
    "application/vnd.openxmlformats-officedocument.presentationml.document":
      "PPTX",
  };
  return labels[mime] ?? mime;
}

/**
 * Returns a safe storage path: {user_id}/{document_id}/{sanitized_filename}
 */
export function buildStoragePath(
  userId: string,
  documentId: string,
  filename: string
): string {
  return `${userId}/${documentId}/${sanitizeFilename(filename)}`;
}

/**
 * Removes the storage files for a document's visual assets (rendered PDF page
 * PNGs, slide images). The visual_assets rows themselves cascade-delete with
 * the document, so only the backing objects need manual cleanup.
 *
 * Best-effort: a failed lookup or failed storage removal must never block the
 * document delete. Returns the number of storage objects removed (0 on any
 * failure or when no assets exist).
 */
export async function deleteDocumentVisualAssets(
  supabase: SupabaseClient,
  documentId: string,
  userId: string
): Promise<number> {
  const { data: assets } = await supabase
    .from("visual_assets")
    .select("storage_path")
    .eq("document_id", documentId)
    .eq("user_id", userId);

  const paths = (assets ?? [])
    .map((a) => a.storage_path)
    .filter((p): p is string => !!p);

  if (paths.length === 0) return 0;

  const { error } = await supabase.storage.from("documents").remove(paths);
  return error ? 0 : paths.length;
}
