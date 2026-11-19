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
    -- Update sellers status check constraint to include 'suspended'
    ALTER TABLE sellers DROP CONSTRAINT IF EXISTS chk_sellers_status;
    ALTER TABLE sellers ADD CONSTRAINT chk_sellers_status CHECK (status IN ('pending-review', 'under-review', 'active', 'rejected', 'suspended'));

    -- Create third-party seller offers table
    CREATE TABLE IF NOT EXISTS offers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
      variant_id UUID NOT NULL,
      price BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      is_purchasable BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_offers_status CHECK (status IN ('active', 'deactivated', 'pending-inventory', 'held-for-review'))
    );

    CREATE INDEX IF NOT EXISTS idx_offers_seller_id ON offers(seller_id);
    CREATE INDEX IF NOT EXISTS idx_offers_variant_id ON offers(variant_id);
    CREATE INDEX IF NOT EXISTS idx_offers_status_purchasable ON offers(status, is_purchasable);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS offers;

    ALTER TABLE sellers DROP CONSTRAINT IF EXISTS chk_sellers_status;
    ALTER TABLE sellers ADD CONSTRAINT chk_sellers_status CHECK (status IN ('pending-review', 'under-review', 'active', 'rejected'));
  `);
};
