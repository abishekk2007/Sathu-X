import { getAuthenticatedUser } from "@/lib/supabase/server";
import { processDocument } from "@/lib/document-processing";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** POST /api/documents/[id]/process — extract text and chunk a document. */
export async function POST(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const result = await processDocument(id, user.id);

    if (!result.ok) {
      return Response.json(
        {
          success: false,
          error: result.error ?? "Processing failed.",
        },
        { status: 422 }
      );
    }

    return Response.json({
      success: true,
      document: {
        id,
        processingStatus: "ready",
        extractedTextLength: result.extractedLength ?? 0,
        chunkCount: result.chunkCount ?? 0,
        processedAt: new Date().toISOString(),
      },
    });
  } catch {
    return jsonError(500, "server_error");
  }
}
