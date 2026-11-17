import type { BuyerTokenPayload } from '../modules/identity/domain/tokens.js';
import type { InternalSessionUser } from '../modules/identity/service.js';

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      user?: BuyerTokenPayload | InternalSessionUser;
      buyerUser?: BuyerTokenPayload;
      internalUser?: InternalSessionUser;
    }
  }
}
