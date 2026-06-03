# Shiloh's Plants

Personal plant care tracker — Supabase backed, deployed on Vercel, photo analysis via Claude.

Live at: https://plant-tracker-fawn.vercel.app/

## Stack

- **Frontend:** vanilla HTML/CSS/JS (`index.html`), no build step
- **Data:** Supabase Postgres (`plants`, `plant_overrides`, `care_events`) + Storage (`plant-photos` bucket)
- **Hosting:** Vercel (auto-deploys on push to `main`)
- **AI:** Claude Sonnet 4.6 via `@anthropic-ai/sdk`, called from a Vercel serverless function (`api/analyze-photo.js`)
- **PWA:** installable on iOS/Android home screen, offline shell via `service-worker.js`

## Schema migrations

Apply each in order via Supabase SQL Editor:

1. [migrations/001_plants_table.sql](migrations/001_plants_table.sql) — plants table, RLS, passphrase gate
2. [migrations/002_care_log.sql](migrations/002_care_log.sql) — care_events table + water/feed cadence on plants
3. [migrations/003_seasonal_care.sql](migrations/003_seasonal_care.sql) — seasonal_care flag

After 001, run [scripts/seed.html](scripts/seed.html) once to import the initial plants.

## Required environment variables (Vercel)

Set these in Vercel → Project Settings → Environment Variables. Mark each for Production, Preview, and Development.

| Name                | Where to get it                                                                                | Used by                          |
| ------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com → Settings → API Keys → Create Key                              | `api/analyze-photo.js`           |
| `PLANT_PASSPHRASE`  | Same value as the literal string in your Supabase `plant_key_ok()` function (see migration 001) | `api/analyze-photo.js`           |

After adding env vars, redeploy from the Vercel dashboard (or push any commit) so the function picks them up.

## Passphrase gate

The browser app and the AI endpoint are gated by the same `PLANT_PASSPHRASE`. On the client side, the passphrase is stored in `localStorage` after first entry; on the server side, `api/analyze-photo.js` checks the `x-plant-key` request header against the env var. Supabase RLS enforces the same passphrase on direct database writes via a SQL function (`plant_key_ok()`).

To rotate the passphrase: update `PLANT_PASSPHRASE` in Vercel, update the literal in the Supabase function, and clear browser localStorage.

## Cost notes

- Claude Sonnet 4.6 with vision: ~$0.013 per photo analyzed (input image ~1500 tokens, ~500 output tokens)
- Supabase free tier covers all current usage
- Vercel free tier covers all current usage

## Local development

```
python3 -m http.server 8000   # or any static server
```

`api/analyze-photo.js` only runs on Vercel — local serving covers everything else.
