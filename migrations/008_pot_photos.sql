-- =============================================================================
-- Plant Tracker — Migration 008
-- Adds a `photo_ts` column to the pots table so each pot can have one photo.
-- Photos are stored in the same plant-photos bucket under pots/<pot-id>.jpg
-- (the existing RLS policy on storage.objects already covers any path
-- inside that bucket — no separate bucket needed).
--
-- The column doubles as a "has photo?" flag (null = no photo) and a
-- cache-buster (the timestamp gets appended to image URLs so an updated
-- photo bypasses browser caching).
--
-- HOW TO RUN
-- 1. In Supabase → SQL Editor → paste this whole file → Run.
-- =============================================================================

alter table public.pots add column if not exists photo_ts bigint;

notify pgrst, 'reload schema';
