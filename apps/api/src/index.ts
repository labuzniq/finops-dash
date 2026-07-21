import { buildApp } from './app.js';
import { closeDb } from './db/client.js';
import { env } from './env.js';
import { logger } from './log.js';
import { runMigrations } from './db/migrate.js';

const log = logger.child({ 'log.logger': 'boot' });

async function main(): Promise<void> {
  log.info(
    { dash: { copilotSource: env.COPILOT_SOURCE, dbSchema: env.DB_SCHEMA } },
    'starting api',
  );

  await runMigrations();

  const app = await buildApp();

  await app.listen({ port: env.API_PORT, host: env.HOST });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        app.log.info(`${signal} received — shutting down`);
        await app.close();
        await closeDb();
        log.info('shutdown complete');
        process.exit(0);
      })();
    });
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'failed to start api');
  process.exit(1);
});
