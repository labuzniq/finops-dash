import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import {
  getGatewayBudgets,
  getGatewayCoverage,
  getGatewayUsage,
  probeGateway,
} from '../services/gateway.js';

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

  /**
   * Which days are stored, and which are missing — the shape of the table
   * rather than the shape of the spend.
   *
   * Takes no query parameters because it *is* the answer to "what may I ask
   * for": the range picker, the comparison window and the chargeback month
   * list all clamp to `floor`, which is the earliest stored day rather than a
   * retention window measured from today. An empty table answers with the
   * retention floor, so a fresh install behaves exactly as it did before.
   */
  app.get('/api/gateway/coverage', async () => getGatewayCoverage());

  /**
   * Budgets and rate limits as of the last sync — current state, not a range,
   * so it takes no query parameters. An empty list is a legitimate answer twice
   * over: the gateway has never synced, or the credential the proxy gave us is
   * not allowed to list keys and teams.
   */
  app.get('/api/gateway/budgets', async () => getGatewayBudgets());

  /**
   * A live connection check — the only gateway route that talks to the proxy
   * while answering, and the only one that reads no table.
   *
   * A GET because it changes nothing, and unrated because it is one round trip
   * per route behind a button. It always answers `200`: an unreachable proxy,
   * a refused management route and an unconfigured source are all *results*
   * carried in the body, and a 5xx would tell the UI only that something went
   * wrong somewhere.
   */
  app.get('/api/gateway/probe', async () => probeGateway());

  /** Whether the gateway integration is configured, and with which source. */
  app.get('/api/gateway/status', async () => ({
    source: env.GATEWAY_SOURCE,
    configured: env.GATEWAY_SOURCE !== 'off',
  }));
};
