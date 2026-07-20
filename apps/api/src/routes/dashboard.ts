import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { listModels, listSeats, listSpend } from '../services/dashboard.js';

const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(90),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const dateWindowQuery = z.object({ from: isoDate, to: isoDate }).refine((q) => q.from <= q.to, {
  message: 'from must not be after to',
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
    // A query mentioning either endpoint is a calendar window; anything else
    // is the "last N days" form. A union would let a bad window (from > to)
    // fall through to the days default and silently return 90 days.
    const query = request.query as Record<string, unknown>;
    const isWindow = 'from' in query || 'to' in query;
    const parsed = (isWindow ? dateWindowQuery : daysQuery).safeParse(query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    return { models: await listModels(parsed.data) };
  });
};
