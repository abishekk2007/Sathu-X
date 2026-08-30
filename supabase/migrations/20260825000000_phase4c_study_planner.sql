-- Spidey Bot — Phase 4C: study planner + exam system
-- Apply via Supabase Dashboard → SQL Editor.
--
-- Safe to run multiple times (idempotent). Never drops tables or data:
--   * creates NEW public.exams / public.study_plans / public.study_sessions /
--     public.study_goals (Phase 4A/4B tables are untouched)
--   * enables RLS on the new tables with strict owner + parent-ownership checks
--   * creates the indexes listed in the Phase 4C spec
--   * reuses the existing public.set_updated_at() trigger function
--
-- Nothing here touches conversations, messages, memories, subjects, topics,
-- knowledge, or auth.

-- ---------------------------------------------------------------------------
-- 1. exams — one row per exam the user prepares for
-- ---------------------------------------------------------------------------
create table if not exists public.exams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject_id uuid references public.subjects (id) on delete set null,
  title text not null
    constraint exams_title_not_empty check (length(btrim(title)) between 1 and 200),
  exam_date timestamptz not null,
  exam_type text not null default 'semester'
    constraint exams_type_check check (exam_type in (
      'semester', 'internal', 'unit_test', 'practical', 'assignment', 'other'
    )),
  description text
    constraint exams_description_len check (char_length(description) <= 1000),
  target_score int
    constraint exams_target_range check (target_score between 0 and 100),
  priority int not null default 3
    constraint exams_priority_range check (priority between 1 and 5),
  status text not null default 'upcoming'
    constraint exams_status_check check (status in (
      'upcoming', 'in_progress', 'completed', 'cancelled'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.exams is 'Exams a user prepares for. Owner-scoped by RLS; identity always from auth.uid().';
comment on column public.exams.exam_date is 'Exam instant as timestamptz. Countdowns are computed client-side in the user''s local timezone.';

-- ---------------------------------------------------------------------------
-- 2. study_plans — a named preparation window with daily capacity
-- ---------------------------------------------------------------------------
create table if not exists public.study_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null
    constraint study_plans_name_not_empty check (length(btrim(name)) between 1 and 160),
  description text
    constraint study_plans_description_len check (char_length(description) <= 1000),
  start_date date not null,
  end_date date not null
    constraint study_plans_date_order check (end_date >= start_date),
  daily_minutes int not null default 60
    constraint study_plans_daily_minutes_positive check (daily_minutes > 0),
  status text not null default 'active'
    constraint study_plans_status_check check (status in (
      'draft', 'active', 'completed', 'paused', 'archived'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.study_plans is 'Study plans: a date window plus daily minutes budget. Sessions hang off plans via study_sessions.study_plan_id.';

-- ---------------------------------------------------------------------------
-- 3. study_sessions — one schedulable block of study work
-- ---------------------------------------------------------------------------
create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  study_plan_id uuid references public.study_plans (id) on delete cascade,
  subject_id uuid references public.subjects (id) on delete set null,
  topic_id uuid references public.subject_topics (id) on delete set null,
  exam_id uuid references public.exams (id) on delete set null,
  scheduled_date date not null,
  start_time time,
  duration_minutes int not null default 30
    constraint study_sessions_duration_positive check (duration_minutes between 5 and 480),
  session_type text not null default 'study'
    constraint study_sessions_type_check check (session_type in (
      'study', 'revision', 'practice', 'mock_test', 'review'
    )),
  status text not null default 'planned'
    constraint study_sessions_status_check check (status in (
      'planned', 'in_progress', 'completed', 'skipped', 'cancelled'
    )),
  notes text
    constraint study_sessions_notes_len check (char_length(notes) <= 1000),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.study_sessions is 'Study sessions (planned/completed blocks). Parent ownership re-checked in policies so cross-user references are impossible.';
comment on column public.study_sessions.completed_at is 'Set once when the session first transitions to completed; never double-counted.';

-- ---------------------------------------------------------------------------
-- 4. study_goals — minute-based targets ("study 600 min this week")
-- ---------------------------------------------------------------------------
create table if not exists public.study_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null
    constraint study_goals_title_not_empty check (length(btrim(title)) between 1 and 160),
  description text
    constraint study_goals_description_len check (char_length(description) <= 1000),
  target_date date,
  target_minutes int
    constraint study_goals_target_minutes_positive check (target_minutes is null or target_minutes > 0),
  completed_minutes int not null default 0
    constraint study_goals_completed_nonneg check (completed_minutes >= 0),
  status text not null default 'active'
    constraint study_goals_status_check check (status in (
      'active', 'completed', 'paused', 'cancelled'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.study_goals is 'Study goals. completed_minutes is maintained on session completion transitions; APIs also recompute progress from real completed sessions at read time.';

-- ---------------------------------------------------------------------------
-- 5. Row Level Security — every policy derives identity from auth.uid().
--    Child rows re-verify parent ownership so a user can never attach to (or
--    read through) another user's subject/topic/exam/plan.
-- ---------------------------------------------------------------------------

-- exams ---------------------------------------------------------------------
alter table public.exams enable row level security;

drop policy if exists "exams_select_own" on public.exams;
create policy "exams_select_own" on public.exams
  for select using (auth.uid() = user_id);

drop policy if exists "exams_insert_own" on public.exams;
create policy "exams_insert_own" on public.exams
  for insert with check (
    auth.uid() = user_id
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
  );

drop policy if exists "exams_update_own" on public.exams;
create policy "exams_update_own" on public.exams
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

drop policy if exists "exams_delete_own" on public.exams;
create policy "exams_delete_own" on public.exams
  for delete using (auth.uid() = user_id);

-- study_plans ---------------------------------------------------------------
alter table public.study_plans enable row level security;

drop policy if exists "study_plans_select_own" on public.study_plans;
create policy "study_plans_select_own" on public.study_plans
  for select using (auth.uid() = user_id);

drop policy if exists "study_plans_insert_own" on public.study_plans;
create policy "study_plans_insert_own" on public.study_plans
  for insert with check (auth.uid() = user_id);

drop policy if exists "study_plans_update_own" on public.study_plans;
create policy "study_plans_update_own" on public.study_plans
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "study_plans_delete_own" on public.study_plans;
create policy "study_plans_delete_own" on public.study_plans
  for delete using (auth.uid() = user_id);

-- study_sessions ------------------------------------------------------------
alter table public.study_sessions enable row level security;

drop policy if exists "study_sessions_select_own" on public.study_sessions;
create policy "study_sessions_select_own" on public.study_sessions
  for select using (auth.uid() = user_id);

drop policy if exists "study_sessions_insert_own" on public.study_sessions;
create policy "study_sessions_insert_own" on public.study_sessions
  for insert with check (
    auth.uid() = user_id
    and (study_plan_id is null or exists (
      select 1 from public.study_plans p
      where p.id = study_plan_id and p.user_id = auth.uid()
    ))
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
    and (exam_id is null or exists (
      select 1 from public.exams e
      where e.id = exam_id and e.user_id = auth.uid()
    ))
  );

drop policy if exists "study_sessions_update_own" on public.study_sessions;
create policy "study_sessions_update_own" on public.study_sessions
  for update using (
    auth.uid() = user_id
    and (study_plan_id is null or exists (
      select 1 from public.study_plans p
      where p.id = study_plan_id and p.user_id = auth.uid()
    ))
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
    and (exam_id is null or exists (
      select 1 from public.exams e
      where e.id = exam_id and e.user_id = auth.uid()
    ))
  ) with check (
    auth.uid() = user_id
    and (study_plan_id is null or exists (
      select 1 from public.study_plans p
      where p.id = study_plan_id and p.user_id = auth.uid()
    ))
    and (subject_id is null or exists (
      select 1 from public.subjects s
      where s.id = subject_id and s.user_id = auth.uid()
    ))
    and (topic_id is null or exists (
      select 1 from public.subject_topics t
      where t.id = topic_id and t.user_id = auth.uid()
    ))
    and (exam_id is null or exists (
      select 1 from public.exams e
      where e.id = exam_id and e.user_id = auth.uid()
    ))
  );

drop policy if exists "study_sessions_delete_own" on public.study_sessions;
create policy "study_sessions_delete_own" on public.study_sessions
  for delete using (auth.uid() = user_id);

-- study_goals ---------------------------------------------------------------
alter table public.study_goals enable row level security;

drop policy if exists "study_goals_select_own" on public.study_goals;
create policy "study_goals_select_own" on public.study_goals
  for select using (auth.uid() = user_id);

drop policy if exists "study_goals_insert_own" on public.study_goals;
create policy "study_goals_insert_own" on public.study_goals
  for insert with check (auth.uid() = user_id);

drop policy if exists "study_goals_update_own" on public.study_goals;
create policy "study_goals_update_own" on public.study_goals
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "study_goals_delete_own" on public.study_goals;
create policy "study_goals_delete_own" on public.study_goals
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 6. Indexes — bounded queries stay cheap as data grows
-- ---------------------------------------------------------------------------
create index if not exists exams_user_id_idx on public.exams (user_id);
create index if not exists exams_user_date_idx on public.exams (user_id, exam_date);
create index if not exists exams_subject_id_idx on public.exams (subject_id);

create index if not exists study_plans_user_id_idx on public.study_plans (user_id);
create index if not exists study_plans_user_status_idx on public.study_plans (user_id, status);

create index if not exists study_sessions_user_id_idx on public.study_sessions (user_id);
create index if not exists study_sessions_plan_id_idx on public.study_sessions (study_plan_id);
create index if not exists study_sessions_scheduled_date_idx on public.study_sessions (scheduled_date);
create index if not exists study_sessions_user_date_idx on public.study_sessions (user_id, scheduled_date);

create index if not exists study_goals_user_id_idx on public.study_goals (user_id);
create index if not exists study_goals_user_status_idx on public.study_goals (user_id, status);

-- ---------------------------------------------------------------------------
-- 7. updated_at maintenance — reuse the existing set_updated_at() function
-- ---------------------------------------------------------------------------
drop trigger if exists exams_set_updated_at on public.exams;
create trigger exams_set_updated_at
  before update on public.exams
  for each row execute function public.set_updated_at();

drop trigger if exists study_plans_set_updated_at on public.study_plans;
create trigger study_plans_set_updated_at
  before update on public.study_plans
  for each row execute function public.set_updated_at();

drop trigger if exists study_sessions_set_updated_at on public.study_sessions;
create trigger study_sessions_set_updated_at
  before update on public.study_sessions
  for each row execute function public.set_updated_at();

drop trigger if exists study_goals_set_updated_at on public.study_goals;
create trigger study_goals_set_updated_at
  before update on public.study_goals
  for each row execute function public.set_updated_at();
