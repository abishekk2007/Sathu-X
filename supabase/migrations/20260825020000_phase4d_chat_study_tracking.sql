-- Spidey Bot — Phase 4D Enhancement: Chat-Based Study Time Tracking
-- Apply via Supabase Dashboard → SQL Editor.
--
-- Safe to run multiple times (idempotent). Never drops tables or data:
--   * creates chat_study_sessions for tracking active academic chat time
--   * enables RLS with strict owner + parent-ownership checks
--   * creates indexes for bounded queries
--   * reuses the existing set_updated_at() trigger function
--
-- Chat study time is counted ONLY from active authenticated academic
-- engagement and does not count idle browser time.

-- ---------------------------------------------------------------------------
-- 1. chat_study_sessions — active academic study time from chat
-- ---------------------------------------------------------------------------
create table if not exists public.chat_study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject_id uuid references public.subjects (id) on delete set null,
  topic_id uuid references public.subject_topics (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  active_seconds int not null default 0
    constraint chat_study_active_seconds_nonneg check (active_seconds >= 0),
  last_activity_at timestamptz,
  source text not null default 'chat'
    constraint chat_study_source_check check (source in ('chat')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.chat_study_sessions is 'Active academic study time tracked from Student Mode chat. Only counts real engagement — idle/inactive time excluded.';
comment on column public.chat_study_sessions.active_seconds is 'Total seconds of active academic engagement. Updated by heartbeat from client; capped server-side.';
comment on column public.chat_study_sessions.last_activity_at is 'Last time the client reported activity. Used for session recovery and inactivity detection.';
comment on column public.chat_study_sessions.source is 'Always "chat" — distinguishes from planner-based study_sessions.';

-- ---------------------------------------------------------------------------
-- 2. Row Level Security — owner-scoped only
-- ---------------------------------------------------------------------------
alter table public.chat_study_sessions enable row level security;

drop policy if exists "chat_study_select_own" on public.chat_study_sessions;
create policy "chat_study_select_own" on public.chat_study_sessions
  for select using (auth.uid() = user_id);

drop policy if exists "chat_study_insert_own" on public.chat_study_sessions;
create policy "chat_study_insert_own" on public.chat_study_sessions
  for insert with check (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t where t.id = topic_id and t.user_id = auth.uid()
    ))
    and (conversation_id is null or exists (
      select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
    ))
  );

drop policy if exists "chat_study_update_own" on public.chat_study_sessions;
create policy "chat_study_update_own" on public.chat_study_sessions
  for update using (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t where t.id = topic_id and t.user_id = auth.uid()
    ))
    and (conversation_id is null or exists (
      select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
    ))
  ) with check (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t where t.id = topic_id and t.user_id = auth.uid()
    ))
    and (conversation_id is null or exists (
      select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
    ))
  );

drop policy if exists "chat_study_delete_own" on public.chat_study_sessions;
create policy "chat_study_delete_own" on public.chat_study_sessions
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Indexes — bounded queries stay cheap as data grows
-- ---------------------------------------------------------------------------
create index if not exists chat_study_user_id_idx on public.chat_study_sessions (user_id);
create index if not exists chat_study_user_date_idx on public.chat_study_sessions (user_id, started_at);
create index if not exists chat_study_user_active_idx on public.chat_study_sessions (user_id, ended_at)
  where ended_at is null;
create index if not exists chat_study_subject_idx on public.chat_study_sessions (subject_id);
create index if not exists chat_study_topic_idx on public.chat_study_sessions (topic_id);

-- ---------------------------------------------------------------------------
-- 4. updated_at maintenance — reuse the existing set_updated_at() function
-- ---------------------------------------------------------------------------
drop trigger if exists chat_study_sessions_set_updated_at on public.chat_study_sessions;
create trigger chat_study_sessions_set_updated_at
  before update on public.chat_study_sessions
  for each row execute function public.set_updated_at();
