-- ---------------------------------------------------------------------------
-- Phase 10 repair — missing public.chat_study_sessions
--
-- Production investigation (Study dashboard 500): the Phase 4D migration
-- 20260825020000 is recorded in supabase_migrations.schema_migrations but
-- public.chat_study_sessions was never actually created in the production
-- database (to_regclass = null; PostgREST PGRST205). The Phase 10 Study
-- dashboard reads this table for today's chat-study minutes and recent
-- activity, so a missing table makes the whole dashboard 500.
--
-- This supplementary repair migration recreates the object exactly as the
-- Phase 4D migration intended (table + comments + owner-scoped RLS with
-- parent-ownership re-checks + indexes + updated_at trigger). It is fully
-- idempotent and NEVER modifies the applied 20260825020000 migration.
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

create index if not exists chat_study_user_id_idx on public.chat_study_sessions (user_id);
create index if not exists chat_study_user_date_idx on public.chat_study_sessions (user_id, started_at);
create index if not exists chat_study_user_active_idx on public.chat_study_sessions (user_id, ended_at)
  where ended_at is null;
create index if not exists chat_study_subject_idx on public.chat_study_sessions (subject_id);
create index if not exists chat_study_topic_idx on public.chat_study_sessions (topic_id);

drop trigger if exists chat_study_sessions_set_updated_at on public.chat_study_sessions;
create trigger chat_study_sessions_set_updated_at
  before update on public.chat_study_sessions
  for each row execute function public.set_updated_at();