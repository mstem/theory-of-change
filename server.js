import express from 'express';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4kb' }));


app.use(express.static(join(__dirname, 'public')));

const MAX_INPUT_LEN = 200;
const CACHE_MAX = 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const CACHE_DIR = join(__dirname, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'analyze-cache.json');

function loadCacheFromDisk() {
  try {
    const arr = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (!Array.isArray(arr)) return;
    const now = Date.now();
    for (const entry of arr) {
      if (entry && typeof entry.key === 'string' && typeof entry.text === 'string' && typeof entry.t === 'number') {
        if (now - entry.t <= CACHE_TTL_MS) cache.set(entry.key, { text: entry.text, t: entry.t });
      }
    }
    console.log(`Loaded ${cache.size} analyze cache entries from disk`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Cache load failed:', err.message);
  }
}

let saveTimer = null;
function scheduleCacheSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      const arr = [];
      for (const [key, { text, t }] of cache.entries()) arr.push({ key, text, t });
      const tmp = CACHE_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(arr));
      renameSync(tmp, CACHE_FILE);
    } catch (err) {
      console.warn('Cache save failed:', err.message);
    }
  }, 2000);
}

loadCacheFromDisk();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > CACHE_TTL_MS) {
    cache.delete(key);
    scheduleCacheSave();
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.text;
}

function cacheSet(key, text) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { text, t: Date.now() });
  scheduleCacheSave();
}

const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' }
});

app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  const { action, change } = req.body || {};
  if (typeof action !== 'string' || typeof change !== 'string' || !action.trim() || !change.trim()) {
    return res.status(400).json({ error: 'action and change are required' });
  }
  if (action.length > MAX_INPUT_LEN || change.length > MAX_INPUT_LEN) {
    return res.status(400).json({ error: `action and change must be ${MAX_INPUT_LEN} characters or fewer` });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set. Restart the server with: ANTHROPIC_API_KEY=your_key npm start' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const cacheKey = `${action.toLowerCase().trim()}|||${change.toLowerCase().trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.write(`data: ${JSON.stringify({ chunk: cached })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    return res.end();
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are an expert in social change theory, history, and empirical research. Analyze this theory of change: "Doing '${action}' will create '${change}' in the world."

Be specific — cite real movements, researchers, and cases. Be concise: 1-2 sentences per field, short titles. Each array must have exactly 3 items.

Score 70–100 as Strong if there is robust peer-reviewed evidence across multiple contexts; 40–69 as Moderate if evidence exists but is mixed or context-dependent; 10–39 as Weak if evidence is thin or contested; 0–9 as Speculative if there is little to no empirical basis.

Return ONLY valid JSON:
{
  "strength": <integer 0-100>,
  "strength_label": "<Strong | Moderate | Weak | Speculative>",
  "summary": "<2 sentences>",
  "assumptions": ["<assumption>", ...x3],
  "mechanisms": ["<mechanism>", ...x3],
  "evidence_for": [{"title": "<short>", "description": "<1-2 sentences>", "source": "<name>"}, ...x3],
  "evidence_against": [{"title": "<short>", "description": "<1-2 sentences>", "source": "<name>"}, ...x3],
  "historical_examples": [{"name": "<movement>", "period": "<dates>", "outcome": "<1 sentence>", "relevance": "<1 sentence>"}, ...x3],
  "probing_questions": ["<question>", ...x3]
}`;

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });

    let full = '';
    stream.on('text', (text) => {
      full += text;
      res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
    });

    stream.on('finalMessage', () => {
      cacheSet(cacheKey, full);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

const FEEDBACK_TO = process.env.FEEDBACK_TO || '';
const FEEDBACK_FROM = process.env.FEEDBACK_FROM || 'Theory of Change <onboarding@resend.dev>';
const MAX_FEEDBACK_LEN = 4000;

const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many feedback submissions. Please try again later.' }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

app.post('/api/feedback', feedbackLimiter, async (req, res) => {
  const { message, email } = req.body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'A message is required.' });
  }
  if (message.length > MAX_FEEDBACK_LEN) {
    return res.status(400).json({ error: `Message must be ${MAX_FEEDBACK_LEN} characters or fewer.` });
  }
  const replyTo = typeof email === 'string' ? email.trim() : '';
  if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
    return res.status(400).json({ error: 'That email address does not look valid.' });
  }

  if (!process.env.RESEND_API_KEY || !FEEDBACK_TO) {
    return res.status(500).json({ error: 'Feedback is not configured: RESEND_API_KEY and FEEDBACK_TO must be set.' });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
    const safeReply = replyTo ? escapeHtml(replyTo) : '(not provided)';

    const { error } = await resend.emails.send({
      from: FEEDBACK_FROM,
      to: [FEEDBACK_TO],
      subject: 'Theory of Change app',
      ...(replyTo ? { replyTo } : {}),
      text: `Feedback from the Theory of Change app:\n\n${message}\n\n— Reply-to: ${replyTo || '(not provided)'}`,
      html: `<p><strong>Feedback from the Theory of Change app:</strong></p><p>${safeMessage}</p><hr><p style="color:#6B7280;font-size:0.85rem">Reply-to: ${safeReply}</p>`
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(502).json({ error: 'Email service rejected the message.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Feedback send failed:', err);
    return res.status(500).json({ error: 'Could not send feedback right now.' });
  }
});

// ─── Source URL lookup (lazy, on-demand) ─────────────────────────────────────
// The main /api/analyze response intentionally omits URLs to keep streaming fast.
// The frontend calls this endpoint when a user clicks the "source" affordance.
const SOURCE_URL_CACHE_MAX = 2000;
const SOURCE_URL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sourceUrlCache = new Map();
const MAX_SOURCE_LEN = 200;
const MAX_CONTEXT_LEN = 600;

const sourceUrlLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many source lookups. Please wait a few minutes and try again.' }
});

app.post('/api/source-url', sourceUrlLimiter, async (req, res) => {
  const { source, context } = req.body || {};
  if (typeof source !== 'string' || !source.trim()) {
    return res.status(400).json({ error: 'source is required' });
  }
  if (source.length > MAX_SOURCE_LEN) {
    return res.status(400).json({ error: `source must be ${MAX_SOURCE_LEN} characters or fewer` });
  }
  const ctx = typeof context === 'string' ? context.slice(0, MAX_CONTEXT_LEN) : '';

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });
  }

  const key = `${source.toLowerCase().trim()}|||${ctx.toLowerCase().trim()}`;
  const cached = sourceUrlCache.get(key);
  if (cached && Date.now() - cached.t <= SOURCE_URL_CACHE_TTL_MS) {
    sourceUrlCache.delete(key);
    sourceUrlCache.set(key, cached);
    return res.json({ url: cached.url });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `Find the canonical homepage or primary web page for this cited source: "${source}"
Context where they were cited: "${ctx}"

Return ONLY valid JSON: {"url": "<https URL>"}
- For a person: their faculty/personal page, or their Wikipedia page if more authoritative
- For an organization or institution: their official website (NOT Wikipedia)
- For a book, paper, or study: prefer the publisher/journal page, the author's page, or a stable DOI link
- If you are not highly confident the URL is real and current, return "".`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content?.[0]?.text || '';
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || '{}';
    let url = '';
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.url === 'string' && /^https?:\/\//i.test(parsed.url.trim())) {
        url = parsed.url.trim();
      }
    } catch { /* fall through with empty url */ }

    if (sourceUrlCache.size >= SOURCE_URL_CACHE_MAX) {
      const oldest = sourceUrlCache.keys().next().value;
      if (oldest !== undefined) sourceUrlCache.delete(oldest);
    }
    sourceUrlCache.set(key, { url, t: Date.now() });
    return res.json({ url });
  } catch (err) {
    console.warn('source-url lookup failed:', err.message || err);
    return res.status(502).json({ error: 'Lookup failed' });
  }
});

// ─── Recommend proxy ──────────────────────────────────────────────────────────
// Forwards page requests to the curator backend which talks to Claude + Airtable.
// Keeps the curator URL and shared origin server-side, never exposed to the page.
// Set CURATOR_API_URL (e.g. https://curator.fly.dev) and CURATOR_ORIGIN_HEADER
// (must match one of curator's RECOMMEND_ALLOWED_ORIGINS values).
const CURATOR_API_URL       = process.env.CURATOR_API_URL || '';
const CURATOR_ORIGIN_HEADER = process.env.CURATOR_ORIGIN_HEADER || '';

app.post('/api/recommend', async (req, res) => {
  if (!CURATOR_API_URL) return res.json({ categories: [] });
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) return res.json({ categories: [] });
  const limit = Math.max(1, Math.min(3, parseInt(req.body?.limit, 10) || 3));

  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 25000);
    const upstream = await fetch(`${CURATOR_API_URL.replace(/\/$/, '')}/api/recommend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CURATOR_ORIGIN_HEADER ? { Origin: CURATOR_ORIGIN_HEADER } : {}),
      },
      body: JSON.stringify({ text: text.slice(0, 5000), limit }),
      signal: ctrl.signal,
    });
    clearTimeout(timeoutId);
    if (!upstream.ok) {
      console.warn(`recommend proxy: upstream ${upstream.status}`);
      return res.json({ categories: [] });
    }
    const data = await upstream.json();
    return res.json(data);
  } catch (err) {
    console.warn('recommend proxy: error', err.message || err);
    return res.json({ categories: [] });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Theory of Change running at http://localhost:${PORT}`));
