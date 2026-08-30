-- Spidey Bot — Phase 4B: student intelligence (subjects, topics, knowledge)
-- Apply via Supabase Dashboard → SQL Editor.
--
-- Safe to run multiple times (idempotent). Never drops tables or data:
--   * extends the EXISTING public.profiles table with optional academic fields
--   * creates NEW public.subjects / public.subject_topics / public.student_knowledge
--   * enables RLS on the new tables with strict owner + parent-ownership checks
--   * reuses the existing public.set_updated_at() trigger function
--
-- Nothing here touches conversations, messages, memories, or auth.

-- ---------------------------------------------------------------------------
-- 1. Extend profiles (existing table) with OPTIONAL academic context fields.
--    All nullable — users are never forced to fill these in.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists department text;
alter table public.profiles add column if not exists semester text;
alter table public.profiles add column if not exists academic_goal text;
alter table public.profiles add column if not exists learning_style text;
alter table public.profiles add column if not exists preferred_language text;
alter table public.profiles add column if not exists target_score text;

comment on column public.profiles.department is 'Academic department/branch, free-form (e.g. "CSE").';
comment on column public.profiles.semester is 'Current semester label, free-form (e.g. "3").';
comment on column public.profiles.academic_goal is 'What the student wants to achieve this term.';
comment on column public.profiles.learning_style is 'How they prefer to learn (e.g. examples-first).';
comment on column public.profiles.preferred_language is 'Language they prefer explanations in.';
comment on column public.profiles.target_score is 'Target grade/score, free-form (e.g. "CGPA 9").';

-- ---------------------------------------------------------------------------
-- 2. subjects — one row per subject the user studies
-- ---------------------------------------------------------------------------
create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null
    constraint subjects_name_not_empty check (length(btrim(name)) between 1 and 120),
  code text
    constraint subjects_code_len check (char_length(code) <= 40),
  description text
    constraint subjects_description_len check (char_length(description) <= 1000),
  semester text
    constraint subjects_semester_len check (char_length(semester) <= 40),
  credits int
    constraint subjects_credits_range check (credits between 0 and 20),
  color text
    constraint subjects_color_len check (char_length(color) <= 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subjects is 'Subjects a user studies. Owner-scoped by RLS; identity always from auth.uid().';

-- ---------------------------------------------------------------------------
-- 3. subject_topics — topics inside a subject, with progress tracking
-- ---------------------------------------------------------------------------
create table if not exists public.subject_topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject_id uuid not null references public.subjects (id) on delete cascade,
  name text not null
    constraint subject_topics_name_not_empty check (length(btrim(name)) between 1 and 160),
  description text
    constraint subject_topics_description_len check (char_length(description) <= 1000),
  unit text
    constraint subject_topics_unit_len check (char_length(unit) <= 40),
  status text not null default 'not_started'
    constraint subject_topics_status_check check (status in (
      'not_started', 'learning', 'review', 'mastered'
    )),
  mastery int not null default 0
    constraint subject_topics_mastery_range check (mastery between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subject_topics is 'Topics within a subject with mastery/status. Owner-scoped by RLS; parent ownership re-checked in policies.';
comment on column public.subject_topics.mastery is '0–100 self+practice derived mastery. >=80 mastered/strong, 60-79 learning, 40-59 needs review, <40 weak.';

-- ---------------------------------------------------------------------------
-- 4. student_knowledge — per-topic knowledge state used by practice outcomes
-- ---------------------------------------------------------------------------
create table if not exists public.student_knowledge (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject_id uuid references public.subjects (id) on delete cascade,
  topic_id uuid references public.subject_topics (id) on delete cascade,
  strength_score int not null default 50
    constraint student_knowledge_strength_range check (strength_score between 0 and 100),
  confidence_score int not null default 50
    constraint student_knowledge_confidence_range check (confidence_score between 0 and 100),
  attempt_count int not null default 0
    constraint student_knowledge_attempts_nonneg check (attempt_count >= 0),
  correct_count int not null default 0
    constraint student_knowledge_correct_nonneg check (correct_count >= 0),
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.student_knowledge is 'Deterministic knowledge state (strength/confidence/attempts) per topic. Owner-scoped by RLS.';

-- One knowledge row per (user, topic); partial because topic_id is nullable.
create unique index if not exists student_knowledge_user_topic_key
  on public.student_knowledge (user_id, topic_id)
  where topic_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Row Level Security — every policy derives identity from auth.uid(),
--    never from client payloads. Parent ownership is re-verified so a user
--    can never attach rows to (or read via) another user's subject/topic.
-- ---------------------------------------------------------------------------

-- subjects -----------------------------------------------------------------
alter table public.subjects enable row level security;

drop policy if exists "subjects_select_own" on public.subjects;
create policy "subjects_select_own" on public.subjects
  for select using (auth.uid() = user_id);

drop policy if exists "subjects_insert_own" on public.subjects;
create policy "subjects_insert_own" on public.subjects
  for insert with check (auth.uid() = user_id);

drop policy if exists "subjects_update_own" on public.subjects;
create policy "subjects_update_own" on public.subjects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "subjects_delete_own" on public.subjects;
create policy "subjects_delete_own" on public.subjects
  for delete using (auth.uid() = user_id);

-- subject_topics -------------------------------------------------------------
alter table public.subject_topics enable row level security;

drop policy if exists "subject_topics_select_own" on public.subject_topics;
create policy "subject_topics_select_own" on public.subject_topics
  for select using (auth.uid() = user_id);

drop policy if exists "subject_topics_insert_own" on public.subject_topics;
create policy "subject_topics_insert_own" on public.subject_topics
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    )
  );

drop policy if exists "subject_topics_update_own" on public.subject_topics;
create policy "subject_topics_update_own" on public.subject_topics
  for update using (
    auth.uid() = user_id
    and exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    )
  ) with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    )
  );

drop policy if exists "subject_topics_delete_own" on public.subject_topics;
create policy "subject_topics_delete_own" on public.subject_topics
  for delete using (
    auth.uid() = user_id
    and exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    )
  );

-- student_knowledge ----------------------------------------------------------
alter table public.student_knowledge enable row level security;

drop policy if exists "student_knowledge_select_own" on public.student_knowledge;
create policy "student_knowledge_select_own" on public.student_knowledge
  for select using (auth.uid() = user_id);

drop policy if exists "student_knowledge_insert_own" on public.student_knowledge;
create policy "student_knowledge_insert_own" on public.student_knowledge
  for insert with check (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
  );

drop policy if exists "student_knowledge_update_own" on public.student_knowledge;
create policy "student_knowledge_update_own" on public.student_knowledge
  for update using (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
  ) with check (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
  );

drop policy if exists "student_knowledge_delete_own" on public.student_knowledge;
create policy "student_knowledge_delete_own" on public.student_knowledge
  for delete using (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
  );

-- ---------------------------------------------------------------------------
-- 6. Indexes — bounded queries stay cheap as data grows
-- ---------------------------------------------------------------------------
create index if not exists subjects_user_id_idx on public.subjects (user_id);
create index if not exists subjects_user_semester_idx on public.subjects (user_id, semester);

create index if not exists subject_topics_user_id_idx on public.subject_topics (user_id);
create index if not exists subject_topics_subject_id_idx on public.subject_topics (subject_id);
create index if not exists subject_topics_user_status_idx on public.subject_topics (user_id, status);

create index if not exists student_knowledge_user_id_idx on public.student_knowledge (user_id);
create index if not exists student_knowledge_subject_id_idx on public.student_knowledge (subject_id);
create index if not exists student_knowledge_topic_id_idx on public.student_knowledge (topic_id);
create index if not exists student_knowledge_user_updated_idx on public.student_knowledge (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- 7. updated_at maintenance — reuse the existing set_updated_at() function
-- ---------------------------------------------------------------------------
drop trigger if exists subjects_set_updated_at on public.subjects;
create trigger subjects_set_updated_at
  before update on public.subjects
  for each row execute function public.set_updated_at();

drop trigger if exists subject_topics_set_updated_at on public.subject_topics;
create trigger subject_topics_set_updated_at
  before update on public.subject_topics
  for each row execute function public.set_updated_at();

drop trigger if exists student_knowledge_set_updated_at on public.student_knowledge;
create trigger student_knowledge_set_updated_at
  before update on public.student_knowledge
  for each row execute function public.set_updated_at();
