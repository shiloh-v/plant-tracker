-- =============================================================================
-- Plant Tracker — Migration 004
-- Adds a structured `health` enum on plant_overrides. The AI photo analysis
-- writes this; the UI shows it as a colored badge and uses it (instead of
-- regex on status text) for theming and Attention filtering.
--
-- Enum values, in roughly severity order:
--   thriving      — going better than expected (⭐, sky blue)
--   healthy       — doing fine (green)
--   establishing  — newly planted/separated, building roots (🌱, purple)
--   watch         — minor concern, monitor (⚠, amber)
--   struggling    — real problems, intervention needed (orange)
--   critical      — likely to die without help (☠, red)
--
-- HOW TO RUN
-- 1. In Supabase → SQL Editor → paste this whole file → Run.
-- =============================================================================

alter table public.plant_overrides
  add column if not exists health text;

-- Enforce the enum; reject anything else
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'plant_overrides_health_check'
  ) then
    alter table public.plant_overrides
      add constraint plant_overrides_health_check
      check (health is null or health in (
        'thriving', 'healthy', 'establishing', 'watch', 'struggling', 'critical'
      ));
  end if;
end $$;

-- Refresh PostgREST schema cache so the new column is usable immediately
notify pgrst, 'reload schema';
