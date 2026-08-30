-- Spidey Bot — Phase 5B verification script
-- READ-ONLY. Safe to run at any time. Does NOT insert or modify data.

-- 1. documents table exists
SELECT 'documents table exists' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'documents'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 2. extracted_text column exists
SELECT 'extracted_text column' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'extracted_text'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 3. extracted_text_length column exists
SELECT 'extracted_text_length column' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'extracted_text_length'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 4. processed_at column exists
SELECT 'processed_at column' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'processed_at'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 5. processing_error column exists
SELECT 'processing_error column' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'processing_error'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 6. document_chunks table exists
SELECT 'document_chunks table exists' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'document_chunks'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 7. document_chunks has expected columns
SELECT 'document_chunks columns' AS check,
  CASE WHEN (
    SELECT count(DISTINCT column_name) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'document_chunks'
    AND column_name IN ('id', 'document_id', 'user_id', 'chunk_index', 'content', 'page_number', 'char_count', 'created_at')
  ) = 8 THEN 'PASS' ELSE 'FAIL' END AS result;

-- 8. document_chunks foreign key to documents
SELECT 'document_chunks FK to documents' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public' AND table_name = 'document_chunks'
    AND constraint_type = 'FOREIGN KEY' AND constraint_name LIKE '%document%'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 9. document_chunks indexes exist
SELECT 'document_chunks indexes' AS check,
  CASE WHEN (
    SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'document_chunks'
    AND indexname IN ('document_chunks_document_id_idx', 'document_chunks_user_id_idx', 'document_chunks_doc_index_idx')
  ) >= 3 THEN 'PASS' ELSE 'FAIL' END AS result;

-- 10. RLS enabled on document_chunks
SELECT 'document_chunks RLS enabled' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'document_chunks' AND rowsecurity = true
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 11. RLS SELECT policy exists on document_chunks
SELECT 'document_chunks SELECT policy' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_chunks'
    AND policyname = 'document_chunks_select_own' AND cmd = 'SELECT'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 12. RLS INSERT policy exists on document_chunks
SELECT 'document_chunks INSERT policy' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_chunks'
    AND policyname = 'document_chunks_insert_own' AND cmd = 'INSERT'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 13. RLS DELETE policy exists on document_chunks
SELECT 'document_chunks DELETE policy' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'document_chunks'
    AND policyname = 'document_chunks_delete_own' AND cmd = 'DELETE'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 14. Documents RLS still enabled
SELECT 'documents RLS still enabled' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'documents' AND rowsecurity = true
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 15. Storage bucket is still private
SELECT 'documents bucket is private' AS check,
  CASE WHEN EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'documents' AND public = false
  ) THEN 'PASS' ELSE 'FAIL' END AS result;
