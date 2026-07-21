import { ecsFormat } from '@elastic/ecs-pino-format';
import { pino } from 'pino';
import type { Logger } from 'pino';
import { env } from './env.js';

/**
 * The one logger for the whole API. Every line is Elastic Common Schema JSON
 * (`@timestamp`, `log.level`, `ecs.version`, `message`, …) so output can be
 * shipped to Elastic without a pipeline rewriting it. Fastify is handed this
 * same instance (see app.ts), and `convertReqRes` maps its `req`/`res` log
 * fields onto ECS `http.*` / `url.*` / `user_agent.*`.
 *
 * Domain fields that have no ECS equivalent (row counts, job ids, …) go under
 * the custom `dash.*` namespace; ECS reserves the top level for its own schema.
 */
export const logger: Logger = pino({
  ...ecsFormat({
    convertReqRes: true,
    serviceName: 'dash-api',
    serviceEnvironment: env.NODE_ENV,
  }),
  level: env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
});

/** Child logger tagged with its origin module via the ECS `log.logger` field. */
export function moduleLogger(name: string): Logger {
  return logger.child({ 'log.logger': name });
}

/** ECS `event.duration` is nanoseconds; pass the `Date.now()` you started at. */
export function eventDuration(startedAtMs: number): number {
  return (Date.now() - startedAtMs) * 1_000_000;
}
