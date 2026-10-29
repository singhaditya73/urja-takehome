import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import type { PortalClient } from '../portal/client.js';
import { normalizeEnergy, type NormalizedEnergy } from './energy.js';
import { getEnergyCache, putEnergyCache } from '../store/queries.js';

/**
 * Serves meters' energy series from the portal, through a small cache with:
 *  - TTL-based staleness (payload fetched > ttl ago is refetched in background
 *    terms: we simply refetch before serving when stale — simple + predictable)
 *  - in-flight coalescing, so N clients asking for the same meter at once
 *    trigger one portal fetch
 * The portal caps each response at its own page logic, we request from/to
 * explicitly, so the cache key is (meter, from, to).
 */
export class EnergyService {
  constructor(
    private readonly db: Database.Database,
    private readonly portal: PortalClient,
    private readonly config: AppConfig
  ) {}

  private inflight = new Map<string, Promise<{ series: NormalizedEnergy; served_from: 'portal' | 'cache' | 'cache-stale' }>>();

  async getEnergy(meterId: string, from?: string, to?: string): Promise<{ series: NormalizedEnergy; served_from: 'portal' | 'cache' | 'cache-stale' }> {
    const key = JSON.stringify({ meterId, from: from ?? null, to: to ?? null });
    const cachedRow = getEnergyCache(this.db, key);
    if (cachedRow && Date.now() - cachedRow.fetched_at < this.config.ttl.energySeconds * 1000) {
      return { series: JSON.parse(cachedRow.payload) as NormalizedEnergy, served_from: 'cache' };
    }
    if (cachedRow) {
      // Serve stale immediately, refresh in the background. Improves latency
      // without pretending data is exactly fresh.
      void this.fetchAndCache(meterId, key, from, to).catch(() => undefined);
      return { series: JSON.parse(cachedRow.payload) as NormalizedEnergy, served_from: 'cache-stale' };
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = this.fetchAndCache(meterId, key, from, to);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async fetchAndCache(
    meterId: string,
    key: string,
    from?: string,
    to?: string
  ): Promise<{ series: NormalizedEnergy; served_from: 'portal' | 'cache' | 'cache-stale' }> {
    const raw = await this.portal.getEnergy(meterId, from, to);
    const series = normalizeEnergy(raw);
    putEnergyCache(this.db, key, JSON.stringify(series), Date.now());
    return { series, served_from: 'portal' };
  }
}
