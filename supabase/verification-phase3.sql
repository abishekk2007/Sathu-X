-- Spidey Bot — Phase 3 READ-ONLY verification
--
-- Run in: Supabase Dashboard -> SQL Editor
-- Safety: SELECT-only. No data, schema, or settings are modified.

-- ---------------------------------------------------------------------------
-- 1-3. Tables exist + row counts (your own data only; RLS does not apply to
--      postgres in the SQL Editor, so counts are project-wide).
-- ---------------------------------------------------------------------------
select 'profiles' as table_name, count(*) from public.profiles
union all
select 'conversations', count(*) from public.conversations
union all
select 'messages', count(*) from public.messages;

-- ---------------------------------------------------------------------------
-- 4. RLS is enabled on all three tables.
--    Expected: relrowsecurity = true for each.
-- ---------------------------------------------------------------------------
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('profiles', 'conversations', 'messages')
order by c.relname;

-- ---------------------------------------------------------------------------
-- 5. RLS policies exist per table.
-- ---------------------------------------------------------------------------
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'conversations', 'messages')
order by tablename, policyname;

-- ---------------------------------------------------------------------------
-- 6. Auth profile trigger exists and is SECURITY DEFINER.
--    Expected: one row, tgenabled = 'O', prosecdef = true.
-- ---------------------------------------------------------------------------
select t.tgname as trigger_name,
       c.relname as on_table,
       t.tgenabled = 'O' as trigger_enabled,
       p.proname as function_name,
       p.prosecdef as prosecurity_definer,
       p.proconfig as function_config
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'auth'
  and c.relname = 'users'
  and not t.tgisinternal;

-- Conversation-touch trigger (public.messages -> conversations.updated_at).
select t.tgname as trigger_name,
       c.relname as on_table,
       t.tgenabled = 'O' as trigger_enabled,
       p.proname as function_name
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
where c.relname = 'messages'
  and t.tgname = 'messages_touch_conversation';

-- ---------------------------------------------------------------------------
-- 7. Indexes on the three tables.
-- ---------------------------------------------------------------------------
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('profiles', 'conversations', 'messages')
order by tablename, indexname;
