import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireRole } from '../../src/middleware/auth.js';
import { ForbiddenError, MfaRequiredError, UnauthorizedError } from '../../src/errors.js';
import type { InternalSessionUser } from '../../src/modules/identity/service.js';

describe('Role Middleware Factory (requireRole)', () => {
  function createMockContext(user?: Partial<InternalSessionUser>) {
    const req = {
      internalUser: user ? (user as InternalSessionUser) : undefined,
      user: user ? (user as InternalSessionUser) : undefined,
    } as unknown as Request;

    const res = {} as Response;
    const next = vi.fn();

    return { req, res, next };
  }

  describe('Authentication and MFA verification', () => {
    it('throws UnauthorizedError when request is unauthenticated', () => {
      const middleware = requireRole('catalog');
      const { req, res, next } = createMockContext(undefined);

      expect(() => middleware(req, res, next)).toThrow(UnauthorizedError);
      expect(next).not.toHaveBeenCalled();
    });

    it('throws MfaRequiredError when session has not completed MFA', () => {
      const middleware = requireRole('catalog');
      const { req, res, next } = createMockContext({
        id: 'u1',
        email: 'u1@marketplace.ir',
        phone: '+989120000001',
        roles: ['catalog'],
        mfaVerified: false,
      });

      expect(() => middleware(req, res, next)).toThrow(MfaRequiredError);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Role-based authorization', () => {
    it('allows access when user possesses the required role', () => {
      const middleware = requireRole('catalog');
      const { req, res, next } = createMockContext({
        id: 'u1',
        email: 'catalog@marketplace.ir',
        phone: '+989120000001',
        roles: ['catalog'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows access when user has one of several accepted roles', () => {
      const middleware = requireRole('support', 'order-ops');
      const { req, res, next } = createMockContext({
        id: 'u2',
        email: 'ops@marketplace.ir',
        phone: '+989120000002',
        roles: ['order-ops'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('throws ForbiddenError when user does not hold the required role', () => {
      const middleware = requireRole('seller-mgmt');
      const { req, res, next } = createMockContext({
        id: 'u3',
        email: 'support@marketplace.ir',
        phone: '+989120000003',
        roles: ['support'],
        mfaVerified: true,
      });

      expect(() => middleware(req, res, next)).toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Separation of Duties (SoD) enforcement for access-admin', () => {
    it('blocks access-admin from finance routes even if finance role is also assigned', () => {
      const middleware = requireRole('finance');
      const { req, res, next } = createMockContext({
        id: 'u4',
        email: 'admin.finance@marketplace.ir',
        phone: '+989120000004',
        roles: ['access-admin', 'finance'],
        mfaVerified: true,
      });

      expect(() => middleware(req, res, next)).toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });

    it('blocks access-admin from order-ops routes even if order-ops role is also assigned', () => {
      const middleware = requireRole('order-ops');
      const { req, res, next } = createMockContext({
        id: 'u5',
        email: 'admin.ops@marketplace.ir',
        phone: '+989120000005',
        roles: ['access-admin', 'order-ops'],
        mfaVerified: true,
      });

      expect(() => middleware(req, res, next)).toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows pure finance role without access-admin into finance routes', () => {
      const middleware = requireRole('finance');
      const { req, res, next } = createMockContext({
        id: 'u6',
        email: 'finance.lead@marketplace.ir',
        phone: '+989120000006',
        roles: ['finance'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows pure order-ops role without access-admin into order-ops routes', () => {
      const middleware = requireRole('order-ops');
      const { req, res, next } = createMockContext({
        id: 'u7',
        email: 'order.lead@marketplace.ir',
        phone: '+989120000007',
        roles: ['order-ops'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows access-admin to access access-admin routes', () => {
      const middleware = requireRole('access-admin');
      const { req, res, next } = createMockContext({
        id: 'u8',
        email: 'admin@marketplace.ir',
        phone: '+989120000008',
        roles: ['access-admin'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
