/* ============================================================================
   run-panel-scan.js — local trigger for the panel scan
   ----------------------------------------------------------------------------
   POSTs to the running server's /api/cron/panel-scan with the x-cron-key
   header, prints the JSON response, and exits non-zero on any failure. This is
   the entry point for a Replit Scheduled Deployment (which runs a command, not
   an HTTP cron) — it just hits the in-process endpoint on localhost.
   ========================================================================== */

const PORT     = process.env.PORT || 3000;
const CRON_KEY = process.env.CRON_KEY || '';
const URL      = `http://localhost:${PORT}/api/cron/panel-scan`;

async function main() {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'x-cron-key': CRON_KEY, 'content-type': 'application/json' },
  });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }

  console.log(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));

  if (!r.ok) {
    console.error(`✗ panel-scan failed: HTTP ${r.status}`);
    process.exit(1);
  }
  console.log('✓ panel-scan ok');
}

main().catch((e) => { console.error('✗ panel-scan error:', e.message); process.exit(1); });
