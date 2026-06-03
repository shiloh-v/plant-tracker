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
-- Defined column-by-column with ADD COLUMN IF NOT EXISTS so this is safe to
-- run whether the table is new, missing, or partially set up from earlier.
create table if not exists public.plants (id text primary key);

alter table public.plants add column if not exists name        text;
alter table public.plants add column if not exists sub         text;
alter table public.plants add column if not exists sci         text;
alter table public.plants add column if not exists type        text;
alter table public.plants add column if not exists loc         text;
alter table public.plants add column if not exists pot         text;
alter table public.plants add column if not exists status      text;
alter table public.plants add column if not exists toxic       boolean not null default false;
alter table public.plants add column if not exists sort_order  int;
alter table public.plants add column if not exists archived_at timestamptz;
alter table public.plants add column if not exists created_at  timestamptz not null default now();
alter table public.plants add column if not exists updated_at  timestamptz not null default now();

-- Make name/type/loc required, and constrain type values
alter table public.plants alter column name set not null;
alter table public.plants alter column type set not null;
alter table public.plants alter column loc  set not null;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'plants_type_check'
  ) then
    alter table public.plants add constraint plants_type_check check (type in ('indoor','outdoor'));
  end if;
end $$;

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
