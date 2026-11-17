import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import type { Express } from 'express';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createApp } from '../../src/app.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';
import type { IdentityService } from '../../src/modules/identity/service.js';

describe('Operational User Invite & Internal Auth HTTP Endpoints', () => {
  let pool: Pool;
  let app: Express;
  let smsSender: InMemorySmsSender;
  let identityService: IdentityService;

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
    identityService = appContext.identityService;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_invites');
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');
    smsSender.clear();
  });

  // Helper to obtain an MFA-verified admin session
  async function createVerifiedAdminSession(): Promise<{ sessionToken: string; email: string }> {
    const adminEmail = 'superadmin@marketplace.ir';
    const adminPhone = '09121110000';
    const adminPass = 'AdminSecretPass123!';

    await identityService.createBootstrapAdminUser({
      email: adminEmail,
      phone: adminPhone,
      password: adminPass,
      fullName: 'System Administrator',
    });

    // 1. Admin logs in
    const loginRes = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: adminEmail, password: adminPass });

    expect(loginRes.status).toBe(200);
    const { sessionToken } = loginRes.body;

    // 2. Fetch MFA OTP from smsSender
    const mfaMsg = smsSender.getLastMessageFor('+989121110000');
    expect(mfaMsg).toBeDefined();

    // 3. Verify MFA
    const mfaRes = await request(app)
      .post('/api/v1/admin/auth/mfa/verify')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ code: mfaMsg!.code });

    expect(mfaRes.status).toBe(200);
    expect(mfaRes.body.mfaVerified).toBe(true);

    return { sessionToken, email: adminEmail };
  }

  describe('Happy Path: Invite -> Setup -> Login -> MFA Verify -> Access Internal Route', () => {
    it('executes full onboarding and verification flow with 2FA enforcement', async () => {
      const admin = await createVerifiedAdminSession();
      smsSender.clear();

      // 1. Admin sends invite to new operational user
      const inviteRes = await request(app)
        .post('/api/v1/admin/users/invite')
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({
          email: 'catalog.lead@marketplace.ir',
          phone: '09123334455',
          roles: ['catalog'],
          fullName: 'Mina Alavi',
        });

      expect(inviteRes.status).toBe(201);
      expect(inviteRes.body.success).toBe(true);
      expect(inviteRes.body.invite).toBeDefined();
      expect(inviteRes.body.invite.email).toBe('catalog.lead@marketplace.ir');
      expect(inviteRes.body.invite.phone).toBe('+989123334455');
      expect(inviteRes.body.invite.roles).toEqual(['catalog']);

      const inviteToken = inviteRes.body.invite.inviteToken;
      expect(inviteToken).toBeDefined();

      // 2. Invited user sets up credentials via invite token
      const setupRes = await request(app).post('/api/v1/admin/auth/setup').send({
        token: inviteToken,
        password: 'MinaSecurePassword123!',
        fullName: 'Mina Alavi',
      });

      expect(setupRes.status).toBe(200);
      expect(setupRes.body.success).toBe(true);
      expect(setupRes.body.user.email).toBe('catalog.lead@marketplace.ir');

      // 3. Operational user logs in with email and password
      const loginRes = await request(app).post('/api/v1/admin/auth/login').send({
        email: 'catalog.lead@marketplace.ir',
        password: 'MinaSecurePassword123!',
      });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.mfaRequired).toBe(true);
      const userSessionToken = loginRes.body.sessionToken;
      expect(userSessionToken).toBeDefined();

      // Second factor OTP sent to Mina's mobile phone
      const mfaMessage = smsSender.getLastMessageFor('+989123334455');
      expect(mfaMessage).toBeDefined();
      expect(mfaMessage?.code).toMatch(/^\d{6}$/);

      // 4. User attempts to access internal route BEFORE MFA verification -> Rejected with 403 Forbidden!
      const prematureAccessRes = await request(app)
        .get('/api/v1/admin/me')
        .set('Authorization', `Bearer ${userSessionToken}`);

      expect(prematureAccessRes.status).toBe(403);
      expect(prematureAccessRes.body.code).toBe('MFA_REQUIRED');
      expect(prematureAccessRes.body.traceId).toBeDefined();

      // 5. User verifies MFA code
      const mfaVerifyRes = await request(app)
        .post('/api/v1/admin/auth/mfa/verify')
        .set('Authorization', `Bearer ${userSessionToken}`)
        .send({ code: mfaMessage!.code });

      expect(mfaVerifyRes.status).toBe(200);
      expect(mfaVerifyRes.body.success).toBe(true);
      expect(mfaVerifyRes.body.mfaVerified).toBe(true);

      // 6. User accesses internal route AFTER MFA verification -> 200 OK!
      const authorizedAccessRes = await request(app)
        .get('/api/v1/admin/me')
        .set('Authorization', `Bearer ${userSessionToken}`);

      expect(authorizedAccessRes.status).toBe(200);
      expect(authorizedAccessRes.body.user.email).toBe('catalog.lead@marketplace.ir');
      expect(authorizedAccessRes.body.user.roles).toEqual(['catalog']);
      expect(authorizedAccessRes.body.user.mfaVerified).toBe(true);
    });
  });

  describe('Invite Tokens Lifecycle & Security Checks', () => {
    it('rejects reuse of already-consumed invite tokens with 400 Bad Request', async () => {
      const admin = await createVerifiedAdminSession();

      const inviteRes = await request(app)
        .post('/api/v1/admin/users/invite')
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({
          email: 'singleuse@marketplace.ir',
          phone: '09124445566',
          roles: ['support'],
        });

      const token = inviteRes.body.invite.inviteToken;

      // First use succeeds
      const firstSetup = await request(app)
        .post('/api/v1/admin/auth/setup')
        .send({ token, password: 'ValidPassword123!' });
      expect(firstSetup.status).toBe(200);

      // Second use fails
      const secondSetup = await request(app)
        .post('/api/v1/admin/auth/setup')
        .send({ token, password: 'AnotherPassword123!' });
      expect(secondSetup.status).toBe(400);
      expect(secondSetup.body.code).toBe('INVITE_ALREADY_USED');
    });

    it('rejects expired invite tokens with 400 Bad Request', async () => {
      const admin = await createVerifiedAdminSession();

      const inviteRes = await request(app)
        .post('/api/v1/admin/users/invite')
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({
          email: 'will.expire@marketplace.ir',
          phone: '09125556677',
        });

      const inviteId = inviteRes.body.invite.id;
      const token = inviteRes.body.invite.inviteToken;

      // Manually expire the invite in PostgreSQL
      await pool.query(
        "UPDATE user_invites SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
        [inviteId],
      );

      const setupRes = await request(app)
        .post('/api/v1/admin/auth/setup')
        .send({ token, password: 'ValidPassword123!' });

      expect(setupRes.status).toBe(400);
      expect(setupRes.body.code).toBe('INVITE_EXPIRED');
    });
  });

  describe('Internal Route Guards & Role Placeholders', () => {
    it('rejects unauthenticated requests to internal routes with 401 Unauthorized', async () => {
      const res = await request(app).get('/api/v1/admin/me');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(res.body.traceId).toBeDefined();
    });

    it('rejects malformed Bearer tokens with 401 Unauthorized', async () => {
      const res = await request(app)
        .get('/api/v1/admin/me')
        .set('Authorization', 'Bearer non-existent-session-token');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects non-access-admin users from inviting others with 403 Forbidden', async () => {
      const admin = await createVerifiedAdminSession();

      // Invite a regular catalog user
      const inviteRes = await request(app)
        .post('/api/v1/admin/users/invite')
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({
          email: 'catalog.only@marketplace.ir',
          phone: '09127778899',
          roles: ['catalog'],
        });

      const token = inviteRes.body.invite.inviteToken;
      await request(app)
        .post('/api/v1/admin/auth/setup')
        .send({ token, password: 'PasswordCatalog123!' });

      // Log in as catalog user
      const loginRes = await request(app)
        .post('/api/v1/admin/auth/login')
        .send({ email: 'catalog.only@marketplace.ir', password: 'PasswordCatalog123!' });

      const sms = smsSender.getLastMessageFor('+989127778899')!;
      await request(app)
        .post('/api/v1/admin/auth/mfa/verify')
        .set('Authorization', `Bearer ${loginRes.body.sessionToken}`)
        .send({ code: sms.code });

      // Now, catalog user tries to call POST /api/v1/admin/users/invite
      const unauthorizedInviteRes = await request(app)
        .post('/api/v1/admin/users/invite')
        .set('Authorization', `Bearer ${loginRes.body.sessionToken}`)
        .send({
          email: 'unauthorized@marketplace.ir',
          phone: '09129990011',
        });

      expect(unauthorizedInviteRes.status).toBe(403);
      expect(unauthorizedInviteRes.body.code).toBe('FORBIDDEN');
    });
  });
});
