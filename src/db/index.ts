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

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
