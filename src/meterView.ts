import type { FastifyInstance } from 'fastify';
import type { Services } from './types.js';

/**
 * View helpers shared between routes. Kept out of the route file so the
 * mapping stays independent from HTTP plumbing.
 */

export function toMeterSummary(row: {
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
}) {
  return {
    meter_id: row.meter_id,
    serial_no: row.serial_no,
    make: row.make,
    phase_type: row.phase_type,
    install_status: row.install_status,
    install_type: row.install_type,
    build: row.build,
    dt_code: row.dt_code,
    latitude: row.lat,
    longitude: row.lng
  };
}

export function rowToMeter(row: {
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
  zone_name: string | null;
  circle_code: string | null;
  circle_name: string | null;
  division_code: string | null;
  division_name: string | null;
  subdivision_code: string | null;
  subdivision_name: string | null;
  substation_code: string | null;
  substation_name: string | null;
  feeder_code: string | null;
  feeder_name: string | null;
  dt_name: string | null;
}) {
  const levels: Array<[string, string | null, string | null]> = [
    ['zone', row.zone_code, row.zone_name],
    ['circle', row.circle_code, row.circle_name],
    ['division', row.division_code, row.division_name],
    ['subdivision', row.subdivision_code, row.subdivision_name],
    ['substation', row.substation_code, row.substation_name],
    ['feeder', row.feeder_code, row.feeder_name],
    ['dt', row.dt_code, row.dt_name]
  ];
  return {
    meter_id: row.meter_id,
    serial_no: row.serial_no,
    make: row.make,
    phase_type: row.phase_type,
    install_status: row.install_status,
    install_type: row.install_type,
    build: row.build,
    dt_code: row.dt_code,
    geo: row.lat === null || row.lng === null ? null : { latitude: row.lat, longitude: row.lng },
    hierarchy: levels
      .filter(([, code]) => code !== null)
      .map(([level, code, name]) => ({
        level,
        code: code as string,
        name: (name as string) ?? (code as string)
      }))
  };
}
