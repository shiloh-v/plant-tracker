-- =============================================================================
-- Plant Tracker — Migration 003
-- Adds a seasonal_care flag on plants for species whose water/feed needs
-- change meaningfully with the seasons (succulents in winter, deciduous
-- plants, etc). The app surfaces a small banner in the care section when
-- this is true so the user remembers to revisit cadences in fall.
--
-- HOW TO RUN
-- 1. In Supabase → SQL Editor → paste this whole file → Run.
-- =============================================================================

alter table public.plants add column if not exists seasonal_care boolean not null default false;

-- Refresh PostgREST schema cache so the new column is usable immediately
notify pgrst, 'reload schema';
