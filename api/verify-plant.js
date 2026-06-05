// Vercel serverless function — verifies an EXISTING plant's record against
// its most recent photo, and proposes fills/corrections for any field that's
// blank or appears wrong. The client uses this to run a batch sweep of the
// whole garden and surface a review queue.
//
// Returns the current value alongside the proposed value for each field so
// the client can build a diff UI. The model also returns id_matches +
// id_reasoning so we can flag species-level changes prominently.
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

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    id_matches: {
      type: 'boolean',
      description: 'True if the photo matches the recorded common_name + scientific_name. False if the species is clearly different.'
    },
    id_confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'high = clearly identifiable, you are certain of the call; medium = best guess; low = could be several species.'
    },
    id_reasoning: {
      type: 'string',
      description: '1-2 short sentences explaining the ID call — what visual features confirm or contradict the recorded ID.'
    },
    proposed_common_name: {
      type: 'string',
      description: 'Best common name for the plant in the photo. Echo the recorded name back if id_matches=true.'
    },
    proposed_variety: {
      type: 'string',
      description: 'Cultivar/variety if visible from distinctive features. Echo the recorded variety if it still fits. Empty string if not identifiable.'
    },
    proposed_scientific_name: {
      type: 'string',
      description: 'Full scientific name. Echo the recorded value if id_matches=true.'
    },
    proposed_toxic_to_dogs: {
      type: 'boolean',
      description: 'True if the species is on the ASPCA toxic-to-dogs list or has well-known canine toxicity. When unsure, set false.'
    },
    proposed_seasonal_care: {
      type: 'boolean',
      description: 'True if care shifts meaningfully in fall/winter (succulents needing dormancy, deciduous tropicals, annuals, most outdoor plants). False for indoor tropicals that stay consistent year-round.'
    },
    proposed_water_every_days: {
      type: 'integer',
      description: 'Recommended watering cadence in days (must be between 1 and 180). Succulents 14-21, tropicals 5-10, ferns 3-5, annual vegetables 2-3. Use the recorded value if it is reasonable for this species.'
    },
    proposed_feed_every_days: {
      type: 'integer',
      description: 'Recommended feeding cadence in days (must be between 7 and 365). Conservative — better to under-feed. Succulents 60-90, tropicals 30, annual veg 14. Use the recorded value if it is reasonable.'
    },
    proposed_care_notes: {
      type: 'string',
      description: '2-4 short sticky directives — light, watering style, temperature limits, common pitfalls. Plain text, no bullets. If the recorded care_notes already cover these things, echo them back. Otherwise rewrite to cover the gaps.'
    },
    visible_concerns: {
      type: 'string',
      description: 'If the photo shows pests, disease, root rot, sunburn, or other issues worth surfacing, 1 short sentence here. Empty string if nothing obvious.'
    }
  },
  required: [
    'id_matches', 'id_confidence', 'id_reasoning',
    'proposed_common_name', 'proposed_variety', 'proposed_scientific_name',
    'proposed_toxic_to_dogs', 'proposed_seasonal_care',
    'proposed_water_every_days', 'proposed_feed_every_days',
    'proposed_care_notes', 'visible_concerns'
  ],
  additionalProperties: false
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-plant-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.PLANT_PASSPHRASE) return res.status(500).json({ error: 'Server misconfigured: PLANT_PASSPHRASE not set' });
  if (req.headers['x-plant-key'] !== process.env.PLANT_PASSPHRASE) return res.status(401).json({ error: 'Invalid passphrase' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server misconfigured: ANTHROPIC_API_KEY not set' });

  const { plantId } = req.body || {};
  if (!plantId || typeof plantId !== 'string' || !/^[a-z0-9_-]+$/i.test(plantId)) {
    return res.status(400).json({ error: 'Valid plantId required' });
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

    // 2. Override (current care_notes)
    const ovResp = await fetch(
      `${SUPABASE_URL}/rest/v1/plant_overrides?id=eq.${encodeURIComponent(plantId)}&select=care_notes`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const overrides = ovResp.ok ? await ovResp.json() : [];
    const careNotes = overrides[0]?.care_notes || '';

    // 3. Latest photo
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
    if (!photoB64) {
      // Client will skip this plant — surface a distinct status so it can show "skipped: no photo"
      return res.status(409).json({ error: 'no_photo', message: 'Plant has no photo to verify against' });
    }

    // 4. Build the prompt — feed Claude the current record so it can echo
    //    fields back unchanged when nothing needs updating
    const recordedLines = [
      `Plant tracker record for review:`,
      `- Common name: ${plant.name}`,
      `- Variety / cultivar: ${plant.sub || '(not recorded)'}`,
      `- Scientific name: ${plant.sci || '(not recorded)'}`,
      `- Type: ${plant.type}`,
      `- Toxic to dogs: ${plant.toxic ? 'true' : 'false'}`,
      `- Water every: ${plant.water_every_days ? plant.water_every_days + ' days' : '(no schedule set)'}`,
      `- Feed every: ${plant.feed_every_days ? plant.feed_every_days + ' days' : '(no schedule set)'}`,
      `- Seasonal care: ${plant.seasonal_care ? 'true' : 'false'}`,
      `- Care notes: ${careNotes ? careNotes : '(empty)'}`,
    ];

    const promptText =
      "Verify this plant's record against the attached photo and propose fills or corrections.\n\n" +
      recordedLines.join('\n') + "\n\n" +
      "For each field, return either the current value (if you agree it's right) or your " +
      "proposed update. Set id_matches=true if the photo matches the recorded common+scientific " +
      "name. Set it to false ONLY when the species is clearly different — minor variety/cultivar " +
      "uncertainty does not flip id_matches to false.\n\n" +
      "If a field is blank or '(not recorded)' / '(empty)' / '(no schedule set)', propose a " +
      "reasonable value based on the species (cadence ballparks: succulents water 14-21d feed " +
      "60-90d, tropical foliage water 7-10d feed 30d, ferns water 3-5d feed 30d, herbs water " +
      "5-7d feed 30d, annual vegetables water 2-3d feed 14d).\n\n" +
      "For proposed_care_notes, if existing care_notes are present and cover the basics " +
      "(light/water/temp/pitfalls), echo them back verbatim. Only rewrite if they're missing " +
      "or genuinely wrong for this species. 2-4 short sentences, plain text, no bullets.\n\n" +
      "For visible_concerns, ONLY flag things the user might not have noticed: pests, disease, " +
      "root rot, sunburn, etiolation. Leave empty if the plant looks fine. This is not a " +
      "general status update.";

    // 5. Call Claude
    const anthropic = new Anthropic();
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: VERIFY_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoB64 } },
          { type: 'text', text: promptText },
        ],
      }],
    });

    const textBlock = message.content.find(b => b.type === 'text');
    const rawText = textBlock?.text || '';
    let result;
    try {
      result = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({ error: 'Failed to parse Claude response', rawText: rawText.slice(0, 500) });
    }

    // Echo current values back so the client can build a diff without
    // re-fetching the plant
    const current = {
      common_name: plant.name,
      variety: plant.sub || '',
      scientific_name: plant.sci || '',
      toxic_to_dogs: !!plant.toxic,
      seasonal_care: !!plant.seasonal_care,
      water_every_days: plant.water_every_days || null,
      feed_every_days: plant.feed_every_days || null,
      care_notes: careNotes,
    };

    return res.status(200).json({
      plantId,
      current,
      proposed: result,
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
