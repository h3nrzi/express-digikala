import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import type { Express } from 'express';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createApp } from '../../src/app.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';
import type { IdentityService } from '../../src/modules/identity/service.js';
import type { OperationalRole } from '../../src/modules/identity/domain/roles.js';

describe('RBAC & Internal Role Middleware Integration', () => {
  let pool: Pool;
  let app: Express;
  let smsSender: InMemorySmsSender;
  let identityService: IdentityService;

  beforeAll(async () => {
    const config = loadConfig({}, { loadDotenv: false });
    pool = createDbPool({ connectionString: config.testDatabaseUrl });
    smsSender = new InMemorySmsSender();
    const appContext = createApp({
      pool,
      config: {
        ...config,
        jwtSecret: 'test-rbac-secret-key-that-is-long-enough',
        otpTtlSeconds: 120,
        otpRateLimitMaxAttempts: 5,
        otpRateLimitWindowSeconds: 60,
      },
      smsSender,
    });

    app = appContext.app;
    identityService = appContext.identityService;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_invites');
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');
    smsSender.clear();
  });

  /**
   * Helper to onboard a verified operational user with specified roles and return their MFA session token.
   */
  async function createVerifiedUserWithRoles(
    email: string,
    phone: string,
    roles: OperationalRole[],
  ): Promise<{ sessionToken: string; userId: string; email: string }> {
    // Direct seed into user_accounts for clean test setup
    const userRes = await pool.query<{ id: string }>(
      `
      INSERT INTO user_accounts (email, phone, password_hash, roles, status)
      VALUES ($1, $2, 'dummyhash', $3, 'active')
      RETURNING id;
      `,
      [email, phone, roles],
    );
    const userId = userRes.rows[0]!.id;

    const sessionToken = `test-token-${email.replace(/[^a-z0-9]/gi, '')}-${Date.now()}-${Math.random()}`;
    await pool.query(
      `
      INSERT INTO internal_sessions (user_id, session_token, mfa_verified, expires_at)
      VALUES ($1, $2, TRUE, NOW() + INTERVAL '24 hours');
      `,
      [userId, sessionToken],
    );

    return { sessionToken, userId, email };
  }

  describe('Unauthenticated and Unverified Access Rejections', () => {
    const internalEndpoints = [
      { method: 'get', path: '/api/v1/admin/me' },
      { method: 'get', path: '/api/v1/admin/sellers' },
      { method: 'get', path: '/api/v1/admin/catalog' },
      { method: 'get', path: '/api/v1/admin/orders' },
      { method: 'get', path: '/api/v1/admin/support' },
      { method: 'get', path: '/api/v1/admin/finance' },
      { method: 'post', path: '/api/v1/admin/users/invite' },
      { method: 'post', path: '/api/v1/admin/users/00000000-0000-0000-0000-000000000001/roles' },
    ];

    it.each(internalEndpoints)(
      'rejects unauthenticated request to $method $path with 401 Unauthorized',
      async ({ method, path }) => {
        const res =
          method === 'get' ? await request(app).get(path) : await request(app).post(path).send({});
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
      },
    );

    it('rejects unverified MFA sessions with 403 MFA_REQUIRED', async () => {
      // Create a user with unverified session
      const userRes = await pool.query<{ id: string }>(
        `
        INSERT INTO user_accounts (email, phone, roles, status)
        VALUES ('unverified@marketplace.ir', '+989129998877', ARRAY['catalog'], 'active')
        RETURNING id;
        `,
      );
      const userId = userRes.rows[0]!.id;

      const unverifiedToken = 'unverified-session-token-xyz';
      await pool.query(
        `
        INSERT INTO internal_sessions (user_id, session_token, mfa_verified, expires_at)
        VALUES ($1, $2, FALSE, NOW() + INTERVAL '1 hour');
        `,
        [userId, unverifiedToken],
      );

      const res = await request(app)
        .get('/api/v1/admin/catalog')
        .set('Authorization', `Bearer ${unverifiedToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MFA_REQUIRED');
    });
  });

  describe('Operational Role Matrix & Boundary Enforcement', () => {
    const roleRoutes: Array<{
      role: OperationalRole;
      method: 'get' | 'post';
      path: string;
      body?: Record<string, unknown>;
      name: string;
    }> = [
      {
        role: 'seller-mgmt',
        method: 'get',
        path: '/api/v1/admin/sellers',
        name: 'Seller Management',
      },
      { role: 'catalog', method: 'get', path: '/api/v1/admin/catalog', name: 'Catalog' },
      { role: 'order-ops', method: 'get', path: '/api/v1/admin/orders', name: 'Order Operations' },
      { role: 'support', method: 'get', path: '/api/v1/admin/support', name: 'Support' },
      { role: 'finance', method: 'get', path: '/api/v1/admin/finance', name: 'Finance' },
      {
        role: 'access-admin',
        method: 'post',
        path: '/api/v1/admin/users/invite',
        body: { email: 'cross.invite@marketplace.ir', phone: '09128881122' },
        name: 'Access Admin',
      },
    ];

    it('allows each single role to reach its dedicated route group', async () => {
      for (let i = 0; i < roleRoutes.length; i++) {
        const target = roleRoutes[i]!;
        const user = await createVerifiedUserWithRoles(
          `${target.role}@marketplace.ir`,
          `+9891200000${i + 10}`,
          [target.role],
        );

        if (target.method === 'get') {
          const res = await request(app)
            .get(target.path)
            .set('Authorization', `Bearer ${user.sessionToken}`);

          expect(res.status).toBe(200);
          expect(res.body.status).toBe('ok');
          expect(res.body.group).toBe(target.role);
        } else {
          const res = await request(app)
            .post(target.path)
            .set('Authorization', `Bearer ${user.sessionToken}`)
            .send(target.body);

          expect(res.status).toBe(201);
          expect(res.body.success).toBe(true);
        }
      }
    });

    it('rejects each single role from every OTHER role route group with 403 Forbidden', async () => {
      for (let i = 0; i < roleRoutes.length; i++) {
        const currentUserDef = roleRoutes[i]!;
        const user = await createVerifiedUserWithRoles(
          `isolated.${currentUserDef.role}@marketplace.ir`,
          `+9891211100${i + 20}`,
          [currentUserDef.role],
        );

        for (const targetRoute of roleRoutes) {
          if (targetRoute.role !== currentUserDef.role) {
            const req =
              targetRoute.method === 'get'
                ? request(app).get(targetRoute.path)
                : request(app).post(targetRoute.path).send(targetRoute.body);

            const res = await req.set('Authorization', `Bearer ${user.sessionToken}`);

            expect(res.status).toBe(403);
            expect(res.body.code).toBe('FORBIDDEN');
          }
        }
      }
    });
  });

  describe('Separation of Duties (SoD): access-admin Exclusions', () => {
    it('strictly forbids access-admin from reaching finance routes', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.alone@marketplace.ir',
        '+989123000001',
        ['access-admin'],
      );

      const res = await request(app)
        .get('/api/v1/admin/finance')
        .set('Authorization', `Bearer ${admin.sessionToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('strictly forbids access-admin from reaching order-ops routes', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.alone2@marketplace.ir',
        '+989123000002',
        ['access-admin'],
      );

      const res = await request(app)
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${admin.sessionToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('strictly excludes access-admin from finance even if assigned BOTH access-admin and finance', async () => {
      const dualUser = await createVerifiedUserWithRoles(
        'admin.finance.dual@marketplace.ir',
        '+989123000003',
        ['access-admin', 'finance'],
      );

      const res = await request(app)
        .get('/api/v1/admin/finance')
        .set('Authorization', `Bearer ${dualUser.sessionToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('strictly excludes access-admin from order-ops even if assigned BOTH access-admin and order-ops', async () => {
      const dualUser = await createVerifiedUserWithRoles(
        'admin.ops.dual@marketplace.ir',
        '+989123000004',
        ['access-admin', 'order-ops'],
      );

      const res = await request(app)
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${dualUser.sessionToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  describe('Role Management Endpoint (POST /api/v1/admin/users/:id/roles)', () => {
    it('rejects non-access-admin caller with 403 Forbidden', async () => {
      const nonAdmin = await createVerifiedUserWithRoles(
        'finance.user@marketplace.ir',
        '+989124000001',
        ['finance'],
      );

      const target = await createVerifiedUserWithRoles(
        'target.user@marketplace.ir',
        '+989124000002',
        ['support'],
      );

      const res = await request(app)
        .post(`/api/v1/admin/users/${target.userId}/roles`)
        .set('Authorization', `Bearer ${nonAdmin.sessionToken}`)
        .send({ roles: ['support', 'catalog'] });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('rejects access-admin from granting roles they do NOT hold', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.only@marketplace.ir',
        '+989124000003',
        ['access-admin'], // does NOT hold finance
      );

      const target = await createVerifiedUserWithRoles(
        'target.user2@marketplace.ir',
        '+989124000004',
        ['support'],
      );

      const res = await request(app)
        .post(`/api/v1/admin/users/${target.userId}/roles`)
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({ roles: ['support', 'finance'] }); // trying to grant 'finance'

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');

      // Check DB unchanged
      const targetInDb = await identityService.getUserById(target.userId);
      expect(targetInDb?.roles).toEqual(['support']);
    });

    it('allows access-admin to grant roles they DO hold', async () => {
      const privilegedAdmin = await createVerifiedUserWithRoles(
        'admin.catalog@marketplace.ir',
        '+989124000005',
        ['access-admin', 'catalog'],
      );

      const target = await createVerifiedUserWithRoles(
        'target.user3@marketplace.ir',
        '+989124000006',
        ['support'],
      );

      const res = await request(app)
        .post(`/api/v1/admin/users/${target.userId}/roles`)
        .set('Authorization', `Bearer ${privilegedAdmin.sessionToken}`)
        .send({ roles: ['support', 'catalog'] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.roles).toContain('support');
      expect(res.body.user.roles).toContain('catalog');

      // Check DB updated
      const targetInDb = await identityService.getUserById(target.userId);
      expect(targetInDb?.roles).toContain('catalog');
    });

    it('allows access-admin to revoke roles from a user', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.revoker@marketplace.ir',
        '+989124000007',
        ['access-admin'],
      );

      const target = await createVerifiedUserWithRoles(
        'target.user4@marketplace.ir',
        '+989124000008',
        ['catalog', 'support'],
      );

      // Revoke support by omitting it from roles list
      const res = await request(app)
        .post(`/api/v1/admin/users/${target.userId}/roles`)
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({ roles: ['catalog'] });

      expect(res.status).toBe(200);
      expect(res.body.user.roles).toEqual(['catalog']);

      const targetInDb = await identityService.getUserById(target.userId);
      expect(targetInDb?.roles).toEqual(['catalog']);
    });

    it('returns 404 NOT_FOUND when target user does not exist', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.lookup@marketplace.ir',
        '+989124000009',
        ['access-admin'],
      );

      const res = await request(app)
        .post('/api/v1/admin/users/00000000-0000-0000-0000-999999999999/roles')
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({ roles: ['access-admin'] });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });
});
