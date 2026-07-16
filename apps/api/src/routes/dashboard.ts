import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { listModels, listSeats, listSpend } from '../services/dashboard.js';

const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(90),
});

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/seats', async () => {
    return { seats: await listSeats() };
  });

  app.get('/api/spend', async (request, reply) => {
    const parsed = daysQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    return { spend: await listSpend(parsed.data.days) };
  });

  app.get('/api/models', async (request, reply) => {
    const parsed = daysQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    return { models: await listModels(parsed.data.days) };
  });
};
