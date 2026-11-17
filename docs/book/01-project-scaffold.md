# Chapter 01: Project Scaffold

## 1. The Goal & Big Picture

### What We Are Building

In this chapter, we bootstrap the complete, production-ready foundation for the **Ecommerce Marketplace Backend**—a modular-monolith REST API built with Node.js, Express, TypeScript, and PostgreSQL.

By the end of this chapter, you will have:

- A strictly typed TypeScript project running under modern ECMAScript Modules (`"type": "module"`).
- ESLint 9 (flat config) and Prettier enforcing automated quality and formatting standards without conflicts.
- A local PostgreSQL 16 container orchestrated via Docker Compose, configured with automated test database initialization and health checks.
- A dedicated PostgreSQL migration runner (`node-pg-migrate`) integrated with a baseline migration enabling cryptographic and UUID extensions (`uuid-ossp`, `pgcrypto`).
- A dual-mode Vitest test harness supporting fast, isolated unit tests for pure domain functions alongside integration tests executing against a real PostgreSQL instance.
- A GitHub Actions CI pipeline running linting, formatting checks, type validation, migrations, and the test suite on every push.
- A one-command local developer setup (`npm run dev:setup`).

### Where It Fits

This scaffold is the ground floor upon which every subsequent domain module—Identity and Access, Seller Participation, Catalog, Inventory Reservations, Cart & Multi-Seller Checkout, Order Fulfillment, Payment & Settlement, Returns, and Support—will be constructed.

```
+-------------------------------------------------------------------------+
|                              Developer CLI / CI                         |
|      (npm run dev:setup | npm test | npm run lint | npm run typecheck)  |
+------------------------------------+------------------------------------+
                                     |
                                     v
+------------------------------------+------------------------------------+
|                         Application Modules                             |
|  +---------------------------+        +------------------------------+  |
|  |     src/config/index.ts   |        |        src/db/index.ts       |  |
|  | (Zod Validation & Defaults| <-----+ |   (Pool Management & Health) |  |
|  +---------------------------+        +--------------+---------------+  |
+------------------------------------------------------|------------------+
                                                       |
               +---------------------------------------+
               | (Port 5433 -> 5432)
               v
+-------------------------------------------------------------------------+
|                       Docker Compose Infrastructure                     |
|  +-------------------------------------------------------------------+  |
|  |                     PostgreSQL 16 (Alpine)                        |  |
|  |   - marketplace_dev  (Development Store)                          |  |
|  |   - marketplace_test (Automated Integration Test Store)           |  |
|  |   - docker/init-test-db.sh (Automatic Test DB Provisioning)       |  |
|  |   - Extensions: uuid-ossp, pgcrypto                               |  |
|  +-------------------------------------------------------------------+  |
+-------------------------------------------------------------------------+
```

### Prerequisites

- Node.js v20+ or v22+ (tested with Node v24).
- Docker and Docker Compose installed and running.
- Basic familiarity with TypeScript, npm, and SQL.

---

## 2. Architectural Deep Dive (The "Why")

### Modular Monolith Seams & Module Depth

A well-designed software module is **deep**: it presents a minimal, self-explanatory **interface** while hiding substantial **implementation** complexity behind that boundary. Deep modules deliver **leverage** to callers (who need to learn very little to get large capabilities) and **locality** to maintainers (modifications and error recovery are isolated in one place).

In this foundation, we establish two critical modules:

1. **The Configuration Module (`src/config/index.ts`)**:
   - **Interface:** `loadConfig(env?, options?): AppConfig`, plus canonical constants `DEFAULT_DEV_DB_URL` and `DEFAULT_TEST_DB_URL`.
   - **Depth:** Callers do not parse environment strings, cast port numbers, or supply fallback regexes. The module encapsulates Zod schema validation, environment normalization, sensible defaults, and informative error formatting behind a single function call.
2. **The Database Module (`src/db/index.ts`)**:
   - **Interface:** `createDbPool(config?): pg.Pool` and `checkDatabaseConnection(pool): Promise<boolean>`.
   - **Depth:** Connection pool sizing, client acquisition, timeout handling, connection cleanup, and error suppression during health checks are encapsulated. Callers simply request a pool or probe health without managing raw PostgreSQL connection lifecycles.

### Design Decisions & Alternatives Considered

| Decision              | Chosen Approach                          | Alternative Considered    | Why Chosen                                                                                                                                                                                    |
| :-------------------- | :--------------------------------------- | :------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Module System**     | Native ESM (`"type": "module"`)          | CommonJS (`require`)      | ESM is the official standard for modern JavaScript and TypeScript; enables clean tree-shaking and seamless alignment with modern libraries like Vitest and ESLint 9.                          |
| **Test Runner**       | Vitest (Workspace projects)              | Jest / Mocha              | Vitest executes natively with ESM and TypeScript via Vite's pipeline without `ts-jest` compilation overhead; supports segregated `unit` and `integration` test projects in one config.        |
| **Migration Runner**  | `node-pg-migrate`                        | TypeORM / Prisma / Flyway | Dedicated exclusively to PostgreSQL; supports transactional migrations, programmatic execution in test suites, and schema evolution without heavy ORM lock-in.                                |
| **Host Port Mapping** | `5433:5432` (configurable via `DB_PORT`) | `5432:5432`               | Local developer machines frequently run PostgreSQL via Homebrew or system services on port 5432. Mapping to 5433 prevents port collisions while keeping container internals on standard 5432. |
| **Test Isolation**    | Dedicated `marketplace_test` DB          | In-memory SQLite / Mocks  | The marketplace relies heavily on Postgres-specific relational features (row-level locking, JSONB, PostgreSQL extensions). Mocking or using SQLite misses real PostgreSQL locking behaviors.  |

### Code Review Lessons & Traps Avoided

During automated code review of this scaffold, five architectural subtleties were identified and resolved:

1. **Cold-Start Race Conditions in Setup Scripts:** Running `docker compose up -d && npm run migrate:up` causes an immediate failure on clean machines because Docker starts the container in the background while Postgres is still running `initdb`. By using `docker compose up -d --wait` alongside a Docker Compose `healthcheck`, the command safely blocks until PostgreSQL is accepting connections.
2. **Test Database Fallback Trap:** A fallback chain like `process.env.DATABASE_URL_TEST || process.env.DATABASE_URL` is dangerous: if `DATABASE_URL_TEST` is unset in a local shell, tests run against `DATABASE_URL` (the active development or production database), mutating live data. Fallbacks must resolve exclusively to test databases (`DEFAULT_TEST_DB_URL`).
3. **Healthcheck Error Handling:** A connection probe (`checkDatabaseConnection`) should return a boolean (`false` on failure). If `pool.connect()` throws without a `try/catch`, callers attempting conditional health handling will crash.
4. **Build Output Contamination:** Compiling TypeScript with `rootDir: "./"` and broad `include` paths causes `tests/` and config files to be emitted into `dist/`. Introducing `tsconfig.build.json` targeting only `src/` keeps deployment artifacts clean.
5. **Linting and Formatting Separation:** ESLint is responsible for code quality and bug detection; Prettier is responsible for formatting. Using `eslint-config-prettier` turns off conflicting ESLint rules so the two tools never fight.

---

## 3. File Map (Build Order)

Follow this logical build order when assembling the repository from scratch:

- [ ] `package.json` — Project manifests, scripts, dependencies, and metadata
- [ ] `tsconfig.json` — Strict TypeScript compiler configuration
- [ ] `tsconfig.build.json` — Production build compilation rules
- [ ] `eslint.config.mjs` — ESLint 9 flat configuration with Prettier compatibility
- [ ] `.prettierrc` — Prettier code formatting rules
- [ ] `.prettierignore` — Files excluded from formatting
- [ ] `.gitignore` — Build outputs, environment secrets, and runtime artifacts to ignore
- [ ] `docker/init-test-db.sh` — PostgreSQL container initialization script for test database
- [ ] `docker-compose.yml` — Local PostgreSQL container service definition
- [ ] `.env.example` — Template environment variables configuration
- [ ] `.env` — Local development environment variables
- [ ] `src/config/index.ts` — Deep configuration loader and environment validator
- [ ] `src/db/index.ts` — PostgreSQL connection pool and health check module
- [ ] `migrations/1794911941722_baseline-init.js` — Baseline database migration enabling UUID and pgcrypto
- [ ] `vitest.config.ts` — Vitest configuration with unit and integration projects
- [ ] `tests/unit/config.test.ts` — Unit tests for configuration parsing and validation
- [ ] `tests/integration/db-smoke.test.ts` — Integration smoke test for PostgreSQL connectivity
- [ ] `tests/integration/migrations.test.ts` — Integration tests for database migration runner
- [ ] `.github/workflows/ci.yml` — GitHub Actions automated CI workflow
- [ ] `README.md` — Project onboarding and quick-start documentation

---

## 4. Step-by-Step Implementation

### Step 1: Package Manifest (`package.json`)

Defines the project as an ES module, registers lifecycle scripts, and locks dependencies.

```json
{
  "name": "ecommerce-marketplace-backend",
  "version": "0.1.0",
  "description": "Modular-monolith REST API backend for an Iranian physical-goods ecommerce marketplace",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "migrate:up": "node-pg-migrate --dir migrations -d DATABASE_URL up",
    "migrate:down": "node-pg-migrate --dir migrations -d DATABASE_URL down",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test": "vitest run",
    "test:watch": "vitest",
    "docker:up": "docker compose up -d",
    "docker:down": "docker compose down",
    "dev:setup": "docker compose up -d --wait && npm run migrate:up"
  },
  "keywords": [
    "marketplace",
    "ecommerce",
    "express",
    "typescript",
    "postgresql",
    "modular-monolith"
  ],
  "author": "",
  "license": "UNLICENSED",
  "private": true,
  "dependencies": {
    "dotenv": "^18.0.10",
    "express": "^5.3.0",
    "pg": "^8.23.1",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/express": "^5.0.6",
    "@types/node": "^26.6.6",
    "@types/pg": "^8.23.1",
    "eslint": "^10.15.0",
    "eslint-config-prettier": "^10.1.8",
    "node-pg-migrate": "^9.0.0",
    "prettier": "^3.10.1",
    "tsx": "^4.23.15",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.73.0",
    "vitest": "^5.1.0"
  }
}
```

### Step 2: TypeScript Configuration (`tsconfig.json` & `tsconfig.build.json`)

Strict mode is enabled with zero tolerances for implicit anys, unhandled nulls, or unchecked index accesses.

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "tests/**/*", "vitest.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

Create `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

### Step 3: Linting & Formatting (`eslint.config.mjs`, `.prettierrc`, `.prettierignore`, `.gitignore`)

Create `eslint.config.mjs`:

```javascript
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.scratch/**', 'docs/**', '.agents/**'],
  },
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
);
```

Create `.prettierrc`:

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100
}
```

Create `.prettierignore`:

```
node_modules
dist
coverage
.scratch
.agents
package-lock.json
```

Create `.gitignore`:

```
# Dependencies
node_modules/

# Build artifacts
dist/

# Environment files
.env
.env.local
.env.*.local

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
*.log

# Coverage and test output
coverage/

# IDE and OS
.DS_Store
.idea/
.vscode/
*.swp
*.swo
```

### Step 4: Infrastructure & Container Setup (`docker-compose.yml` & `docker/init-test-db.sh`)

Create `docker/init-test-db.sh` (make it executable via `chmod +x docker/init-test-db.sh`):

```bash
#!/bin/sh
set -e

# Automatically create the test database when the postgres container initializes
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE marketplace_test;
    GRANT ALL PRIVILEGES ON DATABASE marketplace_test TO $POSTGRES_USER;
EOSQL
```

Create `docker-compose.yml`:

```yaml
name: express-digikala

services:
  postgres:
    image: postgres:16-alpine
    container_name: marketplace-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${DB_USER:-marketplace_user}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-marketplace_password}
      POSTGRES_DB: ${DB_NAME:-marketplace_dev}
    ports:
      - '${DB_PORT:-5433}:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./docker/init-test-db.sh:/docker-entrypoint-initdb.d/init-test-db.sh:ro
    healthcheck:
      test:
        ['CMD-SHELL', 'pg_isready -U ${DB_USER:-marketplace_user} -d ${DB_NAME:-marketplace_dev}']
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

Create `.env.example` and copy to `.env`:

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
```

### Step 5: The Configuration Module (`src/config/index.ts`)

Encapsulates runtime validation using Zod. Note the clean seam: callers never parse raw strings or handle malformed port numbers.

Create `src/config/index.ts`:

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
});

export interface AppConfig {
  databaseUrl: string;
  testDatabaseUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
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

  const { DATABASE_URL, DATABASE_URL_TEST, PORT, NODE_ENV } = result.data;

  return {
    databaseUrl: DATABASE_URL,
    testDatabaseUrl: DATABASE_URL_TEST,
    port: PORT,
    nodeEnv: NODE_ENV,
  };
}
```

### Step 6: The Database Pool Module (`src/db/index.ts`)

Encapsulates PostgreSQL pool instantiation and health monitoring.

Create `src/db/index.ts`:

```typescript
import pg from 'pg';
import { DEFAULT_DEV_DB_URL } from '../config/index.js';

const { Pool } = pg;

export interface DbConfig {
  connectionString?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export function createDbPool(config: DbConfig = {}): pg.Pool {
  const connectionString =
    config.connectionString ?? process.env['DATABASE_URL'] ?? DEFAULT_DEV_DB_URL;

  return new Pool({
    connectionString,
    max: config.max ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
  });
}

export async function checkDatabaseConnection(pool: pg.Pool): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      const res = await client.query<{ ok: number }>('SELECT 1 AS ok');
      return res.rows[0]?.ok === 1;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}
```

### Step 7: Baseline Database Migration (`migrations/1794911941722_baseline-init.js`)

Enables the `uuid-ossp` and `pgcrypto` PostgreSQL extensions for subsequent ticket requirements.

Create `migrations/1794911941722_baseline-init.js`:

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
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql('DROP EXTENSION IF EXISTS "uuid-ossp";');
  pgm.sql('DROP EXTENSION IF EXISTS "pgcrypto";');
};
```

### Step 8: Continuous Integration Pipeline (`.github/workflows/ci.yml`)

Runs automated checks inside an Ubuntu runner with a live PostgreSQL container on every push and PR to `main`.

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    name: Lint, Typecheck & Test
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: marketplace_user
          POSTGRES_PASSWORD: marketplace_password
          POSTGRES_DB: marketplace_dev
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run ESLint
        run: npm run lint

      - name: Verify Code Formatting
        run: npm run format:check

      - name: Run TypeScript typecheck
        run: npm run typecheck

      - name: Initialize Test Database
        run: |
          PGPASSWORD=marketplace_password psql -h localhost -U marketplace_user -d marketplace_dev -c "CREATE DATABASE marketplace_test;"

      - name: Run Migrations
        env:
          DATABASE_URL: postgresql://marketplace_user:marketplace_password@localhost:5432/marketplace_dev
        run: npm run migrate:up

      - name: Run Tests (Unit & Integration)
        env:
          DATABASE_URL: postgresql://marketplace_user:marketplace_password@localhost:5432/marketplace_dev
          DATABASE_URL_TEST: postgresql://marketplace_user:marketplace_password@localhost:5432/marketplace_test
        run: npm test
```

### Step 9: Documentation (`README.md`)

Create `README.md`:

````markdown
# Ecommerce Marketplace Backend

Modular-monolith REST API backend for an Iranian physical-goods ecommerce marketplace (Node.js, Express, TypeScript, PostgreSQL).

## Quick Start (One-Command Setup)

Ensure you have [Node.js](https://nodejs.org/) (v20+) and [Docker](https://www.docker.com/) installed and running.

```bash
# 1. Clone repository and install dependencies
git clone <repo-url>
cd express-digikala
npm install

# 2. Copy environment configuration
cp .env.example .env

# 3. One-command local setup (starts Postgres container and runs migrations)
npm run dev:setup

# 4. Run tests
npm test
```
````

## Available Scripts

| Command                    | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| `npm run dev:setup`        | Start Docker PostgreSQL container and apply database migrations |
| `npm run docker:up`        | Start background PostgreSQL container via Docker Compose        |
| `npm run docker:down`      | Stop background PostgreSQL container                            |
| `npm run migrate:up`       | Run pending PostgreSQL database migrations                      |
| `npm run migrate:down`     | Rollback the latest database migration                          |
| `npm test`                 | Run full test suite (both unit and integration tests)           |
| `npm run test:unit`        | Run fast, isolated unit test suite                              |
| `npm run test:integration` | Run integration tests against PostgreSQL test database          |
| `npm run typecheck`        | Run TypeScript compiler type-checking (`tsc --noEmit`)          |
| `npm run lint`             | Run ESLint checks across TypeScript and JavaScript files        |
| `npm run format`           | Format codebase using Prettier                                  |
| `npm run format:check`     | Verify codebase formatting with Prettier                        |

## Database Architecture

- **PostgreSQL 16**: Managed locally via Docker Compose (`docker-compose.yml`).
- **Development Database**: `marketplace_dev` (default port `5433` to prevent collision with local instances).
- **Test Database**: `marketplace_test` (automatically initialized by `docker/init-test-db.sh`).
- **Migrations**: Governed via `node-pg-migrate` in `migrations/` and recorded in `pgmigrations` table.

````

---

## 5. Verification & Testing (TDD Walkthrough)

### Seam & Test Strategy
We test strictly at public module seams:
1. **Config Seam (`src/config/index.ts`)**: Pure unit testing. Validates schema parsing, default assignments, and error conditions when environment variables are missing or malformed.
2. **Database Smoke Seam (`src/db/index.ts`)**: Integration testing. Tests against a live PostgreSQL server, verifying socket connection, credential authorization, query execution (`SELECT 1`), and non-crashing behavior on bad configurations.
3. **Migration Runner Seam (`migrations/`)**: Integration testing. Invokes `node-pg-migrate` against `marketplace_test`, asserting table creation (`pgmigrations`), extension installation (`uuid-ossp`, `pgcrypto`), and UUID generation.

### Vitest Workspace Configuration (`vitest.config.ts`)
Create `vitest.config.ts`:
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
        },
      },
    ],
  },
});
````

### Verified Test Code

#### 1. Unit Test Suite: Configuration

Create `tests/unit/config.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { loadConfig, DEFAULT_DEV_DB_URL, DEFAULT_TEST_DB_URL } from '../../src/config/index.js';

describe('loadConfig', () => {
  it('parses environment with default values when empty', () => {
    const config = loadConfig({}, { loadDotenv: false });

    expect(config.databaseUrl).toBe(DEFAULT_DEV_DB_URL);
    expect(config.testDatabaseUrl).toBe(DEFAULT_TEST_DB_URL);
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
  });

  it('respects explicitly provided values', () => {
    const config = loadConfig(
      {
        DATABASE_URL: 'postgresql://custom_user:pass@localhost:5432/custom_dev',
        DATABASE_URL_TEST: 'postgresql://custom_user:pass@localhost:5432/custom_test',
        PORT: '8080',
        NODE_ENV: 'test',
      },
      { loadDotenv: false },
    );

    expect(config.databaseUrl).toBe('postgresql://custom_user:pass@localhost:5432/custom_dev');
    expect(config.testDatabaseUrl).toBe('postgresql://custom_user:pass@localhost:5432/custom_test');
    expect(config.port).toBe(8080);
    expect(config.nodeEnv).toBe('test');
  });

  it('throws an error when DATABASE_URL is not a valid URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'invalid-url' }, { loadDotenv: false })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('throws an error when PORT is not a valid number', () => {
    expect(() =>
      loadConfig(
        {
          PORT: 'not-a-number',
        },
        { loadDotenv: false },
      ),
    ).toThrow(/PORT/);
  });
});
```

#### 2. Integration Test Suite: Database Connection Smoke Test

Create `tests/integration/db-smoke.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool, checkDatabaseConnection } from '../../src/db/index.js';
import { DEFAULT_TEST_DB_URL } from '../../src/config/index.js';

describe('Database Integration Smoke Test', () => {
  let pool: Pool;
  const testDbUrl = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DB_URL;

  beforeAll(() => {
    pool = createDbPool({
      connectionString: testDbUrl,
      max: 5,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('connects to Postgres and verifies healthcheck via checkDatabaseConnection', async () => {
    const isHealthy = await checkDatabaseConnection(pool);
    expect(isHealthy).toBe(true);
  });

  it('returns false when database connection fails rather than throwing', async () => {
    const badPool = createDbPool({
      connectionString: 'postgresql://invalid_user:invalid_password@localhost:5433/nonexistent',
      connectionTimeoutMillis: 1000,
    });
    try {
      const isHealthy = await checkDatabaseConnection(badPool);
      expect(isHealthy).toBe(false);
    } finally {
      await badPool.end();
    }
  });

  it('executes a basic query against the database', async () => {
    const result = await pool.query<{ sum: number }>('SELECT 1 + 1 AS sum');
    expect(result.rows[0]?.sum).toBe(2);
  });
});
```

#### 3. Integration Test Suite: Migration Execution

Create `tests/integration/migrations.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { createDbPool } from '../../src/db/index.js';
import { DEFAULT_TEST_DB_URL } from '../../src/config/index.js';

describe('Database Migration Runner', () => {
  let pool: Pool;
  const testDbUrl = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DB_URL;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: testDbUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies baseline migration cleanly and creates pgmigrations table', async () => {
    // Run migrations up using runner API
    await runner({
      databaseUrl: testDbUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    // Check pgmigrations table exists and has entries
    const migrationsResult = await pool.query<{ name: string }>(
      'SELECT name FROM pgmigrations ORDER BY id ASC',
    );
    expect(migrationsResult.rows.length).toBeGreaterThanOrEqual(1);
    expect(migrationsResult.rows[0]?.name).toContain('baseline-init');

    // Verify extensions installed by baseline migration
    const extensionResult = await pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'pgcrypto')",
    );
    const installedExts = extensionResult.rows.map((r) => r.extname);
    expect(installedExts).toContain('uuid-ossp');
    expect(installedExts).toContain('pgcrypto');

    // Verify uuid generation function works
    const uuidResult = await pool.query<{ uuid: string }>('SELECT uuid_generate_v4() AS uuid');
    expect(uuidResult.rows[0]?.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
```

### How to Verify Locally

Run the full verification suite in your terminal:

```bash
# 1. Check code quality and formatting
npm run lint
npm run format:check

# 2. Check TypeScript strict types
npm run typecheck

# 3. Compile distribution build
npm run build

# 4. Bring up PostgreSQL container and wait for healthy state
docker compose up -d --wait

# 5. Apply migrations
npm run migrate:up

# 6. Execute all unit and integration tests
npm test
```

### Acceptance Checklist

- [x] TypeScript project initialised with strict mode; ESLint and Prettier configured and passing on an empty codebase.
- [x] Docker Compose brings up a Postgres instance; connection verified in a smoke test.
- [x] Migration runner integrated (`node-pg-migrate`); at least one baseline migration applied cleanly.
- [x] Test harness configured (integration runner pointing at test DB, unit runner for pure functions); `npm test` exits green.
- [x] CI pipeline stub runs lint, type-check, and tests on every push; pipeline is green.
- [x] `README` documents the one-command local setup.
