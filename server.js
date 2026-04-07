import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Basic auth — inline, no external package
if (process.env.AUTH_PASS) {
  const AUTH_USER = process.env.AUTH_USER || 'admin';
  const AUTH_PASS = process.env.AUTH_PASS;
  app.use((req, res, next) => {
    const b64 = (req.headers.authorization || '').replace(/^Basic\s+/i, '');
    if (b64) {
      const [u, p] = Buffer.from(b64, 'base64').toString('utf8').split(':');
      if (u === AUTH_USER && p === AUTH_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Theory of Change"');
    return res.status(401).end('Unauthorized');
  });
}

app.use(express.static(join(__dirname, 'public')));

app.post('/api/analyze', async (req, res) => {
  const { action, change } = req.body;
  if (!action || !change) return res.status(400).json({ error: 'action and change are required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set. Restart the server with: ANTHROPIC_API_KEY=your_key npm start' });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const prompt = `You are an expert in social change theory, history, and empirical research. Analyze this theory of change: "Doing '${action}' will create '${change}' in the world."

Be specific — cite real movements, researchers, and cases. Be concise: 1-2 sentences per field, short titles. Each array must have exactly 3 items.

Return ONLY valid JSON:
{
  "strength": <integer 0-100>,
  "strength_label": "<Strong | Moderate | Weak | Speculative>",
  "summary": "<2 sentences>",
  "mechanisms": ["<mechanism 1>", "<mechanism 2>", "<mechanism 3>"],
  "evidence_for": [
    {"title": "<short>", "description": "<1-2 sentences>", "source": "<name>"},
    {"title": "...", "description": "...", "source": "..."},
    {"title": "...", "description": "...", "source": "..."}
  ],
  "evidence_against": [
    {"title": "<short>", "description": "<1-2 sentences>", "source": "<name>"},
    {"title": "...", "description": "...", "source": "..."},
    {"title": "...", "description": "...", "source": "..."}
  ],
  "historical_examples": [
    {"name": "<movement>", "period": "<dates>", "outcome": "<1 sentence>", "relevance": "<1 sentence>"},
    {"name": "...", "period": "...", "outcome": "...", "relevance": "..."},
    {"name": "...", "period": "...", "outcome": "...", "relevance": "..."}
  ],
  "probing_questions": ["<question 1>", "<question 2>", "<question 3>"],
  "assumptions": ["<assumption 1>", "<assumption 2>", "<assumption 3>"]
}`;

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
    });

    stream.on('finalMessage', () => {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Theory of Change running at http://localhost:${PORT}`));
