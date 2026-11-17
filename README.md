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
