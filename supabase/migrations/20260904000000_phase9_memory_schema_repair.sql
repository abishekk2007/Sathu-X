-- ============================================================================
-- Phase 9 — Corrective production schema repair.
--
-- WHY: The Phase 6F memory migration (20260829000000_phase6f_memory_type_system.sql)
-- was recorded in the remote migration history, but its DDL never actually took
-- effect on the production database. Live server logs repeatedly show:
--   code=42703  column memories.key does not exist
--   code=42703  column profiles.memory_enabled does not exist
--   code=PGRST204 Could not find the 'confidence' column of 'memories'
-- which breaks every memory read/write ("Memory save failed — continuing without
-- saving"). This file idempotently re-applies the missing columns/constraints so
-- typing the production schema to the Phase 6F model is guaranteed.
--
-- Every statement is guarded (IF NOT EXISTS / information_schema / pg_constraint)
-- and NEVER drops a table, column, policy, or data. Safe to run multiple times.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. memories — Phase 6F typed columns (mirror of 20260829000000)
-- ---------------------------------------------------------------------------
alter table public.memories add column if not exists memory_type text
  not null default 'fact';
alter table public.memories add column if not exists key text not null default '';
alter table public.memories add column if not exists source text
  not null default 'inferred';
alter table public.memories add column if not exists confidence text
  not null default 'low';
alter table public.memories add column if not exists enabled boolean
  not null default true;
alter table public.memories add column if not exists last_used_at timestamptz
  not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'memories_memory_type_check'
      and conrelid = 'public.memories'::regclass
  ) then
    alter table public.memories
      add constraint memories_memory_type_check
      check (memory_type in (
        'preference', 'profile', 'project', 'workflow',
        'instruction', 'fact', 'goal'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'memories_source_check'
      and conrelid = 'public.memories'::regclass
  ) then
    alter table public.memories
      add constraint memories_source_check
      check (source in ('explicit', 'inferred'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'memories_confidence_check'
      and conrelid = 'public.memories'::regclass
  ) then
    alter table public.memories
      add constraint memories_confidence_check
      check (confidence in ('high', 'medium', 'low'));
  end if;
end;
$$;

-- Backfill legacy rows (key='') onto the 6F taxonomy exactly as phase6f did.
do $$
declare
  legacyRows bigint;
begin
  select count(*) into legacyRows from public.memories where key = '';
  if legacyRows > 0 then
    update public.memories
    set memory_type = case coalesce(category, 'general')
          when 'preference'    then 'preference'
          when 'communication' then 'preference'
          when 'project'       then 'project'
          when 'goal'          then 'goal'
          when 'work'          then 'work'
          when 'education'     then 'profile'
          when 'academic'      then 'profile'
          when 'personal'      then 'profile'
          else 'fact'
        end,
        source = 'explicit',
        confidence = 'medium'
    where key = '';
  end if;
end;
$$;

create index if not exists memories_user_enabled_idx
  on public.memories (user_id, enabled);
create index if not exists memories_user_key_idx
  on public.memories (user_id, key);

comment on column public.memories.memory_type is
  'Phase 6F taxonomy: preference / profile / project / workflow / instruction / fact / goal.';
comment on column public.memories.key is
  'Stable dedup key (type:subject). Empty for legacy Phase 4A rows.';
comment on column public.memories.source is
  'explicit (user asked) or inferred (behavioral estimate).';
comment on column public.memories.confidence is
  'high / medium / low — explicit user statements start high.';
comment on column public.memories.enabled is
  'When false the memory is kept but never used for context or recall.';
comment on column public.memories.last_used_at is
  'Last time this memory was surfaced in a conversation.';

-- ---------------------------------------------------------------------------
-- 2. profiles.memory_enabled — Phase 6F master switch (mirror of phase6f)
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists memory_enabled boolean
  not null default true;

comment on column public.profiles.memory_enabled is
  'Phase 6F master switch: when false no memories are recalled or extracted.';
