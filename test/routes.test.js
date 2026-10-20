import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the disk cache out of the repo, and make sure no test can reach a real API:
// every credential the server checks for is cleared before it is imported.
const TMP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'toc-routes-'));
process.env.CACHE_DIR = TMP_CACHE_DIR;

// A stand-in right-to-left translation, written before the server is imported.
// It only has to be complete and valid; the words are irrelevant to the tests.
// Persian, a right-to-left language this page is not translated into, so the
// committed Arabic bundle never shadows the generated stub.
const reference = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'locales', 'en.json'), 'utf8'));
const STUB_LOCALE = 'fa';
const STUB_TITLE = 'STUB TITLE RTL';
mkdirSync(join(TMP_CACHE_DIR, 'locales'), { recursive: true });
writeFileSync(
  join(TMP_CACHE_DIR, 'locales', `${STUB_LOCALE}.json`),
  JSON.stringify({
    ...Object.fromEntries(Object.entries(reference).filter(([key]) => key !== '_meta')),
    _meta: { language: STUB_LOCALE, dir: 'rtl', charWidthFactor: 1 },
    'meta.title': STUB_TITLE,
    'headline.template': 'STUB {X} STUB {Y} STUB'
  })
);
// A second stub, used for two things: negotiating against what is installed,
// and proving that a $-sequence in translated copy survives the meta rewrite.
// Welsh, a language this page is not translated into, so a committed bundle
// never shadows the generated stub.
const NEGOTIATED_LOCALE = 'cy';
const NEGOTIATED_TITLE = 'STUB TITLE CY';
const DOLLAR_DESCRIPTION = "Preco $& total $` and $' too";
writeFileSync(
  join(TMP_CACHE_DIR, 'locales', `${NEGOTIATED_LOCALE}.json`),
  JSON.stringify({
    ...Object.fromEntries(Object.entries(reference).filter(([key]) => key !== '_meta')),
    _meta: { language: NEGOTIATED_LOCALE, dir: 'ltr', charWidthFactor: 1 },
    'meta.title': NEGOTIATED_TITLE,
    'meta.description': DOLLAR_DESCRIPTION,
    'headline.template': 'STUB {X} STUB {Y} STUB'
  })
);

delete process.env.ANTHROPIC_API_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.CURATOR_API_URL;
delete process.env.FEEDBACK_TO;

const { app, inlineScriptHashes, cacheSet, serializeStreams, recordSpend, DAILY_BUDGET_USD, DAILY_LOOKUP_BUDGET_USD } = await import('../server.js');

const server = app.listen(0);
await once(server, 'listening');
const BASE = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  rmSync(TMP_CACHE_DIR, { recursive: true, force: true });
});

// The rate limiters key on req.ip, and `trust proxy` is on, so a distinct
// X-Forwarded-For gives each test its own bucket. Without this, the 5-per-hour
// feedback limiter would start returning 429 partway through the file and any
// test added later would break an unrelated one.
let ipCounter = 0;
function post(path, body, { ip, raw } = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip || `10.0.0.${++ipCounter % 250 + 1}`,
    },
    body: raw ?? JSON.stringify(body),
  });
}

// ─── POST /api/analyze ────────────────────────────────────────────────────────

test('analyze rejects a missing body', async () => {
  const res = await post('/api/analyze', {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /required/i);
});

test('analyze rejects a missing change field', async () => {
  const res = await post('/api/analyze', { action: 'organising' });
  assert.equal(res.status, 400);
});

test('analyze rejects whitespace-only input', async () => {
  const res = await post('/api/analyze', { action: '   ', change: '   ' });
  assert.equal(res.status, 400);
});

test('analyze rejects non-string input', async () => {
  const res = await post('/api/analyze', { action: 123, change: ['x'] });
  assert.equal(res.status, 400);
});

test('analyze rejects input longer than 200 characters', async () => {
  const res = await post('/api/analyze', { action: 'a'.repeat(201), change: 'ok' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /200 characters or fewer/);
});

test('analyze rejects a pushback longer than 500 characters', async () => {
  const res = await post('/api/analyze', { action: 'ok', change: 'ok', clarification: 'a'.repeat(501) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /500 characters or fewer/);
});

test('analyze rejects a pushback that is not a string', async () => {
  const res = await post('/api/analyze', { action: 'ok', change: 'ok', clarification: ['x'] });
  assert.equal(res.status, 400);
});

test('analyze rejects a place longer than 80 characters', async () => {
  const res = await post('/api/analyze', { action: 'organising', change: 'less isolation', place: 'x'.repeat(81) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /place/);
});

test('analyze rejects a place that is not text', async () => {
  const res = await post('/api/analyze', { action: 'organising', change: 'less isolation', place: { city: 'Lisbon' } });
  assert.equal(res.status, 400);
});

test('analyze accepts a place within the limit', async () => {
  // Stops at the missing-key check, which proves validation passed.
  const res = await post('/api/analyze', { action: 'organising', change: 'less isolation', place: 'x'.repeat(80) });
  assert.equal(res.status, 500);
});

// ─── GET /api/place-hint ──────────────────────────────────────────────────────

test('place hint names the country for a time zone, in the page language', async () => {
  const en = await (await fetch(`${BASE}/api/place-hint?tz=Europe/Lisbon&lang=en`)).json();
  assert.deepEqual(en, { name: 'Portugal' });
  const pt = await (await fetch(`${BASE}/api/place-hint?tz=Europe/Paris&lang=pt`)).json();
  assert.deepEqual(pt, { name: 'França' });
});

test('place hint gives no name for an unknown zone or a bad language', async () => {
  assert.deepEqual(await (await fetch(`${BASE}/api/place-hint?tz=Bogus/Zone`)).json(), { name: null });
  const odd = await fetch(`${BASE}/api/place-hint?tz=Europe/Lisbon&lang=${'x'.repeat(40)}`);
  assert.equal(odd.status, 200);
  assert.deepEqual(await odd.json(), { name: 'Portugal' });
});

test('analyze accepts input at exactly the 200 character limit', async () => {
  // No API key is set, so a valid request stops at the config check (500)
  // rather than reaching the model. That 500 is what proves it passed validation.
  const res = await post('/api/analyze', { action: 'a'.repeat(200), change: 'ok' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /ANTHROPIC_API_KEY/);
});

test('analyze reports a missing API key rather than failing silently', async () => {
  const res = await post('/api/analyze', { action: 'mutual aid', change: 'less isolation' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /ANTHROPIC_API_KEY is not set/);
});

test('analyze rejects a body over the 4kb JSON limit', async () => {
  const res = await post('/api/analyze', null, { raw: JSON.stringify({ action: 'x'.repeat(8000), change: 'y' }) });
  assert.equal(res.status, 413);
});

test('analyze enforces its rate limit of 5 per 15 minutes', async () => {
  const ip = '10.9.9.1';
  for (let i = 0; i < 5; i++) assert.notEqual((await post('/api/analyze', {}, { ip })).status, 429);
  const res = await post('/api/analyze', {}, { ip });
  assert.equal(res.status, 429);
});

// Before the two below, and that placement is the whole point: this spends only
// the lookup slice, so the day still has room and analyze still answers. Written
// after the day is spent it would pass with the purpose argument deleted from
// the route, which is what the first version of it did.

test('lookups stop at their own slice while analyses carry on', async () => {
  recordSpend(DAILY_LOOKUP_BUDGET_USD, Date.now(), 'lookup');

  process.env.ANTHROPIC_API_KEY = 'never-used-no-request-is-made';
  const refused = await post('/api/source-url', { source: 'Elinor Ostrom', context: 'commons' });
  cacheSet('slice check|||still answers', serializeStreams({ frame: '{"strength": 61}', grounded: '{"evidence_for": []}' }));
  const analysis = await post('/api/analyze', { action: 'Slice Check', change: 'Still Answers' });
  const body = await analysis.text();
  delete process.env.ANTHROPIC_API_KEY;

  assert.equal(refused.status, 503);
  assert.match(body, /"strength\\": 61/);
});


// Each chunk says which call wrote it, because the page keeps one buffer per call
// and a chunk with no tag would be appended to whichever buffer happened to be
// first — quietly corrupting the JSON of both.
test('a cached analysis replays both streams, each tagged with the call it came from', async () => {
  process.env.ANTHROPIC_API_KEY = 'never-used-no-request-is-made';
  cacheSet('tagged replay|||two streams', serializeStreams({
    frame: '{"strength": 44, "summary": "x"}',
    grounded: '{"strength": 71, "evidence_for": []}'
  }));
  const res = await post('/api/analyze', { action: 'Tagged Replay', change: 'Two Streams' });
  const body = await res.text();
  delete process.env.ANTHROPIC_API_KEY;

  const tagged = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const frame = tagged.find((payload) => payload.s === 'frame');
  const grounded = tagged.find((payload) => payload.s === 'grounded');

  assert.ok(frame, 'no chunk was tagged as the frame call');
  assert.ok(grounded, 'no chunk was tagged as the grounded call');
  assert.match(frame.chunk, /"strength": 44/);
  assert.match(grounded.chunk, /"strength": 71/);
  assert.ok(tagged.some((payload) => payload.done === true), 'the stream never closed');
});

// These two run last in this section: spending the day is global state, and every
// analyze test after them would be turned away by the budget rather than by what
// it meant to check.

test('an analysis already in the cache still answers after the day is spent', async () => {
  process.env.ANTHROPIC_API_KEY = 'never-used-no-request-is-made';
  cacheSet('mutual aid|||less isolation', serializeStreams({ frame: '{"strength": 50}', grounded: '{"evidence_for": []}' }));
  recordSpend(DAILY_BUDGET_USD);
  const res = await post('/api/analyze', { action: 'Mutual Aid', change: 'Less Isolation' });
  const body = await res.text();
  delete process.env.ANTHROPIC_API_KEY;
  assert.match(body, /"strength\\": 50/);
});


// An entry written before the analysis was split into two calls holds one
// undivided blob. Replayed as a frame it would leave the evidence columns on
// skeletons with nothing ever arriving to fill them, so it reads as a miss.
test('an analysis cached before the split is not replayed', async () => {
  process.env.ANTHROPIC_API_KEY = 'never-used-no-request-is-made';
  cacheSet('legacy shape|||one blob', '{"strength": 50, "evidence_for": []}');
  recordSpend(DAILY_BUDGET_USD);
  const res = await post('/api/analyze', { action: 'Legacy Shape', change: 'One Blob' });
  const body = await res.text();
  delete process.env.ANTHROPIC_API_KEY;
  assert.doesNotMatch(body, /"strength": 50/, 'the pre-split entry was replayed');
  assert.match(body, /limit on new analyses/);
});

test('a new theory is turned away once the day is spent, rather than billed', async () => {
  process.env.ANTHROPIC_API_KEY = 'never-used-no-request-is-made';
  recordSpend(DAILY_BUDGET_USD);
  const res = await post('/api/analyze', { action: 'composting', change: 'less landfill' });
  const body = await res.text();
  delete process.env.ANTHROPIC_API_KEY;
  assert.match(body, /Today's limit on new analyses has been reached/);
});

// ─── POST /api/feedback ───────────────────────────────────────────────────────

test('feedback rejects a missing message', async () => {
  const res = await post('/api/feedback', {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /message is required/i);
});

test('feedback rejects a whitespace-only message', async () => {
  const res = await post('/api/feedback', { message: '   \n  ' });
  assert.equal(res.status, 400);
});

test('feedback rejects a message over 4000 characters', async () => {
  const res = await post('/api/feedback', { message: 'x'.repeat(4001) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /4000 characters or fewer/);
});

test('feedback rejects a malformed email address', async () => {
  const res = await post('/api/feedback', { message: 'hello', email: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /email address does not look valid/);
});

test('feedback treats an empty email as "not provided" rather than invalid', async () => {
  // Valid input, so it falls through to the config check — proof it passed validation.
  const res = await post('/api/feedback', { message: 'hello', email: '' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /RESEND_API_KEY and FEEDBACK_TO/);
});

test('feedback reports missing email configuration rather than failing silently', async () => {
  const res = await post('/api/feedback', { message: 'a real note' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not configured/i);
});

test('feedback enforces its rate limit of 5 per hour', async () => {
  const ip = '10.9.9.2';
  for (let i = 0; i < 5; i++) await post('/api/feedback', {}, { ip });
  const res = await post('/api/feedback', {}, { ip });
  assert.equal(res.status, 429);
});

// ─── POST /api/recommend ──────────────────────────────────────────────────────

test('recommend degrades to an empty result when the curator is unconfigured', async () => {
  const res = await post('/api/recommend', { text: 'community organizing' });
  assert.equal(res.status, 200, 'must never surface an error to the page');
  assert.deepEqual(await res.json(), { categories: [] });
});

test('recommend returns an empty result for empty text', async () => {
  const res = await post('/api/recommend', { text: '   ' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { categories: [] });
});

test('recommend returns an empty result for a missing body', async () => {
  const res = await post('/api/recommend', {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { categories: [] });
});

// ─── Static assets ────────────────────────────────────────────────────────────

test('the homepage is served', async () => {
  // Asks for English explicitly: the title is translated now, so a test that
  // relied on the default would break the day a bundle matched the runner.
  const res = await fetch(`${BASE}/`, { headers: { 'Accept-Language': 'en' } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>/i);
  assert.match(html, /theory of change/i);
});

test('fonts are served with a 30-day cache header', async () => {
  const res = await fetch(`${BASE}/fonts/UntitledSans-Regular.woff`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000');
});

test('the OG image is served with a 30-day cache header', async () => {
  const res = await fetch(`${BASE}/og-image.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000');
});

test('HTML is not given the long-lived cache header', async () => {
  const res = await fetch(`${BASE}/index.html`);
  assert.equal(res.status, 200);
  assert.notEqual(res.headers.get('cache-control'), 'public, max-age=2592000');
});

test('an unknown path 404s', async () => {
  const res = await fetch(`${BASE}/no-such-page`);
  assert.equal(res.status, 404);
});

// ─── GET / localization ───────────────────────────────────────────────────────

test('the homepage declares the language and direction it was rendered in', async () => {
  const res = await fetch(`${BASE}/`, { headers: { 'Accept-Language': 'en' } });
  const html = await res.text();
  assert.match(html, /<html lang="en" dir="ltr">/);
});

test('the homepage varies on the headers that chose the language', async () => {
  // Both inputs are request headers, so without this a shared cache in front
  // of the app would serve one visitor's language to the next.
  const res = await fetch(`${BASE}/`);
  const vary = res.headers.get('vary') ?? '';
  assert.match(vary, /Accept-Language/i);
  assert.match(vary, /Cookie/i);
});

test('a translated bundle changes the language, direction and title', async () => {
  const res = await fetch(`${BASE}/`, { headers: { 'Accept-Language': STUB_LOCALE } });
  const html = await res.text();
  assert.match(html, new RegExp(`<html lang="${STUB_LOCALE}" dir="rtl">`));
  assert.ok(html.includes(STUB_TITLE), 'the translated title should be in the served page');
  assert.match(html, new RegExp(`<meta property="og:locale" content="${STUB_LOCALE}">`));
});

test('a region is dropped when choosing the bundle', async () => {
  // pt-PT and pt-BR share one translation, which is what bounds the number of
  // bundles to languages rather than to tags.
  const res = await fetch(`${BASE}/`, { headers: { 'Accept-Language': `${STUB_LOCALE}-IR,${STUB_LOCALE};q=0.9` } });
  assert.match(await res.text(), new RegExp(`<html lang="${STUB_LOCALE}" dir="rtl">`));
});

test('a language with no bundle falls back to English rather than failing', async () => {
  for (const header of ['ja', 'xx', 'zz-ZZ', '', 'not a header', '*']) {
    const res = await fetch(`${BASE}/`, { headers: { 'Accept-Language': header } });
    assert.equal(res.status, 200, `${header} should still serve`);
    assert.match(await res.text(), /<html lang="en" dir="ltr">/, `${header} should fall back`);
  }
});

test('an explicit choice in the query string or a cookie wins over the header', async () => {
  const viaQuery = await fetch(`${BASE}/?lang=${STUB_LOCALE}`, { headers: { 'Accept-Language': 'en' } });
  assert.match(await viaQuery.text(), new RegExp(`<html lang="${STUB_LOCALE}"`));

  const viaCookie = await fetch(`${BASE}/`, {
    headers: { 'Accept-Language': 'en', Cookie: `locale_pref=lang%3D${STUB_LOCALE}` }
  });
  assert.match(await viaCookie.text(), new RegExp(`<html lang="${STUB_LOCALE}"`));
});

test('a hostile language parameter cannot reach outside the locales directory', async () => {
  for (const lang of ['../../etc/passwd', '..%2F..%2Fetc', 'en/../../x', 'a'.repeat(200)]) {
    const res = await fetch(`${BASE}/?lang=${encodeURIComponent(lang)}`);
    assert.equal(res.status, 200, `${lang} should not error`);
    assert.match(await res.text(), /<html lang="en" dir="ltr">/, `${lang} should fall back to English`);
  }
});

test('the string bundle ships as a data block the page can parse', async () => {
  const res = await fetch(`${BASE}/`, { headers: { 'Accept-Language': STUB_LOCALE } });
  const html = await res.text();
  const match = /<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'the i18n data block should be in the page');
  const payload = JSON.parse(match[1]);
  assert.equal(payload.locale.tag, STUB_LOCALE);
  assert.equal(payload.locale.dir, 'rtl');
  assert.equal(payload.strings['meta.title'], STUB_TITLE);
  assert.match(payload.strings['headline.template'], /\{X\}/);
});

test('the data block is not hashed into the policy, because it never executes', async () => {
  // The whole reason the page can be rendered per request: a hash taken from
  // the file at boot could never match a block built per response.
  const res = await fetch(`${BASE}/`, { headers: { 'Accept-Language': STUB_LOCALE } });
  const html = await res.text();
  const csp = res.headers.get('content-security-policy');
  const hashes = inlineScriptHashes(html);
  assert.equal(hashes.length, 1, 'only the analytics bootstrap should be hashed');
  for (const hash of hashes) assert.ok(csp.includes(hash), `CSP is missing ${hash}`);
});

test('index.html serves the same rendered page as /', async () => {
  const [root, explicit] = await Promise.all([
    fetch(`${BASE}/`, { headers: { 'Accept-Language': STUB_LOCALE } }).then((r) => r.text()),
    fetch(`${BASE}/index.html`, { headers: { 'Accept-Language': STUB_LOCALE } }).then((r) => r.text())
  ]);
  assert.equal(root, explicit);
});

test('an out-of-bounds Range header returns 416 and not a crash', async () => {
  const res = await fetch(`${BASE}/og-image.png`, { headers: { Range: 'bytes=999999999-1000000000' } });
  assert.equal(res.status, 416);
});

test('every response carries the security headers', async () => {
  const res = await fetch(`${BASE}/`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('the CSP hashes match the inline scripts actually shipped in the page', async () => {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  const csp = res.headers.get('content-security-policy');
  const hashes = inlineScriptHashes(html);
  assert.ok(hashes.length > 0, 'index.html should still have inline scripts');
  for (const hash of hashes) assert.ok(csp.includes(hash), `CSP is missing ${hash}`);
});

test('HSTS is only sent over TLS', async () => {
  const plain = await fetch(`${BASE}/`);
  assert.equal(plain.headers.get('strict-transport-security'), null);
  // `trust proxy` is on, so the proxy header is what makes req.secure true.
  const forwarded = await fetch(`${BASE}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(forwarded.headers.get('strict-transport-security'), /max-age=31536000/);
});

test('the favicon is served rather than 404ing', async () => {
  for (const path of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, `${path} should be served`);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000');
  }
});

// ─── Translated copy that looks like a replacement pattern ────────────────────

test('a $-sequence in translated copy is rendered literally, not expanded', async () => {
  const res = await fetch(BASE, { headers: { 'Accept-Language': NEGOTIATED_LOCALE } });
  const html = await res.text();
  const descriptions = html.match(/<meta name="description" content="[^"]*">/g) || [];
  assert.equal(descriptions.length, 1);
  assert.match(descriptions[0], /Preco \$&amp; total \$` and \$&#39; too/);
});

test('language negotiation only offers bundles that are actually installed', async () => {
  // `is` has no bundle; `cy` does. Without an available list the top entry wins
  // and the reader gets English instead of the Welsh they can read.
  const res = await fetch(BASE, { headers: { 'Accept-Language': 'is, cy;q=0.9' } });
  const html = await res.text();
  assert.match(html, /<html lang="cy"/);
  assert.match(html, new RegExp(NEGOTIATED_TITLE));
});

// ─── Lookups once the day's money is gone ─────────────────────────────────────
// These have to stay at the end of the file. The analyze budget tests above
// spend the whole day on the process-wide meter, and these read that state
// rather than setting up their own: there is no way to inject a clock into a
// route, so the only reachable budget condition here is the one those tests
// leave behind. The slice arithmetic itself is unit tested with real timestamps.

// A configured key is part of the condition under test: a server with no key at
// all reports that first, because a missing key is a fault to fix rather than a
// limit that lifts tomorrow. The budget guard returns before any client is
// constructed, so this placeholder never reaches the network.
async function postWithKey(path, body) {
  process.env.ANTHROPIC_API_KEY = 'test-key-never-used';
  try {
    return await post(path, body);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
}

test('a lookup is refused once the day is spent, and says so plainly', async () => {
  recordSpend(DAILY_BUDGET_USD);
  const res = await postWithKey('/api/source-url', { source: 'Elinor Ostrom', context: 'commons' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /resume tomorrow/);
});

test('a refused lookup carries no url field for the page to misread as a miss', async () => {
  recordSpend(DAILY_BUDGET_USD);
  const res = await postWithKey('/api/source-url', { source: 'Erica Chenoweth', context: 'resistance' });
  const body = await res.json();
  // The status is asserted here too, or the absence of a url proves nothing: a
  // lookup that failed upstream also returns a body with no url, so without this
  // the test passes just as happily with the budget guard removed.
  assert.equal(res.status, 503);
  assert.equal('url' in body, false);
});

test('the page carries the suggestion lists in its own language', async () => {
  const pageData = async (lang) => {
    const html = await (await fetch(`${BASE}/?lang=${lang}`)).text();
    return JSON.parse(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/.exec(html)[1]);
  };
  const pt = await pageData('pt');
  assert.equal(pt.suggestions['suggestions.x'][0], 'organizar ação comunitária');
  assert.equal(pt.suggestions['suggestions.y'][0], 'estabilidade climática');
  const ar = await pageData('ar');
  assert.equal(ar.suggestions['suggestions.x'][0], 'تنظيم العمل المجتمعي');
  assert.equal(ar.suggestions['suggestions.y'][0], 'استقرار المناخ');
  const en = await pageData('en');
  assert.equal(en.suggestions['suggestions.x'][0], 'organizing community action');
});

test('every committed language gets its own suggestion lists on its page', async () => {
  const locales = new URL('../locales/', import.meta.url);
  const committed = readdirSync(locales)
    .filter((name) => name.endsWith('.suggestions.json') && name !== 'en.suggestions.json')
    .map((name) => name.slice(0, -'.suggestions.json'.length));
  for (const lang of committed) {
    const expected = JSON.parse(readFileSync(new URL(`${lang}.suggestions.json`, locales), 'utf8'));
    const html = await (await fetch(`${BASE}/?lang=${lang}`)).text();
    const data = JSON.parse(/<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(data.locale.bundleKey, lang, `${lang} page`);
    assert.deepEqual(data.suggestions, expected, `${lang} suggestions`);
  }
});

// ─── Page-language picker ─────────────────────────────────────────────────────

function pickerLinks(html) {
  return [...html.matchAll(/<a [^>]*data-page-lang="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
}

test('both footers offer every installed language but the current one, each in its own name', async () => {
  const html = await (await fetch(`${BASE}/`, { headers: { 'Accept-Language': 'en' } })).text();
  const links = pickerLinks(html);
  assert.ok(links.some(([code, name]) => code === 'pt' && name === 'Português'));
  assert.ok(links.some(([code]) => code === NEGOTIATED_LOCALE));
  assert.ok(!links.some(([code]) => code === 'en'), 'the current language is not a link');
  assert.equal(links.filter(([code]) => code === 'pt').length, 2, 'one in each footer');
  assert.match(html, /href="\/\?lang=pt" lang="pt"/);
  assert.match(html, /aria-current="true" lang="en">English</);
});

test('the picker is named in the page language', async () => {
  const en = await (await fetch(`${BASE}/`, { headers: { 'Accept-Language': 'en' } })).text();
  assert.match(en, /<summary aria-label="Page language: English">/);
  assert.match(en, /<ul class="page-langs__menu" aria-label="Page language">/);
  const pt = await (await fetch(`${BASE}/`, { headers: { 'Accept-Language': 'pt-PT' } })).text();
  assert.match(pt, /<summary aria-label="Idioma da página: Português">/);
  assert.ok(pickerLinks(pt).some(([code, name]) => code === 'en' && name === 'English'));
});

test('a saved language nobody has installed falls back to the browser header', async () => {
  const res = await fetch(`${BASE}/`, { headers: { 'Accept-Language': 'pt-PT', Cookie: 'locale_pref=lang%3Dxx' } });
  assert.match(await res.text(), /<html lang="pt"/);
});

// ─── Crawlers ─────────────────────────────────────────────────────────────────

test('robots.txt keeps crawlers off the API and points at the sitemap', async () => {
  const res = await fetch(`${BASE}/robots.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  const body = await res.text();
  assert.match(body, /^User-agent: \*$/m);
  // A crawler rendering a shared link would otherwise run a paid analysis.
  assert.match(body, /^Disallow: \/api\/$/m);
  assert.match(body, /^Sitemap: https:\/\/theory\.evensfoundation\.eu\/sitemap\.xml$/m);
});

test('sitemap.xml lists the page once per language, each naming the others', async () => {
  const res = await fetch(`${BASE}/sitemap.xml`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/xml/);
  const body = await res.text();
  assert.match(body, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(body, /<loc>https:\/\/theory\.evensfoundation\.eu\/<\/loc>/);
  assert.match(body, /<loc>https:\/\/theory\.evensfoundation\.eu\/\?lang=pt<\/loc>/);
  assert.match(body, /hreflang="pt" href="https:\/\/theory\.evensfoundation\.eu\/\?lang=pt"/);
  assert.match(body, /hreflang="x-default" href="https:\/\/theory\.evensfoundation\.eu\/"/);
  const urls = body.match(/<url>/g).length;
  assert.equal(body.match(/hreflang="x-default"/g).length, urls);
});

// ─── Share link previews ──────────────────────────────────────────────────────

const metaContent = (html, attr, name) =>
  html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`))?.[1];

async function page(query, lang = 'en') {
  const res = await fetch(`${BASE}/${query}`, { headers: { 'accept-language': lang } });
  return res.text();
}

test('a share link previews with the theory it tested', async () => {
  const html = await page('?a=occupying+squares&c=more+accessible+housing&p=Portugal');
  const title = 'How will occupying squares create more accessible housing in Portugal?';
  assert.equal(metaContent(html, 'property', 'og:title'), title);
  assert.equal(metaContent(html, 'name', 'twitter:title'), title);
  // LinkedIn and Facebook read their tags from og:url, so it must be the link itself.
  assert.equal(metaContent(html, 'property', 'og:url'), 'https://theory.evensfoundation.eu/?a=occupying+squares&amp;c=more+accessible+housing&amp;p=Portugal');
});

test('a share link left at the world previews with no place', async () => {
  const title = 'How will occupying squares create more accessible housing?';
  assert.equal(metaContent(await page('?a=occupying+squares&c=more+accessible+housing'), 'property', 'og:title'), title);
  assert.equal(metaContent(await page('?a=occupying+squares&c=more+accessible+housing&p=the+world'), 'property', 'og:title'), title);
});

test('a share link previews in the language the page is served in', async () => {
  const html = await page('?a=ocupar+pra%C3%A7as&c=mais+habita%C3%A7%C3%A3o&lang=pt', 'pt');
  assert.equal(metaContent(html, 'property', 'og:title'), 'Como é que ocupar praças vai criar mais habitação?');
});

test('typed text in a share title is escaped', async () => {
  const html = await page('?a=%3Cscript%3Ex%3C%2Fscript%3E&c=%22quoted%22');
  assert.match(metaContent(html, 'property', 'og:title'), /^How will &lt;script&gt;x&lt;\/script&gt; create &quot;quoted&quot;\?$/);
  assert.doesNotMatch(html, /<script>x<\/script>/);
});

test('the plain page and a half-filled link keep the generic preview', async () => {
  const generic = metaContent(await page(''), 'property', 'og:title');
  assert.equal(metaContent(await page('?a=only+an+action'), 'property', 'og:title'), generic);
  assert.equal(metaContent(await page(''), 'property', 'og:url'), 'https://theory.evensfoundation.eu/');
});
