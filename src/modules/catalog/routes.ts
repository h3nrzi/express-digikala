import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { CatalogService } from './service.js';
import { requireRole } from '../../middleware/auth.js';
import { ValidationError } from '../../errors.js';
import type { InternalSessionUser } from '../identity/service.js';
import type { ProductFamilyStatus } from './domain/status-machine.js';

function parseFamilyId(req: Request): string {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    throw new ValidationError('شناسه کالا الزامی است.', [
      { field: 'id', message: 'شناسه کالا الزامی است.' },
    ]);
  }
  return id;
}

function parseCategoryParam(req: Request): string {
  const rawCat = req.params.category;
  const category = Array.isArray(rawCat) ? rawCat[0] : rawCat;
  if (!category) {
    throw new ValidationError('نام دسته‌بندی الزامی است.', [
      { field: 'category', message: 'نام دسته‌بندی الزامی است.' },
    ]);
  }
  return category;
}

function getActorUserId(req: Request): string | undefined {
  const internalUser = req.internalUser ?? (req.user as InternalSessionUser | undefined);
  return internalUser?.id;
}

/**
 * Creates the internal administrative router for catalog management.
 * Protected by internal authentication and 'catalog' role.
 */
export function createCatalogAdminRouter(
  catalogService: CatalogService,
  requireInternalAuth: RequestHandler,
): Router {
  const router = Router();

  // Protect all catalog admin routes with internal auth and 'catalog' role
  router.use(requireInternalAuth, requireRole('catalog'));

  // POST /api/v1/admin/catalog/families
  router.post('/families', async (req: Request, res: Response, next) => {
    try {
      const { title, description, category, attributes, baseAttributes } = req.body ?? {};
      const actorUserId = getActorUserId(req);

      const family = await catalogService.createProductFamily({
        title,
        description,
        category,
        attributes,
        baseAttributes,
        actorUserId,
      });

      res.status(201).json({
        status: 'ok',
        family,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/catalog/families
  router.get('/families', async (req: Request, res: Response, next) => {
    try {
      const rawStatus = req.query['status'];
      const rawCategory = req.query['category'];
      const rawPage = req.query['page'];
      const rawLimit = req.query['limit'];

      const status = typeof rawStatus === 'string' ? (rawStatus.trim() as ProductFamilyStatus) : undefined;
      const category = typeof rawCategory === 'string' ? rawCategory.trim() : undefined;
      const page = typeof rawPage === 'string' ? parseInt(rawPage, 10) : undefined;
      const limit = typeof rawLimit === 'string' ? parseInt(rawLimit, 10) : undefined;

      const filter: {
        status?: ProductFamilyStatus;
        category?: string;
        page?: number;
        limit?: number;
      } = {};
      if (status !== undefined) filter.status = status;
      if (category !== undefined) filter.category = category;
      if (page !== undefined && !Number.isNaN(page)) filter.page = page;
      if (limit !== undefined && !Number.isNaN(limit)) filter.limit = limit;

      const result = await catalogService.listProductFamilies(filter);

      res.status(200).json({
        status: 'ok',
        families: result.items,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/catalog/families/:id
  router.get('/families/:id', async (req: Request, res: Response, next) => {
    try {
      const id = parseFamilyId(req);
      const family = await catalogService.getProductFamilyById(id, { allowDraft: true });

      res.status(200).json({
        status: 'ok',
        family,
      });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/v1/admin/catalog/families/:id
  router.patch('/families/:id', async (req: Request, res: Response, next) => {
    try {
      const id = parseFamilyId(req);
      const { title, description, category, attributes, baseAttributes, reason } = req.body ?? {};
      const actorUserId = getActorUserId(req);

      const family = await catalogService.updateProductFamily(id, {
        title,
        description,
        category,
        attributes,
        baseAttributes,
        actorUserId,
        reason,
      });

      res.status(200).json({
        status: 'ok',
        family,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/catalog/families/:id/approve
  router.post('/families/:id/approve', async (req: Request, res: Response, next) => {
    try {
      const id = parseFamilyId(req);
      const { reason } = req.body ?? {};
      const actorUserId = getActorUserId(req);

      const family = await catalogService.approveProductFamily(id, {
        actorUserId,
        reason,
      });

      res.status(200).json({
        status: 'ok',
        family,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/catalog/families/:id/draft
  router.post('/families/:id/draft', async (req: Request, res: Response, next) => {
    try {
      const id = parseFamilyId(req);
      const { title, description, attributes, baseAttributes, reason } = req.body ?? {};
      const actorUserId = getActorUserId(req);

      const family = await catalogService.createDraftFromApprovedFamily(id, {
        title,
        description,
        attributes,
        baseAttributes,
        actorUserId,
        reason,
      });

      res.status(201).json({
        status: 'ok',
        family,
      });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/admin/catalog/categories/:category/schema
  router.put('/categories/:category/schema', async (req: Request, res: Response, next) => {
    try {
      const category = parseCategoryParam(req);
      const { requiredAttributes, required_attributes, optionalAttributes, optional_attributes, description } =
        req.body ?? {};
      const actorUserId = getActorUserId(req);

      const reqAttrs = requiredAttributes ?? required_attributes ?? [];
      const optAttrs = optionalAttributes ?? optional_attributes ?? [];

      const schema = await catalogService.upsertCategorySchema(category, {
        requiredAttributes: reqAttrs,
        optionalAttributes: optAttrs,
        description,
        actorUserId,
      });

      res.status(200).json({
        status: 'ok',
        schema,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/catalog/categories/:category/schema (alias for upsert)
  router.post('/categories/:category/schema', async (req: Request, res: Response, next) => {
    try {
      const category = parseCategoryParam(req);
      const { requiredAttributes, required_attributes, optionalAttributes, optional_attributes, description } =
        req.body ?? {};
      const actorUserId = getActorUserId(req);

      const reqAttrs = requiredAttributes ?? required_attributes ?? [];
      const optAttrs = optionalAttributes ?? optional_attributes ?? [];

      const schema = await catalogService.upsertCategorySchema(category, {
        requiredAttributes: reqAttrs,
        optionalAttributes: optAttrs,
        description,
        actorUserId,
      });

      res.status(200).json({
        status: 'ok',
        schema,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/catalog/categories/:category/schema
  router.get('/categories/:category/schema', async (req: Request, res: Response, next) => {
    try {
      const category = parseCategoryParam(req);
      const schema = await catalogService.getCategorySchema(category);

      res.status(200).json({
        status: 'ok',
        schema,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/catalog/categories
  router.get('/categories', async (_req: Request, res: Response, next) => {
    try {
      const schemas = await catalogService.listCategorySchemas();
      res.status(200).json({
        status: 'ok',
        categories: schemas,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Creates the public unauthenticated router for catalog browsing.
 */
export function createCatalogPublicRouter(catalogService: CatalogService): Router {
  const router = Router();

  // GET /api/v1/catalog/families
  router.get('/families', async (req: Request, res: Response, next) => {
    try {
      const rawPage = req.query['page'];
      const rawLimit = req.query['limit'];

      const page = typeof rawPage === 'string' ? parseInt(rawPage, 10) : undefined;
      const limit = typeof rawLimit === 'string' ? parseInt(rawLimit, 10) : undefined;

      const pagination: { page?: number; limit?: number } = {};
      if (page !== undefined && !Number.isNaN(page)) pagination.page = page;
      if (limit !== undefined && !Number.isNaN(limit)) pagination.limit = limit;

      const result = await catalogService.listApprovedProductFamilies(pagination);

      res.status(200).json({
        status: 'ok',
        families: result.items,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/catalog/families/:id
  router.get('/families/:id', async (req: Request, res: Response, next) => {
    try {
      const id = parseFamilyId(req);
      const family = await catalogService.getProductFamilyById(id, { allowDraft: false });

      res.status(200).json({
        status: 'ok',
        family,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
