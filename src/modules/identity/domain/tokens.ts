import crypto from 'crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';

export interface BuyerTokenPayload {
  sub: string;
  phone: string;
  role: 'buyer';
  iat?: number;
  exp?: number;
}

/**
 * Generates a cryptographically random 6-digit OTP string.
 */
export function generateOtpCode(): string {
  // randomInt generates an integer in [100000, 1000000)
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Computes a SHA-256 hash of the phone number and OTP code.
 */
export function hashOtpCode(phone: string, code: string): string {
  return crypto.createHash('sha256').update(`${phone}:${code.trim()}`).digest('hex');
}

/**
 * Compares an OTP code against a stored hash using timing-safe comparison.
 */
export function verifyOtpHash(phone: string, code: string, expectedHash: string): boolean {
  const computedHash = hashOtpCode(phone, code);
  const computedBuffer = Buffer.from(computedHash, 'hex');
  const expectedBuffer = Buffer.from(expectedHash, 'hex');

  if (computedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(computedBuffer, expectedBuffer);
}

/**
 * Issues a signed short-lived JWT token for a buyer.
 */
export function createBuyerToken(
  user: { userId: string; phone: string },
  secret: string,
  expiresIn: string = '1h',
): string {
  const payload: Omit<BuyerTokenPayload, 'iat' | 'exp'> = {
    sub: user.userId,
    phone: user.phone,
    role: 'buyer',
  };

  const options: SignOptions = {};
  if (expiresIn) {
    options.expiresIn = expiresIn as NonNullable<SignOptions['expiresIn']>;
  }

  return jwt.sign(payload, secret, options);
}

/**
 * Verifies and decodes a buyer JWT token. Throws if invalid or expired.
 */
export function verifyBuyerToken(token: string, secret: string): BuyerTokenPayload {
  const decoded = jwt.verify(token, secret);
  return decoded as BuyerTokenPayload;
}
