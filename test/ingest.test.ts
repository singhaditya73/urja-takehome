import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/store/db.js';
import { ingestExport } from '../src/store/ingest.js';
import { buildHierarchy, type MeterChain } from '../src/domain/hierarchy.js';
import type { ExportPayload } from '../src/portal/types.js';

const fixture: ExportPayload = JSON.parse(
  readFileSync('test/fixtures/export-trimmed.json', 'utf8')
) as ExportPayload;

describe('ingestExport', () => {
  it('indexes meters with flattened hierarchy', () => {
    const db = openDatabase(':memory:');
    const result = ingestExport(db, fixture, [
      { code: 'DT-001', name: 'Malviya Nagar DT 1', feederCode: 'F-001', capacityKva: 100 },
      { code: 'DT-007', name: 'Sanganer DT 7', feederCode: 'F-007', capacityKva: 63 }
    ]);
    expect(result.meters).toBe(12);
    const m = db.prepare('SELECT * FROM meters WHERE meter_id = ?').get('J100001') as Record<string, unknown>;
    expect(m).toMatchObject({
      meter_id: 'J100001',
      make: 'L&T',
      install_status: 'Installed',
      build: 'legacy',
      dt_code: 'DT-002',
      zone_code: 'Z-02',
      feeder_code: 'F-002',
      dt_name: 'Mansarovar DT 2'
    });
    // Re-running the ingest is idempotent (upsert, not duplicate).
    const again = ingestExport(db, fixture, []);
    expect(again.meters).toBe(12);
    expect((db.prepare('SELECT COUNT(*) c FROM meters').get() as { c: number }).c).toBe(12);
  });
});

describe('hierarchy reconstruction', () => {
  const chains: MeterChain[] = fixture.data.map((m) => (m.hierarchy ?? {}) as MeterChain);

  const { nodes, conflicts } = buildHierarchy(chains);

  it('resolves majority names per code', () => {
    const dt7 = nodes.find((n) => n.level === 'dt' && n.code === 'DT-007')!;
    // Four meters call it Sanganer DT 7; three legacy meters call it
    // "Old Malviya Nagar Xfmr". Majority wins, disagreement is surfaced.
    expect(dt7.name).toBe('Sanganer DT 7');
    expect(dt7.name_variants).toContain('Old Malviya Nagar Xfmr');
  });

  it('never misplaces nodes under blank intermediate levels', () => {
    // J100044's chain has feeder code "" — its DT must stay unresolved, not be
    // re-parented to a substation two levels up.
    const dt5 = nodes.find((n) => n.level === 'dt' && n.code === 'DT-005')!;
    expect(dt5.parent_code).not.toBe('SS-05');
    expect(dt5.unresolved_parents).toBeGreaterThan(0);
  });

  it('counts conflicts for review', () => {
    expect(conflicts).toBeGreaterThan(0);
  });

  it('exposes every DT from the meter chains', () => {
    const codes = nodes.filter((n) => n.level === 'dt').map((n) => n.code);
    expect(codes).toContain('DT-002');
    expect(codes).toContain('DT-007');
  });
});
