# Theory of Change

A Claude-powered tool for stress-testing theories of change. Enter an action (X) and a desired outcome (Y), and the app returns a structured analysis: a strength score, causal mechanisms, evidence for and against, historical analogues, probing questions, and the hidden assumptions your theory depends on.

> *"Doing **X** will create **Y** in the world."*

## What it does

Given a theory of change, the app asks Claude (Sonnet 4.6) to return a single JSON object containing:

- **`strength`** — integer 0–100, plus a label (`Strong` / `Moderate` / `Weak` / `Speculative`)
- **`summary`** — two-sentence overall read
- **`mechanisms`** — three causal pathways from X to Y
- **`evidence_for`** / **`evidence_against`** — three items each, with title, description, and source
- **`historical_examples`** — three movements or cases with period, outcome, and relevance
- **`probing_questions`** — three questions to pressure-test the theory
- **`assumptions`** — three load-bearing assumptions the theory depends on

The response is streamed via Server-Sent Events so the UI can render it incrementally.

## Stack

- **Backend:** Node 22, Express, `@anthropic-ai/sdk`
- **Frontend:** single static `public/index.html` (no build step)
- **Model:** `claude-sonnet-4-6`
- **Deploy:** Dockerfile (Coolify-ready)

## Quick start

```bash
git clone https://github.com/mstem/theory-of-change.git
cd theory-of-change
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Open <http://localhost:3002>.

For auto-reload during development:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | — | Your Anthropic API key |
| `PORT` | no | `3002` | HTTP port |
| `AUTH_USER` | no | `admin` | Username for HTTP Basic Auth (only enforced if `AUTH_PASS` is set) |
| `AUTH_PASS` | no | — | If set, the entire app is gated behind Basic Auth |

Get an API key at <https://console.anthropic.com/>.

## API

### `POST /api/analyze`

Streams analysis as Server-Sent Events.

**Request body**

```json
{
  "action": "organizing rent strikes",
  "change": "stronger tenant protections"
}
```

**Response** — `text/event-stream`. Each event has the form:

```
data: {"chunk": "..."}
```

…concatenated chunks form the JSON payload described above. A final event signals completion:

```
data: {"done": true}
```

Errors are emitted as:

```
data: {"error": "..."}
```

## Operational guards

To keep API spend predictable under public traffic, the server applies a few defaults:

- **Rate limit:** 20 requests per 15 minutes per IP on `/api/analyze` (via `express-rate-limit`). Tunable in `server.js`.
- **Input caps:** `action` and `change` are each limited to 200 characters, and the JSON body to 4 KB.
- **Response cache:** identical `(action, change)` pairs (normalized lower-case) are served from an in-process LRU (1000 entries, 24 h TTL). Cached responses are replayed as a single SSE chunk. The cache is per-process — it does not survive restarts or span multiple replicas.
- **`trust proxy`** is set to `1` so the rate limiter sees the real client IP behind Coolify's reverse proxy.

## Deploy

### Docker

```bash
docker build -t theory-of-change .
docker run -p 3002:3002 -e ANTHROPIC_API_KEY=sk-ant-... theory-of-change
```

### Coolify

In your Coolify dashboard:

1. **New Resource → Public/Private Repository** and point it at this repo.
2. **Build Pack:** Dockerfile (auto-detected).
3. **Environment Variables:** add `ANTHROPIC_API_KEY` (and optionally `AUTH_USER` / `AUTH_PASS`) — mark them as build/runtime as needed.
4. **Network:** Coolify will detect the exposed port `3002`. Set a domain (or use the auto-generated one) and let Coolify provision the cert.
5. **Deploy.** Subsequent pushes to the tracked branch redeploy automatically.

## Project layout

```
.
├── server.js          # Express server + /api/analyze SSE endpoint
├── public/
│   └── index.html     # Single-page UI
├── package.json
└── Dockerfile
```

## License

[MIT](LICENSE) © 2026 Matt Stempeck
