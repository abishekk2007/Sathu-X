-- ============================================================================
-- Phase 5E-1 Verification SQL — Read-only checks
-- Run after applying supabase/migrations/20260826020000_phase5e1_visual_assets.sql
-- All queries are SELECT-only; safe for production.
-- ============================================================================

-- 1. visual_assets table exists
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'visual_assets'
) AS visual_assets_table_exists;

-- 2. Expected columns in visual_assets
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'visual_assets'
ORDER BY ordinal_position;

-- 3. Expected columns added to context_sources
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'context_sources'
  AND column_name IN ('storage_path', 'mime_type', 'file_size_bytes', 'content_hash', 'image_width', 'image_height', 'processing_status', 'processing_error')
ORDER BY ordinal_position;

-- 4. RLS enabled on visual_assets
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname = 'visual_assets'
  AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');

-- 5. RLS policies exist on visual_assets
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'visual_assets'
ORDER BY policyname;

-- 6. Indexes on visual_assets
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'visual_assets'
ORDER BY indexname;

-- 7. Indexes added to context_sources for visual processing
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'context_sources'
  AND indexname LIKE '%visual%' OR indexname LIKE '%storage_path%' OR indexname LIKE '%processing_status%'
ORDER BY indexname;

-- 8. Ownership relationship (user_id references auth.users)
SELECT
  tc.constraint_name,
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.table_name = 'visual_assets'
  AND tc.constraint_type = 'FOREIGN KEY';

-- 9. Processing status constraints
SELECT
  conname AS constraint_name,
  pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint
WHERE conrelid = 'visual_assets'::regclass
  AND contype = 'c';

-- 10. Foreign keys on visual_assets
SELECT
  conname,
  pg_get_constraintdef(oid) AS fk_definition
FROM pg_constraint
WHERE conrelid = 'visual_assets'::regclass
  AND contype = 'f';

-- 11. Unique constraint on (document_id, page_number)
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'visual_assets'
  AND indexname LIKE '%unique%';

-- 12. No orphan visual assets (every asset has a valid user_id)
SELECT COUNT(*) AS orphan_count
FROM visual_assets va
WHERE NOT EXISTS (
  SELECT 1 FROM auth.users u WHERE u.id = va.user_id
);

-- 13. Storage bucket exists
SELECT id, name, public
FROM storage.buckets
WHERE id = 'documents';

-- 14. Sample context_sources with image data (should show new columns)
SELECT id, type, name, storage_path, mime_type, file_size_bytes, image_width, image_height, processing_status
FROM context_sources
WHERE type = 'image'
LIMIT 5;
