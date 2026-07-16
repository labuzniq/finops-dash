import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { importSeats } from '../services/import.js';

/** Up to ~25 MB of CSV/NDJSON, matching the modal's stated limit. */
const importBody = z.object({
  content: z.string().min(1).max(30_000_000),
});

export const importRoutes: FastifyPluginAsync = async (app) => {
  /** Manual CSV / JSON / NDJSON import of seat rows. Upserts by login. */
  app.post('/api/import', async (request, reply) => {
    const parsed = importBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Body must be { content: string }' });
    }

    const result = await importSeats(parsed.data.content);
    // 422 when nothing landed but rows were supplied — the client should show why.
    const code = result.imported + result.updated === 0 && result.errors.length > 0 ? 422 : 200;
    return reply.code(code).send({ result });
  });
};
