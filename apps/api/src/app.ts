import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { importRoutes } from './routes/import.js';
import { refreshRoutes } from './routes/refresh.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    // CSV/JSON imports can approach the modal's 25 MB limit.
    bodyLimit: 30_000_000,
  });

  await app.register(cors, { origin: env.CORS_ORIGIN });

  app.get('/api/health', async () => ({ status: 'ok', source: env.COPILOT_SOURCE }));

  await app.register(dashboardRoutes);
  await app.register(refreshRoutes);
  await app.register(importRoutes);

  return app;
}
