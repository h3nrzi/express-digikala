import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { CatalogService } from '../../src/modules/catalog/service.js';
import { findAuditEventsByEntity } from '../../src/modules/audit/index.js';
import { InvalidStateTransitionError, NotFoundError, ValidationError } from '../../src/errors.js';

describe('CatalogService (Integration)', () => {
  let pool: Pool;
  let catalogService: CatalogService;

  beforeAll(async () => {
    const config = loadConfig({}, { loadDotenv: false });
    pool = createDbPool({ connectionString: config.testDatabaseUrl });
    catalogService = new CatalogService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM product_families');
    await pool.query('DELETE FROM category_attribute_schemas');
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_accounts');
  });

  describe('Category Attribute Schema Management', () => {
    it('creates and retrieves a category attribute schema', async () => {
      const schema = await catalogService.upsertCategorySchema('mobile-phones', {
        requiredAttributes: ['brand', 'model', 'screen_size'],
        description: 'Schema for mobile phones',
      });

      expect(schema.id).toBeDefined();
      expect(schema.category).toBe('mobile-phones');
      expect(schema.requiredAttributes).toEqual(['brand', 'model', 'screen_size']);

      const retrieved = await catalogService.getCategorySchema('mobile-phones');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.category).toBe('mobile-phones');
      expect(retrieved?.requiredAttributes).toEqual(['brand', 'model', 'screen_size']);
    });

    it('updates an existing category attribute schema idempotently', async () => {
      await catalogService.upsertCategorySchema('laptops', {
        requiredAttributes: ['brand', 'ram'],
      });

      const updated = await catalogService.upsertCategorySchema('laptops', {
        requiredAttributes: ['brand', 'ram', 'cpu', 'storage'],
        description: 'Updated laptop schema',
      });

      expect(updated.category).toBe('laptops');
      expect(updated.requiredAttributes).toEqual(['brand', 'ram', 'cpu', 'storage']);
      expect(updated.description).toBe('Updated laptop schema');

      const allSchemas = await catalogService.listCategorySchemas();
      expect(allSchemas).toHaveLength(1);
    });
  });

  describe('Product Family Creation and Draft Lifecycle', () => {
    it('creates a product family in draft status with title, category, and base attributes', async () => {
      const family = await catalogService.createProductFamily({
        title: 'گوشی موبایل اپل مدل iPhone 15 Pro',
        description: 'پرچمدار اپل با بدنه تیتانیومی',
        category: 'mobile-phones',
        attributes: {
          brand: 'Apple',
          model: 'iPhone 15 Pro',
        },
      });

      expect(family.id).toBeDefined();
      expect(family.status).toBe('draft');
      expect(family.title).toBe('گوشی موبایل اپل مدل iPhone 15 Pro');
      expect(family.category).toBe('mobile-phones');
      expect(family.attributes).toEqual({
        brand: 'Apple',
        model: 'iPhone 15 Pro',
      });
      expect(family.approvedAt).toBeNull();
      expect(family.approvedBy).toBeNull();

      // Verify audit event recorded for creation
      const auditEvents = await findAuditEventsByEntity(pool, 'product_family', family.id);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]?.action).toBe('catalog.family.created');
    });

    it('rejects creation when required fields (title, category) are missing', async () => {
      await expect(
        catalogService.createProductFamily({
          title: '',
          category: 'mobile-phones',
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        catalogService.createProductFamily({
          title: 'Valid Title',
          category: '',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('allows updating a family while in draft status and records audit event', async () => {
      const family = await catalogService.createProductFamily({
        title: 'تبلت سامسونگ',
        category: 'tablets',
        attributes: { brand: 'Samsung' },
      });

      const updated = await catalogService.updateProductFamily(family.id, {
        title: 'تبلت سامسونگ مدل Galaxy Tab S9',
        description: 'تبلت قدرتمند با قلم S-Pen',
        attributes: { brand: 'Samsung', screen_size: '11 inch' },
      });

      expect(updated.title).toBe('تبلت سامسونگ مدل Galaxy Tab S9');
      expect(updated.description).toBe('تبلت قدرتمند با قلم S-Pen');
      expect(updated.attributes).toEqual({
        brand: 'Samsung',
        screen_size: '11 inch',
      });

      const auditEvents = await findAuditEventsByEntity(pool, 'product_family', family.id);
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]?.action).toBe('catalog.family.updated');
    });
  });

  describe('Approval Enforcement with Attribute Schema', () => {
    it('blocks approval when required attributes defined by category schema are missing', async () => {
      await catalogService.upsertCategorySchema('mobile-phones', {
        requiredAttributes: ['brand', 'model', 'screen_size', 'storage'],
      });

      const family = await catalogService.createProductFamily({
        title: 'گوشی آیفون 15',
        category: 'mobile-phones',
        attributes: {
          brand: 'Apple',
          model: 'iPhone 15',
          // screen_size and storage are missing!
        },
      });

      await expect(catalogService.approveProductFamily(family.id)).rejects.toThrow(
        ValidationError,
      );

      // Verify status remains draft
      const fetched = await catalogService.getProductFamilyById(family.id, { allowDraft: true });
      expect(fetched.status).toBe('draft');
      expect(fetched.approvedAt).toBeNull();
    });

    it('approves family when all required attributes are present and records audit event', async () => {
      // Create user for foreign key constraint
      const userRes = await pool.query<{ id: string }>(
        `INSERT INTO user_accounts (email, phone, roles, status)
         VALUES ('catalog-operator@test.ir', '+989120001122', ARRAY['catalog']::text[], 'active')
         RETURNING id;`,
      );
      const operatorUserId = userRes.rows[0]!.id;

      await catalogService.upsertCategorySchema('mobile-phones', {
        requiredAttributes: ['brand', 'model'],
      });

      const family = await catalogService.createProductFamily({
        title: 'گوشی آیفون 15',
        category: 'mobile-phones',
        attributes: {
          brand: 'Apple',
          model: 'iPhone 15',
        },
      });

      const approved = await catalogService.approveProductFamily(family.id, {
        actorUserId: operatorUserId,
        reason: 'تأیید مشخصات توسط کارشناس کاتالوگ',
      });

      expect(approved.status).toBe('approved');
      expect(approved.approvedAt).not.toBeNull();
      expect(approved.approvedBy).toBe(operatorUserId);

      // Verify audit event
      const auditEvents = await findAuditEventsByEntity(pool, 'product_family', family.id);
      const approveEvent = auditEvents.find((e) => e.action === 'catalog.family.approved');
      expect(approveEvent).toBeDefined();
      expect(approveEvent?.actorId).toBe(operatorUserId);
    });

    it('approves family when category has no schema configured', async () => {
      const family = await catalogService.createProductFamily({
        title: 'کالای بدون دسته‌بندی خاص',
        category: 'miscellaneous',
        attributes: { note: 'no schema' },
      });

      const approved = await catalogService.approveProductFamily(family.id);
      expect(approved.status).toBe('approved');
    });
  });

  describe('Approved Families Invariants & New Draft Workflow', () => {
    it('forbids editing approved families directly', async () => {
      const family = await catalogService.createProductFamily({
        title: 'لپ‌تاپ لنوو',
        category: 'laptops',
        attributes: {},
      });

      await catalogService.approveProductFamily(family.id);

      await expect(
        catalogService.updateProductFamily(family.id, {
          title: 'لپ‌تاپ لنوو تینک‌پد',
        }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('creates a new draft from an approved family preserving attributes', async () => {
      const original = await catalogService.createProductFamily({
        title: 'ساعت هوشمند گارمین',
        category: 'smartwatches',
        attributes: { brand: 'Garmin', water_resistant: true },
      });

      await catalogService.approveProductFamily(original.id);

      const newDraft = await catalogService.createDraftFromApprovedFamily(original.id, {
        title: 'ساعت هوشمند گارمین نسخه ارتقا یافته',
      });

      expect(newDraft.id).not.toBe(original.id);
      expect(newDraft.status).toBe('draft');
      expect(newDraft.originalFamilyId).toBe(original.id);
      expect(newDraft.title).toBe('ساعت هوشمند گارمین نسخه ارتقا یافته');
      expect(newDraft.category).toBe('smartwatches');
      expect(newDraft.attributes).toEqual({ brand: 'Garmin', water_resistant: true });

      // The new draft can be edited
      const updatedDraft = await catalogService.updateProductFamily(newDraft.id, {
        attributes: { brand: 'Garmin', water_resistant: true, gps: true },
      });
      expect(updatedDraft.attributes).toEqual({
        brand: 'Garmin',
        water_resistant: true,
        gps: true,
      });

      // Original remains approved
      const originalFetched = await catalogService.getProductFamilyById(original.id);
      expect(originalFetched.status).toBe('approved');
    });
  });

  describe('Public vs Admin Queries', () => {
    it('public queries return only approved families', async () => {
      const draft = await catalogService.createProductFamily({
        title: 'کالای پیش‌نویس',
        category: 'books',
        attributes: {},
      });

      const approved = await catalogService.createProductFamily({
        title: 'کالای تأیید شده',
        category: 'books',
        attributes: {},
      });
      await catalogService.approveProductFamily(approved.id);

      // Public get by ID on draft throws NotFoundError
      await expect(catalogService.getProductFamilyById(draft.id)).rejects.toThrow(NotFoundError);

      // Public get by ID on approved returns successfully
      const retrieved = await catalogService.getProductFamilyById(approved.id);
      expect(retrieved.id).toBe(approved.id);

      // Public list returns only approved
      const list = await catalogService.listApprovedProductFamilies({ page: 1, limit: 10 });
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.id).toBe(approved.id);
      expect(list.pagination.total).toBe(1);
    });
  });
});
