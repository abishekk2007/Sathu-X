-- Spidey Bot — one-time welcome email tracking
-- ---------------------------------------------------------------------------
-- Adds the tracking fields to the EXISTING public.profiles table (reuses the
-- Phase 3 profiles row for auth identity — no new table).
--
-- Safe to run multiple times (idempotent):
--   * ALTER ... ADD COLUMN IF NOT EXISTS
--   * one-shot UPDATE backfill marks PRE-EXISTING profiles as already sent so
--     long-time users are NOT emailed when the feature ships.
--
-- Ownership of the profile row remains auth.uid()-bound via the existing RLS
-- policies (profiles_select_own / profiles_update_own). The welcome-email Edge
-- Function acts as the authenticated user and only ever touches the caller's
-- own row, so no elevated permissions are introduced here.

-- 1. Tracking columns (default false => new signups start "not emailed").
alter table public.profiles
  add column if not exists welcome_email_sent boolean not null default false;

alter table public.profiles
  add column if not exists welcome_email_sent_at timestamptz;

comment on column public.profiles.welcome_email_sent is
  'One-time welcome email guard. True once the email has been claimed or sent.';
comment on column public.profiles.welcome_email_sent_at is
  'Moment delivery succeeded. Null while unsent or in-flight.';

-- 2. Backfill: users who already exist must NEVER receive the welcome email.
--    Only rows inserted after this migration (brand-new signups, flag=false)
--    are eligible for the one-time email.
update public.profiles
set welcome_email_sent = true,
    welcome_email_sent_at = now()
where welcome_email_sent = false
  and welcome_email_sent_at is null;