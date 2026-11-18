import type { Pool } from 'pg';
import { withTransaction } from '../../db/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { recordAuditEvent } from '../audit/index.js';
import { assertValidSellerTransition, isValidSellerStatus } from './domain/status-machine.js';
import type {
  CreateSellerParams,
  ListSellersFilter,
  Seller,
  SellerRow,
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
