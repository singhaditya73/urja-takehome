import type Database from 'better-sqlite3';
import type { DistributionTransformer, ExportPayload, ExportMeter } from '../portal/types.js';
import { buildHierarchy, type MeterChain, type ResolvedNode } from '../domain/hierarchy.js';
import { setMeta, getMeta } from './db.js';

const INDEX_FETCHED_AT = 'index_fetched_at';

export interface IngestResult {
  meters: number;
  transformers: number;
  hierarchyNodes: number;
  hierarchyConflicts: number;
}

export function ingestExport(db: Database.Database, payload: ExportPayload, dts: DistributionTransformer[]): IngestResult {
  const insertMeter = db.prepare(`
    INSERT INTO meters (
      meter_id, serial_no, make, phase_type, install_status, install_type, build, dt_code,
      lat, lng,
      zone_code, zone_name, circle_code, circle_name, division_code, division_name,
      subdivision_code, subdivision_name, substation_code, substation_name,
      feeder_code, feeder_name, dt_name, raw
    ) VALUES (
      @meter_id, @serial_no, @make, @phase_type, @install_status, @install_type, @build, @dt_code,
      @lat, @lng,
      @zone_code, @zone_name, @circle_code, @circle_name, @division_code, @division_name,
      @subdivision_code, @subdivision_name, @substation_code, @substation_name,
      @feeder_code, @feeder_name, @dt_name, @raw
    )
    ON CONFLICT(meter_id) DO UPDATE SET
      serial_no=excluded.serial_no, make=excluded.make, phase_type=excluded.phase_type,
      install_status=excluded.install_status, install_type=excluded.install_type,
      build=excluded.build, dt_code=excluded.dt_code, lat=excluded.lat, lng=excluded.lng,
      zone_code=excluded.zone_code, zone_name=excluded.zone_name,
      circle_code=excluded.circle_code, circle_name=excluded.circle_name,
      division_code=excluded.division_code, division_name=excluded.division_name,
      subdivision_code=excluded.subdivision_code, subdivision_name=excluded.subdivision_name,
      substation_code=excluded.substation_code, substation_name=excluded.substation_name,
      feeder_code=excluded.feeder_code, feeder_name=excluded.feeder_name,
      dt_name=excluded.dt_name, raw=excluded.raw
  `);

  const insertTransformer = db.prepare(`
    INSERT INTO transformers (code, name, feeder_code, capacity_kva)
    VALUES (@code, @name, @feeder_code, @capacity_kva)
    ON CONFLICT(code) DO UPDATE SET
      name=excluded.name, feeder_code=excluded.feeder_code, capacity_kva=excluded.capacity_kva
  `);

  const replaceNodes = db.prepare(`
    INSERT INTO hierarchy_nodes (level, code, name, parent_level, parent_code, parent_conflict, unresolved_parents, name_variants, meter_count)
    VALUES (@level, @code, @name, @parent_level, @parent_code, @parent_conflict, @unresolved_parents, @name_variants, @meter_count)
    ON CONFLICT(level, code) DO UPDATE SET
      name=excluded.name, parent_level=excluded.parent_level, parent_code=excluded.parent_code,
      parent_conflict=excluded.parent_conflict, unresolved_parents=excluded.unresolved_parents,
      name_variants=excluded.name_variants, meter_count=excluded.meter_count
  `);

  const flatMapped = payload.data.map(flatMeter);
  const { nodes, conflicts } = buildHierarchy(flatMapped.map((f) => f.chain));

  const tx = db.transaction(() => {
    db.exec('DELETE FROM hierarchy_nodes');
    for (const n of nodes) replaceNodes.run(toNodeRow(n));
    for (const m of flatMapped) insertMeter.run(m.row);
    for (const t of dts) {
      insertTransformer.run({
        code: t.code,
        name: t.name,
        feeder_code: t.feederCode,
        capacity_kva: t.capacityKva
      });
    }
    setMeta(db, INDEX_FETCHED_AT, String(Date.now()));
  });
  tx();

  return { meters: payload.data.length, transformers: dts.length, hierarchyNodes: nodes.length, hierarchyConflicts: conflicts };
}

export function indexAge(db: Database.Database): number | null {
  const v = getMeta(db, INDEX_FETCHED_AT);
  if (v === null) return null;
  return Date.now() - Number(v);
}

function flatMeter(m: ExportMeter): { row: unknown; chain: MeterChain } {
  const h = m.hierarchy ?? {};
  const pick = (lvl: string) => (h[lvl] ? { code: h[lvl].code, name: h[lvl].name } : undefined);
  return {
    chain: {
      zone: pick('zone'),
      circle: pick('circle'),
      division: pick('division'),
      subdivision: pick('subdivision'),
      substation: pick('substation'),
      feeder: pick('feeder'),
      dt: pick('dt')
    },
    row: {
      meter_id: m.meterId,
      serial_no: m.serialNo,
      make: m.make,
      phase_type: m.phaseType,
      install_status: m.installStatus,
      install_type: m.installType ?? null,
      build: m.build ?? null,
      dt_code: m.dtCode,
      lat: m.geo?.lat ?? null,
      lng: m.geo?.lng ?? null,
      zone_code: h.zone?.code || null,
      zone_name: h.zone?.name || null,
      circle_code: h.circle?.code || null,
      circle_name: h.circle?.name || null,
      division_code: h.division?.code || null,
      division_name: h.division?.name || null,
      subdivision_code: h.subdivision?.code || null,
      subdivision_name: h.subdivision?.name || null,
      substation_code: h.substation?.code || null,
      substation_name: h.substation?.name || null,
      feeder_code: h.feeder?.code || null,
      feeder_name: h.feeder?.name || null,
      dt_name: h.dt?.name || null,
      raw: JSON.stringify(m)
    }
  };
}

function toNodeRow(n: ResolvedNode) {
  return {
    level: n.level,
    code: n.code,
    name: n.name,
    parent_level: n.parent_level,
    parent_code: n.parent_code,
    parent_conflict: n.parent_conflict ? 1 : 0,
    unresolved_parents: n.unresolved_parents,
    name_variants: JSON.stringify(n.name_variants),
    meter_count: n.meter_count
  };
}
