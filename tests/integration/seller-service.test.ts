import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { SellerService } from '../../src/modules/seller/service.js';
import { findAuditEventsByEntity } from '../../src/modules/audit/index.js';
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from '../../src/errors.js';

describe('SellerService (Integration)', () => {
  let pool: Pool;
  let sellerService: SellerService;

  beforeAll(async () => {
    const config = loadConfig({}, { loadDotenv: false });
    pool = createDbPool({ connectionString: config.testDatabaseUrl });
    sellerService = new SellerService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM sellers');
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_accounts');
  });

  describe('createSeller', () => {
    it('creates a seller application in pending-review state', async () => {
      const seller = await sellerService.createSeller({
        name: 'دیجی‌کالا فوت‌ویر',
        taxpayerId: '10100998877',
        contact: {
          phone: '09121112233',
          email: 'footwear@seller.ir',
          address: 'تهران، خیابان آزادی',
        },
      });

      expect(seller.id).toBeDefined();
      expect(seller.name).toBe('دیجی‌کالا فوت‌ویر');
      expect(seller.taxpayerId).toBe('10100998877');
      expect(seller.status).toBe('pending-review');
      expect(seller.contact).toEqual({
        phone: '09121112233',
        email: 'footwear@seller.ir',
        address: 'تهران، خیابان آزادی',
      });
      expect(seller.createdAt).toBeInstanceOf(Date);
      expect(seller.updatedAt).toBeInstanceOf(Date);

      // Verify row in database
      const rowRes = await pool.query('SELECT * FROM sellers WHERE id = $1', [seller.id]);
      expect(rowRes.rows).toHaveLength(1);
      expect(rowRes.rows[0].status).toBe('pending-review');
    });

    it('rejects duplicate taxpayer ID with ConflictError (409)', async () => {
      await sellerService.createSeller({
        name: 'فروشگاه الف',
        taxpayerId: '10100000001',
        contact: { phone: '09121110001' },
      });

      await expect(
        sellerService.createSeller({
          name: 'فروشگاه ب با همان کد مالیاتی',
          taxpayerId: '10100000001',
          contact: { phone: '09121110002' },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('validates required fields: name, taxpayerId, contact', async () => {
      await expect(
        sellerService.createSeller({
          name: '',
          taxpayerId: '10100000002',
          contact: { phone: '09121110002' },
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        sellerService.createSeller({
          name: 'فروشگاه بدون کد مالیاتی',
          taxpayerId: '   ',
          contact: { phone: '09121110002' },
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('transitionSellerStatus and Audit Trail integration', () => {
    it('executes full review lifecycle: pending-review -> under-review -> active and records audit events', async () => {
      const seller = await sellerService.createSeller({
        name: 'آرمان تجارت پارس',
        taxpayerId: '14008765432',
        contact: { phone: '09123334455' },
      });

      const actorUserId = '00000000-0000-0000-0000-000000000001';

      // 1. Transition: pending-review -> under-review
      const underReviewSeller = await sellerService.transitionSellerStatus({
        sellerId: seller.id,
        newStatus: 'under-review',
        actorUserId,
        reason: 'تکمیل مدارک هویتی و ثبت در کارتابل بررسی',
      });

      expect(underReviewSeller.status).toBe('under-review');

      let auditEvents = await findAuditEventsByEntity(pool, 'seller', seller.id);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.actorType).toBe('user');
      expect(auditEvents[0]!.actorId).toBe(actorUserId);
      expect(auditEvents[0]!.action).toBe('seller.status_transition');
      expect(auditEvents[0]!.previousValue).toEqual({ status: 'pending-review' });
      expect(auditEvents[0]!.newValue).toEqual({ status: 'under-review' });
      expect(auditEvents[0]!.reason).toBe('تکمیل مدارک هویتی و ثبت در کارتابل بررسی');

      // 2. Transition: under-review -> active
      const activeSeller = await sellerService.transitionSellerStatus({
        sellerId: seller.id,
        newStatus: 'active',
        actorUserId,
        reason: 'تأیید نهایی مدارک بانکی و مالیاتی فروشنده',
      });

      expect(activeSeller.status).toBe('active');

      auditEvents = await findAuditEventsByEntity(pool, 'seller', seller.id);
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]!.actorType).toBe('user');
      expect(auditEvents[1]!.actorId).toBe(actorUserId);
      expect(auditEvents[1]!.action).toBe('seller.status_transition');
      expect(auditEvents[1]!.previousValue).toEqual({ status: 'under-review' });
      expect(auditEvents[1]!.newValue).toEqual({ status: 'active' });
      expect(auditEvents[1]!.reason).toBe('تأیید نهایی مدارک بانکی و مالیاتی فروشنده');
    });

    it('executes rejection lifecycle: pending-review -> under-review -> rejected with audit event', async () => {
      const seller = await sellerService.createSeller({
        name: 'پارس گسترش نوین',
        taxpayerId: '14001234567',
        contact: { phone: '09124445566' },
      });

      const actorUserId = '00000000-0000-0000-0000-000000000002';

      await sellerService.transitionSellerStatus({
        sellerId: seller.id,
        newStatus: 'under-review',
        actorUserId,
      });

      const rejectedSeller = await sellerService.transitionSellerStatus({
        sellerId: seller.id,
        newStatus: 'rejected',
        actorUserId,
        reason: 'عدم تطابق مدارک مالیاتی با کد ملی',
      });

      expect(rejectedSeller.status).toBe('rejected');

      const auditEvents = await findAuditEventsByEntity(pool, 'seller', seller.id);
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]!.newValue).toEqual({ status: 'rejected' });
      expect(auditEvents[1]!.reason).toBe('عدم تطابق مدارک مالیاتی با کد ملی');
    });

    it('rejects invalid transition attempts and does not record an audit event', async () => {
      const seller = await sellerService.createSeller({
        name: 'تست انتقال نامعتبر',
        taxpayerId: '10109999999',
        contact: { phone: '09127778899' },
      });

      const actorUserId = '00000000-0000-0000-0000-000000000003';

      // Cannot jump pending-review -> active directly
      await expect(
        sellerService.transitionSellerStatus({
          sellerId: seller.id,
          newStatus: 'active',
          actorUserId,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Verify seller status remained pending-review
      const current = await sellerService.getSellerById(seller.id);
      expect(current?.status).toBe('pending-review');

      // Verify no audit event was created
      const auditEvents = await findAuditEventsByEntity(pool, 'seller', seller.id);
      expect(auditEvents).toHaveLength(0);
    });

    it('throws NotFoundError when transitioning a non-existent seller', async () => {
      await expect(
        sellerService.transitionSellerStatus({
          sellerId: '00000000-0000-0000-0000-000000000099',
          newStatus: 'under-review',
          actorUserId: '00000000-0000-0000-0000-000000000001',
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('listSellers and getSellerById', () => {
    it('lists sellers and filters by status', async () => {
      const s1 = await sellerService.createSeller({
        name: 'فروشنده یک',
        taxpayerId: '10000000001',
        contact: { phone: '09120000001' },
      });
      const s2 = await sellerService.createSeller({
        name: 'فروشنده دو',
        taxpayerId: '10000000002',
        contact: { phone: '09120000002' },
      });

      await sellerService.transitionSellerStatus({
        sellerId: s2.id,
        newStatus: 'under-review',
        actorUserId: '00000000-0000-0000-0000-000000000001',
      });

      const all = await sellerService.listSellers();
      expect(all).toHaveLength(2);

      const pendingList = await sellerService.listSellers({ status: 'pending-review' });
      expect(pendingList).toHaveLength(1);
      expect(pendingList[0]!.id).toBe(s1.id);

      const underReviewList = await sellerService.listSellers({ status: 'under-review' });
      expect(underReviewList).toHaveLength(1);
      expect(underReviewList[0]!.id).toBe(s2.id);

      const activeList = await sellerService.listSellers({ status: 'active' });
      expect(activeList).toHaveLength(0);
    });

    it('returns full record on getSellerById', async () => {
      const created = await sellerService.createSeller({
        name: 'فروشگاه کامل',
        taxpayerId: '10000000099',
        contact: { phone: '09129990000', email: 'full@seller.ir' },
      });

      const found = await sellerService.getSellerById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe('فروشگاه کامل');
      expect(found?.taxpayerId).toBe('10000000099');
      expect(found?.contact).toEqual({ phone: '09129990000', email: 'full@seller.ir' });
    });

    it('returns null for non-existent seller id', async () => {
      const found = await sellerService.getSellerById('00000000-0000-0000-0000-000000000099');
      expect(found).toBeNull();
    });
  });
});
