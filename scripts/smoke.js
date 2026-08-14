#!/usr/bin/env node
// Smoke test against a running deployment. Unlike the unit tests, this makes real
// network calls and needs the site to be up — it is what tells you the container
// died, the Anthropic key expired, or the curator backend went away.
//
//   npm run smoke                                  # checks production
//   SMOKE_URL=http://localhost:3002 npm run smoke  # checks a local server
//
// Exits 0 if every check passes, 1 otherwise, and prints a one-line summary the
// CI job forwards to ntfy.

const BASE = (process.env.SMOKE_URL || 'https://theory.evensfoundation.eu').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 45000);

const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms, detail });
    console.log(`PASS  ${name} (${ms}ms)${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ name, ok: false, ms, detail: err.message });
    console.error(`FAIL  ${name} (${ms}ms) — ${err.message}`);
  }
}

function request(path, init = {}) {
  return fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
}

function postJson(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// ─── 1. The site is up and serving the real page ──────────────────────────────

await check('homepage responds 200 with the expected content', async () => {
  const res = await request('/');
  expect(res.status === 200, `expected 200, got ${res.status}`);
  const html = await res.text();
  expect(/theory of change/i.test(html), 'page HTML did not contain "Theory of Change"');
  expect(html.length > 5000, `page HTML was only ${html.length} bytes — looks like an error page`);
  return `${(html.length / 1024).toFixed(0)}kb`;
});

await check('static assets are served', async () => {
  const res = await request('/og-image.png');
  expect(res.status === 200, `expected 200, got ${res.status}`);
  expect(res.headers.get('cache-control') === 'public, max-age=2592000', 'missing 30-day cache header');
  return 'og-image.png cached';
});

// ─── 2. Input validation is alive on every write route ────────────────────────
// These cost nothing: they are rejected before any API call or email is sent.

await check('analyze rejects an empty request', async () => {
  const res = await postJson('/api/analyze', {});
  expect(res.status === 400, `expected 400, got ${res.status}`);
  return 'validation active';
});

await check('feedback route is alive and validating', async () => {
  const res = await postJson('/api/feedback', {});
  expect(res.status === 400, `expected 400, got ${res.status}`);
  const body = await res.json();
  expect(/message is required/i.test(body.error || ''), `unexpected error text: ${body.error}`);
  return 'validation active (no email sent)';
});

// ─── 3. The Anthropic key actually works ──────────────────────────────────────
// One real streaming call per run. We abort as soon as the first content chunk
// arrives — enough to prove the key is valid and the model is reachable, without
// paying for a full 4096-token analysis.

await check('analyze streams a real response from the model', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Date-stamped so each day's run misses the server's 24h cache and actually
    // reaches the model. A fixed string would be replayed from cache and would
    // keep passing long after the API key expired — the opposite of the point.
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: `daily uptime check ${today}`, change: 'a working service' }),
      signal: controller.signal,
    });
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(
      (res.headers.get('content-type') || '').includes('text/event-stream'),
      `expected an SSE stream, got ${res.headers.get('content-type')}`
    );

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (buffer.length < 400) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let payload;
        try { payload = JSON.parse(line.slice(6)); } catch { continue; }
        if (payload.error) throw new Error(`server returned an error: ${payload.error}`);
      }
    }

    expect(buffer.includes('data: '), 'stream produced no SSE events');
    expect(/"chunk"/.test(buffer), 'stream produced no content chunks');
    return `first ${buffer.length} bytes streamed`;
  } finally {
    clearTimeout(timer);
    controller.abort(); // stop the stream; we have what we need
  }
});

// ─── 4. The curator proxy is reachable ────────────────────────────────────────
// This route degrades silently by design (returns an empty list on any failure),
// so an empty result for a deliberately broad query means the backend is down.

await check('curator proxy returns real recommendations', async () => {
  const res = await postJson('/api/recommend', { text: 'community organizing', limit: 3 });
  expect(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  expect(Array.isArray(body.categories), 'response had no categories array');
  expect(
    body.categories.length > 0,
    'curator returned zero categories for a broad query — the backend is likely down or CURATOR_API_URL is unset'
  );
  return `${body.categories.length} categories`;
});

// ─── Summary ──────────────────────────────────────────────────────────────────

const failed = results.filter(r => !r.ok);
const summary = `${results.length - failed.length}/${results.length} checks passed against ${BASE}`;

console.log(`\n${summary}`);

if (failed.length) {
  console.error(`\nFailed: ${failed.map(f => f.name).join('; ')}`);
  // Written to the GitHub step summary and forwarded to ntfy by the workflow.
  if (process.env.GITHUB_ENV) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_ENV, `SMOKE_FAILURES=${failed.map(f => `${f.name} (${f.detail})`).join(' | ')}\n`);
  }
  process.exit(1);
}
