import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from './config/index.js';
import { ValidationError } from './errors.js';
import { errorHandler } from './middleware/error.js';
import { traceMiddleware } from './middleware/trace.js';
import {
  createAuthMiddleware,
  createInternalAuthMiddleware,
  requireAccessAdmin,
} from './middleware/auth.js';
import { IdentityService } from './modules/identity/service.js';
import { createAdminRouter, createIdentityRouter } from './modules/identity/routes.js';
import { type SmsSenderPort, InMemorySmsSender } from './modules/identity/ports/sms-sender.js';
import { SellerService } from './modules/seller/service.js';
import { createSellerAdminRouter } from './modules/seller/routes.js';
import {
  CatalogService,
  createCatalogAdminRouter,
  createCatalogPublicRouter,
} from './modules/catalog/index.js';

export interface AppDependencies {
  pool: Pool;
  config: AppConfig;
  smsSender?: SmsSenderPort;
  sellerService?: SellerService;
  catalogService?: CatalogService;
}

export interface AppContext {
  app: Express;
  identityService: IdentityService;
  sellerService: SellerService;
  catalogService: CatalogService;
  smsSender: SmsSenderPort;
}

export function createApp(deps: AppDependencies): AppContext {
  const app = express();

  // Core HTTP middlewares
  app.use(express.json());
  app.use(traceMiddleware);

  // Initialize ports and services
  const smsSender = deps.smsSender ?? new InMemorySmsSender(deps.config.nodeEnv === 'development');
  const identityService = new IdentityService(deps.pool, smsSender, {
    jwtSecret: deps.config.jwtSecret,
    jwtExpiresIn: deps.config.jwtExpiresIn,
    otpTtlSeconds: deps.config.otpTtlSeconds,
    otpRateLimitMaxAttempts: deps.config.otpRateLimitMaxAttempts,
    otpRateLimitWindowSeconds: deps.config.otpRateLimitWindowSeconds,
  });
  const sellerService = deps.sellerService ?? new SellerService(deps.pool);
  const catalogService = deps.catalogService ?? new CatalogService(deps.pool);

  const requireBuyerAuth = createAuthMiddleware(deps.config.jwtSecret);
  const requireInternalAuth = createInternalAuthMiddleware(identityService);

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Mount modules
  const authRouter = createIdentityRouter(identityService, requireBuyerAuth);
  app.use('/api/v1/auth', authRouter);

  const adminRouter = createAdminRouter(identityService, requireInternalAuth, requireAccessAdmin);
  const sellerRouter = createSellerAdminRouter(sellerService, requireInternalAuth);
  adminRouter.use('/sellers', sellerRouter);

  const catalogAdminRouter = createCatalogAdminRouter(catalogService, requireInternalAuth);
  adminRouter.use('/catalog', catalogAdminRouter);
  app.use('/api/v1/admin', adminRouter);

  // Public catalog router (unauthenticated)
  const catalogRouter = express.Router();
  const catalogPublicRouter = createCatalogPublicRouter(catalogService);
  catalogRouter.use(catalogPublicRouter);

  catalogRouter.get('/variants/:variantId/offers', async (req, res, next) => {
    try {
      const rawVariantId = req.params['variantId'];
      const variantId = Array.isArray(rawVariantId) ? rawVariantId[0] : rawVariantId;
      if (!variantId) {
        throw new ValidationError('شناسه گونه کالا الزامی است.', [
          { field: 'variantId', message: 'شناسه گونه کالا الزامی است.' },
        ]);
      }
      const offers = await sellerService.getPublicOffersForVariant(variantId);
      res.status(200).json({
        status: 'ok',
        variantId,
        offers,
      });
    } catch (err) {
      next(err);
    }
  });
  app.use('/api/v1/catalog', catalogRouter);

  // Shopping cart router (buyer auth protected)
  const cartRouter = express.Router();
  cartRouter.put('/lines/:offerId', requireBuyerAuth, async (req, res, next) => {
    try {
      const rawOfferId = req.params['offerId'];
      const offerId = Array.isArray(rawOfferId) ? rawOfferId[0] : rawOfferId;
      if (!offerId) {
        throw new ValidationError('شناسه پیشنهاد الزامی است.', [
          { field: 'offerId', message: 'شناسه پیشنهاد الزامی است.' },
        ]);
      }
      const offer = await sellerService.assertOfferPurchasableForCart(offerId);
      res.status(200).json({
        status: 'ok',
        line: {
          offerId: offer.id,
          sellerId: offer.sellerId,
          variantId: offer.variantId,
          price: offer.price,
        },
      });
    } catch (err) {
      next(err);
    }
  });
  app.use('/api/v1/cart', cartRouter);

  // Global structured error handler
  app.use(errorHandler);

  return {
    app,
    identityService,
    sellerService,
    catalogService,
    smsSender,
  };
}
