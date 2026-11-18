import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import type { Express } from 'express';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createApp } from '../../src/app.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';
import { findAuditEventsByEntity } from '../../src/modules/audit/index.js';
import type { OperationalRole } from '../../src/modules/identity/domain/roles.js';

describe('Seller Application & Review Lifecycle API (Integration)', () => {
  let pool: Pool;
  let app: Express;
  let smsSender: InMemorySmsSender;

  beforeAll(async () => {
    const config = loadConfig({}, { loadDotenv: false });
    pool = createDbPool({ connectionString: config.testDatabaseUrl });
    smsSender = new InMemorySmsSender();
    const appContext = createApp({
      pool,
      config: {
        ...config,
        jwtSecret: 'test-seller-secret-key-that-is-long-enough',
        otpTtlSeconds: 120,
        otpRateLimitMaxAttempts: 5,
        otpRateLimitWindowSeconds: 60,
      },
      smsSender,
    });
    app = appContext.app;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM sellers');
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_invites');
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');
    smsSender.clear();
  });

  async function createVerifiedUser(
    email: string,
    phone: string,
    roles: OperationalRole[],
  ): Promise<{ sessionToken: string; userId: string }> {
    const userRes = await pool.query<{ id: string }>(
      `
      INSERT INTO user_accounts (email, phone, roles, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING id;
      `,
      [email, phone, roles],
    );
    const userId = userRes.rows[0]!.id;

    const tokenRes = await pool.query<{ session_token: string }>(
      `
      INSERT INTO internal_sessions (user_id, session_token, mfa_verified, expires_at)
      VALUES ($1, md5(random()::text), TRUE, NOW() + INTERVAL '1 hour')
      RETURNING session_token;
      `,
      [userId],
    );

    return {
      sessionToken: tokenRes.rows[0]!.session_token,
      userId,
    };
  }

  describe('Authentication and RBAC boundaries', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/v1/admin/sellers');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects requests from operational users without seller-mgmt role with 403 FORBIDDEN', async () => {
      const catalogUser = await createVerifiedUser('catalog@marketplace.ir', '+989121110011', [
        'catalog',
      ]);

      const res = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${catalogUser.sessionToken}`)
        .send({
          name: 'فروشگاه تستی',
          taxpayerId: '10109990001',
          contact: { phone: '09120001122' },
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('rejects requests with unverified MFA with 403 MFA_REQUIRED', async () => {
      const userRes = await pool.query<{ id: string }>(
        `
        INSERT INTO user_accounts (email, phone, roles, status)
        VALUES ('unverified.seller@marketplace.ir', '+989121110022', ARRAY['seller-mgmt'], 'active')
        RETURNING id;
        `,
      );
      const userId = userRes.rows[0]!.id;

      const unverifiedToken = 'seller-unverified-mfa-token';
      await pool.query(
        `
        INSERT INTO internal_sessions (user_id, session_token, mfa_verified, expires_at)
        VALUES ($1, $2, FALSE, NOW() + INTERVAL '1 hour');
        `,
        [userId, unverifiedToken],
      );

      const res = await request(app)
        .get('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${unverifiedToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MFA_REQUIRED');
    });
  });

  describe('POST /api/v1/admin/sellers', () => {
    it('creates a new seller application in pending-review state', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110033', [
        'seller-mgmt',
      ]);

      const payload = {
        name: 'پارس الکترونیک خاورمیانه',
        taxpayerId: '14009876543',
        contact: {
          phone: '09121234567',
          email: 'contact@parselectronic.ir',
          address: 'تهران، خیابان جمهوری',
        },
      };

      const res = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ok');
      expect(res.body.seller).toBeDefined();
      expect(res.body.seller.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(res.body.seller.name).toBe(payload.name);
      expect(res.body.seller.taxpayerId).toBe(payload.taxpayerId);
      expect(res.body.seller.status).toBe('pending-review');
      expect(res.body.seller.contact).toEqual(payload.contact);
    });

    it('rejects duplicate taxpayerId with 409 Conflict', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110034', [
        'seller-mgmt',
      ]);

      const payload = {
        name: 'فروشگاه آلفا',
        taxpayerId: '10105554433',
        contact: { phone: '09123332211' },
      };

      const res1 = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send(payload);
      expect(res1.status).toBe(201);

      const res2 = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه بتا با کد تکراری',
          taxpayerId: '10105554433',
          contact: { phone: '09123332222' },
        });

      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe('CONFLICT');
    });

    it('validates required fields with 400 VALIDATION_ERROR', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110035', [
        'seller-mgmt',
      ]);

      const res = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: '',
          taxpayerId: '',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.fieldErrors).toBeDefined();
    });
  });

  describe('PATCH /api/v1/admin/sellers/:id/status and Audit Trail', () => {
    it('moves seller through allowed lifecycle: pending-review -> under-review -> active and logs audit per transition', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110036', [
        'seller-mgmt',
      ]);

      // Create seller
      const createRes = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه دیجیتال آریا',
          taxpayerId: '14002233445',
          contact: { phone: '09128889900' },
        });

      expect(createRes.status).toBe(201);
      const sellerId = createRes.body.seller.id;

      // Transition 1: pending-review -> under-review
      const underReviewRes = await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          status: 'under-review',
          reason: 'شروع بررسی مدارک ثبتی و شماره شبا',
        });

      expect(underReviewRes.status).toBe(200);
      expect(underReviewRes.body.status).toBe('ok');
      expect(underReviewRes.body.seller.status).toBe('under-review');

      // Verify audit event 1
      let auditEvents = await findAuditEventsByEntity(pool, 'seller', sellerId);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.actorType).toBe('user');
      expect(auditEvents[0]!.actorId).toBe(sellerStaff.userId);
      expect(auditEvents[0]!.action).toBe('seller.status_transition');
      expect(auditEvents[0]!.previousValue).toEqual({ status: 'pending-review' });
      expect(auditEvents[0]!.newValue).toEqual({ status: 'under-review' });
      expect(auditEvents[0]!.reason).toBe('شروع بررسی مدارک ثبتی و شماره شبا');

      // Transition 2: under-review -> active
      const activeRes = await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          status: 'active',
          reason: 'تأیید قرارداد و فعال‌سازی فروشنده در مارکت‌پلیس',
        });

      expect(activeRes.status).toBe(200);
      expect(activeRes.body.seller.status).toBe('active');

      // Verify audit event 2
      auditEvents = await findAuditEventsByEntity(pool, 'seller', sellerId);
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]!.actorType).toBe('user');
      expect(auditEvents[1]!.actorId).toBe(sellerStaff.userId);
      expect(auditEvents[1]!.action).toBe('seller.status_transition');
      expect(auditEvents[1]!.previousValue).toEqual({ status: 'under-review' });
      expect(auditEvents[1]!.newValue).toEqual({ status: 'active' });
      expect(auditEvents[1]!.reason).toBe('تأیید قرارداد و فعال‌سازی فروشنده در مارکت‌پلیس');
    });

    it('rejects invalid state transition attempts with 400 INVALID_STATE_TRANSITION', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110037', [
        'seller-mgmt',
      ]);

      const createRes = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه جهش نامعتبر',
          taxpayerId: '14003344556',
          contact: { phone: '09121112244' },
        });

      const sellerId = createRes.body.seller.id;

      // Attempt illegal jump from pending-review directly to active
      const res = await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          status: 'active',
          reason: 'جهش غیرمجاز مستقیم به فعال',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');

      // Verify no audit event was logged
      const auditEvents = await findAuditEventsByEntity(pool, 'seller', sellerId);
      expect(auditEvents).toHaveLength(0);
    });

    it('supports rejection: under-review -> rejected', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110038', [
        'seller-mgmt',
      ]);

      const createRes = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه رد صلاحیت',
          taxpayerId: '14005566778',
          contact: { phone: '09129995544' },
        });

      const sellerId = createRes.body.seller.id;

      // First move to under-review
      await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({ status: 'under-review' });

      // Then reject
      const rejectRes = await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          status: 'rejected',
          reason: 'عدم تطابق صنف فعالیت با مجوزهای صنفی',
        });

      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.seller.status).toBe('rejected');

      const auditEvents = await findAuditEventsByEntity(pool, 'seller', sellerId);
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]!.newValue).toEqual({ status: 'rejected' });
    });

    it('returns 404 NOT_FOUND when transitioning non-existent seller', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110039', [
        'seller-mgmt',
      ]);

      const res = await request(app)
        .patch('/api/v1/admin/sellers/00000000-0000-0000-0000-000000000099/status')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({ status: 'under-review' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/admin/sellers and GET /api/v1/admin/sellers/:id', () => {
    it('lists sellers and filters by state', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110040', [
        'seller-mgmt',
      ]);

      // Create two sellers
      const s1 = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشنده لیست یک',
          taxpayerId: '19000000001',
          contact: { phone: '09120000011' },
        });

      const s2 = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشنده لیست دو',
          taxpayerId: '19000000002',
          contact: { phone: '09120000022' },
        });

      // Move s2 to under-review
      await request(app)
        .patch(`/api/v1/admin/sellers/${s2.body.seller.id}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({ status: 'under-review' });

      // List all
      const listAllRes = await request(app)
        .get('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(listAllRes.status).toBe(200);
      expect(listAllRes.body.status).toBe('ok');
      expect(listAllRes.body.group).toBe('seller-mgmt');
      expect(listAllRes.body.sellers).toHaveLength(2);

      // Filter by pending-review
      const pendingRes = await request(app)
        .get('/api/v1/admin/sellers?status=pending-review')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.sellers).toHaveLength(1);
      expect(pendingRes.body.sellers[0].id).toBe(s1.body.seller.id);

      // Filter by under-review
      const underReviewRes = await request(app)
        .get('/api/v1/admin/sellers?status=under-review')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(underReviewRes.status).toBe(200);
      expect(underReviewRes.body.sellers).toHaveLength(1);
      expect(underReviewRes.body.sellers[0].id).toBe(s2.body.seller.id);
    });

    it('returns full seller record by id', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110041', [
        'seller-mgmt',
      ]);

      const createRes = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه جزئیات کامل',
          taxpayerId: '19000000099',
          contact: { phone: '09123334466', email: 'detail@seller.ir' },
        });

      const sellerId = createRes.body.seller.id;

      const getRes = await request(app)
        .get(`/api/v1/admin/sellers/${sellerId}`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('ok');
      expect(getRes.body.seller.id).toBe(sellerId);
      expect(getRes.body.seller.name).toBe('فروشگاه جزئیات کامل');
      expect(getRes.body.seller.taxpayerId).toBe('19000000099');
      expect(getRes.body.seller.contact).toEqual({
        phone: '09123334466',
        email: 'detail@seller.ir',
      });
    });

    it('returns 404 for non-existent seller id', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110042', [
        'seller-mgmt',
      ]);

      const getRes = await request(app)
        .get('/api/v1/admin/sellers/00000000-0000-0000-0000-000000000099')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(getRes.status).toBe(404);
      expect(getRes.body.code).toBe('NOT_FOUND');
    });
  });
});
