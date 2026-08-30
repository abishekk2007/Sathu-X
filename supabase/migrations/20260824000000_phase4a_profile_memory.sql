-- Spidey Bot — Phase 4A: profile fields + long-term memory
-- Apply via Supabase Dashboard → SQL Editor.
--
-- Safe to run multiple times (idempotent). Never drops tables or data:
--   * extends the EXISTING public.profiles table with new optional columns
--   * creates the NEW public.memories table (nothing else is touched)
--   * re-points the signup trigger at an updated function (insert-time only;
--     existing profile rows are never overwritten)

-- ---------------------------------------------------------------------------
-- 1. Extend profiles (existing table; id already mirrors auth.users.id)
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists college text;
alter table public.profiles add column if not exists course text;
alter table public.profiles add column if not exists year text;

alter table public.profiles add column if not exists preferred_mode text
  not null default 'general';

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS — guard manually so reruns
-- stay silent. Mirrors the AiMode union used across the app.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_preferred_mode_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_preferred_mode_check
      check (preferred_mode in ('general', 'student', 'assistant'));
  end if;
end;
$$;

-- One-shot backfill for users who signed up before this migration ran.
update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id
  and p.email is distinct from u.email;

comment on column public.profiles.preferred_mode is 'Default AI mode applied to new chats.';
comment on column public.profiles.year is 'Academic year label, free-form (e.g. "2nd year").';

-- ---------------------------------------------------------------------------
-- 2. Memories (long-term facts the assistant may reuse across chats)
-- ---------------------------------------------------------------------------
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content text not null
    constraint memories_content_not_empty check (length(btrim(content)) between 1 and 500),
  category text not null default 'general'
    constraint memories_category_check check (category in (
      'general', 'preference', 'education', 'personal',
      'project', 'academic', 'work', 'goal', 'communication'
    )),
  importance int not null default 3
    constraint memories_importance_range check (importance between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.memories is 'Long-term user facts used to personalize replies. Owner-scoped by RLS.';

create index if not exists memories_user_id_idx on public.memories (user_id);
create index if not exists memories_user_category_idx on public.memories (user_id, category);
create index if not exists memories_user_updated_idx on public.memories (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- 3. Row Level Security on memories (same owner-scoped shape as the rest)
-- ---------------------------------------------------------------------------
alter table public.memories enable row level security;

drop policy if exists "memories_select_own" on public.memories;
create policy "memories_select_own" on public.memories
  for select using (auth.uid() = user_id);

drop policy if exists "memories_insert_own" on public.memories;
create policy "memories_insert_own" on public.memories
  for insert with check (auth.uid() = user_id);

drop policy if exists "memories_update_own" on public.memories;
create policy "memories_update_own" on public.memories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "memories_delete_own" on public.memories;
create policy "memories_delete_own" on public.memories
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 4. updated_at maintenance — reuses the existing set_updated_at() function
-- ---------------------------------------------------------------------------
drop trigger if exists memories_set_updated_at on public.memories;
create trigger memories_set_updated_at
  before update on public.memories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Signup trigger refresh — also stores email + OAuth name/avatar.
--    Fires on INSERT only, so later edits made by the user are never clobbered.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, avatar_url, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Recreate to bind the refreshed function definition.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
