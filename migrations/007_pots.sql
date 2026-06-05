-- =============================================================================
-- Plant Tracker — Migration 007
-- Adds a `pots` table — proper inventory of every container you own (or have
-- owned), separate from the plants that occupy them. Plants still reference
-- pots by free-text Container string; the pots table is the ledger.
--
-- Schema:
--   label           — human-readable name ("White ceramic 6-inch")
--   acquired_at     — when you got it (defaults to now; editable)
--   retired_at      — when you got rid of it (null = still in inventory)
--   retired_reason  — optional why ("broken", "gave away with plant", etc.)
--   notes           — freeform
--
-- Backfill: pulls distinct non-empty pot strings from the existing plants
-- table and inserts a row for each, using the earliest matching plant's
-- created_at as the acquired date.
--
-- HOW TO RUN
-- 1. In Supabase → SQL Editor → paste this whole file → Run.
-- =============================================================================

create table if not exists public.pots (
  id              uuid primary key default gen_random_uuid(),
  label           text not null,
  acquired_at     timestamptz not null default now(),
  retired_at      timestamptz,
  retired_reason  text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Partial unique index — duplicate labels are fine across history (you can
-- retire one "6-inch terracotta" then buy a new one) but not at the same time.
create unique index if not exists pots_label_unique_active
  on public.pots (lower(label))
  where retired_at is null;

create index if not exists pots_retired_idx on public.pots (retired_at);

-- Auto-bump updated_at on update (re-uses the trigger function from 001)
drop trigger if exists pots_touch on public.pots;
create trigger pots_touch
  before update on public.pots
  for each row execute function public.touch_updated_at();

-- ── RLS: same pattern as plants ──────────────────────────────────────────────
alter table public.pots enable row level security;

drop policy if exists pots_select on public.pots;
create policy pots_select on public.pots for select using (true);

drop policy if exists pots_insert on public.pots;
create policy pots_insert on public.pots for insert with check (public.plant_key_ok());

drop policy if exists pots_update on public.pots;
create policy pots_update on public.pots for update
  using (public.plant_key_ok()) with check (public.plant_key_ok());

drop policy if exists pots_delete on public.pots;
create policy pots_delete on public.pots for delete using (public.plant_key_ok());

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Insert distinct non-empty pot strings from plants. For each, use the
-- earliest created_at across plants with that label so the inventory
-- "acquired" date roughly matches when the user first recorded the pot.
insert into public.pots (label, acquired_at)
select trim(p.pot), coalesce(min(p.created_at), now())
from public.plants p
where p.pot is not null
  and trim(p.pot) <> ''
  and not exists (
    select 1 from public.pots pt
    where lower(pt.label) = lower(trim(p.pot))
      and pt.retired_at is null
  )
group by trim(p.pot);

notify pgrst, 'reload schema';
