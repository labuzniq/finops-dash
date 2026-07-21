import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { REFRESH_KINDS } from '@dash/shared';
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
