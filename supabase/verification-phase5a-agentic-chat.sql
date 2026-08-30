-- ============================================================================
-- Phase 5A — Agentic Chat Core: Verification Script
-- Run after applying migration 20260826010000_phase5a_agentic_chat.sql
-- ============================================================================

-- 1. Table exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'context_sources'
  ) THEN '✅ context_sources table exists'
  ELSE '❌ context_sources table MISSING'
END AS check_1;

-- 2. RLS enabled
SELECT
  CASE WHEN relrowsecurity = true
  THEN '✅ RLS enabled on context_sources'
  ELSE '❌ RLS NOT enabled on context_sources'
END AS check_2
FROM pg_class
WHERE relname = 'context_sources';

-- 3. Policies exist (4 expected)
SELECT
  COUNT(*) AS policy_count,
  CASE WHEN COUNT(*) >= 4
  THEN '✅ All 4 RLS policies present'
  ELSE '❌ Missing RLS policies (expected 4, got ' || COUNT(*) || ')'
END AS check_3
FROM pg_policies
WHERE tablename = 'context_sources';

-- 4. Index exists
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_context_sources_user_created'
  ) THEN '✅ Index idx_context_sources_user_created exists'
  ELSE '❌ Index idx_context_sources_user_created MISSING'
END AS check_4;

-- 5. document_chunks table exists (required for document retrieval)
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'document_chunks'
  ) THEN '✅ document_chunks table exists'
  ELSE '❌ document_chunks table MISSING'
END AS check_5;

-- 6. documents table has processing_status column
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'processing_status'
  ) THEN '✅ documents.processing_status column exists'
  ELSE '❌ documents.processing_status column MISSING'
END AS check_6;

-- 7. Auto-processing test: verify processDocument is importable
-- This is checked at build time. At runtime, the chat API calls processDocument()
-- when a document with processing_status != 'ready' is attached.

-- 8. Grounding prompt anti-hallucination rules
-- The grounding instructions now include:
--   Rule 4: "NEVER say 'I don't have access to your document' when valid
--           retrieved context was supplied"
--   Rule 5: Explicit "not found" message when context lacks information

-- 9. Retrieval confidence levels
-- Console logs now include: confidence=high|medium|low|none
-- high: bestScore >= 120 (exact match)
-- medium: bestScore >= 60 (strong token overlap)
-- low: bestScore > 0 (weak match)
-- none: no matching tokens

-- 10. Adjacent chunk expansion
-- retrieval now includes chunks adjacent to high-scoring ones (offset ±1)
-- for better context, bounded by maxChars=12000

-- 11. Type constraint works (try insert with invalid type — should fail)
-- This is a manual check: try inserting type='invalid' via the API.
-- Expected: 400 bad request.

-- 12. Insert a test source (replace USER_ID with a real auth.uid())
-- INSERT INTO context_sources (user_id, type, name, content_text)
-- VALUES ('USER_ID', 'pasted_text', 'Test source', 'Hello world test content')
-- RETURNING id, name, type, created_at;

-- 13. Verify RLS: query as authenticated user should only see own rows
-- SELECT COUNT(*) FROM context_sources;
-- Expected: only the current user's rows.

-- 14. Delete test source
-- DELETE FROM context_sources WHERE name = 'Test source';
