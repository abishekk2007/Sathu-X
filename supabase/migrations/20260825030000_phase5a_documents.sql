-- Spidey Bot — Phase 5A: document upload & management foundation
-- Apply via Supabase Dashboard → SQL Editor.
--
-- Safe to run multiple times (idempotent). Never drops tables or data:
--   * creates NEW public.documents table
--   * creates private 'documents' storage bucket
--   * enables RLS with owner-scoped policies + parent-ownership checks
--   * reuses the existing public.set_updated_at() trigger function
--
-- Nothing here touches conversations, messages, memories, subjects, topics, or auth.

-- ---------------------------------------------------------------------------
-- 1. documents — metadata for files stored in Supabase Storage
-- ---------------------------------------------------------------------------
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject_id uuid references public.subjects (id) on delete set null,
  topic_id uuid references public.subject_topics (id) on delete set null,
  name text not null
    constraint documents_name_not_empty check (length(btrim(name)) between 1 and 255),
  original_filename text not null
    constraint documents_original_filename_len check (length(original_filename) between 1 and 500),
  storage_path text not null unique,
  mime_type text not null
    constraint documents_mime_type_check check (mime_type in (
      'application/pdf',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/markdown'
    )),
  file_size_bytes bigint not null
    constraint documents_file_size_positive check (file_size_bytes > 0),
  status text not null default 'uploaded'
    constraint documents_status_check check (status in (
      'uploaded', 'processing', 'ready', 'failed', 'deleted'
    )),
  processing_status text not null default 'pending'
    constraint documents_processing_status_check check (processing_status in (
      'pending', 'extracting', 'chunking', 'embedding', 'ready', 'failed'
    )),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.documents is 'User-uploaded documents. Files stored in private Supabase Storage bucket; metadata lives here. Owner-scoped by RLS.';
comment on column public.documents.storage_path is 'Path in the documents storage bucket: {user_id}/{document_id}/{sanitized_filename}';
comment on column public.documents.status is 'Document lifecycle: uploaded → processing → ready | failed. 5A sets uploaded.';
comment on column public.documents.processing_status is 'Extraction pipeline: pending → extracting → chunking → embedding → ready | failed. 5A sets pending.';

-- ---------------------------------------------------------------------------
-- 2. Indexes — bounded queries stay cheap as data grows
-- ---------------------------------------------------------------------------
create index if not exists documents_user_id_idx on public.documents (user_id);
create index if not exists documents_user_created_idx on public.documents (user_id, created_at desc);
create index if not exists documents_subject_id_idx on public.documents (subject_id);
create index if not exists documents_topic_id_idx on public.documents (topic_id);
create index if not exists documents_status_idx on public.documents (user_id, status);

-- ---------------------------------------------------------------------------
-- 3. updated_at maintenance — reuse the existing set_updated_at() function
-- ---------------------------------------------------------------------------
drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Row Level Security — owner-scoped; parent ownership re-checked
-- ---------------------------------------------------------------------------
alter table public.documents enable row level security;

drop policy if exists "documents_select_own" on public.documents;
create policy "documents_select_own" on public.documents
  for select using (auth.uid() = user_id);

drop policy if exists "documents_insert_own" on public.documents;
create policy "documents_insert_own" on public.documents
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

drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own" on public.documents
  for update using (auth.uid() = user_id) with check (
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

drop policy if exists "documents_delete_own" on public.documents;
create policy "documents_delete_own" on public.documents
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 5. Private storage bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('documents', 'documents', false)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Storage policies — user-scoped access under documents/{user_id}/*
-- ---------------------------------------------------------------------------

drop policy if exists "documents_storage_select_own" on storage.objects;
create policy "documents_storage_select_own" on storage.objects
  for select using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "documents_storage_insert_own" on storage.objects;
create policy "documents_storage_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "documents_storage_delete_own" on storage.objects;
create policy "documents_storage_delete_own" on storage.objects
  for delete using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
