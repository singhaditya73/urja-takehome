import type { AppConfig } from '../config.js';
import { signRequest } from './sign.js';
import type {
  DtPage,
  ExportPayload,
  MeterSearchItem,
  RawEnergyPoint,
  RawGeo,
  SearchPage,
  SigningSecret
} from './types.js';

export class PortalError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string = 'portal_error'
  ) {
    super(message);
  }
}

export class PortalRateLimited extends PortalError {
  constructor(public readonly retryAfterMs: number | null) {
    super('Portal is rate limiting requests', 429, 'portal_rate_limited');
  }
}

export class PortalNotFound extends PortalError {
  constructor(resource: string) {
    super(resource, 404, 'not_found');
  }
}

export class PortalAuthError extends PortalError {
  constructor(message = 'Portal rejected our credentials') {
    super(message, 401, 'portal_auth_error');
  }
}

export interface PortalClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long the signing secret from /portal/keys is trusted. */
  secretTtlMs?: number;
}

const SESSION_COOKIE = '__Secure-better-auth.session_token';

export function parseSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const first = setCookieHeader.split(', ')[0] ?? '';
  const [pair] = first.split(';');
  if (!pair) return null;
  const [name, value] = pair.split('=');
  if (name?.trim() !== SESSION_COOKIE || !value) return null;
  return `${name}=${value}`;
}

/**
 * Client for the Urja Meter Ops portal. Knows about:
 *  - form login (needs an Origin header or the site rejects it as CSRF)
 *  - the session cookie it hands back, re-authenticating transparently once
 *  - the HMAC request signing scheme used by /portal/export (see portal/sign.ts)
 *  - the ~120 req/min rate limit: we pace ourselves, and back off on 429.
 */
export class PortalClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secretTtlMs: number;
  private sessionCookie: string | null = null;
  private secret: string | null = null;
  private secretFetchedAt = 0;
  private nextAllowedRequestAt = 0;

  constructor(private readonly config: AppConfig['portal'], options: PortalClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.secretTtlMs = options.secretTtlMs ?? 3_600_000;
  }

  // ---------------------------------------------------------------- infra

  /** Pacing + backoff + session renewal around every portal request. */
  private async request(
    path: string,
    init: { method?: string; query?: string; headers?: Record<string, string> } = {},
    { canRelogin = true, retriesLeft }: { canRelogin?: boolean; retriesLeft?: number } = {}
  ): Promise<Response> {
    const method = init.method ?? 'GET';
    // Keep our request rate under the portal's limit even under concurrency.
    if (this.nextAllowedRequestAt > this.now()) {
      await this.sleep(this.nextAllowedRequestAt - this.now());
    }
    this.nextAllowedRequestAt = this.now() + this.config.minRequestIntervalMs;

    const query = init.query ?? '';
    const url = `${this.config.baseUrl}${path}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = { ...init.headers };
    if (this.sessionCookie) headers['Cookie'] = this.sessionCookie;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'manual'
      });
    } catch (err) {
      throw new PortalError(`Portal request failed: ${(err as Error).message}`, 502, 'portal_unreachable');
    }

    if (res.status === 429 && retriesLeft === undefined) {
      retriesLeft = this.config.requestRetries;
    }
    if (res.status === 429 && retriesLeft !== undefined && retriesLeft > 0) {
      await this.sleep(this.config.cooldownMs);
      return this.request(path, init, { canRelogin, retriesLeft: retriesLeft - 1 });
    }
    if (res.status === 401 && canRelogin) {
      this.sessionCookie = null;
      await this.ensureLogin();
      return this.request(path, init, { canRelogin: false, retriesLeft });
    }
    return res;
  }

  private async ensureLogin(): Promise<void> {
    if (this.sessionCookie) return;
    const res = await this.rawLogin();
    const cookie = parseSessionCookie(res.headers.get('set-cookie'));
    if (!cookie) {
      throw new PortalAuthError('Portal did not return a session cookie');
    }
    this.sessionCookie = cookie;
  }

  private async rawLogin(): Promise<Response> {
    const body = new URLSearchParams({ email: this.config.email, password: this.config.password });
    try {
      return await this.fetchImpl(`${this.config.baseUrl}/login`, {
        method: 'POST',
        headers: {
          'Origin': this.config.baseUrl,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      });
    } catch (err) {
      throw new PortalError(`Portal login failed: ${(err as Error).message}`, 502, 'portal_unreachable');
    }
  }

  private async json(res: Response, path: string): Promise<unknown> {
    if (res.status === 404) {
      throw new PortalNotFound(path);
    }
    if (res.status === 401) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new PortalAuthError(payload?.error ?? 'Portal rejected our request');
    }
    if (!res.ok) {
      throw new PortalError(`Portal returned ${res.status} for ${path}`, res.status, 'portal_error');
    }
    return res.json();
  }

  // ------------------------------------------------------------- endpoints

  async searchMeters(query: string, page: number): Promise<SearchPage> {
    await this.ensureLogin();
    const qs = new URLSearchParams({ q: query, page: String(page) }).toString();
    const res = await this.request('/portal/meters/search', { query: qs });
    return (await this.json(res, '/portal/meters/search')) as SearchPage;
  }

  async getEnergy(meterId: string, from?: string, to?: string): Promise<RawEnergyPoint[]> {
    await this.ensureLogin();
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const res = await this.request(`/portal/meters/${encodeURIComponent(meterId)}/energy`, {
      query: qs.toString()
    });
    return ((await this.json(res, 'energy')) as { data: RawEnergyPoint[] }).data;
  }

  async getGeo(meterId: string): Promise<RawGeo> {
    await this.ensureLogin();
    const res = await this.request(`/portal/meters/${encodeURIComponent(meterId)}/geo`);
    return ((await this.json(res, 'geo')) as { data: RawGeo }).data;
  }

  async getTransformers(page: number): Promise<DtPage> {
    await this.ensureLogin();
    const res = await this.request('/portal/dts', { query: new URLSearchParams({ page: String(page) }).toString() });
    return (await this.json(res, '/portal/dts')) as DtPage;
  }

  /**
   * The signing secret is handed out by the portal itself at /portal/keys to any
   * authenticated user (a deliberate, if unusual, bulk-access design). We cache
   * it briefly and refetch whenever a signature is rejected.
   */
  async getSigningSecret(): Promise<string> {
    if (this.secret && this.now() - this.secretFetchedAt < this.secretTtlMs) {
      return this.secret;
    }
    await this.ensureLogin();
    const res = await this.request('/portal/keys');
    const payload = (await this.json(res, '/portal/keys')) as { data: SigningSecret };
    this.secret = payload.data.signingSecret;
    this.secretFetchedAt = this.now();
    return this.secret;
  }

  async invalidateSigningSecret(): Promise<void> {
    this.secret = null;
    this.secretFetchedAt = 0;
  }

  /** Full export (~403 meters with hierarchy + geo). Signs the request. */
  async getExport(): Promise<ExportPayload> {
    const path = '/portal/export';
    const query = 'page=1';
    await this.ensureLogin();
    let res = await this.request(path, { query, headers: await this.exportHeaders(path, query) });
    if (res.status === 401) {
      // Secret may have rotated server-side; refetch and retry exactly once.
      await this.invalidateSigningSecret();
      res = await this.request(path, { query, headers: await this.exportHeaders(path, query) }, { canRelogin: false });
    }
    return (await this.json(res, path)) as ExportPayload;
  }

  private async exportHeaders(path: string, query: string): Promise<Record<string, string>> {
    const secret = await this.getSigningSecret();
    const ts = Math.floor(this.now() / 1000);
    return {
      'x-timestamp': String(ts),
      'x-signature': signRequest('GET', path, query, ts, secret)
    };
  }
}

export interface SignedFetchResult {
  status: number;
  headers: Headers;
}

export { SESSION_COOKIE };
