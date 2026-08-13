import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the disk cache out of the repo, and make sure no test can reach a real API:
// every credential the server checks for is cleared before it is imported.
const TMP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'toc-routes-'));
process.env.CACHE_DIR = TMP_CACHE_DIR;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.CURATOR_API_URL;
delete process.env.FEEDBACK_TO;

const { app } = await import('../server.js');

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
  const res = await fetch(`${BASE}/`);
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

test('an out-of-bounds Range header returns 416 and not a crash', async () => {
  const res = await fetch(`${BASE}/og-image.png`, { headers: { Range: 'bytes=999999999-1000000000' } });
  assert.equal(res.status, 416);
});
