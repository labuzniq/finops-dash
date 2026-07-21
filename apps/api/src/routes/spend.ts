import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getSpend } from '../services/spend.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rangeQuery = z.object({ from: isoDate, to: isoDate }).refine((q) => q.from <= q.to, {
  message: 'from must not be after to',
});

export const spendRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Billing rows + per-model rows + identity join for an inclusive date range,
   * in one payload — fetched once, every KPI/chart/table derived client-side.
   */
  app.get('/api/spend', async (request, reply) => {
    const parsed = rangeQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    return getSpend(parsed.data.from, parsed.data.to);
  });
};
