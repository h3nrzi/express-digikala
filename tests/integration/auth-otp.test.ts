import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import type { Express } from 'express';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createApp } from '../../src/app.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';

describe('Buyer OTP Auth Integration Tests', () => {
  let pool: Pool;
  let app: Express;
  let smsSender: InMemorySmsSender;

  beforeAll(async () => {
    const config = loadConfig({}, { loadDotenv: false });
    pool = createDbPool({ connectionString: config.testDatabaseUrl });

    smsSender = new InMemorySmsSender();
    const appContext = createApp({
      pool,
      config: {
        ...config,
        jwtSecret: 'test-secret-long-enough-for-safe-signing',
        otpTtlSeconds: 120,
        otpRateLimitMaxAttempts: 3,
        otpRateLimitWindowSeconds: 60,
      },
      smsSender,
    });

    app = appContext.app;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');
    smsSender.clear();
  });

  describe('Happy Path: OTP Send -> Verify -> Protected Route', () => {
    it('authenticates buyer and grants access to protected routes with Bearer token', async () => {
      // 1. Request OTP with 11-digit Iranian mobile format
      const sendRes = await request(app)
        .post('/api/v1/auth/otp/send')
        .send({ phone: '09121234567' });

      expect(sendRes.status).toBe(200);
      expect(sendRes.body.success).toBe(true);
      expect(sendRes.body.phone).toBe('+989121234567');
      expect(sendRes.headers['x-trace-id']).toBeDefined();

      // Verify SMS delivery adapter received the code
      const sentMessage = smsSender.getLastMessageFor('+989121234567');
      expect(sentMessage).toBeDefined();
      expect(sentMessage?.code).toMatch(/^\d{6}$/);

      // 2. Verify OTP with received code
      const verifyRes = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: sentMessage!.code });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.token).toBeDefined();
      expect(verifyRes.body.user).toMatchObject({
        phone: '+989121234567',
        role: 'buyer',
        status: 'active',
      });
      expect(verifyRes.body.user.id).toBeDefined();

      const token = verifyRes.body.token;

      // 3. Access protected route with Bearer token
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user).toMatchObject({
        id: verifyRes.body.user.id,
        phone: '+989121234567',
        role: 'buyer',
      });
    });

    it('accepts E.164 phone format (+989...) on send and verify', async () => {
      const sendRes = await request(app)
        .post('/api/v1/auth/otp/send')
        .send({ phone: '+989351234567' });

      expect(sendRes.status).toBe(200);
      const sentMessage = smsSender.getLastMessageFor('+989351234567');

      const verifyRes = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+989351234567', code: sentMessage!.code });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.user.phone).toBe('+989351234567');
    });
  });

  describe('Validation & Error Scenarios', () => {
    it('rejects malformed phone numbers with structured error', async () => {
      const invalidPhones = ['08123456789', '0912', '0912345678901', '0912abc5678', ''];

      for (const invalidPhone of invalidPhones) {
        const res = await request(app).post('/api/v1/auth/otp/send').send({ phone: invalidPhone });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(res.body.message).toBeDefined();
        expect(res.body.traceId).toBeDefined();
        expect(res.body.details).toEqual(
          expect.arrayContaining([expect.objectContaining({ field: 'phone' })]),
        );
      }
    });

    it('rejects malformed OTP codes during verification', async () => {
      const res = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: '123' }); // short code

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'code' })]),
      );
    });

    it('rejects wrong OTP code with structured error', async () => {
      await request(app).post('/api/v1/auth/otp/send').send({ phone: '09121234567' });

      const res = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: '000000' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_OTP');
      expect(res.body.message).toBe('کد تأیید واردشده نادرست است.');
      expect(res.body.traceId).toBeDefined();
    });

    it('rejects expired OTP code with structured error', async () => {
      await request(app).post('/api/v1/auth/otp/send').send({ phone: '09121234567' });

      const sentMessage = smsSender.getLastMessageFor('+989121234567');

      // Force expire code in DB
      await pool.query(
        "UPDATE otp_requests SET expires_at = NOW() - INTERVAL '5 seconds' WHERE phone = $1",
        ['+989121234567'],
      );

      const res = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: sentMessage!.code });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OTP_EXPIRED');
      expect(res.body.traceId).toBeDefined();
    });

    it('enforces rate-limiting on OTP send to prevent abuse', async () => {
      const phone = '09129998877';

      // 3 attempts are allowed within 60s
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/v1/auth/otp/send').send({ phone });
        expect(res.status).toBe(200);
      }

      // 4th attempt should be blocked with 429
      const breachRes = await request(app).post('/api/v1/auth/otp/send').send({ phone });

      expect(breachRes.status).toBe(429);
      expect(breachRes.body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(breachRes.body.message).toBeDefined();
      expect(breachRes.headers['retry-after']).toBeDefined();
      expect(breachRes.body.traceId).toBeDefined();
    });
  });

  describe('Auth Middleware Security on Protected Routes', () => {
    it('rejects request without Authorization header', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(res.body.traceId).toBeDefined();
    });

    it('rejects request with invalid token string', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer invalid.token.string');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects request with expired Bearer token', async () => {
      // Create token that expired 10 seconds ago
      const appContext = createApp({
        pool,
        config: {
          ...loadConfig({}, { loadDotenv: false }),
          jwtSecret: 'test-secret-long-enough-for-safe-signing',
          jwtExpiresIn: '0s',
        },
      });

      const expiredTokenApp = appContext.app;

      await request(expiredTokenApp).post('/api/v1/auth/otp/send').send({ phone: '09121234567' });

      const sms = appContext.smsSender as InMemorySmsSender;
      const code = sms.getLastMessageFor('+989121234567')!.code;

      const verifyRes = await request(expiredTokenApp)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code });

      const expiredToken = verifyRes.body.token;

      // Wait 50ms so exp is in the past
      await new Promise((resolve) => setTimeout(resolve, 50));

      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(meRes.status).toBe(401);
      expect(meRes.body.code).toBe('UNAUTHORIZED');
    });
  });
});
