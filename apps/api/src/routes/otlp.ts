import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { ingestLogs, ingestMetrics } from '../otlp/ingest.js';
import type { IngestResult } from '../otlp/ingest.js';

/**
 * OTLP/HTTP ingest on the standard exporter paths. JSON encoding only —
 * point a client here with:
 *
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://<host>:4000
 *
 * These are the only routes outside the dashboard's cookie gate (they are
 * called by headless exporters, not browsers). When OTLP_INGEST_TOKEN is set
 * they demand `Authorization: Bearer <token>` instead; unset means open, for
 * local development.
 */

/** Success and partial success per the OTLP spec — int64s ride as strings. */
function exportResponse(result: IngestResult): Record<string, unknown> {
  if (result.rejected === 0) return { partialSuccess: {} };
  return {
    partialSuccess: {
      rejectedDataPoints: String(result.rejected),
      errorMessage: 'some datapoints were malformed or of an unsupported type',
    },
  };
}

function rejectNonJson(request: FastifyRequest, reply: FastifyReply): boolean {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.includes('protobuf')) return false;
  void reply.code(415).send({
    error: 'OTLP protobuf encoding is not supported; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
  });
  return true;
}

export const otlpRoutes: FastifyPluginAsync = async (app) => {
  // Registered in an encapsulated context, so this guards only /v1/*.
  app.addHook('onRequest', async (request, reply) => {
    if (!env.OTLP_INGEST_TOKEN) return;
    if (request.headers.authorization === `Bearer ${env.OTLP_INGEST_TOKEN}`) return;
    return reply.code(401).send({ error: 'Invalid OTLP bearer token' });
  });

  // Give protobuf posts a body so the handler can answer 415 with a hint
  // instead of Fastify's generic unsupported-media-type error.
  app.addContentTypeParser('application/x-protobuf', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );

  app.post('/v1/metrics', async (request, reply) => {
    if (rejectNonJson(request, reply)) return reply;
    return exportResponse(await ingestMetrics(request.body));
  });

  app.post('/v1/logs', async (request, reply) => {
    if (rejectNonJson(request, reply)) return reply;
    return exportResponse(await ingestLogs(request.body));
  });
};
