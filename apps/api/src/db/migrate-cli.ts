import { runMigrations } from './migrate.js';

try {
  // runMigrations logs its own outcome in ECS form; nothing to add here.
  await runMigrations();
  process.exit(0);
} catch {
  process.exit(1);
}
