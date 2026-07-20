import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';
import { hasSession } from './auth/session.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { importRoutes } from './routes/import.js';
import { otlpRoutes } from './routes/otlp.js';
import { refreshRoutes } from './routes/refresh.js';
import { telemetryRoutes } from './routes/telemetry.js';

/**
 * Open endpoints: health, the auth handshake itself, and the OTLP ingest —
 * exporters are headless and carry a bearer token (routes/otlp.ts), not the
 * dashboard cookie. Everything else needs the cookie.
 */
const PUBLIC_PATHS = new Set([
  '/api/finops/health',
  '/api/finops/auth/login',
  '/api/finops/auth/me',
  '/api/finops/auth/logout',
  '/v1/metrics',
  '/v1/logs',
]);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    // CSV/JSON imports can approach the modal's 25 MB limit.
    bodyLimit: 30_000_000,
  });

  // Cookies must survive the cross-origin dev proxy, so allow credentials.
  await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });

  // Gate every /api route behind the session cookie, bar the public handshake
  // endpoints. Presence of the cookie is the whole check.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (PUBLIC_PATHS.has(path) || hasSession(request)) return;
    return reply.code(401).send({ error: 'Not authenticated' });
  });

  app.get('/api/finops/health', async () => ({ status: 'ok', source: env.COPILOT_SOURCE }));

  await app.register(authRoutes);
  await app.register(dashboardRoutes);
  await app.register(refreshRoutes);
  await app.register(importRoutes);
  await app.register(otlpRoutes);
  await app.register(telemetryRoutes);

  return app;
}
