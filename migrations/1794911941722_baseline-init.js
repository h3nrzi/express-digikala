/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql('DROP EXTENSION IF EXISTS "uuid-ossp";');
  pgm.sql('DROP EXTENSION IF EXISTS "pgcrypto";');
};
