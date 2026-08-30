-- Spidey Bot — Phase 6F: typed long-term memory
-- Apply via Supabase Dashboard → SQL Editor.
--
-- Safe to run multiple times (idempotent). Never drops tables or data:
--   * extends the EXISTING public.memories table with the typed 6F model
--     (memory_type, key, source, confidence, enabled, last_used_at)
--   * maps existing Phase 4A rows onto the new taxonomy (user-provided facts
--     become explicit/medium; general/category-less rows stay inference-prone)
--   * adds a per-user master switch (profiles.memory_enabled)
-- Nothing here changes ownership rules: the existing RLS policies on
-- public.memories continue to scope every read/write to auth.uid().

-- ---------------------------------------------------------------------------
-- 1. Extend memories with the Phase 6F typed model
-- ---------------------------------------------------------------------------
alter table public.memories add column if not exists memory_type text
  not null default 'fact';

-- Stable dedup key (e.g. 'preference:response_language'). Empty for legacy
-- rows; the store assigns a key on first 6F upsert.
alter table public.memories add column if not exists key text not null default '';

-- Where the fact came from: explicit user request vs inferred from behavior.
alter table public.memories add column if not exists source text
  not null default 'inferred';

-- Confidence tier. Explicit user statements start high; inferred never rises
-- above medium; repeated confirmation may promote an inferred fact.
alter table public.memories add column if not exists confidence text
  not null default 'low';

-- Disabled rows are excluded from retrieval/context but kept for reversal.
alter table public.memories add column if not exists enabled boolean
  not null default true;

-- Last time this memory was surfaced to a conversation (recency ranking).
alter table public.memories add column if not exists last_used_at timestamptz
  not null default now();

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS — guard manually so reruns
-- stay silent.
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
-- 2. Backfill legacy rows onto the 6F taxonomy.
--    Rows without a key predate 6F and were user-provided (explicit) but were
--    never confidence-tagged, so they land at medium. New 6F writes always set
--    a key and are never touched by this guard.
-- ---------------------------------------------------------------------------
do $$
declare
  legacyRows bigint;
begin
  select count(*) into legacyRows from public.memories where key = '';
  if legacyRows > 0 then
    update public.memories
    set memory_type = case category
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

-- ---------------------------------------------------------------------------
-- 3. Indexes for the 6F access paths (owner-scoped by the same user_id).
-- ---------------------------------------------------------------------------
create index if not exists memories_user_enabled_idx
  on public.memories (user_id, enabled);
create index if not exists memories_user_key_idx
  on public.memories (user_id, key);

-- ---------------------------------------------------------------------------
-- 4. Per-user memory master switch (RLS already scopes profiles to owner).
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists memory_enabled boolean
  not null default true;

comment on column public.profiles.memory_enabled is
  'Phase 6F master switch: when false no memories are recalled or extracted.';