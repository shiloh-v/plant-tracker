# Bulk Photo Uploader — `photo-upload.html`

## Goal

Build a standalone `photo-upload.html` page that lives in the repo root alongside `index.html`. It lets you select many photos at once, assign each to a plant, and upload to Supabase Storage in one session — no hunting through a camera roll one photo at a time.

---

## Config

Reuse the same constants already in `index.html`:

```js
const SUPABASE_URL = 'https://mfeebwaniooindqagwqt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7';
const BUCKET       = 'plant-photos';
```

Include Supabase JS the same way:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

---

## Plant List

Copy the entire `PLANTS` array verbatim from `index.html`. Do not import or fetch it — keep this file self-contained so it works locally without a dev server.

---

## UI Layout

### Step 1 — File picker

- A large drag-and-drop zone **plus** a `<input type="file" multiple accept="image/*">` button
- Accepts any number of files at once
- On selection, show all chosen images as a scrollable thumbnail grid

### Step 2 — Assignment grid

Each thumbnail card shows:
- The photo preview (constrained, not full-size)
- A **searchable dropdown / combobox** to pick the plant (search by name, sub, ID, or location)
- A small status badge: `Unassigned` / `Ready` / `Uploading…` / `✓ Done` / `✗ Failed`

The dropdown must be keyboard-friendly. Typing filters the plant list in real time.

### Step 3 — Upload

- A prominent **"Upload All Ready"** button at the top and bottom
- Uploads only cards that have a plant assigned
- Each upload goes to `{id}/{timestamp}.jpg` (timestamp = `Date.now()` at upload time)
- After upload, upserts `plant_overrides` to set `photo_ts` (preserving existing `status` and `notes`)
- Progress shown per-card inline; a summary banner when all done

---

## Upload Logic

Follow the exact same pattern as `index.html`'s `uploadPhoto()`:

1. Compress with canvas to max 1000px, JPEG quality 0.78
2. Path: `${plantId}/${Date.now()}.jpg`
3. `sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false })`
4. On success, fetch existing override row first (to preserve `status`/`notes`), then upsert with new `photo_ts`

Batch uploads — run up to **3 concurrent** uploads at a time (avoid hammering the API).

---

## Edge Cases

- If a photo is uploaded to a plant that already has photos, it simply adds a new file to that plant's subfolder (same behavior as the main app's history strip)
- Duplicate filename collisions can't happen because the filename is `Date.now()` — but add a 1ms `await` between concurrent batches if needed
- Show a **"Skip"** button per card to exclude a photo without removing it from the grid
- Show a **"Clear Done"** button to remove completed cards from view

---

## Styling

Match `index.html` exactly:
- Same CSS custom properties (`:root` block)
- Same fonts: `Fraunces` (serif headings) + `Nunito` (body) from Google Fonts
- Same green (`#2d5a27`), cream (`#fffdf8`), bg (`#f4f0e8`), border (`#e0d8cc`) palette
- Cards and buttons should feel native to the existing app

---

## File Placement

```
repo-root/
├── index.html          ← existing, do not modify
└── photo-upload.html   ← new file to create
```

No build step, no dependencies beyond the Supabase CDN script and Google Fonts. Must work when opened directly in a browser (file://) or served by Vercel.

---

## Out of Scope

- No authentication — same public key as `index.html`
- No deletion of photos
- No editing of status/notes (that stays in the main app)
- No automatic plant ID detection from image content
