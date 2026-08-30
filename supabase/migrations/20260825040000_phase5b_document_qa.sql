-- Spidey Bot — Phase 5B: document extraction + document-grounded Q&A
-- Apply via Supabase Dashboard → SQL Editor.
--
-- Safe to run multiple times (idempotent). Never drops tables or data:
--   * adds extraction columns to public.documents
--   * creates public.document_chunks for searchable text segments
--   * enables RLS with owner-scoped policies
--   * reuses the existing public.set_updated_at() trigger function
--
-- Nothing here touches conversations, messages, memories, subjects, topics, or auth.

-- ---------------------------------------------------------------------------
-- 1. Extend documents table with extraction metadata
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'extracted_text'
  ) THEN
    ALTER TABLE public.documents ADD COLUMN extracted_text text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'extracted_text_length'
  ) THEN
    ALTER TABLE public.documents ADD COLUMN extracted_text_length integer;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'processed_at'
  ) THEN
    ALTER TABLE public.documents ADD COLUMN processed_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'processing_error'
  ) THEN
    ALTER TABLE public.documents ADD COLUMN processing_error text;
  END IF;
END $$;

COMMENT ON COLUMN public.documents.extracted_text IS 'Full extracted text from the document. Used for chunking — not sent to Gemini directly.';
COMMENT ON COLUMN public.documents.extracted_text_length IS 'Character count of extracted_text.';
COMMENT ON COLUMN public.documents.processed_at IS 'Timestamp when extraction completed successfully.';
COMMENT ON COLUMN public.documents.processing_error IS 'Human-readable error message when processing fails. Null on success.';

-- ---------------------------------------------------------------------------
-- 2. document_chunks — searchable text segments for retrieval
-- ---------------------------------------------------------------------------
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  page_number integer,
  char_count integer not null,
  created_at timestamptz not null default now(),
  constraint document_chunks_content_not_empty check (length(btrim(content)) > 0),
  constraint document_chunks_chunk_index_positive check (chunk_index >= 0)
);

comment on table public.document_chunks is 'Searchable text segments extracted from user documents. Owner-scoped by RLS. Used for deterministic retrieval in document-grounded Q&A.';

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
create index if not exists document_chunks_document_id_idx on public.document_chunks (document_id);
create index if not exists document_chunks_user_id_idx on public.document_chunks (user_id);
create index if not exists document_chunks_doc_index_idx on public.document_chunks (document_id, chunk_index);

-- ---------------------------------------------------------------------------
-- 4. RLS — owner-scoped; chunks inherit document ownership
-- ---------------------------------------------------------------------------
alter table public.document_chunks enable row level security;

drop policy if exists "document_chunks_select_own" on public.document_chunks;
create policy "document_chunks_select_own" on public.document_chunks
  for select using (auth.uid() = user_id);

drop policy if exists "document_chunks_insert_own" on public.document_chunks;
create policy "document_chunks_insert_own" on public.document_chunks
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.documents d
      where d.id = document_id and d.user_id = auth.uid()
    )
  );

drop policy if exists "document_chunks_delete_own" on public.document_chunks;
create policy "document_chunks_delete_own" on public.document_chunks
  for delete using (auth.uid() = user_id);
