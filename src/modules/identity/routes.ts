import { Router, type Request, type Response } from 'express';
import type { IdentityService, InternalSessionUser } from './service.js';
import type { RequestHandler } from 'express';
import { UnauthorizedError, ValidationError } from '../../errors.js';
import type { BuyerTokenPayload } from './domain/tokens.js';
import { requireRole } from '../../middleware/auth.js';
import { OPERATIONAL_ROLES, type OperationalRole } from './domain/roles.js';

export function createIdentityRouter(
  identityService: IdentityService,
  requireBuyerAuth: RequestHandler,
): Router {
  const router = Router();

  // POST /api/v1/auth/otp/send
  router.post('/otp/send', async (req: Request, res: Response, next) => {
    try {
      const { phone } = req.body ?? {};
      const result = await identityService.requestOtp(phone);
      res.status(200).json({
        success: true,
        message: 'کد تأیید با موفقیت برای شماره همراه شما ارسال شد.',
        phone: result.phone,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/otp/verify
  router.post('/otp/verify', async (req: Request, res: Response, next) => {
    try {
      const { phone, code } = req.body ?? {};
      const result = await identityService.verifyOtp(phone, code);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Protected route for verifying buyer session / token
  // GET /api/v1/auth/me
  router.get('/me', requireBuyerAuth, (req: Request, res: Response) => {
    const buyer = req.buyerUser ?? (req.user as BuyerTokenPayload | undefined);
    res.status(200).json({
      user: {
        id: buyer?.sub,
        phone: buyer?.phone,
        role: buyer?.role,
      },
    });
  });

  return router;
}

export function createAdminRouter(
  identityService: IdentityService,
  requireInternalAuth: RequestHandler,
  requireAccessAdmin: RequestHandler,
): Router {
  const router = Router();

  // Public operational auth routes
  // POST /api/v1/admin/auth/setup
  router.post('/auth/setup', async (req: Request, res: Response, next) => {
    try {
      const { token, inviteToken, password, fullName } = req.body ?? {};
      const user = await identityService.setupOperationalAccount({
        token: token ?? inviteToken,
        password,
        fullName,
      });

      res.status(200).json({
        success: true,
        message:
          'حساب کاربری با موفقیت راه‌اندازی شد. اکنون می‌توانید با ایمیل و رمز عبور خود وارد شوید.',
        user,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/auth/login
  router.post('/auth/login', async (req: Request, res: Response, next) => {
    try {
      const { email, password } = req.body ?? {};
      const result = await identityService.loginOperationalUser({ email, password });

      res.status(200).json({
        success: true,
        sessionToken: result.sessionToken,
        mfaRequired: result.mfaRequired,
        message: 'کد تأیید دو مرحله‌ای به شماره همراه شما ارسال شد.',
        user: result.user,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/auth/mfa/verify
  router.post('/auth/mfa/verify', async (req: Request, res: Response, next) => {
    try {
      const authHeader = req.header('Authorization');
      let sessionToken = req.body?.sessionToken;

      if (!sessionToken && authHeader && authHeader.startsWith('Bearer ')) {
        sessionToken = authHeader.substring(7).trim();
      }

      if (!sessionToken) {
        throw new UnauthorizedError('توکن نشست ارسال نشده است.');
      }

      const { code } = req.body ?? {};
      const result = await identityService.verifyMfa({ sessionToken, code });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/me (Protected internal route, guarded by operational role check)
  router.get(
    '/me',
    requireInternalAuth,
    requireRole(...OPERATIONAL_ROLES),
    (req: Request, res: Response) => {
      const user = req.internalUser ?? (req.user as InternalSessionUser);
      res.status(200).json({
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          roles: user.roles,
          mfaVerified: user.mfaVerified,
        },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Internal Route Groups (RBAC guarded)
  // ---------------------------------------------------------------------------

  // Group: User & Access Management (access-admin only)
  const usersRouter = Router();
  usersRouter.use(requireInternalAuth, requireAccessAdmin);

  // POST /api/v1/admin/users/invite
  usersRouter.post('/invite', async (req: Request, res: Response, next) => {
    try {
      const { email, phone, roles, fullName } = req.body ?? {};
      const adminId = (req.internalUser ?? (req.user as InternalSessionUser | undefined))?.id;
      const invite = await identityService.inviteOperationalUser(adminId ?? null, {
        email,
        phone,
        roles,
        fullName,
      });

      res.status(201).json({
        success: true,
        invite,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/users/:id/roles
  usersRouter.post('/:id/roles', async (req: Request, res: Response, next) => {
    try {
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!id) {
        throw new ValidationError('شناسه کاربر الزامی است.', [
          { field: 'id', message: 'شناسه کاربر الزامی است.' },
        ]);
      }

      const { roles } = req.body ?? {};
      if (!roles) {
        throw new ValidationError('فیلد roles الزامی است.', [
          { field: 'roles', message: 'فیلد roles الزامی است.' },
        ]);
      }

      const granter = req.internalUser ?? (req.user as InternalSessionUser | undefined);
      if (!granter) {
        throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
      }

      const updatedUser = await identityService.updateUserRoles({
        userId: id,
        granterUser: granter,
        roles,
      });

      res.status(200).json({
        success: true,
        message: 'نقش‌های کاربر با موفقیت به‌روزرسانی شد.',
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          phone: updatedUser.phone,
          roles: updatedUser.roles,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.use('/users', usersRouter);

  // Operational Route Groups (seller-mgmt, catalog, order-ops, support, finance)
  const operationalGroups: Array<{ path: string; role: OperationalRole }> = [
    { path: '/sellers', role: 'seller-mgmt' },
    { path: '/catalog', role: 'catalog' },
    { path: '/orders', role: 'order-ops' },
    { path: '/support', role: 'support' },
    { path: '/finance', role: 'finance' },
  ];

  for (const group of operationalGroups) {
    const groupRouter = Router();
    groupRouter.use(requireInternalAuth, requireRole(group.role));
    groupRouter.get('/', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', group: group.role });
    });
    router.use(group.path, groupRouter);
  }

  return router;
}
