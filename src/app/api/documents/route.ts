import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import {
  getMaxDocumentSizeBytes,
  isSupportedMimeType,
  sanitizeFilename,
  buildStoragePath,
} from "@/lib/documents";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

interface DocumentRow {
  id: string;
  user_id: string;
  subject_id: string | null;
  topic_id: string | null;
  name: string;
  original_filename: string;
  storage_path: string;
  mime_type: string;
  file_size_bytes: number;
  status: string;
  processing_status: string;
  error_message: string | null;
  extracted_text_length: number | null;
  processed_at: string | null;
  processing_error: string | null;
  created_at: string;
  updated_at: string;
  subject?: { name: string }[] | null;
  topic?: { name: string }[] | null;
}

function serializeDocument(row: DocumentRow) {
  return {
    id: row.id,
    userId: row.user_id,
    subjectId: row.subject_id,
    topicId: row.topic_id,
    name: row.name,
    originalFilename: row.original_filename,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    fileSizeBytes: Number(row.file_size_bytes),
    status: row.status,
    processingStatus: row.processing_status,
    errorMessage: row.error_message,
    extractedTextLength: row.extracted_text_length ?? null,
    processedAt: row.processed_at ?? null,
    processingError: row.processing_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subjectName: row.subject?.[0]?.name ?? null,
    topicName: row.topic?.[0]?.name ?? null,
  };
}

/** GET /api/documents — list the authenticated user's documents. */
export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const subjectId = url.searchParams.get("subjectId")?.trim() ?? "";
  const topicId = url.searchParams.get("topicId")?.trim() ?? "";
  const status = url.searchParams.get("status")?.trim() ?? "";
  const pageRaw = Number.parseInt(url.searchParams.get("page") ?? "", 10);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);

  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const limit =
    Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 50 ? limitRaw : 20;
  const offset = (page - 1) * limit;

  try {
    const supabase = await getSupabaseServerClient();
    let query = supabase
      .from("documents")
      .select(
        "*, subject:subjects(name), topic:subject_topics(name)",
        { count: "exact" }
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`name.ilike.%${search}%,original_filename.ilike.%${search}%`);
    }
    if (subjectId) query = query.eq("subject_id", subjectId);
    if (topicId) query = query.eq("topic_id", topicId);
    if (status) query = query.eq("status", status);

    const { data, error, count } = await query;
    if (error) {
      console.error("[api/documents] GET failed");
      return jsonError(500, "server_error");
    }

    return Response.json({
      documents: ((data ?? []) as DocumentRow[]).map(serializeDocument),
      total: count ?? 0,
      page,
      limit,
    });
  } catch {
    console.error("[api/documents] GET crashed");
    return jsonError(500, "server_error");
  }
}

/** POST /api/documents — upload a document via multipart/form-data. */
export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return jsonError(400, "missing_file");
  }

  // Validate MIME type (server-side — never trust client extension alone)
  const mimeType = file.type || "application/octet-stream";
  if (!isSupportedMimeType(mimeType)) {
    return jsonError(
      400,
      "unsupported_file_type"
    );
  }

  // Validate file size
  const maxSize = getMaxDocumentSizeBytes();
  if (file.size > maxSize) {
    const maxMb = Math.round(maxSize / (1024 * 1024));
    return jsonError(400, `file_too_large_${maxMb}mb`);
  }

  if (file.size === 0) {
    return jsonError(400, "empty_file");
  }

  const name = (formData.get("name") as string | null)?.trim() || sanitizeFilename(file.name);
  if (name.length < 1 || name.length > 255) {
    return jsonError(400, "invalid_name");
  }

  const subjectId = (formData.get("subjectId") as string | null)?.trim() || null;
  const topicId = (formData.get("topicId") as string | null)?.trim() || null;

  // Validate subject ownership
  if (subjectId) {
    const supabaseClient = await getSupabaseServerClient();
    const { data: subject } = await supabaseClient
      .from("subjects")
      .select("id")
      .eq("id", subjectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!subject) return jsonError(404, "subject_not_found");
  }

  // Validate topic ownership (+ belongs to user's subject)
  if (topicId) {
    const supabaseClient = await getSupabaseServerClient();
    const { data: topic } = await supabaseClient
      .from("subject_topics")
      .select("id, subject_id")
      .eq("id", topicId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!topic) return jsonError(404, "topic_not_found");
    if (subjectId && topic.subject_id !== subjectId) {
      return jsonError(400, "topic_does_not_belong_to_subject");
    }
  }

  const supabase = await getSupabaseServerClient();
  const docId = crypto.randomUUID();
  const safeFilename = sanitizeFilename(file.name);
  const storagePath = buildStoragePath(user.id, docId, safeFilename);

  // Convert File to ArrayBuffer for Supabase storage upload
  const arrayBuffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);

  // Upload to private storage bucket
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, uint8, {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    console.error("[api/documents] Storage upload failed");
    return jsonError(500, "upload_failed");
  }

  // Insert metadata — if this fails, attempt to clean up the storage object
  const { data: doc, error: insertError } = await supabase
    .from("documents")
    .insert({
      id: docId,
      subject_id: subjectId,
      topic_id: topicId,
      name,
      original_filename: file.name,
      storage_path: storagePath,
      mime_type: mimeType,
      file_size_bytes: file.size,
      status: "uploaded",
      processing_status: "pending",
    })
    .select(
      "*, subject:subjects(name), topic:subject_topics(name)"
    )
    .single();

  if (insertError || !doc) {
    // Cleanup: remove the uploaded file since DB insert failed
    await supabase.storage.from("documents").remove([storagePath]).catch(() => {});
    console.error("[api/documents] DB insert failed, storage cleaned up");
    return jsonError(500, "server_error");
  }

  return Response.json(
    { document: serializeDocument(doc as DocumentRow) },
    { status: 201 }
  );
}
