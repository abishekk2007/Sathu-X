import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import {
  validateImage,
  computeContentHash,
  sanitizeFilename,
  createImageVisualAsset,
} from "@/lib/multimodal";

export const runtime = "nodejs";

const MAX_IMAGE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 10000;

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

/** GET /api/context-sources — list the authenticated user's context sources. */
export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 20;

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("context_sources")
      .select("id, user_id, type, name, content_text, metadata, storage_path, mime_type, file_size_bytes, content_hash, image_width, image_height, processing_status, processing_error, created_at, updated_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[api/context-sources] GET failed:", error.message);
      return jsonError(500, "server_error");
    }

    return Response.json({
      sources: (data ?? []).map((row) => ({
        id: row.id,
        userId: row.user_id,
        type: row.type,
        name: row.name,
        contentText: row.content_text,
        storagePath: row.storage_path,
        mimeType: row.mime_type,
        fileSizeBytes: row.file_size_bytes,
        contentHash: row.content_hash,
        imageWidth: row.image_width,
        imageHeight: row.image_height,
        processingStatus: row.processing_status,
        processingError: row.processing_error,
        metadata: row.metadata ?? {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch {
    console.error("[api/context-sources] GET crashed");
    return jsonError(500, "server_error");
  }
}

/** POST /api/context-sources — create a new context source (pasted text or image). */
export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const contentType = request.headers.get("content-type") ?? "";

  // Handle image upload via FormData
  if (contentType.includes("multipart/form-data")) {
    return handleImageUpload(request, user.id);
  }

  // Handle JSON body (pasted text or metadata-only image)
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const data = body as Record<string, unknown>;
  const type = data.type as string;
  if (type !== "pasted_text" && type !== "image") {
    return jsonError(400, "invalid_type");
  }

  const name = typeof data.name === "string" ? data.name.trim().slice(0, 255) : null;
  const contentText = typeof data.content_text === "string" ? data.content_text : null;
  const metadata = (typeof data.metadata === "object" && data.metadata !== null) ? data.metadata : {};

  if (type === "pasted_text" && (!contentText || contentText.trim().length === 0)) {
    return jsonError(400, "content_required");
  }

  if (type === "pasted_text" && contentText && contentText.length > 500_000) {
    return jsonError(400, "content_too_large");
  }

  try {
    const supabase = await getSupabaseServerClient();
    const id = crypto.randomUUID();
    const displayName = name || (type === "pasted_text" ? "Pasted notes" : "Image");

    const { data: source, error: insertError } = await supabase
      .from("context_sources")
      .insert({
        id,
        user_id: user.id,
        type,
        name: displayName,
        content_text: contentText,
        metadata,
      })
      .select("id, user_id, type, name, content_text, metadata, created_at, updated_at")
      .single();

    if (insertError || !source) {
      console.error("[api/context-sources] POST insert failed:", insertError?.message);
      return jsonError(500, "server_error");
    }

    return Response.json(
      {
        source: {
          id: source.id,
          userId: source.user_id,
          type: source.type,
          name: source.name,
          contentText: source.content_text,
          metadata: source.metadata ?? {},
          createdAt: source.created_at,
          updatedAt: source.updated_at,
        },
      },
      { status: 201 }
    );
  } catch {
    console.error("[api/context-sources] POST crashed");
    return jsonError(500, "server_error");
  }
}

// ---------------------------------------------------------------------------
// Image upload handler — validates, stores, and creates context source
// ---------------------------------------------------------------------------

async function handleImageUpload(
  request: Request,
  userId: string
): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError(400, "invalid_form_data");
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return jsonError(400, "file_required");
  }

  const name = typeof formData.get("name") === "string"
    ? (formData.get("name") as string).trim().slice(0, 255)
    : file.name || "Image";

  // Read file into buffer
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  console.log("[ContextSourceUpload] name=%s size=%d mime=%s", name, buffer.length, file.type);

  // Validate the image
  const validation = validateImage(buffer, file.type, {
    maxImageSizeBytes: MAX_IMAGE_SIZE_BYTES,
    maxImageDimension: MAX_IMAGE_DIMENSION,
  });

  if (!validation.ok) {
    console.error("[ContextSourceUpload] validation failed: %s", validation.error);
    return jsonError(400, validation.error ?? "invalid_image");
  }

  const detectedMime = validation.mimeType!;
  const width = validation.width!;
  const height = validation.height!;
  const contentHash = computeContentHash(buffer);

  try {
    const supabase = await getSupabaseServerClient();
    const sourceId = crypto.randomUUID();

    // Generate storage path
    const safeFilename = sanitizeFilename(file.name || "image");
    const storagePath = `${userId}/images/${sourceId}/${safeFilename}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, buffer, {
        contentType: detectedMime,
        upsert: false,
      });

    if (uploadError) {
      console.error("[ContextSourceUpload] storage upload failed:", uploadError.message);
      return jsonError(500, "storage_upload_failed");
    }

    console.log("[ContextSourceUpload] stored path=%s", storagePath);

    // Create context source record with image metadata
    const { data: source, error: insertError } = await supabase
      .from("context_sources")
      .insert({
        id: sourceId,
        user_id: userId,
        type: "image",
        name,
        storage_path: storagePath,
        mime_type: detectedMime,
        file_size_bytes: buffer.length,
        content_hash: contentHash,
        image_width: width,
        image_height: height,
        processing_status: "ready",
        metadata: {
          originalFilename: file.name,
          size: buffer.length,
          mime: detectedMime,
          width,
          height,
        },
      })
      .select("id, user_id, type, name, storage_path, mime_type, file_size_bytes, content_hash, image_width, image_height, processing_status, metadata, created_at, updated_at")
      .single();

    if (insertError || !source) {
      console.error("[ContextSourceUpload] insert failed:", insertError?.message);
      // Clean up uploaded file
      await supabase.storage.from("documents").remove([storagePath]).catch(() => {});
      return jsonError(500, "server_error");
    }

    console.log("[ContextSourceUpload] created source=%s status=ready", sourceId);

    // Create visual_assets record so the image is visible to the visual retrieval pipeline
    const visualResult = await createImageVisualAsset({
      userId,
      sourceId,
      storagePath,
      mimeType: detectedMime,
      width,
      height,
      fileSizeBytes: buffer.length,
      contentHash,
      filename: file.name,
      metadata: {
        originalFilename: file.name,
        size: buffer.length,
        mime: detectedMime,
        width,
        height,
      },
    });

    if (!visualResult.ok) {
      console.warn(
        "[ContextSourceUpload] visual asset creation failed (non-fatal): %s",
        visualResult.error
      );
    }

    return Response.json(
      {
        source: {
          id: source.id,
          userId: source.user_id,
          type: source.type,
          name: source.name,
          storagePath: source.storage_path,
          mimeType: source.mime_type,
          fileSizeBytes: source.file_size_bytes,
          contentHash: source.content_hash,
          imageWidth: source.image_width,
          imageHeight: source.image_height,
          processingStatus: source.processing_status,
          metadata: source.metadata ?? {},
          createdAt: source.created_at,
          updatedAt: source.updated_at,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown";
    console.error("[ContextSourceUpload] crashed: %s", msg);
    return jsonError(500, "server_error");
  }
}
