-- ---------------------------------------------------------------------------
-- Phase 10 — Study flashcards
--
-- Minimal owner-scoped flashcard storage so the Study dashboard's Flashcards
-- card and the "Practice deck" action show the REAL current user's cards.
-- This is the first flashcard table in the project — no flashcard
-- table/API existed before this migration, so this is not a duplicate
-- learning system. Identity always derives from auth.uid() (never the
-- client); RLS re-verifies subject ownership exactly like subject_topics.
-- ---------------------------------------------------------------------------

create table if not exists public.flashcards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject_id uuid references public.subjects (id) on delete set null,
  question text not null
    constraint flashcards_question_not_empty check (length(btrim(question)) between 1 and 500),
  answer text not null
    constraint flashcards_answer_not_empty check (length(btrim(answer)) between 1 and 5000),
  review_count int not null default 0
    constraint flashcards_review_count_nonneg check (review_count >= 0),
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.flashcards is 'User-created study flashcards. Owner-scoped by RLS; subject ownership re-checked in policies so users can only attach cards to their own subjects.';
comment on column public.flashcards.review_count is 'How many times the card has been reviewed via the Practice deck.';
comment on column public.flashcards.last_reviewed_at is 'Last time the card was reviewed; a card with NULL or a pre-midnight timestamp is due for review today.';

-- ---------------------------------------------------------------------------
-- Row Level Security — owner-scoped only
-- ---------------------------------------------------------------------------
alter table public.flashcards enable row level security;

drop policy if exists "flashcards_select_own" on public.flashcards;
create policy "flashcards_select_own" on public.flashcards
  for select using (auth.uid() = user_id);

drop policy if exists "flashcards_insert_own" on public.flashcards;
create policy "flashcards_insert_own" on public.flashcards
  for insert with check (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
  );

drop policy if exists "flashcards_update_own" on public.flashcards;
create policy "flashcards_update_own" on public.flashcards
  for update using (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
  ) with check (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
  );

drop policy if exists "flashcards_delete_own" on public.flashcards;
create policy "flashcards_delete_own" on public.flashcards
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger + indexes
-- ---------------------------------------------------------------------------
drop trigger if exists flashcards_set_updated_at on public.flashcards;
create trigger flashcards_set_updated_at
  before update on public.flashcards
  for each row execute function public.set_updated_at();

create index if not exists flashcards_user_id_idx on public.flashcards (user_id);
create index if not exists flashcards_user_subject_idx on public.flashcards (user_id, subject_id);
create index if not exists flashcards_user_review_order_idx
  on public.flashcards (user_id, last_reviewed_at);