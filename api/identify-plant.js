// Vercel serverless function — identifies the species in a plant photo.
// Used by the "Add Plant" form to pre-fill name + scientific name + type +
// toxic flag from a single photo upload, so the user doesn't have to type
// everything by hand for a new acquisition.
//
// Gated by the same x-plant-key passphrase as /api/analyze-photo.
//
// Requires env vars (set in Vercel dashboard):
//   ANTHROPIC_API_KEY  — from console.anthropic.com
//   PLANT_PASSPHRASE   — same value that's in your Supabase plant_key_ok()
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

const ID_SCHEMA = {
  type: 'object',
  properties: {
    common_name: {
      type: 'string',
      description: 'Most-likely common name (e.g. "Monstera", "African Violet").'
    },
    variety: {
      type: 'string',
      description: 'Cultivar or variety name if visible from distinctive features (e.g. "Albo Variegata", "Sizzle"). Empty string if not identifiable.'
    },
    scientific_name: {
      type: 'string',
      description: 'Full scientific name including variety/cultivar if visible (e.g. "Monstera deliciosa", "Saintpaulia ionantha").'
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'high = clearly identifiable; medium = best guess; low = could be several things.'
    },
    indoor_outdoor: {
      type: 'string',
      enum: ['indoor', 'outdoor'],
      description: 'Most common growing context for this species in temperate North America.'
    },
    toxic_to_dogs: {
      type: 'boolean',
      description: 'True if the species is known to be toxic to dogs (ASPCA list or similar).'
    },
    seasonal_care: {
      type: 'boolean',
      description: 'True if care needs shift meaningfully in fall/winter (succulents needing dormancy, deciduous tropicals, annuals that die in frost, outdoor plants in temperate zones).'
    },
    water_every_days: {
      type: 'integer',
      description: 'Starting watering cadence in days for a typical indoor/outdoor setup (must be between 1 and 180). Be realistic: succulents 14-21, tropicals 5-10, ferns 3-5, annual vegetables 2-3.'
    },
    feed_every_days: {
      type: 'integer',
      description: 'Starting feeding cadence in days (must be between 7 and 365). Conservative — better to under-feed than burn roots. Succulents 60-90, tropicals 30, annual veg 14, slow growers 60+.'
    },
    care_notes: {
      type: 'string',
      description: 'Sticky care directives — temperature limits, watering style, light needs, common pitfalls. 2-4 short sentences, no bullets. Things that should never change. NOT a current-condition observation. Example: "Bright indirect light. Allow top inch to dry between waterings. Keep above 60°F. Susceptible to spider mites in dry indoor air."'
    },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          common_name: { type: 'string' },
          scientific_name: { type: 'string' }
        },
        required: ['common_name', 'scientific_name'],
        additionalProperties: false
      },
      description: 'Up to 3 other species this could be, if confidence is low or medium.'
    }
  },
  required: ['common_name', 'variety', 'scientific_name', 'confidence', 'indoor_outdoor', 'toxic_to_dogs', 'seasonal_care', 'water_every_days', 'feed_every_days', 'care_notes', 'alternatives'],
  additionalProperties: false
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-plant-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Passphrase gate
  if (!process.env.PLANT_PASSPHRASE) {
    return res.status(500).json({ error: 'Server misconfigured: PLANT_PASSPHRASE not set' });
  }
  const passphrase = req.headers['x-plant-key'];
  if (!passphrase || passphrase !== process.env.PLANT_PASSPHRASE) {
    return res.status(401).json({ error: 'Invalid passphrase' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: ANTHROPIC_API_KEY not set' });
  }

  // Body: { photo: "<base64>", media_type: "image/jpeg" }
  // Limit base64 payload to ~5 MB (Vercel default body size limit varies)
  const { photo, media_type } = req.body || {};
  if (!photo || typeof photo !== 'string') {
    return res.status(400).json({ error: 'photo (base64 string) required' });
  }
  if (photo.length > 5_500_000) {
    return res.status(413).json({ error: 'Photo too large — compress to <4MB before sending' });
  }
  const mediaType = (typeof media_type === 'string' && /^image\/(jpeg|png|webp|gif)$/.test(media_type))
    ? media_type
    : 'image/jpeg';

  try {
    const anthropic = new Anthropic();
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: ID_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: photo } },
          {
            type: 'text',
            text:
              "Identify the plant species in this photo for a home gardener's plant tracker and pre-fill the new-plant form.\n\n" +
              "Return your best species ID + variety (if visible) with a confidence level. " +
              "If confidence is medium or low, include 1–3 alternative species in the alternatives array.\n\n" +
              "For indoor_outdoor, pick the context this species is most commonly grown in for a " +
              "typical home gardener in temperate North America.\n\n" +
              "For toxic_to_dogs, set true only if the species is on the ASPCA toxic-to-dogs list " +
              "or has a well-known toxicity to canines. When unsure, set false.\n\n" +
              "For seasonal_care, set true if care needs shift meaningfully in fall/winter — true " +
              "for succulents/cacti, deciduous tropicals, annuals, and most outdoor plants. False " +
              "for indoor tropicals that stay consistent year-round (Pothos, Monstera, Spider, etc.).\n\n" +
              "For water_every_days and feed_every_days, give realistic starting cadences this " +
              "specific species would need. Common ballparks:\n" +
              "  - Succulents/cacti: water 14-21d, feed 60-90d\n" +
              "  - Tropical foliage (Pothos, Monstera, Philodendron): water 7-10d, feed 30d\n" +
              "  - Thirsty plants (Maidenhair fern, Fittonia): water 3-5d, feed 30d\n" +
              "  - Herbs in containers: water 5-7d, feed 30d\n" +
              "  - Annual vegetables (tomato, basil): water 2-3d, feed 14d\n" +
              "  - Self-watering containers: use reservoir top-off interval (5-7d).\n\n" +
              "For care_notes, write 2-4 short sticky directives the user should keep in mind " +
              "forever about this species: light needs, watering style, temperature limits, common " +
              "pitfalls. Plain text, no bullets, no leading emojis. These are durable instructions, " +
              "NOT a current-condition observation."
          }
        ]
      }]
    });

    const textBlock = message.content.find(b => b.type === 'text');
    const rawText = textBlock?.text || '';
    let result;
    try {
      result = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({ error: 'Failed to parse Claude response', rawText: rawText.slice(0, 500) });
    }

    return res.status(200).json({ identification: result, usage: message.usage });
  } catch (err) {
    if (err && typeof err.status === 'number') {
      console.error('Anthropic error:', err.status, err.message);
      return res.status(502).json({ error: 'Claude API error', status: err.status, message: err.message });
    }
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
}
