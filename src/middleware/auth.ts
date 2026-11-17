import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, MfaRequiredError, UnauthorizedError } from '../errors.js';
import { verifyBuyerToken } from '../modules/identity/domain/tokens.js';
import type { IdentityService, InternalSessionUser } from '../modules/identity/service.js';

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

export function requireAccessAdmin(req: Request, _res: Response, next: NextFunction): void {
  const roles =
    req.internalUser?.roles ?? (req.user as InternalSessionUser | undefined)?.roles ?? [];

  if (!roles.includes('access-admin')) {
    throw new ForbiddenError('فقط کاربر با نقش راهبر دسترسی مجاز به انجام این عملیات است.');
  }

  next();
}
