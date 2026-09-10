import express from 'express';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import { detectFromRequest, bundleKey } from 'localize';
import { getBundle, referenceBundle, REFERENCE_KEY, listBundles } from './lib/i18n.js';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(morgan('combined', { skip: () => process.env.NODE_ENV === 'test' }));
app.use(express.json({ limit: '4kb' }));

// The page ships one inline <script> (the analytics bootstrap), so script-src
// carries its sha256 hash. Hashing index.html at boot instead of pasting literal
// hashes means the policy cannot go stale when the page changes. Inline style
// attributes are generated in the render path (bar heights, strength colours),
// which no hash can cover, so style-src keeps 'unsafe-inline'; script execution
// stays blocked either way.
//
// Only executable scripts are hashed. A <script type="application/json"> block is
// data the browser never runs, so CSP's inline check never reaches it. Hashing
// one would add a hash for content that is never executed, and would break the
// moment that data is built per request rather than read from disk at boot.
const JS_MIME_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript',
  'application/x-javascript', 'text/ecmascript', 'text/javascript',
  'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5',
  'text/jscript', 'text/livescript', 'text/x-ecmascript', 'text/x-javascript'
]);

// An import map is covered by script-src even though it executes no code of its
// own, so it counts as executable here.
function isExecutableScript(attrs) {
  // Anchored to a whitespace boundary rather than \b, which also matches after
  // the hyphen in data-type — a script carrying data-type="application/json"
  // would then be read as a data block and silently left out of script-src.
  const type = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  if (!type) return true;
  const value = (type[1] ?? type[2] ?? type[3] ?? '').trim().toLowerCase();
  if (value === '' || value === 'module' || value === 'importmap') return true;
  return JS_MIME_TYPES.has(value.split(';')[0].trim());
}

function inlineScriptHashes(html) {
  const inlineScript = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  return [...html.matchAll(inlineScript)]
    .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs) && isExecutableScript(attrs))
    .map(([, , body]) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}

// JSON.stringify leaves < > & untouched, so a value containing </script> would
// close the block it is embedded in. These values include model output, so they
// are escaped to \u form. U+2028 and U+2029 are legal raw inside JSON strings but
// are line terminators to a JavaScript parser, so they go too.
function serializeJsonBlock(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildCsp(html) {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')} https://www.googletagmanager.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://www.googletagmanager.com https://*.google-analytics.com",
    "font-src 'self'",
    "connect-src 'self' https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'"
  ].join('; ');
}

const INDEX_PATH = join(__dirname, 'public', 'index.html');

let indexHtml = '';
let csp = '';
try {
  indexHtml = readFileSync(INDEX_PATH, 'utf8');
  csp = buildCsp(indexHtml);
} catch (err) {
  console.warn('CSP build failed, serving without one:', err.message);
}

app.use((req, res, next) => {
  if (csp) res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  // Only over TLS: on plain-HTTP local dev the header is meaningless, and
  // pinning it there would break running the app on http://localhost.
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});



// The page is rendered per language rather than served off disk, so the lang
// and dir attributes, the social metadata and the string bundle are all correct
// in the first byte. Doing it client-side instead would show a flash of English
// and would move a contenteditable field the visitor may already be typing in.
//
// Registered before express.static, and matched on exact paths rather than as a
// catch-all, or unknown paths would stop 404ing.
const RENDER_CACHE_MAX = 32;
const renderCache = new Map();

// Keyed by bundle key, not by the full tag: the page is in Portuguese, not
// specifically pt-PT, and it bounds the cache to the number of languages
// instead of the thousands of tags a browser might send.
function renderIndex(key) {
  if (renderCache.has(key)) return renderCache.get(key);

  const reference = referenceBundle();
  const bundle = key === REFERENCE_KEY ? reference : getBundle(key) ?? reference;
  const language = bundle === reference ? REFERENCE_KEY : key;
  const dir = bundle._meta?.dir === 'rtl' ? 'rtl' : 'ltr';
  const t = (name) => bundle[name] ?? reference[name] ?? '';

  const payload = {
    locale: { tag: language, dir, bundleKey: key },
    strings: bundle
  };

  // Every replacement below is a function, never a string. Translated copy goes
  // into these, and in a replacement string `$&`, `$\`` and `$'` are still
  // expanded after escapeHtml has run — escapeHtml covers &<>"' and not $ — so a
  // bundle containing `$'` would splice the rest of the document into an
  // attribute. A replacer function is inserted verbatim.
  let html = indexHtml
    .replace('<html lang="en">', () => `<html lang="${escapeHtml(language)}" dir="${dir}">`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escapeHtml(t('meta.title'))}</title>`);

  const metas = [
    ['name', 'description', t('meta.description')],
    ['property', 'og:title', t('meta.socialTitle')],
    ['property', 'og:description', t('meta.description')],
    ['name', 'twitter:title', t('meta.socialTitle')],
    ['name', 'twitter:description', t('meta.description')]
  ];
  for (const [attribute, name, value] of metas) {
    const pattern = new RegExp(`<meta ${attribute}="${name}" content="[^"]*">`);
    html = html.replace(pattern, () => `<meta ${attribute}="${name}" content="${escapeHtml(value)}">`);
  }
  html = html.replace('<meta property="og:type" content="website">',
    () => `<meta property="og:type" content="website">\n<meta property="og:locale" content="${escapeHtml(language)}">`);

  // A data block, not a script: the browser never executes it, so CSP's inline
  // check never reaches it and no hash is needed. serializeJsonBlock is what
  // stops a translated string containing </script> from closing the element.
  html = html.replace('<script src="/app.js"></script>',
    () => `<script type="application/json" id="i18n">${serializeJsonBlock(payload)}</script>\n<script src="/app.js"></script>`);

  if (renderCache.size >= RENDER_CACHE_MAX) renderCache.delete(renderCache.keys().next().value);
  renderCache.set(key, html);
  return html;
}

app.get(['/', '/index.html'], (req, res, next) => {
  if (!indexHtml) return next();

  // Without an available list, negotiation hands back the top well-formed entry
  // whether or not a bundle exists for it, so a reader who also accepts a
  // language we do have gets English instead.
  const detected = detectFromRequest(req, { available: listBundles() });
  const key = bundleKey(detected.language.tag) ?? REFERENCE_KEY;

  // Both inputs to the choice are request headers, so a shared cache in front
  // of this would otherwise serve one visitor's language to the next.
  res.setHeader('Vary', 'Accept-Language, Cookie');
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(renderIndex(key));
});

app.use(express.static(join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(woff2?|ttf|png|jpg|jpeg|svg|ico|webp)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    }
  }
}));

const MAX_INPUT_LEN = 200;
const CACHE_MAX = 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const CACHE_DIR = process.env.CACHE_DIR || join(__dirname, '.cache');
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
  // The listening socket keeps the process alive in production, so unref only
  // matters for short-lived processes (tests, scripts) that must be free to exit.
  saveTimer.unref?.();
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
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
      max_tokens: 4096,
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
      console.error('analyze stream error:', err);
      res.write(`data: ${JSON.stringify({ error: 'Analysis failed. Please try again.' })}\n\n`);
      res.end();
    });
  } catch (err) {
    console.error('analyze error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Analysis failed. Please try again.' })}\n\n`);
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

// Pulls the URL out of the model's reply. Returns '' for anything that is not a
// well-formed http(s) URL, so a malformed reply degrades to "no link" not a crash.
function parseSourceUrl(text) {
  // Each brace-delimited object is tried separately, latest first. A single
  // greedy match would run from the first brace to the last, so any prose the
  // model puts around the answer — likelier now that it narrates a search —
  // would swallow the JSON and fail to parse.
  const candidates = String(text ?? '').match(/\{[^{}]*\}/g) || [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(candidates[i]);
    } catch { continue; }
    const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '';
    if (/^https?:\/\//i.test(url)) return url;
  }
  return '';
}

// The reply now arrives as a mix of block types — the search Claude ran, the
// results it came back with, and its own prose — so the JSON can sit anywhere.
// Only text blocks are joined: folding a result block into the string would give
// parseSourceUrl's greedy brace match a span it cannot parse.
function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// An empty URL is a fine thing to remember for a week when the model looked and
// found nothing. A paused search turn or a reply cut off at the token cap looks
// identical from the outside and is not — caching those would keep the failure
// long after a retry would have worked.
function isConclusiveLookup(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.stop_reason !== 'end_turn') return false;
  return textFromContent(msg.content).trim() !== '';
}

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
  const prompt = `Search the web for the specific thing this citation points to: "${source}"
Context where it was cited: "${ctx}"

Find the page for that exact report, paper, study, dataset, or article — not the
publisher's front door. A link to an organization's homepage is a failed lookup.

Return ONLY valid JSON: {"url": "<https URL>"}
- Return a URL only if it appeared in your search results. Never assemble one from a
  pattern you expect a site to use.
- For a report, paper, study, or article: the page for that document, or its DOI.
- For a person: the page about the work cited, or failing that their faculty or personal page.
- For an organization cited without a named document: the page covering the work described
  in the context above, and only if you found one.
- If the search did not turn up the document itself, return "".`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      // Search results and their citation blocks do not fit in a couple of hundred
      // tokens; hitting the cap truncates the JSON and reads as "no link found".
      max_tokens: 1024,
      // 20250305 is the basic tool. The later variants run search from inside code
      // execution, which this model cannot do.
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
      messages: [{ role: 'user', content: prompt }]
    });
    const url = parseSourceUrl(textFromContent(msg.content));

    if (isConclusiveLookup(msg)) {
      if (sourceUrlCache.size >= SOURCE_URL_CACHE_MAX) {
        const oldest = sourceUrlCache.keys().next().value;
        if (oldest !== undefined) sourceUrlCache.delete(oldest);
      }
      sourceUrlCache.set(key, { url, t: Date.now() });
    }
    return res.json({ url });
  } catch (err) {
    console.warn('source-url lookup failed:', err.message || err);
    return res.status(502).json({ error: 'Lookup failed' });
  }
});

// ─── Recommend proxy ──────────────────────────────────────────────────────────
// Forwards page requests to the curator backend which talks to Claude + Airtable.
// Keeps the curator URL and shared origin server-side, never exposed to the page.
// Set CURATOR_API_URL (e.g. https://curator.civictech.guide) and CURATOR_ORIGIN_HEADER
// (must match one of curator's RECOMMEND_ALLOWED_ORIGINS values).
const CURATOR_API_URL       = process.env.CURATOR_API_URL || '';
const CURATOR_ORIGIN_HEADER = process.env.CURATOR_ORIGIN_HEADER || '';

const recommendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { categories: [] }
});

app.post('/api/recommend', recommendLimiter, async (req, res) => {
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

// Bots send out-of-bounds Range headers; return 416 correctly but skip stderr logging.
app.use((err, req, res, next) => {
  if (err.status === 416) {
    return res.status(416).set('Content-Range', res.getHeader('Content-Range') || 'bytes */*').end();
  }
  next(err);
});

// Only bind a port when run directly (`npm start`). Importing this module for
// tests gives you `app` without a listening socket or a hardcoded port.
// import.meta.main needs Node >= 24.2 and the container still runs Node 22,
// where it is `undefined` — the argv fallback keeps the server listening there.
const isEntryPoint = import.meta.main
  ?? (!!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => console.log(`Theory of Change running at http://localhost:${PORT}`));
}

export { app, buildCsp, inlineScriptHashes, serializeJsonBlock, renderIndex, escapeHtml, parseSourceUrl, textFromContent, isConclusiveLookup, cacheGet, cacheSet, cache, loadCacheFromDisk, CACHE_MAX, CACHE_TTL_MS };
