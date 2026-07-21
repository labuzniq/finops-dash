import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { clearSessionCookie, hasSession, setSessionCookie } from '../auth/session.js';

const loginBody = z.object({ token: z.string() });

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Expected { token }' });
    }
    if (parsed.data.token !== env.STATIC_LOGIN_TOKEN) {
      request.log.warn(
        { 'event.category': ['authentication'], 'event.outcome': 'failure' },
        'login rejected: invalid token',
      );
      return reply.code(401).send({ error: 'Invalid token' });
    }
    setSessionCookie(reply);
    request.log.info(
      { 'event.category': ['authentication'], 'event.outcome': 'success' },
      'login accepted',
    );
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    if (!hasSession(request)) {
      return reply.code(401).send({ authenticated: false });
    }
    return { authenticated: true };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });
};
