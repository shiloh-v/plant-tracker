// Vercel serverless function — per-plant Q&A with Claude. Multi-turn: the
// client tracks the conversation in modal-local state and sends the full
// history with each call. Server enriches with plant metadata (system prompt)
// and the latest photo (attached to the first user turn so Claude can see it).
//
// Gated by the same x-plant-key passphrase as the other endpoints.
//
// Required env vars:
//   ANTHROPIC_API_KEY  — from console.anthropic.com
//   PLANT_PASSPHRASE   — same value as in Supabase plant_key_ok()
import Anthropic from '@anthropic-ai/sdk';

const SUPABASE_URL = 'https://mfeebwaniooindqagwqt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7';
const BUCKET = 'plant-photos';
const MODEL = 'claude-sonnet-4-6';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-plant-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.PLANT_PASSPHRASE) return res.status(500).json({ error: 'Server misconfigured: PLANT_PASSPHRASE not set' });
  if (req.headers['x-plant-key'] !== process.env.PLANT_PASSPHRASE) return res.status(401).json({ error: 'Invalid passphrase' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server misconfigured: ANTHROPIC_API_KEY not set' });

  const { plantId, conversation } = req.body || {};
  if (!plantId || typeof plantId !== 'string' || !/^[a-z0-9_-]+$/i.test(plantId)) {
    return res.status(400).json({ error: 'Valid plantId required' });
  }
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return res.status(400).json({ error: 'conversation array required (at least one user message)' });
  }
  if (conversation[conversation.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'last message must be from user' });
  }
  // Sanity cap so a runaway client can't blow tokens
  if (conversation.length > 30) {
    return res.status(400).json({ error: 'conversation too long (max 30 turns) — start a new one' });
  }

  try {
    // 1. Plant metadata
    const plantResp = await fetch(
      `${SUPABASE_URL}/rest/v1/plants?id=eq.${encodeURIComponent(plantId)}&select=id,name,sub,sci,type,loc,pot,status,toxic,water_every_days,feed_every_days,seasonal_care`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!plantResp.ok) return res.status(502).json({ error: 'Supabase plant fetch failed' });
    const plants = await plantResp.json();
    if (!plants.length) return res.status(404).json({ error: 'Plant not found' });
    const plant = plants[0];

    // 2. Override (current status / health / care_notes / notes)
    const ovResp = await fetch(
      `${SUPABASE_URL}/rest/v1/plant_overrides?id=eq.${encodeURIComponent(plantId)}&select=status,notes,health,care_notes`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const overrides = ovResp.ok ? await ovResp.json() : [];
    const override = overrides[0] || {};

    // 3. Recent care events (last 30 to keep prompt size sane)
    const eventsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/care_events?plant_id=eq.${encodeURIComponent(plantId)}&select=kind,occurred_at,notes&order=occurred_at.desc&limit=30`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const careEvents = eventsResp.ok ? await eventsResp.json() : [];

    // 4. Latest photo (filename-sorted = chronological since filenames are timestamps)
    let photoB64 = null;
    const listResp = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1, prefix: `${plantId}/`, sortBy: { column: 'name', order: 'desc' } }),
    });
    if (listResp.ok) {
      const files = await listResp.json();
      if (files.length && files[0].name?.endsWith('.jpg')) {
        const photoResp = await fetch(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${plantId}/${files[0].name}`);
        if (photoResp.ok) {
          photoB64 = Buffer.from(await photoResp.arrayBuffer()).toString('base64');
        }
      }
    }

    // 5. Build system prompt with everything Claude needs to know
    const ctxLines = [
      `You are helping a home gardener answer questions about ONE specific plant in their tracker.`,
      ``,
      `Plant tracker record:`,
      `- Recorded name: ${plant.name}${plant.sub ? ` (${plant.sub})` : ''}`,
      `- Scientific name: ${plant.sci || '(not recorded)'}`,
      `- Type / location: ${plant.type} / ${plant.loc}`,
      `- Container: ${plant.pot || '(not recorded)'}`,
    ];
    if (override.health) ctxLines.push(`- Current health rating: ${override.health}`);
    ctxLines.push(`- Current status text: ${(override.status || plant.status || '(none)').trim()}`);
    if (override.care_notes) ctxLines.push(`- Sticky care notes: ${override.care_notes.trim()}`);
    if (plant.water_every_days) ctxLines.push(`- Water cadence: every ${plant.water_every_days} days`);
    if (plant.feed_every_days) ctxLines.push(`- Feed cadence: every ${plant.feed_every_days} days`);
    if (plant.toxic) ctxLines.push(`- Marked toxic to dogs`);
    if (plant.seasonal_care) ctxLines.push(`- Seasonal care plant (needs winter adjustment)`);
    if (careEvents.length) {
      ctxLines.push(``);
      ctxLines.push(`Recent care events (newest first, up to 30):`);
      careEvents.slice(0, 10).forEach(e => {
        const when = new Date(e.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        ctxLines.push(`- ${when}: ${e.kind}${e.notes ? ' (' + e.notes + ')' : ''}`);
      });
      if (careEvents.length > 10) ctxLines.push(`- ... and ${careEvents.length - 10} more older events`);
    }
    if (override.notes) {
      ctxLines.push(``);
      ctxLines.push(`Notes log (most recent 1500 chars):`);
      ctxLines.push(override.notes.slice(-1500));
    }
    ctxLines.push(``);
    ctxLines.push(`Guidelines:`);
    ctxLines.push(`- Answer concisely and practically. The user is hands-on with their plants; skip generic plant-care lectures.`);
    ctxLines.push(`- If the user suspects a misidentification or asks "what is this", give your best species guess from the photo with brief reasoning. Mention 1-2 alternatives if confidence is low.`);
    ctxLines.push(`- If asked about a problem, give the most likely cause first, then 1-2 alternatives if relevant.`);
    ctxLines.push(`- If the photo shows something the user might not have noticed (pests, disease, root rot signs), point it out unprompted but briefly.`);
    ctxLines.push(`- If you don't know or the photo doesn't show enough, say so plainly.`);

    const systemPrompt = ctxLines.join('\n');

    // 6. Build messages — attach photo (if available) to the first user turn
    const messages = conversation.map((m, i) => {
      if (i === 0 && m.role === 'user' && photoB64) {
        return {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoB64 } },
            { type: 'text', text: m.content },
          ],
        };
      }
      // Validate shape
      return { role: m.role, content: String(m.content || '').slice(0, 4000) };
    });

    // 7. Call Claude
    const anthropic = new Anthropic();
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const textBlock = message.content.find(b => b.type === 'text');
    const answer = textBlock?.text || '';

    return res.status(200).json({
      answer,
      hadPhoto: !!photoB64,
      usage: message.usage,
    });
  } catch (err) {
    if (err && typeof err.status === 'number') {
      console.error('Anthropic error:', err.status, err.message);
      return res.status(502).json({ error: 'Claude API error', status: err.status, message: err.message });
    }
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
}
