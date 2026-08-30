-- ============================================================================
-- Phase 4D Enhancement: Chat Study Tracking — Verification
-- ============================================================================
-- Read-only checks. Safe to run at any time.
-- ============================================================================

-- 1. Table exists
SELECT '1. Table exists' AS check_name,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'chat_study_sessions'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 2. Required columns exist
SELECT '2. Columns exist' AS check_name,
  CASE WHEN (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'chat_study_sessions'
      AND column_name IN (
        'id', 'user_id', 'subject_id', 'topic_id', 'conversation_id',
        'started_at', 'ended_at', 'active_seconds', 'last_activity_at',
        'source', 'created_at', 'updated_at'
      )
  ) = 12 THEN 'PASS' ELSE 'FAIL' END AS result;

-- 3. Indexes exist
SELECT '3. Indexes exist' AS check_name,
  CASE WHEN (
    SELECT count(*) FROM pg_indexes
    WHERE tablename = 'chat_study_sessions'
      AND indexname IN (
        'chat_study_user_id_idx',
        'chat_study_user_date_idx',
        'chat_study_user_active_idx',
        'chat_study_subject_idx',
        'chat_study_topic_idx'
      )
  ) = 5 THEN 'PASS' ELSE 'FAIL' END AS result;

-- 4. RLS enabled
SELECT '4. RLS enabled' AS check_name,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = 'chat_study_sessions'
      AND rowsecurity = true
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 5. RLS policies exist (4 policies)
SELECT '5. Policies exist' AS check_name,
  CASE WHEN (
    SELECT count(*) FROM pg_policies
    WHERE tablename = 'chat_study_sessions'
      AND policyname IN (
        'chat_study_select_own',
        'chat_study_insert_own',
        'chat_study_update_own',
        'chat_study_delete_own'
      )
  ) = 4 THEN 'PASS' ELSE 'FAIL' END AS result;

-- 6. Foreign keys exist
SELECT '6. Foreign keys exist' AS check_name,
  CASE WHEN (
    SELECT count(*) FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'chat_study_sessions'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name IN (
        'chat_study_sessions_user_id_fkey',
        'chat_study_sessions_subject_id_fkey',
        'chat_study_sessions_topic_id_fkey',
        'chat_study_sessions_conversation_id_fkey'
      )
  ) = 4 THEN 'PASS' ELSE 'FAIL' END AS result;

-- 7. Constraints exist (CHECK on active_seconds, source)
SELECT '7. Constraints exist' AS check_name,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name IN (
        'chat_study_active_seconds_nonneg',
        'chat_study_source_check'
      )
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 8. updated_at trigger exists
SELECT '8. updated_at trigger exists' AS check_name,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND event_object_table = 'chat_study_sessions'
      AND trigger_name = 'chat_study_sessions_set_updated_at'
  ) THEN 'PASS' ELSE 'FAIL' END AS result;

-- 9. No redundant productivity tables
SELECT '9. No redundant tables' AS check_name,
  CASE WHEN (
    SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('productivity_scores', 'productivity_history', 'chat_study_timers')
  ) = 0 THEN 'PASS' ELSE 'FAIL' END AS result;

-- 10. Original columns on profiles unchanged
SELECT '10. Original profile columns intact' AS check_name,
  CASE WHEN (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name IN (
        'preferred_session_minutes', 'preferred_break_minutes',
        'preferred_study_time', 'daily_study_target_minutes'
      )
  ) = 4 THEN 'PASS' ELSE 'FAIL' END AS result;
