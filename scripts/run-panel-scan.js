/* ============================================================================
   run-panel-scan.js — run the panel scan as a one-shot command
   ----------------------------------------------------------------------------
   Calls runPanelScan() in-process: no server, no port, no HTTP. This is the
   entry point for any scheduler that runs a command rather than hitting a URL
   (GitHub Actions, `npm run panel-scan` by hand). Needs the same env the server
   does — RAPIDAPI_KEY for TokAPI, plus whatever the active store reads:
   NEON_DATABASE_URL for PostgresStore, REPLIT_DB_URL for ReplitStore.

   .github/workflows/panel-scan.yml runs this file directly on the runner. Note
   that the runner has no REPLIT_DB_URL, so this only succeeds once server.js
   switches `store` to PostgresStore.

   The HTTP path (POST /api/cron/panel-scan, guarded by CRON_KEY) still exists
   for schedulers that can only make a request.
   ========================================================================== */

const { runPanelScan } = require('../server.js');

runPanelScan()
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    console.log('✓ panel-scan ok');
    process.exit(0);
  })
  .catch((e) => {
    console.error('✗ panel-scan error:', e.message);
    process.exit(1);
  });
