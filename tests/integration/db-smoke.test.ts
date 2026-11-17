import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool, checkDatabaseConnection } from '../../src/db/index.js';
import { DEFAULT_TEST_DB_URL } from '../../src/config/index.js';

describe('Database Integration Smoke Test', () => {
  let pool: Pool;
  const testDbUrl = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DB_URL;

  beforeAll(() => {
    pool = createDbPool({
      connectionString: testDbUrl,
      max: 5,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('connects to Postgres and verifies healthcheck via checkDatabaseConnection', async () => {
    const isHealthy = await checkDatabaseConnection(pool);
    expect(isHealthy).toBe(true);
  });

  it('returns false when database connection fails rather than throwing', async () => {
    const badPool = createDbPool({
      connectionString: 'postgresql://invalid_user:invalid_password@localhost:5433/nonexistent',
      connectionTimeoutMillis: 1000,
    });
    try {
      const isHealthy = await checkDatabaseConnection(badPool);
      expect(isHealthy).toBe(false);
    } finally {
      await badPool.end();
    }
  });

  it('executes a basic query against the database', async () => {
    const result = await pool.query<{ sum: number }>('SELECT 1 + 1 AS sum');
    expect(result.rows[0]?.sum).toBe(2);
  });
});
