-- Spidey Bot — Phase 6G: tasks + planning
-- Apply via Supabase Dashboard → SQL Editor (or `supabase db push`).
--
-- Safe to run multiple times (idempotent). Never drops tables or data:
--   * creates NEW public.tasks / public.plans / public.plan_steps
--   * enables RLS with strict owner checks (identity ALWAYS from auth.uid())
--   * plan_steps re-verifies plan ownership AND task ownership so cross-user
--     references are impossible by construction
--   * reuses the existing public.set_updated_at() trigger function
--
-- Nothing here touches conversations, messages, memories, documents, exams,
-- study plans, subjects, topics, or auth.

-- ---------------------------------------------------------------------------
-- 1. tasks — one row per actionable item (chat- or ui-created)
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null
    constraint tasks_title_not_empty check (length(btrim(title)) between 1 and 200),
  description text
    constraint tasks_description_len check (char_length(description) <= 1000),
  status text not null default 'pending'
    constraint tasks_status_check check (status in (
      'pending', 'in_progress', 'completed', 'cancelled', 'failed'
    )),
  priority text not null default 'medium'
    constraint tasks_priority_check check (priority in ('high', 'medium', 'low')),
  category text not null default 'General'
    constraint tasks_category_len check (char_length(category) between 1 and 50),
  due_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  recurrence text not null default 'none'
    constraint tasks_recurrence_check check (recurrence in ('none', 'daily', 'weekly', 'monthly')),
  tags text[] not null default '{}',
  source text not null default 'ui'
    constraint tasks_source_check check (source in ('chat', 'ui', 'plan')),
  plan_id uuid references public.plans (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tasks is 'Owner-scoped tasks. user_id is NEVER written by the app — RLS derives it from auth.uid().';
comment on column public.tasks.due_at is 'Instant as timestamptz; the client renders it in the user''s local timezone.';
comment on column public.tasks.recurrence is 'Closed set: none | daily | weekly | monthly. next-due is computed at read time from due_at.';

-- ---------------------------------------------------------------------------
-- 2. plans — a named objective decomposed into ordered, dependent steps
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null
    constraint plans_title_not_empty check (length(btrim(title)) between 1 and 200),
  objective text not null
    constraint plans_objective_len check (length(btrim(objective)) between 1 and 1000),
  description text
    constraint plans_description_len check (char_length(description) <= 1000),
  status text not null default 'active'
    constraint plans_status_check check (status in ('active', 'completed', 'cancelled')),
  due_at timestamptz,
  source text not null default 'chat'
    constraint plans_source_check check (source in ('chat', 'ui')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.plans is 'Structured plans. Planning and execution are separate: creating a plan never marks steps done.';

-- ---------------------------------------------------------------------------
-- 3. plan_steps — an ordered step inside a plan (dependency-aware)
-- ---------------------------------------------------------------------------
create table if not exists public.plan_steps (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null
    constraint plan_steps_title_not_empty check (length(btrim(title)) between 1 and 300),
  description text
    constraint plan_steps_description_len check (char_length(description) <= 1000),
  position int not null default 1
    constraint plan_steps_position_positive check (position > 0),
  status text not null default 'pending'
    constraint plan_steps_status_check check (status in (
      'pending', 'in_progress', 'completed', 'cancelled'
    )),
  depends_on uuid[] not null default '{}',
  task_id uuid references public.tasks (id) on delete set null,
  estimated_minutes int
    constraint plan_steps_estimate_range check (estimated_minutes is null or estimated_minutes between 1 and 1440),
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.plan_steps is 'Ordered steps. depends_on references sibling ids (validated app-side); deterministically pending until dependencies complete.';

-- ---------------------------------------------------------------------------
-- 4. Row Level Security — owner-scoped; plan_steps re-verifies parent+task.
-- ---------------------------------------------------------------------------

-- tasks ----------------------------------------------------------------------
alter table public.tasks enable row level security;

drop policy if exists "tasks_select_own" on public.tasks;
create policy "tasks_select_own" on public.tasks
  for select using (auth.uid() = user_id);

drop policy if exists "tasks_insert_own" on public.tasks;
create policy "tasks_insert_own" on public.tasks
  for insert with check (
    auth.uid() = user_id
    and (plan_id is null or exists (
      select 1 from public.plans p
      where p.id = plan_id and p.user_id = auth.uid()
    ))
  );

drop policy if exists "tasks_update_own" on public.tasks;
create policy "tasks_update_own" on public.tasks
  for update using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (plan_id is null or exists (
      select 1 from public.plans p
      where p.id = plan_id and p.user_id = auth.uid()
    ))
  );

drop policy if exists "tasks_delete_own" on public.tasks;
create policy "tasks_delete_own" on public.tasks
  for delete using (auth.uid() = user_id);

-- plans ----------------------------------------------------------------------
alter table public.plans enable row level security;

drop policy if exists "plans_select_own" on public.plans;
create policy "plans_select_own" on public.plans
  for select using (auth.uid() = user_id);

drop policy if exists "plans_insert_own" on public.plans;
create policy "plans_insert_own" on public.plans
  for insert with check (auth.uid() = user_id);

drop policy if exists "plans_update_own" on public.plans;
create policy "plans_update_own" on public.plans
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "plans_delete_own" on public.plans;
create policy "plans_delete_own" on public.plans
  for delete using (auth.uid() = user_id);

-- plan_steps -----------------------------------------------------------------
alter table public.plan_steps enable row level security;

drop policy if exists "plan_steps_select_own" on public.plan_steps;
create policy "plan_steps_select_own" on public.plan_steps
  for select using (auth.uid() = user_id);

drop policy if exists "plan_steps_insert_own" on public.plan_steps;
create policy "plan_steps_insert_own" on public.plan_steps
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.plans p
      where p.id = plan_id and p.user_id = auth.uid()
    )
    and (task_id is null or exists (
      select 1 from public.tasks t
      where t.id = task_id and t.user_id = auth.uid()
    ))
  );

drop policy if exists "plan_steps_update_own" on public.plan_steps;
create policy "plan_steps_update_own" on public.plan_steps
  for update using (
    auth.uid() = user_id
    and exists (
      select 1 from public.plans p
      where p.id = plan_id and p.user_id = auth.uid()
    )
  ) with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.plans p
      where p.id = plan_id and p.user_id = auth.uid()
    )
    and (task_id is null or exists (
      select 1 from public.tasks t
      where t.id = task_id and t.user_id = auth.uid()
    ))
  );

drop policy if exists "plan_steps_delete_own" on public.plan_steps;
create policy "plan_steps_delete_own" on public.plan_steps
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 5. Indexes — bounded lists stay cheap as data grows
-- ---------------------------------------------------------------------------
create index if not exists tasks_user_id_idx on public.tasks (user_id);
create index if not exists tasks_user_status_idx on public.tasks (user_id, status);
create index if not exists tasks_user_due_idx on public.tasks (user_id, due_at);

create index if not exists plans_user_id_idx on public.plans (user_id);
create index if not exists plans_user_status_idx on public.plans (user_id, status);

create index if not exists plan_steps_user_id_idx on public.plan_steps (user_id);
create index if not exists plan_steps_plan_id_idx on public.plan_steps (plan_id);
create index if not exists plan_steps_plan_position_idx on public.plan_steps (plan_id, position);

-- ---------------------------------------------------------------------------
-- 6. updated_at maintenance — reuse the existing set_updated_at() function
-- ---------------------------------------------------------------------------
drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

drop trigger if exists plans_set_updated_at on public.plans;
create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

drop trigger if exists plan_steps_set_updated_at on public.plan_steps;
create trigger plan_steps_set_updated_at
  before update on public.plan_steps
  for each row execute function public.set_updated_at();