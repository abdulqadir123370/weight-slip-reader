// weight-slip-reader
// A small, single-purpose service: receives a photo of a printed digital-scale weight slip,
// asks Claude to read the weight off it, and returns structured JSON. Built to sit alongside
// your existing royal-plastics-bot on Railway — same deploy pattern, same idea (Claude doing
// one well-defined job behind a small server, key kept server-side).
//
// SECURITY NOTE: this endpoint is protected by a shared-secret header, not because the data
// is sensitive, but because every call costs you a small amount of Anthropic API usage — the
// secret stops a stranger who stumbles on this URL from running up your bill. It is NOT the
// same kind of secret as your Anthropic API key itself (that one stays server-side only, in
// this file's environment variables, and is never sent to the browser).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

const PORT = process.env.PORT || 8080;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHARED_SECRET = process.env.SHARED_SECRET;
// Comma-separated list, e.g. "https://abdulqadir123370.github.io,http://localhost:5500"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!ANTHROPIC_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY is not set — /read-slip will fail.');
if (!SHARED_SECRET) console.warn('⚠️  SHARED_SECRET is not set — the endpoint is effectively unprotected!');
if (ALLOWED_ORIGINS.length === 0) console.warn('⚠️  ALLOWED_ORIGIN is not set — CORS will block all browser requests.');

app.use(cors({
  origin: function(origin, callback) {
    // Allow server-to-server / curl calls with no Origin header (e.g. your own health checks),
    // but browser requests must come from an allow-listed origin.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed: ' + origin));
  }
}));
app.use(express.json({ limit: '12mb' })); // base64 photos inflate ~33% over the raw file size

// Modest rate limit — a normal work day of sale entries is nowhere near this; it exists purely
// to cap worst-case cost if the URL ever leaks or gets hit by something automated.
app.use('/read-slip', rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Rate limit reached. Try again shortly.' }
}));

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!SHARED_SECRET || token !== SHARED_SECRET) {
    console.warn('Rejected request: secret mismatch or missing.', {
      hasServerSecret: !!SHARED_SECRET,
      gotToken: token ? `${token.slice(0,4)}...(${token.length} chars)` : '(none)'
    });
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/read-slip', requireAuth, async (req, res) => {
  try {
    const { image, mediaType } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing "image" (base64 string) in request body.' });
    }
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const mt = validTypes.includes(mediaType) ? mediaType : 'image/jpeg';

    const prompt = `You are reading a photo of a printed receipt from a digital weighing scale. It records the weight of a wastage material (Bhusa, Patti, or Gitta — by-products from wooden broom manufacturing) being sold by weight.

Look at the image and extract:
- netWeightKg: the NET weight in kilograms. If the slip shows gross/tare/net weights, use NET specifically. If only one weight is printed, use that one. If the unit shown isn't KG, convert it to KG.
- slipDate: any printed date on the slip, formatted YYYY-MM-DD, or null if none is visible.
- slipNumber: any printed ticket/slip/receipt number, or null if none is visible.
- confidence: "high", "medium", or "low", based on how clearly you could read the weight number specifically.
- notes: a short note if anything was ambiguous or you had to guess — otherwise an empty string.

Respond with ONLY a JSON object and nothing else — no markdown code fences, no explanation before or after.

If you cannot find any clear weight value anywhere on the slip, respond with netWeightKg: null and explain what you do see in "notes".`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mt, data: image } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text().catch(() => '');
      console.error('Anthropic API error:', apiRes.status, errBody.slice(0, 500));
      return res.status(502).json({ success: false, error: 'Could not reach the reading service right now.' });
    }

    const data = await apiRes.json();
    const rawText = (data.content || []).map(b => b.text || '').join('').trim();

    let parsed;
    try {
      const cleaned = rawText.replace(/^```json\s*|^```\s*|```\s*$/gm, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse model output as JSON:', rawText.slice(0, 300));
      return res.status(502).json({ success: false, error: 'Got an unreadable response from the reading model.' });
    }

    return res.json({
      success: true,
      netWeightKg: typeof parsed.netWeightKg === 'number' ? parsed.netWeightKg : null,
      slipDate: parsed.slipDate || null,
      slipNumber: parsed.slipNumber || null,
      confidence: parsed.confidence || 'low',
      notes: parsed.notes || ''
    });
  } catch (e) {
    console.error('Unexpected error in /read-slip:', e);
    return res.status(500).json({ success: false, error: 'Unexpected server error.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`weight-slip-reader listening on 0.0.0.0:${PORT}`);
});
