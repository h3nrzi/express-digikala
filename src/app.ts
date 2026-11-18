import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from './config/index.js';
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

export interface AppDependencies {
  pool: Pool;
  config: AppConfig;
  smsSender?: SmsSenderPort;
  sellerService?: SellerService;
}

export interface AppContext {
  app: Express;
  identityService: IdentityService;
  sellerService: SellerService;
  smsSender: SmsSenderPort;
}

export function createApp(deps: AppDependencies): AppContext {
  const app = express();

  // Core HTTP middlewares
  app.use(express.json());
  app.use(traceMiddleware);

  // Initialize ports and services
  const smsSender = deps.smsSender ?? new InMemorySmsSender();
  const identityService = new IdentityService(deps.pool, smsSender, {
    jwtSecret: deps.config.jwtSecret,
    jwtExpiresIn: deps.config.jwtExpiresIn,
    otpTtlSeconds: deps.config.otpTtlSeconds,
    otpRateLimitMaxAttempts: deps.config.otpRateLimitMaxAttempts,
    otpRateLimitWindowSeconds: deps.config.otpRateLimitWindowSeconds,
  });
  const sellerService = deps.sellerService ?? new SellerService(deps.pool);

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
  app.use('/api/v1/admin', adminRouter);

  // Global structured error handler
  app.use(errorHandler);

  return {
    app,
    identityService,
    sellerService,
    smsSender,
  };
}
