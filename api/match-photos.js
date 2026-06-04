// Vercel serverless function — matches a batch of unlabeled card photos
// against a labeled reference set of the user's plants. Used by the bulk
// photo uploader's auto-cluster feature.
//
// Cost optimization:
//   - The reference set is sent with cache_control: 'ephemeral'. Anthropic
//     caches it for ~5 min, so subsequent batches in the same run pay ~10%
//     of normal input cost for the cached reference tokens.
//   - The client thumbnails images aggressively (refs ~200px, cards ~500px)
//     before sending — vision tokens scale with image area.
//   - Default batch is 20 cards per call so total call count stays low.
//
// Requires the same env vars as analyze-photo.js:
//   ANTHROPIC_API_KEY
//   PLANT_PASSPHRASE
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

// Vision calls on a batch of ~12 images plus the cached reference set can run
// 20-40s — Vercel's default 10s cap would time out. Bump to 60s.
export const config = { maxDuration: 60 };

// Structured-output schema. One row per input card; plantId may be null when
// the model isn't confident enough to commit.
const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          uid:        { type: 'integer' },
          plantId:    { type: ['string', 'null'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
          note:       { type: 'string', description: 'Short reason / which visual cue matched.' },
        },
        required: ['uid', 'plantId', 'confidence', 'note'],
        additionalProperties: false,
      }
    }
  },
  required: ['matches'],
  additionalProperties: false,
};

function imgBlock(dataUrl) {
  const m = (dataUrl || '').match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) throw new Error('Invalid dataUrl');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-plant-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const passphrase = req.headers['x-plant-key'];
  if (!process.env.PLANT_PASSPHRASE) return res.status(500).json({ error: 'Server misconfigured: PLANT_PASSPHRASE not set' });
  if (!passphrase || passphrase !== process.env.PLANT_PASSPHRASE) return res.status(401).json({ error: 'Invalid passphrase' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server misconfigured: ANTHROPIC_API_KEY not set' });

  const { cards, references } = req.body || {};
  if (!Array.isArray(cards) || cards.length === 0) return res.status(400).json({ error: 'cards required (array of {uid, dataUrl})' });
  if (!Array.isArray(references) || references.length === 0) return res.status(400).json({ error: 'references required (array of {id, name, sub?, dataUrl})' });

  try {
    // Reference content — cacheable. Each reference: a label line + the image.
    const refContent = [];
    refContent.push({
      type: 'text',
      text: "Reference set — these are the plants the user owns. Each entry is a labeled plant followed by its current photo:"
    });
    for (const r of references) {
      const label = `Plant ID: ${r.id} — ${r.name}${r.sub ? ' (' + r.sub + ')' : ''}`;
      refContent.push({ type: 'text', text: label });
      refContent.push(imgBlock(r.dataUrl));
    }
    // Cache the entire reference set
    refContent[refContent.length - 1].cache_control = { type: 'ephemeral' };

    // Card content — fresh per call
    const cardContent = [{
      type: 'text',
      text:
        "\nMatch each of the following cards to one of the Plant IDs above. " +
        "Use leaf shape and color, growth pattern, pot/container, location/background, " +
        "and variegation patterns. Different lighting and angles are fine. " +
        "Be conservative: if you can't pick a single best match, set plantId=null " +
        "and confidence=\"none\". confidence=\"high\" means clearly that plant, " +
        "\"medium\" means probable, \"low\" means a guess. " +
        "Provide one short sentence in note explaining the cue (e.g. \"variegated heart leaves, terracotta pot\")."
    }];
    for (const c of cards) {
      cardContent.push({ type: 'text', text: `Card uid=${c.uid}:` });
      cardContent.push(imgBlock(c.dataUrl));
    }

    const anthropic = new Anthropic();
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 3500,
      output_config: { format: { type: 'json_schema', schema: MATCH_SCHEMA } },
      system: [{
        type: 'text',
        text:
          "You are matching unlabeled plant photos to a labeled reference set of plants " +
          "the user owns. Output strictly conforms to the supplied JSON schema. " +
          "Prefer null over a wrong guess — the user reviews your output and would rather " +
          "manually assign a card than fix a confidently-wrong assignment.",
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{
        role: 'user',
        content: [...refContent, ...cardContent]
      }]
    });

    const textBlock = message.content.find(b => b.type === 'text');
    const rawText = textBlock?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({ error: 'Failed to parse Claude JSON response', rawText: rawText.slice(0, 800) });
    }

    return res.status(200).json({
      matches: parsed.matches || [],
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
