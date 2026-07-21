import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CsvImportError,
  importBillingCsv,
  importUserExportCsv,
} from '../services/billing-import.js';
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

  /**
   * Billing report CSV (Report 1 or Report 2, auto-detected by header).
   * All-or-nothing: a malformed row or unknown sku rejects the whole file.
   */
  app.post('/api/import/billing', async (request, reply) => {
    const parsed = importBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Body must be { content: string }' });
    }

    try {
      const result = await importBillingCsv(parsed.data.content);
      return { result };
    } catch (error) {
      if (error instanceof CsvImportError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  /** GitHub org user export (login → saml_name_id). Upserts github_users. */
  app.post('/api/import/users', async (request, reply) => {
    const parsed = importBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Body must be { content: string }' });
    }

    try {
      const result = await importUserExportCsv(parsed.data.content);
      return { result };
    } catch (error) {
      if (error instanceof CsvImportError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });
};
