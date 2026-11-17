import type { BuyerTokenPayload } from '../modules/identity/domain/tokens.js';

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      user?: BuyerTokenPayload;
    }
  }
}
