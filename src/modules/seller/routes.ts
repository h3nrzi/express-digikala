import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { SellerService } from './service.js';
import { requireRole } from '../../middleware/auth.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../errors.js';
import type { InternalSessionUser } from '../identity/service.js';
import type { SellerStatus } from './domain/status-machine.js';

function parseSellerId(req: Request): string {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    throw new ValidationError('شناسه فروشنده الزامی است.', [
      { field: 'id', message: 'شناسه فروشنده الزامی است.' },
    ]);
  }
  return id;
}

export function createSellerAdminRouter(
  sellerService: SellerService,
  requireInternalAuth: RequestHandler,
): Router {
  const router = Router();

  // Protect all seller management routes with internal auth and 'seller-mgmt' role
  router.use(requireInternalAuth, requireRole('seller-mgmt'));

  // POST /api/v1/admin/sellers
  router.post('/', async (req: Request, res: Response, next) => {
    try {
      const { name, taxpayerId, contact } = req.body ?? {};
      const seller = await sellerService.createSeller({
        name,
        taxpayerId,
        contact,
      });

      res.status(201).json({
        status: 'ok',
        seller,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/sellers
  router.get('/', async (req: Request, res: Response, next) => {
    try {
      const rawStatus = req.query['status'];
      const statusParam =
        typeof rawStatus === 'string' ? (rawStatus.trim() as SellerStatus) : undefined;

      const sellers = await sellerService.listSellers(
        statusParam ? { status: statusParam } : undefined,
      );

      res.status(200).json({
        status: 'ok',
        group: 'seller-mgmt',
        sellers,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/sellers/:id
  router.get('/:id', async (req: Request, res: Response, next) => {
    try {
      const id = parseSellerId(req);

      const seller = await sellerService.getSellerById(id);
      if (!seller) {
        throw new NotFoundError('فروشنده‌ای با شناسه مورد نظر یافت نشد.');
      }

      res.status(200).json({
        status: 'ok',
        seller,
      });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/v1/admin/sellers/:id/status
  router.patch('/:id/status', async (req: Request, res: Response, next) => {
    try {
      const id = parseSellerId(req);

      const { status: newStatus, reason } = req.body ?? {};
      if (!newStatus) {
        throw new ValidationError('فیلد status الزامی است.', [
          { field: 'status', message: 'فیلد status الزامی است.' },
        ]);
      }

      const internalUser = req.internalUser ?? (req.user as InternalSessionUser | undefined);
      if (!internalUser) {
        throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
      }

      const updatedSeller = await sellerService.transitionSellerStatus({
        sellerId: id,
        newStatus,
        actorUserId: internalUser.id,
        reason: typeof reason === 'string' ? reason.trim() : null,
      });

      res.status(200).json({
        status: 'ok',
        seller: updatedSeller,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/sellers/:id/suspend
  router.post('/:id/suspend', async (req: Request, res: Response, next) => {
    try {
      const id = parseSellerId(req);

      const { reason } = req.body ?? {};
      if (typeof reason !== 'string' || !reason.trim()) {
        throw new ValidationError('علت تعلیق فروشنده الزامی است.', [
          { field: 'reason', message: 'علت تعلیق الزامی است.' },
        ]);
      }

      const internalUser = req.internalUser ?? (req.user as InternalSessionUser | undefined);
      if (!internalUser) {
        throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
      }

      const result = await sellerService.suspendSeller({
        sellerId: id,
        actorUserId: internalUser.id,
        reason: reason.trim(),
      });

      res.status(200).json({
        status: 'ok',
        seller: result.seller,
        affectedOffersCount: result.affectedOffersCount,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/sellers/:id/reinstate
  router.post('/:id/reinstate', async (req: Request, res: Response, next) => {
    try {
      const id = parseSellerId(req);

      const { reason } = req.body ?? {};

      const internalUser = req.internalUser ?? (req.user as InternalSessionUser | undefined);
      if (!internalUser) {
        throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
      }

      const result = await sellerService.reinstateSeller({
        sellerId: id,
        actorUserId: internalUser.id,
        reason: typeof reason === 'string' ? reason.trim() : undefined,
      });

      res.status(200).json({
        status: 'ok',
        seller: result.seller,
        affectedOffersCount: result.affectedOffersCount,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
