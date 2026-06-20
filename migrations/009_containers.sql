-- =============================================================================
-- Plant Tracker — Migration 009
-- Adds a `containers` table so multi-plant homes (elevated planters, plant
-- stands, raised beds, shelves) can be tracked as a single entity with
-- their own photos, care timeline, and cadence. Individual plants
-- reference a container via plants.container_id.
--
-- Why: watering "Herb Planter" with 12 herbs in it should be ONE tap that
-- logs ONE event, not 12 separate water events. Same for taking a wide
-- photo of the whole plant stand vs N closeups.
--
-- Care model (chosen during design): container-only events drive child
-- plant due-status. When you tap "Water Herb Planter," one event is
-- logged on the container; each child plant's careStatus reads from
-- MAX(container's last water, plant's individual last water). Individual
-- per-plant care events still work for the "this one needs extra" case.
--
-- Backfill creates 3 containers from existing data:
--   Herb Planter — Elevated  — 12 plants currently at loc=Herb Planter — Elevated
--   Strawberry Planter — Elevated — 5 plants at loc=Strawberry Planter — Elevated
--   Plant Stand — Family Room with plants whose pot label ends in "(plant stand)"
--
-- HOW TO RUN
-- 1. In Supabase → SQL Editor → paste this whole file → Run.
-- =============================================================================

-- ── containers table ────────────────────────────────────────────────────────
create table if not exists public.containers (
  id                uuid primary key default gen_random_uuid(),
  label             text not null,
  kind              text not null default 'planter',  -- planter | stand | bed | shelf | other
  loc               text not null,                    -- physical location ("Family Room", "Back Patio")
  photo_ts          bigint,                           -- nullable; if set, photo exists at containers/<id>.jpg
  care_notes        text,                             -- durable instructions (light, watering style, etc.)
  notes             text,                             -- freeform / activity log
  water_every_days  int,                              -- cadence (nullable = no schedule)
  feed_every_days   int,                              -- cadence (nullable = no schedule)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  retired_at        timestamptz                       -- soft-archive (nullable = active)
);

create index if not exists containers_loc_idx        on public.containers (loc);
create index if not exists containers_retired_at_idx on public.containers (retired_at);

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'containers_kind_check'
  ) then
    alter table public.containers add constraint containers_kind_check
      check (kind in ('planter','stand','bed','shelf','other'));
  end if;
end $$;

-- Auto-bump updated_at on update (re-uses the trigger function from 001)
drop trigger if exists containers_touch on public.containers;
create trigger containers_touch
  before update on public.containers
  for each row execute function public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.containers enable row level security;

drop policy if exists containers_select on public.containers;
create policy containers_select on public.containers for select using (true);

drop policy if exists containers_insert on public.containers;
create policy containers_insert on public.containers for insert with check (public.plant_key_ok());

drop policy if exists containers_update on public.containers;
create policy containers_update on public.containers for update
  using (public.plant_key_ok()) with check (public.plant_key_ok());

drop policy if exists containers_delete on public.containers;
create policy containers_delete on public.containers for delete using (public.plant_key_ok());

-- ── Add container_id to plants ──────────────────────────────────────────────
alter table public.plants add column if not exists container_id uuid references public.containers(id) on delete set null;
create index if not exists plants_container_id_idx on public.plants (container_id);

-- ── care_events.container_id (nullable; either plant_id or container_id set) ─
alter table public.care_events add column if not exists container_id uuid references public.containers(id) on delete cascade;
create index if not exists care_events_container_id_idx on public.care_events (container_id);

-- Allow plant_id to be null when container_id is set (container-level event)
alter table public.care_events alter column plant_id drop not null;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- 1) Herb Planter — Elevated (single container, all 12 herbs)
do $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.plants where loc = 'Herb Planter — Elevated' and archived_at is null and deceased_at is null and container_id is null) then
    insert into public.containers (label, kind, loc, water_every_days, feed_every_days, care_notes)
    values ('Herb Planter — Elevated', 'planter', 'Herb Planter — Elevated', 3, 14,
            'Self-watering elevated planter with multiple herbs sharing one reservoir. Top up reservoir when low. Snip herbs regularly to encourage bushy growth.')
    returning id into v_id;
    update public.plants set container_id = v_id
      where loc = 'Herb Planter — Elevated' and archived_at is null and deceased_at is null and container_id is null;
  end if;
end $$;

-- 2) Strawberry Planter — Elevated (single container, all 5 strawberries)
do $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.plants where loc = 'Strawberry Planter — Elevated' and archived_at is null and deceased_at is null and container_id is null) then
    insert into public.containers (label, kind, loc, water_every_days, feed_every_days, care_notes)
    values ('Strawberry Planter — Elevated', 'planter', 'Strawberry Planter — Elevated', 3, 14,
            'Cedarcraft self-watering elevated planter. Multiple strawberry varieties sharing one reservoir. Top up reservoir when low.')
    returning id into v_id;
    update public.plants set container_id = v_id
      where loc = 'Strawberry Planter — Elevated' and archived_at is null and deceased_at is null and container_id is null;
  end if;
end $$;

-- 3) Plant Stand — Family Room (plants whose pot label contains "(plant stand)")
do $$
declare
  v_id uuid;
begin
  if exists (
    select 1 from public.plants
    where loc = 'Family Room' and archived_at is null and deceased_at is null
      and container_id is null and pot ilike '%(plant stand)%'
  ) then
    insert into public.containers (label, kind, loc, care_notes)
    values ('Plant Stand', 'stand', 'Family Room',
            'Multi-tiered plant stand in Family Room with assorted succulents and houseplants. Bright indirect light from nearby window.')
    returning id into v_id;
    update public.plants set container_id = v_id
      where loc = 'Family Room' and archived_at is null and deceased_at is null
        and container_id is null and pot ilike '%(plant stand)%';
  end if;
end $$;

notify pgrst, 'reload schema';
