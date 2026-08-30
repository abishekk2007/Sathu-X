-- ============================================================================
-- Phase 5E-2 — visual_assets.asset_type classification repair
--
-- Forensic report: the 5E-1 schema constraint only allowed
-- ('page_image','slide_image','thumbnail'), but the TypeScript code
-- (detectVisualAssetType / createImageVisualAsset) legitimately classifies
-- diagrams, charts, figures, tables, screenshots, scanned pages, and raw
-- images. The too-narrow CHECK caused every such insert to fail, so no
-- typed visual asset ever reached visual_assets — visual (non-page) queries
-- always returned zero evidence.
--
-- This migration relaxes the constraint to the full `VisualAssetType` union
-- already defined in src/lib/multimodal/visual-types.ts. It is idempotent and
-- NEVER drops table data. Existing page_image/slide_image/thumbnail rows are
-- untouched.
-- ============================================================================

DO $$
BEGIN
  -- Drop the narrow constraint if it exists (relaxing, never destructive).
  ALTER TABLE IF EXISTS visual_assets
    DROP CONSTRAINT IF EXISTS visual_assets_asset_type_check;

  -- Re-add with the full classification union (matches VisualAssetType).
  ALTER TABLE IF EXISTS visual_assets
    ADD CONSTRAINT visual_assets_asset_type_check CHECK (
      asset_type IN (
        'page_image', 'slide_image', 'thumbnail',
        'image', 'figure', 'diagram', 'chart', 'table',
        'screenshot', 'scanned_page', 'unknown'
      )
    );
END $$;