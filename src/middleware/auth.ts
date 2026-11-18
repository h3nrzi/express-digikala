import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, MfaRequiredError, UnauthorizedError } from '../errors.js';
import { verifyBuyerToken } from '../modules/identity/domain/tokens.js';
import type { IdentityService, InternalSessionUser } from '../modules/identity/service.js';
import { ACCESS_ADMIN_ROLE, type OperationalRole } from '../modules/identity/domain/roles.js';

export function createAuthMiddleware(jwtSecret: string) {
  return function requireBuyerAuth(req: Request, _res: Response, next: NextFunction): void {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      throw new UnauthorizedError('توکن احراز هویت معتبر نیست.');
    }

    try {
      const payload = verifyBuyerToken(token, jwtSecret);
      if (payload.role !== 'buyer') {
        throw new UnauthorizedError('دسترسی مجاز برای این عملیات وجود ندارد.');
      }
      req.user = payload;
      req.buyerUser = payload;
      next();
    } catch {
      throw new UnauthorizedError('توکن احراز هویت نامعتبر یا منقضی شده است.');
    }
  };
}

export function createInternalAuthMiddleware(identityService: IdentityService) {
  return async function requireInternalAuth(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      throw new UnauthorizedError('توکن احراز هویت معتبر نیست.');
    }

    try {
      const sessionResult = await identityService.validateInternalSession(token);
      if (!sessionResult.valid || !sessionResult.user) {
        throw new UnauthorizedError('نشست نامعتبر یا منقضی شده است.');
      }

      if (!sessionResult.mfaVerified) {
        throw new MfaRequiredError(
          'برای دسترسی به این بخش، تکمیل احراز هویت دو مرحله‌ای (MFA) الزامی است.',
        );
      }

      req.user = sessionResult.user;
      req.internalUser = sessionResult.user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Role middleware factory that verifies the authenticated internal user possesses at least one
 * of the allowed operational roles, while strictly enforcing Separation of Duties (SoD):
 * the `access-admin` role is explicitly barred from financial and order operations.
 */
export function requireRole(...allowedRoles: OperationalRole[]) {
  return function roleMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const user = req.internalUser ?? (req.user as InternalSessionUser | undefined);

    if (!user) {
      throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
    }

    if (!user.mfaVerified) {
      throw new MfaRequiredError(
        'برای دسترسی به این بخش، تکمیل احراز هویت دو مرحله‌ای (MFA) الزامی است.',
      );
    }

    const userRoles = user.roles ?? [];

    // Critical Separation of Duties (SoD) invariant:
    // access-admin cannot perform financial or order operations even if assigned both roles.
    const isRestrictedRouteGroup = allowedRoles.some(
      (role) => role === 'finance' || role === 'order-ops',
    );
    if (isRestrictedRouteGroup && userRoles.includes(ACCESS_ADMIN_ROLE)) {
      throw new ForbiddenError(
        'کاربران با نقش راهبر دسترسی مجاز به عملیات مالی یا سفارشات نیستند.',
      );
    }

    const hasAllowedRole = allowedRoles.some((role) => userRoles.includes(role));
    if (!hasAllowedRole) {
      throw new ForbiddenError('دسترسی غیرمجاز. شما مجوز لازم برای انجام این عملیات را ندارید.');
    }

    next();
  };
}

export const requireAccessAdmin = requireRole(ACCESS_ADMIN_ROLE);
