-- Spidey Bot — Phase 4B verification (READ-ONLY; run in Supabase SQL Editor)
-- Verifies: tables exist, RLS enabled, policies present, indexes present,
-- foreign keys present, CHECK constraints present. Never modifies data.

-- ---------------------------------------------------------------------------
-- 1. Tables exist
-- ---------------------------------------------------------------------------
select 'TABLE' as check_name, tablename as object
from pg_tables
where schemaname = 'public'
  and tablename in ('subjects', 'subject_topics', 'student_knowledge')
order by tablename;

-- ---------------------------------------------------------------------------
-- 2. RLS enabled on all three tables (+ profiles still enabled)
-- ---------------------------------------------------------------------------
select 'RLS_ENABLED' as check_name, c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('profiles', 'subjects', 'subject_topics', 'student_knowledge')
order by c.relname;

-- Expected rows: all four tables with rls_enabled = true.

-- ---------------------------------------------------------------------------
-- 3. Policies exist (4 per new table = 12 total)
-- ---------------------------------------------------------------------------
select 'POLICY' as check_name, tablename as table_name, policyname
from pg_policies
where schemaname = 'public'
  and tablename in ('subjects', 'subject_topics', 'student_knowledge')
order by tablename, policyname;

-- Expected:
--   subjects:               select/insert/update/delete _own
--   subject_topics:         select/insert/update/delete _own
--   student_knowledge:      select/insert/update/delete _own

-- ---------------------------------------------------------------------------
-- 4. Indexes exist
-- ---------------------------------------------------------------------------
select 'INDEX' as check_name, tablename as table_name, indexname
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'subjects_user_id_idx',
    'subjects_user_semester_idx',
    'subject_topics_user_id_idx',
    'subject_topics_subject_id_idx',
    'subject_topics_user_status_idx',
    'student_knowledge_user_id_idx',
    'student_knowledge_subject_id_idx',
    'student_knowledge_topic_id_idx',
    'student_knowledge_user_updated_idx',
    'student_knowledge_user_topic_key'
  )
order by tablename, indexname;

-- Expected: exactly 10 rows.

-- ---------------------------------------------------------------------------
-- 5. Foreign keys exist (user_id → auth.users everywhere; child FKs cascade)
-- ---------------------------------------------------------------------------
select 'FOREIGN_KEY' as check_name,
       conrelid::regclass::text as from_table,
       confrelid::regclass::text as to_table,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where contype = 'fkey'
  and connamespace = 'public'::regnamespace
  and conrelid::regclass::text in ('public.subjects', 'public.subject_topics', 'public.student_knowledge')
order by from_table, definition;

-- Expected:
--   subjects.user_id          → auth.users (on delete cascade)
--   subject_topics.user_id    → auth.users (on delete cascade)
--   subject_topics.subject_id → public.subjects (on delete cascade)
--   student_knowledge.user_id    → auth.users (on delete cascade)
--   student_knowledge.subject_id → public.subjects (on delete cascade)
--   student_knowledge.topic_id   → public.subject_topics (on delete cascade)

-- ---------------------------------------------------------------------------
-- 6. CHECK constraints exist (score ranges, statuses, name lengths)
-- ---------------------------------------------------------------------------
select 'CHECK' as check_name,
       conrelid::regclass::text as table_name,
       conname
from pg_constraint
where contype = 'check'
  and connamespace = 'public'::regnamespace
  and conrelid::regclass::text in (
    'public.profiles', 'public.subjects', 'public.subject_topics', 'public.student_knowledge'
  )
order by table_name, conname;

-- Expected includes:
--   subjects:                subjects_name_not_empty, subjects_credits_range …
--   subject_topics:          status_check + mastery_range + name_not_empty …
--   student_knowledge:       strength/confidence ranges, non-negative counts

-- ---------------------------------------------------------------------------
-- 7. updated_at triggers exist
-- ---------------------------------------------------------------------------
select 'TRIGGER' as check_name,
       event_object_table as table_name,
       trigger_name
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name in (
    'subjects_set_updated_at',
    'subject_topics_set_updated_at',
    'student_knowledge_set_updated_at'
  )
order by table_name;

-- Expected: exactly 3 rows.

-- ---------------------------------------------------------------------------
-- 8. profiles academic columns exist (Phase 4B extension)
-- ---------------------------------------------------------------------------
select 'COLUMN' as check_name, table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'profiles'
  and column_name in (
    'department', 'semester', 'academic_goal',
    'learning_style', 'preferred_language', 'target_score'
  )
order by column_name;

-- Expected: exactly 6 rows, all data_type = text.
