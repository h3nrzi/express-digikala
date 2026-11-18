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
    -- Create append-only audit_events table
    CREATE TABLE IF NOT EXISTS audit_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_type VARCHAR(20) NOT NULL,
      actor_id VARCHAR(255) NULL,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      entity_id VARCHAR(255) NOT NULL,
      previous_value JSONB NULL,
      new_value JSONB NULL,
      reason TEXT NULL,
      linked_event_id UUID NULL,
      CONSTRAINT chk_audit_events_actor_type CHECK (actor_type IN ('system', 'user'))
    );

    -- Indexes for querying entity histories and actor timelines
    CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at ON audit_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_type, actor_id);

    -- Function to prevent UPDATE and DELETE modifications at the statement level
    CREATE OR REPLACE FUNCTION prevent_audit_events_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'audit_events is append-only: % operations are prohibited', TG_OP
        USING ERRCODE = '23506';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS audit_events_prevent_mutation ON audit_events;
    CREATE TRIGGER audit_events_prevent_mutation
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_audit_events_mutation();

    -- Function to prevent TRUNCATE operations
    CREATE OR REPLACE FUNCTION prevent_audit_events_truncate()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'audit_events is append-only: TRUNCATE operations are prohibited'
        USING ERRCODE = '23506';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS audit_events_prevent_truncate ON audit_events;
    CREATE TRIGGER audit_events_prevent_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_audit_events_truncate();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS audit_events_prevent_truncate ON audit_events;
    DROP TRIGGER IF EXISTS audit_events_prevent_mutation ON audit_events;
    DROP FUNCTION IF EXISTS prevent_audit_events_truncate();
    DROP FUNCTION IF EXISTS prevent_audit_events_mutation();
    DROP TABLE IF EXISTS audit_events;
  `);
};
