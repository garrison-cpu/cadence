/* =====================================================================
   CADENCE — TREND ENGINE
   ---------------------------------------------------------------------
   Server-side module. Lives next to the existing API-key proxy.

   What it replaces:
     Today  -> dump raw signals into one Claude prompt, let Claude DECIDE
               what's a trend and INVENT the numbers.
     Now    -> Cadence stores a history of every scan, computes real
               momentum against a baseline, applies OUR rules to decide
               what qualifies, THEN hands the confirmed trends to Claude
               only to write the angle/hook/hashtags.

   Two payoffs, one engine:
     SPEED   -> baselines come from free historical sources (Google
               Trends, Reddit time-windows) on day one, and repeat scans
               serve from stored history instead of re-fetching.
     CONTROL -> every rule that defines "a trend" lives in CONFIG below.
               Change a number, change what qualifies. No code rewrite.
   ===================================================================== */


/* =====================================================================
   1. CONFIG  —  THE KNOBS
   ---------------------------------------------------------------------
   This is the whole point. Everything that decides "what is a trend"
   is here in plain numbers. Charles owns these as a product decision;
   Garrison wires them in. Nothing below this block needs editing to
   retune what qualifies.
   ===================================================================== */
const CONFIG = {

  // ---- How far back "normal" is measured from ----
  baselineWindowDays: 14,      // compare current activity vs the last 2 weeks
  retentionDays: 60,           // keep 60 days of history per signal, then trim
  freshnessDays: 4,            // a signal first seen <=4 days ago counts as "fresh"

  // ---- What makes the trend SCORE (must sum to ~1.0) ----
  // Raise a weight to make that factor matter more in ranking.
  // NOTE: momentum + spike together form the adaptive "trend core."
  // Their combined budget is split between two ways of measuring "normal":
  //   - niche-relative (vs the OTHER signals in THIS scan — works scan one)
  //   - self-relative  (vs this signal's OWN past — needs a few scans)
  // The split shifts automatically with how much history exists (see
  // `blend` below). You set the weights; the engine manages the split.
  weights: {
    momentum:      0.40,       // trend strength (niche- and/or self-relative)
    spike:         0.25,       // statistical unusualness (same blend applied)
    engagement:    0.15,       // engagement relative to reach (not raw size)
    crossPlatform: 0.12,       // showing up on more than one platform
    freshness:     0.08,       // newer = better (trends decay)
  },

  // ---- Heat labels: score thresholds (0-100) ----
  // These are the Rising / Hot / Viral cutoffs shown to the user.
  heat: {
    viral: 75,                 // score >= 75  -> Viral
    hot:   50,                 // score >= 50  -> Hot
    // anything below `hot` -> Rising
  },

  // ---- The bar to even appear as a trend ----
  minScoreToQualify: 30,       // below this, it's noise — don't show it
  minObservations:   1,        // 1 = can appear on the FIRST scan via niche-relative
  maxTrendsReturned: 8,        // how many to surface per scan

  // ---- Topic-first clustering ----
  // Signals from every source are grouped into generalized themes (Claude
  // groups, Cadence scores). A theme that shows up on more platforms earns a
  // breadth bonus on top of its strongest member's score.
  clustering: {
    maxThemes: 8,                  // how many themes to surface per scan
    breadthBonusPerPlatform: 4,    // +score for each extra platform a theme spans
    breadthBonusCap: 12,           // breadth bonus never exceeds this
  },

  // ---- Adaptive baseline blend (this is the cold-start fix) ----
  // How "normal" is measured as a niche accumulates history:
  //   thin history -> lean on niche-relative (this scan's own spread)
  //   rich history -> lean on self-relative  (the signal's own past)
  blend: {
    fullHistoryAt:      5,     // at >=5 readings, self-relative is fully trusted
    nicheRelativeFloor: 0.25,  // niche-relative never drops below this weight, so
                               // a flat niche can't fake momentum out of old data
  },

  // ---- Per-platform trust (real data > inferred data) ----
  // Multiplies a signal's score. Live data we measured outranks data
  // we only inferred via web search.
  sourceTrust: {
    tiktok:        1.00,       // live TokAPI numbers — measured
    reddit:        1.00,       // live Reddit numbers — measured
    google_trends: 0.95,       // real historical index, but relative not absolute
    youtube:       1.00,       // live YouTube Data API numbers — measured
    instagram:     0.70,       // currently inferred via search — discount it
  },
};


/* =====================================================================
   1b. WRITING STYLE + OUTPUT SANITIZER
   ---------------------------------------------------------------------
   STYLE is appended to every copy-writing prompt so the creative layer
   reads like a human social manager wrote it. cleanCopy/deepClean are the
   backstop: even if the model slips, no em/en dash or emoji survives into
   anything we return, show, or save (Ideas / Calendar included).
   ===================================================================== */
const STYLE = `WRITING RULES (hard constraints, follow exactly):
- Never use an em-dash (—) or en-dash (–). For a pause, use a period or a comma, or rewrite the sentence. Plain hyphens in compounds like "30-day" are fine.
- Never use emoji or emoticons of any kind.
- Write like a real social media manager who runs this account, not like a brand and not like an AI. Specific, plain, confident.
- Do not use these AI-tell phrasings: "it's not just X, it's Y", "in today's world", "dive in", "delve", "unlock", "elevate", "supercharge", "level up", "game-changer", "the result?", "look no further", "say goodbye to".
- Vary sentence length. Use contractions. Cut throat-clearing and filler. Lead with the point.
- Match how top accounts in this niche actually post, not generic marketing copy.`;

function cleanCopy(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\s*[—–]\s*/g, ', ')                 // em/en dash -> comma (rarely fires if prompt holds)
    .replace(/\p{Emoji_Presentation}/gu, '')        // colored emoji
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')         // flag pairs
    .replace(/[\u200D\uFE0F\u20E3]/gu, '')          // ZWJ, variation selector, keycap
    .replace(/[ \t]{2,}/g, ' ')                     // collapse leftover spaces
    .replace(/\s+([,.!?])/g, '$1')                  // tidy space-before-punctuation
    .trim();
}
function deepClean(obj) {
  if (typeof obj === 'string') return cleanCopy(obj);
  if (Array.isArray(obj)) return obj.map(deepClean);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = deepClean(obj[k]);
    return out;
  }
  return obj;
}


/* =====================================================================
   2. HISTORY STORE
   ---------------------------------------------------------------------
   A tiny async key-value interface. Back it with anything:
     - Replit DB / Key-Value  (simplest, fine for launch)
     - SQLite / Postgres      (when you outgrow KV — schema at bottom)

   Key scheme:  obs:{niche}:{platform}:{signalKey}  ->  [{v, ts}, ...]
   Reading one signal's history is a single get. Listing a niche's
   signals is one prefix-list. That's all the engine needs.
   ===================================================================== */

class HistoryStore {
  // Replace these three methods with your real backend.
  async getJSON(key)            { throw new Error('implement getJSON'); }
  async setJSON(key, value)     { throw new Error('implement setJSON'); }
  async listKeys(prefix)        { throw new Error('implement listKeys'); }
}

// Reference implementation — in-memory, for local testing only.
// Swap for Replit DB in production (notes at bottom of file).
class InMemoryStore extends HistoryStore {
  constructor() { super(); this.m = new Map(); }
  async getJSON(key)        { return this.m.has(key) ? JSON.parse(this.m.get(key)) : null; }
  async setJSON(key, value) { this.m.set(key, JSON.stringify(value)); }
  async listKeys(prefix)    { return [...this.m.keys()].filter(k => k.startsWith(prefix)); }
}


/* =====================================================================
   3. NORMALIZATION
   ---------------------------------------------------------------------
   The same trend shows up worded slightly differently each scan.
   We collapse it to a stable signalKey so history lines up over time.
   ===================================================================== */
function signalKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[#@]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

const obsKey = (niche, platform, key) =>
  `obs:${signalKey(niche)}:${platform}:${key}`;


/* =====================================================================
   4. RECORD OBSERVATIONS
   ---------------------------------------------------------------------
   Every scan writes what it saw. This append-and-trim is the single
   piece of work that powers BOTH speed (repeat scans read it) and
   control (momentum is computed from it).
   ===================================================================== */
async function recordObservations(store, niche, platform, observations) {
  const now = Date.now();
  const cutoff = now - CONFIG.retentionDays * 864e5;

  for (const o of observations) {
    const key = obsKey(niche, platform, signalKey(o.signal));
    const series = (await store.getJSON(key)) || [];
    series.push({ v: o.value, ts: now });
    // trim anything older than retention window
    const trimmed = series.filter(p => p.ts >= cutoff);
    await store.setJSON(key, trimmed);
  }
}


/* =====================================================================
   5. SIGNAL STATS  —  the real momentum math
   ---------------------------------------------------------------------
   For one signal's history, compute the numbers the UI used to fake:
     - baseline   : its own normal level (trailing average)
     - current    : latest value
     - deltaPct   : % change vs baseline  <-- the real "+312%"
     - velocity   : slope (rising/flat/falling) over recent points
     - spikeZ     : how many std-devs above normal (unusual = trendy)
     - fresh      : did it first appear inside the freshness window
   ===================================================================== */
function computeSignalStats(series) {
  if (!series || series.length === 0) return null;

  const now = Date.now();
  const windowStart = now - CONFIG.baselineWindowDays * 864e5;
  const points = [...series].sort((a, b) => a.ts - b.ts);

  const current = points[points.length - 1].v;

  // baseline = average of everything EXCEPT the latest point, within window
  let baselinePts = points.slice(0, -1).filter(p => p.ts >= windowStart);
  // if the window is too sparse (e.g. weekly Google Trends data), widen to
  // all available history so the baseline is still meaningful
  if (baselinePts.length < 2) baselinePts = points.slice(0, -1);
  const baseline = baselinePts.length
    ? baselinePts.reduce((s, p) => s + p.v, 0) / baselinePts.length
    : current; // no history yet -> no claimable momentum

  const deltaPct = baseline > 0 ? ((current - baseline) / baseline) * 100 : 0;

  // velocity: slope of last up-to-5 points, normalized to baseline
  const recent = points.slice(-5);
  let velocity = 0;
  if (recent.length >= 2 && baseline > 0) {
    const first = recent[0].v, last = recent[recent.length - 1].v;
    velocity = ((last - first) / baseline) / (recent.length - 1);
  }

  // spike: z-score of current vs the signal's own history (spike detection)
  let spikeZ = 0;
  if (baselinePts.length >= 2) {
    const mean = baseline;
    const variance =
      baselinePts.reduce((s, p) => s + (p.v - mean) ** 2, 0) / baselinePts.length;
    const sd = Math.sqrt(variance);
    spikeZ = sd > 0 ? (current - mean) / sd : 0;
  }

  const firstTs = points[0].ts;
  const fresh = firstTs >= now - CONFIG.freshnessDays * 864e5;

  return {
    current, baseline, deltaPct, velocity, spikeZ, fresh,
    observations: points.length,
    // per-measure availability: a self-relative measure should only blend
    // in once it can actually be computed, else it drags the score down.
    hasMomentum: points.length >= 2,   // need >=1 prior reading
    hasSpike:    points.length >= 3,   // need >=2 prior readings for variance
  };
}


/* =====================================================================
   5b. NICHE-RELATIVE STATS  —  works on the very first scan
   ---------------------------------------------------------------------
   Self-relative momentum (above) needs a past. A brand-new narrow niche
   has none. So we add a second, history-free measure of "normal":
   compare each signal against the OTHER signals in the same scan.

   "Hot for THIS niche right now" = sitting well above the niche's own
   median, measured robustly (median + MAD) so one runaway video can't
   distort the baseline and a flat niche can't manufacture a trend.
   Values are only comparable within a platform (TikTok views vs Reddit
   upvotes are different scales), so this is always computed per-platform.
   ===================================================================== */
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Build a niche-relative scorer from one platform's current pull.
// Returns { available, score(value -> 0..1) }.
//   available=false when the pull is too small or too flat to define a
//   "normal" — in that case the engine falls back to self-relative only.
function nicheScorer(values) {
  const vals = (values || []).filter(v => v > 0);
  if (vals.length < 4) return { available: false, score: () => 0 };
  const med = median(vals);
  const mad = median(vals.map(v => Math.abs(v - med))) * 1.4826; // ~= std-dev
  return {
    available: mad > 0,
    // robust cross-sectional z-score; 3 MADs above median = full marks
    score: (value) => (mad > 0 ? clamp01(((value - med) / mad) / 3) : 0),
  };
}

// How much to trust self-relative history, 0..1, from the reading count.
//   1 reading  -> 0.00 (pure niche-relative)
//   2 readings -> partial
//   >=fullHistoryAt -> 1.00 (self-relative fully trusted)
function historyConfidence(observations) {
  const target = Math.max(2, CONFIG.blend.fullHistoryAt);
  return clamp01((observations - 1) / (target - 1));
}


/* =====================================================================
   6. SCORE  —  apply OUR rules, produce a number + heat label
   ---------------------------------------------------------------------
   Turns the stats into a single 0-100 score using CONFIG.weights, then
   maps it to Rising/Hot/Viral using CONFIG.heat. This is where Cadence
   (not Claude) decides what qualifies and how hot it is.
   ===================================================================== */
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function scoreTrend({ stats, platform, engagementRate, crossPlatformCount,
                      nicheRelNorm = 0, nicheAvailable = true }) {
  if (!stats) return null;

  // --- self-relative (temporal): needs the signal's own history ---
  const selfMomentum = clamp01(stats.deltaPct / 200);    // +200% vs own past = full
  const selfSpike    = clamp01(stats.spikeZ / 3);         // 3 std-devs vs own past = full

  // --- niche-relative (cross-sectional): available on the first scan ---
  const nicheNorm = clamp01(nicheRelNorm);

  // --- adaptive blend: trust history vs this scan's spread ---
  //   cold (h=0): trend core = niche-relative
  //   warm (h=1): trend core = self-relative (minus a small niche floor)
  //   no niche distribution available: pure self-relative
  const h = historyConfidence(stats.observations);
  let nicheWeight, selfWeight;
  if (!nicheAvailable) {
    nicheWeight = 0; selfWeight = 1;
  } else {
    nicheWeight = Math.max(1 - h, CONFIG.blend.nicheRelativeFloor);
    selfWeight  = 1 - nicheWeight;
  }

  const f = {
    // Each measure blends toward self-relative ONLY when that measure is
    // actually computable; until then niche-relative carries it fully. This
    // stops a half-formed history from dragging a genuinely hot trend down.
    momentum:      stats.hasMomentum ? (selfWeight * selfMomentum + nicheWeight * nicheNorm) : nicheNorm,
    spike:         stats.hasSpike    ? (selfWeight * selfSpike    + nicheWeight * nicheNorm) : nicheNorm,
    engagement:    clamp01((engagementRate || 0) / 0.10),  // 10% eng = full marks
    crossPlatform: clamp01(((crossPlatformCount || 1) - 1) / 2), // 3 platforms = full
    freshness:     stats.fresh ? 1 : 0.3,
  };

  const w = CONFIG.weights;
  let raw =
    f.momentum * w.momentum +
    f.spike * w.spike +
    f.engagement * w.engagement +
    f.crossPlatform * w.crossPlatform +
    f.freshness * w.freshness;

  // discount inferred sources vs measured ones
  raw *= (CONFIG.sourceTrust[platform] ?? 0.8);

  const score = Math.round(raw * 100);
  const heat =
    score >= CONFIG.heat.viral ? 'viral' :
    score >= CONFIG.heat.hot   ? 'hot'   : 'rising';

  return {
    score, heat, factors: f,
    // basis = how this score was reached, for transparency / debugging / UI
    basis: {
      historyConfidence: Number(h.toFixed(2)),
      nicheWeight: Number(nicheWeight.toFixed(2)),
      selfWeight: Number(selfWeight.toFixed(2)),
      mode: !nicheAvailable ? 'self-only'
           : h === 0 ? 'niche-only'
           : h >= 1 ? 'self-led' : 'blended',
    },
  };
}


/* =====================================================================
   7. BASELINE ADAPTERS
   ---------------------------------------------------------------------
   Each returns observations in a common shape:
       [{ signal, value, engagementRate?, meta? }]
   so the engine treats every platform identically.

   - Google Trends  : free, already historical -> we seed history from it
   - Reddit         : time-windowed API gives an instant rough baseline
   - TikTok         : SLOT — plug in paid history OR your own accumulation
   ===================================================================== */

// --- Google Trends: ships with 5y of history. We pull recent interest for the
//     niche term (seeded as history so first-scan momentum works) AND the rising
//     related queries/topics as their own signals — so Google Trends yields
//     several comparable signals instead of a single niche-level one that can
//     never clear the niche-relative bar.
async function googleTrendsBaseline(niche, fetchTrendSeries) {
  // fetchTrendSeries(term) -> { series:[{date,value0to100}], risingQueries:[{query,value}],
  //   risingTopics:[{topic,value}] }.  (Back-compat: a bare array = just the series.)
  const res = await fetchTrendSeries(niche).catch(() => null);
  const series        = Array.isArray(res) ? res : (res?.series || []);
  const risingQueries = Array.isArray(res) ? []  : (res?.risingQueries || []);
  const risingTopics  = Array.isArray(res) ? []  : (res?.risingTopics || []);

  const observations = [];
  const seed = [];

  // niche term: keep emitting its interest series as seeded history + a current obs
  if (series.length) {
    const latest = series[series.length - 1];
    observations.push({ signal: niche, value: latest.value0to100 });
    for (const p of series.slice(-CONFIG.baselineWindowDays)) {
      seed.push({ signal: niche, value: p.value0to100, ts: new Date(p.date).getTime() });
    }
  }

  // rising related queries + topics: each becomes its own signal
  for (const q of risingQueries) {
    if (q.query && q.value > 0) observations.push({ signal: q.query, value: q.value });
  }
  for (const t of risingTopics) {
    if (t.topic && t.value > 0) observations.push({ signal: t.topic, value: t.value });
  }

  return { observations, seed };
}

// --- Reddit: pull "hot now" and "top of month" so we get current vs a
//     rough baseline in the same scan. Mirrors fetchReddit() in the app.
async function redditBaseline(niche, fetchReddit) {
  const hot = await fetchReddit(niche, 'week').catch(() => []);
  return {
    observations: hot.map(p => ({
      signal: p.title,
      value: p.score,
      engagementRate: p.score > 0 ? p.comments / p.score : 0,
      meta: { subreddit: p.subreddit, url: p.url },
    })),
    seed: [],
  };
}

// --- TikTok: the SLOT.  Wire ONE of these:
//     (a) paid history (TickerTrends etc.) -> instant real baseline
//     (b) your own accumulation from TokAPI -> free, fills over weeks
//     Both return the same shape, so the engine doesn't care which.
async function tiktokBaseline(niche, tiktokVideos, paidHistoryAdapter) {
  const observations = tiktokVideos.map(v => ({
    signal: v.desc,
    value: v.views,
    engagementRate: v.views > 0 ? v.likes / v.views : 0,
    meta: { likes: v.likes },
  }));

  // OPTIONAL: backfill baseline from a paid provider keyed by hashtag.
  // If absent, momentum just relies on your own accumulated history.
  let seed = [];
  if (paidHistoryAdapter) {
    seed = await paidHistoryAdapter(niche).catch(() => []);
  }
  return { observations, seed };
}

// --- YouTube: live video data (real view/like/comment counts) pulled by the
//     server from the YouTube Data API. Every number is measured, so this is
//     a fully-trusted source (sourceTrust.youtube = 1.00).
async function youtubeBaseline(niche, youtubeVideos) {
  const observations = (youtubeVideos || []).map(v => ({
    signal: v.title,
    value: v.viewCount,
    engagementRate: v.viewCount > 0 ? v.likeCount / v.viewCount : 0,
    meta: { url: v.url, likeCount: v.likeCount },
  }));
  return { observations, seed: [] };
}

// --- Instagram: live hashtag posts via Apify. The SIGNAL IS THE DESCRIPTION
//     (the caption), not the hashtag — so momentum tracks what people are
//     actually saying, not just which tag they used.
async function instagramBaseline(niche, fetchInstagram) {
  const raw = await fetchInstagram(niche).catch(() => []);
  // defensive: some actor responses wrap posts inside a hashtag object's nested
  // `posts` array — flatten those; otherwise treat each item as a post itself.
  const posts = raw.flatMap(p => (p && Array.isArray(p.posts)) ? p.posts : [p]);
  const observations = posts.map(p => {
    const views = p.videoViewCount ?? p.videoPlayCount ?? null;
    const likes = p.likesCount ?? 0, comments = p.commentsCount ?? 0;
    return {
      signal: (p.caption || '').replace(/\s+/g, ' ').trim().slice(0, 120) || ('instagram ' + niche),
      value: views ?? likes,
      engagementRate: views ? (likes + comments) / views : (likes > 0 ? comments / likes : 0),
      meta: { url: p.url, likes, comments, views, timestamp: p.timestamp },
    };
  });
  return { observations, seed: [] };
}


/* =====================================================================
   8. DETECT TRENDS  —  the orchestrator (Cadence decides here)
   ---------------------------------------------------------------------
   Gather -> record -> score -> rank -> return.  Claude is NOT involved.
   Output numbers are all MEASURED. Every field is tagged measured:true.
   ===================================================================== */
async function detectTrends(store, niche, perPlatform) {
  // perPlatform = { tiktok: {observations, seed}, reddit: {...}, ... }
  const candidates = [];
  const seenAcross = new Map(); // signalKey -> set of platforms (cross-platform)

  // 8a. seed any historical points first (so first-scan momentum works)
  for (const [platform, data] of Object.entries(perPlatform)) {
    for (const s of (data.seed || [])) {
      const key = obsKey(niche, platform, signalKey(s.signal));
      const series = (await store.getJSON(key)) || [];
      series.push({ v: s.value, ts: s.ts || Date.now() });
      await store.setJSON(key, series);
    }
  }

  // 8b. record this scan's fresh observations
  for (const [platform, data] of Object.entries(perPlatform)) {
    await recordObservations(store, niche, platform, data.observations || []);
    for (const o of (data.observations || [])) {
      const k = signalKey(o.signal);
      if (!seenAcross.has(k)) seenAcross.set(k, new Set());
      seenAcross.get(k).add(platform);
    }
  }

  // 8c. score every observed signal: niche-relative (always available)
  //     blended with self-relative momentum (as history allows).
  for (const [platform, data] of Object.entries(perPlatform)) {
    const obs = data.observations || [];

    // build this platform's niche-relative scorer from the current pull
    const ns = nicheScorer(obs.map(o => o.value));

    for (const o of obs) {
      const k = signalKey(o.signal);
      const series = await store.getJSON(obsKey(niche, platform, k));
      const stats = computeSignalStats(series);
      if (!stats || stats.observations < CONFIG.minObservations) continue;

      const nicheRelNorm = ns.score(o.value);

      const scored = scoreTrend({
        stats,
        platform,
        engagementRate: o.engagementRate,
        crossPlatformCount: seenAcross.get(k)?.size || 1,
        nicheRelNorm,
        nicheAvailable: ns.available,
      });
      if (!scored || scored.score < CONFIG.minScoreToQualify) continue;

      candidates.push({
        signal: o.signal,
        platform,
        // ---- MEASURED fields (real, defensible) ----
        measured: {
          score: scored.score,
          heat: scored.heat,
          deltaPct: Math.round(stats.deltaPct),          // self-relative; ~0 on a cold niche
          nicheRel: Number(nicheRelNorm.toFixed(2)),     // 0..1 vs this niche's spread now
          velocity: Number(stats.velocity.toFixed(3)),
          spikeZ: Number(stats.spikeZ.toFixed(2)),
          current: stats.current,
          baseline: Math.round(stats.baseline),
          engagementRate: o.engagementRate ?? null,
          crossPlatform: seenAcross.get(k)?.size || 1,
          fresh: stats.fresh,
          observations: stats.observations,
          basis: scored.basis,                           // how "normal" was struck
        },
        meta: o.meta || {},
      });
    }
  }

  // 8d. rank by score, de-dupe by signal. Return ALL qualifying signals (no
  //     slice): clustering needs the full set so it can group across platforms.
  const seen = new Set();
  return candidates
    .sort((a, b) => b.measured.score - a.measured.score)
    .filter(c => { const k = signalKey(c.signal); if (seen.has(k)) return false; seen.add(k); return true; });
}


/* =====================================================================
   8e. CLUSTER SIGNALS  —  Claude groups, never scores
   ---------------------------------------------------------------------
   Topic-first: the raw scored signals (across every platform) are handed
   to Claude, which groups ones that are about the same underlying thing
   into generalized, platform-agnostic themes. Claude returns ONLY a
   grouping (indices + a title + reasoning), never a number. Any signal it
   leaves unassigned becomes its own single-member theme so nothing is lost.
   ===================================================================== */
async function clusterSignals(claudeCall, niche, scoredSignals) {
  const signals = scoredSignals || [];
  if (signals.length === 0) return [];

  // every signal becomes its own theme — used as the cold fallback and to
  // catch any signal Claude doesn't assign.
  const soloTheme = (s) => ({
    title: s.signal,
    reasoning: 'Single signal.',
    members: [s],
  });

  // one signal -> nothing to cluster
  if (signals.length === 1) return [soloTheme(signals[0])];

  const list = signals
    .map((s, i) => `${i + 1}. [${s.platform}] ${s.signal}`)
    .join('\n');

  const prompt =
`These are raw signals observed across platforms for the niche "${niche}". Group them into distinct trends. Two signals belong to the same trend if they are about the same underlying thing, even if worded differently or on different platforms. Some trends live on one platform only — that is fine, keep them as their own group. Give each group a short, generalized, platform-agnostic title and one sentence on why these belong together.

SIGNALS:
${list}

Return ONLY JSON: {"themes":[{"title":"...","reasoning":"...","members":[<indices>]}]}
Do not output any numbers, percentages, or metrics.`;

  let parsed;
  try {
    const text = await claudeCall(prompt, false);
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : text);
  } catch (e) {
    // grouping failed -> every signal stands on its own (never drop a signal)
    return signals.map(soloTheme);
  }

  const themes = [];
  const assigned = new Set();
  for (const th of (parsed.themes || [])) {
    const members = [];
    for (const raw of (th.members || [])) {
      const idx = Number(raw) - 1;                 // prompt is 1-based
      if (!Number.isInteger(idx) || idx < 0 || idx >= signals.length) continue;
      if (assigned.has(idx)) continue;             // a signal lands in one theme
      assigned.add(idx);
      members.push(signals[idx]);
    }
    if (!members.length) continue;
    themes.push({
      title: deepClean(String(th.title || members[0].signal)),
      reasoning: deepClean(String(th.reasoning || '')),
      members,
    });
  }

  // any signal Claude left out becomes its own theme
  signals.forEach((s, i) => { if (!assigned.has(i)) themes.push(soloTheme(s)); });

  return themes;
}


/* =====================================================================
   8f. AGGREGATE THEMES  —  Cadence scores the themes (no Claude)
   ---------------------------------------------------------------------
   Every number here comes from the members' MEASURED stats. A theme's
   score is its strongest member plus a breadth bonus for spanning more
   platforms. Heat is derived from that score via CONFIG.heat.
   ===================================================================== */
function aggregateThemes(themesWithMembers) {
  const heatFor = (score) =>
    score >= CONFIG.heat.viral ? 'viral' :
    score >= CONFIG.heat.hot   ? 'hot'   : 'rising';

  const C = CONFIG.clustering;

  const themes = (themesWithMembers || []).map((theme, ti) => {
    const members = theme.members || [];
    // strongest member overall = the dominant signal
    const dominant = members.reduce((best, m) =>
      (!best || m.measured.score > best.measured.score) ? m : best, null);

    const platforms = [...new Set(members.map(m => m.platform))];
    const breadth = platforms.length;

    const bestScore = members.reduce((mx, m) => Math.max(mx, m.measured.score), 0);
    const breadthBonus = Math.min(C.breadthBonusCap, (breadth - 1) * C.breadthBonusPerPlatform);
    const score = Math.min(100, Math.round(bestScore + breadthBonus));

    // evidence: the strongest member ON EACH platform (one chip per platform)
    const evidence = platforms.map(p => {
      const top = members
        .filter(m => m.platform === p)
        .reduce((best, m) => (!best || m.measured.score > best.measured.score) ? m : best, null);
      return {
        platform: p,
        value: top.measured.current,
        engagementRate: top.measured.engagementRate ?? null,
        deltaPct: top.measured.deltaPct,
        url: top.meta?.url || null,
      };
    }).sort((a, b) => b.value - a.value);

    return {
      id: 'theme_' + (ti + 1),
      title: theme.title,
      reasoning: theme.reasoning || '',
      platforms,
      dominantPlatform: dominant ? dominant.platform : (platforms[0] || ''),
      measured: {
        score,
        heat: heatFor(score),
        deltaPct: dominant ? dominant.measured.deltaPct : 0,            // real, from dominant member
        engagementRate: dominant ? (dominant.measured.engagementRate ?? null) : null,
        breadth,
        evidence,
        basis: dominant ? dominant.measured.basis : null,
      },
      meta: {},
    };
  });

  return themes
    .sort((a, b) => b.measured.score - a.measured.score)
    .slice(0, C.maxThemes);
}


/* =====================================================================
   9. EXPLAIN  —  Claude as explainer, never judge
   ---------------------------------------------------------------------
   We send the ALREADY-DECIDED trends with their REAL numbers and ask
   Claude only for the creative layer. It does not pick trends and does
   not produce a single statistic. One job per call (your token lesson).
   ===================================================================== */
async function explainTrendsWithClaude(claudeCall, niche, audience, trends) {
  // `trends` are now THEMES. We pass each theme's title + where it has the most
  // traction (dominantPlatform), and nothing numeric, so Claude can't echo a
  // statistic into the copy.
  const list = trends.map((t, i) =>
    `${i + 1}. "${t.title}" (most traction on ${t.dominantPlatform || 'unknown'})`
  ).join('\n');

  const prompt =
`You are a social strategist. These trends are ALREADY CONFIRMED with real data.
Do NOT add, change, or invent any numbers, percentages, or heat levels.
For each, write only the creative layer.

NICHE: ${niche} | AUDIENCE: ${audience || 'general'}
CONFIRMED TRENDS:
${list}

The angle may note where the trend has the most traction, but ONLY using the platform named for that trend above. Do not invent or mention any other platform.

The creative layer must contain NO statistics of any kind: no percentages, no counts, no ratios, no +X% figures. Those numbers appear on the card. The only digits allowed are ones inside the trend's own title.

${STYLE}

Return ONLY valid JSON, same order:
{"items":[{"angle":"the winning angle in 1-2 sentences","captionHook":"first line that stops the scroll","hashtags":["#a","#b","#c","#d","#e"]}]}`;

  const text = await claudeCall(prompt, false); // no web search needed -> faster
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : text);

  // sanitize the AI creative layer so Ideas/Calendar entries saved from these
  // trends are clean too (no em/en dash, no emoji)
  const items = deepClean(parsed.items || []);

  // merge creative layer onto measured trends, tagging what's generated
  return trends.map((t, i) => ({
    ...t,
    generated: items[i]
      ? { ...items[i], _label: 'AI-written' }
      : null,
  }));
}


/* =====================================================================
   10. RUN SCAN  —  full flow, drop-in replacement for runScan()
   ---------------------------------------------------------------------
   Pass in the app's existing fetchers so this slots into the current
   proxy with no new infrastructure beyond the store.
   ===================================================================== */
async function runScan(opts) {
  const {
    store, niche, audience, platforms,
    tiktokVideos = [],          // from existing parseVideos()
    fetchReddit,                // from existing app
    fetchTrendSeries,           // pytrends/Apify/SerpApi wrapper (free baseline)
    paidTiktokHistory = null,   // optional: TickerTrends-style adapter, or null
    youtubeVideos = [],         // from existing /api/youtube search+videos pull
    fetchInstagram = null,      // Apify Instagram scraper wrapper, or null
    claudeCall,                 // from existing app
    onStatus = () => {},
  } = opts;

  const perPlatform = {};

  // gather every source IN PARALLEL (speed win #1)
  onStatus('reading sources…');
  const jobs = [];

  if (platforms.includes('tiktok'))
    jobs.push(tiktokBaseline(niche, tiktokVideos, paidTiktokHistory)
      .then(r => { perPlatform.tiktok = r; }));

  if (platforms.includes('reddit') && fetchReddit)
    jobs.push(redditBaseline(niche, fetchReddit)
      .then(r => { perPlatform.reddit = r; }));

  if (platforms.includes('google_trends') && fetchTrendSeries)
    jobs.push(googleTrendsBaseline(niche, fetchTrendSeries)
      .then(r => { perPlatform.google_trends = r; }));

  if (platforms.includes('youtube'))
    jobs.push(youtubeBaseline(niche, youtubeVideos)
      .then(r => { perPlatform.youtube = r; }));

  if (platforms.includes('instagram') && fetchInstagram)
    jobs.push(instagramBaseline(niche, fetchInstagram)
      .then(r => { perPlatform.instagram = r; }));

  await Promise.allSettled(jobs);

  // Cadence scores every signal from real numbers (no Claude)
  onStatus('scoring momentum…');
  const signals = await detectTrends(store, niche, perPlatform);

  if (signals.length === 0) return { trends: [], note: 'No signals cleared the bar this scan.' };

  // Claude groups signals into generalized themes (grouping only, no numbers)
  onStatus('clustering themes…');
  const clustered = await clusterSignals(claudeCall, niche, signals);

  // Cadence scores + ranks the themes from their members' real numbers
  const themes = aggregateThemes(clustered);

  if (themes.length === 0) return { trends: [], note: 'No signals cleared the bar this scan.' };

  // Claude writes only the creative layer for each theme
  onStatus('writing angles…');
  const enriched = await explainTrendsWithClaude(claudeCall, niche, audience, themes);

  return { trends: enriched };
}


/* =====================================================================
   EXPORTS
   ===================================================================== */
module.exports = {
  CONFIG,
  STYLE, cleanCopy, deepClean,
  HistoryStore, InMemoryStore,
  signalKey, recordObservations,
  computeSignalStats, scoreTrend,
  googleTrendsBaseline, redditBaseline, tiktokBaseline,
  youtubeBaseline, instagramBaseline,
  detectTrends, clusterSignals, aggregateThemes,
  explainTrendsWithClaude, runScan,
};


/* =====================================================================
   NOTES FOR GARRISON
   ---------------------------------------------------------------------
   STORAGE — Replit DB adapter (drop-in for InMemoryStore):

     const Database = require("@replit/database");
     const db = new Database();
     class ReplitStore extends HistoryStore {
       async getJSON(k)        { return (await db.get(k)) ?? null; }
       async setJSON(k, v)     { await db.set(k, v); }
       async listKeys(prefix)  { return await db.list(prefix); }
     }

   STORAGE — SQL equivalent (when you outgrow KV):

     CREATE TABLE observations (
       niche       TEXT NOT NULL,
       platform    TEXT NOT NULL,
       signal_key  TEXT NOT NULL,
       value       DOUBLE PRECISION NOT NULL,
       ts          TIMESTAMPTZ NOT NULL DEFAULT now()
     );
     CREATE INDEX ON observations (niche, platform, signal_key, ts);
     -- baseline query: AVG(value) WHERE ts >= now() - interval '14 days'

   GOOGLE TRENDS — fetchTrendSeries(term) must return
     [{ date: '2026-06-01', value0to100: 73 }, ...]
     Wrap pytrends (free) or SerpApi/Glimpse (paid, reliable).
     Because it's historical, the `seed` backfills history so momentum
     works on the very first scan — no accumulation wait.

   TIKTOK — leave paidTiktokHistory = null to start (own accumulation,
     fills over ~2 weeks). When/if a provider is bought, pass an adapter
     niche -> [{signal, value, ts}] and baselines become instant.

   TUNING — every "what qualifies" decision is in CONFIG. To make trends
     stricter raise minScoreToQualify; to favor fresh over big, raise
     weights.freshness and lower weights.engagement; to move the Viral
     bar, edit heat.viral. No other code changes needed.

   SPEED — repeat scans of a recently-scanned niche can skip the network
     entirely: read the stored observations, re-score, return. Add a
     short freshness check on the newest ts before deciding to re-fetch.
   ===================================================================== */
