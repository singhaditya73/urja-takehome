import type { FastifyInstance } from 'fastify';
import * as S from '../schemas.js';
import { getMeter, listMeters, metersNear } from '../store/queries.js';
import { toMeterSummary, rowToMeter } from '../meterView.js';
import type { Services } from '../types.js';

export async function metersRoutes(app: FastifyInstance, opts: { services: Services; prefix: string }): Promise<void> {
  const services = opts.services;

  app.get(
    '/meters',
    {
      schema: {
        querystring: S.ListQuery,
        response: { 200: S.MeterList },
        tags: ['meters'],
        summary: 'List meters',
        description: 'Filterable list backed by a local index refreshed from the portal bulk export.'
      }
    },
    async (req) => {
      const q = req.query as S.ListQueryType;
      const limit = q.limit ?? 20;
      const offset = q.offset ?? 0;
      await services.index.ensureFresh();
      const { rows, total } = listMeters(
        services.db,
        {
          q: q.q,
          status: q.status,
          phase: q.phase,
          make: q.make,
          build: q.build,
          installType: q.install_type,
          dt: q.dt,
          feeder: q.feeder,
          zone: q.zone,
          circle: q.circle,
          division: q.division,
          subdivision: q.subdivision,
          substation: q.substation
        },
        limit,
        offset
      );
      return { data: rows.map(toMeterSummary), pagination: { total, limit, offset } };
    }
  );

  app.get(
    '/meters/nearby',
    {
      schema: {
        querystring: S.NearbyQuery,
        response: { 200: S.NearbyMeterList },
        tags: ['meters'],
        summary: 'Meters near a point',
        description: 'Straight-line (haversine) distance search over coordinates from the portal export.'
      }
    },
    async (req) => {
      const q = req.query as S.NearbyQueryType;
      const radius = q.radius_m ?? 500;
      const limit = q.limit ?? 20;
      const offset = q.offset ?? 0;
      await services.index.ensureFresh();
      const { items, total } = metersNear(services.db, q.latitude, q.longitude, radius, limit, offset);
      return {
        data: items.map(({ row, distance_m }) => ({ ...toMeterSummary(row), distance_m })),
        pagination: { total, limit, offset },
        query: { latitude: q.latitude, longitude: q.longitude, radius_m: radius }
      };
    }
  );

  app.get(
    '/meters/:meterId',
    {
      schema: {
        response: { 200: S.Meter, 404: S.ApiError },
        tags: ['meters'],
        summary: 'Meter detail',
        description: 'Includes resolved position in the network hierarchy and coordinates.'
      }
    },
    async (req, reply) => {
      const { meterId } = req.params as { meterId: string };
      await services.index.ensureFresh();
      const row = getMeter(services.db, meterId);
      if (!row) {
        void reply.status(404);
        return { error: 'not_found', message: `Meter ${meterId} not found` };
      }
      return rowToMeter(row);
    }
  );

  app.get(
    '/meters/:meterId/energy',
    {
      schema: {
        querystring: S.EnergyQuery,
        response: { 200: S.EnergySeries, 404: S.ApiError },
        tags: ['meters'],
        summary: 'Meter energy series',
        description:
          'Readings from the portal with per-interval consumption computed from register deltas. Timestamps are ISO 8601 with +05:30. The portal currently stores data for June 2026.'
      }
    },
    async (req, reply) => {
      const { meterId } = req.params as { meterId: string };
      const q = req.query as S.EnergyQueryType;
      await services.index.ensureFresh();
      if (!getMeter(services.db, meterId)) {
        void reply.status(404);
        return { error: 'not_found', message: `Meter ${meterId} not found` };
      }
      const { series, served_from } = await services.energy.getEnergy(meterId, q.from, q.to);
      return {
        meter_id: meterId,
        from: q.from ?? null,
        to: q.to ?? null,
        interval_minutes: series.interval_minutes,
        points: series.points,
        data_quality: series.data_quality,
        cache: { served_from }
      };
    }
  );
}
