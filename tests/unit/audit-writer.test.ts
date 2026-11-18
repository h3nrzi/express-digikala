import { describe, expect, it } from 'vitest';
import { recordAuditEvent } from '../../src/modules/audit/index.js';
import { ValidationError } from '../../src/errors.js';
import type { Queryable } from '../../src/modules/audit/types.js';

describe('recordAuditEvent Unit Validations', () => {
  const fakeDb: Queryable = {
    query: async () => ({
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      rows: [],
      fields: [],
    }),
  };

  it('rejects recording an event with missing or empty actorType', async () => {
    await expect(
      recordAuditEvent(fakeDb, {
        actorType: '',
        action: 'seller.created',
        entityType: 'seller',
        entityId: 'seller-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects recording an event with missing or empty action', async () => {
    await expect(
      recordAuditEvent(fakeDb, {
        actorType: 'system',
        action: '   ',
        entityType: 'seller',
        entityId: 'seller-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects recording an event with missing or empty entityType', async () => {
    await expect(
      recordAuditEvent(fakeDb, {
        actorType: 'user',
        action: 'seller.approved',
        entityType: '',
        entityId: 'seller-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects recording an event with missing or empty entityId', async () => {
    await expect(
      recordAuditEvent(fakeDb, {
        actorType: 'user',
        action: 'seller.approved',
        entityType: 'seller',
        entityId: '   ',
      }),
    ).rejects.toThrow(ValidationError);
  });
});
