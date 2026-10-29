import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MeterRow {
  meter_id: string;
  serial_no: string;
  make: string;
  phase_type: string;
  install_status: string;
  install_type: string | null;
  build: string | null;
  dt_code: string;
  lat: number | null;
  lng: number | null;
  zone_code: string | null;
  circle_code: string | null;
  division_code: string | null;
  subdivision_code: string | null;
  substation_code: string | null;
  feeder_code: string | null;
  zone_name: string | null;
  circle_name: string | null;
  division_name: string | null;
  subdivision_name: string | null;
  substation_name: string | null;
  feeder_name: string | null;
  dt_name: string | null;
  raw: string;
}

export interface HierarchyNodeRow {
  level: string;
  code: string;
  name: string;
  parent_level: string | null;
  parent_code: string | null;
  parent_conflict: number;
  unresolved_parents: number;
  name_variants: string; // JSON array
  meter_count: number;
}

export interface TransformerRow {
  code: string;
  name: string;
  feeder_code: string;
  capacity_kva: number;
}

export interface EnergyCacheRow {
  cache_key: string;
  payload: string;
  fetched_at: number;
}

export type Db = Database.Database;

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  createSchema(db);
  return db;
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meters (
      meter_id TEXT PRIMARY KEY,
      serial_no TEXT NOT NULL,
      make TEXT NOT NULL,
      phase_type TEXT NOT NULL,
      install_status TEXT NOT NULL,
      install_type TEXT,
      build TEXT,
      dt_code TEXT NOT NULL,
      lat REAL,
      lng REAL,
      zone_code TEXT, zone_name TEXT,
      circle_code TEXT, circle_name TEXT,
      division_code TEXT, division_name TEXT,
      subdivision_code TEXT, subdivision_name TEXT,
      substation_code TEXT, substation_name TEXT,
      feeder_code TEXT, feeder_name TEXT,
      dt_name TEXT,
      raw TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meters_dt ON meters(dt_code);
    CREATE INDEX IF NOT EXISTS idx_meters_feeder ON meters(feeder_code);
    CREATE INDEX IF NOT EXISTS idx_meters_zone ON meters(zone_code);
    CREATE INDEX IF NOT EXISTS idx_meters_circle ON meters(circle_code);
    CREATE INDEX IF NOT EXISTS idx_meters_division ON meters(division_code);
    CREATE INDEX IF NOT EXISTS idx_meters_subdivision ON meters(subdivision_code);
    CREATE INDEX IF NOT EXISTS idx_meters_substation ON meters(substation_code);
    CREATE INDEX IF NOT EXISTS idx_meters_status ON meters(install_status);

    CREATE TABLE IF NOT EXISTS transformers (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      feeder_code TEXT NOT NULL,
      capacity_kva REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hierarchy_nodes (
      level TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_level TEXT,
      parent_code TEXT,
      parent_conflict INTEGER NOT NULL DEFAULT 0,
      unresolved_parents INTEGER NOT NULL DEFAULT 0,
      name_variants TEXT NOT NULL DEFAULT '[]',
      meter_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (level, code)
    );

    CREATE TABLE IF NOT EXISTS energy_cache (
      cache_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
