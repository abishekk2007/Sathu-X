// ---------------------------------------------------------------------------
// Visual evidence loading — Phase 5E-2
// Loads image bytes from Supabase Storage and builds multimodal evidence
// structures for Gemini multimodal reasoning.
// ---------------------------------------------------------------------------

import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VisualQueryIntent } from "./visual-intent";
import { getTargetPages, getTargetVisualKinds } from "./visual-intent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VisualEvidence {
  /** Document/source ID this asset belongs to. */
  sourceId: string;
  /** Document/source display name. */
  sourceName: string;
  /** Storage path in Supabase Storage. */
  storagePath: string;
  /** MIME type of the image (e.g. "image/png"). */
  mimeType: string;
  /** Page number, if applicable. */
  pageNumber: number | null;
  /** Asset type (page_image, figure, diagram, chart, table, etc.). */
  assetType: string;
  /** Image width in pixels. */
  width: number | null;
  /** Image height in pixels. */
  height: number | null;
  /** Base64-encoded image data (loaded from storage). */
  base64Data: string;
}

export interface MultimodalEvidence {
  /** Visual evidence items, bounded by MAX_VISUAL_EVIDENCE. */
  visuals: VisualEvidence[];
  /** Whether any visual loading failed (partial failure). */
  partialFailure: boolean;
  /** Error messages from failed loads (for logging, not user-facing). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Maximum number of visual assets to send to Gemini.
 * Keeps request size bounded while providing rich visual context.
 */
const MAX_VISUAL_EVIDENCE = 4;

/**
 * Maximum base64 data size per image (bytes). Images larger than this are
 * skipped to prevent Gemini request size limits.
 * 20MB raw ≈ 26.7MB base64. Gemini supports up to 20MB per inline image.
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Injectable collaborators for deterministic tests / fault injection. */
export interface VisualEvidenceDeps {
  queryAssets?: typeof queryVisualAssets;
  loadAsset?: typeof loadAssetFromStorage;
}

/**
 * Load visual evidence for a query against one or more documents.
 *
 * 1. Analyzes the visual query intent to determine what to retrieve.
 * 2. Queries visual_assets table for matching assets.
 * 3. Downloads image bytes from Supabase Storage.
 * 4. Returns bounded, base64-encoded evidence for Gemini.
 *
 * Never throws — failures are captured as partial failures.
 */
export async function loadVisualEvidence(
  intent: VisualQueryIntent,
  sourceIds: string[],
  userId: string,
  sourceNameMap: Map<string, string>,
  deps: VisualEvidenceDeps = {}
): Promise<MultimodalEvidence> {
  if (intent.type === "none" || sourceIds.length === 0) {
    return { visuals: [], partialFailure: false, errors: [] };
  }

  const queryAssets = deps.queryAssets ?? queryVisualAssets;
  const loadAsset = deps.loadAsset ?? loadAssetFromStorage;

  // Only build the authenticated Supabase client when at least one real
  // (non-injected) collaborator needs it — mocked runs shouldn't require a
  // request scope.
  const needsRealClient = !deps.queryAssets || !deps.loadAsset;
  const db: SupabaseClient | null = needsRealClient
    ? await getSupabaseServerClient()
    : null;
  const supabase = db as unknown as SupabaseClient;

  const targetPages = getTargetPages(intent.references);
  const targetKinds = getTargetVisualKinds(intent.references);

  const evidence: VisualEvidence[] = [];
  const errors: string[] = [];
  let partialFailure = false;

  // For each source, retrieve matching visual assets
  for (const sourceId of sourceIds) {
    if (evidence.length >= MAX_VISUAL_EVIDENCE) break;

    try {
      const assets = await queryAssets(
        supabase,
        sourceId,
        userId,
        targetPages,
        targetKinds,
        MAX_VISUAL_EVIDENCE - evidence.length
      );

      for (const asset of assets) {
        if (evidence.length >= MAX_VISUAL_EVIDENCE) break;

        const loaded = await loadAsset(
          supabase,
          asset.storage_path
        );

        if (loaded) {
          evidence.push({
            sourceId,
            sourceName: sourceNameMap.get(sourceId) ?? "Unknown",
            storagePath: asset.storage_path,
            mimeType: asset.mime_type,
            pageNumber: asset.page_number,
            assetType: asset.asset_type ?? "unknown",
            width: asset.width,
            height: asset.height,
            base64Data: loaded,
          });
        } else {
          partialFailure = true;
          errors.push(
            `Failed to load visual asset ${asset.storage_path}: too large or unreadable`
          );
        }
      }
    } catch (err) {
      partialFailure = true;
      const msg = err instanceof Error ? err.message : "unknown error";
      errors.push(`Failed to load visual evidence for source ${sourceId}: ${msg}`);
    }
  }

  // Sort by page number then asset type for consistent ordering
  evidence.sort((a: VisualEvidence, b: VisualEvidence) => {
    const pageA = a.pageNumber ?? 0;
    const pageB = b.pageNumber ?? 0;
    if (pageA !== pageB) return pageA - pageB;
    return a.assetType.localeCompare(b.assetType);
  });

  return {
    visuals: evidence.slice(0, MAX_VISUAL_EVIDENCE),
    partialFailure,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Asset querying
// ---------------------------------------------------------------------------

interface AssetRow {
  storage_path: string;
  mime_type: string;
  asset_type: string;
  page_number: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Fetch multiplier: we pull extra rows so that type filtering below can still
 * return a bounded, useful set (e.g. page images that contain the requested
 * diagram/chart/table are valid evidence — they ARE the page's visuals).
 */
const KIND_FILTER_FETCH_MULTIPLIER = 4;

/**
 * Query visual_assets table for assets matching the intent.
 *
 * Phase 5E-2 fix: assets are linked to their parent via EITHER `document_id`
 * (5E-1 PDF page renderer) OR `source_id` (standalone uploaded images). Querying
 * only `source_id` silently dropped all PDF page images. We now match both.
 */
export function buildAssetQuery(
  supabase: SupabaseClient,
  sourceId: string,
  userId: string,
  targetPages: number[],
  targetKinds: Set<string>,
  limit: number
) {
  let query = supabase
    .from("visual_assets")
    .select("storage_path, mime_type, asset_type, page_number, width, height")
    // The 5E-1 PDF renderer stores document_id; uploaded images store source_id.
    .or(`document_id.eq.${sourceId},source_id.eq.${sourceId}`)
    .eq("user_id", userId)
    .eq("processing_status", "ready");

  if (targetPages.length > 0) {
    query = query.in("page_number", targetPages);
  }

  // Fetch extra so kind filtering below can still produce a bounded useful set.
  query = query
    .order("page_number", { ascending: true })
    .limit(Math.max(limit, 8) * KIND_FILTER_FETCH_MULTIPLIER);

  return query;
}

async function queryVisualAssets(
  supabase: SupabaseClient,
  sourceId: string,
  userId: string,
  targetPages: number[],
  targetKinds: Set<string>,
  limit: number
): Promise<AssetRow[]> {
  const query = buildAssetQuery(supabase, sourceId, userId, targetPages, targetKinds, limit);

  const { data: assets, error } = await query;

  if (error) {
    console.error(
      "[visual-evidence] queryVisualAssets failed for source %s: %s",
      sourceId,
      error.message
    );
    return [];
  }

  if (!assets || assets.length === 0) return [];

  // If specific visual kinds are targeted, prefer matching assets.
  if (targetKinds.size > 0) {
    const matching = assets.filter((a) => targetKinds.has(a.asset_type));
    if (matching.length > 0) return matching.slice(0, limit);
  }

  // No typed assets stored for those kinds (current 5E-1 pipeline renders full
  // page/slide images). Return the page-scoped images — they contain the actual
  // visuals the user asked about.
  return assets.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Image loading from Supabase Storage
// ---------------------------------------------------------------------------

/**
 * Download an image from Supabase Storage and return base64-encoded data.
 * Returns null if the image is too large, missing, or unreadable.
 */
async function loadAssetFromStorage(
  supabase: SupabaseClient,
  storagePath: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from("documents")
      .download(storagePath);

    if (error || !data) {
      console.error(
        "[visual-evidence] storage download failed for %s: %s",
        storagePath,
        error?.message ?? "no data"
      );
      return null;
    }

    // Check size before base64 encoding
    if (data.size > MAX_IMAGE_BYTES) {
      console.warn(
        "[visual-evidence] image too large (%d bytes): %s",
        data.size,
        storagePath
      );
      return null;
    }

    // Convert Blob to base64
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString("base64");
  } catch (err) {
    console.error(
      "[visual-evidence] loadAssetFromStorage crashed for %s: %s",
      storagePath,
      err instanceof Error ? err.message : "unknown"
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gemini content construction
// ---------------------------------------------------------------------------

/**
 * Build Gemini image parts from visual evidence.
 * Each part contains inlineData with the base64 image and MIME type.
 */
export function buildGeminiImageParts(
  evidence: VisualEvidence[]
): Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> {
  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [];

  for (const v of evidence) {
    // Add a descriptive label before each image
    const label = formatVisualLabel(v);
    parts.push({ text: label });

    // Add the inline image data
    parts.push({
      inlineData: {
        mimeType: v.mimeType,
        data: v.base64Data,
      },
    });
  }

  return parts;
}

/**
 * Format a descriptive label for a visual evidence item.
 * This helps Gemini understand what it's looking at.
 */
function formatVisualLabel(v: VisualEvidence): string {
  const parts: string[] = [];
  parts.push(`[Visual Evidence — ${v.sourceName}]`);

  if (v.pageNumber != null) {
    parts.push(`Page: ${v.pageNumber}`);
  }

  const typeLabel = formatAssetType(v.assetType);
  parts.push(`Type: ${typeLabel}`);

  if (v.width && v.height) {
    parts.push(`Dimensions: ${v.width}×${v.height}`);
  }

  return parts.join("\n");
}

function formatAssetType(type: string): string {
  const map: Record<string, string> = {
    page_image: "Document Page",
    slide_image: "Presentation Slide",
    figure: "Figure",
    diagram: "Diagram",
    chart: "Chart/Graph",
    table: "Table",
    screenshot: "Screenshot",
    scanned_page: "Scanned Page",
    thumbnail: "Thumbnail",
    image: "Image",
    unknown: "Visual Content",
  };
  return map[type] ?? "Visual Content";
}

// ---------------------------------------------------------------------------
// Visual availability note (grounding signal, not user-visible)
// ---------------------------------------------------------------------------

/**
 * Build the grounding note describing whether visual evidence is attached for a
 * visual query. Injected into the model context ALWAYS for visual-intent turns
 * so the model knows:
 *  - which images (source/page/type) are attached as inline evidence, or
 *  - that NO visual asset matched the requested page/type and it must NOT invent
 *    an image or substitute a different page (negative visual queries).
 */
export function buildVisualEvidenceNote(
  intent: VisualQueryIntent,
  evidence: MultimodalEvidence
): string {
  const pages = getTargetPages(intent.references);
  const kinds = [...getTargetVisualKinds(intent.references)];

  const scope = [
    pages.length > 0 ? `page${pages.length > 1 ? "s" : ""} ${pages.join(", ")}` : "",
    kinds.length > 0 ? `type${kinds.length > 1 ? "s" : ""} ${kinds.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const scopeLine = scope ? ` requested visual scope: ${scope}.` : "";

  if (evidence.visuals.length > 0) {
    const lines = [
      "VISUAL EVIDENCE ATTACHED TO THE LATEST USER MESSAGE AS INLINE IMAGES:",
    ];
    for (const v of evidence.visuals) {
      lines.push(
        `- Source "${v.sourceName}" (${v.assetType})${v.pageNumber != null ? ` page ${v.pageNumber}` : ""}: ${v.storagePath}`
      );
    }
    lines.push(
      "Answer using ONLY what is visible in these images. Do not invent anything not present in them."
    );
    if (evidence.partialFailure) {
      lines.push(
        "NOTE: some requested visual assets could not be loaded — say so if one is essential to the answer."
      );
    }
    return lines.join("\n");
  }

  // No visuals matched.
  const lines = [
    "VISUAL EVIDENCE UNAVAILABLE.",
    `The user's query requested visual content${scopeLine}`,
  ];
  lines.push(
    "No stored visual asset matched this request (page-specific queries never borrow from another page)."
  );
  if (evidence.partialFailure) {
    lines.push(
      "One or more visual assets could not be loaded from storage for this request."
    );
  }
  lines.push(
    "If you cannot see relevant visual evidence, explicitly say the visual evidence is unavailable or not found. " +
      "Do NOT describe, invent, or substitute an image that was not supplied."
  );
  return lines.join("\n");
}
