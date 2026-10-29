import { describe, expect, it, beforeEach, afterEach, afterAll } from 'vitest';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/store/db.js';
import { PortalClient } from '../src/portal/client.js';
import { EnergyService } from '../src/domain/energyService.js';
import { IndexService } from '../src/domain/indexService.js';
import { readFileSync } from 'node:fs';

const BASE = 'https://portal.test';
const exportFixture = JSON.parse(readFileSync('test/fixtures/export-trimmed.json', 'utf8'));

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(BASE);
  pool
    .intercept({ path: /\/login$/, method: 'POST' })
    .reply(200, { type: 'redirect' }, { headers: { 'set-cookie': '__Secure-better-auth.session_token=SESS; Path=/' } })
    .persist();
  pool
    .intercept({ path: '/portal/keys' })
    .reply(200, { data: { signingSecret: 'topsecret' } })
    .persist();
  pool
    .intercept({ path: '/portal/export?page=1', method: 'GET' })
    .reply(200, exportFixture)
    .persist();
  pool
    .intercept({ path: '/portal/dts?page=1', method: 'GET' })
    .reply(
      200,
      {
        data: [
          { code: 'DT-001', name: 'Malviya Nagar DT 1', feederCode: 'F-001', capacityKva: 100 },
          { code: 'DT-007', name: 'Sanganer DT 7', feederCode: 'F-007', capacityKva: 63 }
        ],
        total: 2
      }
    )
    .persist();
  pool
    .intercept({ path: /^\/portal\/meters\/J100089\/energy/, method: 'GET' })
    .reply(200, JSON.parse(readFileSync('test/fixtures/energy-j100089.json', 'utf8')))
    .persist();
  pool
    .intercept({ path: /^\/portal\/meters\/J100001\/energy/, method: 'GET' })
    .reply(200, {
      data: [
        { timestamp: '01/06/2026 00:00', kwh: '100.00', kvah: '110.00', voltR: '230' },
        { timestamp: '01/06/2026 00:30', kwh: '100.42', kvah: '110.50', voltR: '231' },
        { timestamp: '01/06/2026 01:00', kwh: '100.84', kvah: '111.00', voltR: '229' }
      ]
    })
    .persist();
});
afterEach(() => agent.close());
afterAll(() => undefined);

type AppHandles = Awaited<ReturnType<typeof buildTestApp>>;

async function buildTestApp() {
  const config = loadConfig({
    apiToken: 'test-token',
    ttl: { indexSeconds: 60, energySeconds: 60, signingSecretSeconds: 60 },
    paths: { db: ':memory:' },
    portal: {
      baseUrl: BASE,
      email: 'x',
      password: 'y',
      minRequestIntervalMs: 0,
      timeoutMs: 5000,
      cooldownMs: 5,
      requestRetries: 1
    }
  } as never);
  const db = openDatabase(':memory:');
  const portal = new PortalClient(config.portal, { fetchImpl: ((url, init) => undiciFetch(url as never, { ...init, dispatcher: agent })) as unknown as typeof fetch });
  const energy = new EnergyService(db, portal, config);
  const index = new IndexService(db, portal, config);
  const app = await buildApp({ config, services: { portal, energy, index, db } });
  await app.ready();
  return { app, config };
}

const json = (r: { payload: unknown; statusCode: number }) => ({ status: r.statusCode, body: r.payload as object });

async function get(a: AppHandles, path: string, withAuth = true) {
  const r = await a.app.inject({
    method: 'GET',
    url: path,
    headers: withAuth ? { authorization: 'Bearer test-token' } : {}
  });
  let body: unknown;
  try {
    body = JSON.parse(r.body) as unknown;
  } catch {
    body = { parse_error: r.body };
  }
  if (r.statusCode >= 400) {
    console.error('HTTP', r.statusCode, path, r.body.slice(0, 400));
  }
  return { status: r.statusCode, body: body as object };
}

describe('API e2e (portal fully mocked)', () => {
  it('rejects unauthenticated /v1 calls but leaves /health open', async () => {
    const a = await buildTestApp();
    expect((await get(a, '/v1/meters', false)).status).toBe(401);
    expect((await get(a, '/health', false)).status).toBe(200);
  });

  it('lists meters with filters and pagination meta', async () => {
    const a = await buildTestApp();
    const r = await get(a, '/v1/meters?status=Decommissioned&limit=2&offset=1');
    expect(r.status).toBe(200);
    const body = r.body as { data: unknown[]; pagination: { total: number; limit: number; offset: number } };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.pagination).toEqual({ total: expect.any(Number), limit: 2, offset: 1 });
  });

  it('returns variable filters from the export (phase, build, dt)', async () => {
    const a = await buildTestApp();
    const r = (await get(a, '/v1/meters?dt=DT-007')) as { body: { data: Array<{ dt_code: string }> ; pagination: { total: number } } };
    expect(r.body.data.every((m) => m.dt_code === 'DT-007')).toBe(true);
    expect(r.body.pagination.total).toBeGreaterThan(0);
  });

  it('serves meter detail with hierarchy and geo', async () => {
    const a = await buildTestApp();
    const r = await get(a, '/v1/meters/J100001');
    expect(r.status).toBe(200);
    const body = r.body as { hierarchy: Array<{ level: string; code: string }>; geo: { latitude: number } };
    expect(body.hierarchy.map((h) => h.level)).toEqual([
      'zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'
    ]);
    expect(body.geo?.latitude).toBeCloseTo(26.822136543835608, 6);
  });

  it('returns 404 with the error envelope for unknown meters', async () => {
    const a = await buildTestApp();
    const r = await get(a, '/v1/meters/J999999/energy');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not_found', message: expect.any(String) });
  });

  it('serves energy with consumption deltas and populates the cache', async () => {
    const a = await buildTestApp();
    const first = (await get(a, '/v1/meters/J100001/energy')) as { body: Record<string, unknown> };
    expect(first.status).toBe(200);
    const series1 = first.body as {
      meter_id: string; interval_minutes: number | null; cache: { served_from: string };
      points: Array<{ timestamp: string; consumption_kWh: number | null }>;
    };
    expect(series1.meter_id).toBe('J100001');
    expect(series1.points[0]!.timestamp).toBe('2026-06-01T00:00:00.000+05:30');
    expect(series1.points.map((p) => p.consumption_kWh)).toEqual([null, 0.42, 0.42]);
    expect(series1.cache.served_from).toBe('portal');

    const second = (await get(a, '/v1/meters/J100001/energy')) as { body: { cache: { served_from: string } } };
    expect(second.body.cache.served_from).toBe('cache');
  });

  it('finds meters near a coordinate', async () => {
    const a = await buildTestApp();
    // J100001 sits at 26.8221, 75.9072; its nearest fixture neighbour is ~4.7 km away
    const r = (await get(a, '/v1/meters/nearby?latitude=26.822136543835608&longitude=75.90718190602279&radius_m=5000')) as {
      body: { data: Array<{ meter_id: string; distance_m: number }> };
    };
    expect(r.body.data[0]?.meter_id).toBe('J100001');
    expect(r.body.data[0]?.distance_m).toBe(0);
    expect(r.body.data.some((x) => x.distance_m > 0 && x.distance_m <= 5000)).toBe(true);
  });

  it('serves the network tree with zones at the root and DTs nested', async () => {
    const a = await buildTestApp();
    const r = (await get(a, '/v1/network/tree')) as {
      body: {
        data: Array<{ level: string; code: string; unresolved_parents?: number; children: unknown[] }>;
        meta: { conflicts: number };
      };
    };
    expect(r.status).toBe(200);
    expect(r.body.data.some((n) => n.level === 'zone')).toBe(true);
    // Nodes whose parent link cannot be resolved from any meter chain (only one
    // DT-005 meter exists here, with a blank feeder code) stay top-level, flagged.
    const dt5 = r.body.data.find((n) => n.code === 'DT-005');
    if (dt5) {
      expect(dt5.level).toBe('dt');
      expect(dt5.unresolved_parents).toBeGreaterThan(0);
    }
    // DT-007's parent feeder resolves fine and must be nested (find recursively).
    const find = (nodes: Array<{ code: string; children: Array<never> }>): boolean =>
      nodes.some((n) => n.code === 'DT-007' || find(n.children as never));
    expect(find(r.body.data as never)).toBe(true);
    expect(typeof r.body.meta.conflicts).toBe('number');
  });

  it('lists transformers with meter counts', async () => {
    const a = await buildTestApp();
    const r = (await get(a, '/v1/network/transformers')) as {
      body: { data: Array<{ code: string; meter_count: number }>; total: number };
    };
    expect(r.body.total).toBe(2);
    const dt7 = r.body.data.find((t) => t.code === 'DT-007')!;
    expect(dt7.meter_count).toBeGreaterThan(0);
  });

  it('flags degraded quality data (J100089 malformed rows surface honestly)', async () => {
    const a = await buildTestApp();
    const r = (await get(a, '/v1/meters/J100089/energy')) as {
      body: { data_quality: { malformed_rows: number; duplicate_timestamps: number }; interval_minutes: number | null };
    };
    const dq = r.body.data_quality as { malformed_rows: number; duplicate_timestamps: number };
    expect(dq.malformed_rows + dq.duplicate_timestamps).toBeGreaterThan(0);
  });
});
