import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool } from '../../src/db/index.js';
import { DEFAULT_TEST_DB_URL } from '../../src/config/index.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';
import {
  InvalidOtpError,
  InviteAlreadyUsedError,
  InviteExpiredError,
  OtpExpiredError,
  UnauthorizedError,
  ValidationError,
} from '../../src/errors.js';

describe('Internal Auth & Operational User Service Seam', () => {
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
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_invites');
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');

    smsSender = new InMemorySmsSender();
    service = new IdentityService(pool, smsSender, {
      jwtSecret: 'test-jwt-secret-with-sufficient-length',
      jwtExpiresIn: '1h',
      otpTtlSeconds: 120,
      otpRateLimitMaxAttempts: 3,
      otpRateLimitWindowSeconds: 60,
    });
  });

  describe('User Invitation', () => {
    it('creates an invite with hashed token and normalized phone', async () => {
      const invite = await service.inviteOperationalUser(null, {
        email: 'colleague@marketplace.ir',
        phone: '09121112233',
        roles: ['catalog'],
        fullName: 'Ali Rezaei',
      });

      expect(invite.inviteId).toBeDefined();
      expect(invite.email).toBe('colleague@marketplace.ir');
      expect(invite.phone).toBe('+989121112233');
      expect(invite.roles).toEqual(['catalog']);
      expect(invite.inviteToken).toHaveLength(64);
      expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Verify invite stored in DB with hashed token (not plaintext)
      const res = await pool.query<{ token_hash: string; email: string }>(
        'SELECT token_hash, email FROM user_invites WHERE id = $1',
        [invite.inviteId],
      );
      expect(res.rows[0]?.email).toBe('colleague@marketplace.ir');
      expect(res.rows[0]?.token_hash).not.toBe(invite.inviteToken);
    });

    it('rejects inviting when email is invalid', async () => {
      await expect(
        service.inviteOperationalUser(null, {
          email: 'not-an-email',
          phone: '09121112233',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects inviting when user already exists with that email', async () => {
      await service.createBootstrapAdminUser({
        email: 'admin@marketplace.ir',
        phone: '09120000000',
        password: 'Password123!',
      });

      await expect(
        service.inviteOperationalUser(null, {
          email: 'admin@marketplace.ir',
          phone: '09121112233',
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('Account Setup via Invite Token', () => {
    it('completes account setup and marks invite as consumed', async () => {
      const invite = await service.inviteOperationalUser(null, {
        email: 'newuser@marketplace.ir',
        phone: '09122223344',
        roles: ['support'],
        fullName: 'Sara Tehrani',
      });

      const setupResult = await service.setupOperationalAccount({
        token: invite.inviteToken,
        password: 'StrongSecretPassword123!',
      });

      expect(setupResult.userId).toBeDefined();
      expect(setupResult.email).toBe('newuser@marketplace.ir');
      expect(setupResult.phone).toBe('+989122223344');
      expect(setupResult.roles).toEqual(['support']);

      // Invite cannot be reused
      await expect(
        service.setupOperationalAccount({
          token: invite.inviteToken,
          password: 'AnotherPassword123!',
        }),
      ).rejects.toThrow(InviteAlreadyUsedError);
    });

    it('rejects expired invite tokens', async () => {
      const invite = await service.inviteOperationalUser(null, {
        email: 'expired@marketplace.ir',
        phone: '09123334455',
      });

      // Manually backdate the invite's expires_at in DB
      await pool.query(
        "UPDATE user_invites SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
        [invite.inviteId],
      );

      await expect(
        service.setupOperationalAccount({
          token: invite.inviteToken,
          password: 'ValidPassword123!',
        }),
      ).rejects.toThrow(InviteExpiredError);
    });

    it('rejects passwords shorter than 8 characters', async () => {
      const invite = await service.inviteOperationalUser(null, {
        email: 'shortpass@marketplace.ir',
        phone: '09124445566',
      });

      await expect(
        service.setupOperationalAccount({
          token: invite.inviteToken,
          password: 'short',
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('Login & Two-Factor Authentication (MFA)', () => {
    let operationalUser: { id: string; email: string; phone: string; roles: string[] };

    beforeEach(async () => {
      const invite = await service.inviteOperationalUser(null, {
        email: 'operator@marketplace.ir',
        phone: '09125556677',
        roles: ['order-ops'],
        fullName: 'Reza Mohammadi',
      });

      operationalUser = await service.setupOperationalAccount({
        token: invite.inviteToken,
        password: 'SuperSecurePassword99!',
      });
    });

    it('issues unverified session on valid credentials and dispatches MFA OTP', async () => {
      const loginResult = await service.loginOperationalUser({
        email: 'operator@marketplace.ir',
        password: 'SuperSecurePassword99!',
      });

      expect(loginResult.sessionToken).toBeDefined();
      expect(loginResult.mfaRequired).toBe(true);
      expect(loginResult.user.id).toBe(operationalUser.id);
      expect(loginResult.user.email).toBe('operator@marketplace.ir');

      // MFA SMS was sent
      const sms = smsSender.getLastMessageFor('+989125556677');
      expect(sms).toBeDefined();
      expect(sms?.code).toMatch(/^\d{6}$/);

      // Session in DB should not be MFA-verified yet
      const sessionCheck = await service.validateInternalSession(loginResult.sessionToken);
      expect(sessionCheck.valid).toBe(true);
      expect(sessionCheck.mfaVerified).toBe(false);
    });

    it('rejects login with wrong password', async () => {
      await expect(
        service.loginOperationalUser({
          email: 'operator@marketplace.ir',
          password: 'IncorrectPassword!',
        }),
      ).rejects.toThrow(UnauthorizedError);
    });

    it('promotes session to mfa-verified upon correct MFA code', async () => {
      const loginResult = await service.loginOperationalUser({
        email: 'operator@marketplace.ir',
        password: 'SuperSecurePassword99!',
      });

      const sms = smsSender.getLastMessageFor('+989125556677')!;
      const verifyResult = await service.verifyMfa({
        sessionToken: loginResult.sessionToken,
        code: sms.code,
      });

      expect(verifyResult.success).toBe(true);
      expect(verifyResult.mfaVerified).toBe(true);

      // Session in DB is now promoted to mfaVerified: true
      const sessionCheck = await service.validateInternalSession(loginResult.sessionToken);
      expect(sessionCheck.valid).toBe(true);
      expect(sessionCheck.mfaVerified).toBe(true);
      expect(sessionCheck.user?.email).toBe('operator@marketplace.ir');
      expect(sessionCheck.user?.roles).toEqual(['order-ops']);
    });

    it('increments attempts on wrong MFA code and locks session after 5 failures', async () => {
      const loginResult = await service.loginOperationalUser({
        email: 'operator@marketplace.ir',
        password: 'SuperSecurePassword99!',
      });

      // 4 wrong attempts throw InvalidOtpError
      for (let i = 0; i < 4; i++) {
        await expect(
          service.verifyMfa({
            sessionToken: loginResult.sessionToken,
            code: '000000',
          }),
        ).rejects.toThrow(InvalidOtpError);
      }

      // 5th wrong attempt triggers max attempt lock
      await expect(
        service.verifyMfa({
          sessionToken: loginResult.sessionToken,
          code: '000000',
        }),
      ).rejects.toThrow(InvalidOtpError);

      // Subsequent attempt fails with lock/expiration
      await expect(
        service.verifyMfa({
          sessionToken: loginResult.sessionToken,
          code: '123456',
        }),
      ).rejects.toThrow(InvalidOtpError);
    });

    it('rejects expired MFA codes', async () => {
      const loginResult = await service.loginOperationalUser({
        email: 'operator@marketplace.ir',
        password: 'SuperSecurePassword99!',
      });

      // Manually expire MFA in DB
      await pool.query(
        "UPDATE internal_sessions SET mfa_expires_at = NOW() - INTERVAL '10 seconds' WHERE session_token = $1",
        [loginResult.sessionToken],
      );

      const sms = smsSender.getLastMessageFor('+989125556677')!;
      await expect(
        service.verifyMfa({
          sessionToken: loginResult.sessionToken,
          code: sms.code,
        }),
      ).rejects.toThrow(OtpExpiredError);
    });
  });
});
