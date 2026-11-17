import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { createDbPool } from '../../src/db/index.js';
import { DEFAULT_TEST_DB_URL } from '../../src/config/index.js';

describe('Database Migration Runner', () => {
  let pool: Pool;
  const testDbUrl = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DB_URL;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: testDbUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies baseline migration cleanly and creates pgmigrations table', async () => {
    // Run migrations up using runner API
    await runner({
      databaseUrl: testDbUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    // Check pgmigrations table exists and has entries
    const migrationsResult = await pool.query<{ name: string }>(
      'SELECT name FROM pgmigrations ORDER BY id ASC',
    );
    expect(migrationsResult.rows.length).toBeGreaterThanOrEqual(1);
    expect(migrationsResult.rows[0]?.name).toContain('baseline-init');

    // Verify extensions installed by baseline migration
    const extensionResult = await pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'pgcrypto')",
    );
    const installedExts = extensionResult.rows.map((r) => r.extname);
    expect(installedExts).toContain('uuid-ossp');
    expect(installedExts).toContain('pgcrypto');

    // Verify uuid generation function works
    const uuidResult = await pool.query<{ uuid: string }>('SELECT uuid_generate_v4() AS uuid');
    expect(uuidResult.rows[0]?.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
