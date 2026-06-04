// Vercel serverless function — groups unlabeled plant photos by which
// look like the same individual plant. Used by the bulk uploader's
// auto-cluster flow.
//
// Stateless / incremental: the client builds a running cluster list across
// many batched calls. Each call sends the existing clusters (one centroid
// photo per cluster) and a batch of new photos. The API returns, for each
// new photo, either the id of the cluster it belongs to or null (= start
// a new cluster with the supplied label).
//
// Cost optimization:
//   - The existing-clusters block is cacheable. As clusters accrue across
//     batches, the cache prefix grows; Anthropic charges the cache-read
//     rate for the matching prefix.
//   - Client thumbnails images to ~500px before sending — vision tokens
//     scale with image area.
//
// Requires the same env vars as analyze-photo.js:
//   ANTHROPIC_API_KEY
//   PLANT_PASSPHRASE
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

// Vision calls on a batch of ~12 images plus the cached cluster centroids
// can run 20-40s — Vercel's default 10s cap would time out. Bump to 60s.
export const config = { maxDuration: 60 };

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          uid:        { type: 'integer' },
          clusterId:  { type: ['integer', 'null'] },
          newLabel:   { type: 'string', description: 'Short descriptive label for a NEW cluster (e.g. "small monstera in white pot"). Empty string if clusterId is not null.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          note:       { type: 'string', description: 'Short reason / which visual cue matched.' },
        },
        required: ['uid', 'clusterId', 'newLabel', 'confidence', 'note'],
        additionalProperties: false,
      }
    }
  },
  required: ['assignments'],
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

  const { cards, existingClusters } = req.body || {};
  if (!Array.isArray(cards) || cards.length === 0) return res.status(400).json({ error: 'cards required (array of {uid, dataUrl})' });
  if (!Array.isArray(existingClusters)) return res.status(400).json({ error: 'existingClusters required (array, can be empty)' });

  try {
    const userContent = [];

    // Existing clusters block (cached). Order is stable: by clusterId ascending.
    if (existingClusters.length === 0) {
      userContent.push({ type: 'text', text: 'No existing clusters yet — every card you assign will create a new one.' });
    } else {
      userContent.push({
        type: 'text',
        text: 'Existing clusters built so far. Each is shown with its id, label, and one representative photo. Assign each new card to the best-matching cluster id, or null to create a new one:'
      });
      for (const c of existingClusters) {
        userContent.push({ type: 'text', text: `Cluster ${c.id} — ${c.label || '(no label)'}` });
        userContent.push(imgBlock(c.centroid));
      }
      // Cache the entire existing-cluster prefix so future calls in the same
      // ~5 min window only pay cache-read price for it.
      userContent[userContent.length - 1].cache_control = { type: 'ephemeral' };
    }

    // New cards (fresh per call)
    userContent.push({
      type: 'text',
      text:
        "\nNew cards to assign. For each, decide:\n" +
        "  - clusterId: the id of an existing cluster this card belongs to, or null to start a new cluster.\n" +
        "  - newLabel: if clusterId is null, a short descriptive label (e.g. \"variegated pothos in terracotta\", \"snake plant tall\"). Empty string otherwise.\n" +
        "  - confidence: \"high\" (clearly same), \"medium\" (probably same), \"low\" (plausible).\n" +
        "  - note: one short sentence about the visual cue.\n\n" +
        "Be willing to assign cards to existing clusters at medium confidence — the user reviews everything and can correct mistakes. Only create a NEW cluster when no existing cluster is a reasonable fit. Two photos of the same plant at different angles, distances, lighting, or growth stages SHOULD share a cluster. Distinguishing cues that matter most: pot/container, room/location/background, distinctive variegation patterns, plant size, growth habit. Cues that vary normally and should NOT prevent matching: lighting, angle, zoom, focus, time of day, season.\n\n" +
        "Cards:"
    });
    for (const c of cards) {
      userContent.push({ type: 'text', text: `Card uid=${c.uid}:` });
      userContent.push(imgBlock(c.dataUrl));
    }

    const anthropic = new Anthropic();
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 3500,
      output_config: { format: { type: 'json_schema', schema: CLUSTER_SCHEMA } },
      system: [{
        type: 'text',
        text:
          "You are grouping unlabeled plant photos by which depict the SAME INDIVIDUAL PLANT — not the same species. " +
          "Two photos of the same plant taken at different angles, distances, lighting, focus, or growth stages belong in the same cluster. " +
          "Two different plants of the same species (e.g., two monsteras in different pots or locations) belong in DIFFERENT clusters. " +
          "Cues that strongly identify the same plant: pot/container, room/location/background, distinctive variegation patterns, plant size, growth habit, unique markings. " +
          "Cues that vary normally between photos and should NOT block a match: lighting, angle, zoom, focus, time of day. " +
          "Output strictly conforms to the supplied JSON schema. " +
          "Be willing to assign at medium confidence — the user reviews everything. Only create a new cluster when the card is clearly a different plant from every existing cluster.",
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{ role: 'user', content: userContent }]
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
      assignments: parsed.assignments || [],
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
