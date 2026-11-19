import { createDbPool } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import { normalizeIranianPhoneNumber } from '../modules/identity/domain/phone.js';
import { hashPassword } from '../modules/identity/domain/passwords.js';

const BOOTSTRAP_LOCK_KEY = '726184039271';

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set before running the admin bootstrap command.`);
  }
  return value;
}

async function bootstrapAdmin(): Promise<void> {
  const config = loadConfig();
  const email = requiredEnvironmentVariable('BOOTSTRAP_ADMIN_EMAIL').toLowerCase();
  const phoneInput = requiredEnvironmentVariable('BOOTSTRAP_ADMIN_PHONE');
  const password = process.env['BOOTSTRAP_ADMIN_PASSWORD'];
  const fullName = process.env['BOOTSTRAP_ADMIN_FULL_NAME']?.trim() || 'Bootstrap Admin';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address.');
  }
  if (!password || password.length < 8) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain at least 8 characters.');
  }
  if (fullName.length > 100) {
    throw new Error('BOOTSTRAP_ADMIN_FULL_NAME must be 100 characters or fewer.');
  }

  const phoneResult = normalizeIranianPhoneNumber(phoneInput);
  if (!phoneResult.isValid || !phoneResult.normalized) {
    throw new Error(phoneResult.error ?? 'BOOTSTRAP_ADMIN_PHONE is invalid.');
  }

  const pool = createDbPool({ connectionString: config.databaseUrl });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::bigint);', [BOOTSTRAP_LOCK_KEY]);

      const existingAdmin = await client.query(
        "SELECT id FROM user_accounts WHERE 'access-admin' = ANY(roles) LIMIT 1;",
      );
      if (existingAdmin.rowCount) {
        throw new Error('An access-admin account already exists; bootstrap was not applied.');
      }

      const existingAccount = await client.query(
        `SELECT id
         FROM user_accounts
         WHERE LOWER(email) = $1 OR phone = $2
         LIMIT 1;`,
        [email, phoneResult.normalized],
      );
      if (existingAccount.rowCount) {
        throw new Error('The supplied email or phone already belongs to an account.');
      }

      const passwordHash = await hashPassword(password);
      await client.query(
        `INSERT INTO user_accounts (email, phone, password_hash, roles, full_name, status)
         VALUES ($1, $2, $3, ARRAY['access-admin'], $4, 'active');`,
        [email, phoneResult.normalized, passwordHash, fullName],
      );

      await client.query('COMMIT');
      console.info(`Created the first access-admin account for ${email}.`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

bootstrapAdmin().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown bootstrap error.';
  console.error(`Admin bootstrap failed: ${message}`);
  process.exitCode = 1;
});
