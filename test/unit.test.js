import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// server.js reads CACHE_DIR at module load, so it has to be set before the import.
const TMP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'toc-unit-'));
const CACHE_FILE = join(TMP_CACHE_DIR, 'analyze-cache.json');
process.env.CACHE_DIR = TMP_CACHE_DIR;

const {
  buildCsp,
  inlineScriptHashes,
  serializeJsonBlock,
  escapeHtml,
  parseSourceUrl,
  textFromContent,
  isConclusiveLookup,
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

test('parseSourceUrl finds the answer when prose around it also has braces', () => {
  assert.equal(
    parseSourceUrl('That site uses a {slug} pattern. {"url":"https://example.org/report/x/"}'),
    'https://example.org/report/x/'
  );
});

test('parseSourceUrl reads the last answer when the model restates itself', () => {
  assert.equal(
    parseSourceUrl('{"url":"https://example.org/wrong/"}\nCorrecting that: {"url":"https://example.org/right/"}'),
    'https://example.org/right/'
  );
});

test('parseSourceUrl still returns nothing when no object carries a url', () => {
  assert.equal(parseSourceUrl('I looked at {a} and {b} and found nothing.'), '');
});

// ─── textFromContent ──────────────────────────────────────────────────────────
// Once the lookup call carries the web search tool, the JSON no longer arrives in
// content[0] — search and result blocks come first, so every text block counts.

test('textFromContent reads a reply that is a single text block', () => {
  assert.equal(textFromContent([{ type: 'text', text: '{"url":"https://example.org"}' }]),
    '{"url":"https://example.org"}');
});

test('textFromContent finds the JSON behind the search blocks that precede it', () => {
  const content = [
    { type: 'text', text: 'Let me look that up.' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'bpc report' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://bipartisanpolicy.org/report/x/' }] },
    { type: 'text', text: '{"url":"https://bipartisanpolicy.org/report/x/"}' },
  ];
  assert.equal(parseSourceUrl(textFromContent(content)), 'https://bipartisanpolicy.org/report/x/');
});

test('textFromContent ignores a search result whose url is not the answer', () => {
  const content = [
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://spam.example/' }] },
    { type: 'text', text: '{"url":""}' },
  ];
  assert.equal(parseSourceUrl(textFromContent(content)), '');
});

test('textFromContent returns an empty string when the reply carries no text block', () => {
  assert.equal(textFromContent([{ type: 'server_tool_use', id: 'x', name: 'web_search', input: {} }]), '');
});

// ─── isConclusiveLookup ───────────────────────────────────────────────────────
// An empty URL is worth caching for a week only when the model actually decided
// there was no link. A paused search turn or a truncated reply is a transient
// failure wearing the same clothes.

test('isConclusiveLookup accepts a reply that ended with an answer', () => {
  assert.equal(isConclusiveLookup({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"url":""}' }]
  }), true);
});

test('isConclusiveLookup rejects a turn the API paused mid-search', () => {
  assert.equal(isConclusiveLookup({
    stop_reason: 'pause_turn',
    content: [{ type: 'server_tool_use', id: 'x', name: 'web_search', input: {} }]
  }), false);
});

test('isConclusiveLookup rejects a reply cut off by the token cap', () => {
  assert.equal(isConclusiveLookup({
    stop_reason: 'max_tokens',
    content: [{ type: 'text', text: '{"url":"https://example.org/rep' }]
  }), false);
});

test('isConclusiveLookup rejects a finished turn that produced no text at all', () => {
  assert.equal(isConclusiveLookup({
    stop_reason: 'end_turn',
    content: [{ type: 'web_search_tool_result', tool_use_id: 'x', content: [] }]
  }), false);
});

test('isConclusiveLookup rejects a malformed message rather than trusting it', () => {
  assert.equal(isConclusiveLookup(undefined), false);
  assert.equal(isConclusiveLookup({}), false);
});

test('textFromContent survives a missing or malformed content array', () => {
  assert.equal(textFromContent(undefined), '');
  assert.equal(textFromContent(null), '');
  assert.equal(textFromContent('not an array'), '');
  assert.equal(textFromContent([null, { type: 'text' }, { type: 'text', text: 5 }]), '');
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

// ─── CSP ──────────────────────────────────────────────────────────────────────

test('inlineScriptHashes hashes inline scripts and skips ones with a src', () => {
  const html = `
    <script async src="https://example.com/a.js"></script>
    <script>console.log(1);</script>
    <script type="text/javascript">console.log(2);</script>
  `;
  const hashes = inlineScriptHashes(html);
  assert.equal(hashes.length, 2);
  for (const h of hashes) assert.match(h, /^'sha256-[A-Za-z0-9+/]+={0,2}'$/);
});

test('inlineScriptHashes hashes the exact script body', () => {
  const body = 'console.log(1);';
  const expected = createHash('sha256').update(body, 'utf8').digest('base64');
  assert.deepEqual(inlineScriptHashes(`<script>${body}</script>`), [`'sha256-${expected}'`]);
});

test('inlineScriptHashes returns nothing when every script is external', () => {
  assert.deepEqual(inlineScriptHashes('<script src="/app.js"></script>'), []);
});

test('buildCsp puts every inline hash in script-src and blocks framing', () => {
  const csp = buildCsp('<script>a()</script><script>b()</script>');
  const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'));
  assert.equal((scriptSrc.match(/'sha256-/g) || []).length, 2);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});

test('inlineScriptHashes skips data blocks, which the browser never executes', () => {
  const html = `
    <script type="application/json" id="i18n">{"headline":"How will {X}"}</script>
    <script type="application/ld+json">{"@type":"WebSite"}</script>
    <script type="speculationrules">{"prerender":[]}</script>
  `;
  assert.deepEqual(inlineScriptHashes(html), []);
});

test('inlineScriptHashes hashes every script type that script-src actually covers', () => {
  const html = `
    <script>a()</script>
    <script type="">b()</script>
    <script type="module">c()</script>
    <script type="importmap">{"imports":{}}</script>
    <script type="TEXT/JavaScript">d()</script>
    <script type="text/javascript; charset=utf-8">e()</script>
    <script type=text/javascript>f()</script>
  `;
  assert.equal(inlineScriptHashes(html).length, 7);
});

test('inlineScriptHashes hashes a script whose only type-like attribute is data-type', () => {
  const hashes = inlineScriptHashes('<script data-type="application/json">alert(1)</script>');
  assert.equal(hashes.length, 1);
});

test('inlineScriptHashes still skips a data block that also carries a src', () => {
  assert.deepEqual(inlineScriptHashes('<script type="application/json" src="/a.json"></script>'), []);
});

test('a data block does not change the policy it is embedded under', () => {
  const withData = buildCsp('<script>a()</script><script type="application/json">{}</script>');
  const without = buildCsp('<script>a()</script>');
  assert.equal(withData, without);
});

test('serializeJsonBlock neutralises a payload that would close the script block', () => {
  const hostile = { summary: '</script><img src=x onerror=alert(1)>' };
  const out = serializeJsonBlock(hostile);
  assert.equal(out.includes('</script>'), false);
  assert.equal(out.includes('<'), false);
  assert.equal(out.includes('>'), false);
  assert.equal(JSON.parse(out).summary, hostile.summary);
});

test('serializeJsonBlock escapes the separators that are legal in JSON but not in JS', () => {
  const raw = `a\u2028b\u2029c`;
  const out = serializeJsonBlock({ s: raw });
  assert.equal(out.includes('\u2028'), false);
  assert.equal(out.includes('\u2029'), false);
  assert.equal(JSON.parse(out).s, raw);
});

test('serializeJsonBlock round-trips a full bundle unchanged', () => {
  const bundle = { headline: 'How will {X}\ncreate {Y}\nin the world?', n: 3, ok: true, missing: null };
  assert.deepEqual(JSON.parse(serializeJsonBlock(bundle)), bundle);
});

test('the shipped index.html has no inline event handlers, which no hash could cover', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  const handlerInMarkup = /<[a-z][^>]*\son[a-z]+\s*=\s*["']/i;
  assert.equal(handlerInMarkup.test(html), false);
});
