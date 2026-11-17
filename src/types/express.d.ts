import type { BuyerTokenPayload } from '../modules/identity/domain/tokens.js';
import type { InternalSessionUser } from '../modules/identity/service.js';

export interface AuthenticatedUser {
  id?: string;
  sub?: string;
  phone?: string;
  email?: string;
  role?: string;
  roles?: string[];
  mfaVerified?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      user?: BuyerTokenPayload | InternalSessionUser | AuthenticatedUser;
      buyerUser?: BuyerTokenPayload;
      internalUser?: InternalSessionUser;
    }
  }
}
