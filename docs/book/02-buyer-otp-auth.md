# Chapter 02: Buyer OTP Auth

## 1. The Goal & Big Picture

### What We Are Building

In this chapter, we implement the complete **Buyer OTP Authentication** slice for our Iranian physical-goods marketplace backend.

In consumer ecommerce across Iran, passwords for retail buyers are largely obsolete. Buyers authenticate exclusively via their verified Iranian mobile phone numbers (`09xx…` or `+989xx…`) and a 6-digit one-time password (OTP) delivered via SMS. No password is ever requested, set, or stored in the database.

By the end of this chapter, you will have built:

- An Iranian phone number normalizer converting 11-digit local numbers (`09123456789`), E.164 numbers (`+989123456789`), Persian/Arabic digits (`۰۹۱۲...`), and hyphenated formats into canonical E.164 (`+989XXXXXXXXX`).
- A PostgreSQL migration creating `user_accounts` and `otp_requests` tables, complete with indexes for rapid lookup and rate limiting.
- Cryptographically secure 6-digit OTP code generation, SHA-256 code hashing, and constant-time (timing-safe) hash verification.
- An OTP rate limiter in PostgreSQL that caps requests per phone number within a rolling time window.
- An OTP lifecycle manager that supersedes previous active codes when a new code is requested and enforces a maximum of 5 failed attempts to prevent online brute-force attacks.
- Account status verification checking whether the user account is `active`, rejecting `locked`, `suspended`, or `closed` accounts per our domain model.
- Short-lived signed JWT Bearer token issuance and a reusable `requireBuyerAuth` Express middleware that verifies tokens and extracts buyer identity.
- Centralized structured error handling adhering to the marketplace REST contract: `{ code, message (Persian), traceId, fieldErrors? }`.
- A fully decoupled SMS delivery port (`SmsSenderPort`) with an `InMemorySmsSender` adapter for fast, deterministic integration tests without paid third-party SMS gateway dependencies.
- A test suite spanning unit tests for domain logic and end-to-end HTTP integration tests against real PostgreSQL.

### Where It Fits

Buyer authentication is the entry gate for all authenticated consumer operations. Subsequent chapters (Saved Delivery Addresses, Cart Persistence, Checkout, Order Tracking, and Return Requests) will directly require the Bearer token issued by this module.

```
+-----------------------------------------------------------------------------------------+
|                                    HTTP Client (Buyer)                                  |
+--------------------+------------------------------------+-------------------------------+
                     |                                    |
(1) POST /otp/send   |                (2) POST /otp/verify|            (3) Protected Routes
 { phone }           |                 { phone, code }    |                (Authorization: Bearer <token>)
                     v                                    v                               v
+--------------------+------------------------------------+-------------------------------+
|                                    Express Pipeline                                     |
|  - traceMiddleware (Assigns req.traceId / X-Trace-Id)                                   |
|  - express.json()                                                                       |
|  - errorHandler (Formats structured JSON errors with Persian messages)                 |
+--------------------+------------------------------------+-------------------------------+
                     |                                    |                               |
                     v                                    v                               v
+--------------------+------------------------------------+-------------------------------+
|                         Identity Router & Auth Middleware                               |
|  - POST /api/v1/auth/otp/send                                                           |
|  - POST /api/v1/auth/otp/verify                                                         |
|  - requireBuyerAuth -> Extracts Bearer token, verifies JWT, checks role = 'buyer'       |
+--------------------+------------------------------------+-------------------------------+
                     |                                    |
                     v                                    v
+-----------------------------------------------------------------------------------------+
|                                IdentityService (Deep Module)                            |
|  - Normalizes phone numbers (09xx... / +989xx... -> canonical +989XXXXXXXXX)            |
|  - Enforces OTP send rate limits in PostgreSQL (e.g. 3 attempts / 60s window)           |
|  - Supersedes old unconsumed OTPs on new request                                        |
|  - Computes SHA-256 hashes & constant-time comparison                                   |
|  - Caps failed verification attempts (max 5)                                            |
|  - Verifies user account status ('active' vs 'locked' / 'suspended' / 'closed')         |
|  - Upserts user_accounts & signs short-lived JWT token                                   |
+--------------------+------------------------------------+-------------------------------+
                     |                                    |
         +-----------+                                    +-----------+
         |                                                            |
         v                                                            v
+------------------------------------+       +--------------------------------------------+
|         SmsSenderPort (Adapter)     |       |           PostgreSQL Database              |
|  - InMemorySmsSender (Test/Dev)     |       |  - user_accounts (id, phone, status)       |
|  - Kavenegar / FarazSMS (Production)|       |  - otp_requests (phone, code_hash, exp)    |
+------------------------------------+       +--------------------------------------------+
```

### Prerequisites

This chapter builds upon:

- **Chapter 01 (Project Scaffold):** PostgreSQL 16 container, `src/config/index.ts`, `src/db/index.ts`, `node-pg-migrate` runner, and the dual-mode Vitest test harness.
- **Node.js crypto:** Standard Node.js `crypto` library for secure random numbers and timing-safe equality.
- **GLOSSARY.md:** Definitions for **Buyer**, **User Account**, and **User Account Status**.

---

## 2. Architectural Deep Dive (The "Why")

### Modular Monolith Seams & Module Depth

Applying our deep module principles, the `Identity` module has a narrow public interface that hides substantial domain and database complexity:

1. **The Phone Normalization Seam (`src/modules/identity/domain/phone.ts`)**:
   - **Interface:** `normalizeIranianPhoneNumber(rawInput?: string): PhoneNormalizationResult`.
   - **Depth:** Callers do not write regular expressions, handle Persian/Arabic Unicode digits (`۰-۹` and `٠-٩`), or worry about input variations (`0912…`, `+989…`, `00989…`, `0912-345-6789`). The function parses, validates, and normalizes the input into canonical E.164 (`+989XXXXXXXXX`) and local (`09XXXXXXXXX`) formats.

2. **The SMS Delivery Port & Adapter Seam (`src/modules/identity/ports/sms-sender.ts`)**:
   - **Interface:** `SmsSenderPort { sendOtp(phone: string, code: string): Promise<void> }`.
   - **Depth:** Core business logic never imports or couples to a specific third-party SMS gateway SDK (e.g. Kavenegar, Magfa, or Twilio). In testing and local development, `InMemorySmsSender` captures sent messages in memory, enabling lightning-fast integration tests without network latency or external costs. In production, swapping to a real SMS gateway is a matter of supplying a single adapter class.

3. **The Identity Service Seam (`src/modules/identity/service.ts`)**:
   - **Interface:**
     - `requestOtp(phone): Promise<{ success: boolean; phone: string }>`
     - `verifyOtp(phone, code): Promise<VerifyOtpResponse>`
   - **Depth:** This deep class encapsulates PostgreSQL transactional queries, rate limit calculations, OTP generation, SHA-256 cryptographic hashing, superseding stale codes, brute-force attempt limits, account status checks, atomic user upserts, and JWT signing behind two straightforward method calls.

4. **The Auth Middleware Seam (`src/middleware/auth.ts`)**:
   - **Interface:** `createAuthMiddleware(jwtSecret): RequestHandler`.
   - **Depth:** Route handlers do not manually inspect headers, decode JWT tokens, or handle token expiry. The middleware extracts the Bearer token, cryptographically verifies its signature and expiry, enforces the `buyer` role claim, and attaches the strongly-typed `req.user` payload to the Express request object.

### Design Decisions & Alternatives Considered

| Decision              | Chosen Approach                 | Alternative Considered        | Why Chosen                                                                                                                                                                                                                                                                  |
| :-------------------- | :------------------------------ | :---------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OTP Storage**       | PostgreSQL table `otp_requests` | Redis / Key-Value cache       | Per architectural decision 15 (`15-choose-backend-architecture.md`), PostgreSQL is the single transactional store for the MVP. Introducing Redis at this stage adds infrastructure complexity, operational failure modes, and deployment overhead for low baseline traffic. |
| **OTP Security**      | SHA-256 hash of `phone:code`    | Plaintext OTP in DB           | Storing plaintext OTPs in the database creates a major security exposure in database backups and logs. Hashing the OTP with the phone number ensures the database stores zero plaintext credentials.                                                                        |
| **Timing Attacks**    | `crypto.timingSafeEqual`        | Standard string `===`         | Standard string comparison terminates on the first mismatch, leaking timing information that allows attackers to determine partial code correctness. Constant-time comparison neutralizes timing analysis.                                                                  |
| **Rate Limiting**     | PostgreSQL time-window query    | In-memory token bucket        | In a multi-replica or clustered production environment, in-memory rate limiting is easily bypassed across instances. Storing requests in PostgreSQL provides consistent rate-limiting across all processes without a separate distributed cache.                            |
| **Single Active OTP** | Invalidate prior codes on send  | Allow concurrent OTPs         | Allowing multiple valid codes for a single phone number widens the attack surface and confuses users who click "Resend" multiple times. Marking previous codes as consumed guarantees only the freshest code can authenticate.                                              |
| **Brute-Force Guard** | Cap verification at 5 attempts  | Unlimited attempts within TTL | A 6-digit numeric OTP has 1,000,000 possibilities. If an attacker can send thousands of requests within a 2-minute window, the probability of guessing increases significantly. Capping attempts at 5 and consuming the OTP invalidates brute-force scripts.                |

### Code Review Lessons & Traps Avoided

During the two-axis code review (Standards and Spec) of this slice, four critical architectural and compliance nuances were identified and resolved:

1. **Error Response Schema Consistency (`fieldErrors`):** The MVP API specification (`spec.md:303`) defines the unified error structure as `{ code, message, traceId, fieldErrors? }`. Initially, our middleware returned `details`. Changing this to `fieldErrors` ensures field-level validation errors strictly match client and OpenAPI expectations.
2. **User Account Status Enforcement:** In `GLOSSARY.md`, _User Account Status_ defines an individual's ability to sign in (`active`, `locked`, `suspended`, or `closed`). If an account was previously locked or suspended by operations, simply verifying an OTP and issuing a token would allow unauthorized access. `verifyOtp` explicitly queries the user's current status and rejects inactive accounts with an `UnauthorizedError`.
3. **Superseded OTP Vulnerability:** If a user requests an OTP, waits 30 seconds, and clicks "Resend", leaving the first OTP valid creates multiple attack vectors. `requestOtp` now executes `UPDATE otp_requests SET consumed_at = NOW() WHERE phone = $1 AND consumed_at IS NULL` before generating the new code.
4. **Triage Status Constraints:** Issue tracker documentation (`docs/agents/triage-labels.md`) restricts ticket `Status:` values to canonical triage labels (`ready-for-agent`, `needs-info`, etc.). Marking dev tickets as `resolved` violates repo conventions where `resolved` is reserved exclusively for wayfinding tickets.

---

## 3. File Map (Build Order)

Follow this logical build order when assembling this slice:

- [ ] `package.json` — Add `jsonwebtoken` and dev dependencies (`supertest`, `@types/jsonwebtoken`, `@types/supertest`)
- [ ] `.env.example` — Document auth and OTP environment variables
- [ ] `src/config/index.ts` — Extend configuration schema with JWT and OTP settings
- [ ] `migrations/1794911941800_buyer-otp-auth.js` — Database migration for `user_accounts` and `otp_requests`
- [ ] `src/errors.ts` — Domain and application error hierarchy
- [ ] `src/modules/identity/domain/phone.ts` — Iranian phone validation and normalization
- [ ] `src/modules/identity/domain/tokens.ts` — OTP code generation, SHA-256 hashing, and JWT token issuance
- [ ] `src/modules/identity/ports/sms-sender.ts` — SMS sender port and in-memory test adapter
- [ ] `src/modules/identity/service.ts` — Deep `IdentityService` module
- [ ] `src/types/express.d.ts` — Express ambient type augmentations (`traceId`, `user`)
- [ ] `src/middleware/trace.ts` — Distributed trace ID middleware
- [ ] `src/middleware/error.ts` — Centralized structured error handler
- [ ] `src/middleware/auth.ts` — Buyer JWT Bearer authentication middleware
- [ ] `src/modules/identity/routes.ts` — REST API router for `/api/v1/auth`
- [ ] `src/app.ts` — Express application factory
- [ ] `src/server.ts` — Server entry point
- [ ] `tests/unit/config.test.ts` — Configuration unit tests
- [ ] `tests/unit/phone.test.ts` — Phone validation unit tests
- [ ] `tests/unit/otp-token.test.ts` — OTP and JWT unit tests
- [ ] `tests/integration/identity-service.test.ts` — Identity service integration tests
- [ ] `tests/integration/auth-otp.test.ts` — End-to-end HTTP integration tests

---

## 4. Step-by-Step Implementation

### Step 1: Package Dependencies (`package.json`)

#### Context & Purpose

We add `jsonwebtoken` for signing and verifying JSON Web Tokens, and `supertest` for exercising Express HTTP routes against real PostgreSQL during integration tests.

#### Verified Code

Run the installation command in your terminal:

```bash
npm install jsonwebtoken
npm install -D @types/jsonwebtoken supertest @types/supertest
```

In `package.json`, verify the dependencies are present:

```json
{
  "dependencies": {
    "dotenv": "^18.0.10",
    "express": "^5.3.0",
    "jsonwebtoken": "^9.0.2",
    "pg": "^8.23.1",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/express": "^5.0.6",
    "@types/jsonwebtoken": "^9.0.10",
    "@types/node": "^26.6.6",
    "@types/pg": "^8.23.1",
    "@types/supertest": "^6.0.3",
    "eslint": "^10.15.0",
    "eslint-config-prettier": "^10.1.8",
    "node-pg-migrate": "^9.0.0",
    "prettier": "^3.10.1",
    "supertest": "^7.1.3",
    "tsx": "^4.23.15",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.73.0",
    "vitest": "^5.1.0"
  }
}
```

---

### Step 2: Environment Example (`.env.example`)

#### Context & Purpose

Documents the required environment variables for JWT secret management, token expiry, OTP time-to-live, and rate limiting thresholds.

#### Verified Code

```ini
# Server Configuration
PORT=3000
NODE_ENV=development

# PostgreSQL Database Configuration
DB_HOST=localhost
DB_PORT=5433
DB_USER=marketplace_user
DB_PASSWORD=marketplace_password
DB_NAME=marketplace_dev

# Connection URLs
DATABASE_URL=postgresql://marketplace_user:marketplace_password@localhost:5433/marketplace_dev
DATABASE_URL_TEST=postgresql://marketplace_user:marketplace_password@localhost:5433/marketplace_test

# Authentication & OTP Configuration
JWT_SECRET=dev-jwt-insecure-secret-key-32chars!!
JWT_EXPIRES_IN=1h
OTP_TTL_SECONDS=120
OTP_RATE_LIMIT_MAX_ATTEMPTS=3
OTP_RATE_LIMIT_WINDOW_SECONDS=60
```

---

### Step 3: Configuration Module (`src/config/index.ts`)

#### Context & Purpose

Validates and parses environment variables with strict typing using Zod, assigning safe defaults for local development.

#### Verified Code

```typescript
import dotenv from 'dotenv';
import { z } from 'zod';

export const DEFAULT_DEV_DB_URL =
  'postgresql://marketplace_user:marketplace_password@localhost:5433/marketplace_dev';

export const DEFAULT_TEST_DB_URL =
  'postgresql://marketplace_user:marketplace_password@localhost:5433/marketplace_test';

const envSchema = z.object({
  DATABASE_URL: z
    .string({
      error: 'DATABASE_URL is required',
    })
    .url('DATABASE_URL must be a valid URL')
    .default(DEFAULT_DEV_DB_URL),
  DATABASE_URL_TEST: z
    .string()
    .url('DATABASE_URL_TEST must be a valid URL')
    .default(DEFAULT_TEST_DB_URL),
  PORT: z
    .string()
    .default('3000')
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: 'PORT must be a valid positive number',
    })
    .transform((val) => Number(val)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters long')
    .default('dev-jwt-insecure-secret-key-32chars!!'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  OTP_TTL_SECONDS: z
    .string()
    .default('120')
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: 'OTP_TTL_SECONDS must be a positive number',
    })
    .transform((val) => Number(val)),
  OTP_RATE_LIMIT_MAX_ATTEMPTS: z
    .string()
    .default('3')
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: 'OTP_RATE_LIMIT_MAX_ATTEMPTS must be a positive number',
    })
    .transform((val) => Number(val)),
  OTP_RATE_LIMIT_WINDOW_SECONDS: z
    .string()
    .default('60')
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: 'OTP_RATE_LIMIT_WINDOW_SECONDS must be a positive number',
    })
    .transform((val) => Number(val)),
});

export interface AppConfig {
  databaseUrl: string;
  testDatabaseUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  jwtSecret: string;
  jwtExpiresIn: string;
  otpTtlSeconds: number;
  otpRateLimitMaxAttempts: number;
  otpRateLimitWindowSeconds: number;
}

export function loadConfig(
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: { loadDotenv?: boolean } = {},
): AppConfig {
  if (options.loadDotenv !== false && typeof process !== 'undefined') {
    dotenv.config();
  }

  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const errorMessages = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }

  const {
    DATABASE_URL,
    DATABASE_URL_TEST,
    PORT,
    NODE_ENV,
    JWT_SECRET,
    JWT_EXPIRES_IN,
    OTP_TTL_SECONDS,
    OTP_RATE_LIMIT_MAX_ATTEMPTS,
    OTP_RATE_LIMIT_WINDOW_SECONDS,
  } = result.data;

  return {
    databaseUrl: DATABASE_URL,
    testDatabaseUrl: DATABASE_URL_TEST,
    port: PORT,
    nodeEnv: NODE_ENV,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: JWT_EXPIRES_IN,
    otpTtlSeconds: OTP_TTL_SECONDS,
    otpRateLimitMaxAttempts: OTP_RATE_LIMIT_MAX_ATTEMPTS,
    otpRateLimitWindowSeconds: OTP_RATE_LIMIT_WINDOW_SECONDS,
  };
}
```

#### Code Walkthrough

- `JWT_SECRET`: Enforces a minimum length of 16 characters to prevent weak cryptographic signing keys.
- `OTP_TTL_SECONDS`: Sets the validity duration of an OTP (defaults to 120 seconds).
- `OTP_RATE_LIMIT_MAX_ATTEMPTS` & `OTP_RATE_LIMIT_WINDOW_SECONDS`: Configurable rate limit parameters (defaults to 3 requests per 60 seconds).

---

### Step 4: Database Migration (`migrations/1794911941800_buyer-otp-auth.js`)

#### Context & Purpose

Defines the relational tables for buyer authentication in PostgreSQL using `node-pg-migrate`.

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
    CREATE TABLE IF NOT EXISTS user_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone VARCHAR(20) NOT NULL UNIQUE,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_user_accounts_phone ON user_accounts(phone);

    CREATE TABLE IF NOT EXISTS otp_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone VARCHAR(20) NOT NULL,
      code_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ NULL,
      attempts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_otp_requests_phone_created ON otp_requests(phone, created_at DESC);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS otp_requests;
    DROP TABLE IF EXISTS user_accounts;
  `);
};
```

#### Code Walkthrough

- `user_accounts`: Stores identity accounts. `phone` is marked `UNIQUE` to prevent duplicate accounts. `status` defaults to `'active'`.
- `otp_requests`: Stores OTP transactions. `code_hash` is a 64-character hex string holding the SHA-256 hash. `consumed_at` marks whether the OTP was verified or superseded. `attempts` tracks failed guesses.
- `idx_otp_requests_phone_created`: Composite descending index enabling high-performance rate limit checks (`WHERE phone = $1 AND created_at >= NOW() - INTERVAL '...'`).

---

### Step 5: Domain Error Hierarchy (`src/errors.ts`)

#### Context & Purpose

Establishes an expressive error hierarchy where each error specifies its HTTP status code, stable machine error code, Persian message, and optional field-level validation errors.

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
```

#### Code Walkthrough

- `exactOptionalPropertyTypes` compatibility: Properties are explicitly typed as `T | undefined` to satisfy strict TypeScript compiler checks.
- `RateLimitError`: Carries `retryAfterSeconds` so middleware can set the HTTP `Retry-After` header.
- `fieldErrors`: Matches the exact naming required by the marketplace API specification.

---

### Step 6: Phone Normalization Domain Logic (`src/modules/identity/domain/phone.ts`)

#### Context & Purpose

Handles Iranian mobile phone number parsing, stripping formatting artifacts, mapping Persian/Arabic digits, and producing normalized E.164 and local strings.

#### Verified Code

```typescript
export interface PhoneNormalizationResult {
  isValid: boolean;
  normalized?: string; // E.164 format: +989XXXXXXXXX
  localFormat?: string; // 11-digit local format: 09XXXXXXXXX
  error?: string;
}

const PERSIAN_ARABIC_DIGIT_MAP: Record<string, string> = {
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

function convertDigitsToAscii(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (char) => PERSIAN_ARABIC_DIGIT_MAP[char] ?? char);
}

/**
 * Validates and normalizes Iranian mobile phone numbers.
 * Accepts:
 *  - 11-digit local format: `09xx...`
 *  - E.164 international format: `+989xx...` (or `00989xx...`)
 * Returns normalized E.164 (+989XXXXXXXXX) and local (09XXXXXXXXX) forms.
 */
export function normalizeIranianPhoneNumber(rawInput?: string | null): PhoneNormalizationResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return {
      isValid: false,
      error: 'شماره تلفن همراه الزامی است.',
    };
  }

  // Convert Persian/Arabic digits, remove spaces, dashes, parentheses
  let cleaned = convertDigitsToAscii(rawInput.trim()).replace(/[\s\-()]/g, '');

  // Handle leading international prefixes
  if (cleaned.startsWith('0098')) {
    cleaned = '+' + cleaned.substring(2);
  }

  // Pattern 1: E.164 (+989XXXXXXXXX) - exactly 13 characters
  const e164Regex = /^\+989\d{9}$/;
  // Pattern 2: Local 11-digit (09XXXXXXXXX) - exactly 11 digits
  const localRegex = /^09\d{9}$/;

  if (e164Regex.test(cleaned)) {
    const nineDigits = cleaned.substring(4);
    return {
      isValid: true,
      normalized: cleaned,
      localFormat: `09${nineDigits}`,
    };
  }

  if (localRegex.test(cleaned)) {
    const nineDigits = cleaned.substring(2);
    return {
      isValid: true,
      normalized: `+989${nineDigits}`,
      localFormat: cleaned,
    };
  }

  return {
    isValid: false,
    error:
      'فرمت شماره تلفن همراه نامعتبر است. شماره باید ۱۱ رقمی با فرمت ۰۹ یا فرمت بین‌المللی ۹۸۹+ باشد.',
  };
}

export function validateIranianPhoneNumber(rawInput?: string | null): boolean {
  return normalizeIranianPhoneNumber(rawInput).isValid;
}
```

---

### Step 7: Cryptographic Tokens & OTP Domain (`src/modules/identity/domain/tokens.ts`)

#### Context & Purpose

Provides cryptographically secure 6-digit random code generation, SHA-256 hash generation, constant-time hash comparison, and JWT token issuing/verifying.

#### Verified Code

```typescript
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
```

#### Code Walkthrough

- `crypto.randomInt(100000, 1000000)`: Replaces insecure `Math.random()` with entropy from the OS CSPRNG.
- `crypto.timingSafeEqual`: Prevents side-channel timing analysis when checking OTP hashes.
- `createBuyerToken`: Embeds the user UUID in `sub` and sets `role: 'buyer'`.

---

### Step 8: SMS Delivery Port & In-Memory Adapter (`src/modules/identity/ports/sms-sender.ts`)

#### Context & Purpose

Decouples SMS dispatching from external gateway APIs via the Ports & Adapters pattern.

#### Verified Code

```typescript
export interface SmsMessage {
  phone: string;
  code: string;
  sentAt: Date;
}

export interface SmsSenderPort {
  sendOtp(phone: string, code: string): Promise<void>;
}

export class InMemorySmsSender implements SmsSenderPort {
  private messages: SmsMessage[] = [];

  async sendOtp(phone: string, code: string): Promise<void> {
    this.messages.push({
      phone,
      code,
      sentAt: new Date(),
    });
  }

  getSentMessages(): readonly SmsMessage[] {
    return [...this.messages];
  }

  getLastMessageFor(phone: string): SmsMessage | undefined {
    return [...this.messages].reverse().find((m) => m.phone === phone);
  }

  clear(): void {
    this.messages = [];
  }
}
```

---

### Step 9: The Deep Identity Module (`src/modules/identity/service.ts`)

#### Context & Purpose

The centerpiece of the slice: coordinates rate limiting, superseded OTP invalidation, cryptographic checks, attempt limits, account status enforcement, user upsertion, and token issuance.

#### Verified Code

```typescript
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
```

---

### Step 10: Ambient Express Types (`src/types/express.d.ts`)

#### Context & Purpose

Augments Express's global `Request` interface so TypeScript strongly types `req.traceId` and `req.user`.

#### Verified Code

```typescript
import type { BuyerTokenPayload } from '../modules/identity/domain/tokens.js';

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      user?: BuyerTokenPayload;
    }
  }
}
```

---

### Step 11: Distributed Trace Middleware (`src/middleware/trace.ts`)

#### Context & Purpose

Extracts or generates a correlation UUID for each incoming request, attaching it to `req.traceId` and the `X-Trace-Id` response header for observability and log correlation.

#### Verified Code

```typescript
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingTraceId = req.header('X-Trace-Id') || req.header('X-Request-Id');
  const traceId =
    incomingTraceId && typeof incomingTraceId === 'string' ? incomingTraceId : crypto.randomUUID();

  req.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  next();
}
```

---

### Step 12: Centralized Error Handler (`src/middleware/error.ts`)

#### Context & Purpose

Intercepts all errors thrown across the application, serializing them into the marketplace JSON specification with stable codes, Persian messages, trace IDs, and optional field error arrays.

#### Verified Code

```typescript
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors.js';

export interface ErrorResponseBody {
  code: string;
  message: string;
  traceId: string;
  fieldErrors?: Array<{ field: string; message: string }>;
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const traceId = req.traceId ?? 'unknown-trace-id';

  if (err instanceof AppError) {
    if (err.retryAfterSeconds) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }

    const body: ErrorResponseBody = {
      code: err.code,
      message: err.message,
      traceId,
      ...(err.fieldErrors && err.fieldErrors.length > 0 ? { fieldErrors: err.fieldErrors } : {}),
    };

    res.status(err.statusCode).json(body);
    return;
  }

  // Handle unhandled unexpected errors
  res.status(500).json({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'خطای غیرمنتظره‌ای در سرور رخ داده است.',
    traceId,
  });
}
```

---

### Step 13: Buyer Auth Middleware (`src/middleware/auth.ts`)

#### Context & Purpose

Verifies the `Authorization: Bearer <token>` header, decodes the JWT, validates that `role === 'buyer'`, and attaches the payload to `req.user`.

#### Verified Code

```typescript
import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../errors.js';
import { verifyBuyerToken } from '../modules/identity/domain/tokens.js';

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
      next();
    } catch {
      throw new UnauthorizedError('توکن احراز هویت نامعتبر یا منقضی شده است.');
    }
  };
}
```

---

### Step 14: Identity Routes (`src/modules/identity/routes.ts`)

#### Context & Purpose

Exposes `POST /otp/send`, `POST /otp/verify`, and the protected `GET /me` endpoint.

#### Verified Code

```typescript
import { Router, type Request, type Response } from 'express';
import type { IdentityService } from './service.js';
import type { RequestHandler } from 'express';

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
    res.status(200).json({
      user: {
        id: req.user?.sub,
        phone: req.user?.phone,
        role: req.user?.role,
      },
    });
  });

  return router;
}
```

---

### Step 15: Express Application Factory (`src/app.ts`)

#### Context & Purpose

Encapsulates dependency injection and Express setup into a testable factory function `createApp(deps)`.

#### Verified Code

```typescript
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from './config/index.js';
import { errorHandler } from './middleware/error.js';
import { traceMiddleware } from './middleware/trace.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { IdentityService } from './modules/identity/service.js';
import { createIdentityRouter } from './modules/identity/routes.js';
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

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Mount modules
  const authRouter = createIdentityRouter(identityService, requireBuyerAuth);
  app.use('/api/v1/auth', authRouter);

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

### Step 16: Executable Server (`src/server.ts`)

#### Context & Purpose

Boots the Express application with live PostgreSQL connections when executed via CLI.

#### Verified Code

```typescript
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createDbPool, checkDatabaseConnection } from './db/index.js';

async function startServer(): Promise<void> {
  const config = loadConfig();
  const pool = createDbPool({ connectionString: config.databaseUrl });

  const isConnected = await checkDatabaseConnection(pool);
  if (!isConnected) {
    console.error('Failed to establish database connection during server startup.');
    process.exit(1);
  }

  const { app } = createApp({ pool, config });

  app.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port} (env: ${config.nodeEnv})`);
  });
}

if (process.env['NODE_ENV'] !== 'test') {
  startServer().catch((err) => {
    console.error('Fatal error during server startup:', err);
    process.exit(1);
  });
}
```

---

## 5. Verification & Testing (TDD Walkthrough)

### Seam & Test Strategy

We test this slice across three distinct seams:

1. **Domain Unit Tests (`tests/unit/phone.test.ts` & `tests/unit/otp-token.test.ts`)**: Verify pure algorithmic operations (Persian digit conversion, E.164 normalization, CSPRNG code generation, SHA-256 constant-time verification, JWT signing and expiry) in complete isolation without database overhead.
2. **Service Integration Tests (`tests/integration/identity-service.test.ts`)**: Verify PostgreSQL interactions directly against `IdentityService`—validating transaction execution, OTP record insertion, rate limit queries, and account upsertion.
3. **HTTP API Integration Tests (`tests/integration/auth-otp.test.ts`)**: Test the complete public interface using `supertest` against the Express app and real PostgreSQL, covering happy-path login, rate limit breaches, validation errors, expired codes, and auth middleware security.

---

### Verified Test Code

#### Unit Test: Phone Normalization (`tests/unit/phone.test.ts`)

```typescript
import { describe, expect, it } from 'vitest';
import {
  normalizeIranianPhoneNumber,
  validateIranianPhoneNumber,
} from '../../src/modules/identity/domain/phone.js';

describe('Iranian Phone Number Validation & Normalization', () => {
  it('validates and normalizes valid 11-digit numbers starting with 09', () => {
    const result = normalizeIranianPhoneNumber('09123456789');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+989123456789');
    expect(result.localFormat).toBe('09123456789');
  });

  it('validates and normalizes valid E.164 numbers starting with +989', () => {
    const result = normalizeIranianPhoneNumber('+989123456789');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+989123456789');
    expect(result.localFormat).toBe('09123456789');
  });

  it('handles spaces and hyphens gracefully', () => {
    const result = normalizeIranianPhoneNumber(' 0912-345-6789 ');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+989123456789');
  });

  it('converts Persian digits to ASCII digits', () => {
    const result = normalizeIranianPhoneNumber('۰۹۱۲۳۴۵۶۷۸۹');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+989123456789');
  });

  it('rejects numbers not starting with 09 or +989', () => {
    const result1 = normalizeIranianPhoneNumber('02123456789');
    expect(result1.isValid).toBe(false);
    expect(result1.error).toBeDefined();

    const result2 = normalizeIranianPhoneNumber('+98212345678');
    expect(result2.isValid).toBe(false);
    expect(result2.error).toBeDefined();
  });

  it('rejects numbers that are too short or too long', () => {
    const tooShort = normalizeIranianPhoneNumber('091234567');
    expect(tooShort.isValid).toBe(false);

    const tooLong = normalizeIranianPhoneNumber('0912345678901');
    expect(tooLong.isValid).toBe(false);
  });

  it('rejects non-numeric characters', () => {
    const invalid = normalizeIranianPhoneNumber('0912abc6789');
    expect(invalid.isValid).toBe(false);
  });

  it('rejects empty or whitespace-only strings', () => {
    expect(normalizeIranianPhoneNumber('').isValid).toBe(false);
    expect(normalizeIranianPhoneNumber('   ').isValid).toBe(false);
  });

  it('validateIranianPhoneNumber helper returns boolean', () => {
    expect(validateIranianPhoneNumber('09123456789')).toBe(true);
    expect(validateIranianPhoneNumber('+989123456789')).toBe(true);
    expect(validateIranianPhoneNumber('invalid')).toBe(false);
  });
});
```

#### Unit Test: Tokens & OTP (`tests/unit/otp-token.test.ts`)

```typescript
import { describe, expect, it } from 'vitest';
import {
  generateOtpCode,
  hashOtpCode,
  verifyOtpHash,
  createBuyerToken,
  verifyBuyerToken,
} from '../../src/modules/identity/domain/tokens.js';

describe('OTP & JWT Domain Services', () => {
  describe('OTP Generation and Hashing', () => {
    it('generates a 6-digit numeric OTP code', () => {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    });

    it('hashes OTP and verifies matching code safely', () => {
      const phone = '+989123456789';
      const code = '123456';
      const hash = hashOtpCode(phone, code);

      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64); // SHA-256 hex string

      expect(verifyOtpHash(phone, '123456', hash)).toBe(true);
      expect(verifyOtpHash(phone, '654321', hash)).toBe(false);
      expect(verifyOtpHash('+989120000000', '123456', hash)).toBe(false);
    });
  });

  describe('JWT Token Issuance and Verification', () => {
    const secret = 'super-secret-jwt-key-123456789012';
    const user = { userId: '550e8400-e29b-41d4-a716-446655440000', phone: '+989123456789' };

    it('creates and verifies a valid buyer JWT token', () => {
      const token = createBuyerToken(user, secret, '1h');
      expect(typeof token).toBe('string');

      const decoded = verifyBuyerToken(token, secret);
      expect(decoded.sub).toBe(user.userId);
      expect(decoded.phone).toBe(user.phone);
      expect(decoded.role).toBe('buyer');
      expect(decoded.exp).toBeDefined();
    });

    it('throws when verifying a token signed with a different secret', () => {
      const token = createBuyerToken(user, secret, '1h');
      expect(() => verifyBuyerToken(token, 'different-wrong-secret')).toThrow();
    });

    it('throws when token is expired', () => {
      const token = createBuyerToken(user, secret, '0s');
      expect(() => verifyBuyerToken(token, secret)).toThrow();
    });

    it('throws when token is malformed', () => {
      expect(() => verifyBuyerToken('invalid-token-string', secret)).toThrow();
    });
  });
});
```

#### Integration Test: HTTP REST Interface (`tests/integration/auth-otp.test.ts`)

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import type { Express } from 'express';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createApp } from '../../src/app.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';

describe('Buyer OTP Auth Integration Tests', () => {
  let pool: Pool;
  let app: Express;
  let smsSender: InMemorySmsSender;

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
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');
    smsSender.clear();
  });

  describe('Happy Path: OTP Send -> Verify -> Protected Route', () => {
    it('authenticates buyer and grants access to protected routes with Bearer token', async () => {
      // 1. Request OTP with 11-digit Iranian mobile format
      const sendRes = await request(app)
        .post('/api/v1/auth/otp/send')
        .send({ phone: '09121234567' });

      expect(sendRes.status).toBe(200);
      expect(sendRes.body.success).toBe(true);
      expect(sendRes.body.phone).toBe('+989121234567');
      expect(sendRes.headers['x-trace-id']).toBeDefined();

      // Verify SMS delivery adapter received the code
      const sentMessage = smsSender.getLastMessageFor('+989121234567');
      expect(sentMessage).toBeDefined();
      expect(sentMessage?.code).toMatch(/^\d{6}$/);

      // 2. Verify OTP with received code
      const verifyRes = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: sentMessage!.code });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.token).toBeDefined();
      expect(verifyRes.body.tokenType).toBe('Bearer');
      expect(verifyRes.body.user).toMatchObject({
        phone: '+989121234567',
        role: 'buyer',
        status: 'active',
      });
      expect(verifyRes.body.user.id).toBeDefined();

      const token = verifyRes.body.token;

      // 3. Access protected route with Bearer token
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user).toMatchObject({
        id: verifyRes.body.user.id,
        phone: '+989121234567',
        role: 'buyer',
      });
    });

    it('accepts E.164 phone format (+989...) on send and verify', async () => {
      const sendRes = await request(app)
        .post('/api/v1/auth/otp/send')
        .send({ phone: '+989351234567' });

      expect(sendRes.status).toBe(200);
      const sentMessage = smsSender.getLastMessageFor('+989351234567');

      const verifyRes = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+989351234567', code: sentMessage!.code });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.tokenType).toBe('Bearer');
      expect(verifyRes.body.user.phone).toBe('+989351234567');
    });

    it('supersedes previous OTP codes when a new OTP is requested', async () => {
      // Send first code
      await request(app).post('/api/v1/auth/otp/send').send({ phone: '09121234567' });
      const firstCode = smsSender.getLastMessageFor('+989121234567')!.code;

      // Send second code (superseding the first)
      await request(app).post('/api/v1/auth/otp/send').send({ phone: '09121234567' });
      const secondCode = smsSender.getLastMessageFor('+989121234567')!.code;

      // First code should be rejected as invalid/superseded
      const oldVerifyRes = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: firstCode });
      expect(oldVerifyRes.status).toBe(400);

      // Second code succeeds
      const newVerifyRes = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: secondCode });
      expect(newVerifyRes.status).toBe(200);
    });
  });

  describe('Validation & Error Scenarios', () => {
    it('rejects malformed phone numbers with structured error', async () => {
      const invalidPhones = ['08123456789', '0912', '0912345678901', '0912abc5678', ''];

      for (const invalidPhone of invalidPhones) {
        const res = await request(app).post('/api/v1/auth/otp/send').send({ phone: invalidPhone });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(res.body.message).toBeDefined();
        expect(res.body.traceId).toBeDefined();
        expect(res.body.fieldErrors).toEqual(
          expect.arrayContaining([expect.objectContaining({ field: 'phone' })]),
        );
      }
    });

    it('rejects malformed OTP codes during verification', async () => {
      const res = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: '123' }); // short code

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.fieldErrors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'code' })]),
      );
    });

    it('rejects wrong OTP code with structured error', async () => {
      await request(app).post('/api/v1/auth/otp/send').send({ phone: '09121234567' });

      const res = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: '000000' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_OTP');
      expect(res.body.message).toBe('کد تأیید واردشده نادرست است.');
      expect(res.body.traceId).toBeDefined();
    });

    it('rejects expired OTP code with structured error', async () => {
      await request(app).post('/api/v1/auth/otp/send').send({ phone: '09121234567' });

      const sentMessage = smsSender.getLastMessageFor('+989121234567');

      // Force expire code in DB
      await pool.query(
        "UPDATE otp_requests SET expires_at = NOW() - INTERVAL '5 seconds' WHERE phone = $1",
        ['+989121234567'],
      );

      const res = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: sentMessage!.code });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OTP_EXPIRED');
      expect(res.body.traceId).toBeDefined();
    });

    it('enforces maximum 5 failed verification attempts before invalidating OTP', async () => {
      await request(app).post('/api/v1/auth/otp/send').send({ phone: '09121234567' });
      const validCode = smsSender.getLastMessageFor('+989121234567')!.code;

      // Fail 5 times
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post('/api/v1/auth/otp/verify')
          .send({ phone: '09121234567', code: '111111' });
        expect(res.status).toBe(400);
      }

      // Even if subsequent attempt supplies the right code, it is rejected due to max attempts exceeded
      const finalRes = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code: validCode });

      expect(finalRes.status).toBe(400);
      expect(finalRes.body.code).toBe('INVALID_OTP');
    });

    it('enforces rate-limiting on OTP send to prevent abuse', async () => {
      const phone = '09129998877';

      // 3 attempts are allowed within 60s
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/api/v1/auth/otp/send').send({ phone });
        expect(res.status).toBe(200);
      }

      // 4th attempt should be blocked with 429
      const breachRes = await request(app).post('/api/v1/auth/otp/send').send({ phone });

      expect(breachRes.status).toBe(429);
      expect(breachRes.body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(breachRes.body.message).toBeDefined();
      expect(breachRes.headers['retry-after']).toBeDefined();
      expect(breachRes.body.traceId).toBeDefined();
    });

    it('rejects authentication if user account status is suspended or closed', async () => {
      const phone = '09129990011';
      // Pre-create suspended user in DB
      await pool.query(
        "INSERT INTO user_accounts (phone, status) VALUES ('+989129990011', 'suspended')",
      );

      await request(app).post('/api/v1/auth/otp/send').send({ phone });
      const code = smsSender.getLastMessageFor('+989129990011')!.code;

      const verifyRes = await request(app).post('/api/v1/auth/otp/verify').send({ phone, code });

      expect(verifyRes.status).toBe(401);
      expect(verifyRes.body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('Auth Middleware Security on Protected Routes', () => {
    it('rejects request without Authorization header', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      expect(res.body.traceId).toBeDefined();
    });

    it('rejects request with invalid token string', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer invalid.token.string');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects request with expired Bearer token', async () => {
      // Create token that expired 10 seconds ago
      const appContext = createApp({
        pool,
        config: {
          ...loadConfig({}, { loadDotenv: false }),
          jwtSecret: 'test-secret-long-enough-for-safe-signing',
          jwtExpiresIn: '0s',
        },
      });

      const expiredTokenApp = appContext.app;

      await request(expiredTokenApp).post('/api/v1/auth/otp/send').send({ phone: '09121234567' });

      const sms = appContext.smsSender as InMemorySmsSender;
      const code = sms.getLastMessageFor('+989121234567')!.code;

      const verifyRes = await request(expiredTokenApp)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '09121234567', code });

      const expiredToken = verifyRes.body.token;

      // Wait 50ms so exp is in the past
      await new Promise((resolve) => setTimeout(resolve, 50));

      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(meRes.status).toBe(401);
      expect(meRes.body.code).toBe('UNAUTHORIZED');
    });
  });
});
```

---

### How to Verify Locally

Run the following commands in your terminal to verify this slice from scratch:

```bash
# 1. Apply database migrations to test and dev databases
npm run migrate:up

# 2. Run unit tests
npm run test:unit

# 3. Run integration tests (real PostgreSQL)
npm run test:integration

# 4. Run full test suite
npm test

# 5. Verify type safety and code formatting
npm run typecheck
npm run lint
npm run format:check
```

---

### Acceptance Checklist

- [x] `POST /api/v1/auth/otp/send` accepts an Iranian-format phone number, generates a short-lived OTP, and delivers it (adapter-stubbed in tests)
- [x] `POST /api/v1/auth/otp/verify` checks the code and issues a signed short-lived JWT Bearer token on success; rejects expired or wrong codes
- [x] Iranian phone number format validated (11-digit `09xx…` or E.164 `+98xx…`); malformed numbers rejected with a structured error
- [x] Token carries buyer identity and is verified by auth middleware on protected buyer routes
- [x] Rate-limiting on OTP send to prevent abuse (configurable threshold)
- [x] Integration tests cover happy path, wrong code, expired code, malformed phone number, and rate-limit breach
