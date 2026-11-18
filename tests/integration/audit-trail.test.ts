import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { createDbPool, withTransaction } from '../../src/db/index.js';
import { DEFAULT_TEST_DB_URL } from '../../src/config/index.js';
import {
  findAuditEventById,
  findAuditEventsByEntity,
  recordAuditEvent,
} from '../../src/modules/audit/index.js';

describe('Audit Trail Database Immutability & Shared Writer', () => {
  let pool: Pool;
  const testDbUrl = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DB_URL;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: testDbUrl });

    // Refresh migration to ensure latest trigger definition and check constraints are applied
    await runner({
      databaseUrl: testDbUrl,
      dir: 'migrations',
      direction: 'down',
      count: 1,
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    await runner({
      databaseUrl: testDbUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Database Schema & Immutability Trigger', () => {
    it('creates audit_events table with all required columns and constraints', async () => {
      const columnsResult = await pool.query<{ column_name: string; data_type: string }>(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'audit_events'
        ORDER BY ordinal_position ASC;
      `);

      const columnNames = columnsResult.rows.map((r) => r.column_name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('occurred_at');
      expect(columnNames).toContain('actor_type');
      expect(columnNames).toContain('actor_id');
      expect(columnNames).toContain('action');
      expect(columnNames).toContain('entity_type');
      expect(columnNames).toContain('entity_id');
      expect(columnNames).toContain('previous_value');
      expect(columnNames).toContain('new_value');
      expect(columnNames).toContain('reason');
      expect(columnNames).toContain('linked_event_id');
    });

    it('rejects direct SQL UPDATE queries via statement-level trigger even if zero rows match', async () => {
      const event = await recordAuditEvent(pool, {
        actorType: 'system',
        actorId: 'sys-immutability-1',
        action: 'seller.created',
        entityType: 'seller',
        entityId: 'seller-immutability-1',
        reason: 'Initial onboarding',
      });

      // Target exact row
      await expect(
        pool.query(`UPDATE audit_events SET reason = 'tampered reason' WHERE id = $1`, [event.id]),
      ).rejects.toThrow(/append-only/i);

      // Target zero rows (statement-level trigger blocks statement unconditionally)
      await expect(
        pool.query(`UPDATE audit_events SET reason = 'tampered' WHERE 1 = 0`),
      ).rejects.toThrow(/append-only/i);
    });

    it('rejects direct SQL DELETE queries via statement-level trigger even if zero rows match', async () => {
      const event = await recordAuditEvent(pool, {
        actorType: 'user',
        actorId: 'user-immutability-1',
        action: 'order.cancelled',
        entityType: 'buyer_order',
        entityId: 'ord-immutability-1',
        reason: 'Buyer cancellation',
      });

      // Target exact row
      await expect(
        pool.query(`DELETE FROM audit_events WHERE id = $1`, [event.id]),
      ).rejects.toThrow(/append-only/i);

      // Target zero rows
      await expect(pool.query(`DELETE FROM audit_events WHERE 1 = 0`)).rejects.toThrow(
        /append-only/i,
      );
    });

    it('rejects direct SQL TRUNCATE queries via database-level trigger', async () => {
      await expect(pool.query(`TRUNCATE TABLE audit_events`)).rejects.toThrow(/append-only/i);
    });

    it('enforces database check constraint rejecting invalid actor_type', async () => {
      await expect(
        pool.query(`
          INSERT INTO audit_events (
            actor_type, action, entity_type, entity_id
          ) VALUES ('invalid_actor', 'seller.created', 'seller', 's-1')
        `),
      ).rejects.toThrow(/chk_audit_events_actor_type/i);
    });
  });

  describe('Shared Writer Utility (recordAuditEvent & Readers)', () => {
    it('records an audit event with JSONB before/after values and reads it back faithfully', async () => {
      const entityId = `seller-${Date.now()}`;
      const previousValue = { status: 'pending-review', commission_rate: 0.05 };
      const newValue = { status: 'active', commission_rate: 0.08 };

      const createdEvent = await recordAuditEvent(pool, {
        actorType: 'user',
        actorId: 'admin-user-uuid',
        action: 'seller.approved',
        entityType: 'seller',
        entityId,
        previousValue,
        newValue,
        reason: 'Merchant documentation verified',
      });

      expect(createdEvent.id).toBeDefined();
      expect(createdEvent.occurredAt).toBeInstanceOf(Date);
      expect(createdEvent.actorType).toBe('user');
      expect(createdEvent.actorId).toBe('admin-user-uuid');
      expect(createdEvent.action).toBe('seller.approved');
      expect(createdEvent.entityType).toBe('seller');
      expect(createdEvent.entityId).toBe(entityId);
      expect(createdEvent.previousValue).toEqual(previousValue);
      expect(createdEvent.newValue).toEqual(newValue);
      expect(createdEvent.reason).toBe('Merchant documentation verified');
      expect(createdEvent.linkedEventId).toBeNull();

      // Read back via findAuditEventById
      const fetchedById = await findAuditEventById(pool, createdEvent.id);
      expect(fetchedById).toEqual(createdEvent);

      // Read back via findAuditEventsByEntity
      const events = await findAuditEventsByEntity(pool, 'seller', entityId);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(createdEvent);
    });

    it('records corrective audit events with linkedEventId instead of overwriting', async () => {
      const entityId = `order-${Date.now()}`;

      // 1. Initial event
      const initialEvent = await recordAuditEvent(pool, {
        actorType: 'user',
        actorId: 'support-agent-1',
        action: 'order.address_updated',
        entityType: 'buyer_order',
        entityId,
        previousValue: { postalCode: '1111111111' },
        newValue: { postalCode: '2222222222' },
        reason: 'Buyer requested address correction',
      });

      // 2. Corrective event linking back to initial event
      const correctiveEvent = await recordAuditEvent(pool, {
        actorType: 'user',
        actorId: 'support-supervisor',
        action: 'order.address_corrected',
        entityType: 'buyer_order',
        entityId,
        previousValue: { postalCode: '2222222222' },
        newValue: { postalCode: '3333333333' },
        reason: 'Supervisor override: corrected unit number and postal code',
        linkedEventId: initialEvent.id,
      });

      expect(correctiveEvent.linkedEventId).toBe(initialEvent.id);

      // Query entity timeline
      const timeline = await findAuditEventsByEntity(pool, 'buyer_order', entityId);
      expect(timeline).toHaveLength(2);
      expect(timeline[0]?.id).toBe(initialEvent.id);
      expect(timeline[1]?.id).toBe(correctiveEvent.id);
      expect(timeline[1]?.linkedEventId).toBe(initialEvent.id);

      // Verify initial event was not modified
      const originalUnchanged = await findAuditEventById(pool, initialEvent.id);
      expect(originalUnchanged?.newValue).toEqual({ postalCode: '2222222222' });
    });
  });

  describe('Transactional Atomicity with withTransaction', () => {
    it('commits both entity state change and audit event together on success', async () => {
      const phone = `+98912${Math.floor(1000000 + Math.random() * 9000000)}`;

      // Use withTransaction to insert a user account and record its creation audit event
      const result = await withTransaction(pool, async (client) => {
        const userInsertRes = await client.query<{ id: string; phone: string }>(
          `INSERT INTO user_accounts (phone, status) VALUES ($1, 'active') RETURNING id, phone;`,
          [phone],
        );
        const user = userInsertRes.rows[0]!;

        const audit = await recordAuditEvent(client, {
          actorType: 'system',
          actorId: 'system-job',
          action: 'user.created',
          entityType: 'user_account',
          entityId: user.id,
          newValue: { phone: user.phone, status: 'active' },
          reason: 'Automated user account provisioning',
        });

        return { user, audit };
      });

      // Assert user exists in database
      const userCheck = await pool.query<{ id: string }>(
        `SELECT id FROM user_accounts WHERE id = $1;`,
        [result.user.id],
      );
      expect(userCheck.rows).toHaveLength(1);

      // Assert audit event exists in database
      const auditCheck = await findAuditEventById(pool, result.audit.id);
      expect(auditCheck).not.toBeNull();
      expect(auditCheck?.entityId).toBe(result.user.id);
    });

    it('rolls back both entity state change and audit event when transaction fails', async () => {
      const phone = `+98912${Math.floor(1000000 + Math.random() * 9000000)}`;
      let capturedUserId: string | null = null;
      let capturedAuditId: string | null = null;

      await expect(
        withTransaction(pool, async (client) => {
          const userInsertRes = await client.query<{ id: string; phone: string }>(
            `INSERT INTO user_accounts (phone, status) VALUES ($1, 'active') RETURNING id, phone;`,
            [phone],
          );
          const user = userInsertRes.rows[0]!;
          capturedUserId = user.id;

          const audit = await recordAuditEvent(client, {
            actorType: 'user',
            actorId: 'operator-1',
            action: 'user.provision_attempt',
            entityType: 'user_account',
            entityId: user.id,
            newValue: { phone: user.phone },
            reason: 'Should roll back',
          });
          capturedAuditId = audit.id;

          // Intentionally throw an unhandled error inside transaction
          throw new Error('Simulated operational failure during multi-step operation');
        }),
      ).rejects.toThrow('Simulated operational failure during multi-step operation');

      // Assert business entity was rolled back
      expect(capturedUserId).not.toBeNull();
      const userCheck = await pool.query<{ id: string }>(
        `SELECT id FROM user_accounts WHERE id = $1;`,
        [capturedUserId],
      );
      expect(userCheck.rows).toHaveLength(0);

      // Assert audit event was also rolled back
      expect(capturedAuditId).not.toBeNull();
      const auditCheck = await findAuditEventById(pool, capturedAuditId!);
      expect(auditCheck).toBeNull();
    });
  });
});
