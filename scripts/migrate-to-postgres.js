/* ============================================================================
   migrate-to-postgres.js — copy every Replit DB key into Neon Postgres
   ----------------------------------------------------------------------------
   Run this from an environment that can see BOTH stores — in practice that
   means on Replit, since REPLIT_DB_URL only exists there:

     npm run migrate-to-postgres

   Keys are enumerated by listing the store with an empty prefix, so whatever is
   actually in Replit DB gets copied. Nothing is filtered against a hardcoded
   prefix list, because anything missing from such a list would be silently
   left behind.

   Safe to re-run: every write is an upsert keyed on `key`, so a second pass
   overwrites with the current value rather than duplicating. It never deletes,
   so re-running after new scans have landed simply brings Postgres up to date.
   ========================================================================== */

require('dotenv').config();

const { ReplitStore, PostgresStore } = require('../server.js');

// Group for the per-prefix report: everything up to and including the first
// colon (scan:, series:, thumb:, ...). Keys without a colon report as '(none)'.
function prefixOf(key) {
  const i = key.indexOf(':');
  return i === -1 ? '(none)' : key.slice(0, i + 1);
}

function bump(counts, key) {
  const p = prefixOf(key);
  counts.set(p, (counts.get(p) || 0) + 1);
}

function report(label, counts, total) {
  console.log(`\n${label}`);
  if (!counts.size) { console.log('  (none)'); return; }
  const width = Math.max(...[...counts.keys()].map((p) => p.length));
  for (const p of [...counts.keys()].sort()) {
    console.log(`  ${p.padEnd(width)}  ${String(counts.get(p)).padStart(5)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(width)}  ${String(total).padStart(5)}`);
}

async function main() {
  if (!process.env.REPLIT_DB_URL) {
    throw new Error('REPLIT_DB_URL is not set — run this on Replit, where the source store lives.');
  }
  if (!process.env.NEON_DATABASE_URL) {
    throw new Error('NEON_DATABASE_URL is not set — add it to .env before migrating.');
  }

  const src = new ReplitStore();
  const dst = new PostgresStore();

  console.log('Listing every key in Replit DB…');
  const keys = await src.listKeys('');
  console.log(`Found ${keys.length} key(s).`);
  if (!keys.length) { await dst.close(); return { migrated: 0, skipped: 0, failed: 0 }; }

  const migrated = new Map();
  const skipped  = new Map();
  const failures = [];
  let done = 0;

  for (const key of keys) {
    try {
      const value = await src.getJSON(key);
      if (value === null || value === undefined) {
        // Absent or unreadable on the source side. Copying `null` would write a
        // real JSON null and mask the difference, so record and move on.
        bump(skipped, key);
      } else {
        await dst.setJSON(key, value);
        bump(migrated, key);
      }
    } catch (e) {
      failures.push({ key, message: e.message });
    }
    if (++done % 25 === 0 || done === keys.length) {
      console.log(`  …${done}/${keys.length}`);
    }
  }

  const migratedTotal = [...migrated.values()].reduce((a, b) => a + b, 0);
  const skippedTotal  = [...skipped.values()].reduce((a, b) => a + b, 0);

  report('Migrated by prefix:', migrated, migratedTotal);
  if (skippedTotal) report('Skipped (null/absent in Replit DB):', skipped, skippedTotal);

  if (failures.length) {
    console.log(`\nFailed (${failures.length}):`);
    for (const f of failures.slice(0, 20)) console.log(`  ${f.key}: ${f.message}`);
    if (failures.length > 20) console.log(`  …and ${failures.length - 20} more`);
  }

  const inPg = (await dst.listKeys('')).length;
  console.log(`\nPostgres now holds ${inPg} key(s) in total.`);

  await dst.close();
  return { migrated: migratedTotal, skipped: skippedTotal, failed: failures.length };
}

main()
  .then(({ migrated, skipped, failed }) => {
    console.log(`\n${failed ? '✗' : '✓'} migrate: ${migrated} migrated, ${skipped} skipped, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('✗ migrate error:', e.message);
    process.exit(1);
  });
