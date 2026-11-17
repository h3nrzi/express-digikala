import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors.js';

export interface ErrorResponseBody {
  code: string;
  message: string;
  traceId: string;
  details?: Array<{ field: string; message: string }>;
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const traceId = req.traceId ?? 'unknown-trace-id';

  if (err instanceof AppError) {
    if (err.retryAfterSeconds) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }

    const body: ErrorResponseBody = {
      code: err.code,
      message: err.message,
      traceId,
      ...(err.details && err.details.length > 0 ? { details: err.details } : {}),
    };

    res.status(err.statusCode).json(body);
    return;
  }

  // Handle unhandled unexpected errors
  res.status(500).json({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'خطای غیرمنتظره‌ای در سرور رخ داده است.',
    traceId,
  });
}
