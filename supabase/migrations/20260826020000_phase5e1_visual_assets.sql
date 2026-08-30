-- ============================================================================
-- Phase 5E-1 — Vision & Visual Processing
-- Extends context_sources for real image storage; creates visual_assets for
-- PDF page images and PPTX slide images.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Safe to run multiple times (idempotent). Never drops tables or data.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extend context_sources with image storage columns
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'context_sources' AND column_name = 'storage_path'
  ) THEN
    ALTER TABLE context_sources ADD COLUMN storage_path TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'context_sources' AND column_name = 'mime_type'
  ) THEN
    ALTER TABLE context_sources ADD COLUMN mime_type TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'context_sources' AND column_name = 'file_size_bytes'
  ) THEN
    ALTER TABLE context_sources ADD COLUMN file_size_bytes BIGINT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'context_sources' AND column_name = 'content_hash'
  ) THEN
    ALTER TABLE context_sources ADD COLUMN content_hash TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'context_sources' AND column_name = 'image_width'
  ) THEN
    ALTER TABLE context_sources ADD COLUMN image_width INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'context_sources' AND column_name = 'image_height'
  ) THEN
    ALTER TABLE context_sources ADD COLUMN image_height INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'context_sources' AND column_name = 'processing_status'
  ) THEN
    ALTER TABLE context_sources ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'ready'
      CONSTRAINT context_sources_processing_status_check CHECK (processing_status IN ('pending', 'processing', 'ready', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'context_sources' AND column_name = 'processing_error'
  ) THEN
    ALTER TABLE context_sources ADD COLUMN processing_error TEXT;
  END IF;
END $$;

-- Index for looking up context sources by storage path
CREATE INDEX IF NOT EXISTS idx_context_sources_storage_path
  ON context_sources (storage_path) WHERE storage_path IS NOT NULL;

-- Index for processing status lookups
CREATE INDEX IF NOT EXISTS idx_context_sources_processing_status
  ON context_sources (user_id, processing_status);

-- ---------------------------------------------------------------------------
-- 2. visual_assets — metadata for generated visual content (PDF pages, PPTX slides)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visual_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id     UUID REFERENCES public.documents(id) ON DELETE CASCADE,
  source_id       UUID REFERENCES context_sources(id) ON DELETE SET NULL,
  asset_type      TEXT NOT NULL CHECK (asset_type IN ('page_image', 'slide_image', 'thumbnail')),
  storage_path    TEXT NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT 'image/png',
  page_number     INTEGER,
  slide_number    INTEGER,
  width           INTEGER,
  height          INTEGER,
  file_size_bytes BIGINT,
  content_hash    TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT visual_assets_processing_status_check CHECK (processing_status IN ('pending', 'processing', 'ready', 'failed')),
  processing_error  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE visual_assets IS 'Generated visual assets (PDF page images, PPTX slide images). Owned by user. Linked to source document/context.';
COMMENT ON COLUMN visual_assets.asset_type IS 'Type of visual asset: page_image, slide_image, or thumbnail.';
COMMENT ON COLUMN visual_assets.page_number IS '1-based page number for PDF page images. NULL for non-page assets.';
COMMENT ON COLUMN visual_assets.slide_number IS '1-based slide number for PPTX slide images. NULL for non-slide assets.';

-- ---------------------------------------------------------------------------
-- 3. Indexes for visual_assets
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_visual_assets_user_id ON visual_assets (user_id);
CREATE INDEX IF NOT EXISTS idx_visual_assets_document_id ON visual_assets (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visual_assets_source_id ON visual_assets (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visual_assets_processing ON visual_assets (user_id, processing_status);
CREATE INDEX IF NOT EXISTS idx_visual_assets_page ON visual_assets (document_id, page_number) WHERE page_number IS NOT NULL;

-- Unique constraint: no duplicate page images for the same document
CREATE UNIQUE INDEX IF NOT EXISTS idx_visual_assets_doc_page_unique
  ON visual_assets (document_id, page_number)
  WHERE document_id IS NOT NULL AND page_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. updated_at trigger for visual_assets
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS visual_assets_set_updated_at ON visual_assets;
CREATE TRIGGER visual_assets_set_updated_at
  BEFORE UPDATE ON visual_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Row Level Security — owner-scoped
-- ---------------------------------------------------------------------------
ALTER TABLE visual_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "visual_assets_select_own" ON visual_assets;
CREATE POLICY "visual_assets_select_own" ON visual_assets
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "visual_assets_insert_own" ON visual_assets;
CREATE POLICY "visual_assets_insert_own" ON visual_assets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "visual_assets_update_own" ON visual_assets;
CREATE POLICY "visual_assets_update_own" ON visual_assets
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "visual_assets_delete_own" ON visual_assets;
CREATE POLICY "visual_assets_delete_own" ON visual_assets
  FOR DELETE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 6. Context-sources storage bucket policies (extend existing if needed)
--    The 'documents' bucket already has user-scoped policies.
--    We store context-source images under: {user_id}/images/{source_id}/{filename}
--    which falls under the same user_id prefix — existing policies apply.
--
--    If a separate bucket is preferred, create 'context-sources' bucket manually:
--      create bucket 'context-sources' with public = false
--    and add policies:
-- ---------------------------------------------------------------------------
-- NOTE: context-source images are stored in the 'documents' bucket under
-- {user_id}/images/... path. The existing storage policies already scope
-- access to auth.uid() = first folder name, so no new policies needed.

-- ---------------------------------------------------------------------------
-- 7. Visual assets storage policies
--    Visual assets are stored in the 'documents' bucket under
--    {user_id}/visual_assets/{document_id}/{asset_id}.png
--    Same user-scoped prefix applies.
-- ---------------------------------------------------------------------------
-- No additional storage policies needed — the existing documents bucket
-- policies already restrict access to the user_id folder owner.
