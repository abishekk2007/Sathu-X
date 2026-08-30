-- Spidey Bot — Phase 3 SAFE repair: profile-creation hook on auth.users
--
-- Run in: Supabase Dashboard -> SQL Editor
-- Safety: fully idempotent. Creates/replaces ONLY the handle_new_user()
-- function and the on_auth_user_created trigger.
--   * Does NOT create, alter, or drop any table.
--   * Does NOT touch RLS or policies.
--   * Does NOT modify existing rows or user data.
-- Safe to run regardless of whether the objects already exist and whether
-- they were created correctly the first time.
--
-- Why this exists: triggers on auth.users are invisible in the Dashboard's
-- Table Editor, so "the other three triggers exist" does not prove this one
-- does. If it is missing or broken, signups fail with GoTrue 500
-- ("Database error saving new user") or succeed silently without a profile.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Profile creation on signup (idempotent replace)
-- SECURITY DEFINER: runs as its owner during GoTrue's insert into
-- auth.users, where there is no user JWT; auth.uid() would be NULL and an
-- RLS-bound invoker insert could never pass profiles_insert_own.
-- The owner (postgres, i.e. whoever runs this script) owns public.profiles,
-- so RLS is bypassed legitimately by table ownership — no policy changes.
--
-- Works for BOTH email/password and Google sign-ups:
--   full_name  <- raw_user_meta_data->>'full_name'  else ->>'name'
--   avatar_url <- raw_user_meta_data->>'avatar_url' else ->>'picture'
-- (Supabase normalises Google identities into these metadata keys.)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      new.raw_user_meta_data ->> 'picture'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Recreate the trigger cleanly (drop-if-exists avoids ERROR 42P07).
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Read-only verification (results appear in the SQL Editor output).
-- Expected: one row for on_auth_user_created with prosecure_definer = true.
-- ---------------------------------------------------------------------------
select
  t.tgname                    as trigger_name,
  c.relname                   as on_table,
  p.proname                   as function_name,
  p.prosecdef                 as prosecurity_definer,
  p.proconfig                 as function_config
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
where t.tgname = 'on_auth_user_created';
