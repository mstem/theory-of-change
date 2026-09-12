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

// Opus 4.8 list prices, in dollars. A search costs $10 per thousand on top of the
// tokens its results bring back with them, and those tokens are the larger half.
const PRICE_PER_INPUT_TOKEN = 5 / 1e6;
const PRICE_PER_OUTPUT_TOKEN = 25 / 1e6;
const PRICE_PER_CACHE_READ_TOKEN = 0.5 / 1e6;
const PRICE_PER_CACHE_WRITE_TOKEN = 6.25 / 1e6;
const PRICE_PER_SEARCH = 10 / 1000;

function analysisCost(usage) {
  const u = usage || {};
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  return n(u.input_tokens) * PRICE_PER_INPUT_TOKEN
    + n(u.output_tokens) * PRICE_PER_OUTPUT_TOKEN
    + n(u.cache_read_input_tokens) * PRICE_PER_CACHE_READ_TOKEN
    + n(u.cache_creation_input_tokens) * PRICE_PER_CACHE_WRITE_TOKEN
    + n(u.server_tool_use && u.server_tool_use.web_search_requests) * PRICE_PER_SEARCH;
}

// What one day of new analyses may cost. Past it, anything already in the cache
// still answers and anything new waits for tomorrow. The figure is kept on disk
// beside the cache: a redeploy in the middle of a runaway day would otherwise hand
// the next visitor a fresh budget.
const DAILY_BUDGET_USD = Number(process.env.DAILY_BUDGET_USD || 25);
// Citation lookups cost cents rather than dollars, fire several times on one page,
// and need no account, so on a shared ceiling an afternoon of clicking could spend
// the day the analyses needed. They get a slice instead, which leaves an analysis
// with at least DAILY_BUDGET_USD minus this figure however busy the lookups get.
const DAILY_LOOKUP_BUDGET_USD = Number(process.env.DAILY_LOOKUP_BUDGET_USD || 5);
let spend = { day: '', usd: 0, lookupUsd: 0 };

function utcDay(now) { return new Date(now).toISOString().slice(0, 10); }

function recordSpend(usd, now = Date.now(), purpose = 'analysis') {
  const day = utcDay(now);
  if (spend.day !== day) spend = { day, usd: 0, lookupUsd: 0 };
  spend.usd += usd;
  if (purpose === 'lookup') spend.lookupUsd += usd;
  saveSpendToDisk();
  return spend.usd;
}

function spentToday(now = Date.now()) {
  return spend.day === utcDay(now) ? spend.usd : 0;
}

function spentOnLookupsToday(now = Date.now()) {
  return spend.day === utcDay(now) ? spend.lookupUsd : 0;
}

// An analysis runs for minutes and only reports what it cost at the end. Charging
// the day then leaves a window in which every request that starts reads a budget
// that the analyses already running have committed and not yet reported. So the
// day is charged an estimate up front and corrected once the real figure arrives.
const ANALYSIS_ESTIMATE_USD = 0.3;

// Takes a purpose and an estimate so lookups can reserve against their slice the
// same way analyses reserve against the day. Called with no arguments it behaves
// exactly as before, which is how the analyze path still calls it.
function reserveSpend(now = Date.now(), purpose = 'analysis', estimateUsd = ANALYSIS_ESTIMATE_USD) {
  recordSpend(estimateUsd, now, purpose);
  return { usd: estimateUsd, day: utcDay(now), purpose };
}

// A run that never reports back keeps its estimate. It had already paid for its
// searches and its tokens by then, so forgetting it would understate the day.
function settleSpend(reservation, actualUsd, now = Date.now()) {
  const purpose = reservation?.purpose ?? 'analysis';
  if (!reservation || reservation.day !== utcDay(now)) return recordSpend(actualUsd, now, purpose);
  return recordSpend(actualUsd - reservation.usd, now, purpose);
}

function budgetExhausted(now = Date.now(), purpose = 'analysis') {
  if (spentToday(now) >= DAILY_BUDGET_USD) return true;
  return purpose === 'lookup' && spentOnLookupsToday(now) >= DAILY_LOOKUP_BUDGET_USD;
}

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

const SPEND_FILE = join(CACHE_DIR, 'daily-spend.json');

function loadSpendFromDisk() {
  try {
    const d = JSON.parse(readFileSync(SPEND_FILE, 'utf8'));
    if (d && typeof d.day === 'string' && typeof d.usd === 'number') {
      // A hand-edited or corrupted figure below zero would disable the ceiling for
      // the rest of the day, which is the one thing this file must not be able to do.
      spend = {
        day: d.day,
        usd: Math.max(0, d.usd),
        lookupUsd: Math.max(0, typeof d.lookupUsd === 'number' ? d.lookupUsd : 0)
      };
    }
    if (spentToday() > 0) console.log(`Spent so far today: $${spentToday().toFixed(2)} of $${DAILY_BUDGET_USD}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Spend load failed:', err.message);
  }
}

function saveSpendToDisk() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(SPEND_FILE, JSON.stringify(spend));
  } catch (err) {
    console.warn('Spend save failed:', err.message);
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
loadSpendFromDisk();

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

// How many searches one analysis may run. Each costs about $0.02 and four to five
// seconds of the wait before the first token.
const ANALYZE_SEARCH_MAX_USES = 3;

const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Each uncached analysis costs real money now, so this is a spend limit as much
  // as an abuse limit. Five is about as many theories as one sitting produces.
  max: 5,
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

  if (budgetExhausted()) {
    console.warn(`analyze refused: $${spentToday().toFixed(2)} spent today against a $${DAILY_BUDGET_USD} budget`);
    res.write(`data: ${JSON.stringify({ error: "Today's limit on new analyses has been reached. Theories already explored today still load, and new ones resume tomorrow." })}\n\n`);
    return res.end();
  }

  const reservation = reserveSpend();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are an expert in social change theory, history, and empirical research. Analyze this theory of change: "Doing '${action}' will create '${change}' in the world."

Work from sources to claims, never the reverse. For the two evidence sections: first establish what research and documented cases actually found about this question, then state each finding, then place it in the column its content supports. Never pick a column, write a claim to fill it, and attach a citation afterwards.

Search the web before you write anything, and let what comes back outrank what you remember — your training data is older than the question. Where search turns up nothing usable, answer from what you know and set as_of to the year of the evidence you are leaning on rather than to this year.

Weighing sources against each other:
- For a claim about a quantity that moves (adoption, usage, polling, prices, error rates), the most recent credible measurement wins outright.
- For a claim about a mechanism or an effect, a landmark replicated finding is not displaced by a single recent survey, preprint, or single-country study.
- Where recent work genuinely contradicts established work, state both. They belong in opposite columns.
- Weigh the source, not only the date: statistical agencies, peer-reviewed journals and established survey programmes outrank think-tank posts, which outrank vendor research.
- Cite the primary study, not journalism about it.

evidence_for and evidence_against take 0 to 3 items each. Include only findings that genuinely belong in that column. If the evidence is one-sided, leave the thin column short or empty — an empty column is an honest finding, and padding it with manufactured counterpoints is a failure. Always emit both keys, writing an empty column as [] rather than omitting the key. Every other array has exactly 3 items.

Be specific — cite real movements, researchers, and cases. Be concise: 1-2 sentences per field, short titles.

Score 70–100 as Strong if there is robust peer-reviewed evidence across multiple contexts; 40–69 as Moderate if evidence exists but is mixed or context-dependent; 10–39 as Weak if evidence is thin or contested; 0–9 as Speculative if there is little to no empirical basis.

Before the JSON, write nothing a person would read. No sentences, no plan, no summary of what a search returned. If you write anything at all between searches, it is one line per search in the form q:<keywords> and nothing else.

Then return ONLY valid JSON, with nothing after it:
{
  "strength": <integer 0-100>,
  "strength_label": "<Strong | Moderate | Weak | Speculative>",
  "summary": "<2 sentences>",
  "assumptions": ["<assumption>", ...x3],
  "mechanisms": ["<mechanism>", ...x3],
  "evidence_for": [{"title": "<short>", "description": "<1-2 sentences>", "source": "<name>", "as_of": "<4-digit year the finding is from>"}, ...0 to 3],
  "evidence_against": [{"title": "<short>", "description": "<1-2 sentences>", "source": "<name>", "as_of": "<4-digit year the finding is from>"}, ...0 to 3],
  "historical_examples": [{"name": "<movement>", "period": "<dates>", "outcome": "<1 sentence>", "relevance": "<1 sentence>"}, ...x3],
  "probing_questions": ["<question>", ...x3]
}`;

  try {
    const stream = client.messages.stream({
      model: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
      // A measured grounded run emitted 3,699 output tokens, and the search notation
      // comes out of the same budget. Hitting the cap truncates the JSON, which the
      // page then repairs into a half analysis without saying so.
      max_tokens: 8192,
      // The current search variant runs code execution under the hood, which is why
      // code_execution must not also be declared here — two execution environments
      // confuse the model. Step 3 of docs/PRD-evidence-freshness.md tunes the cap.
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: ANALYZE_SEARCH_MAX_USES }],
      // The bill here is not the searches, it is their results being read again on
      // every pass of the server-side tool loop. Web search writes its own cache
      // entry after each result block, but only once the request is caching at all,
      // which is what this marker is for. The prompt is about 1,130 tokens against a
      // 1,024-token minimum on this model, so it only just qualifies: if it is ever
      // shortened, cache_write in the analyze log line goes to zero and the loop
      // silently returns to full price.
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] }]
    });

    let full = '';
    stream.on('text', (text) => {
      full += text;
      res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
    });

    stream.on('finalMessage', (msg) => {
      const { searches, errors, results } = webSearchUsage(msg);
      for (const code of errors) console.warn(`analyze web search failed: ${code}`);
      // A turn can search, get nothing back, and answer from training data anyway.
      // It ends cleanly and reads like any other analysis, so this line is the only
      // place the difference between a grounded answer and an ungrounded one shows.
      if (results === 0) console.warn('analyze was not grounded: no search results came back');
      const u = msg?.usage || {};
      console.log([
        `analyze: ${searches} search(es)`,
        `${errors.length} search error(s)`,
        `stop_reason=${msg?.stop_reason}`,
        `in=${u.input_tokens ?? '?'}`,
        `out=${u.output_tokens ?? '?'}`,
        `cache_read=${u.cache_read_input_tokens ?? 0}`,
        `cache_write=${u.cache_creation_input_tokens ?? 0}`,
        // The API's own count of billable searches, which is what the invoice reads,
        // rather than the blocks the model happened to leave in the transcript.
        `billed_searches=${u.server_tool_use?.web_search_requests ?? '?'}`,
        `results=${results}`,
        `cost=$${analysisCost(u).toFixed(4)}`,
        `spent_today=$${settleSpend(reservation, analysisCost(u)).toFixed(2)}/${DAILY_BUDGET_USD}`
      ].join(', '));
      if (isCompleteAnalysis(msg)) cacheSet(cacheKey, full);
      else console.warn(`analyze not cached: turn ended on ${msg?.stop_reason}`);
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
// A found link is a fact about the web and keeps for the week. "Nothing found"
// is a fact about one search on one afternoon, and the same citation resolved on
// the next attempt in testing, so it is held only long enough to stop a visitor
// clicking the same dead affordance over and over.
// These three belong together and should not be changed one at a time: the
// four-search ceiling below, the refusal to answer without results, and this
// short negative TTL. Zero results means "this lookup ran out of searches" at
// least as often as it means "no such page", so dropping the URL is only safe
// while a retry is cheap and soon. Lower the ceiling or lengthen this, and
// citations a second attempt would have found go dead instead.
const SOURCE_URL_EMPTY_TTL_MS = 60 * 60 * 1000;
// Four searches and the results they drag into context, which is what a lookup
// costs when it uses the whole ceiling. Reserved up front and settled down to
// the real figure once the call returns.
const LOOKUP_ESTIMATE_USD = 0.09;

function lookupTtl(url) {
  return url ? SOURCE_URL_CACHE_TTL_MS : SOURCE_URL_EMPTY_TTL_MS;
}
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

// The same two questions the lookup endpoint asks, read off one message: how many
// searches ran, which of them failed, and how much they found. An analysis that
// searched and got nothing back reads exactly like one that searched and got
// everything, so results is the only number that separates them.
function webSearchUsage(msg) {
  const content = Array.isArray(msg?.content) ? msg.content : [];
  const searches = content.filter((b) => b && b.type === 'server_tool_use' && b.name === 'web_search').length;
  return { searches, errors: searchErrors(content), results: searchResultCount(content) };
}

// Only a turn the model ended itself holds the whole analysis. The server-side tool
// loop stops at ten iterations with pause_turn, and a grounded answer runs longer
// than an ungrounded one, so the token cap is closer than it was. Either way the
// JSON is cut off, and the 24-hour cache would hand that to everyone who follows.
function isCompleteAnalysis(msg) {
  return msg?.stop_reason === 'end_turn';
}

// An empty URL is a fine thing to remember for a week when the model looked and
// found nothing. A paused search turn or a reply cut off at the token cap looks
// identical from the outside and is not — caching those would keep the failure
// long after a retry would have worked.
// Every error code the search tool reports: a rate limit, an internal failure,
// a query it would not run, or the use ceiling below. On an error the block's
// content is a single object; on success it is a list of results.
function searchErrors(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b?.type === 'web_search_tool_result' && !Array.isArray(b.content))
    .map((b) => b.content?.error_code || 'unknown');
}

// Hits across every search that ran. A search can return an empty list instead of
// an error, which reads as success to anything looking only for an error block,
// and a measured run on the analyze endpoint had the model say out loud that
// search had stopped working and then answer from memory anyway. With no results
// behind it, a URL is a guess, which is the failure this endpoint exists to fix.
function searchResultCount(content) {
  if (!Array.isArray(content)) return 0;
  return content
    .filter((b) => b?.type === 'web_search_tool_result' && Array.isArray(b.content))
    .reduce((total, b) => total + b.content.length, 0);
}

// Anthropic list prices for what one lookup actually consumes. The searches
// dominate: three of them cost more than every token in the call put together,
// which is why the ceiling on searches is the number that decides the bill.
const SEARCH_USD = 0.01;            // $10 per 1,000 searches
const HAIKU_INPUT_USD_PER_TOKEN = 1 / 1_000_000;
const HAIKU_OUTPUT_USD_PER_TOKEN = 5 / 1_000_000;

function lookupCost(msg) {
  const usage = msg?.usage;
  if (!usage) return 0;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return searches * SEARCH_USD
    + (usage.input_tokens ?? 0) * HAIKU_INPUT_USD_PER_TOKEN
    + (usage.output_tokens ?? 0) * HAIKU_OUTPUT_USD_PER_TOKEN;
}

function isConclusiveLookup(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.stop_reason !== 'end_turn') return false;
  // A search that failed and a search that found nothing both end the turn with
  // {"url":""}. Only the error block distinguishes them, and without this check
  // a rate limit gets remembered as though it were an answer.
  if (searchErrors(msg.content).length > 0) return false;
  // Nothing came back from any search, so nothing the model wrote is grounded.
  if (searchResultCount(msg.content) === 0) return false;
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

  const key = `${source.toLowerCase().trim()}|||${ctx.toLowerCase().trim()}`;
  const cached = sourceUrlCache.get(key);
  if (cached && Date.now() - cached.t <= lookupTtl(cached.url)) {
    sourceUrlCache.delete(key);
    sourceUrlCache.set(key, cached);
    return res.json({ url: cached.url });
  }

  // Both of these sit after the cache read on purpose: a citation already
  // resolved today keeps working whether or not the slice is spent, and whether
  // or not the key is configured. Only a lookup that would call out stops here.
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });
  }

  if (budgetExhausted(Date.now(), 'lookup')) {
    console.warn(`source-url refused: $${spentOnLookupsToday().toFixed(2)} spent on lookups today against a $${DAILY_LOOKUP_BUDGET_USD} slice`);
    return res.status(503).json({ error: "Link lookups have reached today's limit. They resume tomorrow." });
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

  // The estimate is the worst case, four searches and their results. A burst of
  // lookups all clears the check above before any of them has finished, so the
  // estimate goes on the meter now and the difference comes back below.
  const reservation = reserveSpend(Date.now(), 'lookup', LOOKUP_ESTIMATE_USD);

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      // Search results and their citation blocks do not fit in a couple of hundred
      // tokens; hitting the cap truncates the JSON and reads as "no link found".
      max_tokens: 1024,
      // 20250305 is the basic tool. The later variants run search from inside code
      // execution, which this model cannot do.
      // Four, not two. The model's first choice of keywords is often wrong on a
      // citation that names an organization rather than a document, and at two it
      // spent the ceiling before it could reformulate: forcing that ceiling in
      // testing turned a reliable lookup into a coin flip. Searches are billed
      // per use, so the ceiling costs nothing on the runs that do not need it.
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{ role: 'user', content: prompt }]
    });
    // A URL the search results never produced came from the model's memory, and a
    // remembered URL is how this endpoint used to return publisher homepages and
    // invented paths. Drop it rather than pass a guess off as a found link.
    const searches = msg.usage?.server_tool_use?.web_search_requests ?? 0;
    const cost = lookupCost(msg);
    settleSpend(reservation, cost);
    console.log([
      `source-url: ${searches} search(es)`,
      `$${cost.toFixed(4)}`,
      `stop_reason=${msg?.stop_reason}`,
      `lookups_today=$${spentOnLookupsToday().toFixed(2)}/${DAILY_LOOKUP_BUDGET_USD}`,
      `spent_today=$${spentToday().toFixed(2)}/${DAILY_BUDGET_USD}`
    ].join(', '));
    for (const code of searchErrors(msg.content)) console.warn(`source-url search failed: ${code}`);

    const grounded = searchResultCount(msg.content) > 0;
    const url = grounded ? parseSourceUrl(textFromContent(msg.content)) : '';
    if (!grounded) console.warn('source-url: no search results behind the reply, answering empty');

    if (isConclusiveLookup(msg)) {
      if (sourceUrlCache.size >= SOURCE_URL_CACHE_MAX) {
        const oldest = sourceUrlCache.keys().next().value;
        if (oldest !== undefined) sourceUrlCache.delete(oldest);
      }
      sourceUrlCache.set(key, { url, t: Date.now() });
    }
    return res.json({ url });
  } catch (err) {
    // The reservation stands, which is what settleSpend's own comment asks for
    // and what the analyze path does. A lookup that throws has usually already
    // run and paid for its searches: upstream rate limiting makes the model wait
    // and retry, so the failures that reach here are the expensive ones, not the
    // free ones. Refunding them would understate the day in exactly the case the
    // meter exists for.
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

export { app, buildCsp, inlineScriptHashes, serializeJsonBlock, renderIndex, escapeHtml, parseSourceUrl, textFromContent, isConclusiveLookup, searchErrors, searchResultCount, lookupCost, lookupTtl, webSearchUsage, isCompleteAnalysis, analysisCost, recordSpend, reserveSpend, settleSpend, spentToday, spentOnLookupsToday, budgetExhausted, DAILY_BUDGET_USD, DAILY_LOOKUP_BUDGET_USD, cacheGet, cacheSet, cache, loadCacheFromDisk, CACHE_MAX, CACHE_TTL_MS };
