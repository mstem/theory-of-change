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
  webSearchUsage,
  isCompleteAnalysis,
  analysisCost,
  recordSpend,
  spentToday,
  budgetExhausted,
  reserveSpend,
  settleSpend,
  DAILY_BUDGET_USD,
  DAILY_LOOKUP_BUDGET_USD,
  isConclusiveLookup,
  lookupTtl,
  searchResultCount,
  lookupCost,
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
    content: [
      { type: 'web_search_tool_result', tool_use_id: 'a', content: [{ type: 'web_search_result', url: 'https://example.org/' }] },
      { type: 'text', text: '{"url":""}' }
    ]
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

// A search that failed is not a search that came back empty. Both end the turn
// with a well-formed {"url":""}, so the error block is the only thing that tells
// them apart, and caching the first as an answer strands the citation.

test('isConclusiveLookup rejects a reply whose search hit the use limit', () => {
  assert.equal(isConclusiveLookup({
    stop_reason: 'end_turn',
    content: [
      { type: 'web_search_tool_result', tool_use_id: 'a', content: [{ type: 'web_search_result', url: 'https://example.org/' }] },
      { type: 'web_search_tool_result', tool_use_id: 'b', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
      { type: 'text', text: '{"url":""}' }
    ]
  }), false);
});

test('isConclusiveLookup rejects a reply whose search was rate limited', () => {
  assert.equal(isConclusiveLookup({
    stop_reason: 'end_turn',
    content: [
      { type: 'web_search_tool_result', tool_use_id: 'a', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } },
      { type: 'text', text: '{"url":""}' }
    ]
  }), false);
});

// This one asserted the opposite until a run on the sibling endpoint showed the
// model announcing that search had stopped working and then answering from
// memory, with every result block an empty list and no error anywhere. A search
// that genuinely matched nothing and a search that silently did nothing are the
// same bytes, so neither is cached. Empties expire in an hour, so the cost of
// re-asking is one lookup; the cost of believing a broken search is a citation
// that stays dead.
test('isConclusiveLookup declines to cache a run where no search returned anything', () => {
  assert.equal(isConclusiveLookup({
    stop_reason: 'end_turn',
    content: [
      { type: 'web_search_tool_result', tool_use_id: 'a', content: [] },
      { type: 'text', text: '{"url":""}' }
    ]
  }), false);
});

// ─── searchResultCount ────────────────────────────────────────────────────────
// A search can come back as an empty list rather than an error, which reads as
// success to anything checking only for an error block. When every search
// returns nothing, whatever URL the model then writes came out of training data,
// which is the bug this endpoint exists to fix.

test('searchResultCount adds up the hits across every search', () => {
  assert.equal(searchResultCount([
    { type: 'web_search_tool_result', tool_use_id: 'a', content: [{ type: 'web_search_result' }, { type: 'web_search_result' }] },
    { type: 'web_search_tool_result', tool_use_id: 'b', content: [{ type: 'web_search_result' }] },
    { type: 'text', text: '{"url":"https://example.org/"}' }
  ]), 3);
});

test('searchResultCount counts a silent empty search as no evidence', () => {
  assert.equal(searchResultCount([
    { type: 'web_search_tool_result', tool_use_id: 'a', content: [] },
    { type: 'web_search_tool_result', tool_use_id: 'b', content: [] }
  ]), 0);
});

test('searchResultCount counts a reply that never searched as no evidence', () => {
  assert.equal(searchResultCount([{ type: 'text', text: '{"url":"https://example.org/"}' }]), 0);
});

test('isConclusiveLookup rejects an answer no search result supports', () => {
  assert.equal(isConclusiveLookup({
    stop_reason: 'end_turn',
    content: [
      { type: 'web_search_tool_result', tool_use_id: 'a', content: [] },
      { type: 'text', text: '{"url":"https://bipartisanpolicy.org/"}' }
    ]
  }), false);
});

// ─── lookupCost ───────────────────────────────────────────────────────────────
// Searches dominate: three of them cost more than the tokens of the whole call.
// Haiku 4.5 is $1 per million in and $5 per million out; a search is $0.01.

test('lookupCost charges searches and tokens together', () => {
  const usd = lookupCost({ usage: {
    input_tokens: 2000, output_tokens: 200,
    server_tool_use: { web_search_requests: 3 }
  } });
  // 3 searches = $0.03, 2000 in = $0.002, 200 out = $0.001
  assert.equal(Number(usd.toFixed(4)), 0.033);
});

test('lookupCost charges nothing for a reply that never searched', () => {
  const usd = lookupCost({ usage: { input_tokens: 1000, output_tokens: 100 } });
  assert.equal(Number(usd.toFixed(4)), 0.0015);
});

test('lookupCost treats a missing usage block as free rather than crashing', () => {
  assert.equal(lookupCost(undefined), 0);
  assert.equal(lookupCost({}), 0);
});

// ─── lookupTtl ────────────────────────────────────────────────────────────────
// A found link is a fact about the web and keeps. "I did not find it" is a fact
// about one search, and pinning that for a week strands a citation that the next
// attempt would have resolved.

test('lookupTtl keeps a found link for the full week', () => {
  assert.equal(lookupTtl('https://example.org/report/'), 7 * 24 * 60 * 60 * 1000);
});

test('lookupTtl lets an empty result expire within the hour', () => {
  assert.equal(lookupTtl(''), 60 * 60 * 1000);
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

// ─── Evidence columns ─────────────────────────────────────────────────────────
// renderEvidenceColumn lives in public/app.js, which is a plain browser script with
// top-level DOM access, so it cannot be imported. Slice the two functions it needs out
// of the shipped file and run them against a stub document — this exercises the real
// shipped code rather than a copy that can drift.

// Slices a top-level function out of the shipped script. Braces inside strings,
// comments and regex literals do not count toward nesting: escapeHtml's /[&<>"']/g
// holds both quote characters, and renderEvidenceColumn's /^\d{4}$/ holds a brace pair.
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `public/app.js no longer defines ${name}`);

  // A slash opens a regex rather than dividing when the last meaningful character
  // cannot end an expression.
  const REGEX_MAY_FOLLOW = new Set([...'(,=:[!&|?{};+-*%~^<>', undefined]);
  let depth = 0;
  let previous;

  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && next === '*') { i = src.indexOf('*/', i) + 1; continue; }

    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === c) break;
      }
      previous = c;
      continue;
    }

    if (c === '/' && REGEX_MAY_FOLLOW.has(previous)) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
      }
      previous = '/';
      continue;
    }

    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1);

    if (!/\s/.test(c)) previous = c;
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function renderColumn(elId, items, strings = {}) {
  const appSrc = readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const el = { innerHTML: '' };
  const doc = { getElementById: (id) => (id === elId ? el : null) };
  // An empty strings map stands in for a page whose bundle never loaded, which is
  // the case the English fallbacks exist for.
  const t = (key) => strings[key] ?? '';
  const body = [sliceFunction(appSrc, 'escapeHtml'), sliceFunction(appSrc, 'renderEvidenceColumn')].join('\n');
  new Function('document', 't', 'elId', 'items', `${body}\nrenderEvidenceColumn(elId, items);`)(
    doc, t, elId, items);
  return el.innerHTML;
}

const ITEM = { title: 'Demos poll', description: 'One in five UK adults used AI.', source: 'Demos', as_of: '2026' };

test('an empty evidence column reads as a finding, not a failed load', () => {
  const html = renderColumn('evidence-against', []);
  assert.match(html, /evidence-empty/);
  assert.match(html, /against/);
  assert.equal(/evidence-item/.test(html), false);
});

test('each evidence column names its own side when empty', () => {
  assert.match(renderColumn('evidence-for', []), /evidence\s+for this/);
  assert.match(renderColumn('evidence-against', []), /evidence\s+against this/);
});

test('a missing evidence array is treated as empty rather than throwing', () => {
  assert.match(renderColumn('evidence-for', undefined), /evidence-empty/);
});

test('an evidence item shows the year its finding is from', () => {
  const html = renderColumn('evidence-for', [ITEM]);
  assert.match(html, /source-year[^>]*> · 2026</);
});

// The lookup handler does querySelector('.source-sep') and removes the first match, so a
// second element carrying that class would make it delete the wrong separator.
test('an evidence item carries exactly one source-sep for the lookup handler to remove', () => {
  const html = renderColumn('evidence-for', [ITEM]);
  assert.equal(html.match(/class="source-sep"/g).length, 1);
});

test('an as_of that is not a four-digit year is dropped rather than printed', () => {
  for (const asOf of ['mid-2020s', '', 'n/a', '26']) {
    const html = renderColumn('evidence-for', [{ ...ITEM, as_of: asOf }]);
    assert.equal(/source-year/.test(html), false, `rendered a year for ${JSON.stringify(asOf)}`);
  }
});

test('the analyze prompt asks for evidence-led counts, not three items a side', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'server.js'), 'utf8');
  assert.equal(/Each array must have exactly 3 items/.test(src), false);
  assert.match(src, /evidence_for and evidence_against take 0 to 3 items each/);
  assert.match(src, /Work from sources to claims, never the reverse/);
});

test('a translated empty-column message replaces the English fallback', () => {
  const html = renderColumn('evidence-against', [], { 'evidence.noneAgainst': 'Geen substantieel bewijs.' });
  assert.match(html, /Geen substantieel bewijs\./);
  assert.equal(/No substantial evidence/.test(html), false);
});

// Drift between these two fallbacks and locales/en.json is covered for every key in
// the script by i18n-keys.test.js, so it is not repeated here.

// The progressive renderer walks SECTIONS_IN_ORDER and breaks on the first key whose
// value has not fully arrived. An empty column must read as a complete value, or every
// section after it would stop streaming and wait for the final parse.
test('an empty evidence array reads as a complete value, so streaming does not stall on it', () => {
  const appSrc = readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const extract = new Function(
    `${sliceFunction(appSrc, 'extractCompleteJsonValue')}\nreturn extractCompleteJsonValue;`)();

  const buf = '{"summary": "x", "evidence_for": [], "evidence_against": [{"title": "t"}]';
  assert.equal(extract(buf, 'evidence_for'), '[]');
  assert.ok(extract(buf, 'evidence_for'), 'an empty array must be truthy or the render loop breaks');
  assert.deepEqual(JSON.parse(extract(buf, 'evidence_for')), []);
  assert.equal(extract(buf, 'evidence_against'), '[{"title": "t"}]');
});

// A column the model omits entirely, rather than sending as [], breaks the progressive
// loop and defers every later section to the final parse. The prompt forbids it.
test('the prompt requires both evidence keys even when a column is empty', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /Always emit both keys, writing an empty column as \[\] rather than omitting the key/);
});

// ─── Grounding the analysis in search ─────────────────────────────────────────
// A server tool that fails does not throw. The request comes back 200 and the
// result block holds an error object where the list of results would be, so an
// analysis can quietly fall back to the model's own knowledge with no signal.

test('a failed web search is reported rather than read as a result', () => {
  const msg = {
    stop_reason: 'end_turn',
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'chatbot adoption 2026' } },
      { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
      { type: 'text', text: '{}' }
    ]
  };
  assert.deepEqual(webSearchUsage(msg), { searches: 1, errors: ['max_uses_exceeded'], results: 0 });
});

test('a web search that returned results counts as grounding, not as an error', () => {
  const msg = {
    stop_reason: 'end_turn',
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'chatbot adoption 2026' } },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.org/report' }] },
      { type: 'text', text: '{}' }
    ]
  };
  assert.deepEqual(webSearchUsage(msg), { searches: 1, errors: [], results: 1 });
});

test('an analysis the model answered without searching reports no searches', () => {
  assert.deepEqual(webSearchUsage({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }),
    { searches: 0, errors: [], results: 0 });
});

test('a response with no content block array is not mistaken for a grounded one', () => {
  assert.deepEqual(webSearchUsage(undefined), { searches: 0, errors: [], results: 0 });
  assert.deepEqual(webSearchUsage({ content: 'not blocks' }), { searches: 0, errors: [], results: 0 });
});

// The 24-hour cache is what makes the search cost bearable, and it is also what
// makes a bad analysis stick. A turn that paused at the server-side tool-loop
// limit, or hit the token cap, carries truncated JSON — cache it and every visitor
// for the next day gets the broken half.

test('a turn that paused mid-search is not a complete analysis', () => {
  assert.equal(isCompleteAnalysis({ stop_reason: 'pause_turn', content: [{ type: 'text', text: '{"strength"' }] }), false);
});

test('a turn cut off at the token cap is not a complete analysis', () => {
  assert.equal(isCompleteAnalysis({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"strength"' }] }), false);
});

test('a turn the model finished on its own is a complete analysis', () => {
  assert.equal(isCompleteAnalysis({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }), true);
});

test('a response that never arrived is not a complete analysis', () => {
  assert.equal(isCompleteAnalysis(undefined), false);
  assert.equal(isCompleteAnalysis({}), false);
});

// Search puts the model in a mood to explain itself. Anything it says before the
// opening brace lands in the same buffer the progressive renderer reads, and the
// renderer must still find the sections underneath it.
test('text written before the JSON does not hide a finished section', () => {
  const appSrc = readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const extract = new Function(
    `${sliceFunction(appSrc, 'extractCompleteJsonValue')}\nreturn extractCompleteJsonValue;`)();

  const buf = 'I looked up recent adoption figures first.\n{"strength": 62, "summary": "x", "evidence_for": []';
  assert.equal(extract(buf, 'strength'), '62');
  assert.equal(extract(buf, 'summary'), '"x"');
  assert.equal(extract(buf, 'evidence_for'), '[]');
});

// The model narrates before it searches, so the final parse can no longer assume the
// buffer is JSON and nothing else. Taking everything from the first brace to the last
// one works only for as long as the narration happens to contain no braces.
test('a brace in the search narration does not become the start of the analysis', () => {
  const appSrc = readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const extract = new Function(
    [sliceFunction(appSrc, 'parseJSON'), sliceFunction(appSrc, 'isRecoverableJson'),
     sliceFunction(appSrc, 'extractJsonObject'), 'return extractJsonObject;'].join('\n'))();

  const buf = 'I will return {the analysis} once I have searched.\n{"strength": 62, "summary": "x"}';
  assert.equal(extract(buf), '{"strength": 62, "summary": "x"}');
});

test('a response cut off before its closing brace still yields something to repair', () => {
  const appSrc = readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const extract = new Function(
    [sliceFunction(appSrc, 'parseJSON'), sliceFunction(appSrc, 'isRecoverableJson'),
     sliceFunction(appSrc, 'extractJsonObject'), 'return extractJsonObject;'].join('\n'))();

  const buf = '{"strength": 62, "evidence_for": [{"title": "t"}], "summary": "cut off here';
  assert.match(extract(buf), /^\{"strength": 62/);
});

// The model writes something before the JSON whatever the prompt says, and every
// character of it is billed output the reader never sees. The instruction can only
// make that preamble cheap, so it is worth pinning that the instruction is there.
test('the prompt holds the preamble to a machine notation rather than prose', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /Before the JSON, write nothing a person would read/);
  assert.match(src, /one line per search in the form q:<keywords>/);
});

// ─── What a grounded analysis costs ───────────────────────────────────────────
// Published Opus 4.8 rates: $5 per million input tokens, $25 per million output,
// a tenth of input for a cache read, and $10 per thousand searches.

test('the cost of an analysis is its tokens plus its searches', () => {
  const usd = analysisCost({
    input_tokens: 100_000,
    output_tokens: 2_000,
    server_tool_use: { web_search_requests: 3 }
  });
  assert.equal(Number(usd.toFixed(4)), 0.5800); // 0.50 + 0.05 + 0.03
});

test('a cache read costs a tenth of what reading it fresh would', () => {
  const usd = analysisCost({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 });
  assert.equal(Number(usd.toFixed(4)), 0.5);
});

test('a usage object the API did not send costs nothing rather than NaN', () => {
  assert.equal(analysisCost(undefined), 0);
  assert.equal(analysisCost({}), 0);
});

// ─── The daily ceiling ────────────────────────────────────────────────────────

test('spend accumulates across the analyses run in one day', () => {
  const noon = Date.UTC(2026, 8, 11, 12);
  recordSpend(0.4, noon);
  recordSpend(0.6, noon);
  assert.equal(Number(spentToday(noon).toFixed(4)), 1);
});

test('spend starts again when the day rolls over', () => {
  const day1 = Date.UTC(2026, 8, 12, 23);
  const day2 = Date.UTC(2026, 8, 13, 1);
  recordSpend(5, day1);
  assert.equal(spentToday(day1), 5);
  assert.equal(spentToday(day2), 0);
});

test('the ceiling is reached at the budget, not past it', () => {
  const day = Date.UTC(2026, 8, 14, 9);
  assert.equal(budgetExhausted(day), false);
  recordSpend(DAILY_BUDGET_USD - 0.01, day);
  assert.equal(budgetExhausted(day), false);
  recordSpend(0.01, day);
  assert.equal(budgetExhausted(day), true);
});

// A search can come back successful and empty. There is no error block, the turn
// ends cleanly, and the analysis reads like every other one, but nothing grounded
// it. Counting the results is the only way that shows up anywhere.
test('a search that returned nothing is not counted as grounding', () => {
  const msg = {
    stop_reason: 'end_turn',
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'a' } },
      { type: 'web_search_tool_result', content: [] },
      { type: 'server_tool_use', name: 'web_search', input: { query: 'b' } },
      { type: 'web_search_tool_result', content: [] },
      { type: 'text', text: '{}' }
    ]
  };
  assert.deepEqual(webSearchUsage(msg), { searches: 2, errors: [], results: 0 });
});

test('results are counted across every search in the turn', () => {
  const msg = {
    content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result' }, { type: 'web_search_result' }] },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result' }] }
    ]
  };
  assert.equal(webSearchUsage(msg).results, 3);
});

// Citation lookups are cheap, unauthenticated and can fire several times on one
// page. Sharing a single ceiling with analyses would let an afternoon of clicking
// spend the day the analyses needed, so lookups get a slice rather than the run of it.

test('lookups cannot take more of the day than their own slice', () => {
  const day = Date.UTC(2026, 8, 20, 9);
  recordSpend(DAILY_LOOKUP_BUDGET_USD, day, 'lookup');
  assert.equal(budgetExhausted(day, 'lookup'), true);
});

test('an analysis is never turned away by what lookups spent', () => {
  const day = Date.UTC(2026, 8, 21, 9);
  recordSpend(DAILY_LOOKUP_BUDGET_USD, day, 'lookup');
  assert.equal(budgetExhausted(day, 'analysis'), false);
});

test('what lookups spend still counts toward the day', () => {
  const day = Date.UTC(2026, 8, 22, 9);
  recordSpend(1, day, 'lookup');
  recordSpend(2, day, 'analysis');
  assert.equal(Number(spentToday(day).toFixed(4)), 3);
});

test('lookups stop when the whole day is spent, slice or no slice', () => {
  const day = Date.UTC(2026, 8, 23, 9);
  recordSpend(DAILY_BUDGET_USD, day, 'analysis');
  assert.equal(budgetExhausted(day, 'lookup'), true);
});

// ─── What the wait shows ──────────────────────────────────────────────────────
// Nothing renders until the searches finish, which is most of a minute at best.
// The searches themselves arrive long before that, as q: lines, so the wait can
// show what is actually happening rather than a spinner and a promise.

function searchQueries(buf) {
  const appSrc = readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  return new Function(
    `${sliceFunction(appSrc, 'extractSearchQueries')}\nreturn extractSearchQueries;`)()(buf);
}

test('each search shows up once the model has finished writing it', () => {
  assert.deepEqual(searchQueries('q:participatory budgeting trust\nq:porto alegre outcomes\n'),
    ['participatory budgeting trust', 'porto alegre outcomes']);
});

test('a search still being written is not shown half-typed', () => {
  assert.deepEqual(searchQueries('q:participatory budgeting trust\nq:porto ale'),
    ['participatory budgeting trust']);
});

test('a search is complete once the JSON has started, newline or not', () => {
  assert.deepEqual(searchQueries('q:a\nq:b{"strength": 60'), ['a', 'b']);
});

// The model drops back into prose when a search goes wrong, and that prose is not
// for the reader: it is the model talking to itself about rate limits.
test('anything the model writes that is not a search is not shown', () => {
  const buf = 'q:basic income labour supply\nWaiting for rate limit to reset.The search tool appears rate-limited.\n';
  assert.deepEqual(searchQueries(buf), ['basic income labour supply']);
});

test('a q: inside the analysis itself is not mistaken for a search', () => {
  assert.deepEqual(searchQueries('q:a\n{"summary": "q:not a search"}'), ['a']);
});

test('an answer that came back with no searches at all shows nothing', () => {
  assert.deepEqual(searchQueries('{"strength": 60'), []);
  assert.deepEqual(searchQueries(''), []);
});

// The analysis is the outermost object in the buffer. A raw newline inside a string
// value makes it fail a strict parse, which is the whole reason parseJSON exists, so
// strictness is the wrong test for which object to take: the first one that passes it
// is an evidence item, and rendering that wipes every section already on screen.
test('a repairable analysis is preferred over a child of it that parses cleanly', () => {
  const appSrc = readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const extract = new Function(
    [sliceFunction(appSrc, 'parseJSON'), sliceFunction(appSrc, 'isRecoverableJson'),
     sliceFunction(appSrc, 'extractJsonObject'), 'return extractJsonObject;'].join('\n'))();

  const buf = 'q:mutual aid trust\n{"strength": 62, "summary": "Line one\nLine two", "evidence_for": [{"title": "T"}]}';
  assert.match(extract(buf), /^\{"strength": 62/);
});

test('a brace in the narration is still skipped, repairable or not', () => {
  const appSrc = readFileSync(join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  const extract = new Function(
    [sliceFunction(appSrc, 'parseJSON'), sliceFunction(appSrc, 'isRecoverableJson'),
     sliceFunction(appSrc, 'extractJsonObject'), 'return extractJsonObject;'].join('\n'))();

  assert.equal(extract('I will return {the analysis} once I have searched.\n{"strength": 62}'), '{"strength": 62}');
});

// Same assumption, other function: the first brace in the buffer is not necessarily
// the analysis, and cutting there stops the searches rendering for the rest of the wait.
test('a brace in the narration does not stop the searches from showing', () => {
  assert.deepEqual(searchQueries('q:a\nI will return {the analysis} next.\nq:b\n'), ['a', 'b']);
});

// ─── Reserving before spending ────────────────────────────────────────────────
// An analysis takes minutes, and what it cost is only known at the end. Charging
// the day only then leaves a window where every request that starts sees a budget
// that six other running analyses have already committed.

test('a reservation is charged the moment the analysis starts', () => {
  const day = Date.UTC(2026, 9, 1, 9);
  reserveSpend(day);
  assert.ok(spentToday(day) > 0, 'nothing was charged until the analysis finished');
});

test('settling replaces the estimate with what the analysis actually cost', () => {
  const day = Date.UTC(2026, 9, 2, 9);
  const reservation = reserveSpend(day);
  settleSpend(reservation, 0.42, day);
  assert.equal(Number(spentToday(day).toFixed(4)), 0.42);
});

test('an analysis that never finished stays charged at the estimate', () => {
  const day = Date.UTC(2026, 9, 3, 9);
  const before = spentToday(day);
  reserveSpend(day);
  assert.ok(spentToday(day) > before, 'a failed run cost searches and tokens and must still count');
});

test('a reservation made yesterday does not subtract from today', () => {
  const yesterday = Date.UTC(2026, 9, 4, 23);
  const today = Date.UTC(2026, 9, 5, 1);
  const reservation = reserveSpend(yesterday);
  settleSpend(reservation, 0.42, today);
  assert.equal(Number(spentToday(today).toFixed(4)), 0.42);
});
