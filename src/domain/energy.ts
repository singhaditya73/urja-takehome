import type { RawEnergyPoint } from '../portal/types.js';

export interface EnergyPoint {
  /** Interval start, ISO 8601 with the assumed IST offset of the source data. */
  timestamp: string;
  /** Cumulative kVAh / active-energy register readings. Null when the portal row was malformed. */
  kWh: number | null;
  kVAh: number | null;
  voltR: number | null;
  /** Consumption in kWh between the previous point and this one. Null when it cannot be derived. */
  consumption_kWh: number | null;
}

export interface DataQuality {
  malformed_rows: number;
  duplicate_timestamps: number;
  regressed_readings: number; // kWh went backwards — physically dubious, delta nulled
  irregular_gaps: number; // series skips intervals (missing data)
}

export interface NormalizedEnergy {
  points: EnergyPoint[];
  interval_minutes: number | null;
  data_quality: DataQuality;
}

/**
 * The portal timestamps readings as "DD/MM/YYYY HH:mm" strings with no
 * timezone marker. India's portals run on IST; we normalize with a fixed
 * +05:30 offset. Parsing day-first explicitly avoids JS's slash-date parsing
 * treating "01/06" as January 6th.
 */
export function parsePortalTimestamp(ts: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(ts);
  if (!m) return null;
  const [, day, month, year, hh, mm] = m as unknown as [string, string, string, string, string, string];
  const date = new Date(`${year}-${month}-${day}T${hh}:${mm}:00+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isoIst(date: Date): string {
  // Present the value in IST wall-clock terms. toISOString only speaks UTC,
  // so shift by +05:30, render, then drop the Z and attach the IST offset.
  const shifted = new Date(date.getTime() + 5.5 * 3_600_000);
  return shifted.toISOString().slice(0, 23) + '+05:30';
}

function parseFloatOr(v: string | undefined): number | null {
  if (v === undefined) return null;
  const f = Number(v);
  return v.toString().trim() === '' || Number.isNaN(f) ? null : f;
}

export function normalizeEnergy(raw: RawEnergyPoint[]): NormalizedEnergy {
  const quality: DataQuality = { malformed_rows: 0, duplicate_timestamps: 0, regressed_readings: 0, irregular_gaps: 0 };

  type Parsed = { date: Date; kWh: number; kVAh: number; voltR: number };
  const parsed: Parsed[] = [];  for (const point of raw) {
    const date = parsePortalTimestamp(point.timestamp);
    const kWh = parseFloatOr(point.kwh);
    const kVAh = parseFloatOr(point.kvah);
    const voltR = parseFloatOr(point.voltR);
    if (!date || kWh === null || kVAh === null || voltR === null) {
      quality.malformed_rows += 1;
      continue; // J100089-style rows (empty kwh/voltR) are unusable
    }
    parsed.push({ date, kWh, kVAh, voltR });
  }
  parsed.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Drop rows that share a timestamp with a previous usable row.
  const deduped: Parsed[] = [];
  let prev: Parsed | undefined;
  for (const p of parsed) {
    if (prev && prev.date.getTime() === p.date.getTime()) {
      quality.duplicate_timestamps += 1;
      continue;
    }
    deduped.push(p);
    prev = p;
  }

  // Consumption deltas between cumulative registers.
  const points: EnergyPoint[] = deduped.map((p, i) => {
    let consumption: number | null = null;
    if (i > 0) {
      const before = deduped[i - 1];
      if (before) {
        const delta = p.kWh - before.kWh;
        if (delta < 0) {
          quality.regressed_readings += 1; // e.g. meter reset; we refuse to guess
        } else {
          consumption = Math.round(delta * 100) / 100;
        }
      }
    }
    return {
      timestamp: isoIst(p.date),
      kWh: Math.round(p.kWh * 100) / 100,
      kVAh: Math.round(p.kVAh * 100) / 100,
      voltR: p.voltR,
      consumption_kWh: consumption
    };
  });

  // Cadence: most common gap, rounded to the minute. Mixed-cadence meters
  // surface as irregular_gaps rather than a lie about their interval.
  const gaps = new Map<number, number>();
  for (let i = 1; i < deduped.length; i++) {
    const before = deduped[i - 1];
    const current = deduped[i];
    if (!before || !current) continue;
    const gapMin = Math.round((current.date.getTime() - before.date.getTime()) / 60_000);
    if (gapMin <= 0) continue;
    gaps.set(gapMin, (gaps.get(gapMin) ?? 0) + 1);
  }
  let interval: number | null = null;
  if (gaps.size > 0) {
    const sorted = [...gaps.entries()].sort((a, b) => b[1] - a[1]);
    interval = sorted[0]?.[0] ?? null;
    for (const [gap, count] of gaps) {
      if (gap !== interval) quality.irregular_gaps += count;
    }
  }

  return { points, interval_minutes: interval, data_quality: quality };
}
