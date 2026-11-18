/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- Create third-party sellers table with lifecycle status and unique taxpayer ID
    CREATE TABLE IF NOT EXISTS sellers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      taxpayer_id VARCHAR(100) NOT NULL,
      contact JSONB NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending-review',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_sellers_taxpayer_id UNIQUE (taxpayer_id),
      CONSTRAINT chk_sellers_status CHECK (status IN ('pending-review', 'under-review', 'active', 'rejected'))
    );

    -- Indexes for querying by lifecycle status and created_at ordering
    CREATE INDEX IF NOT EXISTS idx_sellers_status ON sellers(status);
    CREATE INDEX IF NOT EXISTS idx_sellers_created_at ON sellers(created_at DESC);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS sellers;
  `);
};
