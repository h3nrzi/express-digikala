import { createDbPool } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import { normalizeIranianPhoneNumber } from '../modules/identity/domain/phone.js';
import { hashPassword } from '../modules/identity/domain/passwords.js';
import { OPERATIONAL_ROLES } from '../modules/identity/domain/roles.js';

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

      const accountsByIdentity = await client.query<{
        id: string;
        roles: string[];
      }>(
        `SELECT id, roles
         FROM user_accounts
         WHERE LOWER(email) = $1 OR phone = $2
         FOR UPDATE;`,
        [email, phoneResult.normalized],
      );

      if (accountsByIdentity.rows.length > 1) {
        throw new Error('The supplied email and phone belong to different accounts.');
      }

      const existingAdmins = await client.query<{ id: string }>(
        `SELECT id
         FROM user_accounts
         WHERE 'access-admin' = ANY(roles)
         FOR UPDATE;`,
      );

      let targetAdminId: string | undefined;
      const accountWithIdentity = accountsByIdentity.rows[0];
      if (accountWithIdentity) {
        if (!accountWithIdentity.roles.includes('access-admin')) {
          throw new Error(
            'The supplied email or phone belongs to an account that is not an access-admin.',
          );
        }
        targetAdminId = accountWithIdentity.id;
      } else if (existingAdmins.rows.length === 1) {
        targetAdminId = existingAdmins.rows[0]?.id;
      } else if (existingAdmins.rows.length > 1) {
        throw new Error(
          'Multiple access-admin accounts exist; configure this command with the target account email and phone.',
        );
      }

      const passwordHash = await hashPassword(password);
      if (targetAdminId) {
        await client.query('DELETE FROM internal_sessions WHERE user_id = $1;', [targetAdminId]);
        await client.query(
          `UPDATE user_accounts
           SET email = $1,
               phone = $2,
               password_hash = $3,
               roles = $4,
               full_name = $5,
               status = 'active',
               updated_at = NOW()
           WHERE id = $6;`,
          [
            email,
            phoneResult.normalized,
            passwordHash,
            [...OPERATIONAL_ROLES],
            fullName,
            targetAdminId,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO user_accounts (email, phone, password_hash, roles, full_name, status)
           VALUES ($1, $2, $3, $4, $5, 'active');`,
          [email, phoneResult.normalized, passwordHash, [...OPERATIONAL_ROLES], fullName],
        );
      }

      await client.query('COMMIT');
      console.info(
        `${targetAdminId ? 'Replaced' : 'Created'} the bootstrap admin account for ${email}.`,
      );
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
