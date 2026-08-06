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

require('dotenv').config();

const express  = require('express');
const path     = require('path');
const engine   = require('./trend-engine');
const Database = require('@replit/database');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Secrets (set these in Replit → Tools → Secrets) ─────────────────────────
const CLAUDE_KEY   = process.env.CLAUDE_API_KEY || '';
const RAPID_KEY    = process.env.RAPIDAPI_KEY   || '';
const YOUTUBE_KEY  = process.env.YOUTUBE_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL   || 'claude-sonnet-4-6';

const TOKAPI_HOST = 'tokapi-mobile-version.p.rapidapi.com';
const TOKAPI_BASE = 'https://' + TOKAPI_HOST;

// Scraped post text can contain lone/unpaired UTF-16 surrogates (broken emoji).
// JSON.stringify escapes them as \udXXX, which the Anthropic API rejects with a
// 400 — so every prompt passes through this before the request body is built.
// Removes ONLY unpaired high/low surrogates; valid paired emoji stay intact.
function stripLoneSurrogates(s) {
  return String(s == null ? '' : s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// Apify powers the live Google Trends + Instagram sources used by /api/scan.
// The token NEVER leaves the server (never echoed to the browser).
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';

if (!CLAUDE_KEY)  console.warn('⚠  CLAUDE_API_KEY is not set — /api/claude will fail.');
if (!RAPID_KEY)   console.warn('⚠  RAPIDAPI_KEY is not set — /api/tokapi will fail.');
if (!YOUTUBE_KEY) console.warn('⚠  YOUTUBE_API_KEY is not set — /api/youtube will fail.');
if (!APIFY_TOKEN) console.warn('⚠  APIFY_TOKEN is not set — /api/scan Google Trends + Instagram sources will be empty.');

// ── Keep the server alive ───────────────────────────────────────────────────
// Upstream calls (Anthropic, TokAPI, Reddit, YouTube, Apify) can reject outside
// a request's try/catch (e.g. a background promise). In modern Node an unhandled
// rejection terminates the process — which would take the whole app down. Log
// these instead of crashing so a single bad upstream response never kills the
// server. Per-request errors are still caught and returned in their routes.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (kept alive):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (kept alive):', err && err.stack ? err.stack : err);
});

app.use(express.json({ limit: '1mb' }));

// ── Trend-engine history store (Replit DB-backed) ───────────────────────────
// One shared store: the engine reads/writes observation history through it so
// momentum is computed from real accumulated data, not invented per scan.
const db = new Database();
// Follows the NOTES FOR GARRISON adapter, but unwraps the Result envelope the
// installed @replit/database v3 returns ({ ok, value }) so getJSON/listKeys hand
// the engine the raw value/array it expects. Works with both v2 and v3 returns.
const unwrap = (r) => (r && typeof r === 'object' && 'ok' in r) ? (r.ok ? r.value : null) : r;
class ReplitStore extends engine.HistoryStore {
  async getJSON(k)       { return unwrap(await db.get(k)) ?? null; }
  async setJSON(k, v)    { await db.set(k, v); }
  async listKeys(prefix) { return unwrap(await db.list(prefix)) || []; }
}
const store = new ReplitStore();

// ── Claude proxy ─────────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  try {
    const { prompt, useSearch, maxTokens } = req.body || {};
    if (!prompt) return res.status(400).json({ error: { message: 'Missing prompt.' } });
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: Math.min(Number(maxTokens) || 4000, 16000),
      messages: [{ role: 'user', content: stripLoneSurrogates(prompt) }],
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

/* ============================================================================
   TREND ENGINE — server-side fetchers + scan orchestration
   ----------------------------------------------------------------------------
   These power POST /api/scan. Cadence (the engine) decides what qualifies as a
   trend from REAL measured numbers; Claude only writes the creative layer.
   All API keys + the Apify token stay here, server-side only.
   ========================================================================== */

// Reuse the exact Anthropic request body /api/claude builds, but return the
// concatenated text instead of the raw API envelope.
async function claudeCallText(prompt, useSearch = false) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: Math.min(4000, 16000),
    messages: [{ role: 'user', content: stripLoneSurrogates(prompt) }],
  };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,              // ← secret, server-side only
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error('Claude API error ' + r.status + ': ' + (data.error?.message || JSON.stringify(data.error || {})));
  }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// Apify run-with-cache. Reads a stored { items, ts }; if fresh enough, serves
// it. Otherwise runs the actor synchronously, caches the dataset items, and
// returns them. On any error, falls back to cached items, else []. The Apify
// token is never exposed to the client.
async function apifyCached(cacheKey, actorId, input, ttlHours = 12) {
  const key = 'apify:' + cacheKey;
  let cached = null;
  try { cached = await store.getJSON(key); } catch {}
  // only treat a NON-EMPTY fresh cache as a hit, so a one-off empty/garbage run
  // can't keep serving nothing for 12h.
  if (cached && cached.items && cached.items.length && (Date.now() - cached.ts) < ttlHours * 3600000) {
    return cached.items;
  }
  try {
    const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) {
      const snippet = (await r.text().catch(() => '')).slice(0, 200);
      console.warn(`[apify] ${actorId} HTTP ${r.status} — ${snippet}`);
      throw new Error('Apify ' + actorId + ' HTTP ' + r.status);
    }
    const items = await r.json();
    const arr = Array.isArray(items) ? items : [];
    console.log(`[apify] ${actorId} returned ${arr.length} items`);
    // cache only usable (non-empty) results so an empty run is retried next scan
    if (arr.length) { try { await store.setJSON(key, { items: arr, ts: Date.now() }); } catch {} }
    return arr;
  } catch (e) {
    console.warn('[apify] ' + actorId + ' failed:', e.message);
    return cached?.items || [];
  }
}

// --- TikTok: port of the TokAPI search+recommended pull + parseVideos logic
//     currently living in public/app.html. Returns [{ desc, views, likes }].
async function tokGet(p) {
  console.log('[tiktok] tokGet ->', TOKAPI_BASE + p);
  const r = await fetch(TOKAPI_BASE + p, {
    headers: { 'x-rapidapi-key': RAPID_KEY, 'x-rapidapi-host': TOKAPI_HOST },
  });
  console.log('[tiktok] tokGet status', r.status, 'for', p);
  if (!r.ok) throw new Error('TokAPI ' + r.status);
  const body = await r.json();
  // tokapi returns HTTP 200 even on logical failures (e.g. {"status_code":5,
  // "status_msg":"Invalid parameters"}). Surface these instead of silently
  // yielding zero videos.
  if (body && body.status_code) {
    throw new Error('TokAPI logical error ' + body.status_code + ': ' + (body.message || body.status_msg || ''));
  }
  return body;
}
function parseVideos(raw) {
  let items = [];
  if (Array.isArray(raw)) items = raw;
  // tokapi /v1/search/post returns results under search_item_list[].aweme_info
  else if (raw?.search_item_list) items = raw.search_item_list.map(i => i.aweme_info || i);
  else if (raw?.aweme_list?.length) items = raw.aweme_list;
  else if (raw?.data?.aweme_list) items = raw.data.aweme_list;
  else if (raw?.data?.video_list) items = raw.data.video_list;
  return items.slice(0, 15).map(v => {
    const s = v.statistics || v.stats || {};
    // origin_cover first (unwatermarked still), then cover. Both are signed URLs
    // that expire within hours — see the scan's thumbnail capture.
    const coverList = v.video?.origin_cover?.url_list || v.video?.cover?.url_list || [];
    return {
      desc: (v.desc || '').substring(0, 90),
      views: s.play_count || s.views || 0,
      likes: s.digg_count || s.likes || 0,
      createTime: v.create_time || v.createTime || 0,
      url: v.aweme_id ? `https://www.tiktok.com/@${v.author?.unique_id || 'tiktok'}/video/${v.aweme_id}` : null,
      awemeId: v.aweme_id || null,
      cover: (Array.isArray(coverList) && coverList[0]) || null,
    };
  }).filter(v => v.views > 0 || v.likes > 0);
}
async function pullTikTok(niche) {
  console.log('[tiktok] pullTikTok ENTER niche=', niche);
  // TokAPI Basic tier allows only 10 req/min; firing two endpoints in parallel
  // trips the limiter (429/403). Use a SINGLE niche-relevant search call.
  let search;
  try {
    search = await tokGet('/v1/search/post?keyword=' + encodeURIComponent(niche) + '&count=15&offset=0');
  } catch (e) {
    console.error('[tiktok] pullTikTok FAILED:', e && e.message);
    console.warn('[tiktok] pull failed:', e.message);
    return [];
  }
  const out = parseVideos(search).slice(0, 15);
  console.log('[scan] tiktok items:', out.length);
  return out;
}

// --- Reddit: server-side port of fetchReddit() from app.html. Returns
//     [{ title, score, comments, subreddit, url }].
async function fetchRedditServer(niche, window = 'week') {
  const headers = { 'User-Agent': 'Cadence/1.0' };
  let posts = [];
  for (const q of [niche.replace(/\s+/g, '').toLowerCase(), niche.replace(/\s+/g, '_'), niche.split(' ')[0]]) {
    try {
      const r = await fetch(`https://www.reddit.com/r/${q}/hot.json?limit=10`, { headers });
      if (!r.ok) continue;
      const d = await r.json();
      const kids = d?.data?.children || [];
      if (kids.length >= 4) {
        posts = kids.map(c => ({
          title: c.data.title || '',
          score: c.data.score || 0,
          comments: c.data.num_comments || 0,
          subreddit: c.data.subreddit || q,
          createdUtc: c.data.created_utc || 0,
          url: `https://reddit.com${c.data.permalink}`,
        })).filter(p => p.score > 0);
        break;
      }
    } catch { continue; }
  }
  if (posts.length < 3) {
    try {
      const r = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(niche)}&sort=hot&limit=10&t=${window}`, { headers });
      if (r.ok) {
        const d = await r.json();
        posts = [...posts, ...(d?.data?.children || []).map(c => ({
          title: c.data.title || '',
          score: c.data.score || 0,
          comments: c.data.num_comments || 0,
          subreddit: c.data.subreddit || '',
          createdUtc: c.data.created_utc || 0,
          url: `https://reddit.com${c.data.permalink}`,
        }))].slice(0, 10);
      }
    } catch {}
  }
  console.log('[scan] reddit posts:', posts.length);
  return posts;
}

// --- Instagram: live hashtag posts via Apify (cached 12h).
// The `search`+`searchType:hashtag` mode returned hashtag-search metadata, not
// posts. Scrape the hashtag's explore page directly so we get real post objects
// (caption / likesCount / commentsCount / videoViewCount).
async function fetchInstagram(niche) {
  const tag = String(niche).toLowerCase().replace(/[^a-z0-9]/g, '');
  const items = await apifyCached('ig:' + niche, 'apify~instagram-scraper', {
    directUrls: ['https://www.instagram.com/explore/tags/' + tag + '/'],
    resultsType: 'posts', resultsLimit: 30,
  }, 12);
  console.log('[scan] instagram items:', items.length);
  return items;
}

// --- Google Trends: live data via Apify (cached 12h). Returns the niche-term
//     interest series (for the engine's seeded history) PLUS the rising related
//     queries/topics, which become their own signals so Google Trends yields
//     several comparable signals instead of one.
async function fetchTrendSeries(term) {
  // steadyfetch~google-trends-scraper returns an ARRAY of records, each tagged
  // by a `surface` field (interestOverTime / relatedQueries / interestByRegion).
  // (The old apify~google-trends-scraper timed out at ~10min with 408/502.)
  const items = await apifyCached('gt:' + term, 'steadyfetch~google-trends-scraper', {
    searchTerms: [term], geo: 'US', timeRange: 'today 1-m',
    compare: false, includeTrendingNow: false,
  }, 12);

  const records = Array.isArray(items) ? items : [];
  const iot = records.find(r => r && r.surface === 'interestOverTime');
  const relQ = records.find(r => r && r.surface === 'relatedQueries');

  // Timeline points live at record.data.points = [{ date, value, isPartial }].
  // Drop the partial point (today's incomplete bucket). Missing record -> [].
  const series = ((iot && iot.data && iot.data.points) || [])
    .filter(p => p && p.isPartial !== true)
    .map(p => ({ date: p.date, value0to100: Number(p.value) }))
    .filter(p => Number.isFinite(p.value0to100));

  // Rising queries live at record.data.rising = [{ query, value, ... }].
  const risingQueries = ((relQ && relQ.data && relQ.data.rising) || [])
    .map(q => ({ query: q.query, value: Number(q.value) || 0 }))
    .filter(q => q.query && q.value > 0);
  // This actor exposes no related-topics surface; keep the field for back-compat.
  const risingTopics = [];

  console.log(`[scan] google_trends series ${series.length}pts, rising ${risingQueries.length}q/${risingTopics.length}t`);
  return { series, risingQueries, risingTopics };
}

// --- YouTube: server-side port of the /api/youtube search+videos pull used by
//     app.html. Returns [{ id, title, viewCount, likeCount, commentCount, url }].
async function pullYouTube(niche) {
  try {
    const sParams = new URLSearchParams({
      part: 'snippet', type: 'video', order: 'date', maxResults: '15', q: niche, key: YOUTUBE_KEY,
    });
    const sr = await fetch('https://www.googleapis.com/youtube/v3/search?' + sParams.toString());
    if (!sr.ok) return [];
    const sd = await sr.json();
    const ids = (sd.items || []).map(it => it?.id?.videoId).filter(Boolean);
    if (!ids.length) return [];
    const vParams = new URLSearchParams({
      part: 'snippet,statistics', id: ids.join(','), key: YOUTUBE_KEY,
    });
    const vr = await fetch('https://www.googleapis.com/youtube/v3/videos?' + vParams.toString());
    if (!vr.ok) return [];
    const vd = await vr.json();
    const out = (vd.items || []).map(it => {
      const s = it.statistics || {};
      return {
        id: it.id,
        title: (it.snippet?.title || '').substring(0, 90),
        viewCount: parseInt(s.viewCount, 10) || 0,
        likeCount: parseInt(s.likeCount, 10) || 0,
        commentCount: parseInt(s.commentCount, 10) || 0,
        publishedAt: it.snippet?.publishedAt || '',
        url: it.id ? 'https://www.youtube.com/watch?v=' + it.id : null,
      };
    }).filter(v => v.viewCount > 0 || v.likeCount > 0)
      .sort((a, b) => b.viewCount - a.viewCount);
    console.log('[scan] youtube videos:', out.length);
    return out;
  } catch (e) {
    console.warn('[youtube] server pull failed:', e.message);
    return [];
  }
}

// ── Scan: Cadence decides the trends, Claude writes the creative layer ───────
app.post('/api/scan', async (req, res) => {
  try {
    const { niche, audience, platforms, formats, tone, extra, profile, fresh, tz } = req.body || {};
    if (!niche || !String(niche).trim()) {
      return res.status(400).json({ error: { message: 'Missing niche.' } });
    }
    const plats = Array.isArray(platforms) && platforms.length
      ? platforms
      : ['tiktok', 'reddit', 'youtube', 'instagram', 'google_trends'];

    // Whole-scan result cache. Keyed on every input that changes the output, so
    // re-running the SAME scan (the common dev loop) returns instantly instead of
    // re-pulling every source and re-running both Claude calls. Bypass with
    // { fresh:true } in the body or ?fresh=1 (still refreshes the cache).
    const SCAN_TTL_MS = 30 * 60 * 1000; // 30 min
    const wantsFresh = fresh === true || req.query.fresh === '1' || req.query.fresh === 'true';
    const keyInput = JSON.stringify({
      niche: String(niche).trim().toLowerCase(),
      audience: audience || '', tone: tone || '', extra: extra || '',
      platforms: [...plats].sort(),
      formats: [...(formats || [])].sort(),
      profile: profile || null,
      tz: tz || 'UTC',
    });
    let hash = 5381;
    for (let i = 0; i < keyInput.length; i++) hash = ((hash << 5) + hash + keyInput.charCodeAt(i)) | 0;
    const cacheKey = 'scan:' + (hash >>> 0).toString(36);

    if (!wantsFresh) {
      try {
        const hit = await store.getJSON(cacheKey);
        if (hit && hit.result && (Date.now() - hit.ts) < SCAN_TTL_MS) {
          console.log(`[scan] CACHE HIT ${cacheKey} (age ${Math.round((Date.now() - hit.ts) / 1000)}s) niche="${niche}"`);
          return res.json(hit.result);
        }
      } catch {}
    }
    console.log(`[scan] CACHE MISS ${cacheKey} fresh=${wantsFresh} niche="${niche}" platforms=${plats.join(',')}`);

    // Independent live pulls — run concurrently instead of sequentially.
    const [youtubeVideos, tiktokVideos] = await Promise.all([
      plats.includes('youtube') ? pullYouTube(niche) : Promise.resolve([]),
      plats.includes('tiktok')  ? pullTikTok(niche)  : Promise.resolve([]),
    ]);

    const result = await engine.runScan({
      store, niche, audience, platforms: plats,
      formats, tone, extra, profile,
      tiktokVideos,
      fetchReddit: fetchRedditServer,
      fetchTrendSeries,
      fetchInstagram,
      youtubeVideos,
      claudeCall: claudeCallText,
      tz: tz || 'UTC',
      onStatus: () => {},
    });
    console.log(`[scan] done: ${(result.trends || []).length} themes${result.note ? ' (' + result.note + ')' : ''}`);

    // Cache only a non-empty result, so an empty/garbage run is retried next scan.
    if (result && (result.trends || []).length) {
      try { await store.setJSON(cacheKey, { result, ts: Date.now() }); } catch {}
    }
    res.json(result);
  } catch (e) {
    console.error('[scan] error:', e.message);
    res.status(502).json({ error: { message: 'Scan error: ' + e.message } });
  }
});

app.get('/api/scan/clear', async (_req, res) => {
  try {
    const keys = await store.listKeys('scan:');
    for (const k of keys) { try { await db.delete(k); } catch {} }
    console.log(`[scan] cache cleared: ${keys.length} keys`);
    res.json({ cleared: keys.length });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// ── Trendsetter panel scan ───────────────────────────────────────────────────
// Background data-capture seed: scans a curated set of TikTok accounts
// (panel.json), writes a per-account views/engagement time-series, and flags
// self-relative breakouts (a post that massively outperforms the account's own
// recent median).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function median(arr) {
  const a = (arr || []).filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Breakout admission, two tiers.
//
// Tier 1 is the original gate: a post at ≥6× its own account's recent median
// with a real audience behind it. It is a high bar by design, and across the
// panel it clears one or two posts on a typical day — not a feed. Tier 2 admits
// the same shape of signal earlier and smaller, so Discover has something honest
// to show while tier 1 stays the headline.
//
// Both gates are self-relative: mult is the post against its own account's
// median, so a 40k-view post on a small account can out-rank a 2M-view post from
// someone who always does 2M.
const TIER1_MIN_MULT  = 6;       // "breakout"
const TIER1_MIN_VIEWS = 250000;
const TIER2_MIN_MULT  = 3;       // "emerging"
const TIER2_MIN_VIEWS = 75000;
const BREAKOUT_MAX_PER_ACCOUNT = 2;   // across both tiers combined
const BREAKOUT_MAX_TOTAL       = 24;

// Age ceiling on admission.
//
// Both gates score a post on mult, and views only ever accumulate — so a post
// that did 4M views three years ago beats everything posted this week, forever.
// The old funnel never showed this because it tested one post per account picked
// by velocity (views ÷ hours since posting), which is implicitly a recency
// filter; scoring every post removes that accident and lets the back catalogue
// in. Measured on the panel: without this, 23 of 24 selected posts are >30d old,
// median age 532 days.
//
// 30 days is where Discover stops looking: the window pills top out at 30d and
// the feed filters on createTime, so an older post cannot render in the UI at
// all — admitting it only spends a slot and a thumbnail fetch on a card nobody
// can see.
const BREAKOUT_MAX_AGE_DAYS = 30;

// 1 or 2 for an admitted post; 0 to discard. ageSecs is the post's age; posts
// with no usable timestamp can't prove recency and are discarded.
function tierFor(mult, views, ageSecs) {
  if (!(ageSecs >= 0) || ageSecs > BREAKOUT_MAX_AGE_DAYS * 86400) return 0;
  if (mult >= TIER1_MIN_MULT && views >= TIER1_MIN_VIEWS) return 1;
  if (mult >= TIER2_MIN_MULT && views >= TIER2_MIN_VIEWS) return 2;
  return 0;
}

// Round-robin the niches so the feed reads as a cross-section of the panel
// instead of five straight posts from whichever niche happened to pop today.
// Niches lead in order of their own strongest post; within a niche, strongest
// first. Callers pass one tier at a time — tier never interleaves.
function interleaveByNiche(items) {
  const groups = new Map();
  for (const it of items) {
    const k = it.niche || '—';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const ordered = [...groups.values()].map((g) => g.sort((a, b) => b.mult - a.mult));
  ordered.sort((a, b) => b[0].mult - a[0].mult);

  const out = [];
  const deepest = Math.max(0, ...ordered.map((g) => g.length));
  for (let i = 0; i < deepest; i++) {
    for (const g of ordered) if (i < g.length) out.push(g[i]);
  }
  return out;
}

// Thumbnail capture.
//
// TikTok image URLs are signed and expire within hours, so the scan downloads
// the bytes while the URL is still live rather than persisting a link that
// would 403 by the time anyone opens Discover. Stored as base64 + content-type
// under thumb:tiktok:<awemeId>; served back by /api/thumb/tiktok/:awemeId.
//
// Source order matters. The aweme's own video.origin_cover/cover is a 360x360
// HEIC (measured across the panel: 18/19 accounts), which Chrome, Firefox and
// Edge cannot render — and the URL signature covers the format segment, so
// rewriting .heic to .jpeg just 403s. The official oEmbed endpoint hands back a
// 720x1280 JPEG for the same post, which is both renderable and already the 9:16
// the cards want, so it goes first and the raw cover is only a fallback.
//
// Every candidate is sniffed by magic bytes and dropped unless it is a format
// browsers actually decode; a card with no thumbnail falls back to a text-only
// layout, which is a far better outcome than a broken <img>.
const THUMB_MAX_BYTES = 2 * 1024 * 1024; // guard the store against an outlier

function sniffImage(buf) {
  if (buf.slice(0, 3).toString('hex') === 'ffd8ff') return { fmt: 'JPEG', contentType: 'image/jpeg' };
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return { fmt: 'PNG', contentType: 'image/png' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return { fmt: 'WEBP', contentType: 'image/webp' };
  }
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return { fmt: 'HEIC', contentType: null }; // unrenderable
  return { fmt: 'UNKNOWN', contentType: null };
}

// Official oEmbed. No key, no signature games — just the post URL.
async function oembedThumbUrl(postUrl) {
  if (!postUrl) return null;
  const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(postUrl), {
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`oembed HTTP ${r.status}`);
  const j = await r.json();
  return j.thumbnail_url || null;
}

async function fetchRenderableImage(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('0 bytes');
  if (buf.length > THUMB_MAX_BYTES) throw new Error(`too large (${buf.length}B)`);
  const { fmt, contentType } = sniffImage(buf);
  if (!contentType) throw new Error(`${fmt} is not browser-renderable`);
  return { buf, contentType };
}

// Returns true when a thumbnail was stored. Throws — callers must not let a
// thumbnail failure fail the scan.
async function captureThumb(awemeId, postUrl, coverUrl) {
  if (!awemeId) return false;

  const candidates = [];
  try {
    const t = await oembedThumbUrl(postUrl);
    if (t) candidates.push(['oembed', t]);
  } catch (e) {
    console.warn(`[panel] oembed lookup failed for ${awemeId}: ${e.message}`);
  }
  if (coverUrl) candidates.push(['cover', coverUrl]);
  if (!candidates.length) return false;

  const errs = [];
  for (const [label, url] of candidates) {
    try {
      const { buf, contentType } = await fetchRenderableImage(url);
      await store.setJSON(`thumb:tiktok:${awemeId}`, { contentType, b64: buf.toString('base64'), t: Date.now() });
      return true;
    } catch (e) {
      errs.push(`${label}: ${e.message}`);
    }
  }
  throw new Error(errs.join('; '));
}

// The scan itself, callable without an HTTP round-trip so a scheduler that runs
// a command (rather than hitting a URL) can invoke it directly. Resolves to the
// run summary; throws only when panel.json can't be loaded.
async function runPanelScan() {
  const t0 = Date.now();
  let panel;
  try {
    panel = require('./panel.json');
  } catch (e) {
    console.error('[panel] could not load panel.json:', e.message);
    throw new Error('panel.json missing or invalid.');
  }

  // Only resolved TikTok accounts. Platform defaults to tiktok when absent.
  const accounts = (panel.accounts || []).filter(
    (a) => a && a.uid && (a.platform || 'tiktok') === 'tiktok'
  );

  const candidates = [];
  // Signed cover URL per candidate, kept out of the candidate itself so it never
  // reaches the store — it would be a dead link by the time anyone read it.
  const coverOf = new Map();
  let scanned = 0, skipped = 0;

  for (const acct of accounts) {
    const handle = (acct.handle || '').replace(/^@/, '').trim();
    try {
      const raw  = await tokGet(`/v1/post/user/${acct.uid}/posts?count=15&offset=0`);
      const vids = parseVideos(raw); // {views, likes, createTime, url, desc}

      if (vids.length < 3) {
        console.log(`[panel] @${handle} skipped (only ${vids.length} videos)`);
        skipped++;
        await sleep(350);
        continue;
      }

      const baseline = median(vids.map((v) => v.views).filter((n) => n > 0));

      // Standout = highest views-per-hour since posting (early velocity beats raw
      // total, which just favors older posts). Fall back to max views when no
      // usable timestamps exist.
      const nowSec = Date.now() / 1000;
      let standout = null;
      for (const v of vids) {
        v.velocity = v.createTime > 0
          ? v.views / Math.max(1, (nowSec - v.createTime) / 3600)
          : 0;
        if (!standout || v.velocity > standout.velocity) standout = v;
      }
      if (standout && standout.velocity === 0) {
        // All velocities zero (no timestamps) — fall back to max views.
        standout = vids.reduce((m, v) => (v.views > m.views ? v : m), vids[0]);
      }

      const mult = baseline > 0 ? standout.views / baseline : 0;

      // Append to the per-account time-series (cap to last 180 points).
      const seriesKey = `series:tiktok:${handle}`;
      let series = null;
      try { series = await store.getJSON(seriesKey); } catch {}
      if (!series || !Array.isArray(series.points)) series = { points: [] };
      series.points.push({
        t: Date.now(),
        medViews: baseline,
        medEng: median(vids.map((v) => (v.views > 0 ? v.likes / v.views : 0))),
        topViews: standout.views,
      });
      if (series.points.length > 180) series.points = series.points.slice(-180);
      try { await store.setJSON(seriesKey, series); } catch {}

      // Latest snapshot (top 10 posts) for quick UI reads.
      try {
        await store.setJSON(`latest:tiktok:${handle}`, { t: Date.now(), posts: vids.slice(0, 10) });
      } catch {}

      // Admission runs over EVERY post with usable data, not just the standout.
      // A standout-only funnel throws away the account's second breakout and
      // scores a quiet account's best-of-a-bad-week the same as a real hit.
      const qualified = [];
      if (baseline > 0) {
        for (const v of vids) {
          if (!(v.views > 0)) continue;
          const m = v.views / baseline;
          const tier = tierFor(m, v.views, v.createTime > 0 ? nowSec - v.createTime : -1);
          if (!tier) continue;
          const cand = {
            handle,
            niche: acct.niche || null,
            tier,
            mult: Number(m.toFixed(1)),
            velocity: Math.round(v.velocity),
            thumb: null,
            post: {
              url: v.url,
              desc: v.desc,
              views: v.views,
              likes: v.likes,
              createTime: v.createTime,
              awemeId: v.awemeId || null,
            },
          };
          coverOf.set(cand, v.cover);
          qualified.push(cand);
        }
      }
      // Any tier 1 outranks any tier 2; velocity breaks ties inside a tier.
      qualified.sort((a, b) => a.tier - b.tier || b.velocity - a.velocity);
      candidates.push(...qualified.slice(0, BREAKOUT_MAX_PER_ACCOUNT));

      scanned++;
      const t1 = qualified.filter((q) => q.tier === 1).length;
      console.log(
        `[panel] @${handle} base=${baseline} top=${standout.views} mult=${mult.toFixed(1)} ` +
        `qualified=${qualified.length} (t1=${t1} t2=${qualified.length - t1})`
      );
    } catch (e) {
      console.error(`[panel] @${handle} error:`, e.message);
      skipped++;
    }
    await sleep(350); // respect TokAPI rate limits
  }

  // Sounds layer — best-effort, isolated so a charts failure never fails the scan.
  // Field names are a guess from the spec; stay defensive (null/'' on miss).
  let soundsCount = 0;
  try {
    const charts = await tokGet('/v1/music/charts?region=US');
    const list =
      (Array.isArray(charts) && charts) ||
      charts?.music_list || charts?.musicList ||
      charts?.data?.music_list || charts?.data ||
      charts?.sound_list || charts?.items || [];
    const arr = (Array.isArray(list) ? list : []).slice(0, 20).map((m) => ({
      musicId: m.music_info?.id || m.id || m.music?.id || null,
      title:   m.title || m.music_info?.title || m.music?.title || '',
      author:  m.author || m.music_info?.author || '',
    }));
    soundsCount = arr.length;
    await store.setJSON('trending_sounds:tiktok', { t: Date.now(), items: arr });
  } catch (e) {
    console.error('[panel] sounds layer failed (non-fatal):', e.message);
  }

  // Final order: every tier-1 item ahead of every tier-2 item, niche-interleaved
  // within each tier, then capped.
  const breakouts = [
    ...interleaveByNiche(candidates.filter((b) => b.tier === 1)),
    ...interleaveByNiche(candidates.filter((b) => b.tier === 2)),
  ].slice(0, BREAKOUT_MAX_TOTAL);

  // Thumbnails for the final list only, walked in feed order. Ordering does the
  // prioritising: anything a limit cuts short comes off the tier-2 tail. Each
  // capture is isolated — a failure costs that card its image, never the scan
  // and never another card.
  let thumbs = 0, thumbsFailed = 0;
  for (const b of breakouts) {
    try {
      if (await captureThumb(b.post.awemeId, b.post.url, coverOf.get(b))) {
        b.thumb = `/api/thumb/tiktok/${b.post.awemeId}`;
        thumbs++;
      }
    } catch (e) {
      thumbsFailed++;
      console.error(`[panel] @${b.handle} thumbnail failed (non-fatal):`, e.message);
    }
  }
  console.log(`[panel] thumbs: captured=${thumbs} failed=${thumbsFailed} of ${breakouts.length} breakouts`);

  // Persist in the order above — the feed renders it as-is.
  //
  // Unless nothing scanned at all. A run where every account errors (TokAPI
  // down, rate-limit wall, expired subscription) knows nothing about the world;
  // writing its empty list would delete the last good feed and blank Discover
  // until the next healthy scan. An empty list from a *healthy* scan is real
  // information — nothing broke out today — and is still written.
  if (scanned === 0) {
    console.warn(`[panel] no account scanned (${skipped} failed) — keeping the stored breakouts`);
  } else {
    try {
      await store.setJSON('breakouts:tiktok', { t: Date.now(), items: breakouts });
    } catch (e) {
      console.error('[panel] could not persist breakouts:', e.message);
    }
  }

  const tier1 = breakouts.filter((b) => b.tier === 1).length;
  const ms = Date.now() - t0;
  console.log(
    `[panel] scan done: scanned=${scanned} skipped=${skipped} breakouts=${breakouts.length} ` +
    `(t1=${tier1} t2=${breakouts.length - tier1}) qualified=${candidates.length} ` +
    `thumbs=${thumbs}/${thumbsFailed}f sounds=${soundsCount} in ${ms}ms`
  );
  return {
    scanned, skipped,
    breakouts: breakouts.length,
    tier1, tier2: breakouts.length - tier1,
    qualified: candidates.length,
    thumbs, thumbsFailed,
    sounds: soundsCount, ms,
  };
}

// Triggered on a schedule via POST /api/cron/panel-scan — see the GitHub Actions
// cron in .github/workflows/panel-scan.yml. `npm run panel-scan` calls
// runPanelScan() directly and needs no server.
app.post('/api/cron/panel-scan', async (req, res) => {
  // Guard: only refuse when a CRON_KEY is configured AND the header doesn't match.
  const CRON_KEY = process.env.CRON_KEY || '';
  if (CRON_KEY && req.get('x-cron-key') !== CRON_KEY) {
    return res.status(401).json({ error: { message: 'Unauthorized.' } });
  }
  try {
    res.json(await runPanelScan());
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// ── Discover reads ───────────────────────────────────────────────────────────
// Read-only views over the panel scan's stored output for the Discover surface.
// getJSON only — these routes can never alter panel data. Each returns a safe
// empty shape when the key is absent (panel hasn't run yet).
app.get('/api/discover/breakouts', async (_req, res) => {
  try {
    const data = (await store.getJSON('breakouts:tiktok')) || { items: [] };
    // Normalize every stored generation into one shape. Breakouts written before
    // thumbnail capture existed carry no awemeId/thumb; those written before
    // tiering carry no tier/niche. Anything stored untiered cleared the old gate,
    // which is today's tier 1 — so that is what it reads back as.
    res.json({
      ...data,
      items: (data.items || []).map((it) => ({
        ...it,
        awemeId: (it.post && it.post.awemeId) || null,
        thumb: it.thumb || null,
        tier: it.tier === 2 ? 2 : 1,
        niche: it.niche || null,
      })),
    });
  } catch (e) {
    res.json({ items: [] });
  }
});

// Serves a thumbnail captured at scan time. The bytes are immutable once
// stored, so let the browser hold them for a day.
app.get('/api/thumb/tiktok/:awemeId', async (req, res) => {
  const id = req.params.awemeId;
  if (!/^\d{1,32}$/.test(id)) {
    return res.status(400).json({ error: { message: 'Bad aweme id.' } });
  }
  try {
    const rec = await store.getJSON(`thumb:tiktok:${id}`);
    if (!rec || !rec.b64) return res.status(404).json({ error: { message: 'No thumbnail.' } });
    const buf = Buffer.from(rec.b64, 'base64');
    res.set('Content-Type', rec.contentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(404).json({ error: { message: 'No thumbnail.' } });
  }
});

app.get('/api/discover/sounds', async (_req, res) => {
  try {
    res.json((await store.getJSON('trending_sounds:tiktok')) || { items: [] });
  } catch (e) {
    res.json({ items: [] });
  }
});

app.get('/api/discover/series/:handle', async (req, res) => {
  // handles come from panel.json (letters/digits/._-); reject anything else so
  // the param can't address arbitrary store keys.
  const handle = String(req.params.handle || '').replace(/^@/, '');
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(handle)) return res.json({ points: [] });
  try {
    res.json((await store.getJSON('series:tiktok:' + handle)) || { points: [] });
  } catch (e) {
    res.json({ points: [] });
  }
});

// ── Static pages ─────────────────────────────────────────────────────────────
const pub = path.join(__dirname, 'public');
app.get('/',    (_req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(pub, 'app.html')));
app.use(express.static(pub)); // serves any other assets you add later

// Only boot the HTTP server when run as the entry point. Requiring this file
// (scripts/run-panel-scan.js does, to call runPanelScan directly) must not bind
// a port.
if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`Cadence running on http://localhost:${PORT}`));

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Another instance is likely still running. Stop it and restart.`);
      process.exit(1);
    } else {
      throw err;
    }
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, runPanelScan };
