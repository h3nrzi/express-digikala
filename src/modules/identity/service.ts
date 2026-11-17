import type { Pool } from 'pg';
import {
  InvalidOtpError,
  OtpExpiredError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../../errors.js';
import { normalizeIranianPhoneNumber } from './domain/phone.js';
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
   * Retrieves a user by their unique UUID.
   */
  async getUserById(userId: string): Promise<UserAccount | null> {
    const query = `
      SELECT id, phone, status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM user_accounts
      WHERE id = $1;
    `;
    const result = await this.pool.query<UserAccount>(query, [userId]);
    return result.rows[0] ?? null;
  }
}
