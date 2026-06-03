-- =============================================================================
-- Plant Tracker — Migration 001
-- Adds a `plants` table (so plants can be added/edited from the app, not code)
-- and locks down write access on plants / plant_overrides / plant-photos bucket
-- with a passphrase header.
--
-- HOW TO RUN
-- 1. In Supabase → SQL Editor → paste this whole file.
-- 2. Before running, search for `REPLACE_WITH_YOUR_PASSPHRASE` (3 occurrences
--    in the function below) and set it to a passphrase only you know.
--    Use something long-ish; nobody will type it on a keyboard.
-- 3. Run.
-- 4. Then open scripts/seed.html in your browser once to import the 95 plants
--    from the inline list. (Enter the same passphrase when prompted.)
-- 5. Done — the rewritten index.html will fetch plants from this table.
-- =============================================================================


-- ── plants table ──────────────────────────────────────────────────────────────
create table if not exists public.plants (
  id           text primary key,            -- keep your 'i01','o67' scheme
  name         text not null,
  sub          text,
  sci          text,
  type         text not null check (type in ('indoor','outdoor')),
  loc          text not null,
  pot          text,
  status       text,                        -- initial/seed status
  toxic        boolean not null default false,
  sort_order   int,                         -- nulls last; lower = earlier
  archived_at  timestamptz,                 -- soft-delete; null = active
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists plants_type_idx     on public.plants (type);
create index if not exists plants_loc_idx      on public.plants (loc);
create index if not exists plants_archived_idx on public.plants (archived_at);

-- Auto-bump updated_at on row update
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists plants_touch on public.plants;
create trigger plants_touch
  before update on public.plants
  for each row execute function public.touch_updated_at();


-- ── Passphrase gate ───────────────────────────────────────────────────────────
-- Returns true if the request includes the expected X-Plant-Key header.
-- The header is sent by the app's Supabase client (see index.html) and
-- forwarded by PostgREST into request.headers.
create or replace function public.plant_key_ok()
returns boolean
language sql
stable
as $$
  select coalesce(
    current_setting('request.headers', true)::json->>'x-plant-key',
    ''
  ) = 'REPLACE_WITH_YOUR_PASSPHRASE'
$$;


-- ── RLS: plants ───────────────────────────────────────────────────────────────
alter table public.plants enable row level security;

drop policy if exists plants_select on public.plants;
create policy plants_select on public.plants
  for select using (true);

drop policy if exists plants_insert on public.plants;
create policy plants_insert on public.plants
  for insert with check (public.plant_key_ok());

drop policy if exists plants_update on public.plants;
create policy plants_update on public.plants
  for update using (public.plant_key_ok()) with check (public.plant_key_ok());

drop policy if exists plants_delete on public.plants;
create policy plants_delete on public.plants
  for delete using (public.plant_key_ok());


-- ── RLS: plant_overrides ──────────────────────────────────────────────────────
-- This table already exists from your earlier work. We're just adding policies.
alter table public.plant_overrides enable row level security;

drop policy if exists plant_overrides_select on public.plant_overrides;
create policy plant_overrides_select on public.plant_overrides
  for select using (true);

drop policy if exists plant_overrides_insert on public.plant_overrides;
create policy plant_overrides_insert on public.plant_overrides
  for insert with check (public.plant_key_ok());

drop policy if exists plant_overrides_update on public.plant_overrides;
create policy plant_overrides_update on public.plant_overrides
  for update using (public.plant_key_ok()) with check (public.plant_key_ok());

drop policy if exists plant_overrides_delete on public.plant_overrides;
create policy plant_overrides_delete on public.plant_overrides
  for delete using (public.plant_key_ok());


-- ── RLS: storage.objects (plant-photos bucket) ────────────────────────────────
-- Public read so <img src> tags work without auth.
-- Writes (insert/update/delete) require the passphrase header.
drop policy if exists plant_photos_select on storage.objects;
create policy plant_photos_select on storage.objects
  for select using (bucket_id = 'plant-photos');

drop policy if exists plant_photos_insert on storage.objects;
create policy plant_photos_insert on storage.objects
  for insert with check (bucket_id = 'plant-photos' and public.plant_key_ok());

drop policy if exists plant_photos_update on storage.objects;
create policy plant_photos_update on storage.objects
  for update
  using       (bucket_id = 'plant-photos' and public.plant_key_ok())
  with check  (bucket_id = 'plant-photos' and public.plant_key_ok());

drop policy if exists plant_photos_delete on storage.objects;
create policy plant_photos_delete on storage.objects
  for delete using (bucket_id = 'plant-photos' and public.plant_key_ok());


-- ── Done. Run scripts/seed.html next. ────────────────────────────────────────
