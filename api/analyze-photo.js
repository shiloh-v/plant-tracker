// Vercel serverless function — analyzes a plant's latest photo with Claude vision
// and writes structured findings back to plant_overrides.notes.
//
// Gated by the same x-plant-key passphrase the rest of the app uses, so the
// endpoint can't be hammered by random visitors burning the API key. The
// passphrase value is read from the PLANT_PASSPHRASE env var in Vercel.
//
// Requires env vars (set in Vercel dashboard → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  — from console.anthropic.com → Settings → API Keys
//   PLANT_PASSPHRASE   — same value that's in your Supabase plant_key_ok() function
import Anthropic from '@anthropic-ai/sdk';

const SUPABASE_URL = 'https://mfeebwaniooindqagwqt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Qd7TJXvaLerPAPayVJWxtg_hzqVJni7';
const BUCKET = 'plant-photos';
const MODEL = 'claude-sonnet-4-6';

// JSON schema for the analysis — keeps Claude's output strictly typed
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    id_check: {
      type: 'object',
      description: "Does the plant in the photo match the recorded species?",
      properties: {
        matches: { type: 'boolean' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        actual_species: {
          type: 'string',
          description: 'Best guess at the visible species. If matches=true, the recorded name.'
        }
      },
      required: ['matches', 'confidence', 'actual_species'],
      additionalProperties: false
    },
    health: {
      type: 'string',
      enum: ['thriving', 'healthy', 'watch', 'struggling', 'critical']
    },
    observations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Visible details (max 5): leaf condition, growth, soil/pot. One sentence each.'
    },
    action_items: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete next steps (max 4). Empty array if no action needed.'
    }
  },
  required: ['id_check', 'health', 'observations', 'action_items'],
  additionalProperties: false
};

export default async function handler(req, res) {
  // CORS (Vercel deploys this on the same origin as the static site, so CORS
  // isn't strictly required — included for flexibility / local testing)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-plant-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Passphrase gate
  const passphrase = req.headers['x-plant-key'];
  if (!process.env.PLANT_PASSPHRASE) {
    return res.status(500).json({ error: 'Server misconfigured: PLANT_PASSPHRASE not set' });
  }
  if (!passphrase || passphrase !== process.env.PLANT_PASSPHRASE) {
    return res.status(401).json({ error: 'Invalid passphrase' });
  }

  // API key gate
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: ANTHROPIC_API_KEY not set' });
  }

  const { plantId } = req.body || {};
  if (!plantId || typeof plantId !== 'string' || !/^[a-z0-9_-]+$/i.test(plantId)) {
    return res.status(400).json({ error: 'Valid plantId required' });
  }

  try {
    // 1. Fetch plant metadata
    const plantResp = await fetch(
      `${SUPABASE_URL}/rest/v1/plants?id=eq.${encodeURIComponent(plantId)}&select=id,name,sub,sci,type,loc,status,toxic,water_every_days,feed_every_days,seasonal_care`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!plantResp.ok) return res.status(502).json({ error: 'Supabase plant fetch failed', status: plantResp.status });
    const plants = await plantResp.json();
    if (!plants.length) return res.status(404).json({ error: 'Plant not found' });
    const plant = plants[0];

    // 2. Fetch the current override (user-edited status/notes) if any
    const ovResp = await fetch(
      `${SUPABASE_URL}/rest/v1/plant_overrides?id=eq.${encodeURIComponent(plantId)}&select=status,notes`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const overrides = ovResp.ok ? await ovResp.json() : [];
    const override = overrides[0] || {};

    // 3. List photos for this plant, newest first by filename (filenames are timestamps)
    const listResp = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        limit: 100,
        prefix: `${plantId}/`,
        sortBy: { column: 'name', order: 'desc' }
      })
    });
    if (!listResp.ok) return res.status(502).json({ error: 'Supabase photo list failed', status: listResp.status });
    const files = await listResp.json();
    const jpgs = files.filter(f => f.name && f.name.endsWith('.jpg'));
    if (jpgs.length === 0) {
      return res.status(404).json({ error: 'No photos found for this plant — upload one first' });
    }
    const latest = jpgs[0].name;
    const photoUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${plantId}/${latest}`;

    // 4. Fetch the photo bytes and base64-encode for Claude
    const photoResp = await fetch(photoUrl);
    if (!photoResp.ok) {
      return res.status(502).json({ error: 'Photo fetch failed', status: photoResp.status });
    }
    const photoBuf = Buffer.from(await photoResp.arrayBuffer());
    const photoB64 = photoBuf.toString('base64');

    // 5. Build the prompt context — what the tracker knows
    const ctxLines = [
      `Recorded name: ${plant.name}${plant.sub ? ` (${plant.sub})` : ''}`,
      `Scientific name: ${plant.sci || '(unknown)'}`,
      `Type / location: ${plant.type} / ${plant.loc}`,
      `Current status: ${(override.status || plant.status || '(none)').trim()}`,
    ];
    if (plant.water_every_days) ctxLines.push(`Water cadence: every ${plant.water_every_days} days`);
    if (plant.feed_every_days) ctxLines.push(`Feed cadence: every ${plant.feed_every_days} days`);
    if (plant.toxic) ctxLines.push('Marked toxic to dogs');
    if (plant.seasonal_care) ctxLines.push('Marked as seasonal-care (needs winter adjustment)');

    // 6. Call Claude with structured output
    const anthropic = new Anthropic();  // reads ANTHROPIC_API_KEY env var
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: photoB64 }
          },
          {
            type: 'text',
            text:
              "Analyze this photo of a plant from the owner's tracker.\n\n" +
              "Tracker context:\n" + ctxLines.join('\n') + "\n\n" +
              "Focus on what's visible in the photo — leaf condition, color, growth pattern, " +
              "soil/pot if visible. Don't restate the tracker data.\n\n" +
              "If the species visible in the photo doesn't match the recorded name, set " +
              "id_check.matches=false and put your best species guess in actual_species. " +
              "If it matches, set actual_species to the recorded name and confidence accordingly.\n\n" +
              "Keep observations and action_items to one short sentence each. Use 0–4 actions; " +
              "leave empty if no action is warranted."
          }
        ]
      }]
    });

    // 7. Extract and parse the JSON response
    const textBlock = message.content.find(b => b.type === 'text');
    const rawText = textBlock?.text || '';
    let analysis;
    try {
      analysis = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({
        error: 'Failed to parse Claude JSON response',
        rawText: rawText.slice(0, 500)
      });
    }

    // 8. Format the result as a human-readable note
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const noteLines = [`[${today} AI analysis] Health: ${analysis.health}.`];
    if (analysis.id_check && analysis.id_check.matches === false) {
      const conf = analysis.id_check.confidence || 'medium';
      noteLines.push(`⚠ Possible mis-ID: photo looks like ${analysis.id_check.actual_species} (${conf} confidence), not ${plant.name}.`);
    }
    if (analysis.observations?.length) {
      noteLines.push('Observations:');
      analysis.observations.forEach(o => noteLines.push(`• ${o}`));
    }
    if (analysis.action_items?.length) {
      noteLines.push('Actions:');
      analysis.action_items.forEach(a => noteLines.push(`• ${a}`));
    }
    const noteText = noteLines.join('\n');

    // 9. Write back to plant_overrides.notes — preserves existing photo_ts
    const existingNotes = override.notes ? override.notes + '\n\n' : '';
    const upsertResp = await fetch(`${SUPABASE_URL}/rest/v1/plant_overrides?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'x-plant-key': passphrase,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        id: plantId,
        notes: existingNotes + noteText,
        updated_at: new Date().toISOString()
      })
    });
    if (!upsertResp.ok) {
      console.warn('Notes upsert failed:', upsertResp.status, await upsertResp.text());
      // Don't fail the whole request — still return the analysis
    }

    return res.status(200).json({
      analysis,
      noteText,
      photoUrl,
      usage: message.usage,
    });
  } catch (err) {
    // Anthropic SDK errors have .status; surface them with the original status
    if (err && typeof err.status === 'number') {
      console.error('Anthropic error:', err.status, err.message);
      return res.status(502).json({
        error: 'Claude API error',
        status: err.status,
        message: err.message
      });
    }
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
}
