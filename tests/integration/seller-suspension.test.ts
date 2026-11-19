import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { SellerService } from '../../src/modules/seller/service.js';
import { findAuditEventsByEntity } from '../../src/modules/audit/index.js';
import { InvalidStateTransitionError, NotFoundError, ValidationError } from '../../src/errors.js';

describe('Seller Suspension & Reinstatement Service (Integration)', () => {
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
    await pool.query('DELETE FROM offers');
    await pool.query('DELETE FROM sellers');
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_accounts');
  });

  async function createActiveSeller(taxpayerId: string = '10100112233') {
    const seller = await sellerService.createSeller({
      name: 'فروشگاه تستی پارس',
      taxpayerId,
      contact: { phone: '09121112233', email: 'pars@seller.ir' },
    });

    // Advance to under-review
    await sellerService.transitionSellerStatus({
      sellerId: seller.id,
      newStatus: 'under-review',
      actorUserId: '00000000-0000-0000-0000-000000000001',
      reason: 'شروع بررسی مدارک',
    });

    // Advance to active
    return sellerService.transitionSellerStatus({
      sellerId: seller.id,
      newStatus: 'active',
      actorUserId: '00000000-0000-0000-0000-000000000001',
      reason: 'تأیید مدارک و فعال‌سازی',
    });
  }

  async function insertOffer(
    sellerId: string,
    options: { price?: number; status?: string; isPurchasable?: boolean } = {},
  ) {
    const price = options.price ?? 250000;
    const status = options.status ?? 'active';
    const isPurchasable = options.isPurchasable ?? true;

    const res = await pool.query<{
      id: string;
      seller_id: string;
      variant_id: string;
      price: string;
      status: string;
      is_purchasable: boolean;
    }>(
      `INSERT INTO offers (seller_id, variant_id, price, status, is_purchasable)
       VALUES ($1, gen_random_uuid(), $2, $3, $4)
       RETURNING *;`,
      [sellerId, price, status, isPurchasable],
    );
    return res.rows[0]!;
  }

  describe('suspendSeller', () => {
    it('requires a mandatory non-empty reason', async () => {
      const seller = await createActiveSeller();

      await expect(
        sellerService.suspendSeller({
          sellerId: seller.id,
          actorUserId: '00000000-0000-0000-0000-000000000001',
          reason: '',
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        sellerService.suspendSeller({
          sellerId: seller.id,
          actorUserId: '00000000-0000-0000-0000-000000000001',
          reason: '   ',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects suspending a non-existent seller with NotFoundError', async () => {
      await expect(
        sellerService.suspendSeller({
          sellerId: '99999999-9999-9999-9999-999999999999',
          actorUserId: '00000000-0000-0000-0000-000000000001',
          reason: 'مشکوک به تقلب',
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('rejects suspending sellers not in active state', async () => {
      // Pending review seller
      const pendingSeller = await sellerService.createSeller({
        name: 'فروشنده در انتظار',
        taxpayerId: '20202020202',
        contact: { phone: '09123334455' },
      });

      await expect(
        sellerService.suspendSeller({
          sellerId: pendingSeller.id,
          actorUserId: '00000000-0000-0000-0000-000000000001',
          reason: 'عدم تایید مدارک',
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Under review seller
      const underReviewSeller = await sellerService.transitionSellerStatus({
        sellerId: pendingSeller.id,
        newStatus: 'under-review',
        actorUserId: '00000000-0000-0000-0000-000000000001',
        reason: 'بررسی',
      });

      await expect(
        sellerService.suspendSeller({
          sellerId: underReviewSeller.id,
          actorUserId: '00000000-0000-0000-0000-000000000001',
          reason: 'عدم تایید مدارک',
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('suspends an active seller, atomically marks offers non-purchasable, and writes audit event', async () => {
      const activeSeller = await createActiveSeller('11111111111');
      const otherSeller = await createActiveSeller('22222222222');

      // Create 2 active offers for the seller to be suspended
      const offer1 = await insertOffer(activeSeller.id, {
        price: 100000,
        status: 'active',
        isPurchasable: true,
      });
      const offer2 = await insertOffer(activeSeller.id, {
        price: 200000,
        status: 'active',
        isPurchasable: true,
      });

      // Create 1 already deactivated offer for the seller
      const deactivatedOffer = await insertOffer(activeSeller.id, {
        price: 300000,
        status: 'deactivated',
        isPurchasable: false,
      });

      // Create 1 offer for the other seller (should remain unaffected)
      const otherOffer = await insertOffer(otherSeller.id, {
        price: 500000,
        status: 'active',
        isPurchasable: true,
      });

      // Execute suspension
      const result = await sellerService.suspendSeller({
        sellerId: activeSeller.id,
        actorUserId: '00000000-0000-0000-0000-000000000001',
        reason: 'کالای تقلبی کشف شده و ریسک جدی برای خریداران ایجاد کرده است',
      });

      expect(result.seller.id).toBe(activeSeller.id);
      expect(result.seller.status).toBe('suspended');
      expect(result.affectedOffersCount).toBe(2);

      // Verify seller in database
      const dbSeller = await sellerService.getSellerById(activeSeller.id);
      expect(dbSeller?.status).toBe('suspended');

      // Verify offers in database
      const checkOffer1 = await pool.query<{ is_purchasable: boolean }>(
        'SELECT is_purchasable FROM offers WHERE id = $1',
        [offer1.id],
      );
      expect(checkOffer1.rows[0]?.is_purchasable).toBe(false);

      const checkOffer2 = await pool.query<{ is_purchasable: boolean }>(
        'SELECT is_purchasable FROM offers WHERE id = $1',
        [offer2.id],
      );
      expect(checkOffer2.rows[0]?.is_purchasable).toBe(false);

      const checkDeactivated = await pool.query<{ is_purchasable: boolean; status: string }>(
        'SELECT is_purchasable, status FROM offers WHERE id = $1',
        [deactivatedOffer.id],
      );
      expect(checkDeactivated.rows[0]?.is_purchasable).toBe(false);
      expect(checkDeactivated.rows[0]?.status).toBe('deactivated');

      // Other seller's offer remains purchasable
      const checkOther = await pool.query<{ is_purchasable: boolean }>(
        'SELECT is_purchasable FROM offers WHERE id = $1',
        [otherOffer.id],
      );
      expect(checkOther.rows[0]?.is_purchasable).toBe(true);

      // Verify audit event
      const auditEvents = await findAuditEventsByEntity(pool, 'seller', activeSeller.id);
      const suspendEvent = auditEvents.find((e) => e.action === 'seller.suspended');
      expect(suspendEvent).toBeDefined();
      expect(suspendEvent?.actorId).toBe('00000000-0000-0000-0000-000000000001');
      expect(suspendEvent?.actorType).toBe('user');
      expect(suspendEvent?.previousValue).toEqual({ status: 'active' });
      expect(suspendEvent?.newValue).toEqual({ status: 'suspended' });
      expect(suspendEvent?.reason).toBe(
        'کالای تقلبی کشف شده و ریسک جدی برای خریداران ایجاد کرده است',
      );
    });
  });

  describe('reinstateSeller', () => {
    it('rejects reinstating a seller who is not suspended', async () => {
      const activeSeller = await createActiveSeller('33333333333');

      await expect(
        sellerService.reinstateSeller({
          sellerId: activeSeller.id,
          actorUserId: '00000000-0000-0000-0000-000000000001',
          reason: 'تلاش برای رفع تعلیق فروشنده فعال',
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('reinstates a suspended seller, restores active offers to purchasable, and writes audit event', async () => {
      const seller = await createActiveSeller('44444444444');

      // Create active and deactivated offers
      const activeOffer = await insertOffer(seller.id, {
        price: 150000,
        status: 'active',
        isPurchasable: true,
      });
      const deactivatedOffer = await insertOffer(seller.id, {
        price: 90000,
        status: 'deactivated',
        isPurchasable: false,
      });

      // Suspend seller
      await sellerService.suspendSeller({
        sellerId: seller.id,
        actorUserId: '00000000-0000-0000-0000-000000000001',
        reason: 'بررسی عدم تطابق کالا',
      });

      // Verify suspended state
      let offerRes = await pool.query<{ is_purchasable: boolean }>(
        'SELECT is_purchasable FROM offers WHERE id = $1',
        [activeOffer.id],
      );
      expect(offerRes.rows[0]?.is_purchasable).toBe(false);

      // Reinstate seller
      const result = await sellerService.reinstateSeller({
        sellerId: seller.id,
        actorUserId: '00000000-0000-0000-0000-000000000001',
        reason: 'ارائه مدارک اصالت کالا و برطرف شدن ابهام',
      });

      expect(result.seller.status).toBe('active');
      expect(result.affectedOffersCount).toBe(1);

      // Offer restored to purchasable
      offerRes = await pool.query<{ is_purchasable: boolean }>(
        'SELECT is_purchasable FROM offers WHERE id = $1',
        [activeOffer.id],
      );
      expect(offerRes.rows[0]?.is_purchasable).toBe(true);

      // Deactivated offer stays non-purchasable
      const deactRes = await pool.query<{ is_purchasable: boolean }>(
        'SELECT is_purchasable FROM offers WHERE id = $1',
        [deactivatedOffer.id],
      );
      expect(deactRes.rows[0]?.is_purchasable).toBe(false);

      // Verify audit event
      const auditEvents = await findAuditEventsByEntity(pool, 'seller', seller.id);
      const reinstateEvent = auditEvents.find((e) => e.action === 'seller.reinstated');
      expect(reinstateEvent).toBeDefined();
      expect(reinstateEvent?.actorId).toBe('00000000-0000-0000-0000-000000000001');
      expect(reinstateEvent?.previousValue).toEqual({ status: 'suspended' });
      expect(reinstateEvent?.newValue).toEqual({ status: 'active' });
      expect(reinstateEvent?.reason).toBe('ارائه مدارک اصالت کالا و برطرف شدن ابهام');
    });
  });

  describe('Public catalog queries and cart checks with suspension', () => {
    it('hides suspended seller offers from catalog and blocks cart addition; restores upon reinstatement', async () => {
      const seller = await createActiveSeller('55555555555');
      const variantId = '77777777-7777-7777-7777-777777777777';

      // Create an offer using createOffer
      const offer = await sellerService.createOffer({
        sellerId: seller.id,
        variantId,
        price: 320000,
        status: 'active',
        isPurchasable: true,
      });

      // 1. Initial active state: visible in catalog, valid for cart
      let catalogOffers = await sellerService.getPublicOffersForVariant(variantId);
      expect(catalogOffers).toHaveLength(1);
      expect(catalogOffers[0]?.id).toBe(offer.id);
      expect(catalogOffers[0]?.seller.name).toBe('فروشگاه تستی پارس');
      expect(catalogOffers[0]?.price).toBe(320000);

      const cartOffer = await sellerService.assertOfferPurchasableForCart(offer.id);
      expect(cartOffer.id).toBe(offer.id);
      expect(cartOffer.isPurchasable).toBe(true);

      // 2. Suspend seller: offers disappear from public catalog, cart addition rejected
      await sellerService.suspendSeller({
        sellerId: seller.id,
        actorUserId: '00000000-0000-0000-0000-000000000001',
        reason: 'شکایت‌های متعدد خریداران از عدم ارسال کالا',
      });

      catalogOffers = await sellerService.getPublicOffersForVariant(variantId);
      expect(catalogOffers).toHaveLength(0);

      await expect(sellerService.assertOfferPurchasableForCart(offer.id)).rejects.toThrow(
        ValidationError,
      );

      // 3. Reinstate seller: offers reappear in catalog and can be added to cart again
      await sellerService.reinstateSeller({
        sellerId: seller.id,
        actorUserId: '00000000-0000-0000-0000-000000000001',
        reason: 'حل و فصل شکایات و تعهد به ارسال به موقع',
      });

      catalogOffers = await sellerService.getPublicOffersForVariant(variantId);
      expect(catalogOffers).toHaveLength(1);
      expect(catalogOffers[0]?.id).toBe(offer.id);

      const restoredCartOffer = await sellerService.assertOfferPurchasableForCart(offer.id);
      expect(restoredCartOffer.id).toBe(offer.id);
      expect(restoredCartOffer.isPurchasable).toBe(true);
    });
  });
});
