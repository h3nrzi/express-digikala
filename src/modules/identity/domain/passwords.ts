import crypto from 'crypto';
import util from 'util';

const scryptAsync = util.promisify(crypto.scrypt);

const KEY_LENGTH_BYTES = 64;
const SALT_LENGTH_BYTES = 16;

/**
 * Hashes a plaintext password using Node.js scrypt with a unique random salt.
 * Returns formatted as `scrypt:<saltHex>:<derivedKeyHex>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH_BYTES).toString('hex');
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH_BYTES)) as Buffer;
  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verifies a plaintext password against a stored `scrypt:<salt>:<hash>` string using timing-safe comparison.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith('scrypt:')) {
    return false;
  }

  const parts = storedHash.split(':');
  if (parts.length !== 3) {
    return false;
  }

  const [, salt, expectedHashHex] = parts;
  if (!salt || !expectedHashHex) {
    return false;
  }

  try {
    const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH_BYTES)) as Buffer;
    const expectedBuffer = Buffer.from(expectedHashHex, 'hex');

    if (derivedKey.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(derivedKey, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Generates a cryptographically secure 64-character hex token for account setup invites.
 */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Computes a SHA-256 hash of an invite token for safe database persistence.
 */
export function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}
