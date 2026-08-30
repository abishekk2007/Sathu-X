import { z } from "zod";

import {
  getAuthenticatedUser,
  getSupabaseServerClient,
} from "@/lib/supabase/server";
import { deleteDocumentVisualAssets } from "@/lib/documents";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    subjectId: z.string().uuid().nullable().optional(),
    topicId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

interface RouteContext {
  params: Promise<{ id: string }>;
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

/** GET /api/documents/[id] — return metadata for an owned document. */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("documents")
      .select("*, subject:subjects(name), topic:subject_topics(name)")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("[api/documents/:id] GET failed");
      return jsonError(500, "server_error");
    }
    if (!data) return jsonError(404, "not_found");

    return Response.json({ document: serializeDocument(data as DocumentRow) });
  } catch {
    console.error("[api/documents/:id] GET crashed");
    return jsonError(500, "server_error");
  }
}

/** PATCH /api/documents/[id] — rename or change subject/topic association. */
export async function PATCH(request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");

  const supabase = await getSupabaseServerClient();

  // Validate subject ownership if changing
  if (parsed.data.subjectId !== undefined && parsed.data.subjectId !== null) {
    const { data: subject } = await supabase
      .from("subjects")
      .select("id")
      .eq("id", parsed.data.subjectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!subject) return jsonError(404, "subject_not_found");
  }

  // Validate topic ownership if changing
  if (parsed.data.topicId !== undefined && parsed.data.topicId !== null) {
    const { data: topic } = await supabase
      .from("subject_topics")
      .select("id, subject_id")
      .eq("id", parsed.data.topicId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!topic) return jsonError(404, "topic_not_found");

    // If both subject and topic are being set, verify they match
    const subjectId =
      parsed.data.subjectId !== undefined
        ? parsed.data.subjectId
        : null;
    if (subjectId && topic.subject_id !== subjectId) {
      return jsonError(400, "topic_does_not_belong_to_subject");
    }
  }

  try {
    // Build update object — only whitelisted fields
    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.subjectId !== undefined)
      updates.subject_id = parsed.data.subjectId;
    if (parsed.data.topicId !== undefined)
      updates.topic_id = parsed.data.topicId;

    const { data, error } = await supabase
      .from("documents")
      .update(updates)
      .eq("id", id)
      .select("*, subject:subjects(name), topic:subject_topics(name)")
      .single();

    if (error || !data) {
      console.error("[api/documents/:id] PATCH found no owned row");
      return jsonError(404, "not_found");
    }

    return Response.json({ document: serializeDocument(data as DocumentRow) });
  } catch {
    console.error("[api/documents/:id] PATCH crashed");
    return jsonError(500, "server_error");
  }
}

/** DELETE /api/documents/[id] — remove document + storage object. */
export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();

    // Fetch the document to get storage_path (for cleanup)
    const { data: doc } = await supabase
      .from("documents")
      .select("id, storage_path")
      .eq("id", id)
      .maybeSingle();

    if (!doc) return jsonError(404, "not_found");

    // Remove visual asset storage files (PDF page PNGs / standalone image
    // assets) so they don't orphan when the document row is deleted. The
    // visual_assets rows themselves cascade-delete with the document.
    await deleteDocumentVisualAssets(supabase, id, user.id);

    // Delete from storage first (best-effort)
    if (doc.storage_path) {
      const { error: storageErr } = await supabase.storage
        .from("documents")
        .remove([doc.storage_path]);
      if (storageErr) {
        console.error("[api/documents/:id] Storage delete failed");
        return jsonError(500, "storage_delete_failed");
      }
    }

    // Delete the database row
    const { error: deleteError } = await supabase
      .from("documents")
      .delete()
      .eq("id", id);

    if (deleteError) {
      console.error("[api/documents/:id] DELETE failed");
      return jsonError(500, "server_error");
    }

    return Response.json({ deleted: 1 });
  } catch {
    console.error("[api/documents/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}
