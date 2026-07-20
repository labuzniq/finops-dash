import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  connection: { search_path: env.DB_SCHEMA },
});

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await queryClient.end();
}
