/* ============================================================================
   run-panel-scan.js — run the panel scan as a one-shot command
   ----------------------------------------------------------------------------
   Calls runPanelScan() in-process: no server, no port, no HTTP. This is the
   entry point for any scheduler that runs a command rather than hitting a URL
   (Replit Scheduled Deployment, `npm run panel-scan` by hand). Needs the same
   env the server does — RAPIDAPI_KEY for TokAPI, REPLIT_DB_URL for the store.

   The HTTP path (POST /api/cron/panel-scan, guarded by CRON_KEY) still exists
   for schedulers that can only make a request; see .github/workflows/panel-scan.yml.
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
