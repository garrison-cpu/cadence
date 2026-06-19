/* ============================================================================
   Cadence — proxy server
   ----------------------------------------------------------------------------
   WHY THIS EXISTS:
   The browser must NEVER see your Claude or RapidAPI keys. So the browser talks
   only to THIS server, and this server adds the secret keys and forwards the
   request to Anthropic / TokAPI / Reddit. The keys live in environment
   variables (Replit "Secrets"), never in any file you ship to the browser.

   ROUTES:
     GET  /              -> marketing site   (public/index.html)
     GET  /app           -> the tool         (public/app.html)
     POST /api/claude    -> proxy to Anthropic (key added here)
     GET  /api/tokapi/*  -> proxy to TokAPI    (key added here)
     GET  /api/reddit/*  -> proxy to Reddit    (avoids browser CORS)
     GET  /api/youtube/* -> proxy to YouTube   (key added here)

   ACCESS:
   Open — anyone with the link can use it. Because all usage runs on YOUR keys,
   you pay for everything. If you later want to limit spend, add a rate limit or
   an access gate in front of the /api/* routes.
   ========================================================================== */

const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Secrets (set these in Replit → Tools → Secrets) ─────────────────────────
const CLAUDE_KEY   = process.env.CLAUDE_API_KEY || '';
const RAPID_KEY    = process.env.RAPIDAPI_KEY   || '';
const YOUTUBE_KEY  = process.env.YOUTUBE_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL   || 'claude-sonnet-4-6';

const TOKAPI_HOST = 'tokapi-mobile-version.p.rapidapi.com';
const TOKAPI_BASE = 'https://' + TOKAPI_HOST;

if (!CLAUDE_KEY)  console.warn('⚠  CLAUDE_API_KEY is not set — /api/claude will fail.');
if (!RAPID_KEY)   console.warn('⚠  RAPIDAPI_KEY is not set — /api/tokapi will fail.');
if (!YOUTUBE_KEY) console.warn('⚠  YOUTUBE_API_KEY is not set — /api/youtube will fail.');

app.use(express.json({ limit: '1mb' }));

// ── Claude proxy ─────────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  try {
    const { prompt, useSearch, maxTokens } = req.body || {};
    if (!prompt) return res.status(400).json({ error: { message: 'Missing prompt.' } });
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: Math.min(Number(maxTokens) || 4000, 16000),
      messages: [{ role: 'user', content: String(prompt) }],
    };
    if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,            // ← secret, server-side only
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: { message: 'Proxy error: ' + e.message } });
  }
});

// ── TokAPI proxy (everything after /api/tokapi is forwarded) ─────────────────
app.get('/api/tokapi/*', async (req, res) => {
  try {
    const upstream = TOKAPI_BASE + req.originalUrl.replace(/^\/api\/tokapi/, '');
    const r = await fetch(upstream, {
      headers: { 'x-rapidapi-key': RAPID_KEY, 'x-rapidapi-host': TOKAPI_HOST },
    });
    const text = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'TokAPI proxy error: ' + e.message } });
  }
});

// ── Reddit proxy (public JSON, but proxying avoids browser CORS) ─────────────
app.get('/api/reddit/*', async (req, res) => {
  try {
    const upstream = 'https://www.reddit.com' + req.originalUrl.replace(/^\/api\/reddit/, '');
    const r = await fetch(upstream, { headers: { 'User-Agent': 'Cadence/1.0' } });
    const text = await r.text();
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Reddit proxy error: ' + e.message } });
  }
});

// ── YouTube Data API v3 proxy (key added here, never echoed back) ────────────
// NOTE: search.list costs 100 quota units per call and the daily default is
// only ~100 searches — use /api/youtube/search sparingly. (Caching is a
// separate task; none is added here.)
app.get('/api/youtube/search', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    if (!params.has('part'))       params.set('part', 'snippet');
    if (!params.has('type'))       params.set('type', 'video');
    if (!params.has('maxResults')) params.set('maxResults', '10');
    params.set('key', YOUTUBE_KEY);          // ← secret, server-side only
    const upstream = 'https://www.googleapis.com/youtube/v3/search?' + params.toString();
    const r = await fetch(upstream);
    const text = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'YouTube proxy error: ' + e.message } });
  }
});

app.get('/api/youtube/videos', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    if (!params.has('part')) params.set('part', 'snippet,statistics');
    params.set('key', YOUTUBE_KEY);          // ← secret, server-side only
    const upstream = 'https://www.googleapis.com/youtube/v3/videos?' + params.toString();
    const r = await fetch(upstream);
    const text = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'YouTube proxy error: ' + e.message } });
  }
});

// ── Static pages ─────────────────────────────────────────────────────────────
const pub = path.join(__dirname, 'public');
app.get('/',    (_req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(pub, 'app.html')));
app.use(express.static(pub)); // serves any other assets you add later

app.listen(PORT, () => console.log(`Cadence running on http://localhost:${PORT}`));
