-- =============================================================================
-- Plant Tracker — Migration 006
-- Adds a `deceased_at` timestamp on plants so plants that didn't survive can
-- be marked distinctly from `archived_at`. Archived = removed from rotation
-- (gifted, sold, intentionally retired). Deceased = died despite care, kept
-- for the historical record but excluded from active workflows.
--
-- App behavior when deceased_at is set:
-- - Hidden from All / Indoor / Outdoor / Attention tabs by default
-- - Shown in a "💀 Lost" filter chip
-- - Excluded from the weekly digest, verify sweeps, and analyze flows
-- - Care timeline + photos preserved for memorial / lessons-learned review
--
-- HOW TO RUN
-- 1. In Supabase → SQL Editor → paste this whole file → Run.
-- =============================================================================

alter table public.plants add column if not exists deceased_at timestamptz;

-- Refresh PostgREST schema cache so the new column is usable immediately
notify pgrst, 'reload schema';
