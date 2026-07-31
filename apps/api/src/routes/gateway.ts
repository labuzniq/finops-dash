import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import {
  GatewaySealError,
  checkMonthSeal,
  getGatewaySeal,
  getGatewaySealHistory,
  listGatewaySeals,
  sealGatewayMonth,
} from '../services/gateway-seal.js';
import { getGatewayNotifications } from '../services/gateway-notify.js';
import {
  EXCEPTION_MAX_WINDOW_DAYS,
  LATENCY_MAX_WINDOW_DAYS,
  SPEND_LOG_MAX_WINDOW_DAYS,
  SPEND_LOG_ROW_CAP,
} from '@dash/shared';
import {
  GatewayLogsUnavailableError,
  getGatewayBudgetHistory,
  getGatewayBudgets,
  getGatewayCoverage,
  getGatewayDeploymentHistory,
  getGatewayExceptions,
  getGatewayHealth,
  getGatewayLatency,
  getGatewayModels,
  getGatewaySpendLogs,
  getGatewayUsage,
  probeGateway,
} from '../services/gateway.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const monthParams = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

const revisionQuery = z.object({
  revision: z.coerce.number().int().positive().optional(),
});

/**
 * A refusal to seal maps to the status that says what the caller should do:
 * a month still running or one with holes in it is a request that is wrong
 * *now* and right later (400), while an already-sealed month is a conflict
 * with existing state (409) and is resolved by asking again with `force`.
 */
const SEAL_ERROR_STATUS = {
  invalid_month: 400,
  in_flight: 400,
  incomplete: 400,
  empty: 400,
  sealed: 409,
} as const;

const historyQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(60),
});

/** How far back closed episodes are still worth reporting. Open ones are always returned. */
const notificationsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const rangeQuery = z.object({ from: isoDate, to: isoDate }).refine((q) => q.from <= q.to, {
  message: 'from must not be after to',
});

/**
 * The request-log drill-down's window. Same date rule as every other range,
 * with a row cap the caller may lower but not raise: the ceiling is a property
 * of what a browser and a proxy can carry, not of what a caller asks for.
 */
const logsQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    limit: z.coerce.number().int().min(1).max(SPEND_LOG_ROW_CAP).optional().default(SPEND_LOG_ROW_CAP),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to' });

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
   * The proxy's configured price list as of the last full sync — per-model list
   * rates, context windows and modality.
   *
   * Current state, so no query parameters, same as budgets. It is deliberately
   * *not* folded into `GET /api/gateway`: that payload is a date range and this
   * is not, and a card that re-fetched a price list every time the range picker
   * moved would be re-reading a table that cannot have changed.
   */
  app.get('/api/gateway/models', async () => getGatewayModels());

  /**
   * Per-deployment health as of the last full sync.
   *
   * Current state, so no query parameters — and a *stored* reading rather than a
   * live one, which is the opposite choice from `/api/gateway/probe` one route
   * down. The reason is cost: `/health` on the proxy issues a test call to every
   * deployment, so a route that forwarded it would let a browser refresh bill
   * the corporation. The nightly sync pays that once and this hands over what it
   * found, with the reading's own timestamp on it so a stale answer reads as
   * stale rather than as current.
   */
  app.get('/api/gateway/health', async () => getGatewayHealth());

  /**
   * What those deployments read on each of the last `days` days.
   *
   * The health twin of `/api/gateway/budgets/history`, and it exists for the
   * same reason: the snapshot above is replaced by every full sync, so it can
   * say a pool is refusing tonight and can never say it has been refusing all
   * week. Only that second statement separates a fault somebody has to fix from
   * an evening's trouble that already cleared.
   *
   * A weaker sample than the governance one, deliberately read as such: a
   * deployment that failed and recovered between two nightly readings left
   * nothing here, so `summarizeDeploymentHistory` counts readings and never
   * converts them to hours, and a day with no row stays unknown.
   *
   * Same window rules as the budget history — 60 days by default, 365 at most.
   * The rows are ours rather than the proxy's, so the only argument for the cap
   * is payload size: deployments × days, and a large router is a hundred rows a
   * night.
   */
  app.get('/api/gateway/health/history', async (request, reply) => {
    const parsed = historyQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    return getGatewayDeploymentHistory(parsed.data.days);
  });

  /**
   * What those budgets read on each of the last `days` days.
   *
   * The one governance route with a window, because it is the only governance
   * fact that *has* one: the snapshot above is replaced by every sync, and this
   * is what the sync kept before replacing it. Nothing is filled in for a day
   * the scheduler did not run — an unobserved day is unknown, not unchanged,
   * and the card draws it as a hole.
   *
   * Defaults to 60 days and caps at 365. There is no retention argument to make
   * here (the rows are ours, not the proxy's), only a payload one: the response
   * is objects × days, and a year of a hundred governed keys is already a large
   * thing to hand a browser.
   */
  app.get('/api/gateway/budgets/history', async (request, reply) => {
    const parsed = historyQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    return getGatewayBudgetHistory(parsed.data.days);
  });

  /**
   * Governance findings and whether they left the building.
   *
   * The only gateway read about the dashboard's *own* behaviour rather than the
   * proxy's: every open finding, the ones that closed inside the window, and
   * whether a delivery target is configured at all. A closed episode is the
   * reason this is a list — one that opened and cleared between two visits is
   * invisible in the budget snapshot, which has already moved on.
   */
  app.get('/api/gateway/notifications', async (request, reply) => {
    const parsed = notificationsQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    return getGatewayNotifications(parsed.data.days);
  });

  /**
   * A sample of individual requests for a short window — the joint-keyed
   * evidence layer under every aggregate on the page.
   *
   * Live, like `/probe` and unlike everything else: nothing is stored, because
   * these rows come from the largest table LiteLLM has, are pruned on the
   * proxy's own retention schedule, and can be switched off entirely
   * (`disable_spend_logs`). The window is capped at a week and the response at
   * `SPEND_LOG_ROW_CAP` rows for the same reason the proxy would want it capped
   * — a busy day is millions of requests — and a read that hit the cap says so,
   * because a truncated sample presented as a window is the one way this route
   * misleads.
   *
   * It answers `503` while the gateway is off, rather than an empty list: every
   * other gateway route reads a table that is legitimately empty on a fresh
   * install, and this one has no table to be empty.
   */
  app.get('/api/gateway/logs', async (request, reply) => {
    const parsed = logsQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { from, to, limit } = parsed.data;
    const days = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1,
    );
    if (days > SPEND_LOG_MAX_WINDOW_DAYS) {
      return reply.code(400).send({
        error: `Request logs may be read ${SPEND_LOG_MAX_WINDOW_DAYS} days at a time — asked for ${days}.`,
      });
    }
    try {
      return await getGatewaySpendLogs(from, to, limit);
    } catch (error) {
      if (error instanceof GatewayLogsUnavailableError) {
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }
  });

  /**
   * Why the failed calls in a window failed, per deployment.
   *
   * Live and storing nothing, like `/logs` and `/probe`. It reads
   * `LiteLLM_ErrorLogs` — a different table from both the aggregates and the
   * request log, separately switchable upstream (`disable_error_logs`) and
   * carrying no denominator of its own — so the counts here are reasons rather
   * than a failure rate, and the ledger stays the place failures are counted.
   *
   * The window is capped at a month because the proxy's own default on this
   * route is thirty days and the error table is pruned on a schedule of its
   * own: a wider ask answers a shorter window and does not say so.
   */
  app.get('/api/gateway/exceptions', async (request, reply) => {
    const parsed = rangeQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { from, to } = parsed.data;
    const days = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1,
    );
    if (days > EXCEPTION_MAX_WINDOW_DAYS) {
      return reply.code(400).send({
        error: `Exceptions may be read ${EXCEPTION_MAX_WINDOW_DAYS} days at a time — asked for ${days}.`,
      });
    }
    try {
      return await getGatewayExceptions(from, to);
    } catch (error) {
      if (error instanceof GatewayLogsUnavailableError) {
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }
  });

  /**
   * How slowly each deployment answered over a window, per day.
   *
   * Live and storing nothing, like `/logs` and `/exceptions`. It reads the
   * proxy's own aggregation over `LiteLLM_SpendLogs` — the whole window rather
   * than the head of it, which is the one thing the request sample cannot do —
   * and the number it answers is *seconds per completion token*, so nothing
   * derived from it is a request duration.
   *
   * The window is capped at a month for the same two reasons the exception
   * route is: the proxy's own default here is thirty days, and the table
   * underneath is pruned on the request log's schedule rather than the
   * aggregates' ninety days.
   */
  app.get('/api/gateway/latency', async (request, reply) => {
    const parsed = rangeQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    const { from, to } = parsed.data;
    const days = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1,
    );
    if (days > LATENCY_MAX_WINDOW_DAYS) {
      return reply.code(400).send({
        error: `Latency may be read ${LATENCY_MAX_WINDOW_DAYS} days at a time — asked for ${days}.`,
      });
    }
    try {
      return await getGatewayLatency(from, to);
    } catch (error) {
      if (error instanceof GatewayLogsUnavailableError) {
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }
  });

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

  /**
   * Every month that has been sealed, newest first — headers only.
   *
   * The chargeback card reads this to say whether the statement on screen is
   * the one that was issued. It carries each month's sealed total, which is all
   * the drift check needs; the lines are one route down and are only fetched
   * when someone asks to see the issued statement itself.
   */
  app.get('/api/gateway/months', async () => ({ seals: await listGatewaySeals() }));

  /**
   * One sealed month with its per-payer lines — the statement as issued.
   *
   * `404` means the month was never sealed, which is a different answer from
   * "the month had no spend": an unsealed month has no statement to quote, and
   * the card falls back to deriving one from the daily rows. The body carries
   * the `check` for an unsealed month, so a caller learns *why* — still
   * running, or missing days it should backfill first.
   */
  app.get('/api/gateway/months/:month', async (request, reply) => {
    const parsed = monthParams.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid month', issues: parsed.error.issues });
    }
    const query = revisionQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'Invalid revision', issues: query.error.issues });
    }
    // `?revision=` quotes a statement that has since been replaced — the one a
    // recipient is holding — which is a different question from "what is this
    // month's bill" and must not silently answer with the current one.
    const revision = query.data.revision;
    const sealed =
      revision === undefined
        ? await getGatewaySeal(parsed.data.month)
        : await getGatewaySeal(parsed.data.month, revision);
    if (sealed === null) {
      return reply.code(404).send({
        error:
          revision === undefined
            ? `${parsed.data.month} has not been sealed`
            : `${parsed.data.month} has no revision ${revision}`,
        check: await checkMonthSeal(parsed.data.month),
      });
    }
    return sealed;
  });

  /**
   * Every statement this month has ever carried, newest first, with what each
   * re-seal changed.
   *
   * `sealDrift` says a month has moved since it was billed; this says *who*
   * moved, which is what a department disputing a corrected invoice actually
   * needs. The diffs are computed from two recorded statements, so unlike the
   * drift check they are stable — nothing about a past revision can change
   * again.
   */
  app.get('/api/gateway/months/:month/revisions', async (request, reply) => {
    const parsed = monthParams.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid month', issues: parsed.error.issues });
    }
    const history = await getGatewaySealHistory(parsed.data.month);
    if (history === null) {
      return reply.code(404).send({
        error: `${parsed.data.month} has not been sealed`,
        check: await checkMonthSeal(parsed.data.month),
      });
    }
    return history;
  });

  /**
   * Seal a closed month by hand.
   *
   * The nightly sync seals a month the first time it is complete, so this
   * exists for the two cases it cannot cover: a month completed by a backfill
   * (which deliberately does not seal — see `gateway-sync.ts`), and a
   * deliberate re-seal after the daily rows were revised, which needs
   * `?force=true` because it replaces the statement that was already issued.
   */
  app.post('/api/gateway/months/:month/seal', async (request, reply) => {
    const parsed = monthParams.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid month', issues: parsed.error.issues });
    }
    const force = z
      .object({ force: z.enum(['true', 'false']).optional() })
      .safeParse(request.query);
    try {
      return await sealGatewayMonth(parsed.data.month, {
        force: force.success && force.data.force === 'true',
        sealedBy: 'manual',
      });
    } catch (error) {
      if (error instanceof GatewaySealError) {
        return reply.code(SEAL_ERROR_STATUS[error.code]).send({
          error: error.message,
          code: error.code,
          check: error.code === 'invalid_month' ? null : await checkMonthSeal(parsed.data.month),
        });
      }
      throw error;
    }
  });

  /** Whether the gateway integration is configured, and with which source. */
  app.get('/api/gateway/status', async () => ({
    source: env.GATEWAY_SOURCE,
    configured: env.GATEWAY_SOURCE !== 'off',
  }));
};
