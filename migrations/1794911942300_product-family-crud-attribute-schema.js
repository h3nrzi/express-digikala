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
    -- Create category attribute schemas table
    CREATE TABLE IF NOT EXISTS category_attribute_schemas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category VARCHAR(100) NOT NULL UNIQUE,
      required_attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
      optional_attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_category_schemas_category ON category_attribute_schemas(category);

    -- Create product families table
    CREATE TABLE IF NOT EXISTS product_families (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(100) NOT NULL,
      attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      original_family_id UUID REFERENCES product_families(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      approved_by UUID REFERENCES user_accounts(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_product_families_status CHECK (status IN ('draft', 'approved', 'archived'))
    );

    CREATE INDEX IF NOT EXISTS idx_product_families_category ON product_families(category);
    CREATE INDEX IF NOT EXISTS idx_product_families_status ON product_families(status);
    CREATE INDEX IF NOT EXISTS idx_product_families_status_category ON product_families(status, category);
    CREATE INDEX IF NOT EXISTS idx_product_families_created_at ON product_families(created_at DESC);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS product_families;
    DROP TABLE IF EXISTS category_attribute_schemas;
  `);
};
