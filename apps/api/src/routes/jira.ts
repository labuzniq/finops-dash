import type { FastifyPluginAsync } from 'fastify';
import { JiraSyncUnavailableError, startJiraSync } from '../services/jira-sync.js';

export const jiraRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Kick off a JIRA identity sync. Returns 202 with the job to poll (same
   * `GET /api/refresh/:id` as Copilot refreshes — one job table, kind `jira`).
   * 503 while JIRA env is unset (unless the mock source generates people).
   */
  app.post('/api/jira/sync', async (_request, reply) => {
    try {
      const job = await startJiraSync();
      return reply.code(202).send({ job });
    } catch (error) {
      if (error instanceof JiraSyncUnavailableError) {
        return reply.code(503).send({ error: error.message });
      }
      throw error;
    }
  });
};
