import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/index.js';
import { NotFoundError, ValidationError } from '../../errors.js';
import { recordAuditEvent } from '../audit/index.js';
import { assertCategoryAttributesSatisfied } from './domain/schema-validator.js';
import {
  assertCanEditFamily,
  assertValidFamilyTransition,
  isValidFamilyStatus,
} from './domain/status-machine.js';
import type {
  ApproveProductFamilyParams,
  CategoryAttributeSchema,
  CategoryAttributeSchemaRow,
  CreateDraftFromApprovedFamilyParams,
  CreateProductFamilyParams,
  ListProductFamiliesFilter,
  PaginatedResult,
  ProductFamily,
  ProductFamilyRow,
  UpdateProductFamilyParams,
  UpsertCategorySchemaParams,
} from './types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidUuid(id: string, fieldName: string = 'id'): void {
  if (!UUID_REGEX.test(id)) {
    throw new ValidationError('شناسه نامعتبر است.', [
      { field: fieldName, message: 'شناسه باید یک UUID استاندارد و معتبر باشد.' },
    ]);
  }
}

function parseJsonField<T>(field: T | string): T {
  if (typeof field === 'string') {
    try {
      return JSON.parse(field) as T;
    } catch {
      return {} as T;
    }
  }
  return field;
}

function mapCategorySchemaRow(row: CategoryAttributeSchemaRow): CategoryAttributeSchema {
  const reqAttrs = parseJsonField<string[]>(row.required_attributes) || [];
  const optAttrs = parseJsonField<string[]>(row.optional_attributes) || [];

  return {
    id: row.id,
    category: row.category,
    requiredAttributes: Array.isArray(reqAttrs) ? reqAttrs : [],
    optionalAttributes: Array.isArray(optAttrs) ? optAttrs : [],
    description: row.description,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapProductFamilyRow(row: ProductFamilyRow): ProductFamily {
  const attrs = parseJsonField<Record<string, unknown>>(row.attributes) || {};

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    attributes: attrs,
    baseAttributes: attrs,
    status: row.status,
    originalFamilyId: row.original_family_id,
    approvedAt: row.approved_at ? new Date(row.approved_at) : null,
    approvedBy: row.approved_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class CatalogService {
  constructor(private readonly pool: Pool) {}

  /**
   * Configures (creates or updates) the attribute schema for a product category.
   * Required attribute keys are enforced when approving product families in this category.
   */
  async upsertCategorySchema(
    category: string,
    params: UpsertCategorySchemaParams,
  ): Promise<CategoryAttributeSchema> {
    const normalizedCategory = category?.trim().toLowerCase();
    if (!normalizedCategory) {
      throw new ValidationError('نام دسته‌بندی الزامی است.', [
        { field: 'category', message: 'دسته‌بندی نمی‌تواند خالی باشد.' },
      ]);
    }

    if (!Array.isArray(params.requiredAttributes)) {
      throw new ValidationError('فهرست مشخصه‌های الزامی باید یک آرایه باشد.', [
        { field: 'requiredAttributes', message: 'آرایه‌ای از کلیدهای مشخصات الزامی مورد نیاز است.' },
      ]);
    }

    const cleanedRequired = params.requiredAttributes
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean);

    const cleanedOptional = (params.optionalAttributes ?? [])
      .map((k) => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean);

    const description = params.description?.trim() ?? null;

    return withTransaction(this.pool, async (client: PoolClient) => {
      const query = `
        INSERT INTO category_attribute_schemas (
          category,
          required_attributes,
          optional_attributes,
          description,
          updated_at
        ) VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW())
        ON CONFLICT (category) DO UPDATE SET
          required_attributes = EXCLUDED.required_attributes,
          optional_attributes = EXCLUDED.optional_attributes,
          description = EXCLUDED.description,
          updated_at = NOW()
        RETURNING *;
      `;

      const result = await client.query<CategoryAttributeSchemaRow>(query, [
        normalizedCategory,
        JSON.stringify(cleanedRequired),
        JSON.stringify(cleanedOptional),
        description,
      ]);

      const row = result.rows[0]!;
      const schema = mapCategorySchemaRow(row);

      // Audit log the schema configuration
      await recordAuditEvent(client, {
        actorType: params.actorUserId ? 'user' : 'system',
        actorId: params.actorUserId ?? null,
        action: 'catalog.category_schema.configured',
        entityType: 'category_schema',
        entityId: schema.id,
        newValue: {
          category: schema.category,
          requiredAttributes: schema.requiredAttributes,
          optionalAttributes: schema.optionalAttributes,
        },
      });

      return schema;
    });
  }

  /**
   * Retrieves the attribute schema for a category, or null if unconfigured.
   */
  async getCategorySchema(category: string): Promise<CategoryAttributeSchema | null> {
    const normalizedCategory = category?.trim().toLowerCase();
    if (!normalizedCategory) return null;

    const query = `
      SELECT * FROM category_attribute_schemas
      WHERE category = $1
      LIMIT 1;
    `;
    const result = await this.pool.query<CategoryAttributeSchemaRow>(query, [normalizedCategory]);
    if (result.rows.length === 0 || !result.rows[0]) {
      return null;
    }
    return mapCategorySchemaRow(result.rows[0]);
  }

  /**
   * Lists all configured category attribute schemas.
   */
  async listCategorySchemas(): Promise<CategoryAttributeSchema[]> {
    const query = `
      SELECT * FROM category_attribute_schemas
      ORDER BY category ASC;
    `;
    const result = await this.pool.query<CategoryAttributeSchemaRow>(query);
    return result.rows.map(mapCategorySchemaRow);
  }

  /**
   * Creates a product family in 'draft' state with title, description, category, and base attributes.
   */
  async createProductFamily(params: CreateProductFamilyParams): Promise<ProductFamily> {
    const title = params.title?.trim();
    if (!title || title.length < 2) {
      throw new ValidationError('عنوان کالا الزامی است و باید حداقل ۲ کاراکتر باشد.', [
        { field: 'title', message: 'عنوان کالا نمی‌تواند خالی یا کمتر از ۲ کاراکتر باشد.' },
      ]);
    }

    const category = params.category?.trim().toLowerCase();
    if (!category) {
      throw new ValidationError('دسته‌بندی کالا الزامی است.', [
        { field: 'category', message: 'دسته‌بندی کالا نمی‌تواند خالی باشد.' },
      ]);
    }

    const description = params.description?.trim() ?? null;
    const attributes = params.attributes ?? params.baseAttributes ?? {};

    return withTransaction(this.pool, async (client: PoolClient) => {
      const query = `
        INSERT INTO product_families (
          title,
          description,
          category,
          attributes,
          status
        ) VALUES ($1, $2, $3, $4::jsonb, 'draft')
        RETURNING *;
      `;

      const result = await client.query<ProductFamilyRow>(query, [
        title,
        description,
        category,
        JSON.stringify(attributes),
      ]);

      const row = result.rows[0]!;
      const family = mapProductFamilyRow(row);

      await recordAuditEvent(client, {
        actorType: params.actorUserId ? 'user' : 'system',
        actorId: params.actorUserId ?? null,
        action: 'catalog.family.created',
        entityType: 'product_family',
        entityId: family.id,
        newValue: {
          id: family.id,
          title: family.title,
          category: family.category,
          attributes: family.attributes,
          status: 'draft',
        },
      });

      return family;
    });
  }

  /**
   * Updates an existing product family while it is in 'draft' state.
   * Direct updates to 'approved' families are rejected; a new draft is required.
   */
  async updateProductFamily(
    id: string,
    params: UpdateProductFamilyParams,
  ): Promise<ProductFamily> {
    assertValidUuid(id, 'id');

    return withTransaction(this.pool, async (client: PoolClient) => {
      const selectQuery = `
        SELECT * FROM product_families
        WHERE id = $1
        FOR UPDATE;
      `;
      const selectResult = await client.query<ProductFamilyRow>(selectQuery, [id]);
      if (selectResult.rows.length === 0 || !selectResult.rows[0]) {
        throw new NotFoundError('کالای مورد نظر یافت نشد.');
      }

      const currentRow = selectResult.rows[0];
      assertCanEditFamily(currentRow.status);

      const oldAttrs = parseJsonField<Record<string, unknown>>(currentRow.attributes) || {};

      let newTitle = currentRow.title;
      if (params.title !== undefined) {
        const trimmed = params.title.trim();
        if (!trimmed || trimmed.length < 2) {
          throw new ValidationError('عنوان کالا الزامی است و باید حداقل ۲ کاراکتر باشد.', [
            { field: 'title', message: 'عنوان کالا نمی‌تواند خالی یا کمتر از ۲ کاراکتر باشد.' },
          ]);
        }
        newTitle = trimmed;
      }

      let newCategory = currentRow.category;
      if (params.category !== undefined) {
        const trimmed = params.category.trim().toLowerCase();
        if (!trimmed) {
          throw new ValidationError('دسته‌بندی کالا الزامی است.', [
            { field: 'category', message: 'دسته‌بندی نمی‌تواند خالی باشد.' },
          ]);
        }
        newCategory = trimmed;
      }

      const newDescription =
        params.description !== undefined ? params.description?.trim() ?? null : currentRow.description;

      const incomingAttrs = params.attributes ?? params.baseAttributes;
      const newAttrs = incomingAttrs !== undefined ? { ...oldAttrs, ...incomingAttrs } : oldAttrs;

      const updateQuery = `
        UPDATE product_families
        SET
          title = $1,
          description = $2,
          category = $3,
          attributes = $4::jsonb,
          updated_at = NOW()
        WHERE id = $5
        RETURNING *;
      `;

      const updateResult = await client.query<ProductFamilyRow>(updateQuery, [
        newTitle,
        newDescription,
        newCategory,
        JSON.stringify(newAttrs),
        id,
      ]);

      const updatedRow = updateResult.rows[0]!;
      const updatedFamily = mapProductFamilyRow(updatedRow);

      await recordAuditEvent(client, {
        actorType: params.actorUserId ? 'user' : 'system',
        actorId: params.actorUserId ?? null,
        action: 'catalog.family.updated',
        entityType: 'product_family',
        entityId: id,
        previousValue: {
          title: currentRow.title,
          description: currentRow.description,
          category: currentRow.category,
          attributes: oldAttrs,
        },
        newValue: {
          title: updatedFamily.title,
          description: updatedFamily.description,
          category: updatedFamily.category,
          attributes: updatedFamily.attributes,
        },
        reason: params.reason ?? null,
      });

      return updatedFamily;
    });
  }

  /**
   * Transitions a product family from 'draft' to 'approved'.
   * Enforces that all required category attributes exist and are non-empty.
   */
  async approveProductFamily(
    id: string,
    params: ApproveProductFamilyParams = {},
  ): Promise<ProductFamily> {
    assertValidUuid(id, 'id');

    return withTransaction(this.pool, async (client: PoolClient) => {
      const selectQuery = `
        SELECT * FROM product_families
        WHERE id = $1
        FOR UPDATE;
      `;
      const selectResult = await client.query<ProductFamilyRow>(selectQuery, [id]);
      if (selectResult.rows.length === 0 || !selectResult.rows[0]) {
        throw new NotFoundError('کالای مورد نظر یافت نشد.');
      }

      const currentRow = selectResult.rows[0];
      assertValidFamilyTransition(currentRow.status, 'approved');

      const familyAttrs = parseJsonField<Record<string, unknown>>(currentRow.attributes) || {};

      // Check category schema requirements
      const schemaQuery = `
        SELECT * FROM category_attribute_schemas
        WHERE category = $1
        LIMIT 1;
      `;
      const schemaResult = await client.query<CategoryAttributeSchemaRow>(schemaQuery, [
        currentRow.category,
      ]);

      if (schemaResult.rows.length > 0 && schemaResult.rows[0]) {
        const schema = mapCategorySchemaRow(schemaResult.rows[0]);
        assertCategoryAttributesSatisfied(
          schema.requiredAttributes,
          familyAttrs,
          currentRow.category,
        );
      }

      const updateQuery = `
        UPDATE product_families
        SET
          status = 'approved',
          approved_at = NOW(),
          approved_by = $1,
          updated_at = NOW()
        WHERE id = $2
        RETURNING *;
      `;

      const updateResult = await client.query<ProductFamilyRow>(updateQuery, [
        params.actorUserId ?? null,
        id,
      ]);

      const updatedRow = updateResult.rows[0]!;
      const approvedFamily = mapProductFamilyRow(updatedRow);

      await recordAuditEvent(client, {
        actorType: params.actorUserId ? 'user' : 'system',
        actorId: params.actorUserId ?? null,
        action: 'catalog.family.approved',
        entityType: 'product_family',
        entityId: id,
        previousValue: { status: currentRow.status },
        newValue: {
          status: 'approved',
          approvedAt: approvedFamily.approvedAt,
          approvedBy: approvedFamily.approvedBy,
        },
        reason: params.reason ?? 'Approved by catalog operator',
      });

      return approvedFamily;
    });
  }

  /**
   * Creates a new draft from an existing approved product family.
   * Satisfies the invariant: approved families cannot be edited directly and require a new draft.
   */
  async createDraftFromApprovedFamily(
    id: string,
    params: CreateDraftFromApprovedFamilyParams = {},
  ): Promise<ProductFamily> {
    assertValidUuid(id, 'id');

    return withTransaction(this.pool, async (client: PoolClient) => {
      const selectQuery = `
        SELECT * FROM product_families
        WHERE id = $1;
      `;
      const selectResult = await client.query<ProductFamilyRow>(selectQuery, [id]);
      if (selectResult.rows.length === 0 || !selectResult.rows[0]) {
        throw new NotFoundError('کالای مورد نظر یافت نشد.');
      }

      const originalRow = selectResult.rows[0];
      if (originalRow.status !== 'approved') {
        throw new ValidationError(
          'ایجاد پیش‌نویس جدید تنها برای کالاهای تأیید شده (approved) امکان‌پذیر است.',
          [
            {
              field: 'status',
              message: `وضعیت کالا «${originalRow.status}» است و نمی‌توان از آن پیش‌نویس جدید ساخت.`,
            },
          ],
        );
      }

      const oldAttrs = parseJsonField<Record<string, unknown>>(originalRow.attributes) || {};
      const newAttrs =
        params.attributes !== undefined || params.baseAttributes !== undefined
          ? { ...oldAttrs, ...(params.attributes ?? params.baseAttributes) }
          : oldAttrs;

      const title = params.title?.trim() || originalRow.title;
      const description =
        params.description !== undefined ? params.description?.trim() ?? null : originalRow.description;

      const insertQuery = `
        INSERT INTO product_families (
          title,
          description,
          category,
          attributes,
          status,
          original_family_id
        ) VALUES ($1, $2, $3, $4::jsonb, 'draft', $5)
        RETURNING *;
      `;

      const insertResult = await client.query<ProductFamilyRow>(insertQuery, [
        title,
        description,
        originalRow.category,
        JSON.stringify(newAttrs),
        originalRow.id,
      ]);

      const newDraftRow = insertResult.rows[0]!;
      const newDraftFamily = mapProductFamilyRow(newDraftRow);

      await recordAuditEvent(client, {
        actorType: params.actorUserId ? 'user' : 'system',
        actorId: params.actorUserId ?? null,
        action: 'catalog.family.draft_created',
        entityType: 'product_family',
        entityId: newDraftFamily.id,
        previousValue: { sourceFamilyId: originalRow.id },
        newValue: {
          id: newDraftFamily.id,
          originalFamilyId: originalRow.id,
          status: 'draft',
          title: newDraftFamily.title,
        },
        reason: params.reason ?? 'New draft created from approved family',
      });

      return newDraftFamily;
    });
  }

  /**
   * Retrieves a product family by ID.
   * If allowDraft is false (default, for public endpoint), draft or non-approved records return 404.
   */
  async getProductFamilyById(
    id: string,
    options: { allowDraft?: boolean } = {},
  ): Promise<ProductFamily> {
    assertValidUuid(id, 'id');

    const query = `
      SELECT * FROM product_families
      WHERE id = $1
      LIMIT 1;
    `;
    const result = await this.pool.query<ProductFamilyRow>(query, [id]);
    if (result.rows.length === 0 || !result.rows[0]) {
      throw new NotFoundError('کالای مورد نظر یافت نشد.');
    }

    const family = mapProductFamilyRow(result.rows[0]);
    if (!options.allowDraft && family.status !== 'approved') {
      throw new NotFoundError('کالای مورد نظر یافت نشد.');
    }

    return family;
  }

  /**
   * Public unauthenticated catalog query: lists only approved product families with pagination.
   */
  async listApprovedProductFamilies(
    pagination: { page?: number; limit?: number } = {},
  ): Promise<PaginatedResult<ProductFamily>> {
    const page = Math.max(1, Math.floor(pagination.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(pagination.limit ?? 20)));
    const offset = (page - 1) * limit;

    const countRes = await this.pool.query<{ count: string }>(`
      SELECT COUNT(*)::text as count
      FROM product_families
      WHERE status = 'approved';
    `);
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    const dataRes = await this.pool.query<ProductFamilyRow>(
      `
      SELECT * FROM product_families
      WHERE status = 'approved'
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2;
    `,
      [limit, offset],
    );

    const items = dataRes.rows.map(mapProductFamilyRow);
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Internal catalog query: lists product families with optional status and category filters.
   */
  async listProductFamilies(
    filter: ListProductFamiliesFilter = {},
  ): Promise<PaginatedResult<ProductFamily>> {
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(filter.limit ?? 20)));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.status && isValidFamilyStatus(filter.status)) {
      values.push(filter.status);
      conditions.push(`status = $${values.length}`);
    }

    if (filter.category) {
      values.push(filter.category.trim().toLowerCase());
      conditions.push(`category = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM product_families ${whereClause};`,
      values,
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    const dataValues = [...values, limit, offset];
    const dataRes = await this.pool.query<ProductFamilyRow>(
      `
      SELECT * FROM product_families
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length};
    `,
      dataValues,
    );

    const items = dataRes.rows.map(mapProductFamilyRow);
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      items,
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }
}
