import 'dotenv/config';

function envString(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export interface AppConfig {
  port: number;
  host: string;
  /** Bearer token callers must present on /v1/* endpoints. */
  apiToken: string;
  portal: {
    baseUrl: string;
    email: string;
    password: string;
    /** Min time between portal requests (ms). The portal allows ~120 req/min
     *  before it starts answering 429; we keep comfortably below that. */
    minRequestIntervalMs: number;
    /** Per-request timeouts (ms). */
    timeoutMs: number;
    /** Full-portal cooldown after a 429, per portal observed behavior (~45-60s). */
    cooldownMs: number;
    requestRetries: number;
  };
  paths: {
    db: string;
  };
  ttl: {
    /** How long the local meter index (from /portal/export) stays fresh. */
    indexSeconds: number;
    /** How long a fetched energy series is served from cache. */
    energySeconds: number;
    /** How long the portal signing secret is trusted. */
    signingSecretSeconds: number;
  };
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    port: envInt('PORT', 8000),
    host: envString('HOST', '127.0.0.1'),
    apiToken: envString('API_TOKEN', 'dev-token-change-me'),
    portal: {
      baseUrl: envString('PORTAL_BASE_URL', 'https://urja-ops.flockenergy.tech'),
      email: envString('PORTAL_EMAIL', 'operator@urja.local'),
      password: envString('PORTAL_PASSWORD', ''),
      minRequestIntervalMs: envInt('PORTAL_MIN_REQUEST_INTERVAL_MS', 550),
      timeoutMs: envInt('PORTAL_TIMEOUT_MS', 15000),
      cooldownMs: envInt('PORTAL_COOLDOWN_MS', 60_000),
      requestRetries: envInt('PORTAL_REQUEST_RETRIES', 3)
    },
    paths: {
      db: envString('DB_PATH', 'data/urja.db')
    },
    ttl: {
      indexSeconds: envInt('INDEX_TTL_SECONDS', 600),
      energySeconds: envInt('ENERGY_TTL_SECONDS', 300),
      signingSecretSeconds: envInt('SIGNING_SECRET_TTL_SECONDS', 3600)
    }
  };
  return {
    ...base,
    portal: { ...base.portal, ...overrides.portal },
    paths: { ...base.paths, ...overrides.paths },
    ttl: { ...base.ttl, ...overrides.ttl },
    ...overrides
  };
}
