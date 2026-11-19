import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createApp } from '../../src/app.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';
import { findAuditEventsByEntity } from '../../src/modules/audit/index.js';
import type { OperationalRole } from '../../src/modules/identity/domain/roles.js';

describe('Seller Suspension & Reinstatement API (Integration)', () => {
  let pool: Pool;
  let app: Express;
  let smsSender: InMemorySmsSender;
  const JWT_SECRET = 'test-seller-suspension-secret-key-123456';

  beforeAll(async () => {
    const config = loadConfig({}, { loadDotenv: false });
    pool = createDbPool({ connectionString: config.testDatabaseUrl });
    smsSender = new InMemorySmsSender();
    const appContext = createApp({
      pool,
      config: {
        ...config,
        jwtSecret: JWT_SECRET,
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
    await pool.query('DELETE FROM offers');
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

  function createBuyerToken(
    buyerId: string = '00000000-0000-0000-0000-000000000999',
    phone: string = '+989129998877',
  ) {
    return jwt.sign({ sub: buyerId, phone, role: 'buyer' }, JWT_SECRET, { expiresIn: '1h' });
  }

  async function createActiveSeller(
    sellerStaffToken: string,
    params: { name?: string; taxpayerId?: string } = {},
  ): Promise<string> {
    const createRes = await request(app)
      .post('/api/v1/admin/sellers')
      .set('Authorization', `Bearer ${sellerStaffToken}`)
      .send({
        name: params.name ?? 'فروشگاه تست تعلیق',
        taxpayerId: params.taxpayerId ?? '10108877665',
        contact: { phone: '09121112233', email: 'test@suspension.ir' },
      });

    const sellerId = createRes.body.seller.id;

    await request(app)
      .patch(`/api/v1/admin/sellers/${sellerId}/status`)
      .set('Authorization', `Bearer ${sellerStaffToken}`)
      .send({ status: 'under-review', reason: 'بررسی مدارک' });

    await request(app)
      .patch(`/api/v1/admin/sellers/${sellerId}/status`)
      .set('Authorization', `Bearer ${sellerStaffToken}`)
      .send({ status: 'active', reason: 'تأیید اولیه' });

    return sellerId;
  }

  describe('RBAC & Validation for Suspension & Reinstatement endpoints', () => {
    it('requires authentication for suspend and reinstate endpoints', async () => {
      const dummyId = '00000000-0000-0000-0000-000000000123';

      const suspendRes = await request(app)
        .post(`/api/v1/admin/sellers/${dummyId}/suspend`)
        .send({ reason: 'تست' });
      expect(suspendRes.status).toBe(401);

      const reinstateRes = await request(app)
        .post(`/api/v1/admin/sellers/${dummyId}/reinstate`)
        .send({ reason: 'تست' });
      expect(reinstateRes.status).toBe(401);
    });

    it('rejects operational users without seller-mgmt role with 403', async () => {
      const catalogUser = await createVerifiedUser('catalog.user@marketplace.ir', '+989121110011', [
        'catalog',
      ]);
      const dummyId = '00000000-0000-0000-0000-000000000123';

      const suspendRes = await request(app)
        .post(`/api/v1/admin/sellers/${dummyId}/suspend`)
        .set('Authorization', `Bearer ${catalogUser.sessionToken}`)
        .send({ reason: 'کالای تقلبی' });
      expect(suspendRes.status).toBe(403);
      expect(suspendRes.body.code).toBe('FORBIDDEN');

      const reinstateRes = await request(app)
        .post(`/api/v1/admin/sellers/${dummyId}/reinstate`)
        .set('Authorization', `Bearer ${catalogUser.sessionToken}`)
        .send({ reason: 'رفع سوءتفاهم' });
      expect(reinstateRes.status).toBe(403);
      expect(reinstateRes.body.code).toBe('FORBIDDEN');
    });

    it('requires mandatory non-empty reason for suspend endpoint', async () => {
      const sellerStaff = await createVerifiedUser('staff@marketplace.ir', '+989121110022', [
        'seller-mgmt',
      ]);
      const sellerId = await createActiveSeller(sellerStaff.sessionToken);

      // Missing reason
      const res1 = await request(app)
        .post(`/api/v1/admin/sellers/${sellerId}/suspend`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({});
      expect(res1.status).toBe(400);
      expect(res1.body.code).toBe('VALIDATION_ERROR');

      // Empty string reason
      const res2 = await request(app)
        .post(`/api/v1/admin/sellers/${sellerId}/suspend`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({ reason: '   ' });
      expect(res2.status).toBe(400);
      expect(res2.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 for non-existent seller id', async () => {
      const sellerStaff = await createVerifiedUser('staff@marketplace.ir', '+989121110022', [
        'seller-mgmt',
      ]);
      const nonExistentId = '99999999-9999-9999-9999-999999999999';

      const res = await request(app)
        .post(`/api/v1/admin/sellers/${nonExistentId}/suspend`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({ reason: 'تست' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('rejects suspending a seller that is not in active state (400 INVALID_STATE_TRANSITION)', async () => {
      const sellerStaff = await createVerifiedUser('staff@marketplace.ir', '+989121110022', [
        'seller-mgmt',
      ]);
      const createRes = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشنده در انتظار',
          taxpayerId: '10103332211',
          contact: { phone: '09129998877' },
        });
      expect(createRes.status).toBe(201);
      const pendingSellerId = createRes.body.seller.id;

      const res = await request(app)
        .post(`/api/v1/admin/sellers/${pendingSellerId}/suspend`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({ reason: 'تعلیق زودهنگام' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('End-to-End Suspension and Reinstatement Lifecycle', () => {
    it('executes full cycle: active seller with offers -> suspend (offers disappear & cart rejected) -> reinstate (offers reappear & cart accepted) with audit events', async () => {
      const sellerStaff = await createVerifiedUser('staff@marketplace.ir', '+989121110022', [
        'seller-mgmt',
      ]);
      const sellerId = await createActiveSeller(sellerStaff.sessionToken, {
        name: 'فروشگاه دیجی‌پارس',
        taxpayerId: '10107766554',
      });

      const variantId = '11111111-2222-3333-4444-555555555555';
      const offerRes = await pool.query<{ id: string }>(
        `INSERT INTO offers (seller_id, variant_id, price, status, is_purchasable)
         VALUES ($1, $2, 450000, 'active', true)
         RETURNING id;`,
        [sellerId, variantId],
      );
      const offerId = offerRes.rows[0]!.id;

      const buyerToken = createBuyerToken();

      // 1. Initial State: Catalog returns active offer; Buyer can add to cart
      const catalogBeforeSuspend = await request(app).get(
        `/api/v1/catalog/variants/${variantId}/offers`,
      );
      expect(catalogBeforeSuspend.status).toBe(200);
      expect(catalogBeforeSuspend.body.offers).toHaveLength(1);
      expect(catalogBeforeSuspend.body.offers[0].id).toBe(offerId);
      expect(catalogBeforeSuspend.body.offers[0].price).toBe(450000);
      expect(catalogBeforeSuspend.body.offers[0].seller.name).toBe('فروشگاه دیجی‌پارس');

      const cartBeforeSuspend = await request(app)
        .put(`/api/v1/cart/lines/${offerId}`)
        .set('Authorization', `Bearer ${buyerToken}`);
      expect(cartBeforeSuspend.status).toBe(200);
      expect(cartBeforeSuspend.body.status).toBe('ok');

      // 2. Suspend Seller
      const suspendRes = await request(app)
        .post(`/api/v1/admin/sellers/${sellerId}/suspend`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          reason: 'گزارش تخلف شدید در ارسال کالای مغایر با کاتالوگ',
        });

      expect(suspendRes.status).toBe(200);
      expect(suspendRes.body.status).toBe('ok');
      expect(suspendRes.body.seller.status).toBe('suspended');
      expect(suspendRes.body.affectedOffersCount).toBe(1);

      // Verify offer in database is is_purchasable = false
      const dbOfferSuspended = await pool.query<{ is_purchasable: boolean }>(
        'SELECT is_purchasable FROM offers WHERE id = $1',
        [offerId],
      );
      expect(dbOfferSuspended.rows[0]?.is_purchasable).toBe(false);

      // Verify Public Catalog: offers disappear!
      const catalogAfterSuspend = await request(app).get(
        `/api/v1/catalog/variants/${variantId}/offers`,
      );
      expect(catalogAfterSuspend.status).toBe(200);
      expect(catalogAfterSuspend.body.offers).toHaveLength(0);

      // Verify Cart: cannot add suspended seller offer
      const cartAfterSuspend = await request(app)
        .put(`/api/v1/cart/lines/${offerId}`)
        .set('Authorization', `Bearer ${buyerToken}`);
      expect(cartAfterSuspend.status).toBe(400);
      expect(cartAfterSuspend.body.code).toBe('VALIDATION_ERROR');

      // 3. Reinstate Seller
      const reinstateRes = await request(app)
        .post(`/api/v1/admin/sellers/${sellerId}/reinstate`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          reason: 'تعهد کتبی مدیرعامل فروشگاه و ارائه فاکتور رسمی اصالت',
        });

      expect(reinstateRes.status).toBe(200);
      expect(reinstateRes.body.status).toBe('ok');
      expect(reinstateRes.body.seller.status).toBe('active');
      expect(reinstateRes.body.affectedOffersCount).toBe(1);

      // Verify offer in database is is_purchasable = true again
      const dbOfferReinstated = await pool.query<{ is_purchasable: boolean }>(
        'SELECT is_purchasable FROM offers WHERE id = $1',
        [offerId],
      );
      expect(dbOfferReinstated.rows[0]?.is_purchasable).toBe(true);

      // Verify Public Catalog: offers reappear!
      const catalogAfterReinstate = await request(app).get(
        `/api/v1/catalog/variants/${variantId}/offers`,
      );
      expect(catalogAfterReinstate.status).toBe(200);
      expect(catalogAfterReinstate.body.offers).toHaveLength(1);
      expect(catalogAfterReinstate.body.offers[0].id).toBe(offerId);

      // Verify Cart: can add to cart again
      const cartAfterReinstate = await request(app)
        .put(`/api/v1/cart/lines/${offerId}`)
        .set('Authorization', `Bearer ${buyerToken}`);
      expect(cartAfterReinstate.status).toBe(200);
      expect(cartAfterReinstate.body.status).toBe('ok');

      // 4. Verify Audit Events
      const auditEvents = await findAuditEventsByEntity(pool, 'seller', sellerId);
      const suspendEvent = auditEvents.find((e) => e.action === 'seller.suspended');
      expect(suspendEvent).toBeDefined();
      expect(suspendEvent?.actorId).toBe(sellerStaff.userId);
      expect(suspendEvent?.previousValue).toEqual({ status: 'active' });
      expect(suspendEvent?.newValue).toEqual({ status: 'suspended' });
      expect(suspendEvent?.reason).toBe('گزارش تخلف شدید در ارسال کالای مغایر با کاتالوگ');

      const reinstateEvent = auditEvents.find((e) => e.action === 'seller.reinstated');
      expect(reinstateEvent).toBeDefined();
      expect(reinstateEvent?.actorId).toBe(sellerStaff.userId);
      expect(reinstateEvent?.previousValue).toEqual({ status: 'suspended' });
      expect(reinstateEvent?.newValue).toEqual({ status: 'active' });
      expect(reinstateEvent?.reason).toBe('تعهد کتبی مدیرعامل فروشگاه و ارائه فاکتور رسمی اصالت');
    });
  });
});
