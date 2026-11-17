import { Router, type Request, type Response } from 'express';
import type { IdentityService } from './service.js';
import type { RequestHandler } from 'express';

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
    res.status(200).json({
      user: {
        id: req.user?.sub,
        phone: req.user?.phone,
        role: req.user?.role,
      },
    });
  });

  return router;
}
