import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import type { PortalClient } from '../portal/client.js';
import { ingestExport, indexAge } from '../store/ingest.js';
import type { DistributionTransformer } from '../portal/types.js';

/**
 * Keeps the local meter index (from the portal's bulk export) fresh.
 *
 * The export is one signed request for the whole dataset (~240 KB), so the
 * refresh policy is simple: if the snapshot is older than the TTL, refetch it
 * on demand. If the portal is unreachable or rate-limits us when we try, we
 * serve the stale snapshot and flag it — the portal being down must not take
 * the API down with it.
 */
export class IndexService {
  constructor(
    private readonly db: Database.Database,
    private readonly portal: PortalClient,
    private readonly config: AppConfig
  ) {}

  async ensureFresh(): Promise<{ index_age_ms: number | null; refreshed: boolean; stale: boolean }> {
    const age = indexAge(this.db);
    if (age !== null && age < this.config.ttl.indexSeconds * 1000) {
      return { index_age_ms: age, refreshed: false, stale: false };
    }
    try {
      await this.refresh();
      return { index_age_ms: indexAge(this.db), refreshed: true, stale: false };
    } catch (err) {
      if (age !== null) {
        return { index_age_ms: age, refreshed: false, stale: true };
      }
      throw err; // nothing at all to serve
    }
  }

  async refresh(): Promise<void> {
    const payload = await this.portal.getExport();
    const dts = await this.allTransformers();
    ingestExport(this.db, payload, dts);
  }

  private async allTransformers(): Promise<DistributionTransformer[]> {
    const all: DistributionTransformer[] = [];
    for (let page = 1; ; page++) {
      const res = await this.portal.getTransformers(page);
      all.push(...res.data);
      if (page * 20 >= res.total) break;
    }
    return all;
  }
}
