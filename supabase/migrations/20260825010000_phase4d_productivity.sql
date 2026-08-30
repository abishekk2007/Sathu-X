-- ============================================================================
-- Phase 4D: Student Productivity + Personalization
-- ============================================================================
-- Adds routine-preference columns to the existing profiles table.
-- No new tables: all productivity metrics are computed from existing
-- study_sessions, subject_topics, student_knowledge, exams, and study_goals.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Profile columns for routine preferences
-- ---------------------------------------------------------------------------

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS preferred_session_minutes int
    CHECK (preferred_session_minutes IS NULL OR (preferred_session_minutes >= 5 AND preferred_session_minutes <= 480));

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS preferred_break_minutes int
    CHECK (preferred_break_minutes IS NULL OR (preferred_break_minutes >= 0 AND preferred_break_minutes <= 120));

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS preferred_study_time text
    CHECK (preferred_study_time IS NULL OR length(preferred_study_time) <= 20);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS daily_study_target_minutes int
    CHECK (daily_study_target_minutes IS NULL OR (daily_study_target_minutes >= 0 AND daily_study_target_minutes <= 720));
