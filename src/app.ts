import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { type AppConfig } from './config.js';
import type { PortalClient, PortalError } from './portal/client.js';
import type { Services } from './types.js';
import { metersRoutes } from './routes/meters.js';
import { networkRoutes } from './routes/network.js';
import * as S from './schemas.js';

export interface BuildOptions {
  config: AppConfig;
  services: Omit<Services, 'config'>;
}

export async function buildApp({ config, services }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true
  });
  const fullServices: Services = { config, ...services };

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.code === 'FST_ERR_VALIDATION' || err.name === 'ValidationError') {
      void reply.status(400).send({ error: 'bad_request', message: err.message });
      return;
    }
    const portalErr = err as unknown as PortalError;
    const status = typeof portalErr.status === 'number' ? portalErr.status : 500;
    const code = typeof portalErr.code === 'string' ? portalErr.code : 'internal_error';
    req.log.error({ err: { message: err.message, stack: err.stack } }, 'request failed');
    void reply.status(status).send({ error: code, message: err.message });
  });

  // Bearer auth on everything under /v1.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v1')) return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.apiToken}`) {
      void reply.status(401).send({
        error: 'unauthorized',
        message: 'Provide Authorization: Bearer <token>'
      });
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Urja Ops API',
        description:
          'Clean programmatic access over the legacy Urja Meter Ops portal: meter records, network hierarchy and consumption.',
        version: '0.1.0'
      },
      tags: [
        { name: 'meters', description: 'Meter records and time series' },
        { name: 'network', description: 'Distribution network hierarchy' }
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' }
        }
      },
      security: [{ bearerAuth: [] }]
    }
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.get('/', { schema: { hide: true } }, async () => ({
    service: 'urja-ops-api',
    docs: '/docs',
    openapi: '/openapi.json',
    health: '/health'
  }));

  app.get(
    '/health',
    { schema: { response: { 200: S.Health } } },
    async () => {
      const fresh = await services.index.ensureFresh();
      const age = fresh.index_age_ms;
      return {
        status: 'ok' as const,
        index_age_ms: age === null ? null : Math.round(age),
        stale_index: fresh.stale,
        uptime_s: Math.round(process.uptime())
      };
    }
  );

  await app.register(metersRoutes, { services: fullServices, prefix: '/v1' });
  await app.register(networkRoutes, { services: fullServices, prefix: '/v1' });

  return app;
}
