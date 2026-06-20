# Shiloh's Plants

Personal plant care tracker — Supabase backed, deployed on Vercel, photo analysis via Claude.

Live at: https://plant-tracker-fawn.vercel.app/

## Stack

- **Frontend:** vanilla HTML/CSS/JS (`index.html`), no build step
- **Data:** Supabase Postgres (`plants`, `plant_overrides`, `care_events`) + Storage (`plant-photos` bucket)
- **Hosting:** Vercel (auto-deploys on push to `main`)
- **AI:** Claude Sonnet 4.6 via `@anthropic-ai/sdk`, called from Vercel serverless functions (`api/analyze-photo.js`, `api/identify-plant.js`, `api/verify-plant.js`, `api/ask-plant.js`)
- **Email:** Resend, called from `api/weekly-digest.js` on a Vercel cron
- **PWA:** installable on iOS/Android home screen, offline shell via `service-worker.js`

## Schema migrations

Apply each in order via Supabase SQL Editor:

1. [migrations/001_plants_table.sql](migrations/001_plants_table.sql) — plants table, RLS, passphrase gate
2. [migrations/002_care_log.sql](migrations/002_care_log.sql) — care_events table + water/feed cadence on plants
3. [migrations/003_seasonal_care.sql](migrations/003_seasonal_care.sql) — seasonal_care flag
4. [migrations/004_health.sql](migrations/004_health.sql) — health enum on plant_overrides
5. [migrations/005_care_notes.sql](migrations/005_care_notes.sql) — sticky care_notes field
6. [migrations/006_deceased.sql](migrations/006_deceased.sql) — deceased_at timestamp for plants that didn't survive
7. [migrations/007_pots.sql](migrations/007_pots.sql) — pots inventory table with acquired_at + retired_at (auto-backfills from existing plant.pot strings)
8. [migrations/008_pot_photos.sql](migrations/008_pot_photos.sql) — photo_ts column on pots so each pot can have one photo (stored at `plant-photos/pots/<id>.jpg`)

After 001, run [scripts/seed.html](scripts/seed.html) once to import the initial plants.

## Required environment variables (Vercel)

Set these in Vercel → Project Settings → Environment Variables. Mark each for Production, Preview, and Development. After adding env vars, **redeploy** (Deployments → ⋯ → Redeploy) so the functions pick them up.

| Name                | Where to get it                                                                                | Used by                                            |
| ------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com → Settings → API Keys → Create Key                              | `analyze-photo.js`, `identify-plant.js`, `verify-plant.js`, `ask-plant.js` |
| `PLANT_PASSPHRASE`  | Same value as the literal string in your Supabase `plant_key_ok()` function (see migration 001) | all api endpoints                                  |
| `RESEND_API_KEY`    | https://resend.com → API Keys (free tier: 100 emails/day, 3000/month)                          | `weekly-digest.js`                                 |
| `DIGEST_TO_EMAIL`   | Your inbox (e.g. `you@gmail.com`)                                                              | `weekly-digest.js`                                 |
| `DIGEST_FROM_EMAIL` | A verified sender on Resend (`onboarding@resend.dev` for testing; `plants@yourdomain.com` once you verify a domain) | `weekly-digest.js`                                 |
| `CRON_SECRET`       | Any long random string. Generate with `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`. **Vercel auto-sends this as `Authorization: Bearer $CRON_SECRET` on every cron run** — your function checks it to reject non-cron callers. | `weekly-digest.js`                                 |

## Weekly digest setup (Phase 4)

The digest runs every **Sunday at 13:00 UTC** (9am EDT / 8am EST) via a cron entry in `vercel.json`. It pulls all plants from Supabase, identifies the ones flagged `watch`/`struggling`/`critical` or overdue on water, extracts action items from the most recent AI analysis per plant, and emails a styled HTML digest via Resend.

**To enable:**

1. Sign up at https://resend.com (free tier is fine for one weekly email).
2. Create an API key — store as `RESEND_API_KEY` in Vercel.
3. For `DIGEST_FROM_EMAIL`, start with `onboarding@resend.dev` (no setup, rate-limited but works). Later, verify your own domain in Resend and switch to e.g. `plants@yourdomain.com`.
4. Set `DIGEST_TO_EMAIL` to your inbox.
5. Generate a `CRON_SECRET` and set it.
6. Redeploy.

**Manual testing:** the endpoint accepts the passphrase header for manual triggers — useful for previewing the next digest without waiting until Sunday:

```sh
# Dry run — returns digest stats + text preview, doesn't send email
curl -X POST "https://plant-tracker-fawn.vercel.app/api/weekly-digest?dryRun=1" \
  -H "x-plant-key: YOUR_PASSPHRASE" -H "Content-Type: application/json"

# Real send — sends to DIGEST_TO_EMAIL now
curl -X POST "https://plant-tracker-fawn.vercel.app/api/weekly-digest" \
  -H "x-plant-key: YOUR_PASSPHRASE" -H "Content-Type: application/json"
```

## Passphrase gate

The browser app and the AI/digest endpoints are gated by the same `PLANT_PASSPHRASE`. On the client side, the passphrase is stored in `localStorage` after first entry; on the server side, each function checks the `x-plant-key` request header against the env var. Supabase RLS enforces the same passphrase on direct database writes via a SQL function (`plant_key_ok()`).

To rotate the passphrase: update `PLANT_PASSPHRASE` in Vercel, update the literal in the Supabase function, and clear browser localStorage.

## Cost notes

- Claude Sonnet 4.6 with vision: ~$0.013 per photo analyzed (input image ~1500 tokens, ~500 output tokens)
- Resend free tier: 100 emails/day, 3000/month — weekly digest = 4-5 emails/month
- Supabase free tier covers all current usage
- Vercel free tier (Hobby) covers all current usage including 1 cron job/project

## Local development

```
python3 -m http.server 8000   # or any static server
```

`api/*.js` only runs on Vercel — local serving covers everything else.
