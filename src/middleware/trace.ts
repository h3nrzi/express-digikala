import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingTraceId = req.header('X-Trace-Id') || req.header('X-Request-Id');
  const traceId =
    incomingTraceId && typeof incomingTraceId === 'string' ? incomingTraceId : crypto.randomUUID();

  req.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  next();
}
