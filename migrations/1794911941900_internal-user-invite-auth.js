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
    -- Extend user_accounts for internal operational credentials and roles
    ALTER TABLE user_accounts
      ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS full_name VARCHAR(100) NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_email ON user_accounts(email) WHERE email IS NOT NULL;

    -- Table for onboarding operational users via invitation
    CREATE TABLE IF NOT EXISTS user_invites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      roles TEXT[] NOT NULL DEFAULT '{}',
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      invited_by UUID NULL REFERENCES user_accounts(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_user_invites_token_hash ON user_invites(token_hash);
    CREATE INDEX IF NOT EXISTS idx_user_invites_email ON user_invites(email);

    -- Table for internal sessions requiring second-factor verification (MFA)
    CREATE TABLE IF NOT EXISTS internal_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
      session_token VARCHAR(128) NOT NULL UNIQUE,
      mfa_verified BOOLEAN NOT NULL DEFAULT FALSE,
      mfa_code_hash VARCHAR(64) NULL,
      mfa_expires_at TIMESTAMPTZ NULL,
      mfa_attempts INT NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_internal_sessions_token ON internal_sessions(session_token);
    CREATE INDEX IF NOT EXISTS idx_internal_sessions_user ON internal_sessions(user_id);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS internal_sessions;
    DROP TABLE IF EXISTS user_invites;
    DROP INDEX IF EXISTS idx_user_accounts_email;
    ALTER TABLE user_accounts
      DROP COLUMN IF EXISTS full_name,
      DROP COLUMN IF EXISTS roles,
      DROP COLUMN IF EXISTS password_hash,
      DROP COLUMN IF EXISTS email;
  `);
};
