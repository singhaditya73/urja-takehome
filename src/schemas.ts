import { Type, type Static } from '@sinclair/typebox';

/** All ISO strings carry an explicit +05:30 offset — the source data is IST. */
export const IsoTimestamp = Type.String({ description: 'ISO 8601 timestamp with IST offset' });
export const IsoDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD (IST)' });

export const MeterSummary = Type.Object({
  meter_id: Type.String(),
  serial_no: Type.String(),
  make: Type.String(),
  phase_type: Type.String(),
  install_status: Type.String(),
  install_type: Type.Union([Type.String(), Type.Null()]),
  build: Type.Union([Type.String(), Type.Null()], {
    description: 'legacy | v2 — internal build marker the portal UI never shows'
  }),
  dt_code: Type.String()
});

export const Geo = Type.Object({
  latitude: Type.Number(),
  longitude: Type.Number()
});

export const HierarchyPathNode = Type.Object({
  level: Type.String(),
  code: Type.String(),
  name: Type.String()
});

export const Meter = Type.Object({
  ...MeterSummary.properties,
  geo: Type.Union([Geo, Type.Null()]),
  hierarchy: Type.Array(HierarchyPathNode, {
    description: 'Meter\u2019s network path, outermost first. Names resolved by majority vote.'
  })
});

export const Pagination = Type.Object({
  total: Type.Integer(),
  limit: Type.Integer(),
  offset: Type.Integer()
});

export const MeterList = Type.Object({
  data: Type.Array(MeterSummary),
  pagination: Pagination
});

export const NearbyMeter = Type.Object({
  ...MeterSummary.properties,
  distance_m: Type.Number()
});

export const NearbyMeterList = Type.Object({
  data: Type.Array(NearbyMeter),
  pagination: Pagination,
  query: Type.Object({ latitude: Type.Number(), longitude: Type.Number(), radius_m: Type.Number() })
});

export const EnergyPointOut = Type.Object({
  timestamp: IsoTimestamp,
  kWh: Type.Union([Type.Number(), Type.Null()]),
  kVAh: Type.Union([Type.Number(), Type.Null()]),
  voltR: Type.Union([Type.Number(), Type.Null()]),
  consumption_kWh: Type.Union([Type.Number(), Type.Null()])
});

export const DataQuality = Type.Object({
  malformed_rows: Type.Integer(),
  duplicate_timestamps: Type.Integer(),
  regressed_readings: Type.Integer(),
  irregular_gaps: Type.Integer()
});

export const EnergySeries = Type.Object({
  meter_id: Type.String(),
  from: Type.Union([IsoDate, Type.Null()]),
  to: Type.Union([IsoDate, Type.Null()]),
  interval_minutes: Type.Union([Type.Integer(), Type.Null()], {
    description: 'Modal read interval; null with too few points. Irregular cadence shows in data_quality.'
  }),
  points: Type.Array(EnergyPointOut),
  data_quality: DataQuality,
  cache: Type.Object({
    served_from: Type.String({ enum: ['portal', 'cache', 'cache-stale'] })
  })
});

export const HierarchyNodeOut = Type.Recursive((Node) =>
  Type.Object({
    level: Type.String(),
    code: Type.String(),
    name: Type.String(),
    name_variants: Type.Array(Type.String(), {
      description: 'Other names the portal attaches to this code (data conflict).'
    }),
    parent_code: Type.Union([Type.String(), Type.Null()]),
    parent_conflict: Type.Boolean(),
    unresolved_parents: Type.Integer({ description: 'Meters whose chain does not resolve this node\u2019s parent.' }),
    meter_count: Type.Integer(),
    children: Type.Array(Node, { description: 'Nested levels of the network tree.' })
  })
);

export const NetworkTree = Type.Object({
  data: Type.Array(HierarchyNodeOut),
  meta: Type.Object({
    conflicts: Type.Integer({ description: 'Nodes with conflicting names or parents across meters.' })
  })
});

export const TransformerOut = Type.Object({
  code: Type.String(),
  name: Type.String(),
  feeder_code: Type.String(),
  capacity_kva: Type.Number(),
  meter_count: Type.Integer()
});

export const TransformerList = Type.Object({ data: Type.Array(TransformerOut), total: Type.Integer() });

export const Health = Type.Object({
  status: Type.String({ enum: ['ok', 'degraded'] }),
  index_age_ms: Type.Union([Type.Integer(), Type.Null()]),
  stale_index: Type.Boolean(),
  uptime_s: Type.Number()
});

export const ApiError = Type.Object({
  error: Type.String(),
  message: Type.String()
});

// ---------------------------------------------------------------- query types

export const ListQuery = Type.Object({
  q: Type.Optional(Type.String({ description: 'Substring match on meter id or serial number' })),
  status: Type.Optional(Type.String({ description: 'Installed | Faulty | Decommissioned' })),
  phase: Type.Optional(Type.String({ description: 'single | three' })),
  make: Type.Optional(Type.String()),
  build: Type.Optional(Type.String({ description: 'legacy | v2' })),
  install_type: Type.Optional(Type.String()),
  dt: Type.Optional(Type.String({ description: 'DT code, e.g. DT-002' })),
  feeder: Type.Optional(Type.String({ description: 'Feeder code, e.g. F-002' })),
  zone: Type.Optional(Type.String()),
  circle: Type.Optional(Type.String()),
  subdivision: Type.Optional(Type.String()),
  division: Type.Optional(Type.String()),
  substation: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 }))
});

export const NearbyQuery = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  radius_m: Type.Optional(Type.Integer({ minimum: 1, maximum: 50_000, default: 500 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 }))
});

export const EnergyQuery = Type.Object({
  from: Type.Optional(IsoDate),
  to: Type.Optional(IsoDate)
});

export type ListQueryType = Static<typeof ListQuery>;
export type NearbyQueryType = Static<typeof NearbyQuery>;
export type EnergyQueryType = Static<typeof EnergyQuery>;
