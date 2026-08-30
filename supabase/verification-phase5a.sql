-- verification-phase5a.sql
-- Phase 5A verification — READ ONLY. Do not insert/update/delete data.
-- Run in Supabase SQL Editor after applying the migration.

-- 1. documents table exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'documents'
  ) THEN 'PASS' ELSE 'FAIL: documents table missing' END AS check_1;

-- 2. Required columns exist
SELECT
  CASE WHEN (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'documents'
    AND column_name IN (
      'id', 'user_id', 'subject_id', 'topic_id', 'name', 'original_filename',
      'storage_path', 'mime_type', 'file_size_bytes', 'status',
      'processing_status', 'error_message', 'created_at', 'updated_at'
    )
  ) = 14 THEN 'PASS' ELSE 'FAIL: missing required columns' END AS check_2;

-- 3. CHECK constraints exist
SELECT
  CASE WHEN (
    SELECT count(*) FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'documents'
    AND constraint_type = 'CHECK'
  ) >= 4 THEN 'PASS' ELSE 'FAIL: missing CHECK constraints' END AS check_3;

-- 4. Indexes exist
SELECT
  CASE WHEN (
    SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'documents'
    AND indexname IN (
      'documents_user_id_idx',
      'documents_user_created_idx',
      'documents_subject_id_idx',
      'documents_topic_id_idx',
      'documents_status_idx'
    )
  ) = 5 THEN 'PASS' ELSE 'FAIL: missing indexes' END AS check_4;

-- 5. RLS enabled
SELECT
  CASE WHEN (
    SELECT relrowsecurity FROM pg_class
    WHERE relname = 'documents' AND relnamespace = 'public'::regnamespace
  ) = true THEN 'PASS' ELSE 'FAIL: RLS not enabled' END AS check_5;

-- 6. SELECT policy exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'documents'
    AND policyname = 'documents_select_own'
  ) THEN 'PASS' ELSE 'FAIL: SELECT policy missing' END AS check_6;

-- 7. INSERT policy exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'documents'
    AND policyname = 'documents_insert_own'
  ) THEN 'PASS' ELSE 'FAIL: INSERT policy missing' END AS check_7;

-- 8. UPDATE policy exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'documents'
    AND policyname = 'documents_update_own'
  ) THEN 'PASS' ELSE 'FAIL: UPDATE policy missing' END AS check_8;

-- 9. DELETE policy exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'documents'
    AND policyname = 'documents_delete_own'
  ) THEN 'PASS' ELSE 'FAIL: DELETE policy missing' END AS check_9;

-- 10. Storage bucket exists and is private
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'documents' AND public = false
  ) THEN 'PASS' ELSE 'FAIL: documents bucket missing or public' END AS check_10;

-- 11. Storage SELECT policy exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'documents_storage_select_own'
  ) THEN 'PASS' ELSE 'FAIL: storage SELECT policy missing' END AS check_11;

-- 12. Storage INSERT policy exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'documents_storage_insert_own'
  ) THEN 'PASS' ELSE 'FAIL: storage INSERT policy missing' END AS check_12;

-- 13. Storage DELETE policy exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'documents_storage_delete_own'
  ) THEN 'PASS' ELSE 'FAIL: storage DELETE policy missing' END AS check_13;

-- 14. subject foreign key exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'documents'
    AND constraint_type = 'FOREIGN KEY'
    AND constraint_name LIKE '%subject%'
  ) THEN 'PASS' ELSE 'FAIL: subject FK missing' END AS check_14;

-- 15. topic foreign key exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'documents'
    AND constraint_type = 'FOREIGN KEY'
    AND constraint_name LIKE '%topic%'
  ) THEN 'PASS' ELSE 'FAIL: topic FK missing' END AS check_15;
