/**
 * Types for the payloads the legacy portal actually returns, as discovered
 * in PROTOCOL.md. Kept deliberately close to the wire format — normalization
 * happens in the domain layer, not here.
 */

export interface MeterSearchItem {
  meterId: string;
  serialNo: string;
  make: string;
  phaseType: string;
  installStatus: string;
  dtCode: string;
}

export interface SearchPage {
  data: MeterSearchItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ExportMeter {
  meterId: string;
  serialNo: string;
  make: string;
  phaseType: string;
  installStatus: string;
  /** Only present in the export payload, not in search results. */
  installType?: string;
  /** "legacy" | "v2" — export only, and absent from the portal UI entirely. */
  build?: string;
  dtCode: string;
  /** zone -> circle -> division -> subdivision -> substation -> feeder -> dt */
  hierarchy?: Record<string, { code: string; name: string }>;
  geo?: { lat: number; lng: number };
}

export interface ExportPayload {
  data: ExportMeter[];
  total: number;
}

export interface DistributionTransformer {
  code: string;
  name: string;
  feederCode: string;
  capacityKva: number;
}

export interface DtPage {
  data: DistributionTransformer[];
  total: number;
}

/** Strings on purpose: the portal sends numerals as strings, empty for missing. */
export interface RawEnergyPoint {
  timestamp: string;
  kwh: string;
  kvah: string;
  voltR: string;
}

export interface RawGeo {
  latitude: string;
  longitude: string;
}

export interface SigningSecret {
  signingSecret: string;
}
