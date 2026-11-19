import type { Pool } from 'pg';
import { withTransaction } from '../../db/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { recordAuditEvent } from '../audit/index.js';
import { assertValidSellerTransition, isValidSellerStatus } from './domain/status-machine.js';
import type {
  CreateOfferParams,
  CreateSellerParams,
  ListSellersFilter,
  Offer,
  PublicCatalogOffer,
  ReinstateSellerParams,
  ReinstateSellerResult,
  Seller,
  SellerRow,
  SuspendSellerParams,
  SuspendSellerResult,
  TransitionSellerStatusParams,
} from './types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidUuid(id: string, fieldName: string = 'id'): void {
  if (!UUID_REGEX.test(id)) {
    throw new ValidationError('شناسه فروشنده نامعتبر است.', [
      { field: fieldName, message: 'شناسه فروشنده باید یک UUID معتبر باشد.' },
    ]);
  }
}

function mapSellerRow(row: SellerRow): Seller {
  return {
    id: row.id,
    name: row.name,
    taxpayerId: row.taxpayer_id,
    contact: row.contact,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class SellerService {
  constructor(private readonly pool: Pool) {}

  /**
   * Registers a third-party seller application in the initial 'pending-review' state.
   * Enforces unique taxpayer ID and validated contact information.
   */
  async createSeller(params: CreateSellerParams): Promise<Seller> {
    const name = params.name?.trim();
    if (!name) {
      throw new ValidationError('نام فروشنده الزامی است.', [
        { field: 'name', message: 'نام فروشنده الزامی است.' },
      ]);
    }

    const taxpayerId = params.taxpayerId?.trim();
    if (!taxpayerId) {
      throw new ValidationError('کد مالیاتی / شناسه ملی فروشنده الزامی است.', [
        { field: 'taxpayerId', message: 'کد مالیاتی / شناسه ملی فروشنده الزامی است.' },
      ]);
    }

    const contact = params.contact;
    if (
      !contact ||
      typeof contact !== 'object' ||
      Array.isArray(contact) ||
      Object.keys(contact).length === 0
    ) {
      throw new ValidationError('اطلاعات تماس فروشنده الزامی است.', [
        { field: 'contact', message: 'اطلاعات تماس فروشنده الزامی است.' },
      ]);
    }

    const query = `
      INSERT INTO sellers (name, taxpayer_id, contact, status)
      VALUES ($1, $2, $3, 'pending-review')
      RETURNING *;
    `;

    try {
      const result = await this.pool.query<SellerRow>(query, [
        name,
        taxpayerId,
        JSON.stringify(contact),
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Failed to create seller: No row returned from database');
      }
      return mapSellerRow(row);
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new ConflictError('فروشنده‌ای با این کد مالیاتی قبلاً ثبت شده است.');
      }
      throw err;
    }
  }

  /**
   * Retrieves a seller record by its unique UUID.
   */
  async getSellerById(id: string): Promise<Seller | null> {
    assertValidUuid(id, 'id');

    const query = `
      SELECT *
      FROM sellers
      WHERE id = $1
      LIMIT 1;
    `;

    const result = await this.pool.query<SellerRow>(query, [id]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return mapSellerRow(row);
  }

  /**
   * Transitions a seller's lifecycle status through allowed state machine paths,
   * guaranteeing transactional atomicity between the status update and the append-only audit event.
   */
  async transitionSellerStatus(params: TransitionSellerStatusParams): Promise<Seller> {
    const { sellerId, newStatus, actorUserId, reason } = params;

    assertValidUuid(sellerId, 'id');

    if (!isValidSellerStatus(newStatus)) {
      throw new ValidationError(`وضعیت جدید '${newStatus}' نامعتبر است.`, [
        { field: 'status', message: `وضعیت باید یکی از مقادیر مجاز باشد.` },
      ]);
    }

    return withTransaction(this.pool, async (client) => {
      // Lock row for update within the transaction boundary
      const selectQuery = `
        SELECT *
        FROM sellers
        WHERE id = $1
        FOR UPDATE;
      `;
      const selectRes = await client.query<SellerRow>(selectQuery, [sellerId]);
      const currentRow = selectRes.rows[0];

      if (!currentRow) {
        throw new NotFoundError('فروشنده‌ای با شناسه مورد نظر یافت نشد.');
      }

      // Enforce domain state machine invariants
      assertValidSellerTransition(currentRow.status, newStatus);

      // Mutate status and update timestamp
      const updateQuery = `
        UPDATE sellers
        SET status = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *;
      `;
      const updateRes = await client.query<SellerRow>(updateQuery, [newStatus, sellerId]);
      const updatedRow = updateRes.rows[0];

      if (!updatedRow) {
        throw new Error('Failed to update seller status: No row returned');
      }

      // Record immutable audit event in the same transaction
      await recordAuditEvent(client, {
        actorType: 'user',
        actorId: actorUserId,
        action: 'seller.status_transition',
        entityType: 'seller',
        entityId: sellerId,
        previousValue: { status: currentRow.status },
        newValue: { status: newStatus },
        reason: reason ?? null,
      });

      return mapSellerRow(updatedRow);
    });
  }

  /**
   * Suspends an active seller in cases of serious risk.
   * Atomically marks all active offers non-purchasable and records an audit event in one transaction.
   */
  async suspendSeller(params: SuspendSellerParams): Promise<SuspendSellerResult> {
    const { sellerId, actorUserId, reason } = params;

    assertValidUuid(sellerId, 'id');

    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new ValidationError('علت تعلیق فروشنده الزامی است.', [
        { field: 'reason', message: 'علت تعلیق الزامی است.' },
      ]);
    }

    if (!actorUserId?.trim()) {
      throw new ValidationError('شناسه کاربر اقدام‌کننده الزامی است.', [
        { field: 'actorUserId', message: 'شناسه کاربر الزامی است.' },
      ]);
    }

    return withTransaction(this.pool, async (client) => {
      // 1. Lock seller row for update
      const selectRes = await client.query<SellerRow>(
        'SELECT * FROM sellers WHERE id = $1 FOR UPDATE;',
        [sellerId],
      );
      const currentRow = selectRes.rows[0];
      if (!currentRow) {
        throw new NotFoundError('فروشنده‌ای با شناسه مورد نظر یافت نشد.');
      }

      // 2. Validate state transition: only active sellers can be suspended
      assertValidSellerTransition(currentRow.status, 'suspended');

      // 3. Update seller status to 'suspended'
      const updateRes = await client.query<SellerRow>(
        `UPDATE sellers
         SET status = 'suspended', updated_at = NOW()
         WHERE id = $1
         RETURNING *;`,
        [sellerId],
      );
      const updatedRow = updateRes.rows[0];
      if (!updatedRow) {
        throw new Error('Failed to update seller status: No row returned');
      }

      // 4. Atomically mark all active offers belonging to this seller as non-purchasable
      const offersRes = await client.query(
        `UPDATE offers
         SET is_purchasable = false, updated_at = NOW()
         WHERE seller_id = $1 AND status = 'active';`,
        [sellerId],
      );
      const affectedOffersCount = offersRes.rowCount ?? 0;

      // 5. Record immutable audit event
      await recordAuditEvent(client, {
        actorType: 'user',
        actorId: actorUserId,
        action: 'seller.suspended',
        entityType: 'seller',
        entityId: sellerId,
        previousValue: { status: currentRow.status },
        newValue: { status: 'suspended' },
        reason: trimmedReason,
      });

      return {
        seller: mapSellerRow(updatedRow),
        affectedOffersCount,
      };
    });
  }

  /**
   * Reinstates a suspended seller back to active status.
   * Atomically restores active offers to purchasable and records an audit event in one transaction.
   */
  async reinstateSeller(params: ReinstateSellerParams): Promise<ReinstateSellerResult> {
    const { sellerId, actorUserId, reason } = params;

    assertValidUuid(sellerId, 'id');

    if (!actorUserId?.trim()) {
      throw new ValidationError('شناسه کاربر اقدام‌کننده الزامی است.', [
        { field: 'actorUserId', message: 'شناسه کاربر الزامی است.' },
      ]);
    }

    const trimmedReason = reason?.trim() || 'رفع تعلیق و بازگشت به وضعیت فعال';

    return withTransaction(this.pool, async (client) => {
      // 1. Lock seller row for update
      const selectRes = await client.query<SellerRow>(
        'SELECT * FROM sellers WHERE id = $1 FOR UPDATE;',
        [sellerId],
      );
      const currentRow = selectRes.rows[0];
      if (!currentRow) {
        throw new NotFoundError('فروشنده‌ای با شناسه مورد نظر یافت نشد.');
      }

      // 2. Validate state transition: only suspended sellers can be reinstated to active
      assertValidSellerTransition(currentRow.status, 'active');

      // 3. Update seller status to 'active'
      const updateRes = await client.query<SellerRow>(
        `UPDATE sellers
         SET status = 'active', updated_at = NOW()
         WHERE id = $1
         RETURNING *;`,
        [sellerId],
      );
      const updatedRow = updateRes.rows[0];
      if (!updatedRow) {
        throw new Error('Failed to update seller status: No row returned');
      }

      // 4. Atomically restore all active offers belonging to this seller to purchasable
      const offersRes = await client.query(
        `UPDATE offers
         SET is_purchasable = true, updated_at = NOW()
         WHERE seller_id = $1 AND status = 'active';`,
        [sellerId],
      );
      const affectedOffersCount = offersRes.rowCount ?? 0;

      // 5. Record immutable audit event
      await recordAuditEvent(client, {
        actorType: 'user',
        actorId: actorUserId,
        action: 'seller.reinstated',
        entityType: 'seller',
        entityId: sellerId,
        previousValue: { status: currentRow.status },
        newValue: { status: 'active' },
        reason: trimmedReason,
      });

      return {
        seller: mapSellerRow(updatedRow),
        affectedOffersCount,
      };
    });
  }

  /**
   * Helper to create an offer for testing and matching flows.
   */
  async createOffer(params: CreateOfferParams): Promise<Offer> {
    const { sellerId, variantId, price, status = 'active', isPurchasable = true } = params;
    assertValidUuid(sellerId, 'sellerId');
    assertValidUuid(variantId, 'variantId');

    const res = await this.pool.query<{
      id: string;
      seller_id: string;
      variant_id: string;
      price: string;
      status: 'active' | 'deactivated' | 'pending-inventory' | 'held-for-review';
      is_purchasable: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO offers (seller_id, variant_id, price, status, is_purchasable)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *;`,
      [sellerId, variantId, price, status, isPurchasable],
    );
    const row = res.rows[0]!;
    return {
      id: row.id,
      sellerId: row.seller_id,
      variantId: row.variant_id,
      price: Number(row.price),
      status: row.status,
      isPurchasable: row.is_purchasable,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Public catalog query: retrieves all active, purchasable offers for a variant.
   * Filters out offers belonging to non-active / suspended sellers and non-purchasable offers.
   */
  async getPublicOffersForVariant(variantId: string): Promise<PublicCatalogOffer[]> {
    assertValidUuid(variantId, 'variantId');

    const query = `
      SELECT o.id, o.variant_id, o.price, s.id AS seller_id, s.name AS seller_name
      FROM offers o
      JOIN sellers s ON s.id = o.seller_id
      WHERE o.variant_id = $1
        AND o.is_purchasable = true
        AND o.status = 'active'
        AND s.status = 'active'
      ORDER BY o.price ASC;
    `;

    const result = await this.pool.query<{
      id: string;
      variant_id: string;
      price: string;
      seller_id: string;
      seller_name: string;
    }>(query, [variantId]);

    return result.rows.map((r) => ({
      id: r.id,
      variantId: r.variant_id,
      price: Number(r.price),
      seller: {
        id: r.seller_id,
        name: r.seller_name,
      },
    }));
  }

  /**
   * Asserts an offer is valid and purchasable for adding to a cart.
   * Throws ValidationError if the offer belongs to a suspended seller or is marked non-purchasable.
   */
  async assertOfferPurchasableForCart(offerId: string): Promise<Offer> {
    assertValidUuid(offerId, 'offerId');

    const query = `
      SELECT o.id, o.seller_id, o.variant_id, o.price, o.status, o.is_purchasable, o.created_at, o.updated_at,
             s.status AS seller_status
      FROM offers o
      JOIN sellers s ON s.id = o.seller_id
      WHERE o.id = $1;
    `;

    const result = await this.pool.query<{
      id: string;
      seller_id: string;
      variant_id: string;
      price: string;
      status: 'active' | 'deactivated' | 'pending-inventory' | 'held-for-review';
      is_purchasable: boolean;
      created_at: Date;
      updated_at: Date;
      seller_status: string;
    }>(query, [offerId]);

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError('پیشنهاد مورد نظر یافت نشد.');
    }

    if (row.seller_status !== 'active' || !row.is_purchasable || row.status !== 'active') {
      throw new ValidationError(
        'این پیشنهاد به دلیل تعلیق فروشنده یا عدم دسترسی، قابل افزودن به سبد خرید نمی‌باشد.',
        [
          {
            field: 'offerId',
            message: 'پیشنهادهای فروشنده تعلیق‌شده امکان افزودن به سبد خرید ندارند.',
          },
        ],
      );
    }

    return {
      id: row.id,
      sellerId: row.seller_id,
      variantId: row.variant_id,
      price: Number(row.price),
      status: row.status,
      isPurchasable: row.is_purchasable,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Lists sellers, optionally filtered by status, ordered by creation date descending.
   */
  async listSellers(filter?: ListSellersFilter): Promise<Seller[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.status) {
      if (!isValidSellerStatus(filter.status)) {
        throw new ValidationError(`وضعیت فیلتر '${filter.status}' نامعتبر است.`, [
          { field: 'status', message: 'وضعیت باید یکی از مقادیر مجاز باشد.' },
        ]);
      }
      values.push(filter.status);
      conditions.push(`status = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `
      SELECT *
      FROM sellers
      ${whereClause}
      ORDER BY created_at DESC;
    `;

    const result = await this.pool.query<SellerRow>(query, values);
    return result.rows.map(mapSellerRow);
  }
}
