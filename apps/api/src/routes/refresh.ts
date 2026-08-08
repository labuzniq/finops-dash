import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { REFRESH_KINDS } from '@dash/shared';
import { BillingSyncUnavailableError, startBillingSync } from '../services/billing-sync.js';
import { MembersSyncUnavailableError, startMembersSync } from '../services/members-sync.js';
import { getLatestRefreshJob, getRefreshJob, startRefresh } from '../services/refresh.js';

const jobParams = z.object({ id: z.string().uuid() });

/** One job table holds both kinds; the caller picks which timeline it wants. */
const latestQuery = z.object({ kind: z.enum(REFRESH_KINDS).default('copilot') });

export const refreshRoutes: FastifyPluginAsync = async (app) => {
  /** Kick off a sync. Returns 202 with the job to poll — never blocks on GitHub. */
  app.post('/api/refresh', async (_request, reply) => {
    const job = await startRefresh();
    return reply.code(202).send({ job });
  });

  /**
   * Kick off an enterprise billing sync (kind `billing`) — the scheduled
   * 07:00 run uses the same entry point. 503 while GITHUB_ENTERPRISE is unset.
   */
  app.post('/api/refresh/billing', async (_request, reply) => {
    try {
      const job = await startBillingSync();
      return reply.code(202).send({ job });
    } catch (error) {
      if (error instanceof BillingSyncUnavailableError) {
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }
  });

  /**
   * Kick off an org member sync (kind `members`) — the scheduled 07:00 run
   * uses the same entry point. 503 while GITHUB_ORG or a token is unset.
   *
   * This is the API replacement for the members-export CSV upload; the upload
   * route stays for the members GraphQL cannot see (never linked SSO).
   */
  app.post('/api/refresh/members', async (_request, reply) => {
    try {
      const job = await startMembersSync();
      return reply.code(202).send({ job });
    } catch (error) {
      if (error instanceof MembersSyncUnavailableError) {
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }
  });

  /**
   * Latest job of any status for one kind — the header's "synced …" note and
   * the modal's JIRA row read this. Defaults to `copilot`.
   */
  app.get('/api/refresh/latest', async (request, reply) => {
    const parsed = latestQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: `kind must be one of ${REFRESH_KINDS.join(', ')}` });
    }

    return { job: await getLatestRefreshJob(parsed.data.kind) };
  });

  app.get('/api/refresh/:id', async (request, reply) => {
    const parsed = jobParams.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid job id' });
    }

    const job = await getRefreshJob(parsed.data.id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    return { job };
  });
};
