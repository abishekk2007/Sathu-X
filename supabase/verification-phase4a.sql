-- Spidey Bot — Phase 4A verification (READ-ONLY; safe to run anytime)
-- Run in Supabase Dashboard → SQL Editor after the phase4a migration.

-- 1. New profile columns exist with expected defaults
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;

-- Expect: id, full_name, avatar_url, created_at, updated_at,
--         email (nullable), bio/college/course/year (nullable),
--         preferred_mode not null default 'general'

-- 2. preferred_mode constraint present
select conname from pg_constraint
where conrelid = 'public.profiles'::regclass and conname = 'profiles_preferred_mode_check';

-- 3. Memories table shape
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'memories'
order by ordinal_position;

-- 4. Memories indexes
select indexname from pg_indexes
where schemaname = 'public' and tablename = 'memories';

-- 5. RLS enabled + policies owner-scoped
select relrowselect as rls_enabled
from pg_class where oid = 'public.memories'::regclass;

select policyname, cmd
from pg_policies
where schemaname = 'public' and tablename = 'memories'
order by policyname;

-- 6. Triggers: memories updated_at + refreshed signup trigger
select tgname from pg_trigger
where tgrelid = 'public.memories'::regclass and not tgisinternal;

select tgname from pg_trigger
where tgrelid = 'auth.users'::regclass and not tgisinternal;

-- 7. Signup trigger function stores email now
select prosrc from pg_proc where proname = 'handle_new_user';

-- 8. Profile emails backfilled (rows with null email should be rare/none)
select count(*) as profiles_missing_email
from public.profiles
where email is null;
