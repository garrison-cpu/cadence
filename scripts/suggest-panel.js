/* ============================================================================
   suggest-panel.js — real-data trendsetter-panel miner
   ----------------------------------------------------------------------------
   Discovers mid-tier TikTok accounts per category using ONLY live TokAPI
   responses — no handle in the output originates anywhere but an API response
   received during this run.

   Per category:
     1. GET /v1/search/post?keyword={category}&count=20 — extract each post's
        author unique_id (search_item_list[].aweme_info.author, defensively
        item.author). Recurrence across a category's top posts = trendsetter
        signal.
     2. Dedupe authors across categories (an account belongs to the category
        where it recurs most).
     3. GET /v1/user/@{handle} for real uid / sec_uid / follower_count.
        Candidates whose follower_count AS REPORTED BY SEARCH ITSELF is wildly
        out of band (<5K or >2M) are skipped before the lookup to save quota —
        they cannot plausibly land in 50K–500K. Every KEPT account is validated
        by its own /v1/user response.
     4. Keep 50K <= followers <= 500K, rank by recurrence then followers.

   Writes the top ~5/category (max ~50 total) into panel.json (preserving
   _doc), prints the full ranked candidate list so the team can swap picks.

   Run:  RAPIDAPI_KEY=... node scripts/suggest-panel.js   (or: npm run suggest-panel)
   ========================================================================== */

const fs   = require('fs');
const path = require('path');

const TOKAPI_HOST = 'tokapi-mobile-version.p.rapidapi.com';
const TOKAPI_BASE = 'https://' + TOKAPI_HOST;
const RAPID_KEY   = process.env.RAPIDAPI_KEY || '';

const PANEL_PATH = path.join(__dirname, '..', 'panel.json');

const BAND_MIN = 50000;
const BAND_MAX = 500000;
// search-payload prefilter (generous margins; final check uses /v1/user data)
const PREFILTER_MIN = 5000;
const PREFILTER_MAX = 2000000;

const PER_CATEGORY = 5;
const TOTAL_CAP    = 50;
const PACE_MS      = 350;

const CATEGORIES = [
  'beauty', 'skincare', 'fitness', 'home workouts', 'food', 'cooking',
  'fashion', 'thrifting', 'finance', 'tech gadgets', 'home decor', 'DIY',
  'travel', 'pets', 'parenting', 'gaming', 'books', 'music', 'comedy',
  'wellness', 'cars', 'art', 'small business', 'photography',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror server.js tokGet(): rapidapi headers, surface HTTP-200 logical errors.
async function tokGet(p) {
  const r = await fetch(TOKAPI_BASE + p, {
    headers: { 'x-rapidapi-key': RAPID_KEY, 'x-rapidapi-host': TOKAPI_HOST },
  });
  if (!r.ok) throw new Error('TokAPI ' + r.status);
  const body = await r.json();
  if (body && body.status_code) {
    throw new Error('TokAPI logical error ' + body.status_code + ': ' + (body.message || body.status_msg || ''));
  }
  return body;
}

// Defensive author pluck — confirmed shape is item.aweme_info.author, but stay
// tolerant of the alternates TokAPI uses on other search variants.
function pluckAuthor(item) {
  const aweme = item?.aweme_info || item?.item || item;
  const a = aweme?.author;
  if (!a || typeof a.unique_id !== 'string' || !a.unique_id.trim()) return null;
  return a;
}

function pickUser(raw) {
  return raw?.user || raw?.data?.user || raw?.userInfo?.user || raw?.data || raw || {};
}

async function main() {
  if (!RAPID_KEY) {
    console.error('✗ RAPIDAPI_KEY is not set.');
    process.exit(1);
  }

  // ── 1. search every category, tally author recurrence ─────────────────────
  // candidates: handle -> { perCat: {cat: count}, searchFollowers }
  const candidates = new Map();
  const emptyCategories = [];

  for (const cat of CATEGORIES) {
    let list = [];
    try {
      const body = await tokGet('/v1/search/post?keyword=' + encodeURIComponent(cat) + '&count=20&offset=0');
      list = body.search_item_list || body.aweme_list || body.data || [];
      if (!Array.isArray(list)) list = [];
    } catch (e) {
      console.error(`[search] "${cat}" failed: ${e.message}`);
    }
    let found = 0;
    for (const item of list) {
      const a = pluckAuthor(item);
      if (!a) continue;
      found++;
      const h = a.unique_id;
      if (!candidates.has(h)) candidates.set(h, { perCat: {}, searchFollowers: null });
      const c = candidates.get(h);
      c.perCat[cat] = (c.perCat[cat] || 0) + 1;
      if (typeof a.follower_count === 'number') {
        c.searchFollowers = Math.max(c.searchFollowers ?? 0, a.follower_count);
      }
    }
    console.log(`[search] "${cat}": ${list.length} posts, ${found} authors`);
    if (found === 0) emptyCategories.push(cat);
    await sleep(PACE_MS);
  }

  // ── 2. assign each author to the category where it recurs most ────────────
  const assigned = [];
  for (const [handle, c] of candidates) {
    let best = null, bestN = 0, recurrence = 0;
    for (const [cat, n] of Object.entries(c.perCat)) {
      recurrence += n;
      if (n > bestN) { best = cat; bestN = n; }
    }
    assigned.push({ handle, niche: best, recurrence, searchFollowers: c.searchFollowers });
  }
  console.log(`\n${assigned.length} unique authors across ${CATEGORIES.length} categories`);

  // ── 3. resolve real uid/secUid/followers per candidate ────────────────────
  const resolved = [];
  let prefiltered = 0, lookupFails = 0;
  for (const cand of assigned) {
    const sf = cand.searchFollowers;
    if (sf != null && (sf < PREFILTER_MIN || sf > PREFILTER_MAX)) { prefiltered++; continue; }
    try {
      const raw = await tokGet('/v1/user/@' + encodeURIComponent(cand.handle));
      const u = pickUser(raw);
      const followers = u.follower_count ?? u.followerCount ?? null;
      const uid = u.uid || u.id || null;
      const secUid = u.sec_uid || u.secUid || null;
      if (uid && followers != null) {
        resolved.push({ ...cand, uid: String(uid), secUid: secUid || '', followers });
      } else {
        lookupFails++;
      }
    } catch (e) {
      lookupFails++;
      console.error(`[user] @${cand.handle} failed: ${e.message}`);
    }
    await sleep(PACE_MS);
  }
  console.log(`resolved ${resolved.length} (prefiltered out-of-band from search data: ${prefiltered}, lookup failures: ${lookupFails})`);

  // ── 4. band filter + rank ──────────────────────────────────────────────────
  const inBand = resolved.filter((r) => r.followers >= BAND_MIN && r.followers <= BAND_MAX);
  const byCat = {};
  for (const r of inBand) (byCat[r.niche] = byCat[r.niche] || []).push(r);
  for (const cat of Object.keys(byCat)) {
    byCat[cat].sort((a, b) => b.recurrence - a.recurrence || b.followers - a.followers);
  }

  // ── candidate report (full in-band list, ranked) ──────────────────────────
  console.log('\n════ CANDIDATE REPORT (all in-band 50K–500K, ranked per category) ════');
  const gapCategories = [];
  for (const cat of CATEGORIES) {
    const rows = byCat[cat] || [];
    if (!rows.length) { gapCategories.push(cat); continue; }
    console.log(`\n· ${cat}`);
    for (const r of rows) {
      console.log(`   @${r.handle} · ${r.followers.toLocaleString()} followers · recurrence ${r.recurrence}`);
    }
  }
  if (gapCategories.length) {
    console.log(`\n⚠ categories with NO mid-tier candidates this run: ${gapCategories.join(', ')}`);
  }
  if (emptyCategories.length) {
    console.log(`⚠ categories whose search returned no authors at all: ${emptyCategories.join(', ')}`);
  }

  // ── 5. write panel.json (top PER_CATEGORY per category, TOTAL_CAP overall) ─
  let panel = {};
  try { panel = JSON.parse(fs.readFileSync(PANEL_PATH, 'utf8')); } catch {}
  const accounts = [];
  for (const cat of CATEGORIES) {
    for (const r of (byCat[cat] || []).slice(0, PER_CATEGORY)) {
      if (accounts.length >= TOTAL_CAP) break;
      accounts.push({ handle: r.handle, niche: r.niche, uid: r.uid, secUid: r.secUid, followers: r.followers });
    }
  }
  const out = { _doc: panel._doc || '', accounts };
  fs.writeFileSync(PANEL_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n✓ wrote ${accounts.length} accounts to panel.json (cap ${PER_CATEGORY}/category, ${TOTAL_CAP} total)`);
}

main().catch((e) => { console.error('✗ suggest-panel failed:', e.message); process.exit(1); });
