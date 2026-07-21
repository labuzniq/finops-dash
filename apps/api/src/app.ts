import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { env } from './env.js';
import { logger } from './log.js';
import { hasSession } from './auth/session.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { importRoutes } from './routes/import.js';
import { jiraRoutes } from './routes/jira.js';
import { otlpRoutes } from './routes/otlp.js';
import { refreshRoutes } from './routes/refresh.js';
import { spendRoutes } from './routes/spend.js';
import { telemetryRoutes } from './routes/telemetry.js';

/**
 * Open endpoints: health, the auth handshake itself, and the OTLP ingest —
 * exporters are headless and carry a bearer token (routes/otlp.ts), not the
 * dashboard cookie. Everything else needs the cookie.
 */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/me',
  '/api/auth/logout',
  '/v1/metrics',
  '/v1/logs',
]);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // The shared ECS logger (log.ts) — its baked-in serializers turn Fastify's
    // req/res log fields into ECS http.* / url.*, so request logs ship as-is.
    // The cast narrows pino's Logger to the pino-compatible surface Fastify
    // types against; the runtime instance is a plain pino logger either way.
    loggerInstance: logger as FastifyBaseLogger,
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

  // Health checks poll constantly and drown the log; suppress their request
  // lines unless the logger runs at debug/trace, where full traffic is wanted.
  app.get(
    '/api/health',
    { logLevel: logger.isLevelEnabled('debug') ? 'info' : 'warn' },
    async () => ({ status: 'ok', source: env.COPILOT_SOURCE }),
  );

  await app.register(authRoutes);
  await app.register(dashboardRoutes);
  await app.register(spendRoutes);
  await app.register(refreshRoutes);
  await app.register(jiraRoutes);
  await app.register(importRoutes);
  await app.register(otlpRoutes);
  await app.register(telemetryRoutes);

  return app;
}
