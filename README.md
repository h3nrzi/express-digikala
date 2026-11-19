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

## Available Scripts

| Command                    | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| `npm run dev:setup`        | Start Docker PostgreSQL container and apply database migrations |
| `npm run bootstrap:admin`  | Create the first admin from bootstrap environment variables     |
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

## Bootstrap the First Admin

Migrations create the database schema but do not insert an admin account. To create the first admin, set these variables in your ignored `.env` file:

```dotenv
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PHONE=09121110000
BOOTSTRAP_ADMIN_PASSWORD=choose-a-private-password
BOOTSTRAP_ADMIN_FULL_NAME=System Administrator
```

After the database migrations have run, invoke the one-time command:

```bash
npm run bootstrap:admin
```

The command creates an active `access-admin` account and refuses to run if an access-admin already exists or the supplied email or phone belongs to another account. It does not run during server startup. Keep the password private and remove the bootstrap variables from `.env` after the account is created.

Log in with the configured email and password at `POST /api/v1/admin/auth/login`. Login starts MFA; in local development, the in-memory SMS sender logs the verification code in the server terminal. After verifying MFA, use the admin account to invite additional operational users.
