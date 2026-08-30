import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

/** DELETE /api/context-sources/:id — delete a context source and its storage files. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await params;

  try {
    const supabase = await getSupabaseServerClient();

    // Fetch the source to check for storage_path before deleting
    const { data: source } = await supabase
      .from("context_sources")
      .select("id, storage_path, user_id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!source) {
      // Source not found or not owned — RLS would also block, but check explicitly
      return jsonError(404, "not_found");
    }

    // Delete associated visual assets (page images, thumbnails)
    const { data: assets } = await supabase
      .from("visual_assets")
      .select("id, storage_path")
      .eq("source_id", id)
      .eq("user_id", user.id);

    if (assets && assets.length > 0) {
      // Delete visual asset files from storage
      const assetPaths = assets
        .map((a) => a.storage_path)
        .filter((p): p is string => !!p);
      if (assetPaths.length > 0) {
        await supabase.storage.from("documents").remove(assetPaths).catch(() => {});
      }
      // Delete visual asset records
      await supabase
        .from("visual_assets")
        .delete()
        .eq("source_id", id)
        .eq("user_id", user.id);
    }

    // Delete the source's own storage file if it exists
    if (source.storage_path) {
      await supabase.storage.from("documents").remove([source.storage_path]).catch(() => {});
    }

    // Delete the context source record
    const { error } = await supabase
      .from("context_sources")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      console.error("[api/context-sources/:id] DELETE failed:", error.message);
      return jsonError(500, "server_error");
    }

    return Response.json({ ok: true });
  } catch {
    console.error("[api/context-sources/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}
