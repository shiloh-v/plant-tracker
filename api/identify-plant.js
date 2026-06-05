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
    },
    care_hint: {
      type: 'string',
      description: 'One short sentence with the most important care fact for this species (e.g. "Bright indirect light; let topsoil dry between waterings").'
    }
  },
  required: ['common_name', 'scientific_name', 'confidence', 'indoor_outdoor', 'toxic_to_dogs', 'alternatives', 'care_hint'],
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
              "Identify the plant species in this photo for a home gardener's plant tracker.\n\n" +
              "Return your best identification with a confidence level. If confidence is medium " +
              "or low, include 1–3 alternative species in the alternatives array.\n\n" +
              "For indoor_outdoor, pick the context this species is most commonly grown in for a " +
              "typical home gardener in temperate North America.\n\n" +
              "For toxic_to_dogs, set true only if the species is on the ASPCA toxic-to-dogs " +
              "list or has a well-known toxicity to canines. When unsure, set false.\n\n" +
              "care_hint should be a single short sentence with the most important care fact for " +
              "someone who just got this plant — light needs, watering frequency, or a critical " +
              "warning."
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
