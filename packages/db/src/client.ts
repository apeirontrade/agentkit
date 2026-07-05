import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

/** Lazily create a single pooled client per process. */
export function getPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!pool) {
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}

export function getDb(
  connectionString?: string,
): NodePgDatabase<typeof schema> {
  return drizzle(getPool(connectionString), { schema });
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export { schema };
