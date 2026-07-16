import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getLatestRefreshJob, getRefreshJob, startRefresh } from '../services/refresh.js';

const jobParams = z.object({ id: z.string().uuid() });

export const refreshRoutes: FastifyPluginAsync = async (app) => {
  /** Kick off a sync. Returns 202 with the job to poll — never blocks on GitHub. */
  app.post('/api/refresh', async (_request, reply) => {
    const job = await startRefresh();
    return reply.code(202).send({ job });
  });

  /** Latest job of any status — the header's "synced …" note reads this. */
  app.get('/api/refresh/latest', async () => {
    return { job: await getLatestRefreshJob() };
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
