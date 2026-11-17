# Chapter 03: Internal User Invite & Personal Account Auth

## 1. The Goal & Big Picture

### What We Are Building

In this chapter, we implement the complete **Internal User Onboarding, Personal Account Authentication, and Multi-Factor Authentication (MFA)** slice for our Iranian physical-goods marketplace backend.

While retail buyers in Iran authenticate via passwordless phone OTP (built in Chapter 02), internal operational users—such as catalog reviewers, support staff, seller operations, finance controllers, and access administrators—operate under a radically different security and governance model:

1. **Strictly Invitation-Only (No Self-Registration):** Internal accounts can never be registered from a public signup form. New team members must be invited by an authorized administrator (`access-admin`).
2. **Personal Accounts (No Shared Credentials):** Operational staff must use personal user accounts rather than shared administrative credentials. This ensures strict non-repudiation and immutable audit logs per our domain model.
3. **Time-Limited, Single-Use Invite Tokens:** Invitations carry cryptographically secure random tokens with strict expiry windows (default 24 hours). Once consumed to establish personal credentials, an invite token is invalidated immediately and can never be reused.
4. **Mandatory Two-Factor Authentication (MFA):** Knowing a password is not enough. Operational users authenticate with their personal email and password, which yields an _untrusted_ session with `mfa_verified = false`. Internal APIs (`/api/v1/admin/*`) reject this session with HTTP 403 Forbidden. Only after successfully submitting the 6-digit second-factor OTP sent to their verified personal mobile phone is the session promoted to `mfa_verified = true`.
5. **Brute-Force Lockout Defense:** MFA sessions enforce a hard cap of 5 failed verification attempts before the session is forcibly expired.

By the end of this chapter, you will have built:

- A PostgreSQL migration adding personal credentials (`email`, `password_hash`, `roles`, `full_name`) to `user_accounts`, creating the `user_invites` table, and establishing the `internal_sessions` table with second-factor verification tracking.
- Password hashing using Node.js's native `scrypt` algorithm with unique 16-byte random salts and constant-time comparison to protect against offline dictionary attacks and timing side channels.
- Secure 256-bit random invite token generation with SHA-256 database hashing so tokens are never stored in plaintext.
- The `InternalAuth` service methods on our deep `IdentityService` module, encapsulating invite issuance, account setup, login, MFA dispatch, MFA verification, and session state validation.
- Express middleware enforcing authentication boundaries: `requireInternalAuth` (verifying session validity and requiring `mfaVerified === true`) and `requireAccessAdmin` (enforcing the administrative placeholder role).
- Endpoints under `/api/v1/admin`:
  - `POST /api/v1/admin/users/invite`: Sends an invite to a new operational user (access-admin only).
  - `POST /api/v1/admin/auth/setup`: Invited user establishes password credentials via their invite token.
  - `POST /api/v1/admin/auth/login`: Authenticates with email and password, creates an untrusted session, and sends an SMS MFA code.
  - `POST /api/v1/admin/auth/mfa/verify`: Verifies the MFA code and promotes the session to `mfa-verified`.
  - `GET /api/v1/admin/me`: Protected internal route verifying access with an MFA-promoted session.
- Dual-layer test coverage: domain unit tests for cryptography and token hashing, service integration tests against real PostgreSQL, and HTTP integration tests asserting the complete onboarding and 2FA lifecycle.

---

### Where It Fits

Internal authentication is the bedrock for all administrative functions. Subsequent chapters—such as Role-Based Access Control (Chapter 04), the Shared Audit Trail (Chapter 05), Seller Application Review (Chapter 06), Catalog Approvals (Chapter 08), and Settlement Confirmations (Chapter 37)—will depend on the authenticated, MFA-verified internal session established here.

```
+--------------------------------------------------------------------------------------------------------+
|                                  HTTP Client (Operational Staff / Admin)                                |
+-----------------------+---------------------+---------------------+--------------------+---------------+
                        |                     |                     |                    |
 (1) Admin Invites User | (2) User Sets Up    | (3) User Logs In    | (4) User Submits   | (5) Accesses
  POST /admin/users/    |  POST /admin/auth/  |  POST /admin/auth/  |     MFA Code       |     Admin API
  invite                |  setup              |  login              |  POST /admin/auth/ |  GET /admin/me
                        |                     |                     |  mfa/verify        |
                        v                     v                     v                    v
+--------------------------------------------------------------------------------------------------------+
|                                           Express Pipeline                                             |
|  - traceMiddleware (Assigns req.traceId / X-Trace-Id)                                                  |
|  - express.json()                                                                                      |
|  - errorHandler (Structured JSON error bodies with Persian messages: { code, message, traceId })       |
+--------------------------------------------------------------------------------------------------------+
                        |                     |                     |                    |
                        v                     v                     v                    v
+--------------------------------------------------------------------------------------------------------+
|                                         Identity & Admin Routers                                       |
|  - requireAccessAdmin -------------------------------------------------> [Checks role: access-admin]   |
|  - requireInternalAuth ------------------------------------------------> [Checks mfa_verified = true] |
+--------------------------------------------------------------------------------------------------------+
                        |                     |                     |                    |
                        v                     v                     v                    v
+--------------------------------------------------------------------------------------------------------+
|                                      IdentityService (Deep Module)                                     |
|  - inviteOperationalUser: Generates 256-bit token, saves sha256 hash, sets 24h expiry                  |
|  - setupOperationalAccount: Verifies unconsumed token, scrypt-hashes password, activates user          |
|  - loginOperationalUser: Checks scrypt password, inserts unverified session, sends 6-digit MFA OTP     |
|  - verifyMfa: Verifies OTP code, caps attempts at 5, promotes session to mfa_verified = true           |
|  - validateInternalSession: Validates Bearer session token and active status against PostgreSQL        |
+--------------------------------------------------------------------------------------------------------+
         |                                     |                                         |
         v                                     v                                         v
+-------------------------+         +-------------------------+               +--------------------------+
|      SmsSenderPort      |         |  domain/passwords.ts    |               |   PostgreSQL Database    |
| - InMemorySmsSender     |         | - scrypt password hash  |               | - user_accounts          |
|   (Captures MFA codes   |         | - constant-time verify  |               | - user_invites           |
|    in tests/dev)        |         | - sha256 token hashing  |               | - internal_sessions      |
+-------------------------+         +-------------------------+               +--------------------------+
```

---

### Prerequisites

This chapter builds upon:

- **Chapter 01 (Project Scaffold):** PostgreSQL 16 container, `src/config/index.ts`, `src/db/index.ts`, `node-pg-migrate` runner, and the Vitest test harness.
- **Chapter 02 (Buyer OTP Auth):** Iranian phone normalization (`normalizeIranianPhoneNumber`), `SmsSenderPort` and `InMemorySmsSender`, OTP generation (`generateOtpCode`), and OTP hashing/timing-safe verification (`hashOtpCode`, `verifyOtpHash`).
- **GLOSSARY.md:** Definitions for **User Account**, **Operational User**, **Operational Role**, and **Access Administrator**.
- **Node.js `crypto` standard library:** Built-in cryptographic routines (`crypto.scrypt`, `crypto.randomBytes`, `crypto.timingSafeEqual`, `crypto.createHash`).

---

## 2. Architectural Deep Dive (The "Why")

### Personal Accounts vs. Shared Administrative Logins

A frequent security failure in legacy e-commerce backends is sharing a generic `admin` account across operations staff. When an inventory count is manually overridden or a high-value refund is approved, a shared account makes it impossible to determine which team member took the action.

Per our specification and `GLOSSARY.md`:

- Every operational user must hold a **personal user account** linked to their specific corporate email address and verified Iranian mobile number.
- Operational actions record the individual's `user.id` on an immutable audit trail.
- Self-registration is strictly forbidden: accounts can only be provisioned through invitations issued by an authorized `access-admin`.

### Multi-Factor Authentication: Two-Phase Session Lifecycle

Authentication for internal tools requires two factors:

1. **Factor 1 (Knowledge):** Personal email address + strong password.
2. **Factor 2 (Possession):** Verified mobile phone receiving an ephemeral 6-digit OTP via SMS.

Rather than implementing a monolithic single-step login that would complicate API clients, we use a two-phase session lifecycle:

```
                  +-----------------------------------+
                  |  POST /api/v1/admin/auth/login    |
                  |  Body: { email, password }        |
                  +-----------------+-----------------+
                                    |
                                    v
                  +-----------------------------------+
                  |  internal_sessions row created    |
                  |  - session_token: <random_hex>    |
                  |  - mfa_verified: false            |
                  |  - mfa_code_hash: <sha256>        |
                  |  - mfa_attempts: 0                |
                  +-----------------+-----------------+
                                    |
        +---------------------------+---------------------------+
        |                                                       |
        v                                                       v
Calls /api/v1/admin/* (Protected)             Calls POST /api/v1/admin/auth/mfa/verify
Authorization: Bearer <session_token>         Authorization: Bearer <session_token>
        |                                     Body: { code: "123456" }
        v                                                       |
+-----------------------------------+                           v
|   requireInternalAuth             |          +-----------------------------------+
|   Checks session in DB:           |          |   IdentityService.verifyMfa       |
|   mfa_verified == false           |          |   Checks OTP hash & attempts:     |
|   -> THROW 403 Forbidden          |          |   Updates session in DB:          |
|      (Code: MFA_REQUIRED)         |          |   - mfa_verified: true            |
+-----------------------------------+          |   - mfa_code_hash: NULL           |
                                               +----------------+------------------+
                                                                |
                                                                v
                                              Subsequent calls to /api/v1/admin/*
                                              Authorization: Bearer <session_token>
                                                                |
                                                                v
                                               +-----------------------------------+
                                               |   requireInternalAuth             |
                                               |   mfa_verified == true            |
                                               |   -> 200 OK (Allowed)             |
                                               +-----------------------------------+
```

### HTTP 401 Unauthorized vs. HTTP 403 Forbidden

A critical architectural seam is the exact HTTP response code returned by internal guards:

- **401 Unauthorized:** Returned when the request is **unauthenticated**—e.g., no `Authorization` header is provided, the token format is not `Bearer <token>`, or the session token does not exist in `internal_sessions` (or has expired). The caller must authenticate.
- **403 Forbidden:** Returned when the request is authenticated, but the actor **lacks authorization or has not completed necessary verification**. Specifically:
  1. If an internal session exists but `mfa_verified` is `false`, the server responds with HTTP 403 and `code: "MFA_REQUIRED"`.
  2. If the user is authenticated and MFA-verified, but attempts to perform an administrative action without holding the required role (e.g., a catalog user attempting to invite others), the server responds with HTTP 403 and `code: "FORBIDDEN"`.

### Password Hashing with Scrypt

We avoid external C++ binary dependencies (like `bcrypt`) by utilizing Node.js's standard `crypto.scrypt`:

- **Algorithm:** Scrypt is a memory-hard password derivation function specifically designed to make hardware-accelerated attacks (ASICs, GPUs) prohibitively expensive.
- **Format:** `scrypt:<16-byte-hex-salt>:<64-byte-hex-derived-key>`.
- **Timing Safety:** Hash verification uses `crypto.timingSafeEqual` over the derived key buffer to prevent timing attacks.

### Token Security: Never Store Plaintext Invite Tokens

Invite tokens grant the power to activate an administrative identity. Storing them in plaintext in PostgreSQL would allow anyone with read access to the database (or database backups) to hijack pending staff invitations.

We apply the same principle as passwords:

1. `generateInviteToken()` creates 32 cryptographically random bytes formatted as a 64-character hexadecimal string.
2. The user receives this raw token in their invitation.
3. The database only ever stores the SHA-256 hash: `token_hash = sha256(rawInviteToken)`.
4. When the user submits their invite token for account setup, the server hashes the input and looks up the record by `token_hash`. Even a full database dump reveals zero usable invite credentials.

### Lessons from Code Review

During our implementation review, two subtle architectural smells were identified and resolved:

1. **Redundant Route Duplication & Scope Creep:** An initial helper alias was placed under `/api/v1/auth/invite/accept`. Because internal authentication strictly belongs under the `/api/v1/admin` namespace, the duplicate route was eliminated to keep all internal operations unified and avoid divergent routing.
2. **Primitive Obsession on Roles:** Roles were initially typed as generic `string[]`. We extracted a strongly typed domain module `src/modules/identity/domain/roles.ts` introducing the `OperationalRole` union (`'seller-mgmt' | 'catalog' | 'order-ops' | 'support' | 'finance' | 'access-admin' | 'staff'`) and `ACCESS_ADMIN_ROLE` constant, ensuring compile-time safety across service methods and middleware.

---

## 3. File Map (Build Order)

Here is every file created or modified in this slice, arranged in the logical order of implementation:

- [ ] `migrations/1794911941900_internal-user-invite-auth.js` — Migration extending `user_accounts` and creating `user_invites` and `internal_sessions` tables.
- [ ] `src/errors.ts` — Adding `ForbiddenError`, `MfaRequiredError`, `InviteExpiredError`, and `InviteAlreadyUsedError`.
- [ ] `src/modules/identity/domain/roles.ts` — Strongly typed operational role definitions and constants.
- [ ] `src/modules/identity/domain/passwords.ts` — Scrypt password hashing, timing-safe verification, invite token generation and SHA-256 hashing.
- [ ] `src/types/express.d.ts` — Express request type declarations for `user`, `internalUser`, and `buyerUser`.
- [ ] `src/modules/identity/service.ts` — Core service methods for operational user invites, account setup, login, MFA challenge/verification, and session validation.
- [ ] `src/middleware/auth.ts` — `createInternalAuthMiddleware` (enforcing MFA-verified sessions) and `requireAccessAdmin` (placeholder role check).
- [ ] `src/modules/identity/routes.ts` — Admin HTTP routes for `/users/invite`, `/auth/setup`, `/auth/login`, `/auth/mfa/verify`, and `/me`.
- [ ] `src/app.ts` — Mounting the admin router under `/api/v1/admin`.
- [ ] `vitest.config.ts` — Configuring sequential integration test execution (`fileParallelism: false`) for transactional database safety.
- [ ] `tests/unit/password-token.test.ts` — Unit tests for password hashing and invite token mechanics.
- [ ] `tests/integration/internal-auth-service.test.ts` — Database-backed integration tests for the service seam.
- [ ] `tests/integration/admin-auth.test.ts` — End-to-end HTTP integration tests for the REST API seam.

---

## 4. Step-by-Step Implementation

### Step 1: Database Migration (`migrations/1794911941900_internal-user-invite-auth.js`)

#### Context & Purpose

We must expand `user_accounts` so operational users can store their corporate email, scrypt password hash, operational roles, and full name. We also need `user_invites` to track time-limited invitations, and `internal_sessions` to track login state, MFA codes, and MFA verification status.

#### Verified Code

```javascript
/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    -- Extend user_accounts for internal operational credentials and roles
    ALTER TABLE user_accounts
      ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS full_name VARCHAR(100) NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_email ON user_accounts(email) WHERE email IS NOT NULL;

    -- Table for onboarding operational users via invitation
    CREATE TABLE IF NOT EXISTS user_invites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      roles TEXT[] NOT NULL DEFAULT '{}',
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      invited_by UUID NULL REFERENCES user_accounts(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_user_invites_token_hash ON user_invites(token_hash);
    CREATE INDEX IF NOT EXISTS idx_user_invites_email ON user_invites(email);

    -- Table for internal sessions requiring second-factor verification (MFA)
    CREATE TABLE IF NOT EXISTS internal_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
      session_token VARCHAR(128) NOT NULL UNIQUE,
      mfa_verified BOOLEAN NOT NULL DEFAULT FALSE,
      mfa_code_hash VARCHAR(64) NULL,
      mfa_expires_at TIMESTAMPTZ NULL,
      mfa_attempts INT NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_internal_sessions_token ON internal_sessions(session_token);
    CREATE INDEX IF NOT EXISTS idx_internal_sessions_user ON internal_sessions(user_id);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS internal_sessions;
    DROP TABLE IF EXISTS user_invites;
    DROP INDEX IF EXISTS idx_user_accounts_email;
    ALTER TABLE user_accounts
      DROP COLUMN IF EXISTS full_name,
      DROP COLUMN IF EXISTS roles,
      DROP COLUMN IF EXISTS password_hash,
      DROP COLUMN IF EXISTS email;
  `);
};
```

#### Code Walkthrough

- `idx_user_accounts_email`: A partial unique index (`WHERE email IS NOT NULL`) ensures corporate emails are strictly unique among operational users while allowing consumer buyers (who sign in purely via mobile number) to have a `NULL` email.
- `roles TEXT[] NOT NULL DEFAULT '{}'`: PostgreSQL array column storing the assigned operational roles on the user account and invite record.
- `user_invites`: Holds the SHA-256 hashed invite token (`token_hash VARCHAR(64)`), the target `email`, the target `phone` (for MFA SMS dispatch), and expiration/consumption timestamps.
- `internal_sessions`: Holds active session tokens. Notice `mfa_verified BOOLEAN NOT NULL DEFAULT FALSE`. A session begins unverified; `mfa_code_hash` holds the SHA-256 hash of the 6-digit OTP, while `mfa_attempts` tracks failed attempts.

---

### Step 2: Custom Error Hierarchies (`src/errors.ts`)

#### Context & Purpose

Extend `src/errors.ts` with explicit domain error classes for authorization and invitation lifecycles. All error classes inherit from `AppError` and carry standard HTTP status codes, error codes, and Persian error messages conforming to our marketplace REST contract.

#### Verified Code

```typescript
export interface FieldErrorDetail {
  field: string;
  message: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fieldErrors?: FieldErrorDetail[] | undefined;
  public readonly retryAfterSeconds?: number | undefined;

  constructor(options: {
    message: string;
    statusCode: number;
    code: string;
    fieldErrors?: FieldErrorDetail[] | undefined;
    retryAfterSeconds?: number | undefined;
  }) {
    super(options.message);
    this.name = 'AppError';
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fieldErrors?: FieldErrorDetail[] | undefined) {
    super({
      message,
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      fieldErrors,
    });
    this.name = 'ValidationError';
  }
}

export class InvalidOtpError extends AppError {
  constructor(message: string = 'کد تأیید واردشده نادرست است.') {
    super({
      message,
      statusCode: 400,
      code: 'INVALID_OTP',
    });
    this.name = 'InvalidOtpError';
  }
}

export class OtpExpiredError extends AppError {
  constructor(message: string = 'کد تأیید منقضی شده است. لطفاً مجدداً درخواست ارسال کد دهید.') {
    super({
      message,
      statusCode: 400,
      code: 'OTP_EXPIRED',
    });
    this.name = 'OtpExpiredError';
  }
}

export class RateLimitError extends AppError {
  constructor(
    message: string = 'تعداد درخواست‌های ارسال کد بیش از حد مجاز است. لطفاً کمی صبر کرده و سپس تلاش کنید.',
    retryAfterSeconds: number = 60,
  ) {
    super({
      message,
      statusCode: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterSeconds,
    });
    this.name = 'RateLimitError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'دسترسی غیرمجاز. لطفاً ابتدا وارد حساب کاربری خود شوید.') {
    super({
      message,
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message: string = 'دسترسی غیرمجاز. شما مجوز لازم برای انجام این عملیات را ندارید.',
    code: string = 'FORBIDDEN',
  ) {
    super({
      message,
      statusCode: 403,
      code,
    });
    this.name = 'ForbiddenError';
  }
}

export class MfaRequiredError extends AppError {
  constructor(
    message: string = 'برای دسترسی به این بخش، تکمیل احراز هویت دو مرحله‌ای (MFA) الزامی است.',
  ) {
    super({
      message,
      statusCode: 403,
      code: 'MFA_REQUIRED',
    });
    this.name = 'MfaRequiredError';
  }
}

export class InviteExpiredError extends AppError {
  constructor(
    message: string = 'دعوت‌نامه منقضی شده است. لطفاً از مدیر سیستم درخواست دعوت جدید نمایید.',
  ) {
    super({
      message,
      statusCode: 400,
      code: 'INVITE_EXPIRED',
    });
    this.name = 'InviteExpiredError';
  }
}

export class InviteAlreadyUsedError extends AppError {
  constructor(message: string = 'این دعوت‌نامه قبلاً مورد استفاده قرار گرفته است.') {
    super({
      message,
      statusCode: 400,
      code: 'INVITE_ALREADY_USED',
    });
    this.name = 'InviteAlreadyUsedError';
  }
}
```

#### Code Walkthrough

- `ForbiddenError`: Carries HTTP 403. Used when an authenticated actor attempts an action outside their permissions (e.g. non-admin inviting users).
- `MfaRequiredError`: Carries HTTP 403 with `code: 'MFA_REQUIRED'`. Signals to API clients that the user holds a valid password session but must complete second-factor verification before accessing internal resources.
- `InviteExpiredError` & `InviteAlreadyUsedError`: Carry HTTP 400 with distinct semantic codes to give immediate, localized feedback when account onboarding fails.

---

### Step 3: Domain Roles (`src/modules/identity/domain/roles.ts`)

#### Context & Purpose

Provide a strongly typed domain representation for internal operational roles. This eliminates loose string literals and prepares the foundation for RBAC in Ticket 04.

#### Verified Code

```typescript
export type OperationalRole =
  'seller-mgmt' | 'catalog' | 'order-ops' | 'support' | 'finance' | 'access-admin';

export const OPERATIONAL_ROLES: readonly OperationalRole[] = [
  'seller-mgmt',
  'catalog',
  'order-ops',
  'support',
  'finance',
  'access-admin',
] as const;

export const ACCESS_ADMIN_ROLE: OperationalRole = 'access-admin';

export function isValidOperationalRole(role: string): role is OperationalRole {
  return (OPERATIONAL_ROLES as readonly string[]).includes(role);
}
```

#### Code Walkthrough

- `OperationalRole`: TypeScript union type covering all six operational roles specified in `spec.md` and `GLOSSARY.md`.
- `ACCESS_ADMIN_ROLE`: Exported constant ensuring the invite guard checks against the exact domain role identifier.
- `isValidOperationalRole`: Type-guard function validating that untrusted input roles match defined operational roles before state changes.

---

### Step 4: Password Hashing & Invite Tokens (`src/modules/identity/domain/passwords.ts`)

#### Context & Purpose

Implement pure cryptographic functions for password hashing using `scrypt`, timing-safe verification, secure random invite token generation, and SHA-256 token hashing.

#### Verified Code

```typescript
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
```

#### Code Walkthrough

- `scryptAsync`: Node.js's asynchronous Scrypt implementation.
- `hashPassword`: Generates 16 bytes of random salt for every invocation (`crypto.randomBytes(16)`), derives a 64-byte key, and formats the result as `scrypt:${salt}:${derivedKey}`.
- `verifyPassword`: Parses the stored salt and derived key, derives the key for the candidate password with the same salt, and uses `crypto.timingSafeEqual` to prevent timing attacks.
- `generateInviteToken`: Generates 32 random bytes (256 bits of entropy) resulting in a 64-character hex string.
- `hashInviteToken`: Deterministic SHA-256 hash for database storage and index lookups.

---

### Step 5: Express Request Typing (`src/types/express.d.ts`)

#### Context & Purpose

Extend Express's `Request` interface to declare the authenticated user context for both buyers and internal users.

#### Verified Code

```typescript
import type { BuyerTokenPayload } from '../modules/identity/domain/tokens.js';
import type { InternalSessionUser } from '../modules/identity/service.js';

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      user?: BuyerTokenPayload | InternalSessionUser;
      buyerUser?: BuyerTokenPayload;
      internalUser?: InternalSessionUser;
    }
  }
}
```

#### Code Walkthrough

- `internalUser`: Carries typed operational identity (`id`, `email`, `phone`, `roles: OperationalRole[]`, `mfaVerified: boolean`).
- `buyerUser`: Preserves typed consumer buyer identity (`sub`, `phone`, `role: 'buyer'`).

---

### Step 6: Identity Service Deep Module (`src/modules/identity/service.ts`)

#### Context & Purpose

The `IdentityService` class encapsulates all identity, buyer OTP, and internal staff authentication logic behind a clean, deep interface. Callers never write SQL or manipulate cryptography directly.

#### Verified Code

```typescript
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

    await this.pool.query(
      'UPDATE otp_requests SET consumed_at = NOW() WHERE phone = $1 AND consumed_at IS NULL;',
      [phone],
    );

    const code = generateOtpCode();
    const codeHash = hashOtpCode(phone, code);
    const ttlSeconds = this.config.otpTtlSeconds;

    const insertOtpQuery = `
      INSERT INTO otp_requests (phone, code_hash, expires_at)
      VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)
      RETURNING id, expires_at;
    `;

    await this.pool.query(insertOtpQuery, [phone, codeHash, ttlSeconds]);
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

    const existingUserQuery = 'SELECT status FROM user_accounts WHERE phone = $1;';
    const existingUserRes = await this.pool.query<{ status: string }>(existingUserQuery, [phone]);
    if (existingUserRes.rows[0] && existingUserRes.rows[0].status !== 'active') {
      throw new UnauthorizedError(
        'حساب کاربری شما غیرفعال یا معلق است. لطفاً با پشتیبانی تماس بگیرید.',
      );
    }

    await this.pool.query('UPDATE otp_requests SET consumed_at = NOW() WHERE id = $1', [
      activeOtp.id,
    ]);

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
```

#### Code Walkthrough

- `inviteOperationalUser`: Normalizes email and mobile phone, validates that neither is already registered, generates a 32-byte cryptographically secure token, writes the SHA-256 hash to `user_invites`, and returns the raw `inviteToken`.
- `setupOperationalAccount`: Takes the raw token, hashes it with SHA-256, looks up the active invite, ensures `consumed_at` is null and `expires_at > NOW()`, scrypt-hashes the password, and upserts `user_accounts` before marking `consumed_at = NOW()`.
- `loginOperationalUser`: Looks up the user by email, verifies the password with `verifyPassword`, verifies `status === 'active'`, creates a row in `internal_sessions` with `mfa_verified: false`, generates a 6-digit OTP, and dispatches it via `smsSender.sendOtp`.
- `verifyMfa`: Validates the session token, verifies that failed attempts have not reached 5, checks code expiry, verifies the timing-safe OTP hash, and promotes the session: `UPDATE internal_sessions SET mfa_verified = TRUE, mfa_code_hash = NULL`.
- `validateInternalSession`: Used by middleware on every internal request. Checks session token existence, session expiry, user account status, and returns `{ valid, mfaVerified, user }`.

---

### Step 7: Internal Authentication Middleware (`src/middleware/auth.ts`)

#### Context & Purpose

Provide Express middlewares guarding internal routes:

1. `requireInternalAuth`: Validates the Bearer session token, rejecting unauthenticated callers with 401 and unverified MFA sessions with 403.
2. `requireAccessAdmin`: Placeholder role check ensuring only users with `access-admin` can invite others.

#### Verified Code

```typescript
import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, MfaRequiredError, UnauthorizedError } from '../errors.js';
import { verifyBuyerToken } from '../modules/identity/domain/tokens.js';
import type { IdentityService, InternalSessionUser } from '../modules/identity/service.js';
import { ACCESS_ADMIN_ROLE } from '../modules/identity/domain/roles.js';

export function createAuthMiddleware(jwtSecret: string) {
  return function requireBuyerAuth(req: Request, _res: Response, next: NextFunction): void {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      throw new UnauthorizedError('توکن احراز هویت معتبر نیست.');
    }

    try {
      const payload = verifyBuyerToken(token, jwtSecret);
      if (payload.role !== 'buyer') {
        throw new UnauthorizedError('دسترسی مجاز برای این عملیات وجود ندارد.');
      }
      req.user = payload;
      req.buyerUser = payload;
      next();
    } catch {
      throw new UnauthorizedError('توکن احراز هویت نامعتبر یا منقضی شده است.');
    }
  };
}

export function createInternalAuthMiddleware(identityService: IdentityService) {
  return async function requireInternalAuth(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      throw new UnauthorizedError('توکن احراز هویت معتبر نیست.');
    }

    try {
      const sessionResult = await identityService.validateInternalSession(token);
      if (!sessionResult.valid || !sessionResult.user) {
        throw new UnauthorizedError('نشست نامعتبر یا منقضی شده است.');
      }

      if (!sessionResult.mfaVerified) {
        throw new MfaRequiredError(
          'برای دسترسی به این بخش، تکمیل احراز هویت دو مرحله‌ای (MFA) الزامی است.',
        );
      }

      req.user = sessionResult.user;
      req.internalUser = sessionResult.user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAccessAdmin(req: Request, _res: Response, next: NextFunction): void {
  const roles =
    req.internalUser?.roles ?? (req.user as InternalSessionUser | undefined)?.roles ?? [];

  if (!roles.includes(ACCESS_ADMIN_ROLE)) {
    throw new ForbiddenError('فقط کاربر با نقش راهبر دسترسی مجاز به انجام این عملیات است.');
  }

  next();
}
```

#### Code Walkthrough

- `createInternalAuthMiddleware`: Extracts `Authorization: Bearer <sessionToken>`. If absent or malformed, throws `UnauthorizedError` (HTTP 401). If the session exists in PostgreSQL but has not yet completed second-factor verification, throws `MfaRequiredError` (HTTP 403). If valid and verified, populates `req.internalUser` and `req.user`.
- `requireAccessAdmin`: Checks whether `ACCESS_ADMIN_ROLE` (`'access-admin'`) is present in `req.internalUser.roles`. If absent, throws `ForbiddenError` (HTTP 403).

---

### Step 8: Identity & Admin Routers (`src/modules/identity/routes.ts`)

#### Context & Purpose

Defines the REST endpoints for internal user management and authentication under `/api/v1/admin`.

#### Verified Code

```typescript
import { Router, type Request, type Response } from 'express';
import type { IdentityService, InternalSessionUser } from './service.js';
import type { RequestHandler } from 'express';
import { UnauthorizedError } from '../../errors.js';
import type { BuyerTokenPayload } from './domain/tokens.js';

export function createIdentityRouter(
  identityService: IdentityService,
  requireBuyerAuth: RequestHandler,
): Router {
  const router = Router();

  // POST /api/v1/auth/otp/send
  router.post('/otp/send', async (req: Request, res: Response, next) => {
    try {
      const { phone } = req.body ?? {};
      const result = await identityService.requestOtp(phone);
      res.status(200).json({
        success: true,
        message: 'کد تأیید با موفقیت برای شماره همراه شما ارسال شد.',
        phone: result.phone,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/otp/verify
  router.post('/otp/verify', async (req: Request, res: Response, next) => {
    try {
      const { phone, code } = req.body ?? {};
      const result = await identityService.verifyOtp(phone, code);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Protected route for verifying buyer session / token
  // GET /api/v1/auth/me
  router.get('/me', requireBuyerAuth, (req: Request, res: Response) => {
    const buyer = req.buyerUser ?? (req.user as BuyerTokenPayload | undefined);
    res.status(200).json({
      user: {
        id: buyer?.sub,
        phone: buyer?.phone,
        role: buyer?.role,
      },
    });
  });

  return router;
}

export function createAdminRouter(
  identityService: IdentityService,
  requireInternalAuth: RequestHandler,
  requireAccessAdmin: RequestHandler,
): Router {
  const router = Router();

  // POST /api/v1/admin/users/invite (Access-admin only)
  router.post(
    '/users/invite',
    requireInternalAuth,
    requireAccessAdmin,
    async (req: Request, res: Response, next) => {
      try {
        const { email, phone, roles, fullName } = req.body ?? {};
        const adminId = (req.internalUser ?? (req.user as InternalSessionUser | undefined))?.id;
        const invite = await identityService.inviteOperationalUser(adminId ?? null, {
          email,
          phone,
          roles,
          fullName,
        });

        res.status(201).json({
          success: true,
          invite,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/v1/admin/auth/setup
  router.post('/auth/setup', async (req: Request, res: Response, next) => {
    try {
      const { token, inviteToken, password, fullName } = req.body ?? {};
      const user = await identityService.setupOperationalAccount({
        token: token ?? inviteToken,
        password,
        fullName,
      });

      res.status(200).json({
        success: true,
        message:
          'حساب کاربری با موفقیت راه‌اندازی شد. اکنون می‌توانید با ایمیل و رمز عبور خود وارد شوید.',
        user,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/auth/login
  router.post('/auth/login', async (req: Request, res: Response, next) => {
    try {
      const { email, password } = req.body ?? {};
      const result = await identityService.loginOperationalUser({ email, password });

      res.status(200).json({
        success: true,
        sessionToken: result.sessionToken,
        mfaRequired: result.mfaRequired,
        message: 'کد تأیید دو مرحله‌ای به شماره همراه شما ارسال شد.',
        user: result.user,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/auth/mfa/verify
  router.post('/auth/mfa/verify', async (req: Request, res: Response, next) => {
    try {
      const authHeader = req.header('Authorization');
      let sessionToken = req.body?.sessionToken;

      if (!sessionToken && authHeader && authHeader.startsWith('Bearer ')) {
        sessionToken = authHeader.substring(7).trim();
      }

      if (!sessionToken) {
        throw new UnauthorizedError('توکن نشست ارسال نشده است.');
      }

      const { code } = req.body ?? {};
      const result = await identityService.verifyMfa({ sessionToken, code });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/me (Protected internal route)
  router.get('/me', requireInternalAuth, (req: Request, res: Response) => {
    const user = req.internalUser ?? (req.user as InternalSessionUser);
    res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        roles: user.roles,
        mfaVerified: user.mfaVerified,
      },
    });
  });

  return router;
}
```

#### Code Walkthrough

- `POST /users/invite`: Guarded by `requireInternalAuth` and `requireAccessAdmin`. Responds with 201 Created and the invite payload containing `inviteToken`.
- `POST /auth/setup`: Unauthenticated endpoint where the newly invited colleague submits their invite token and sets their initial personal password.
- `POST /auth/login`: Accepts `email` and `password`. If valid, triggers the SMS OTP and returns `{ sessionToken, mfaRequired: true }`.
- `POST /auth/mfa/verify`: Accepts the 6-digit OTP via Bearer header or request body and promotes the session.
- `GET /me`: Guarded by `requireInternalAuth`, returning the verified operator profile.

---

### Step 9: Express Application Assembly (`src/app.ts`)

#### Context & Purpose

Wire up the services, middlewares, and mount the admin router at `/api/v1/admin`.

#### Verified Code

```typescript
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from './config/index.js';
import { errorHandler } from './middleware/error.js';
import { traceMiddleware } from './middleware/trace.js';
import {
  createAuthMiddleware,
  createInternalAuthMiddleware,
  requireAccessAdmin,
} from './middleware/auth.js';
import { IdentityService } from './modules/identity/service.js';
import { createAdminRouter, createIdentityRouter } from './modules/identity/routes.js';
import { type SmsSenderPort, InMemorySmsSender } from './modules/identity/ports/sms-sender.js';

export interface AppDependencies {
  pool: Pool;
  config: AppConfig;
  smsSender?: SmsSenderPort;
}

export interface AppContext {
  app: Express;
  identityService: IdentityService;
  smsSender: SmsSenderPort;
}

export function createApp(deps: AppDependencies): AppContext {
  const app = express();

  // Core HTTP middlewares
  app.use(express.json());
  app.use(traceMiddleware);

  // Initialize ports and services
  const smsSender = deps.smsSender ?? new InMemorySmsSender();
  const identityService = new IdentityService(deps.pool, smsSender, {
    jwtSecret: deps.config.jwtSecret,
    jwtExpiresIn: deps.config.jwtExpiresIn,
    otpTtlSeconds: deps.config.otpTtlSeconds,
    otpRateLimitMaxAttempts: deps.config.otpRateLimitMaxAttempts,
    otpRateLimitWindowSeconds: deps.config.otpRateLimitWindowSeconds,
  });

  const requireBuyerAuth = createAuthMiddleware(deps.config.jwtSecret);
  const requireInternalAuth = createInternalAuthMiddleware(identityService);

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Mount modules
  const authRouter = createIdentityRouter(identityService, requireBuyerAuth);
  app.use('/api/v1/auth', authRouter);

  const adminRouter = createAdminRouter(identityService, requireInternalAuth, requireAccessAdmin);
  app.use('/api/v1/admin', adminRouter);

  // Global structured error handler
  app.use(errorHandler);

  return {
    app,
    identityService,
    smsSender,
  };
}
```

---

### Step 10: Vitest Configuration (`vitest.config.ts`)

#### Context & Purpose

Ensure integration test suites run serially against the shared PostgreSQL test database to prevent cross-suite fixture truncation race conditions.

#### Verified Code

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: ['default'],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 15000,
          fileParallelism: false,
        },
      },
    ],
  },
});
```

---

## 5. Verification & Testing (TDD Walkthrough)

### Seam & Test Strategy

Our testing strategy covers three distinct boundaries:

1. **Unit Seam (`tests/unit/password-token.test.ts`):** Tests pure cryptographic invariants in memory. Asserts that Scrypt hashes are unique, verification is timing-safe, and invite tokens are 256-bit secure hex strings.
2. **Service Integration Seam (`tests/integration/internal-auth-service.test.ts`):** Tests state transitions directly against PostgreSQL. Asserts invite token generation, single-use consumption, expiration backdating, password verification, session creation, and the 5-attempt MFA lockout limit.
3. **HTTP Integration Seam (`tests/integration/admin-auth.test.ts`):** Tests the end-to-end REST API boundary using `supertest`. Asserts the complete lifecycle: an access-admin invites a user, the user sets credentials, logs in, receives an untrusted session, is blocked from internal endpoints with HTTP 403 (`MFA_REQUIRED`), verifies MFA, and is admitted with HTTP 200.

---

### Verified Test Code

#### 1. Unit Tests: `tests/unit/password-token.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import {
  generateInviteToken,
  hashInviteToken,
  hashPassword,
  verifyPassword,
} from '../../src/modules/identity/domain/passwords.js';

describe('Password & Invite Token Domain Seam', () => {
  describe('Password Hashing', () => {
    it('hashes passwords using scrypt with unique random salts', async () => {
      const password = 'CorrectHorseBatteryStaple123!';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
      expect(hash2).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
      expect(hash1).not.toBe(hash2);
    });

    it('verifies passwords correctly', async () => {
      const password = 'StrongPassword987#';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);

      const isInvalid = await verifyPassword('WrongPassword', hash);
      expect(isInvalid).toBe(false);
    });

    it('returns false for malformed password hashes without throwing', async () => {
      expect(await verifyPassword('password', 'invalid-hash')).toBe(false);
      expect(await verifyPassword('password', 'scrypt:short')).toBe(false);
      expect(await verifyPassword('password', '')).toBe(false);
    });
  });

  describe('Invite Tokens', () => {
    it('generates a 64-character hex cryptographically secure token', () => {
      const token1 = generateInviteToken();
      const token2 = generateInviteToken();

      expect(token1).toHaveLength(64);
      expect(token2).toHaveLength(64);
      expect(token1).toMatch(/^[0-9a-f]{64}$/);
      expect(token1).not.toBe(token2);
    });

    it('hashes invite tokens deterministically using sha256', () => {
      const token = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const hash1 = hashInviteToken(token);
      const hash2 = hashInviteToken(token);

      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      expect(hash1).toBe(hash2);
    });
  });
});
```

#### 2. Service Integration Tests: `tests/integration/internal-auth-service.test.ts`

```typescript
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
```

#### 3. HTTP Integration Tests: `tests/integration/admin-auth.test.ts`

```typescript
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
```

---

### How to Verify Locally

Run the following terminal commands to verify migrations, linting, formatting, types, and all tests in your local repository:

```bash
# 1. Apply database migrations to your development PostgreSQL container
npm run migrate:up

# 2. Check TypeScript static types
npm run typecheck

# 3. Check ESLint rules
npm run lint

# 4. Check Prettier code formatting
npm run format:check

# 5. Run only unit tests
npm run test:unit

# 6. Run only integration tests
npm run test:integration

# 7. Run the entire comprehensive test suite
npm test
```

Expected output:

```text
Test Files  10 passed (10)
     Tests  63 passed (63)
```

---

### Acceptance Checklist

- [x] `POST /api/v1/admin/users/invite` (access-admin only placeholder — full RBAC comes in ticket 04) sends an invite to a new operational user
- [x] Invited user completes account setup (sets credentials) via a time-limited invite token
- [x] Login endpoint issues a session that is not fully trusted until a second factor is verified
- [x] Second-factor verification endpoint promotes the session to `mfa-verified`; internal routes reject sessions that have not passed MFA
- [x] Invite tokens expire and cannot be reused
- [x] Integration tests cover happy-path invite → setup → login → MFA; expired invite; MFA-unverified session rejected from an internal route
