import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/store/db.js';
import { PortalClient } from '../src/portal/client.js';
import { EnergyService } from '../src/domain/energyService.js';
import { IndexService } from '../src/domain/indexService.js';
import { buildApp } from '../src/app.js';

/** Writes the OpenAPI document that ships in the repo, straight from the
 *  live Fastify schemas, so it can never drift from the running service. */
const config = loadConfig();
const db = openDatabase(':memory:');
const portal = new PortalClient(config.portal);
const energy = new EnergyService(db, portal, config);
const index = new IndexService(db, portal, config);
const app = await buildApp({ config, services: { portal, energy, index, db } });
await app.ready();
const spec = app.swagger();
writeFileSync('openapi.json', JSON.stringify(spec, null, 2) + '\n');
await app.close();
console.log('openapi.json written');
