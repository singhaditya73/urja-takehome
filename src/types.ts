import type { AppConfig } from './config.js';
import type { PortalClient } from './portal/client.js';
import type { EnergyService } from './domain/energyService.js';
import type { IndexService } from './domain/indexService.js';
import type { Db } from './store/db.js';

export interface Services {
  config: AppConfig;
  portal: PortalClient;
  energy: EnergyService;
  index: IndexService;
  db: Db;
}
