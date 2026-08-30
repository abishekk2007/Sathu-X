-- ============================================================================
-- Phase 5A — Agentic Chat Core: context_sources table
-- Stores pasted text and image metadata as first-class context sources.
-- ============================================================================

-- Guard: only create if not already present
CREATE TABLE IF NOT EXISTS context_sources (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('pasted_text', 'image')),
  name       TEXT,
  content_text TEXT,
  metadata   JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for listing a user's recent sources
CREATE INDEX IF NOT EXISTS idx_context_sources_user_created
  ON context_sources (user_id, created_at DESC);

-- RLS: users can only access their own sources
ALTER TABLE context_sources ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-applying (idempotent)
DROP POLICY IF EXISTS "context_sources_select_own" ON context_sources;
DROP POLICY IF EXISTS "context_sources_insert_own" ON context_sources;
DROP POLICY IF EXISTS "context_sources_update_own" ON context_sources;
DROP POLICY IF EXISTS "context_sources_delete_own" ON context_sources;

CREATE POLICY "context_sources_select_own"
  ON context_sources FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "context_sources_insert_own"
  ON context_sources FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "context_sources_update_own"
  ON context_sources FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "context_sources_delete_own"
  ON context_sources FOR DELETE
  USING (auth.uid() = user_id);

-- Storage bucket for uploaded images (context-sources)
-- NOTE: This must be created manually in Supabase Dashboard if not present:
--   create bucket 'context-sources' with public = false
