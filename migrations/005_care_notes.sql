-- =============================================================================
-- Plant Tracker — Migration 005
-- Adds a care_notes field on plant_overrides for sticky care instructions
-- (temperature limits, watering style, safety reminders, USPP numbers, etc.)
-- that should NEVER be touched by the AI analysis.
--
-- Distinct from:
--   status      — current condition snapshot (AI replaces on each analysis)
--   notes       — chronological log of changes (AI appends to)
--   care_notes  — sticky instructions (only edited by user)
--
-- HOW TO RUN
-- 1. In Supabase → SQL Editor → paste this whole file → Run.
-- =============================================================================

alter table public.plant_overrides
  add column if not exists care_notes text;

-- Refresh PostgREST schema cache so the new column is usable immediately
notify pgrst, 'reload schema';
