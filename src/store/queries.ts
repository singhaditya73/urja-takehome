import type Database from 'better-sqlite3';
import type { MeterRow, HierarchyNodeRow, TransformerRow, EnergyCacheRow } from './db.js';

export interface MeterFilters {
  q?: string;
  status?: string;
  phase?: string;
  make?: string;
  build?: string;
  installType?: string;
  dt?: string;
  feeder?: string;
  zone?: string;
  circle?: string;
  division?: string;
  subdivision?: string;
  substation?: string;
}

const HIERARCHY_CODE_COLUMNS: Record<string, string> = {
  zone: 'zone_code',
  circle: 'circle_code',
  division: 'division_code',
  subdivision: 'subdivision_code',
  substation: 'substation_code',
  feeder: 'feeder_code',
  dt: 'dt_code'
};

export function listMeters(
  db: Database.Database,
  filters: MeterFilters,
  limit: number,
  offset: number
): { rows: MeterRow[]; total: number } {
  const clauses: string[] = [];
  const params: Record<string, string> = {};

  if (filters.q) {
    clauses.push('(meter_id LIKE @q OR serial_no LIKE @q)');
    params.q = `%${filters.q}%`;
  }
  if (filters.status) {
    clauses.push('install_status = @status');
    params.status = filters.status;
  }
  if (filters.phase) {
    clauses.push('phase_type = @phase');
    params.phase = filters.phase;
  }
  if (filters.make) {
    clauses.push('make = @make');
    params.make = filters.make;
  }
  if (filters.build) {
    clauses.push('build = @build');
    params.build = filters.build;
  }
  if (filters.installType) {
    clauses.push('install_type = @installType');
    params.installType = filters.installType;
  }
  if (filters.dt) {
    clauses.push('dt_code = @dt');
    params.dt = filters.dt;
  }
  for (const [level, col] of Object.entries(HIERARCHY_CODE_COLUMNS)) {
    if (level === 'dt') continue;
    const value = (filters as Record<string, string | undefined>)[level];
    if (value) {
      clauses.push(`${col} = @${level}`);
      params[level] = value;
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS t FROM meters ${where}`).get(params) as { t: number }
  ).t;
  const rows = db
    .prepare(`SELECT * FROM meters ${where} ORDER BY meter_id LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset }) as MeterRow[];
  return { rows, total };
}

export function getMeter(db: Database.Database, meterId: string): MeterRow | undefined {
  return db.prepare('SELECT * FROM meters WHERE meter_id = ?').get(meterId) as MeterRow | undefined;
}

const EARTH_RADIUS_M = 6_371_008.8;

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function metersNear(
  db: Database.Database,
  lat: number,
  lng: number,
  radiusM: number,
  limit: number,
  offset: number
): { items: Array<{ row: MeterRow; distance_m: number }>; total: number } {
  // 403 rows fits in memory fine; at district scale (10^5+) we would filter
  // with a bounding box + spatial index instead. See README notes.
  const rows = db
    .prepare('SELECT * FROM meters WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY meter_id')
    .all() as MeterRow[];

  type WithDist = { row: MeterRow; distance_m: number };
  const withDist: WithDist[] = [];
  for (const row of rows) {
    const dist = haversineMeters(lat, lng, row.lat as number, row.lng as number);
    if (dist <= radiusM) {
      withDist.push({ row, distance_m: dist });
    }
  }
  withDist.sort((a, b) => a.distance_m - b.distance_m);
  const total = withDist.length;
  const items = withDist.slice(offset, offset + limit).map((x) => ({ row: x.row, distance_m: Math.round(x.distance_m) }));
  return { items, total };
}

export function allHierarchyNodes(db: Database.Database): HierarchyNodeRow[] {
  return db.prepare('SELECT * FROM hierarchy_nodes').all() as HierarchyNodeRow[];
}

export function listTransformers(db: Database.Database): TransformerRow[] {
  return db.prepare('SELECT * FROM transformers ORDER BY code').all() as TransformerRow[];
}

export function transformerMetersCounts(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare('SELECT dt_code, COUNT(*) AS n FROM meters GROUP BY dt_code')
    .all() as { dt_code: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.dt_code, r.n]));
}

export function getEnergyCache(db: Database.Database, cacheKey: string): EnergyCacheRow | undefined {
  return db.prepare('SELECT * FROM energy_cache WHERE cache_key = ?').get(cacheKey) as EnergyCacheRow | undefined;
}

export function putEnergyCache(
  db: Database.Database,
  cacheKey: string,
  payload: string,
  now: number
): void {
  db.prepare(
    `INSERT INTO energy_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).run(cacheKey, payload, now);
}
