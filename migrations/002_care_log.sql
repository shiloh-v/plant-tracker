-- =============================================================================
-- Plant Tracker — Migration 002
-- Adds a care_events log (watering, feeding, repotting, etc.) and cadence
-- fields on plants for computing "due in N days".
--
-- HOW TO RUN
-- 1. In Supabase → SQL Editor → paste this whole file → Run.
-- 2. Done — the app picks up the new table on next load.
-- =============================================================================


-- ── care_events ───────────────────────────────────────────────────────────────
create table if not exists public.care_events (
  id          uuid primary key default gen_random_uuid(),
  plant_id    text not null references public.plants(id) on delete cascade,
  kind        text not null check (kind in ('water','feed','repot','prune','inspect','other')),
  occurred_at timestamptz not null default now(),
  notes       text,
  created_at  timestamptz not null default now()
);

create index if not exists care_events_plant_idx  on public.care_events (plant_id, occurred_at desc);
create index if not exists care_events_recent_idx on public.care_events (occurred_at desc);


-- ── Cadence fields on plants ─────────────────────────────────────────────────
-- NULL means "no schedule" — plant only shows up in "needs attention" if
-- status flags it. A number means "after N days since last event of that kind,
-- consider it due."
alter table public.plants add column if not exists water_every_days int;
alter table public.plants add column if not exists feed_every_days  int;


-- ── RLS: care_events ──────────────────────────────────────────────────────────
-- Read public (so the app can render last-watered without auth); writes gated
-- by the same passphrase header as plants / plant_overrides.
alter table public.care_events enable row level security;

drop policy if exists care_events_select on public.care_events;
create policy care_events_select on public.care_events
  for select using (true);

drop policy if exists care_events_insert on public.care_events;
create policy care_events_insert on public.care_events
  for insert with check (public.plant_key_ok());

drop policy if exists care_events_update on public.care_events;
create policy care_events_update on public.care_events
  for update using (public.plant_key_ok()) with check (public.plant_key_ok());

drop policy if exists care_events_delete on public.care_events;
create policy care_events_delete on public.care_events
  for delete using (public.plant_key_ok());


-- ── Done. ────────────────────────────────────────────────────────────────────
