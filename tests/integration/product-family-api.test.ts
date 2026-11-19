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

describe('Product Family CRUD & Attribute Schema API (Integration)', () => {
  let pool: Pool;
  let app: Express;
  let smsSender: InMemorySmsSender;
  const JWT_SECRET = 'test-product-family-catalog-secret-key-123456';

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
    await pool.query('DELETE FROM product_families');
    await pool.query('DELETE FROM category_attribute_schemas');
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

  describe('Authorization & RBAC for Catalog Endpoints', () => {
    it('rejects unauthenticated requests to admin catalog endpoints with 401', async () => {
      const res = await request(app).post('/api/v1/admin/catalog/families').send({
        title: 'گوشی هوشمند',
        category: 'smartphones',
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects operational users without catalog role with 403 FORBIDDEN', async () => {
      const { sessionToken } = await createVerifiedUser(
        'finance-staff@test.ir',
        '+989121110001',
        ['finance'],
      );

      const res = await request(app)
        .post('/api/v1/admin/catalog/families')
        .set('Authorization', `Bearer ${sessionToken}`)
        .send({
          title: 'گوشی هوشمند',
          category: 'smartphones',
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('rejects session without verified MFA with 403 MFA_REQUIRED', async () => {
      const userRes = await pool.query<{ id: string }>(
        `INSERT INTO user_accounts (email, phone, roles, status)
         VALUES ('unverified@test.ir', '+989121110002', ARRAY['catalog']::text[], 'active')
         RETURNING id;`,
      );
      const tokenRes = await pool.query<{ session_token: string }>(
        `INSERT INTO internal_sessions (user_id, session_token, mfa_verified, expires_at)
         VALUES ($1, 'mfa-unverified-token', FALSE, NOW() + INTERVAL '1 hour')
         RETURNING session_token;`,
        [userRes.rows[0]!.id],
      );

      const res = await request(app)
        .post('/api/v1/admin/catalog/families')
        .set('Authorization', `Bearer ${tokenRes.rows[0]!.session_token}`)
        .send({
          title: 'گوشی هوشمند',
          category: 'smartphones',
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MFA_REQUIRED');
    });
  });

  describe('End-to-End Product Family Lifecycle with Attribute Schema Enforcement', () => {
    it('fulfills complete lifecycle: configure schema -> create draft -> reject invalid approval -> patch missing attributes -> approve -> forbid direct patch -> create new draft', async () => {
      const { sessionToken: catalogToken, userId: catalogUserId } = await createVerifiedUser(
        'catalog-expert@digikala.local',
        '+989129990011',
        ['catalog'],
      );

      // Step 1: Configure Category Attribute Schema
      const schemaRes = await request(app)
        .put('/api/v1/admin/catalog/categories/mobile-phones/schema')
        .set('Authorization', `Bearer ${catalogToken}`)
        .send({
          requiredAttributes: ['brand', 'model', 'os', 'screen_size'],
          optionalAttributes: ['battery_capacity', 'weight'],
          description: 'الزامات دسته‌بندی تلفن‌های هوشمند',
        });

      expect(schemaRes.status).toBe(200);
      expect(schemaRes.body.schema.category).toBe('mobile-phones');
      expect(schemaRes.body.schema.requiredAttributes).toEqual([
        'brand',
        'model',
        'os',
        'screen_size',
      ]);

      // Step 2: Create Product Family in 'draft' state with partial attributes
      const createRes = await request(app)
        .post('/api/v1/admin/catalog/families')
        .set('Authorization', `Bearer ${catalogToken}`)
        .send({
          title: 'گوشی موبایل اپل مدل iPhone 15 Pro Max',
          description: 'پرچمدار سال ۲۰۲۳ اپل مجهز به تراشه A17 Pro',
          category: 'mobile-phones',
          baseAttributes: {
            brand: 'Apple',
            model: 'iPhone 15 Pro Max',
            // Missing: os, screen_size
          },
        });

      expect(createRes.status).toBe(201);
      const familyId = createRes.body.family.id;
      expect(createRes.body.family.status).toBe('draft');
      expect(createRes.body.family.title).toBe('گوشی موبایل اپل مدل iPhone 15 Pro Max');

      // Step 3: Attempt to approve family when required attributes are missing -> Rejection (400)
      const prematureApproveRes = await request(app)
        .post(`/api/v1/admin/catalog/families/${familyId}/approve`)
        .set('Authorization', `Bearer ${catalogToken}`)
        .send({ reason: 'تأیید اولیه' });

      expect(prematureApproveRes.status).toBe(400);
      expect(prematureApproveRes.body.code).toBe('VALIDATION_ERROR');
      expect(prematureApproveRes.body.fieldErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'attributes.os' }),
          expect.objectContaining({ field: 'attributes.screen_size' }),
        ]),
      );

      // Verify the family remains in 'draft' state
      const adminGetDraftRes = await request(app)
        .get(`/api/v1/admin/catalog/families/${familyId}`)
        .set('Authorization', `Bearer ${catalogToken}`);
      expect(adminGetDraftRes.status).toBe(200);
      expect(adminGetDraftRes.body.family.status).toBe('draft');

      // Verify public catalog endpoint hides draft families
      const publicGetDraftRes = await request(app).get(`/api/v1/catalog/families/${familyId}`);
      expect(publicGetDraftRes.status).toBe(404);

      // Step 4: PATCH family while in draft to add missing required attributes
      const patchRes = await request(app)
        .patch(`/api/v1/admin/catalog/families/${familyId}`)
        .set('Authorization', `Bearer ${catalogToken}`)
        .send({
          baseAttributes: {
            os: 'iOS 17',
            screen_size: '6.7 inches',
            battery_capacity: '4422 mAh',
          },
          reason: 'تکمیل مشخصات فنی بر اساس دفترچه سازنده',
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.family.attributes).toEqual({
        brand: 'Apple',
        model: 'iPhone 15 Pro Max',
        os: 'iOS 17',
        screen_size: '6.7 inches',
        battery_capacity: '4422 mAh',
      });

      // Step 5: Approve family -> Success
      const approveRes = await request(app)
        .post(`/api/v1/admin/catalog/families/${familyId}/approve`)
        .set('Authorization', `Bearer ${catalogToken}`)
        .send({ reason: 'تمام مشخصات فنی الزامی توسط تیم کاتالوگ بازبینی و تأیید شد.' });

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.family.status).toBe('approved');
      expect(approveRes.body.family.approvedAt).not.toBeNull();
      expect(approveRes.body.family.approvedBy).toBe(catalogUserId);

      // Step 6: Verify audit trail
      const auditEvents = await findAuditEventsByEntity(pool, 'product_family', familyId);
      expect(auditEvents.length).toBeGreaterThanOrEqual(3);
      const actions = auditEvents.map((e) => e.action);
      expect(actions).toContain('catalog.family.created');
      expect(actions).toContain('catalog.family.updated');
      expect(actions).toContain('catalog.family.approved');

      // Step 7: Verify PATCH on approved family is REJECTED
      const invalidPatchRes = await request(app)
        .patch(`/api/v1/admin/catalog/families/${familyId}`)
        .set('Authorization', `Bearer ${catalogToken}`)
        .send({ title: 'عنوان دستکاری شده' });

      expect(invalidPatchRes.status).toBe(400);
      expect(invalidPatchRes.body.code).toBe('INVALID_STATE_TRANSITION');

      // Step 8: Approved family requires creating a new draft
      const newDraftRes = await request(app)
        .post(`/api/v1/admin/catalog/families/${familyId}/draft`)
        .set('Authorization', `Bearer ${catalogToken}`)
        .send({
          title: 'گوشی موبایل اپل مدل iPhone 15 Pro Max (نسخه ارتقا یافته)',
          reason: 'ایجاد پیش‌نویس جدید برای ویرایش محتوای اشتراکی کالا',
        });

      expect(newDraftRes.status).toBe(201);
      const newDraftFamily = newDraftRes.body.family;
      expect(newDraftFamily.id).not.toBe(familyId);
      expect(newDraftFamily.status).toBe('draft');
      expect(newDraftFamily.originalFamilyId).toBe(familyId);
      expect(newDraftFamily.attributes).toEqual(approveRes.body.family.attributes);

      // Step 9: Public unauthenticated queries
      // Public GET by ID on approved family returns 200 with full record
      const publicApprovedRes = await request(app).get(`/api/v1/catalog/families/${familyId}`);
      expect(publicApprovedRes.status).toBe(200);
      expect(publicApprovedRes.body.family.id).toBe(familyId);
      expect(publicApprovedRes.body.family.status).toBe('approved');

      // Public GET on list returns only approved families and supports pagination
      const publicListRes = await request(app).get('/api/v1/catalog/families?page=1&limit=10');
      expect(publicListRes.status).toBe(200);
      expect(publicListRes.body.families).toHaveLength(1);
      expect(publicListRes.body.families[0].id).toBe(familyId);
      expect(publicListRes.body.pagination.total).toBe(1);
      expect(publicListRes.body.pagination.totalPages).toBe(1);
    });
  });

  describe('Public Catalog Listing Pagination & Filtering', () => {
    it('returns only approved families and respects page and limit', async () => {
      const { sessionToken: catalogToken } = await createVerifiedUser(
        'catalog-staff@digikala.local',
        '+989127776655',
        ['catalog'],
      );

      // Create 5 approved families and 3 draft families
      for (let i = 1; i <= 5; i++) {
        const createRes = await request(app)
          .post('/api/v1/admin/catalog/families')
          .set('Authorization', `Bearer ${catalogToken}`)
          .send({
            title: `کالای تأیید شده شماره ${i}`,
            category: 'books',
            attributes: { isbn: `978-00000000${i}` },
          });

        await request(app)
          .post(`/api/v1/admin/catalog/families/${createRes.body.family.id}/approve`)
          .set('Authorization', `Bearer ${catalogToken}`);
      }

      for (let i = 1; i <= 3; i++) {
        await request(app)
          .post('/api/v1/admin/catalog/families')
          .set('Authorization', `Bearer ${catalogToken}`)
          .send({
            title: `کالای پیش‌نویس شماره ${i}`,
            category: 'books',
            attributes: {},
          });
      }

      // Page 1 with limit 2
      const page1Res = await request(app).get('/api/v1/catalog/families?page=1&limit=2');
      expect(page1Res.status).toBe(200);
      expect(page1Res.body.families).toHaveLength(2);
      expect(page1Res.body.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 5,
        totalPages: 3,
      });

      // Page 3 with limit 2
      const page3Res = await request(app).get('/api/v1/catalog/families?page=3&limit=2');
      expect(page3Res.status).toBe(200);
      expect(page3Res.body.families).toHaveLength(1);
    });
  });
});
