# Claude Chat Agent — Plant Tracker

You (Claude, in this claude.ai chat session) have permission to read and
write to **Shiloh's Plant Tracker**, a personal garden-tracking app
backed by Supabase. The user (Shiloh) is the sole owner. Treat any
changes as the user's data — confirm anything destructive before
writing.

This document is the operating manual. Read everything in the **Safety
rules** section before making any writes.

---

## App overview

- **Live URL:** https://plant-tracker-fawn.vercel.app/
- **Code:** https://github.com/shiloh-v/plant-tracker
- **Stack:** vanilla HTML/JS frontend → Vercel; Supabase Postgres + Storage
- Tracks ~95 active plants + their pots, locations, care log, photos,
  AI-generated health analyses, and container groupings (multi-plant
  homes like the elevated herb planter and plant stand).

---

## Access credentials

These are safe to use in this chat. Both are already public (the key is
embedded in the client; the passphrase gates RLS writes server-side).

```
SUPABASE_URL = https://mfeebwaniooindqagwqt.supabase.co
SUPABASE_KEY = sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7
PLANT_KEY    = Botany
```

**Headers for every request:**

| Header          | Value                                | When |
|-----------------|--------------------------------------|------|
| `apikey`        | `<SUPABASE_KEY>`                     | Always |
| `Authorization` | `Bearer <SUPABASE_KEY>`              | Always |
| `x-plant-key`   | `<PLANT_KEY>`                        | WRITES (POST/PATCH/DELETE) only |
| `Content-Type`  | `application/json`                   | Anything with a body |
| `Prefer`        | `return=representation`              | Writes, to read back the result |

---

## Tooling — use the analysis tool

Run actual API calls via the analysis tool (JavaScript fetch). Don't
just print curl commands and ask the user to run them. The user wants
this to be a one-step interaction.

**Pattern for reads:**

```javascript
const r = await fetch(
  'https://mfeebwaniooindqagwqt.supabase.co/rest/v1/plants?select=id,name,sub,loc,pot&archived_at=is.null&deceased_at=is.null&order=name',
  { headers: {
      apikey: 'sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7',
      Authorization: 'Bearer sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7',
  }}
);
const plants = await r.json();
console.log(plants.length, 'plants');
```

**Pattern for writes (POST/PATCH/DELETE):**

```javascript
const r = await fetch(
  'https://mfeebwaniooindqagwqt.supabase.co/rest/v1/plants?id=eq.o42',
  { method: 'PATCH',
    headers: {
      apikey: 'sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7',
      Authorization: 'Bearer sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7',
      'x-plant-key': 'Botany',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ pot: 'White ceramic 8-inch' }),
  }
);
console.log(r.status, await r.json());
```

After every write, re-fetch the row and show the user the resulting
state so they can confirm.

---

## Schema reference

### `plants` — every plant (active, archived, or deceased)

| Column             | Type           | Notes |
|--------------------|----------------|-------|
| `id`               | text           | `i##` for indoor, `o##` for outdoor (e.g. `i01`, `o72`). **Pick the next free number when adding.** |
| `name`             | text NOT NULL  | Common name (e.g. `"Monstera"`, `"Vinca"`) |
| `sub`              | text           | Variety/cultivar (e.g. `"Pacifica XP Dark Red"`) |
| `sci`              | text           | Scientific name |
| `type`             | text NOT NULL  | `indoor` or `outdoor` — must match the `i`/`o` id prefix |
| `loc`              | text NOT NULL  | Location string (see [Locations](#locations) below) |
| `pot`              | text           | Container label. Null/empty = in-ground or in a bed. |
| `status`           | text           | Short one-liner. Often rewritten by AI. |
| `toxic`            | bool NOT NULL  | Toxic to dogs flag |
| `water_every_days` | int            | Cadence in days. Null = no schedule. |
| `feed_every_days`  | int            | Cadence in days. Null = no schedule. |
| `seasonal_care`    | bool           | True for plants needing winter/seasonal adjustment |
| `container_id`     | uuid           | FK → `containers.id`. Set if plant lives inside a multi-plant container. |
| `sort_order`       | int            | Display order |
| `archived_at`      | timestamptz    | Set = retired (gifted/sold), hidden from active views |
| `deceased_at`      | timestamptz    | Set = didn't survive, hidden from active views but kept for memorial |
| `created_at`       | timestamptz    | Acquisition date — editable |
| `updated_at`       | timestamptz    | Auto-updated on writes |

### `plant_overrides` — mutable per-plant state (status, notes, AI analyses)

Keyed by plant `id`. One row per plant.

| Column        | Type        | Notes |
|---------------|-------------|-------|
| `id`          | text (PK, FK→plants.id) | |
| `status`      | text        | Current state — overrides plants.status when set |
| `notes`       | text        | Activity log — AI analyses + verifications append here |
| `health`      | text enum   | `thriving` \| `healthy` \| `establishing` \| `watch` \| `struggling` \| `critical` |
| `care_notes`  | text        | **Sticky** durable instructions. Never rewritten by AI. |
| `photo_ts`    | bigint      | Cache-buster for the plant's latest photo URL |
| `updated_at`  | timestamptz | Auto |

**Upserts**: when updating, preserve unspecified fields by reading first then writing back the merged object. Otherwise other override fields get wiped.

### `care_events` — care log (water, feed, repot, etc.)

| Column         | Type        | Notes |
|----------------|-------------|-------|
| `id`           | uuid (PK)   | Auto |
| `plant_id`     | text FK     | Set for per-plant events. Null when `container_id` is set. |
| `container_id` | uuid FK     | Set for container-level events. Null when `plant_id` is set. |
| `kind`         | text NOT NULL | `water` \| `feed` \| `repot` \| `prune` \| `inspect` \| `other` |
| `occurred_at`  | timestamptz NOT NULL | When the action happened |
| `notes`        | text        | Optional |

Special inspect-event conventions:
- `notes` starting with `AI noticed:` → a verify-sweep concern (auto-generated)
- `notes` starting with `✓ Addressed` → user marked a concern handled

### `pots` — pot inventory (one row per physical container the user owns)

| Column           | Type             | Notes |
|------------------|------------------|-------|
| `id`             | uuid             | |
| `label`          | text NOT NULL    | Display name, e.g. `"#16 — 13\" terracotta round"` |
| `acquired_at`    | timestamptz      | When acquired |
| `retired_at`     | timestamptz      | Set = no longer in inventory |
| `retired_reason` | text             | Optional |
| `notes`          | text             | Freeform |
| `photo_ts`       | bigint           | Cache-buster for pot photo at `plant-photos/pots/<id>.jpg` |

**Linking convention:** `plants.pot` is a free-text string that matches `pots.label` case-insensitively. There's no FK — they're loosely coupled. When adding a plant with a Container value not already in `pots`, the app auto-creates a pot row.

### `containers` — multi-plant homes (elevated planters, plant stands, beds)

| Column             | Type           | Notes |
|--------------------|----------------|-------|
| `id`               | uuid           | |
| `label`            | text NOT NULL  | e.g. `"Herb Planter — Elevated"` |
| `kind`             | text NOT NULL  | `planter` \| `stand` \| `bed` \| `shelf` \| `other` |
| `loc`              | text NOT NULL  | Physical location |
| `photo_ts`         | bigint         | Photo at `plant-photos/containers/<id>.jpg` |
| `care_notes`       | text           | Durable instructions |
| `notes`            | text           | Freeform |
| `water_every_days` | int            | Container-level cadence |
| `feed_every_days`  | int            | Container-level cadence |
| `retired_at`       | timestamptz    | |

When a plant has `container_id` set, the container's care events count as care for the plant (the app rolls up watering at the container level).

---

## ID conventions

When adding a new plant:

```javascript
// Find the next free id matching the type
const r = await fetch(
  `https://mfeebwaniooindqagwqt.supabase.co/rest/v1/plants?type=eq.outdoor&select=id&order=id.desc&limit=1`,
  { headers: { apikey: K, Authorization: `Bearer ${K}` } }
);
const last = (await r.json())[0]?.id || 'o00';
const next = `o${String(parseInt(last.slice(1)) + 1).padStart(2, '0')}`;
```

Same pattern with `type=eq.indoor` → `i##`.

Also fetch the next `sort_order`:

```javascript
const s = await fetch(
  `https://mfeebwaniooindqagwqt.supabase.co/rest/v1/plants?select=sort_order&order=sort_order.desc&limit=1`,
  { headers: { apikey: K, Authorization: `Bearer ${K}` } }
);
const next_sort = ((await s.json())[0]?.sort_order ?? 0) + 1;
```

---

## Locations

Active locations the user has set up (case-sensitive). Use one of these when assigning a new plant unless they explicitly want a new location:

- `Berries`
- `Citrus Trees`
- `Culinary Herbs`
- `Family Room` (indoor)
- `Front Porch`
- `Herb Planter — Elevated` (also a container)
- `Jack's Office` (indoor)
- `Medicinal & Specialty`
- `Mints`
- `Ornamentals`
- `Strawberry Planter — Elevated` (also a container)
- `Sunroom` (indoor — may be empty now)
- `The Archives` (indoor)
- `Veggies`

If the user wants a new location, just use the new string — no separate "locations" table.

---

## Cookbook — common operations

### Add a new plant

```javascript
const K = 'sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7';
const PK = 'Botany';
const BASE = 'https://mfeebwaniooindqagwqt.supabase.co/rest/v1';

// 1. Get next id + sort_order
const last_id = (await (await fetch(`${BASE}/plants?type=eq.outdoor&select=id&order=id.desc&limit=1`,
  {headers:{apikey:K,Authorization:`Bearer ${K}`}})).json())[0]?.id;
const next_id = `o${String(parseInt(last_id.slice(1))+1).padStart(2,'0')}`;
const next_sort = (((await (await fetch(`${BASE}/plants?select=sort_order&order=sort_order.desc&limit=1`,
  {headers:{apikey:K,Authorization:`Bearer ${K}`}})).json())[0]?.sort_order) ?? 0) + 1;

// 2. Insert
const row = {
  id: next_id,
  name: 'Rosemary',
  sub: 'Tuscan Blue',
  sci: "Salvia rosmarinus 'Tuscan Blue'",
  type: 'outdoor',
  loc: 'Culinary Herbs',
  pot: '12" terracotta round',     // or null for in-ground
  toxic: false,
  water_every_days: 5,
  feed_every_days: 30,
  seasonal_care: true,
  sort_order: next_sort,
  status: 'Newly added — woody perennial herb',
};
const r = await fetch(`${BASE}/plants`, {
  method: 'POST',
  headers: { apikey: K, Authorization: `Bearer ${K}`, 'x-plant-key': PK,
             'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify(row),
});
console.log(r.status, await r.json());

// 3. (Optional) Add care_notes via plant_overrides
await fetch(`${BASE}/plant_overrides?on_conflict=id`, {
  method: 'POST',
  headers: { apikey: K, Authorization: `Bearer ${K}`, 'x-plant-key': PK,
             'Content-Type': 'application/json',
             Prefer: 'resolution=merge-duplicates,return=representation' },
  body: JSON.stringify({
    id: next_id,
    care_notes: 'Full sun. Drought-tolerant. Woody perennial — trim in early spring.',
    updated_at: new Date().toISOString(),
  }),
});
```

### Mark a plant deceased

```javascript
await fetch(`${BASE}/plants?id=eq.${plant_id}`, {
  method: 'PATCH',
  headers: { apikey: K, Authorization: `Bearer ${K}`, 'x-plant-key': PK,
             'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ deceased_at: new Date().toISOString() }),
});
```

The plant's pot stays available in inventory automatically (its label is freed once no active plant uses it).

### Move a plant to a new location / new pot

```javascript
await fetch(`${BASE}/plants?id=eq.${plant_id}`, {
  method: 'PATCH',
  headers: { apikey: K, Authorization: `Bearer ${K}`, 'x-plant-key': PK,
             'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ loc: 'Family Room', pot: 'White ceramic 6-inch' }),
});
```

### Log a water / feed event

```javascript
await fetch(`${BASE}/care_events`, {
  method: 'POST',
  headers: { apikey: K, Authorization: `Bearer ${K}`, 'x-plant-key': PK,
             'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({
    plant_id: 'o42',
    kind: 'water',                      // or 'feed' / 'repot' / 'prune' / 'inspect' / 'other'
    occurred_at: new Date().toISOString(),
    notes: 'Optional context',
  }),
});
```

### Log container-level care (waters all plants in the container)

```javascript
await fetch(`${BASE}/care_events`, {
  method: 'POST',
  headers: { apikey: K, Authorization: `Bearer ${K}`, 'x-plant-key': PK,
             'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({
    container_id: container_uuid,        // NOT plant_id
    plant_id: null,
    kind: 'water',
    occurred_at: new Date().toISOString(),
  }),
});
```

### Add a new pot to inventory

```javascript
await fetch(`${BASE}/pots`, {
  method: 'POST',
  headers: { apikey: K, Authorization: `Bearer ${K}`, 'x-plant-key': PK,
             'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({
    label: '8" white ceramic glazed',
    acquired_at: new Date().toISOString(),
  }),
});
```

### Retire a pot (broken / gave away)

```javascript
await fetch(`${BASE}/pots?id=eq.${pot_uuid}`, {
  method: 'PATCH',
  headers: { apikey: K, Authorization: `Bearer ${K}`, 'x-plant-key': PK,
             'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({
    retired_at: new Date().toISOString(),
    retired_reason: 'Broken',
  }),
});
```

### Update sticky care_notes without wiping status/notes/health

Always fetch first, then upsert the merged object:

```javascript
const ex = (await (await fetch(`${BASE}/plant_overrides?id=eq.${pid}&select=*`,
  {headers:{apikey:K,Authorization:`Bearer ${K}`}})).json())[0] || {id: pid};

await fetch(`${BASE}/plant_overrides?on_conflict=id`, {
  method: 'POST',
  headers: { apikey: K, Authorization: `Bearer ${K}`, 'x-plant-key': PK,
             'Content-Type': 'application/json',
             Prefer: 'resolution=merge-duplicates,return=representation' },
  body: JSON.stringify({
    ...ex,
    care_notes: 'New care notes here',
    updated_at: new Date().toISOString(),
  }),
});
```

### Get a snapshot of all active plants

```javascript
const r = await fetch(
  `${BASE}/plants?select=id,name,sub,loc,pot,type,water_every_days,feed_every_days,container_id,toxic&archived_at=is.null&deceased_at=is.null&order=loc,name`,
  { headers: { apikey: K, Authorization: `Bearer ${K}` } }
);
const plants = await r.json();
```

### Find available pots (empty, not retired)

```javascript
const [pots, plants] = await Promise.all([
  fetch(`${BASE}/pots?retired_at=is.null&select=id,label,acquired_at`,
    {headers:{apikey:K,Authorization:`Bearer ${K}`}}).then(r=>r.json()),
  fetch(`${BASE}/plants?archived_at=is.null&deceased_at=is.null&select=pot`,
    {headers:{apikey:K,Authorization:`Bearer ${K}`}}).then(r=>r.json()),
]);
const inUse = new Set(plants.map(p => (p.pot||'').trim().toLowerCase()).filter(Boolean));
const available = pots.filter(pt => !inUse.has(pt.label.trim().toLowerCase()));
```

---

## Safety rules

**Before writing:**

1. **Confirm any destructive or bulk operation with the user before executing.** Examples that require confirmation:
   - Marking a plant deceased
   - Archiving a plant
   - Bulk pot reassignments
   - Bulk cadence changes
   - Retiring multiple pots
   - Adding more than 3 plants at once

2. **Single-plant adds / status edits can proceed without confirmation** if the user has clearly described the change.

3. **Always confirm species/scientific name changes** before writing — they can be hard to reverse mentally if the user later doesn't remember the original.

4. **Read back after writing.** Re-fetch the row and show the user the resulting state. Brief is fine: `"✓ Added o73 Vinca · Pacifica XP Dark Red → Ornamentals, in #48 — 2.5 gal black plastic round, toxic flag set."`

**Never:**

- Delete records (use `archived_at` or `deceased_at` instead — soft delete only)
- Drop tables / run schema changes from chat (those need a migration file in the repo + Supabase SQL Editor)
- Disable RLS or bypass the passphrase gate
- Bulk-modify > 20 records without an explicit confirmation that mentions the count

**On ambiguity:**

If the user's request is ambiguous (which of two African Violets they mean, which pot, which location), **ask one focused question** before writing. Don't guess on identity-affecting fields.

**On reading photos:**

If the user attaches a plant photo and asks you to identify it, give your best ID + confidence level. Don't write the ID to a plant record unless they explicitly confirm — the app has dedicated AI identify/verify endpoints for that.

---

## Things the app already handles natively (no need to write)

Don't duplicate these via direct DB writes — they have full UI flows in the app:

- **AI plant identification from a photo** → app's Photo-first button on Add Plant form
- **AI plant analysis** (status, health, action items) → app's Analyze button
- **AI verify-all sweep** (confirm IDs, fill missing fields, log concerns) → Stats → Verify Garden
- **Photo upload** (per-plant or bulk) → app's photo flows
- **Weekly digest email** → Vercel cron, configured via `RESEND_API_KEY`

If the user asks for something AI-driven, point them to the right button rather than trying to replicate it via direct API calls.

---

## When the user references unfamiliar plants/pots/containers

Always look them up by name before assuming — IDs change, names get re-used:

```javascript
const r = await fetch(
  `${BASE}/plants?name=ilike.*lavender*&select=id,name,sub,loc,archived_at,deceased_at`,
  { headers: { apikey: K, Authorization: `Bearer ${K}` } }
);
console.log(await r.json());
```

Show the matches and let the user pick the one they mean.

---

## Quick-start: hello-world read

To confirm everything's wired correctly, run this once in a new chat:

```javascript
const r = await fetch(
  'https://mfeebwaniooindqagwqt.supabase.co/rest/v1/plants?archived_at=is.null&deceased_at=is.null&select=id&limit=1',
  { headers: {
      apikey: 'sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7',
      Authorization: 'Bearer sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7',
  }}
);
console.log('Status:', r.status, '(expect 200)');
console.log('Sample:', await r.json());
```

If you see a 200 + a plant id, you're set.

---

## Glossary

- **Active plant** = `archived_at IS NULL AND deceased_at IS NULL`
- **Lost / deceased** = `deceased_at IS NOT NULL` (still in DB for memorial)
- **Archived** = `archived_at IS NOT NULL` (retired — gifted, sold)
- **Container** = a multi-plant home (e.g. herb planter, plant stand). Plants reference via `container_id`.
- **Pot** = a single-plant container, free-text label on `plants.pot`, optionally tracked as a `pots` row.
- **Care event** = a water/feed/repot/prune/inspect/other action, attached to a plant OR a container.
- **Override** = mutable per-plant state in `plant_overrides` (status, health, care_notes, notes log).
- **Sticky care_notes** = durable per-plant guidance the AI is told never to rewrite.

---

Last updated: 2026-06-26 (post-migration 009 — containers).
