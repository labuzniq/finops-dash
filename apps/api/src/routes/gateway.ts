import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { getGatewayUsage } from '../services/gateway.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rangeQuery = z.object({ from: isoDate, to: isoDate }).refine((q) => q.from <= q.to, {
  message: 'from must not be after to',
});

export const gatewayRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Gateway-wide daily totals plus every breakdown dimension for an inclusive
   * date range, in one payload — fetched once, all metrics derived
   * client-side, same as `/api/spend`.
   *
   * Answers normally while GATEWAY_SOURCE is `off`: the tables are simply
   * empty, and an empty range is a legitimate answer for a gateway that has
   * never synced. `/api/gateway/status` is what tells the UI whether to offer
   * the feature at all.
   */
  app.get('/api/gateway', async (request, reply) => {
    const parsed = rangeQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    return getGatewayUsage(parsed.data.from, parsed.data.to);
  });

  /** Whether the gateway integration is configured, and with which source. */
  app.get('/api/gateway/status', async () => ({
    source: env.GATEWAY_SOURCE,
    configured: env.GATEWAY_SOURCE !== 'off',
  }));
};
