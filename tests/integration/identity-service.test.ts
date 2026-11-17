import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool } from '../../src/db/index.js';
import { DEFAULT_TEST_DB_URL } from '../../src/config/index.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';
import {
  InvalidOtpError,
  OtpExpiredError,
  RateLimitError,
  ValidationError,
} from '../../src/errors.js';

describe('IdentityService Integration', () => {
  let pool: Pool;
  let smsSender: InMemorySmsSender;
  let service: IdentityService;

  beforeAll(async () => {
    const testDbUrl = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DB_URL;
    pool = createDbPool({ connectionString: testDbUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clean test tables
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');

    smsSender = new InMemorySmsSender();
    service = new IdentityService(pool, smsSender, {
      jwtSecret: 'test-jwt-secret-with-sufficient-length',
      jwtExpiresIn: '1h',
      otpTtlSeconds: 120,
      otpRateLimitMaxAttempts: 2,
      otpRateLimitWindowSeconds: 60,
    });
  });

  it('sends OTP and verifies successfully, creating user', async () => {
    const sendResult = await service.requestOtp('09121112233');
    expect(sendResult.success).toBe(true);
    expect(sendResult.phone).toBe('+989121112233');

    const sentMessage = smsSender.getLastMessageFor('+989121112233');
    expect(sentMessage).toBeDefined();
    expect(sentMessage?.code).toMatch(/^\d{6}$/);

    const verifyResult = await service.verifyOtp('09121112233', sentMessage!.code);
    expect(verifyResult.token).toBeDefined();
    expect(verifyResult.tokenType).toBe('Bearer');
    expect(verifyResult.user.phone).toBe('+989121112233');
    expect(verifyResult.user.role).toBe('buyer');
    expect(verifyResult.user.status).toBe('active');

    // Check user in database
    const userInDb = await service.getUserById(verifyResult.user.id);
    expect(userInDb).toBeDefined();
    expect(userInDb?.phone).toBe('+989121112233');
  });

  it('rejects wrong OTP code and increments attempts', async () => {
    await service.requestOtp('09121112233');
    await expect(service.verifyOtp('09121112233', '999999')).rejects.toThrow(InvalidOtpError);

    const dbOtp = await pool.query<{ attempts: number }>(
      'SELECT attempts FROM otp_requests WHERE phone = $1',
      ['+989121112233'],
    );
    expect(dbOtp.rows[0]?.attempts).toBe(1);
  });

  it('rejects expired OTP code', async () => {
    await service.requestOtp('09121112233');
    const sent = smsSender.getLastMessageFor('+989121112233');

    // Manually expire the code in DB
    await pool.query(
      "UPDATE otp_requests SET expires_at = NOW() - INTERVAL '10 seconds' WHERE phone = $1",
      ['+989121112233'],
    );

    await expect(service.verifyOtp('09121112233', sent!.code)).rejects.toThrow(OtpExpiredError);
  });

  it('rejects malformed phone numbers', async () => {
    await expect(service.requestOtp('invalid-phone')).rejects.toThrow(ValidationError);
    await expect(service.verifyOtp('invalid-phone', '123456')).rejects.toThrow(ValidationError);
  });

  it('enforces rate limiting after max attempts within window', async () => {
    // maxAttempts is configured as 2
    await service.requestOtp('09121112233');
    await service.requestOtp('09121112233');

    // 3rd attempt within window should throw RateLimitError
    await expect(service.requestOtp('09121112233')).rejects.toThrow(RateLimitError);
  });
});
