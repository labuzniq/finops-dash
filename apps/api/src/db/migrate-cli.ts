import { runMigrations } from './migrate.js';

try {
  await runMigrations();
  console.log('migrations applied');
  process.exit(0);
} catch (error) {
  console.error('migration failed', error);
  process.exit(1);
}
