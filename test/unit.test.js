import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// server.js reads CACHE_DIR at module load, so it has to be set before the import.
const TMP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'toc-unit-'));
const CACHE_FILE = join(TMP_CACHE_DIR, 'analyze-cache.json');
process.env.CACHE_DIR = TMP_CACHE_DIR;

const {
  escapeHtml,
  parseSourceUrl,
  cacheGet,
  cacheSet,
  cache,
  loadCacheFromDisk,
  CACHE_MAX,
  CACHE_TTL_MS,
} = await import('../server.js');

test.after(() => rmSync(TMP_CACHE_DIR, { recursive: true, force: true }));

// ─── escapeHtml ───────────────────────────────────────────────────────────────

test('escapeHtml escapes all five HTML-significant characters', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('escapeHtml neutralises a script tag in feedback', () => {
  const out = escapeHtml('<script>alert(document.cookie)</script>');
  assert.ok(!out.includes('<script'), 'raw <script must not survive escaping');
  assert.equal(out, '&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
});

test('escapeHtml neutralises an attribute-breakout payload', () => {
  const out = escapeHtml('" onmouseover="alert(1)');
  assert.ok(!out.includes('"'), 'raw double quote must not survive escaping');
});

test('escapeHtml coerces non-strings instead of throwing', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(undefined), 'undefined');
});

test('escapeHtml leaves ordinary prose untouched', () => {
  const prose = 'Mutual aid networks reduced isolation in 2020.';
  assert.equal(escapeHtml(prose), prose);
});

// ─── parseSourceUrl ───────────────────────────────────────────────────────────

test('parseSourceUrl extracts an https URL from a JSON reply', () => {
  assert.equal(parseSourceUrl('{"url":"https://example.org/paper"}'), 'https://example.org/paper');
});

test('parseSourceUrl finds the JSON object inside surrounding prose', () => {
  assert.equal(parseSourceUrl('Sure! {"url":"https://example.org"} Hope that helps.'), 'https://example.org');
});

test('parseSourceUrl trims surrounding whitespace', () => {
  assert.equal(parseSourceUrl('{"url":"  https://example.org  "}'), 'https://example.org');
});

test('parseSourceUrl rejects a javascript: URL', () => {
  assert.equal(parseSourceUrl('{"url":"javascript:alert(1)"}'), '');
});

test('parseSourceUrl rejects a bare domain with no scheme', () => {
  assert.equal(parseSourceUrl('{"url":"example.org"}'), '');
});

test('parseSourceUrl returns empty string for the deliberate no-match case', () => {
  assert.equal(parseSourceUrl('{"url":""}'), '');
});

test('parseSourceUrl survives a reply with no JSON at all', () => {
  assert.equal(parseSourceUrl('I could not find a canonical page for that source.'), '');
});

test('parseSourceUrl survives malformed JSON', () => {
  assert.equal(parseSourceUrl('{"url": "https://example.org"'), '');
  assert.equal(parseSourceUrl('{url: https://example.org}'), '');
});

test('parseSourceUrl survives a non-string url field', () => {
  assert.equal(parseSourceUrl('{"url":123}'), '');
  assert.equal(parseSourceUrl('{"url":null}'), '');
});

test('parseSourceUrl survives null and undefined input', () => {
  assert.equal(parseSourceUrl(null), '');
  assert.equal(parseSourceUrl(undefined), '');
});

// ─── analyze cache: LRU eviction ──────────────────────────────────────────────

test('cacheSet then cacheGet round-trips a value', () => {
  cache.clear();
  cacheSet('a|||b', 'analysis text');
  assert.equal(cacheGet('a|||b'), 'analysis text');
});

test('cacheGet returns null for an unknown key', () => {
  cache.clear();
  assert.equal(cacheGet('never-stored'), null);
});

test('cache never grows past CACHE_MAX', () => {
  cache.clear();
  for (let i = 0; i < CACHE_MAX + 50; i++) cacheSet(`k${i}`, `v${i}`);
  assert.equal(cache.size, CACHE_MAX);
});

test('cache evicts the oldest entry first', () => {
  cache.clear();
  for (let i = 0; i < CACHE_MAX; i++) cacheSet(`k${i}`, `v${i}`);
  cacheSet('overflow', 'v');
  assert.equal(cacheGet('k0'), null, 'oldest entry should have been evicted');
  assert.equal(cacheGet('overflow'), 'v', 'newest entry should be present');
});

test('reading an entry protects it from the next eviction', () => {
  cache.clear();
  for (let i = 0; i < CACHE_MAX; i++) cacheSet(`k${i}`, `v${i}`);
  cacheGet('k0');           // touch the oldest entry
  cacheSet('overflow', 'v'); // should now evict k1 instead of k0
  assert.equal(cacheGet('k0'), 'v0', 'recently read entry must survive');
  assert.equal(cacheGet('k1'), null, 'k1 is now the oldest and should be evicted');
});

// ─── analyze cache: TTL ───────────────────────────────────────────────────────

test('cache entry survives just under the 24h TTL', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  cache.clear();
  cacheSet('fresh', 'value');
  t.mock.timers.tick(CACHE_TTL_MS - 1000);
  assert.equal(cacheGet('fresh'), 'value');
});

test('cache entry expires once past the 24h TTL', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  cache.clear();
  cacheSet('stale', 'value');
  t.mock.timers.tick(CACHE_TTL_MS + 1000);
  assert.equal(cacheGet('stale'), null);
  assert.ok(!cache.has('stale'), 'expired entry should be deleted, not just hidden');
});

// ─── disk cache loading ───────────────────────────────────────────────────────

test('loadCacheFromDisk restores entries that are still fresh', () => {
  cache.clear();
  writeFileSync(CACHE_FILE, JSON.stringify([
    { key: 'x|||y', text: 'restored', t: Date.now() },
  ]));
  loadCacheFromDisk();
  assert.equal(cacheGet('x|||y'), 'restored');
});

test('loadCacheFromDisk drops entries already past their TTL', () => {
  cache.clear();
  writeFileSync(CACHE_FILE, JSON.stringify([
    { key: 'old', text: 'expired', t: Date.now() - CACHE_TTL_MS - 1000 },
    { key: 'new', text: 'kept', t: Date.now() },
  ]));
  loadCacheFromDisk();
  assert.equal(cache.has('old'), false, 'expired entry must not be restored');
  assert.equal(cacheGet('new'), 'kept');
});

test('loadCacheFromDisk skips malformed entries without dropping good ones', () => {
  cache.clear();
  writeFileSync(CACHE_FILE, JSON.stringify([
    { key: 'good', text: 'kept', t: Date.now() },
    { key: 123, text: 'bad key', t: Date.now() },
    { key: 'no-text', t: Date.now() },
    { key: 'no-timestamp', text: 'x' },
    null,
  ]));
  loadCacheFromDisk();
  assert.equal(cacheGet('good'), 'kept');
  assert.equal(cache.size, 1);
});

test('loadCacheFromDisk survives a corrupt cache file', () => {
  cache.clear();
  writeFileSync(CACHE_FILE, 'not json at all {{{');
  assert.doesNotThrow(() => loadCacheFromDisk());
  assert.equal(cache.size, 0);
});

test('loadCacheFromDisk ignores a JSON file that is not an array', () => {
  cache.clear();
  writeFileSync(CACHE_FILE, JSON.stringify({ key: 'x', text: 'y', t: Date.now() }));
  assert.doesNotThrow(() => loadCacheFromDisk());
  assert.equal(cache.size, 0);
});

test('loadCacheFromDisk is a no-op when the cache file does not exist', () => {
  cache.clear();
  rmSync(CACHE_FILE, { force: true });
  assert.doesNotThrow(() => loadCacheFromDisk());
  assert.equal(cache.size, 0);
});
