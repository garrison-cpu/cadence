/* ============================================================================
   resolve-panel.js — one-time/occasional curation helper
   ----------------------------------------------------------------------------
   Reads panel.json and, for each account missing a uid, resolves its TikTok
   identifiers (uid + sec_uid) and follower_count from TokAPI, writes them back
   into panel.json IN PLACE, and prints a vet report. Accounts outside the
   50K–500K target band are FLAGGED (kept, not removed — vetting is a human
   decision; this just surfaces the data).

   Run:  RAPIDAPI_KEY=... node scripts/resolve-panel.js   (or: npm run resolve-panel)

   Resilient by design: each account is wrapped in try/catch so one bad handle
   never aborts the run, and panel.json is saved at the end regardless.
   ========================================================================== */

const fs   = require('fs');
const path = require('path');

const TOKAPI_HOST = 'tokapi-mobile-version.p.rapidapi.com';
const TOKAPI_BASE = 'https://' + TOKAPI_HOST;
const RAPID_KEY   = process.env.RAPIDAPI_KEY || '';

const PANEL_PATH = path.join(__dirname, '..', 'panel.json');

const BAND_MIN = 50000;
const BAND_MAX = 500000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror server.js tokGet(): fetch TOKAPI_BASE+path with the rapidapi headers,
// surface tokapi's HTTP-200 logical errors, return parsed JSON.
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

// Defensive pluck — TokAPI nests user objects differently across endpoints.
function pickUser(raw) {
  return raw?.user || raw?.data?.user || raw?.userInfo?.user || raw?.data || raw || {};
}

async function main() {
  if (!RAPID_KEY) {
    console.error('✗ RAPIDAPI_KEY is not set. Export it before running, e.g.\n    RAPIDAPI_KEY=xxxx npm run resolve-panel');
    process.exit(1);
  }

  let panel;
  try {
    panel = JSON.parse(fs.readFileSync(PANEL_PATH, 'utf8'));
  } catch (e) {
    console.error('✗ Could not read/parse panel.json:', e.message);
    process.exit(1);
  }

  const accounts = Array.isArray(panel.accounts) ? panel.accounts : [];
  if (!accounts.length) {
    console.log('panel.json has no accounts. Add some as {handle, niche} and re-run.');
    return;
  }

  let resolved = 0, skipped = 0, failed = 0, flagged = 0;

  for (const acct of accounts) {
    const handle = (acct.handle || '').replace(/^@/, '').trim();
    if (!handle) { console.warn('· skipping entry with no handle:', JSON.stringify(acct)); continue; }

    if (acct.uid) {
      console.log(`· @${handle} already has uid (${acct.uid}) — skipping`);
      skipped++;
      continue;
    }

    try {
      // 1) identifiers (uid + sec_uid)
      const idRaw  = await tokGet(`/v1/user/username/${encodeURIComponent(handle)}`);
      const idUser = pickUser(idRaw);
      const uid    = idUser.uid || idUser.id || idUser.user_id || null;
      const secUid = idUser.sec_uid || idUser.secUid || null;

      if (!uid) throw new Error('no uid in /v1/user/username response');

      await sleep(300);

      // 2) follower_count
      const profRaw  = await tokGet(`/v1/user/@${encodeURIComponent(handle)}`);
      const profUser = pickUser(profRaw);
      const followers = profUser.follower_count ?? profUser.followers ?? profUser.followerCount ?? null;

      acct.uid       = uid;
      acct.secUid    = secUid;
      acct.followers = followers;
      acct.platform  = acct.platform || 'tiktok';

      const inBand = typeof followers === 'number' && followers >= BAND_MIN && followers <= BAND_MAX;
      const flag   = inBand ? '' : '  ⚠ OUT OF BAND (target 50K–500K)';
      if (!inBand) flagged++;

      console.log(
        `✓ @${handle} [${acct.niche || '—'}]  uid=${uid}  followers=${followers ?? 'unknown'}${flag}`
      );
      resolved++;
    } catch (e) {
      console.error(`✗ @${handle} failed: ${e.message}`);
      failed++;
    }

    await sleep(300);
  }

  try {
    fs.writeFileSync(PANEL_PATH, JSON.stringify(panel, null, 2) + '\n');
    console.log(`\nSaved panel.json — resolved=${resolved} skipped=${skipped} failed=${failed} flagged=${flagged}`);
  } catch (e) {
    console.error('✗ Could not write panel.json:', e.message);
    process.exit(1);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
