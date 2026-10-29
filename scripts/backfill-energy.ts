import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/store/db.js';
import { PortalClient } from '../src/portal/client.js';
import { EnergyService } from '../src/domain/energyService.js';
import { IndexService } from '../src/domain/indexService.js';

/**
 * Optional CLI: walks every meter in the index and pulls its June 2026
 * energy series through the (paced) portal client so the API answers from
 * cache. Run only when you want the full dataset warm:
 *
 *   npx tsx scripts/backfill-energy.ts
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.paths.db);
  const portal = new PortalClient(config.portal, { secretTtlMs: config.ttl.signingSecretSeconds * 1000 });
  const energy = new EnergyService(db, portal, config);
  const index = new IndexService(db, portal, config);

  const fresh = await index.ensureFresh();
  if (fresh.stale) console.warn('warning: serving a stale index while backfilling');

  const rows = db.prepare('SELECT meter_id FROM meters ORDER BY meter_id').all() as Array<{ meter_id: string }>;
  console.log(`backfilling energy for ${rows.length} meters (${config.portal.minRequestIntervalMs}ms pacing)...`);
  let done = 0;
  let wall = Date.now();
  for (const { meter_id } of rows) {
    try {
      await energy.getEnergy(meter_id, '2026-06-01', '2026-06-30');
    } catch (err) {
      console.warn(`  ${meter_id}: ${(err as Error).message}`);
    }
    done += 1;
    if (done % 20 === 0) {
      const rate = 20 / ((Date.now() - wall) / 1000);
      wall = Date.now();
      console.log(`  ${done}/${rows.length} (${rate.toFixed(1)} req/s)`);
    }
  }
  console.log('done');
  process.exit(0);
}

void main();
