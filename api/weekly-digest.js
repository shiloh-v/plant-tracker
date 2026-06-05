// Vercel serverless function — composes and emails a weekly digest of plants
// that need attention. Triggered by Vercel cron on Sundays (see vercel.json)
// or callable manually with the passphrase for testing.
//
// Required env vars (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY    — from resend.com → API Keys (free tier is plenty)
//   DIGEST_TO_EMAIL   — your inbox
//   DIGEST_FROM_EMAIL — verified sender on Resend (e.g. plants@yourdomain.com,
//                       or onboarding@resend.dev while testing)
//   CRON_SECRET       — any long random string; Vercel sends it as the cron
//                       Authorization bearer. Generate one with:
//                         python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
//   PLANT_PASSPHRASE  — already set; allows manual testing via x-plant-key header

const SUPABASE_URL = 'https://mfeebwaniooindqagwqt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7';
const APP_URL = 'https://plant-tracker-fawn.vercel.app';

const KIND_EMOJI = { water:'💧', feed:'🍴', repot:'🌱', prune:'✂️', inspect:'👀', other:'•' };
const HEALTH_META = {
  thriving:     { label: 'Thriving',     emoji: '⭐', color: '#0369a1', severity: 0 },
  healthy:      { label: 'Healthy',      emoji: '',   color: '#15803d', severity: 1 },
  establishing: { label: 'Establishing', emoji: '🌱', color: '#6d28d9', severity: 2 },
  watch:        { label: 'Watch',        emoji: '⚠',  color: '#b45309', severity: 3 },
  struggling:   { label: 'Struggling',   emoji: '',   color: '#9a3412', severity: 4 },
  critical:     { label: 'Critical',     emoji: '☠',  color: '#b91c1c', severity: 5 },
};

// Pull the most recent "[Month Day, YYYY AI analysis]" block out of notes.
// Used to surface the latest action items per plant in the digest.
function lastAIAnalysisBlock(notes) {
  if (!notes) return null;
  const matches = [...notes.matchAll(/\[[A-Z][a-z]+ \d{1,2}, \d{4} AI analysis\][\s\S]*?(?=\n\[[A-Z][a-z]+ \d{1,2}, \d{4} AI analysis\]|$)/g)];
  return matches.length ? matches[matches.length - 1][0].trim() : null;
}

// Parse action_items out of a notes block — they appear after a line containing "Actions:"
function actionItemsFromBlock(block) {
  if (!block) return [];
  const lines = block.split('\n');
  const i = lines.findIndex(l => /^Actions:/i.test(l.trim()));
  if (i === -1) return [];
  const items = [];
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (!t) break;
    if (t.startsWith('•')) items.push(t.replace(/^•\s*/, '').trim());
    else break;
  }
  return items;
}

async function sbFetch(path) {
  const resp = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!resp.ok) throw new Error('Supabase fetch failed: ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  return resp.json();
}

// Lookup the latest photo URL for one plant (storage list, sorted by name desc
// since filenames are timestamps). Returns null on failure or no photos.
async function latestPhotoUrl(plantId) {
  try {
    const resp = await fetch(SUPABASE_URL + '/storage/v1/object/list/plant-photos', {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        limit: 1,
        prefix: plantId + '/',
        sortBy: { column: 'name', order: 'desc' },
      }),
    });
    if (!resp.ok) return null;
    const files = await resp.json();
    if (!files.length || !files[0].name || !files[0].name.endsWith('.jpg')) return null;
    return SUPABASE_URL + '/storage/v1/object/public/plant-photos/' + plantId + '/' + files[0].name;
  } catch (e) {
    console.warn('Photo lookup failed for', plantId, e.message);
    return null;
  }
}

function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildDigest({ plants, overrides, careEvents }) {
  // Index overrides + events by plant_id
  const ovById = {};
  overrides.forEach(o => { ovById[o.id] = o; });
  const eventsByPlant = {};
  careEvents.forEach(e => { (eventsByPlant[e.plant_id] = eventsByPlant[e.plant_id] || []).push(e); });

  // Exclude both archived (intentionally retired) and deceased (didn't make it).
  // Deceased plants stay in DB for memorial but shouldn't drive weekly nags.
  const active = plants.filter(p => !p.archived_at && !p.deceased_at);

  // Compute attention list
  const now = Date.now();
  const attention = [];
  active.forEach(p => {
    const ov = ovById[p.id] || {};
    const health = ov.health;
    let reason = null;

    // Health-flagged
    if (health === 'critical' || health === 'struggling' || health === 'watch') {
      reason = health;
    }

    // Overdue water — only flag if the plant has been watered AT LEAST ONCE
    // before AND the cadence has lapsed. "Never watered" doesn't count, so
    // newly-added plants with cadence set don't spam the attention list until
    // the user has actually started logging.
    let waterOverdueDays = null;
    if (p.water_every_days) {
      const events = eventsByPlant[p.id] || [];
      const lastWater = events.find(e => e.kind === 'water');
      if (lastWater) {
        const daysSince = Math.floor((now - new Date(lastWater.occurred_at).getTime()) / 86400000);
        const dueIn = p.water_every_days - daysSince;
        if (dueIn <= 0) waterOverdueDays = -dueIn;
      }
    }

    if (reason || waterOverdueDays != null) {
      const recentBlock = lastAIAnalysisBlock(ov.notes);
      attention.push({
        plant: p,
        override: ov,
        health,
        reason,
        waterOverdueDays,
        actionItems: actionItemsFromBlock(recentBlock),
        currentStatus: ov.status || p.status || '',
      });
    }
  });

  // Sort: critical first, then struggling, watch, then overdue-only
  attention.sort((a, b) => {
    const ah = a.health ? HEALTH_META[a.health]?.severity ?? -1 : -1;
    const bh = b.health ? HEALTH_META[b.health]?.severity ?? -1 : -1;
    if (bh !== ah) return bh - ah;
    return (b.waterOverdueDays || 0) - (a.waterOverdueDays || 0);
  });

  // Recent activity (past 7 days)
  const weekAgo = now - 7 * 86400000;
  const recentEvents = careEvents.filter(e => new Date(e.occurred_at).getTime() >= weekAgo);
  const eventTallies = recentEvents.reduce((m, e) => { m[e.kind] = (m[e.kind] || 0) + 1; return m; }, {});

  return { attention, weekTotals: eventTallies, recentCount: recentEvents.length, totalActive: active.length };
}

function renderHTML(digest) {
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const renderPlantRow = item => {
    const p = item.plant;
    const hm = item.health ? HEALTH_META[item.health] : null;
    const label = p.name + (p.sub ? ' — ' + p.sub : '');
    const deepLink = APP_URL + '/#plant=' + encodeURIComponent(p.id);
    const badge = hm
      ? '<span style="display:inline-block;background:' + hm.color + '22;color:' + hm.color + ';font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;margin-right:6px">' + (hm.emoji ? hm.emoji + ' ' : '') + hm.label + '</span>'
      : '';
    const overdueChip = item.waterOverdueDays != null && item.waterOverdueDays > 0
      ? '<span style="display:inline-block;background:#fed7aa;color:#9a3412;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;margin-right:6px">💧 ' + item.waterOverdueDays + 'd overdue</span>'
      : '';
    const actions = item.actionItems.length
      ? '<ul style="margin:6px 0 0;padding-left:18px;color:#15803d;font-size:13px;font-weight:600">' +
        item.actionItems.slice(0, 3).map(a => '<li style="margin-bottom:3px">' + escapeHTML(a) + '</li>').join('') +
        '</ul>'
      : '';
    // Thumbnail column (when a photo exists). Email clients vary on rendering
    // remote images; Supabase URLs are public so most clients will load them.
    const thumb = item.photoUrl
      ? '<td style="padding:12px 0 12px 14px;vertical-align:top;width:76px"><a href="' + deepLink + '" style="text-decoration:none"><img src="' + item.photoUrl + '" alt="" width="60" height="60" style="display:block;width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #e0d8cc"></a></td>'
      : '';
    return '<tr>' +
      thumb +
      '<td style="padding:12px 14px;border-bottom:1px solid #e0d8cc;vertical-align:top">' +
        '<div style="font-family:Georgia,serif;font-size:15px;font-weight:700;color:#1e1a12;margin-bottom:4px"><a href="' + deepLink + '" style="color:#1e1a12;text-decoration:none">' + escapeHTML(label) + '</a></div>' +
        '<div style="margin-bottom:4px">' + badge + overdueChip + '<span style="font-size:11px;color:#7a7060">' + escapeHTML(p.loc) + '</span></div>' +
        '<div style="font-size:13px;color:#3f3a30;line-height:1.45">' + escapeHTML(item.currentStatus) + '</div>' +
        actions +
      '</td>' +
    '</tr>';
  };

  const kindEmoji = KIND_EMOJI;
  const activityChips = Object.entries(digest.weekTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => '<span style="display:inline-block;background:#f0ebe0;border-radius:14px;padding:5px 11px;font-size:13px;margin:2px 4px 2px 0"><strong>' + (kindEmoji[k] || '•') + ' ' + n + '</strong> <span style="color:#7a7060">' + k + '</span></span>')
    .join('') || '<span style="color:#7a7060;font-size:13px;font-style:italic">No care events logged this week</span>';

  const empty = digest.attention.length === 0
    ? '<div style="padding:24px;background:#dcfce7;border-radius:12px;text-align:center"><div style="font-size:42px;margin-bottom:6px">🌿</div><div style="font-size:15px;font-weight:700;color:#15803d">Nothing needs attention. Everything\'s thriving.</div></div>'
    : '<table style="width:100%;border-collapse:collapse;background:#fffdf8;border-radius:12px;overflow:hidden">' +
        digest.attention.map(renderPlantRow).join('') +
      '</table>';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px">
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:#2d5a27">🌿 Weekly garden digest</div>
      <div style="font-size:13px;color:#7a7060;margin-top:4px">${today}</div>
    </div>

    <div style="background:#fffdf8;border-radius:12px;padding:16px;margin-bottom:16px;text-align:center">
      <div style="font-size:13px;color:#7a7060;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:4px">Needs attention</div>
      <div style="font-family:Georgia,serif;font-size:36px;font-weight:700;color:${digest.attention.length === 0 ? '#15803d' : '#b45309'}">${digest.attention.length}</div>
      <div style="font-size:12px;color:#7a7060;margin-top:2px">of ${digest.totalActive} active plants</div>
    </div>

    ${empty}

    <div style="background:#fffdf8;border-radius:12px;padding:16px;margin-top:16px">
      <div style="font-size:13px;color:#7a7060;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:10px">Past 7 days</div>
      <div>${activityChips}</div>
    </div>

    <div style="text-align:center;margin-top:24px">
      <a href="${APP_URL}" style="display:inline-block;background:#2d5a27;color:white;text-decoration:none;padding:12px 24px;border-radius:24px;font-size:14px;font-weight:700">Open Shiloh's Plants →</a>
    </div>

    <div style="text-align:center;font-size:11px;color:#7a7060;margin-top:18px">Sent by the plant tracker · Sundays at 8am</div>
  </div>
</body></html>`;
}

function renderText(digest) {
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const lines = [
    `🌿 Weekly garden digest — ${today}`,
    '',
    `${digest.attention.length} of ${digest.totalActive} plants need attention.`,
    '',
  ];

  if (digest.attention.length === 0) {
    lines.push('Nothing needs attention. Everything is thriving!');
  } else {
    digest.attention.forEach(item => {
      const tag = item.health ? '[' + item.health + ']' : '';
      const overdue = item.waterOverdueDays != null && item.waterOverdueDays > 0
        ? ' [' + item.waterOverdueDays + 'd overdue water]'
        : '';
      lines.push(`• ${item.plant.name}${item.plant.sub ? ' — ' + item.plant.sub : ''}${tag ? ' ' + tag : ''}${overdue}`);
      if (item.currentStatus) lines.push(`    ${item.currentStatus}`);
      item.actionItems.slice(0, 3).forEach(a => lines.push(`    → ${a}`));
      lines.push('');
    });
  }

  lines.push('Past 7 days:');
  const evParts = Object.entries(digest.weekTotals).map(([k, n]) => `${n} ${k}`);
  lines.push('  ' + (evParts.join(' · ') || 'No care events logged'));
  lines.push('');
  lines.push(APP_URL);
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-plant-key, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Allow GET (Vercel cron) and POST (manual test)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth — accept either:
  //   (a) Vercel cron bearer (Authorization: Bearer $CRON_SECRET)
  //   (b) Plant passphrase header (x-plant-key) for manual testing
  const auth = req.headers['authorization'] || '';
  const isCronAuth = process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET;
  const isUserAuth = process.env.PLANT_PASSPHRASE && req.headers['x-plant-key'] === process.env.PLANT_PASSPHRASE;
  if (!isCronAuth && !isUserAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Env checks
  const missing = ['RESEND_API_KEY', 'DIGEST_TO_EMAIL', 'DIGEST_FROM_EMAIL'].filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: 'Server misconfigured', missing });
  }

  // dryRun=1 query param skips sending the email (returns the rendered preview)
  const url = new URL(req.url, 'http://localhost');
  const dryRun = url.searchParams.get('dryRun') === '1';

  try {
    // Pull data in parallel
    const [plants, overrides, careEvents] = await Promise.all([
      sbFetch('plants?select=id,name,sub,sci,type,loc,status,toxic,water_every_days,feed_every_days,seasonal_care,archived_at,deceased_at'),
      sbFetch('plant_overrides?select=id,status,notes,health,care_notes'),
      sbFetch('care_events?select=plant_id,kind,occurred_at&order=occurred_at.desc&limit=2000'),
    ]);

    const digest = buildDigest({ plants, overrides, careEvents });

    // Fetch latest photo URL for each attention plant (parallel, ~200ms total)
    if (digest.attention.length > 0) {
      const urls = await Promise.all(digest.attention.map(item => latestPhotoUrl(item.plant.id)));
      digest.attention.forEach((item, i) => { item.photoUrl = urls[i]; });
    }

    const html = renderHTML(digest);
    const text = renderText(digest);

    if (dryRun) {
      return res.status(200).json({
        attentionCount: digest.attention.length,
        totalActive: digest.totalActive,
        weekTotals: digest.weekTotals,
        previewText: text,
        previewHTMLLength: html.length,
      });
    }

    // Send via Resend
    const subject = digest.attention.length === 0
      ? '🌿 Weekly garden digest — all good'
      : `🌿 Weekly garden digest — ${digest.attention.length} need${digest.attention.length === 1 ? 's' : ''} attention`;

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.DIGEST_FROM_EMAIL,
        to: process.env.DIGEST_TO_EMAIL,
        subject,
        html,
        text,
      }),
    });

    const resendBody = await resendResp.json();
    if (!resendResp.ok) {
      console.error('Resend error:', resendResp.status, resendBody);
      return res.status(502).json({ error: 'Email send failed', status: resendResp.status, detail: resendBody });
    }

    return res.status(200).json({
      sent: true,
      messageId: resendBody.id,
      attentionCount: digest.attention.length,
      totalActive: digest.totalActive,
      via: isCronAuth ? 'cron' : 'manual',
    });
  } catch (err) {
    console.error('Digest error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
}
