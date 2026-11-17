import pg from 'pg';
import { DEFAULT_DEV_DB_URL } from '../config/index.js';

const { Pool } = pg;

export interface DbConfig {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export function createDbPool(config: DbConfig = {}): pg.Pool {
  const connectionString =
    config.connectionString ?? process.env['DATABASE_URL'] ?? DEFAULT_DEV_DB_URL;

  return new Pool({
    connectionString,
    max: config.max ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
  });
}

export async function checkDatabaseConnection(pool: pg.Pool): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      const res = await client.query<{ ok: number }>('SELECT 1 AS ok');
      return res.rows[0]?.ok === 1;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}
