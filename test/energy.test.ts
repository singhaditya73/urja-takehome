import { describe, expect, it } from 'vitest';
import { parsePortalTimestamp, normalizeEnergy, isoIst } from '../src/domain/energy.js';

describe('portal timestamp parsing', () => {
  it('treats day-first dates correctly (DD/MM/YYYY, IST)', () => {
    const d = parsePortalTimestamp('05/06/2026 07:30');
    expect(d).not.toBeNull();
    // Day-first: June 5th, not May 6th; in UTC that is 02:00Z the same day.
    expect(d!.toISOString()).toBe('2026-06-05T02:00:00.000Z');
    expect(isoIst(d!)).toBe('2026-06-05T07:30:00.000+05:30');  });

  it('rejects garbage', () => {
    expect(parsePortalTimestamp('garbage')).toBeNull();
    expect(parsePortalTimestamp('32/13/2026 99:99')).toBeNull();
  });
});

describe('normalizeEnergy', () => {
  const mk = (ts: string, kwh: string, kvah: string, voltR: string) => ({ timestamp: ts, kwh, kvah, voltR });

  it('computes consumption deltas and rounds them', () => {
    const { points, interval_minutes, data_quality } = normalizeEnergy([
      mk('01/06/2026 00:00', '100.00', '110.00', '230'),
      mk('01/06/2026 00:30', '100.42', '110.50', '231'),
      mk('01/06/2026 01:00', '100.84', '111.00', '229')
    ]);
    expect(data_quality.malformed_rows).toBe(0);
    expect(interval_minutes).toBe(30);
    expect(points.map((p) => p.consumption_kWh)).toEqual([null, 0.42, 0.42]);
    expect(points[0]!.timestamp).toBe('2026-06-01T00:00:00.000+05:30');
  });

  it('flags malformed rows instead of crashing (J100089 case)', () => {
    const { points, data_quality } = normalizeEnergy([
      mk('01/06/2026 00:00', '10', '12', '232'),
      mk('30/06/2026 00:00', '', '13750.93', '') // portal sent empty strings
    ]);
    expect(data_quality.malformed_rows).toBe(1);
    expect(points).toHaveLength(1);
  });

  it('drops true duplicate timestamps', () => {
    const { data_quality } = normalizeEnergy([
      mk('01/06/2026 00:00', '10', '12', '232'),
      mk('01/06/2026 00:00', '10', '12', '232')
    ]);
    expect(data_quality.duplicate_timestamps).toBe(1);
  });

  it('refuses to report negative consumption on regressed registers', () => {
    const { data_quality } = normalizeEnergy([
      mk('01/06/2026 00:00', '5000', '5000', '232'),
      mk('01/06/2026 00:30', '1000', '1001', '232') // meter battery swap/reset
    ]);
    expect(data_quality.regressed_readings).toBe(1);
  });

  it('reports irregular gaps for mixed-cadence meters', () => {
    const { interval_minutes, data_quality } = normalizeEnergy([
      mk('01/06/2026 00:00', '1', '1', '232'),
      mk('01/06/2026 00:30', '2', '2', '232'), // half-hourly...
      mk('01/06/2026 01:00', '3', '3', '232'),
      mk('02/06/2026 00:00', '9', '9', '232') // ...then a daily jump
    ]);
    expect(interval_minutes).toBe(30);
    expect(data_quality.irregular_gaps).toBe(1);
  });
});
