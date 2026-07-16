import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';

/**
 * The whole session, on purpose kept trivial: one cookie whose presence means
 * "this browser typed the admin token in the last 8 hours". The value is a
 * constant, unsigned and forgeable — that is an accepted trade for simplicity.
 * It is a convenience flag, not a security boundary.
 */
export const COOKIE_NAME = 'dash_session';
const COOKIE_VALUE = 'ok';
const MAX_AGE_S = 8 * 60 * 60; // 8 hours

/** Zero-dep read of a single cookie out of the raw `Cookie` header. */
function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function hasSession(request: FastifyRequest): boolean {
  return readCookie(request, COOKIE_NAME) === COOKIE_VALUE;
}

export function setSessionCookie(reply: FastifyReply): void {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  reply.header(
    'Set-Cookie',
    `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`,
  );
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}
