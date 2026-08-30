-- ============================================================================
-- Phase 4D Verification (READ-ONLY)
-- Run in Supabase SQL Editor after migration 20260825010000.
-- Each check prints PASS or FAIL via RAISE NOTICE / RAISE WARNING.
-- ============================================================================

-- 1. Routine columns exist on profiles
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'preferred_session_minutes'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'preferred_break_minutes'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'preferred_study_time'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'daily_study_target_minutes'
  ) THEN
    RAISE NOTICE 'PASS: profiles has all routine preference columns';
  ELSE
    RAISE WARNING 'FAIL: profiles missing routine preference columns';
  END IF;
END $$;

-- 2. RLS still enabled on profiles (existing — must not be broken)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE tablename = 'profiles' AND rowsecurity = true
  ) THEN
    RAISE NOTICE 'PASS: RLS enabled on profiles';
  ELSE
    RAISE WARNING 'FAIL: RLS disabled on profiles';
  END IF;
END $$;

-- 3. RLS enabled on all existing tables
DO $$
DECLARE
  tbl text;
  insecure text[] := ARRAY[]::text[];
  expected text[] := ARRAY[
    'profiles','conversations','messages','memories',
    'subjects','subject_topics','student_knowledge',
    'exams','study_plans','study_sessions','study_goals'
  ];
BEGIN
  FOREACH tbl IN ARRAY expected LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE tablename = tbl AND rowsecurity = true
    ) THEN
      insecure := array_append(insecure, tbl);
    END IF;
  END LOOP;
  IF array_length(insecure, 1) IS NULL THEN
    RAISE NOTICE 'PASS: RLS enabled on all existing tables';
  ELSE
    RAISE WARNING 'FAIL: RLS missing on: %', insecure;
  END IF;
END $$;

-- 4. No redundant productivity tables were created
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'productivity_scores'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'productivity_history'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'study_routines'
  ) THEN
    RAISE NOTICE 'PASS: No redundant productivity tables created';
  ELSE
    RAISE WARNING 'FAIL: Unexpected productivity tables found';
  END IF;
END $$;

-- 5. All existing tables still exist
DO $$
DECLARE
  tbl text;
  expected text[] := ARRAY[
    'profiles','conversations','messages','memories',
    'subjects','subject_topics','student_knowledge',
    'exams','study_plans','study_sessions','study_goals'
  ];
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH tbl IN ARRAY expected LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = tbl
    ) THEN
      missing := array_append(missing, tbl);
    END IF;
  END LOOP;
  IF array_length(missing, 1) IS NULL THEN
    RAISE NOTICE 'PASS: All existing tables present';
  ELSE
    RAISE WARNING 'FAIL: Missing tables: %', missing;
  END IF;
END $$;

-- 6. CHECK constraints on new columns
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON con.conrelid = c.oid
    WHERE c.relname = 'profiles'
      AND con.conname = 'profiles_preferred_session_minutes_check'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON con.conrelid = c.oid
    WHERE c.relname = 'profiles'
      AND con.conname = 'profiles_preferred_break_minutes_check'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON con.conrelid = c.oid
    WHERE c.relname = 'profiles'
      AND con.conname = 'profiles_preferred_study_time_check'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON con.conrelid = c.oid
    WHERE c.relname = 'profiles'
      AND con.conname = 'profiles_daily_study_target_minutes_check'
  ) THEN
    RAISE NOTICE 'PASS: CHECK constraints on all new columns';
  ELSE
    RAISE WARNING 'FAIL: One or more CHECK constraints missing on new columns';
  END IF;
END $$;

-- 7. New columns have correct types
DO $$
BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'preferred_session_minutes'
  ) = 'integer'
  AND (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'preferred_break_minutes'
  ) = 'integer'
  AND (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'daily_study_target_minutes'
  ) = 'integer'
  AND (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'preferred_study_time'
  ) = 'text'
  THEN
    RAISE NOTICE 'PASS: New columns have correct types';
  ELSE
    RAISE WARNING 'FAIL: New column types are incorrect';
  END IF;
END $$;

-- 8. Existing foreign keys still intact
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_conversation_id_fkey'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subject_topics_subject_id_fkey'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'study_sessions_study_plan_id_fkey'
  ) THEN
    RAISE NOTICE 'PASS: Key foreign keys still exist';
  ELSE
    RAISE WARNING 'FAIL: Some foreign keys are missing';
  END IF;
END $$;

-- 9. Existing indexes on study_sessions still present (productivity relies on these)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname LIKE '%study_sessions%scheduled_date%'
  ) OR EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'study_sessions'
  ) THEN
    RAISE NOTICE 'PASS: study_sessions indexes present';
  ELSE
    RAISE WARNING 'FAIL: study_sessions indexes missing';
  END IF;
END $$;

-- 10. Original profiles columns still intact (not dropped)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'full_name'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'preferred_mode'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'learning_style'
  ) THEN
    RAISE NOTICE 'PASS: Original profile columns intact';
  ELSE
    RAISE WARNING 'FAIL: Some original profile columns missing';
  END IF;
END $$;
