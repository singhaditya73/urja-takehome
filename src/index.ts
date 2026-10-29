import { loadConfig } from './config.js';
import { openDatabase } from './store/db.js';
import { PortalClient } from './portal/client.js';
import { EnergyService } from './domain/energyService.js';
import { IndexService } from './domain/indexService.js';
import { buildApp } from './app.js';

export async function start(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.paths.db);
  const portal = new PortalClient(config.portal, { secretTtlMs: config.ttl.signingSecretSeconds * 1000 });
  const energy = new EnergyService(db, portal, config);
  const index = new IndexService(db, portal, config);

  const app = await buildApp({ config, services: { portal, energy, index, db } });

  // Warm the index in the background so the first caller doesn't pay for it.
  void index.ensureFresh().catch((err) => {
    app.log.error({ err }, 'startup index refresh failed (will retry on demand)');
  });

  await app.listen({ port: config.port, host: config.host });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
