import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../errors.js';
import { verifyBuyerToken } from '../modules/identity/domain/tokens.js';

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
      next();
    } catch {
      throw new UnauthorizedError('توکن احراز هویت نامعتبر یا منقضی شده است.');
    }
  };
}
