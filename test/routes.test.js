import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the disk cache out of the repo, and make sure no test can reach a real API:
// every credential the server checks for is cleared before it is imported.
const TMP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'toc-routes-'));
process.env.CACHE_DIR = TMP_CACHE_DIR;

// A stand-in right-to-left translation, written before the server is imported.
// It only has to be complete and valid; the words are irrelevant to the tests.
const reference = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'locales', 'en.json'), 'utf8'));
const STUB_LOCALE = 'ar';
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
const NEGOTIATED_LOCALE = 'de';
const NEGOTIATED_TITLE = 'STUB TITLE DE';
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

const { app, inlineScriptHashes } = await import('../server.js');

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

test('analyze enforces its rate limit of 20 per 15 minutes', async () => {
  const ip = '10.9.9.1';
  for (let i = 0; i < 20; i++) await post('/api/analyze', {}, { ip });
  const res = await post('/api/analyze', {}, { ip });
  assert.equal(res.status, 429);
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
  const res = await fetch(`${BASE}/`, { headers: { 'Accept-Language': `${STUB_LOCALE}-EG,${STUB_LOCALE};q=0.9` } });
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
  // `is` has no bundle; `de` does. Without an available list the top entry wins
  // and the reader gets English instead of the German they can read.
  const res = await fetch(BASE, { headers: { 'Accept-Language': 'is, de;q=0.9' } });
  const html = await res.text();
  assert.match(html, /<html lang="de"/);
  assert.match(html, new RegExp(NEGOTIATED_TITLE));
});
