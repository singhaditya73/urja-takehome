import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { PortalClient, parseSessionCookie, PortalNotFound } from '../src/portal/client.js';
import { signRequest } from '../src/portal/sign.js';
import type { AppConfig } from '../src/config.js';

const BASE = 'https://portal.test';

function portalConfig(overrides: Partial<AppConfig['portal']> = {}): AppConfig['portal'] {
  return {
    baseUrl: BASE,
    email: 'operator@urja.local',
    password: 'pw',
    minRequestIntervalMs: 0,
    timeoutMs: 5000,
    cooldownMs: 10,
    requestRetries: 2,
    ...overrides
  };
}

let agent: MockAgent;
const sleepSpy =
  () => undefined;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
});
afterEach(() => {
  agent.close();
});

function testFetch(): typeof fetch {
  return ((url: string | URL, init?: RequestInit) =>
    undiciFetch(url as never, { ...(init as object), dispatcher: agent })) as unknown as typeof fetch;
}

describe('parseSessionCookie', () => {
  it('extracts the better-auth session cookie', () => {
    expect(
      parseSessionCookie(
        '__Secure-better-auth.session_token=abc.123; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax'
      )
    ).toBe('__Secure-better-auth.session_token=abc.123');
  });
  it('ignores foreign cookies', () => {
    expect(parseSessionCookie('other=xyz; Path=/')).toBeNull();
  });
});

function mockPortal() {
  const pool = agent.get(BASE);
  pool
    .intercept({ path: /\/login$/, method: 'POST' })
    .reply(200, { type: 'redirect', status: 303, location: '/meters' }, { headers: { 'set-cookie': '__Secure-better-auth.session_token=SESS; Path=/' } })
    .persist();

  pool
    .intercept({ path: '/portal/keys' })
    .reply(200, { data: { signingSecret: 'topsecret' } })
    .persist();
  return pool;
}

describe('PortalClient', () => {
  it('logs in and carries the session cookie on subsequent calls', async () => {
    const pool = mockPortal();
    let sawCookie: string | undefined;
    pool
      .intercept({ path: /^\/portal\/meters\/search\?/, method: 'GET' })
      .reply(200, (opts) => {
        sawCookie = String(opts.headers?.cookie ?? opts.headers?.Cookie ?? '');
        return { data: [], total: 0, page: 1, pageSize: 20 };
      });

    const client = new PortalClient(portalConfig(), { fetchImpl: testFetch(), sleep: sleepSpy });
    await client.searchMeters('', 1);
    expect(sawCookie).toContain('__Secure-better-auth.session_token=SESS');
  });

  it('re-authenticates once when the portal says 401', async () => {
    const pool = mockPortal();
    pool
      .intercept({ path: /^\/portal\/meters\/J1\/energy/, method: 'GET' })
      .reply(401, { error: 'unauthorized' })
      .times(1);
    pool
      .intercept({ path: /^\/portal\/meters\/J1\/energy/, method: 'GET' })
      .reply(200, { data: [{ timestamp: '01/06/2026 00:00', kwh: '1', kvah: '1', voltR: '230' }] })
      .times(1);

    const client = new PortalClient(portalConfig(), { fetchImpl: testFetch(), sleep: sleepSpy });
    await expect(client.getEnergy('J1', '2026-06-01')).resolves.toEqual([
      { timestamp: '01/06/2026 00:00', kwh: '1', kvah: '1', voltR: '230' }
    ]);
  });

  it('backs off on 429 and retries', async () => {
    const pool = mockPortal();
    pool
      .intercept({ path: /^\/portal\/meters\/J1\/energy/, method: 'GET' })
      .reply(429, { error: 'rate_limited' })
      .times(1);
    pool.intercept({ path: /^\/portal\/meters\/J1\/energy/, method: 'GET' }).reply(200, { data: [] });

    const sleeps: number[] = [];
    const client = new PortalClient(portalConfig({ cooldownMs: 42 }), {
      fetchImpl: testFetch(),
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });
    await expect(client.getEnergy('J1')).resolves.toEqual([]);
    expect(sleeps).toContain(42);
  });

  it('maps unknown meters to PortalNotFound', async () => {
    const pool = mockPortal();
    pool
      .intercept({ path: /^\/portal\/meters\/NOPE\/energy/, method: 'GET' })
      .reply(404, { error: 'not_found', message: 'Meter not found' })
      .persist();
    const client = new PortalClient(portalConfig(), { fetchImpl: testFetch(), sleep: sleepSpy });
    await expect(client.getEnergy('NOPE')).rejects.toBeInstanceOf(PortalNotFound);
  });

  it('signs the export request like the portal expects', async () => {
    const pool = mockPortal();
    let signature: string | undefined;
    pool
      .intercept({ path: '/portal/export?page=1', method: 'GET' })
      .reply(200, (opts) => {
        signature = String(opts.headers?.['x-signature'] ?? opts.headers?.['X-Signature'] ?? '');
        return { data: [], total: 0 };
      });
    const client = new PortalClient(portalConfig(), { fetchImpl: testFetch(), sleep: sleepSpy });
    const payload = await client.getExport();
    expect(payload.total).toBe(0);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});
