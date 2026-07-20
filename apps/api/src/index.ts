import { buildApp } from './app.js';
import { closeDb } from './db/client.js';
import { env } from './env.js';
import { runMigrations } from './db/migrate.js';

async function main(): Promise<void> {
  await runMigrations();

  const app = await buildApp();

  await app.listen({ port: env.API_PORT, host: env.HOST });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        app.log.info(`${signal} received — shutting down`);
        await app.close();
        await closeDb();
        process.exit(0);
      })();
    });
  }
}

main().catch((error: unknown) => {
  console.error('failed to start api', error);
  process.exit(1);
});
