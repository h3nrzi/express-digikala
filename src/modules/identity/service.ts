import crypto from 'crypto';
import type { Pool } from 'pg';
import {
  InvalidOtpError,
  InviteAlreadyUsedError,
  InviteExpiredError,
  OtpExpiredError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../../errors.js';
import { normalizeIranianPhoneNumber } from './domain/phone.js';
import {
  generateInviteToken,
  hashInviteToken,
  hashPassword,
  verifyPassword,
} from './domain/passwords.js';
import { isValidOperationalRole, type OperationalRole } from './domain/roles.js';
import { createBuyerToken, generateOtpCode, hashOtpCode, verifyOtpHash } from './domain/tokens.js';
import type { SmsSenderPort } from './ports/sms-sender.js';

export interface IdentityServiceConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  otpTtlSeconds: number;
  otpRateLimitMaxAttempts: number;
  otpRateLimitWindowSeconds: number;
}

export interface UserAccount {
  id: string;
  phone: string;
  email?: string | null;
  roles?: OperationalRole[];
  status: 'active' | 'locked' | 'suspended' | 'closed';
  createdAt: Date;
  updatedAt: Date;
}

export interface VerifyOtpResponse {
  token: string;
  tokenType: 'Bearer';
  user: {
    id: string;
    phone: string;
    role: 'buyer';
    status: string;
  };
}

export interface InviteOperationalUserParams {
  email: string;
  phone: string;
  roles?: OperationalRole[];
  fullName?: string;
  expiresInSeconds?: number;
}

export interface OperationalUserInvite {
  id: string;
  inviteId: string;
  email: string;
  phone: string;
  roles: OperationalRole[];
  inviteToken: string;
  expiresAt: Date;
}

export interface SetupOperationalAccountParams {
  token: string;
  password: string;
  fullName?: string;
}

export interface SetupOperationalAccountResponse {
  id: string;
  userId: string;
  email: string;
  phone: string;
  roles: OperationalRole[];
}

export interface LoginOperationalUserParams {
  email: string;
  password: string;
}

export interface LoginOperationalUserResponse {
  sessionToken: string;
  mfaRequired: true;
  user: {
    id: string;
    email: string;
    phone: string;
    roles: OperationalRole[];
  };
}

export interface VerifyMfaParams {
  sessionToken: string;
  code: string;
}

export interface VerifyMfaResponse {
  success: true;
  sessionToken: string;
  mfaVerified: true;
  user: {
    id: string;
    email: string;
    phone: string;
    roles: OperationalRole[];
  };
}

export interface InternalSessionUser {
  id: string;
  email: string;
  phone: string;
  roles: OperationalRole[];
  mfaVerified: boolean;
}

export interface InternalSessionValidationResult {
  valid: boolean;
  mfaVerified: boolean;
  user?: InternalSessionUser;
  errorReason?: string;
}

export interface BootstrapAdminParams {
  email: string;
  phone: string;
  password: string;
  fullName?: string;
}

export class IdentityService {
  constructor(
    private readonly pool: Pool,
    private readonly smsSender: SmsSenderPort,
    private readonly config: IdentityServiceConfig,
  ) {}

  private validateAndNormalizePhone(rawPhone?: string): string {
    const phoneResult = normalizeIranianPhoneNumber(rawPhone);
    if (!phoneResult.isValid || !phoneResult.normalized) {
      throw new ValidationError(phoneResult.error ?? 'شماره تلفن همراه نامعتبر است.', [
        {
          field: 'phone',
          message: phoneResult.error ?? 'شماره تلفن همراه نامعتبر است.',
        },
      ]);
    }
    return phoneResult.normalized;
  }

  private validateEmail(rawEmail?: string): string {
    if (!rawEmail || typeof rawEmail !== 'string') {
      throw new ValidationError('ایمیل واردشده نامعتبر است.', [
        {
          field: 'email',
          message: 'ایمیل واردشده نامعتبر است.',
        },
      ]);
    }

    const email = rawEmail.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new ValidationError('فرمت ایمیل واردشده نامعتبر است.', [
        {
          field: 'email',
          message: 'فرمت ایمیل واردشده نامعتبر است.',
        },
      ]);
    }

    return email;
  }

  /**
   * Accepts an Iranian phone number, enforces rate limiting, invalidates superseded codes,
   * generates a 6-digit OTP, saves the hash, and dispatches via SMS.
   */
  async requestOtp(rawPhone?: string): Promise<{ success: boolean; phone: string }> {
    const phone = this.validateAndNormalizePhone(rawPhone);

    // Check rate limit: count requests within the configured window
    const windowSeconds = this.config.otpRateLimitWindowSeconds;
    const maxAttempts = this.config.otpRateLimitMaxAttempts;

    const rateLimitCheckQuery = `
      SELECT COUNT(*)::int AS count
      FROM otp_requests
      WHERE phone = $1
        AND created_at >= NOW() - ($2 || ' seconds')::INTERVAL;
    `;

    const rateLimitResult = await this.pool.query<{ count: number }>(rateLimitCheckQuery, [
      phone,
      windowSeconds,
    ]);

    const recentCount = rateLimitResult.rows[0]?.count ?? 0;
    if (recentCount >= maxAttempts) {
      throw new RateLimitError(
        'تعداد درخواست‌های ارسال کد بیش از حد مجاز است. لطفاً بعداً تلاش کنید.',
        windowSeconds,
      );
    }

    // Invalidate any active, unconsumed OTP requests for this phone so only latest is valid
    await this.pool.query(
      'UPDATE otp_requests SET consumed_at = NOW() WHERE phone = $1 AND consumed_at IS NULL;',
      [phone],
    );

    // Generate code and compute hash
    const code = generateOtpCode();
    const codeHash = hashOtpCode(phone, code);
    const ttlSeconds = this.config.otpTtlSeconds;

    const insertOtpQuery = `
      INSERT INTO otp_requests (phone, code_hash, expires_at)
      VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)
      RETURNING id, expires_at;
    `;

    await this.pool.query(insertOtpQuery, [phone, codeHash, ttlSeconds]);

    // Dispatch OTP via SMS delivery port
    await this.smsSender.sendOtp(phone, code);

    return {
      success: true,
      phone,
    };
  }

  /**
   * Verifies an OTP code and returns a signed short-lived JWT token along with user data.
   */
  async verifyOtp(rawPhone?: string, rawCode?: string): Promise<VerifyOtpResponse> {
    const phone = this.validateAndNormalizePhone(rawPhone);

    if (!rawCode || typeof rawCode !== 'string' || !/^\d{6}$/.test(rawCode.trim())) {
      throw new ValidationError('کد تأیید باید یک عدد ۶ رقمی معتبر باشد.', [
        {
          field: 'code',
          message: 'کد تأیید باید یک عدد ۶ رقمی معتبر باشد.',
        },
      ]);
    }

    const code = rawCode.trim();

    // Fetch the latest unconsumed OTP request for this phone
    const fetchOtpQuery = `
      SELECT id, code_hash, expires_at, consumed_at, attempts
      FROM otp_requests
      WHERE phone = $1 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1;
    `;

    const otpResult = await this.pool.query<{
      id: string;
      code_hash: string;
      expires_at: Date;
      consumed_at: Date | null;
      attempts: number;
    }>(fetchOtpQuery, [phone]);

    const activeOtp = otpResult.rows[0];
    if (!activeOtp) {
      throw new InvalidOtpError('کد تأیید معتبری یافت نشد. لطفاً مجدداً درخواست ارسال کد دهید.');
    }

    // Enforce max verification attempts per OTP code (prevent brute-forcing 6 digits)
    if (activeOtp.attempts >= 5) {
      await this.pool.query('UPDATE otp_requests SET consumed_at = NOW() WHERE id = $1', [
        activeOtp.id,
      ]);
      throw new InvalidOtpError(
        'تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً کد جدید دریافت کنید.',
      );
    }

    const now = new Date();
    if (new Date(activeOtp.expires_at) < now) {
      throw new OtpExpiredError('کد تأیید منقضی شده است. لطفاً مجدداً درخواست ارسال کد دهید.');
    }

    const isMatch = verifyOtpHash(phone, code, activeOtp.code_hash);
    if (!isMatch) {
      await this.pool.query('UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1', [
        activeOtp.id,
      ]);
      throw new InvalidOtpError('کد تأیید واردشده نادرست است.');
    }

    // Check account status if user already exists
    const existingUserQuery = 'SELECT status FROM user_accounts WHERE phone = $1;';
    const existingUserRes = await this.pool.query<{ status: string }>(existingUserQuery, [phone]);
    if (existingUserRes.rows[0] && existingUserRes.rows[0].status !== 'active') {
      throw new UnauthorizedError(
        'حساب کاربری شما غیرفعال یا معلق است. لطفاً با پشتیبانی تماس بگیرید.',
      );
    }

    // Mark OTP as consumed
    await this.pool.query('UPDATE otp_requests SET consumed_at = NOW() WHERE id = $1', [
      activeOtp.id,
    ]);

    // Upsert user account
    const upsertUserQuery = `
      INSERT INTO user_accounts (phone, status)
      VALUES ($1, 'active')
      ON CONFLICT (phone) DO UPDATE
      SET updated_at = NOW()
      RETURNING id, phone, status, created_at, updated_at;
    `;

    const userResult = await this.pool.query<{
      id: string;
      phone: string;
      status: string;
    }>(upsertUserQuery, [phone]);

    const user = userResult.rows[0]!;

    // Issue JWT token
    const token = createBuyerToken(
      { userId: user.id, phone: user.phone },
      this.config.jwtSecret,
      this.config.jwtExpiresIn,
    );

    return {
      token,
      tokenType: 'Bearer',
      user: {
        id: user.id,
        phone: user.phone,
        role: 'buyer',
        status: user.status,
      },
    };
  }

  /**
   * Invites an operational user with a cryptographically secure, time-limited invite token.
   */
  async inviteOperationalUser(
    invitedByUserId: string | null,
    params: InviteOperationalUserParams,
  ): Promise<OperationalUserInvite> {
    const email = this.validateEmail(params.email);
    const phone = this.validateAndNormalizePhone(params.phone);

    // Check if user already exists with this email or phone
    const existingUserCheck = await this.pool.query<{ id: string; email: string; phone: string }>(
      'SELECT id, email, phone FROM user_accounts WHERE LOWER(email) = $1 OR phone = $2;',
      [email, phone],
    );

    if (existingUserCheck.rows.length > 0) {
      throw new ValidationError(
        'کاربری با این مشخصات (ایمیل یا شماره همراه) قبلاً در سامانه ثبت شده است.',
        [
          {
            field: 'email',
            message: 'کاربری با این ایمیل یا شماره همراه قبلاً در سامانه ثبت شده است.',
          },
        ],
      );
    }

    const roles: OperationalRole[] =
      params.roles && params.roles.length > 0 ? params.roles : ['support'];

    for (const role of roles) {
      if (!isValidOperationalRole(role)) {
        throw new ValidationError(`نقش عملیاتی "${role}" نامعتبر است.`, [
          { field: 'roles', message: `نقش عملیاتی "${role}" نامعتبر است.` },
        ]);
      }
    }

    const rawInviteToken = generateInviteToken();
    const tokenHash = hashInviteToken(rawInviteToken);
    const expiresInSeconds = params.expiresInSeconds ?? 86400; // 24 hours default

    // Invalidate any previous unconsumed invite for this email by expiring it
    await this.pool.query(
      'UPDATE user_invites SET expires_at = NOW() WHERE LOWER(email) = $1 AND consumed_at IS NULL;',
      [email],
    );

    const insertInviteQuery = `
      INSERT INTO user_invites (email, phone, roles, token_hash, invited_by, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' seconds')::INTERVAL)
      RETURNING id, email, phone, roles, expires_at;
    `;

    const insertResult = await this.pool.query<{
      id: string;
      email: string;
      phone: string;
      roles: OperationalRole[];
      expires_at: Date;
    }>(insertInviteQuery, [email, phone, roles, tokenHash, invitedByUserId, expiresInSeconds]);

    const createdInvite = insertResult.rows[0]!;

    return {
      id: createdInvite.id,
      inviteId: createdInvite.id,
      email: createdInvite.email,
      phone: createdInvite.phone,
      roles: createdInvite.roles,
      inviteToken: rawInviteToken,
      expiresAt: createdInvite.expires_at,
    };
  }

  /**
   * Completes operational user account setup by verifying the invite token and storing password credentials.
   */
  async setupOperationalAccount(
    params: SetupOperationalAccountParams,
  ): Promise<SetupOperationalAccountResponse> {
    if (!params.token || typeof params.token !== 'string') {
      throw new ValidationError('توکن دعوت‌نامه معتبر نیست.', [
        { field: 'token', message: 'توکن دعوت‌نامه معتبر نیست.' },
      ]);
    }

    if (!params.password || typeof params.password !== 'string' || params.password.length < 8) {
      throw new ValidationError('رمز عبور باید حداقل ۸ کاراکتر باشد.', [
        { field: 'password', message: 'رمز عبور باید حداقل ۸ کاراکتر باشد.' },
      ]);
    }

    const tokenHash = hashInviteToken(params.token);

    const inviteResult = await this.pool.query<{
      id: string;
      email: string;
      phone: string;
      roles: OperationalRole[];
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      'SELECT id, email, phone, roles, expires_at, consumed_at FROM user_invites WHERE token_hash = $1;',
      [tokenHash],
    );

    const invite = inviteResult.rows[0];
    if (!invite) {
      throw new ValidationError('توکن دعوت‌نامه نامعتبر است.', [
        { field: 'token', message: 'توکن دعوت‌نامه نامعتبر است.' },
      ]);
    }

    if (invite.consumed_at) {
      throw new InviteAlreadyUsedError();
    }

    const now = new Date();
    if (new Date(invite.expires_at) < now) {
      throw new InviteExpiredError();
    }

    const passwordHash = await hashPassword(params.password);

    // Upsert into user_accounts
    const upsertUserQuery = `
      INSERT INTO user_accounts (email, phone, password_hash, roles, full_name, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
      ON CONFLICT (phone) DO UPDATE
      SET email = EXCLUDED.email,
          password_hash = EXCLUDED.password_hash,
          roles = EXCLUDED.roles,
          full_name = COALESCE(EXCLUDED.full_name, user_accounts.full_name),
          status = 'active',
          updated_at = NOW()
      RETURNING id, email, phone, roles;
    `;

    const userResult = await this.pool.query<{
      id: string;
      email: string;
      phone: string;
      roles: OperationalRole[];
    }>(upsertUserQuery, [
      invite.email,
      invite.phone,
      passwordHash,
      invite.roles,
      params.fullName ?? null,
    ]);

    const user = userResult.rows[0]!;

    // Mark invite as consumed
    await this.pool.query('UPDATE user_invites SET consumed_at = NOW() WHERE id = $1;', [
      invite.id,
    ]);

    return {
      id: user.id,
      userId: user.id,
      email: user.email,
      phone: user.phone,
      roles: user.roles,
    };
  }

  /**
   * Authenticates operational user with personal credentials (email & password),
   * initiates MFA, and issues an unverified session.
   */
  async loginOperationalUser(
    params: LoginOperationalUserParams,
  ): Promise<LoginOperationalUserResponse> {
    const email = this.validateEmail(params.email);
    if (!params.password || typeof params.password !== 'string') {
      throw new UnauthorizedError('ایمیل یا رمز عبور واردشده نادرست است.');
    }

    const userResult = await this.pool.query<{
      id: string;
      email: string;
      phone: string;
      password_hash: string | null;
      roles: OperationalRole[];
      status: string;
    }>(
      'SELECT id, email, phone, password_hash, roles, status FROM user_accounts WHERE LOWER(email) = $1;',
      [email],
    );

    const user = userResult.rows[0];
    if (!user || !user.password_hash) {
      throw new UnauthorizedError('ایمیل یا رمز عبور واردشده نادرست است.');
    }

    const isPasswordValid = await verifyPassword(params.password, user.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedError('ایمیل یا رمز عبور واردشده نادرست است.');
    }

    if (user.status !== 'active') {
      throw new UnauthorizedError('حساب کاربری شما غیرفعال یا معلق است.');
    }

    // Generate session token and second-factor code
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const mfaCode = generateOtpCode();
    const mfaCodeHash = hashOtpCode(user.phone, mfaCode);
    const mfaTtlSeconds = this.config.otpTtlSeconds;
    const sessionTtlSeconds = 86400; // 24 hours

    const createSessionQuery = `
      INSERT INTO internal_sessions (
        user_id,
        session_token,
        mfa_verified,
        mfa_code_hash,
        mfa_expires_at,
        expires_at
      )
      VALUES ($1, $2, FALSE, $3, NOW() + ($4 || ' seconds')::INTERVAL, NOW() + ($5 || ' seconds')::INTERVAL)
      RETURNING session_token;
    `;

    await this.pool.query(createSessionQuery, [
      user.id,
      sessionToken,
      mfaCodeHash,
      mfaTtlSeconds,
      sessionTtlSeconds,
    ]);

    // Send MFA code via SMS
    await this.smsSender.sendOtp(user.phone, mfaCode);

    return {
      sessionToken,
      mfaRequired: true,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        roles: user.roles,
      },
    };
  }

  /**
   * Verifies the second factor (MFA OTP) for an internal session and promotes it to mfa-verified.
   */
  async verifyMfa(params: VerifyMfaParams): Promise<VerifyMfaResponse> {
    if (!params.sessionToken || typeof params.sessionToken !== 'string') {
      throw new UnauthorizedError('نشست نامعتبر یا ارسال نشده است.');
    }

    if (!params.code || typeof params.code !== 'string' || !/^\d{6}$/.test(params.code.trim())) {
      throw new ValidationError('کد تأیید دو مرحله‌ای باید یک عدد ۶ رقمی باشد.', [
        { field: 'code', message: 'کد تأیید دو مرحله‌ای باید یک عدد ۶ رقمی باشد.' },
      ]);
    }

    const code = params.code.trim();

    const sessionResult = await this.pool.query<{
      id: string;
      user_id: string;
      session_token: string;
      mfa_verified: boolean;
      mfa_code_hash: string | null;
      mfa_expires_at: Date | null;
      mfa_attempts: number;
      expires_at: Date;
      email: string;
      phone: string;
      roles: OperationalRole[];
      status: string;
    }>(
      `
      SELECT s.id, s.user_id, s.session_token, s.mfa_verified, s.mfa_code_hash, s.mfa_expires_at, s.mfa_attempts, s.expires_at,
             u.email, u.phone, u.roles, u.status
      FROM internal_sessions s
      JOIN user_accounts u ON u.id = s.user_id
      WHERE s.session_token = $1;
      `,
      [params.sessionToken],
    );

    const session = sessionResult.rows[0];
    if (!session) {
      throw new UnauthorizedError('نشست نامعتبر یا منقضی شده است.');
    }

    const now = new Date();
    if (new Date(session.expires_at) < now) {
      throw new UnauthorizedError('نشست منقضی شده است. لطفاً مجدداً وارد شوید.');
    }

    if (session.status !== 'active') {
      throw new UnauthorizedError('حساب کاربری شما غیرفعال یا معلق است.');
    }

    if (session.mfa_verified) {
      throw new ValidationError('این نشست قبلاً احراز هویت دو مرحله‌ای را تکمیل کرده است.', [
        {
          field: 'sessionToken',
          message: 'این نشست قبلاً احراز هویت دو مرحله‌ای را تکمیل کرده است.',
        },
      ]);
    }

    // Enforce max 5 attempts per MFA session
    if (session.mfa_attempts >= 5) {
      await this.pool.query('UPDATE internal_sessions SET expires_at = NOW() WHERE id = $1;', [
        session.id,
      ]);
      throw new InvalidOtpError('تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً مجدداً وارد شوید.');
    }

    if (!session.mfa_expires_at || new Date(session.mfa_expires_at) < now) {
      throw new OtpExpiredError('کد تأیید دو مرحله‌ای منقضی شده است.');
    }

    if (!session.mfa_code_hash) {
      throw new InvalidOtpError('کد تأیید دو مرحله‌ای نامعتبر است.');
    }

    const isMatch = verifyOtpHash(session.phone, code, session.mfa_code_hash);
    if (!isMatch) {
      await this.pool.query(
        'UPDATE internal_sessions SET mfa_attempts = mfa_attempts + 1 WHERE id = $1;',
        [session.id],
      );
      throw new InvalidOtpError('کد تأیید واردشده نادرست است.');
    }

    // Promote session to mfa_verified = true
    await this.pool.query(
      'UPDATE internal_sessions SET mfa_verified = TRUE, mfa_code_hash = NULL, updated_at = NOW() WHERE id = $1;',
      [session.id],
    );

    return {
      success: true,
      sessionToken: session.session_token,
      mfaVerified: true,
      user: {
        id: session.user_id,
        email: session.email,
        phone: session.phone,
        roles: session.roles,
      },
    };
  }

  /**
   * Validates an internal session token against PostgreSQL, returning verification state.
   */
  async validateInternalSession(sessionToken: string): Promise<InternalSessionValidationResult> {
    if (!sessionToken || typeof sessionToken !== 'string') {
      return { valid: false, mfaVerified: false, errorReason: 'MISSING_TOKEN' };
    }

    const sessionResult = await this.pool.query<{
      id: string;
      user_id: string;
      session_token: string;
      mfa_verified: boolean;
      expires_at: Date;
      email: string;
      phone: string;
      roles: OperationalRole[];
      status: string;
    }>(
      `
      SELECT s.id, s.user_id, s.session_token, s.mfa_verified, s.expires_at,
             u.email, u.phone, u.roles, u.status
      FROM internal_sessions s
      JOIN user_accounts u ON u.id = s.user_id
      WHERE s.session_token = $1;
      `,
      [sessionToken],
    );

    const session = sessionResult.rows[0];
    if (!session) {
      return { valid: false, mfaVerified: false, errorReason: 'SESSION_NOT_FOUND' };
    }

    if (new Date(session.expires_at) < new Date()) {
      return { valid: false, mfaVerified: false, errorReason: 'SESSION_EXPIRED' };
    }

    if (session.status !== 'active') {
      return { valid: false, mfaVerified: false, errorReason: 'USER_INACTIVE' };
    }

    return {
      valid: true,
      mfaVerified: session.mfa_verified,
      user: {
        id: session.user_id,
        email: session.email,
        phone: session.phone,
        roles: session.roles,
        mfaVerified: session.mfa_verified,
      },
    };
  }

  /**
   * Helper to seed/bootstrap an initial administrative user for testing and environment setup.
   */
  async createBootstrapAdminUser(params: BootstrapAdminParams): Promise<UserAccount> {
    const email = this.validateEmail(params.email);
    const phone = this.validateAndNormalizePhone(params.phone);
    const passwordHash = await hashPassword(params.password);

    const query = `
      INSERT INTO user_accounts (email, phone, password_hash, roles, full_name, status)
      VALUES ($1, $2, $3, ARRAY['access-admin'], $4, 'active')
      ON CONFLICT (phone) DO UPDATE
      SET email = EXCLUDED.email,
          password_hash = EXCLUDED.password_hash,
          roles = ARRAY['access-admin'],
          full_name = COALESCE(EXCLUDED.full_name, user_accounts.full_name),
          status = 'active',
          updated_at = NOW()
      RETURNING id, phone, email, roles, status, created_at AS "createdAt", updated_at AS "updatedAt";
    `;

    const res = await this.pool.query<UserAccount>(query, [
      email,
      phone,
      passwordHash,
      params.fullName ?? 'Bootstrap Admin',
    ]);

    return res.rows[0]!;
  }

  /**
   * Retrieves a user by their unique UUID.
   */
  async getUserById(userId: string): Promise<UserAccount | null> {
    const query = `
      SELECT id, phone, email, roles, status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM user_accounts
      WHERE id = $1;
    `;
    const result = await this.pool.query<UserAccount>(query, [userId]);
    return result.rows[0] ?? null;
  }
}
