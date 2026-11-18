import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/errors.js';
import type { InternalSessionUser } from '../../src/modules/identity/service.js';
import type { OperationalRole } from '../../src/modules/identity/domain/roles.js';

describe('IdentityService.updateUserRoles Seam', () => {
  let pool: Pool;
  let identityService: IdentityService;
  let smsSender: InMemorySmsSender;

  beforeAll(async () => {
    const config = loadConfig({}, { loadDotenv: false });
    pool = createDbPool({ connectionString: config.testDatabaseUrl });
    smsSender = new InMemorySmsSender();
    identityService = new IdentityService(pool, smsSender, {
      jwtSecret: 'test-secret',
      jwtExpiresIn: '1h',
      otpTtlSeconds: 120,
      otpRateLimitMaxAttempts: 5,
      otpRateLimitWindowSeconds: 60,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_invites');
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');
  });

  // Helper to create an operational user directly in the database
  async function createTestUser(email: string, phone: string, roles: string[] = []) {
    const res = await pool.query<{ id: string; email: string; phone: string; roles: string[] }>(
      `
      INSERT INTO user_accounts (email, phone, password_hash, roles, status)
      VALUES ($1, $2, 'dummyhash', $3, 'active')
      RETURNING id, email, phone, roles;
      `,
      [email, phone, roles],
    );
    return res.rows[0]!;
  }

  it('allows granter to grant roles that they hold', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin.catalog@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin', 'catalog'],
      mfaVerified: true,
    };

    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', []);

    const updated = await identityService.updateUserRoles({
      userId: targetUser.id,
      granterUser: granter,
      roles: ['catalog'],
    });

    expect(updated.roles).toEqual(['catalog']);

    // Verify persisted in DB
    const persisted = await identityService.getUserById(targetUser.id);
    expect(persisted?.roles).toEqual(['catalog']);
  });

  it('rejects granter from granting roles they do NOT hold with ForbiddenError', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'pure.admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'], // does NOT hold finance or order-ops
      mfaVerified: true,
    };

    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', []);

    await expect(
      identityService.updateUserRoles({
        userId: targetUser.id,
        granterUser: granter,
        roles: ['finance'],
      }),
    ).rejects.toThrow(ForbiddenError);

    // Target roles remain unchanged in DB
    const persisted = await identityService.getUserById(targetUser.id);
    expect(persisted?.roles).toEqual([]);
  });

  it('allows granter to revoke roles even if granter does not hold the revoked role', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'pure.admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    // Target user currently holds finance
    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', ['finance']);

    // Admin revokes finance by setting roles to []
    const updated = await identityService.updateUserRoles({
      userId: targetUser.id,
      granterUser: granter,
      roles: [],
    });

    expect(updated.roles).toEqual([]);
  });

  it('allows granter to grant role A (which they hold) while retaining existing role B', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin.catalog@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin', 'catalog'],
      mfaVerified: true,
    };

    // Target user already holds finance
    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', ['finance']);

    // Granter adds catalog. Target will now have [finance, catalog].
    // Since finance was already held, it was not newly granted.
    // Catalog is newly granted, and granter holds catalog.
    const updated = await identityService.updateUserRoles({
      userId: targetUser.id,
      granterUser: granter,
      roles: ['finance', 'catalog'],
    });

    expect(updated.roles).toContain('finance');
    expect(updated.roles).toContain('catalog');
  });

  it('throws NotFoundError when target user does not exist', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    await expect(
      identityService.updateUserRoles({
        userId: '11111111-1111-1111-1111-111111111111',
        granterUser: granter,
        roles: [],
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError when userId format is not a valid UUID', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    await expect(
      identityService.updateUserRoles({
        userId: 'not-a-valid-uuid',
        granterUser: granter,
        roles: [],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when role name is invalid', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', []);

    await expect(
      identityService.updateUserRoles({
        userId: targetUser.id,
        granterUser: granter,
        roles: ['super-god-role' as unknown as OperationalRole],
      }),
    ).rejects.toThrow(ValidationError);
  });
});
