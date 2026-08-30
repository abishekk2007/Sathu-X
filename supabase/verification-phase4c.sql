-- Spidey Bot — Phase 4C verification (READ-ONLY; run after the migration)
-- Confirms: tables exist, RLS enabled, policies present, indexes present,
-- foreign keys present, constraints present. Modifies no data.

-- 1. Tables exist -------------------------------------------------------------
select 'tables' as check_name, tablename
from pg_tables
where schemaname = 'public'
  and tablename in ('exams', 'study_plans', 'study_sessions', 'study_goals')
order by tablename;

-- 2. RLS enabled on all four tables ------------------------------------------
select 'rls_enabled' as check_name, c.relname as table_name, c.relrowsecurity as rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in ('exams', 'study_plans', 'study_sessions', 'study_goals')
order by c.relname;

-- 3. Policy count per table (expect exams=4, study_plans=4,
--    study_sessions=3, study_goals=4) -----------------------------------------
select 'policies' as check_name, tablename, count(*) as policy_count
from pg_policies
where schemaname = 'public'
  and tablename in ('exams', 'study_plans', 'study_sessions', 'study_goals')
group by tablename
order by tablename;

-- 4. Expected indexes exist ---------------------------------------------------
select 'indexes' as check_name, indexname
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'exams_user_id_idx',
    'exams_user_date_idx',
    'exams_subject_id_idx',
    'study_plans_user_id_idx',
    'study_plans_user_status_idx',
    'study_sessions_user_id_idx',
    'study_sessions_plan_id_idx',
    'study_sessions_scheduled_date_idx',
    'study_sessions_user_date_idx',
    'study_goals_user_id_idx',
    'study_goals_user_status_idx'
  )
order by indexname;

-- 5. Foreign keys from study_sessions (expect 4: plan, subject, topic, exam) --
select 'fks' as check_name,
       tc.table_name,
       kcu.column_name,
       ccu.table_name as references_table
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
where tc.constraint_type = 'FOREIGN KEY'
  and tc.table_schema = 'public'
  and tc.table_name in ('exams', 'study_plans', 'study_sessions', 'study_goals')
order by tc.table_name, kcu.column_name;

-- 6. Check constraints (types/statuses/ranges) -------------------------------
select 'constraints' as check_name, conrelid::regclass as table_name, conname
from pg_constraint
where contype = 'c'
  and connamespace = 'public'::regnamespace
  and conrelid::regclass::text in ('exams', 'study_plans', 'study_sessions', 'study_goals')
order by conrelid::regclass::text, conname;

-- 7. updated_at triggers reuse public.set_updated_at() ------------------------
select 'triggers' as check_name, event_object_table as table_name, trigger_name
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table in ('exams', 'study_plans', 'study_sessions', 'study_goals')
order by event_object_table;
