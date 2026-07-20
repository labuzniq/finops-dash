import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { telemetryRollup } from '../services/telemetry.js';

const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(90),
});

/** Claude Code telemetry reads. Behind the session cookie like the rest of /api. */
export const telemetryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/finops/telemetry/rollup', async (request, reply) => {
    const parsed = daysQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    return { rollup: await telemetryRollup(parsed.data.days) };
  });
};
