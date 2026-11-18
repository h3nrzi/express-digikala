# Chapter 06: Seller Application & Review Lifecycle

## 1. The Goal & Big Picture

### What We Are Building

In this chapter, we build the **Seller Application & Review Lifecycle** module. This operational domain allows internal marketplace operations personnel to onboard third-party merchants (_فروشندگان شخص ثالث_), record their legal identity and contact credentials, and transition their participation status through a strictly enforced state machine:

$$\text{pending-review} \longrightarrow \text{under-review} \longrightarrow \begin{cases} \text{active} \\ \text{rejected} \end{cases}$$

In an Iranian physical-goods marketplace modelled after Digikala, third-party sellers are the lifeblood of the catalog. However, unlike consumer buyers who self-register via SMS OTP, merchants carry significant legal, tax, and commercial obligations under Iranian commercial legislation:

- **Electronic Commerce Law (_قانون تجارت الکترونیکی_):** Platforms bear shared responsibility for consumer disclosures, seller identity validation, and counterfeit prevention.
- **National Tax Administration Directives (_سازمان امور مالیاتی کشور_):** Each merchant operates under a unique National Taxpayer ID (_کد اقتصادی یا شناسه ملی_). Every seller suborder and invoice is linked directly to this taxpayer ID for value-added tax (VAT / _ارزش افزوده_) reporting and seasonal tax declarations (_معاملات فصلی ماده ۱۶۹ مکرر_).
- **Separation of Concerns in MVP:** Third-party sellers do **not** have direct login accounts or a self-service management portal in the initial MVP release. Instead, internal operational staff (_کارشناسان عملیات فروشندگان_) handle onboarding, verification of business registries, and offer management on behalf of merchants.

To safeguard marketplace integrity, we enforce four foundational guarantees:

1. **Deterministic State Machine:** A third-party seller application begins strictly in `pending-review`. It cannot jump directly to `active` or `rejected` without first entering `under-review`. Once `active` or `rejected`, illegal backwards or horizontal transitions are rejected immediately.
2. **PostgreSQL Relational Integrity & Unique Taxpayer ID:** Every seller record stores identity fields (`name`, `taxpayer_id`, and structured `contact`). A database-level unique constraint (`uq_sellers_taxpayer_id`) ensures that no taxpayer ID can be registered more than once, returning a clean HTTP 409 Conflict error.
3. **Transactional Audit Logging:** Every status change is coupled within an atomic PostgreSQL transaction (`withTransaction`) with our append-only audit trail (`recordAuditEvent`). The status cannot mutate without recording the operational actor ID, previous status, new status, and approval/rejection justification.
4. **Role-Based Access Control (RBAC):** All administrative endpoints under `/api/v1/admin/sellers` are protected by internal authentication, requiring MFA completion and the dedicated operational role `seller-mgmt`.

---

### Where It Fits

The Seller Participation module sits at the heart of merchant governance. It bridges the foundational identity/RBAC infrastructure built in Chapters 03 and 04 with the immutable audit log established in Chapter 05, laying the groundwork for upcoming catalog offers, inventory, and settlement disbursements:

```
+---------------------------------------------------------------------------------------------------------------+
|                                    Operational Staff Client (HTTP / REST)                                     |
+---------------------------------------------------------------------------------------------------------------+
                                                        |
                                                        | Bearer Token (Session with 'seller-mgmt' Role + MFA)
                                                        v
+---------------------------------------------------------------------------------------------------------------+
|                                           Express Routing Tier                                                |
|                                                                                                               |
|  POST   /api/v1/admin/sellers             -> createSellerApplication()                                       |
|  GET    /api/v1/admin/sellers             -> listSellers(statusFilter?)                                       |
|  GET    /api/v1/admin/sellers/:id         -> getSellerById(id)                                                |
|  PATCH  /api/v1/admin/sellers/:id/status  -> transitionSellerStatus(newStatus, reason)                        |
|                                                                                                               |
|  Guards: requireInternalAuth -> requireRole('seller-mgmt')                                                    |
+---------------------------------------------------------------------------------------------------------------+
                                                        |
                                                        | Delegates to deep module
                                                        v
+---------------------------------------------------------------------------------------------------------------+
|                                                SellerService                                                  |
|                                          src/modules/seller/service.ts                                        |
|                                                                                                               |
|   1. Enforces status machine rules: assertValidSellerTransition(current, next)                                |
|   2. Opens database transaction via withTransaction()                                                         |
|   3. Row locks seller row: SELECT * FROM sellers WHERE id = $1 FOR UPDATE                                     |
|   4. Mutates status and records audit event in ONE transaction:                                               |
|      - UPDATE sellers SET status = $1, updated_at = NOW()                                                     |
|      - recordAuditEvent(client, { action: 'seller.status_transition', ... })                                   |
+---------------------------------------------------------------------------------------------------------------+
                           |                                                    |
                           | Reads & Writes                                     | Records Event
                           v                                                    v
+---------------------------------------+          +------------------------------------------------------------+
|        PostgreSQL: sellers            |          |              PostgreSQL: audit_events                      |
|  - id UUID (PK)                       |          |  - id UUID (PK)                                            |
|  - name VARCHAR(255)                  |          |  - occurred_at TIMESTAMPTZ (NOW())                         |
|  - taxpayer_id VARCHAR(100) (UNIQUE)  |          |  - actor_type 'user'                                       |
|  - contact JSONB                      |          |  - actor_id (operator UUID)                                |
|  - status VARCHAR(50) (CHECK)         |          |  - action 'seller.status_transition'                       |
|  - created_at / updated_at            |          |  - previous_value: {"status": "pending-review"}            |
+---------------------------------------+          |  - new_value: {"status": "under-review"}                  |
                                                   |  - reason: "Business registration documents verified"       |
                                                   +------------------------------------------------------------+
```

---

### Prerequisites

This chapter builds directly upon:

- **Chapter 04 (Internal Role Middleware & RBAC):** Uses `requireInternalAuth` and `requireRole('seller-mgmt')` to enforce Separation of Duties.
- **Chapter 05 (Audit Trail Shared Writer):** Uses `withTransaction` and `recordAuditEvent` to record immutable historical traces of merchant approvals and rejections.

---

## 2. Architectural Deep Dive (The "Why")

### Pure Domain State Machine vs. Database Constraints

In stateful enterprise workflows, state transitions can be constrained in two places:

1. **At the database engine:** Using SQL triggers, check constraints, or foreign keys.
2. **In a pure domain module:** Using deterministic pure functions and TypeScript unions.

In our architecture, we use **both**, leveraging the distinct strengths of each tier:

- The **database** enforces _valid membership_:
  ```sql
  CONSTRAINT chk_sellers_status CHECK (status IN ('pending-review', 'under-review', 'active', 'rejected'))
  ```
  This guarantees that no rogue SQL query or external script can ever insert an invalid status string like `"approved"`, `"verified"`, or `"disabled"`.
- The **domain module** (`src/modules/seller/domain/status-machine.ts`) enforces _valid transition paths_:
  It is a pure TypeScript function with zero I/O, zero network dependencies, and zero database queries. Given `current` and `next`, it computes whether the transition is legal in constant time ($\mathcal{O}(1)$):
  ```ts
  export const ALLOWED_STATUS_TRANSITIONS: Record<SellerStatus, readonly SellerStatus[]> = {
    'pending-review': ['under-review'],
    'under-review': ['active', 'rejected'],
    active: [],
    rejected: [],
  };
  ```

This separation ensures the business logic can be unit-tested thoroughly in milliseconds without starting a database or booting Express.

---

### Concurrency and Pessimistic Row Locking (`FOR UPDATE`)

In high-throughput marketplace operations, multiple operational staff may work concurrently on merchant applications. Consider a race condition without concurrency control:

1. **Staff A** opens seller application `X` (currently `pending-review`) and clicks "Begin Review" (`under-review`).
2. Simultaneously, **Staff B** mistakenly opens the same seller application and attempts an invalid transition or duplicate operation.
3. If both requests read `status = 'pending-review'` at the exact same millisecond, both might proceed to mutate the record, generating duplicate or conflicting audit events.

To eliminate race conditions, `SellerService.transitionSellerStatus` acquires a pessimistic row-level lock within the transaction boundary:

```sql
SELECT * FROM sellers WHERE id = $1 FOR UPDATE;
```

PostgreSQL halts any concurrent transaction attempting to read or modify the same seller row until the first transaction completes its `COMMIT` or `ROLLBACK`. The locked row provides the authoritative `current.status` against which `assertValidSellerTransition` validates the transition.

---

### High-Leverage Seam: Composing Admin Sub-Routers at the Application Root

During our code-review phase, we identified a critical architectural smell: `src/modules/identity/routes.ts` had previously included placeholder loops for operational routes. If `identity/routes.ts` were made responsible for importing `sellerService` and mounting `/sellers`, it would create tight coupling across domains (**Divergent Change** and **Shotgun Surgery**). Every new domain (catalog, orders, finance) would force edits to the identity module.

Instead, we follow the **Deep Module & Application Composition Root** pattern:

- `src/modules/seller/routes.ts` exposes a self-contained router factory: `createSellerAdminRouter(sellerService, requireInternalAuth)`. It knows nothing about identity internals beyond the session user contract.
- `src/app.ts` (the composition root) imports `createSellerAdminRouter` and mounts it directly onto the top-level admin router:
  ```ts
  const adminRouter = createAdminRouter(identityService, requireInternalAuth, requireAccessAdmin);
  const sellerRouter = createSellerAdminRouter(sellerService, requireInternalAuth);
  adminRouter.use('/sellers', sellerRouter);
  app.use('/api/v1/admin', adminRouter);
  ```

This preserves **module locality**: the `identity` module owns identity, the `seller` module owns sellers, and `app.ts` binds them together.

---

### Audit Actor Attribution & Fast Failures

When recording an audit event during status transitions, our code review flagged a subtle hazard: falling back to a dummy or nil UUID (e.g., `00000000-0000-0000-0000-000000000000`) if the operational user was not found on `req`.

In a production audit trail, attributing an approval or rejection to a magic nil UUID destroys forensic traceability. If the upstream authentication middleware somehow failed to populate `req.internalUser`, the transition handler must **fail fast**:

```ts
const internalUser = req.internalUser ?? (req.user as InternalSessionUser | undefined);
if (!internalUser) {
  throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
}
const actorUserId = internalUser.id;
```

This guarantees that every entry in `audit_events` is indelibly attached to a genuine, authenticated human operator.

---

## 3. File Map (Build Order)

Here is the exact build order for manually implementing this vertical slice:

- [ ] `src/errors.ts` — Add `ConflictError` (HTTP 409) and `InvalidStateTransitionError` (HTTP 400) to the core error taxonomy.
- [ ] `migrations/1794911942100_seller-application-review-lifecycle.js` — Create the `sellers` table, unique index on `taxpayer_id`, and status check constraint.
- [ ] `src/modules/seller/domain/status-machine.ts` — Pure domain state machine and transition validators.
- [ ] `src/modules/seller/types.ts` — Domain types, DTO interfaces, database row schemas, and structured contact definitions.
- [ ] `src/modules/seller/service.ts` — Deep `SellerService` class encapsulating queries, transaction handling, row locking, and audit recording.
- [ ] `src/modules/seller/routes.ts` — Express administrative router for `/api/v1/admin/sellers`.
- [ ] `src/modules/seller/index.ts` — Public module facade exporting types, service, and routes.
- [ ] `src/modules/identity/routes.ts` — Clean operational route group placeholders in identity router.
- [ ] `src/app.ts` — Instantiate `SellerService` and mount `createSellerAdminRouter` onto `adminRouter`.
- [ ] `tests/unit/seller-lifecycle.test.ts` — Unit tests for status machine definitions, type guards, and transitions.
- [ ] `tests/integration/seller-service.test.ts` — Integration tests for database operations, conflict handling, and transactional audit trails.
- [ ] `tests/integration/seller-lifecycle-api.test.ts` — Full HTTP integration tests for RBAC, seller creation, status progression, and listing/detail endpoints.

---

## 4. Step-by-Step Implementation

### Step 1: Core Error Taxonomy Extensions

#### Context & Purpose

When a client attempts an illegal state transition (e.g. jumping from `pending-review` directly to `active`), or attempts to create a seller with a duplicate taxpayer ID, our API must return structured, machine-readable HTTP errors rather than generic 500 crashes.

#### Verified Code: `src/errors.ts`

Add `ConflictError` (409) and `InvalidStateTransitionError` (400) to [src/errors.ts](file:///Users/hossein/Projects/express-digikala/src/errors.ts):

```ts
export class ConflictError extends AppError {
  constructor(
    message: string = 'منبع با مشخصات ارائه‌شده از قبل در سیستم وجود دارد.',
    code: string = 'CONFLICT',
  ) {
    super({
      message,
      statusCode: 409,
      code,
    });
    this.name = 'ConflictError';
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(
    message: string = 'تغییر وضعیت درخواستی مجاز نمی‌باشد.',
    code: string = 'INVALID_STATE_TRANSITION',
  ) {
    super({
      message,
      statusCode: 400,
      code,
    });
    this.name = 'InvalidStateTransitionError';
  }
}
```

#### Code Walkthrough

- `ConflictError`: Sets `statusCode: 409` with code `'CONFLICT'`. Used when database unique constraints (such as `taxpayer_id`) are violated.
- `InvalidStateTransitionError`: Sets `statusCode: 400` with code `'INVALID_STATE_TRANSITION'`. Expresses client-side domain invariant violations when requesting disallowed lifecycle paths.

---

### Step 2: Database Migration for Sellers

#### Context & Purpose

This migration introduces the `sellers` table, enforcing a primary key UUID, non-null trade name, unique taxpayer ID, structured JSONB contact details, and a database-level CHECK constraint on `status`.

#### Verified Code: `migrations/1794911942100_seller-application-review-lifecycle.js`

Create [migrations/1794911942100_seller-application-review-lifecycle.js](file:///Users/hossein/Projects/express-digikala/migrations/1794911942100_seller-application-review-lifecycle.js):

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
    -- Create third-party sellers table with lifecycle status and unique taxpayer ID
    CREATE TABLE IF NOT EXISTS sellers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      taxpayer_id VARCHAR(100) NOT NULL,
      contact JSONB NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending-review',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_sellers_taxpayer_id UNIQUE (taxpayer_id),
      CONSTRAINT chk_sellers_status CHECK (status IN ('pending-review', 'under-review', 'active', 'rejected'))
    );

    -- Indexes for querying by lifecycle status and created_at ordering
    CREATE INDEX IF NOT EXISTS idx_sellers_status ON sellers(status);
    CREATE INDEX IF NOT EXISTS idx_sellers_created_at ON sellers(created_at DESC);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS sellers;
  `);
};
```

#### Code Walkthrough

- `taxpayer_id VARCHAR(100) NOT NULL`: Stores the Iranian economic code or national identity number.
- `CONSTRAINT uq_sellers_taxpayer_id UNIQUE (taxpayer_id)`: Enforces database uniqueness. Prevents duplicate merchant entities from claiming the same tax identity.
- `contact JSONB NOT NULL`: Stores flexible contact information (telephone, mobile, email, physical warehouse address) without requiring schema migrations for new contact attributes.
- `idx_sellers_status`: B-tree index enabling operational staff to filter seller queues by status (`WHERE status = 'under-review'`) efficiently.

---

### Step 3: Pure Domain State Machine

#### Context & Purpose

Defines the valid seller status strings, the state transition lookup table, and pure functions to validate transitions without database or framework dependencies.

#### Verified Code: `src/modules/seller/domain/status-machine.ts`

Create [src/modules/seller/domain/status-machine.ts](file:///Users/hossein/Projects/express-digikala/src/modules/seller/domain/status-machine.ts):

```typescript
import { InvalidStateTransitionError } from '../../../errors.js';

export const SELLER_STATUSES = ['pending-review', 'under-review', 'active', 'rejected'] as const;

export type SellerStatus = (typeof SELLER_STATUSES)[number];

export function isValidSellerStatus(status: unknown): status is SellerStatus {
  return typeof status === 'string' && (SELLER_STATUSES as readonly string[]).includes(status);
}

export const ALLOWED_STATUS_TRANSITIONS: Record<SellerStatus, readonly SellerStatus[]> = {
  'pending-review': ['under-review'],
  'under-review': ['active', 'rejected'],
  active: [],
  rejected: [],
};

export function canTransitionSellerStatus(current: SellerStatus, next: SellerStatus): boolean {
  if (current === next) {
    return false;
  }
  const allowed = ALLOWED_STATUS_TRANSITIONS[current];
  return allowed.includes(next);
}

export function assertValidSellerTransition(current: SellerStatus, next: SellerStatus): void {
  if (!canTransitionSellerStatus(current, next)) {
    throw new InvalidStateTransitionError(
      `تغییر وضعیت فروشنده از '${current}' به '${next}' مجاز نمی‌باشد. مسیر مجاز: pending-review -> under-review -> active | rejected`,
    );
  }
}
```

#### Code Walkthrough

- `SELLER_STATUSES`: Read-only tuple of allowed statuses.
- `isValidSellerStatus`: User-defined type guard narrowing `unknown` to `SellerStatus`.
- `ALLOWED_STATUS_TRANSITIONS`: Explicit map defining legal forward progressions. Note that `active` and `rejected` have empty arrays, making them terminal in this ticket slice.
- `canTransitionSellerStatus`: Pure predicate returning `true` only if `next` is in `ALLOWED_STATUS_TRANSITIONS[current]`. Disallows no-op transitions (`current === next`).
- `assertValidSellerTransition`: Invariant assertion throwing `InvalidStateTransitionError` with a clear, Persian-language explanatory message.

---

### Step 4: Seller Module Types

#### Context & Purpose

Provides clean, decoupled TypeScript interfaces for domain entities, creation parameters, transition parameters, and database row mappings.

#### Verified Code: `src/modules/seller/types.ts`

Create [src/modules/seller/types.ts](file:///Users/hossein/Projects/express-digikala/src/modules/seller/types.ts):

```typescript
import type { SellerStatus } from './domain/status-machine.js';

export interface SellerContact {
  phone?: string;
  email?: string;
  address?: string;
  postalCode?: string;
  [key: string]: unknown;
}

export interface Seller {
  id: string;
  name: string;
  taxpayerId: string;
  contact: SellerContact;
  status: SellerStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SellerRow {
  id: string;
  name: string;
  taxpayer_id: string;
  contact: SellerContact;
  status: SellerStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateSellerParams {
  name: string;
  taxpayerId: string;
  contact: SellerContact;
}

export interface TransitionSellerStatusParams {
  sellerId: string;
  newStatus: SellerStatus;
  actorUserId: string;
  reason?: string | null | undefined;
}

export interface ListSellersFilter {
  status?: SellerStatus | undefined;
}
```

---

### Step 5: Deep Seller Service

#### Context & Purpose

The `SellerService` class serves as the deep module for all merchant operations. It encapsulates database queries, input validation, unique constraint error mapping, row locking, and transactional audit logging.

#### Verified Code: `src/modules/seller/service.ts`

Create [src/modules/seller/service.ts](file:///Users/hossein/Projects/express-digikala/src/modules/seller/service.ts):

```typescript
import type { Pool } from 'pg';
import { withTransaction } from '../../db/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import { recordAuditEvent } from '../audit/index.js';
import { assertValidSellerTransition, isValidSellerStatus } from './domain/status-machine.js';
import type {
  CreateSellerParams,
  ListSellersFilter,
  Seller,
  SellerRow,
  TransitionSellerStatusParams,
} from './types.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidUuid(id: string, fieldName: string = 'id'): void {
  if (!UUID_REGEX.test(id)) {
    throw new ValidationError('شناسه فروشنده نامعتبر است.', [
      { field: fieldName, message: 'شناسه فروشنده باید یک UUID معتبر باشد.' },
    ]);
  }
}

function mapSellerRow(row: SellerRow): Seller {
  return {
    id: row.id,
    name: row.name,
    taxpayerId: row.taxpayer_id,
    contact: row.contact,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class SellerService {
  constructor(private readonly pool: Pool) {}

  /**
   * Registers a third-party seller application in the initial 'pending-review' state.
   * Enforces unique taxpayer ID and validated contact information.
   */
  async createSeller(params: CreateSellerParams): Promise<Seller> {
    const name = params.name?.trim();
    if (!name) {
      throw new ValidationError('نام فروشنده الزامی است.', [
        { field: 'name', message: 'نام فروشنده الزامی است.' },
      ]);
    }

    const taxpayerId = params.taxpayerId?.trim();
    if (!taxpayerId) {
      throw new ValidationError('کد مالیاتی / شناسه ملی فروشنده الزامی است.', [
        { field: 'taxpayerId', message: 'کد مالیاتی / شناسه ملی فروشنده الزامی است.' },
      ]);
    }

    const contact = params.contact;
    if (
      !contact ||
      typeof contact !== 'object' ||
      Array.isArray(contact) ||
      Object.keys(contact).length === 0
    ) {
      throw new ValidationError('اطلاعات تماس فروشنده الزامی است.', [
        { field: 'contact', message: 'اطلاعات تماس فروشنده الزامی است.' },
      ]);
    }

    const query = `
      INSERT INTO sellers (name, taxpayer_id, contact, status)
      VALUES ($1, $2, $3, 'pending-review')
      RETURNING *;
    `;

    try {
      const result = await this.pool.query<SellerRow>(query, [
        name,
        taxpayerId,
        JSON.stringify(contact),
      ]);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Failed to create seller: No row returned from database');
      }
      return mapSellerRow(row);
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        throw new ConflictError('فروشنده‌ای با این کد مالیاتی قبلاً ثبت شده است.');
      }
      throw err;
    }
  }

  /**
   * Retrieves a seller record by its unique UUID.
   */
  async getSellerById(id: string): Promise<Seller | null> {
    assertValidUuid(id, 'id');

    const query = `
      SELECT *
      FROM sellers
      WHERE id = $1
      LIMIT 1;
    `;

    const result = await this.pool.query<SellerRow>(query, [id]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return mapSellerRow(row);
  }

  /**
   * Transitions a seller's lifecycle status through allowed state machine paths,
   * guaranteeing transactional atomicity between the status update and the append-only audit event.
   */
  async transitionSellerStatus(params: TransitionSellerStatusParams): Promise<Seller> {
    const { sellerId, newStatus, actorUserId, reason } = params;

    assertValidUuid(sellerId, 'id');

    if (!isValidSellerStatus(newStatus)) {
      throw new ValidationError(`وضعیت جدید '${newStatus}' نامعتبر است.`, [
        { field: 'status', message: `وضعیت باید یکی از مقادیر مجاز باشد.` },
      ]);
    }

    return withTransaction(this.pool, async (client) => {
      // Lock row for update within the transaction boundary
      const selectQuery = `
        SELECT *
        FROM sellers
        WHERE id = $1
        FOR UPDATE;
      `;
      const selectRes = await client.query<SellerRow>(selectQuery, [sellerId]);
      const currentRow = selectRes.rows[0];

      if (!currentRow) {
        throw new NotFoundError('فروشنده‌ای با شناسه مورد نظر یافت نشد.');
      }

      // Enforce domain state machine invariants
      assertValidSellerTransition(currentRow.status, newStatus);

      // Mutate status and update timestamp
      const updateQuery = `
        UPDATE sellers
        SET status = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *;
      `;
      const updateRes = await client.query<SellerRow>(updateQuery, [newStatus, sellerId]);
      const updatedRow = updateRes.rows[0];

      if (!updatedRow) {
        throw new Error('Failed to update seller status: No row returned');
      }

      // Record immutable audit event in the same transaction
      await recordAuditEvent(client, {
        actorType: 'user',
        actorId: actorUserId,
        action: 'seller.status_transition',
        entityType: 'seller',
        entityId: sellerId,
        previousValue: { status: currentRow.status },
        newValue: { status: newStatus },
        reason: reason ?? null,
      });

      return mapSellerRow(updatedRow);
    });
  }

  /**
   * Lists sellers, optionally filtered by status, ordered by creation date descending.
   */
  async listSellers(filter?: ListSellersFilter): Promise<Seller[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.status) {
      if (!isValidSellerStatus(filter.status)) {
        throw new ValidationError(`وضعیت فیلتر '${filter.status}' نامعتبر است.`, [
          { field: 'status', message: 'وضعیت باید یکی از مقادیر مجاز باشد.' },
        ]);
      }
      values.push(filter.status);
      conditions.push(`status = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `
      SELECT *
      FROM sellers
      ${whereClause}
      ORDER BY created_at DESC;
    `;

    const result = await this.pool.query<SellerRow>(query, values);
    return result.rows.map(mapSellerRow);
  }
}
```

#### Code Walkthrough

- `createSeller`: Trims strings, verifies structured contact information, inserts the row defaulting to `pending-review`, and maps PostgreSQL error `23505` to a clean `ConflictError`.
- `getSellerById`: Validates the UUID format using `assertValidUuid` before querying PostgreSQL, returning `null` if no record matches.
- `transitionSellerStatus`: Uses `withTransaction` to wrap `SELECT ... FOR UPDATE`, `assertValidSellerTransition`, `UPDATE sellers`, and `recordAuditEvent` in a single ACID transaction. If audit writing fails, the status update is rolled back automatically.
- `listSellers`: Dynamically constructs the SQL query with parameterized bindings (`$1`), avoiding string concatenation while eliminating duplicated mapping logic.

---

### Step 6: Express Admin Router

#### Context & Purpose

Exposes administrative endpoints under `/api/v1/admin/sellers`. Enforces authentication and `seller-mgmt` RBAC, extracts request parameters, calls `SellerService`, and handles error propagation via Express middleware.

#### Verified Code: `src/modules/seller/routes.ts`

Create [src/modules/seller/routes.ts](file:///Users/hossein/Projects/express-digikala/src/modules/seller/routes.ts):

```typescript
import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { SellerService } from './service.js';
import { requireRole } from '../../middleware/auth.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../errors.js';
import type { InternalSessionUser } from '../identity/service.js';
import type { SellerStatus } from './domain/status-machine.js';

function parseSellerId(req: Request): string {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    throw new ValidationError('شناسه فروشنده الزامی است.', [
      { field: 'id', message: 'شناسه فروشنده الزامی است.' },
    ]);
  }
  return id;
}

export function createSellerAdminRouter(
  sellerService: SellerService,
  requireInternalAuth: RequestHandler,
): Router {
  const router = Router();

  // Protect all seller management routes with internal auth and 'seller-mgmt' role
  router.use(requireInternalAuth, requireRole('seller-mgmt'));

  // POST /api/v1/admin/sellers
  router.post('/', async (req: Request, res: Response, next) => {
    try {
      const { name, taxpayerId, contact } = req.body ?? {};
      const seller = await sellerService.createSeller({
        name,
        taxpayerId,
        contact,
      });

      res.status(201).json({
        status: 'ok',
        seller,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/sellers
  router.get('/', async (req: Request, res: Response, next) => {
    try {
      const rawStatus = req.query['status'];
      const statusParam =
        typeof rawStatus === 'string' ? (rawStatus.trim() as SellerStatus) : undefined;

      const sellers = await sellerService.listSellers(
        statusParam ? { status: statusParam } : undefined,
      );

      res.status(200).json({
        status: 'ok',
        group: 'seller-mgmt',
        sellers,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/sellers/:id
  router.get('/:id', async (req: Request, res: Response, next) => {
    try {
      const id = parseSellerId(req);

      const seller = await sellerService.getSellerById(id);
      if (!seller) {
        throw new NotFoundError('فروشنده‌ای با شناسه مورد نظر یافت نشد.');
      }

      res.status(200).json({
        status: 'ok',
        seller,
      });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/v1/admin/sellers/:id/status
  router.patch('/:id/status', async (req: Request, res: Response, next) => {
    try {
      const id = parseSellerId(req);

      const { status: newStatus, reason } = req.body ?? {};
      if (!newStatus) {
        throw new ValidationError('فیلد status الزامی است.', [
          { field: 'status', message: 'فیلد status الزامی است.' },
        ]);
      }

      const internalUser = req.internalUser ?? (req.user as InternalSessionUser | undefined);
      if (!internalUser) {
        throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
      }

      const updatedSeller = await sellerService.transitionSellerStatus({
        sellerId: id,
        newStatus,
        actorUserId: internalUser.id,
        reason: typeof reason === 'string' ? reason.trim() : null,
      });

      res.status(200).json({
        status: 'ok',
        seller: updatedSeller,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

#### Code Walkthrough

- `router.use(requireInternalAuth, requireRole('seller-mgmt'))`: Enforces that any caller must be an authenticated internal operator with an active MFA session and the `seller-mgmt` role.
- `POST /`: Validates the payload and returns HTTP 201 Created with the new seller in `pending-review` status.
- `GET /`: Extracts the optional `status` query parameter and returns HTTP 200 with `{ status: 'ok', group: 'seller-mgmt', sellers: [...] }`, satisfying both the ticket requirement and backward compatibility with RBAC group tests.
- `GET /:id`: Retrieves the seller record by ID, throwing a 404 `NotFoundError` if not found.
- `PATCH /:id/status`: Extracts `newStatus` and `reason`, validates that the operational user is present, and coordinates the status transition.

---

### Step 7: Module Facade

#### Context & Purpose

Exports the public interface of the `seller` module. External modules and application roots import only from this file.

#### Verified Code: `src/modules/seller/index.ts`

Create [src/modules/seller/index.ts](file:///Users/hossein/Projects/express-digikala/src/modules/seller/index.ts):

```typescript
export * from './domain/status-machine.js';
export * from './types.js';
export * from './service.js';
export * from './routes.js';
```

---

### Step 8: Decoupled Operational Placeholders in Identity Routes

#### Context & Purpose

In [src/modules/identity/routes.ts](file:///Users/hossein/Projects/express-digikala/src/modules/identity/routes.ts), remove `/sellers` from the generic placeholder array. Identity remains focused entirely on user and access administration.

#### Verified Code: `src/modules/identity/routes.ts`

Update lines 220-235 of [src/modules/identity/routes.ts](file:///Users/hossein/Projects/express-digikala/src/modules/identity/routes.ts):

```typescript
  // Operational Route Groups (catalog, order-ops, support, finance)
  const operationalGroups: Array<{ path: string; role: OperationalRole }> = [
    { path: '/catalog', role: 'catalog' },
    { path: '/orders', role: 'order-ops' },
    { path: '/support', role: 'support' },
    { path: '/finance', role: 'finance' },
  ];

  for (const group of operationalGroups) {
    const groupRouter = Router();
    groupRouter.use(requireInternalAuth, requireRole(group.role));
    groupRouter.get('/', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', group: group.role });
    });
    router.use(group.path, groupRouter);
  }

  return router;
}
```

---

### Step 9: Application Composition Root

#### Context & Purpose

Wired in [src/app.ts](file:///Users/hossein/Projects/express-digikala/src/app.ts). Creates the `SellerService` instance using `deps.pool` and mounts `createSellerAdminRouter` directly at `/api/v1/admin/sellers`.

#### Verified Code: `src/app.ts`

Update [src/app.ts](file:///Users/hossein/Projects/express-digikala/src/app.ts):

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
import { SellerService } from './modules/seller/service.js';
import { createSellerAdminRouter } from './modules/seller/routes.js';

export interface AppDependencies {
  pool: Pool;
  config: AppConfig;
  smsSender?: SmsSenderPort;
  sellerService?: SellerService;
}

export interface AppContext {
  app: Express;
  identityService: IdentityService;
  sellerService: SellerService;
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
  const sellerService = deps.sellerService ?? new SellerService(deps.pool);

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
  const sellerRouter = createSellerAdminRouter(sellerService, requireInternalAuth);
  adminRouter.use('/sellers', sellerRouter);
  app.use('/api/v1/admin', adminRouter);

  // Global structured error handler
  app.use(errorHandler);

  return {
    app,
    identityService,
    sellerService,
    smsSender,
  };
}
```

---

## 5. Verification & Testing (TDD Walkthrough)

### Seam & Test Strategy

We verify the implementation across three distinct, rigorously isolated seams:

1. **Pure Domain Unit Seam (`tests/unit/seller-lifecycle.test.ts`):** Tests `assertValidSellerTransition` and `canTransitionSellerStatus` in memory across all permutation states. Verifies that illegal horizontal jumps, backwards jumps, terminal transitions, and no-op transitions throw `InvalidStateTransitionError`.
2. **Service & Transactional Seam (`tests/integration/seller-service.test.ts`):** Tests `SellerService` directly against a real PostgreSQL instance. Verifies unique taxpayer ID handling (409 Conflict), row locking (`FOR UPDATE`), and exact audit event payload persistence.
3. **HTTP API & RBAC Seam (`tests/integration/seller-lifecycle-api.test.ts`):** End-to-end integration tests using Supertest. Verifies that requests lacking `seller-mgmt` or with unverified MFA are rejected with 403, and tests the complete lifecycle progression from HTTP request to database audit verification.

---

### Verified Test Code: Unit Tests (`tests/unit/seller-lifecycle.test.ts`)

```typescript
import { describe, expect, it } from 'vitest';
import {
  SELLER_STATUSES,
  assertValidSellerTransition,
  canTransitionSellerStatus,
  isValidSellerStatus,
  type SellerStatus,
} from '../../src/modules/seller/domain/status-machine.js';
import { InvalidStateTransitionError } from '../../src/errors.js';

describe('Seller Lifecycle State Machine (Unit)', () => {
  describe('Status definitions and type guard', () => {
    it('defines exactly the 4 allowed statuses in the MVP lifecycle', () => {
      expect(SELLER_STATUSES).toEqual(['pending-review', 'under-review', 'active', 'rejected']);
    });

    it('validates known statuses and rejects invalid strings', () => {
      expect(isValidSellerStatus('pending-review')).toBe(true);
      expect(isValidSellerStatus('under-review')).toBe(true);
      expect(isValidSellerStatus('active')).toBe(true);
      expect(isValidSellerStatus('rejected')).toBe(true);

      expect(isValidSellerStatus('suspended')).toBe(false);
      expect(isValidSellerStatus('unknown')).toBe(false);
      expect(isValidSellerStatus('')).toBe(false);
    });
  });

  describe('Allowed transitions', () => {
    it('allows pending-review -> under-review', () => {
      expect(canTransitionSellerStatus('pending-review', 'under-review')).toBe(true);
      expect(() => assertValidSellerTransition('pending-review', 'under-review')).not.toThrow();
    });

    it('allows under-review -> active', () => {
      expect(canTransitionSellerStatus('under-review', 'active')).toBe(true);
      expect(() => assertValidSellerTransition('under-review', 'active')).not.toThrow();
    });

    it('allows under-review -> rejected', () => {
      expect(canTransitionSellerStatus('under-review', 'rejected')).toBe(true);
      expect(() => assertValidSellerTransition('under-review', 'rejected')).not.toThrow();
    });
  });

  describe('Forbidden transitions', () => {
    it('forbids direct jump from pending-review to active', () => {
      expect(canTransitionSellerStatus('pending-review', 'active')).toBe(false);
      expect(() => assertValidSellerTransition('pending-review', 'active')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids direct jump from pending-review to rejected', () => {
      expect(canTransitionSellerStatus('pending-review', 'rejected')).toBe(false);
      expect(() => assertValidSellerTransition('pending-review', 'rejected')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids backward transition from under-review to pending-review', () => {
      expect(canTransitionSellerStatus('under-review', 'pending-review')).toBe(false);
      expect(() => assertValidSellerTransition('under-review', 'pending-review')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('forbids transitions out of terminal active state in this ticket lifecycle', () => {
      const targets: SellerStatus[] = ['pending-review', 'under-review', 'rejected'];
      for (const target of targets) {
        expect(canTransitionSellerStatus('active', target)).toBe(false);
        expect(() => assertValidSellerTransition('active', target)).toThrow(
          InvalidStateTransitionError,
        );
      }
    });

    it('forbids transitions out of terminal rejected state', () => {
      const targets: SellerStatus[] = ['pending-review', 'under-review', 'active'];
      for (const target of targets) {
        expect(canTransitionSellerStatus('rejected', target)).toBe(false);
        expect(() => assertValidSellerTransition('rejected', target)).toThrow(
          InvalidStateTransitionError,
        );
      }
    });

    it('forbids identical state transitions (no-op transitions)', () => {
      for (const status of SELLER_STATUSES) {
        expect(canTransitionSellerStatus(status, status)).toBe(false);
        expect(() => assertValidSellerTransition(status, status)).toThrow(
          InvalidStateTransitionError,
        );
      }
    });
  });
});
```

---

### Verified Test Code: Service Integration Tests (`tests/integration/seller-service.test.ts`)

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { SellerService } from '../../src/modules/seller/service.js';
import { findAuditEventsByEntity } from '../../src/modules/audit/index.js';
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from '../../src/errors.js';

describe('SellerService (Integration)', () => {
  let pool: Pool;
  let sellerService: SellerService;

  beforeAll(async () => {
    const config = loadConfig({}, { loadDotenv: false });
    pool = createDbPool({ connectionString: config.testDatabaseUrl });
    sellerService = new SellerService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM sellers');
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_accounts');
  });

  describe('createSeller', () => {
    it('creates a seller application in pending-review state', async () => {
      const seller = await sellerService.createSeller({
        name: 'دیجی‌کالا فوت‌ویر',
        taxpayerId: '10100998877',
        contact: {
          phone: '09121112233',
          email: 'footwear@seller.ir',
          address: 'تهران، خیابان آزادی',
        },
      });

      expect(seller.id).toBeDefined();
      expect(seller.name).toBe('دیجی‌کالا فوت‌ویر');
      expect(seller.taxpayerId).toBe('10100998877');
      expect(seller.status).toBe('pending-review');
      expect(seller.contact).toEqual({
        phone: '09121112233',
        email: 'footwear@seller.ir',
        address: 'تهران، خیابان آزادی',
      });
      expect(seller.createdAt).toBeInstanceOf(Date);
      expect(seller.updatedAt).toBeInstanceOf(Date);

      // Verify row in database
      const rowRes = await pool.query('SELECT * FROM sellers WHERE id = $1', [seller.id]);
      expect(rowRes.rows).toHaveLength(1);
      expect(rowRes.rows[0].status).toBe('pending-review');
    });

    it('rejects duplicate taxpayer ID with ConflictError (409)', async () => {
      await sellerService.createSeller({
        name: 'فروشگاه الف',
        taxpayerId: '10100000001',
        contact: { phone: '09121110001' },
      });

      await expect(
        sellerService.createSeller({
          name: 'فروشگاه ب با همان کد مالیاتی',
          taxpayerId: '10100000001',
          contact: { phone: '09121110002' },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('validates required fields: name, taxpayerId, contact', async () => {
      await expect(
        sellerService.createSeller({
          name: '',
          taxpayerId: '10100000002',
          contact: { phone: '09121110002' },
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        sellerService.createSeller({
          name: 'فروشگاه بدون کد مالیاتی',
          taxpayerId: '   ',
          contact: { phone: '09121110002' },
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('transitionSellerStatus and Audit Trail integration', () => {
    it('executes full review lifecycle: pending-review -> under-review -> active and records audit events', async () => {
      const seller = await sellerService.createSeller({
        name: 'آرمان تجارت پارس',
        taxpayerId: '14008765432',
        contact: { phone: '09123334455' },
      });

      const actorUserId = '00000000-0000-0000-0000-000000000001';

      // 1. Transition: pending-review -> under-review
      const underReviewSeller = await sellerService.transitionSellerStatus({
        sellerId: seller.id,
        newStatus: 'under-review',
        actorUserId,
        reason: 'تکمیل مدارک هویتی و ثبت در کارتابل بررسی',
      });

      expect(underReviewSeller.status).toBe('under-review');

      let auditEvents = await findAuditEventsByEntity(pool, 'seller', seller.id);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.actorType).toBe('user');
      expect(auditEvents[0]!.actorId).toBe(actorUserId);
      expect(auditEvents[0]!.action).toBe('seller.status_transition');
      expect(auditEvents[0]!.previousValue).toEqual({ status: 'pending-review' });
      expect(auditEvents[0]!.newValue).toEqual({ status: 'under-review' });
      expect(auditEvents[0]!.reason).toBe('تکمیل مدارک هویتی و ثبت در کارتابل بررسی');

      // 2. Transition: under-review -> active
      const activeSeller = await sellerService.transitionSellerStatus({
        sellerId: seller.id,
        newStatus: 'active',
        actorUserId,
        reason: 'تأیید نهایی مدارک بانکی و مالیاتی فروشنده',
      });

      expect(activeSeller.status).toBe('active');

      auditEvents = await findAuditEventsByEntity(pool, 'seller', seller.id);
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]!.actorType).toBe('user');
      expect(auditEvents[1]!.actorId).toBe(actorUserId);
      expect(auditEvents[1]!.action).toBe('seller.status_transition');
      expect(auditEvents[1]!.previousValue).toEqual({ status: 'under-review' });
      expect(auditEvents[1]!.newValue).toEqual({ status: 'active' });
      expect(auditEvents[1]!.reason).toBe('تأیید نهایی مدارک بانکی و مالیاتی فروشنده');
    });

    it('executes rejection lifecycle: pending-review -> under-review -> rejected with audit event', async () => {
      const seller = await sellerService.createSeller({
        name: 'پارس گسترش نوین',
        taxpayerId: '14001234567',
        contact: { phone: '09124445566' },
      });

      const actorUserId = '00000000-0000-0000-0000-000000000002';

      await sellerService.transitionSellerStatus({
        sellerId: seller.id,
        newStatus: 'under-review',
        actorUserId,
      });

      const rejectedSeller = await sellerService.transitionSellerStatus({
        sellerId: seller.id,
        newStatus: 'rejected',
        actorUserId,
        reason: 'عدم تطابق مدارک مالیاتی با کد ملی',
      });

      expect(rejectedSeller.status).toBe('rejected');

      const auditEvents = await findAuditEventsByEntity(pool, 'seller', seller.id);
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]!.newValue).toEqual({ status: 'rejected' });
      expect(auditEvents[1]!.reason).toBe('عدم تطابق مدارک مالیاتی با کد ملی');
    });

    it('rejects invalid transition attempts and does not record an audit event', async () => {
      const seller = await sellerService.createSeller({
        name: 'تست انتقال نامعتبر',
        taxpayerId: '10109999999',
        contact: { phone: '09127778899' },
      });

      const actorUserId = '00000000-0000-0000-0000-000000000003';

      // Cannot jump pending-review -> active directly
      await expect(
        sellerService.transitionSellerStatus({
          sellerId: seller.id,
          newStatus: 'active',
          actorUserId,
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Verify seller status remained pending-review
      const current = await sellerService.getSellerById(seller.id);
      expect(current?.status).toBe('pending-review');

      // Verify no audit event was created
      const auditEvents = await findAuditEventsByEntity(pool, 'seller', seller.id);
      expect(auditEvents).toHaveLength(0);
    });

    it('throws NotFoundError when transitioning a non-existent seller', async () => {
      await expect(
        sellerService.transitionSellerStatus({
          sellerId: '00000000-0000-0000-0000-000000000099',
          newStatus: 'under-review',
          actorUserId: '00000000-0000-0000-0000-000000000001',
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('listSellers and getSellerById', () => {
    it('lists sellers and filters by status', async () => {
      const s1 = await sellerService.createSeller({
        name: 'فروشنده یک',
        taxpayerId: '10000000001',
        contact: { phone: '09120000001' },
      });
      const s2 = await sellerService.createSeller({
        name: 'فروشنده دو',
        taxpayerId: '10000000002',
        contact: { phone: '09120000002' },
      });

      await sellerService.transitionSellerStatus({
        sellerId: s2.id,
        newStatus: 'under-review',
        actorUserId: '00000000-0000-0000-0000-000000000001',
      });

      const all = await sellerService.listSellers();
      expect(all).toHaveLength(2);

      const pendingList = await sellerService.listSellers({ status: 'pending-review' });
      expect(pendingList).toHaveLength(1);
      expect(pendingList[0]!.id).toBe(s1.id);

      const underReviewList = await sellerService.listSellers({ status: 'under-review' });
      expect(underReviewList).toHaveLength(1);
      expect(underReviewList[0]!.id).toBe(s2.id);

      const activeList = await sellerService.listSellers({ status: 'active' });
      expect(activeList).toHaveLength(0);
    });

    it('returns full record on getSellerById', async () => {
      const created = await sellerService.createSeller({
        name: 'فروشگاه کامل',
        taxpayerId: '10000000099',
        contact: { phone: '09129990000', email: 'full@seller.ir' },
      });

      const found = await sellerService.getSellerById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe('فروشگاه کامل');
      expect(found?.taxpayerId).toBe('10000000099');
      expect(found?.contact).toEqual({ phone: '09129990000', email: 'full@seller.ir' });
    });

    it('returns null for non-existent seller id', async () => {
      const found = await sellerService.getSellerById('00000000-0000-0000-0000-000000000099');
      expect(found).toBeNull();
    });
  });
});
```

---

### Verified Test Code: HTTP API Integration Tests (`tests/integration/seller-lifecycle-api.test.ts`)

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import type { Express } from 'express';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createApp } from '../../src/app.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';
import { findAuditEventsByEntity } from '../../src/modules/audit/index.js';
import type { OperationalRole } from '../../src/modules/identity/domain/roles.js';

describe('Seller Application & Review Lifecycle API (Integration)', () => {
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
        jwtSecret: 'test-seller-secret-key-that-is-long-enough',
        otpTtlSeconds: 120,
        otpRateLimitMaxAttempts: 5,
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
    await pool.query('DELETE FROM sellers');
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_invites');
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');
    smsSender.clear();
  });

  async function createVerifiedUser(
    email: string,
    phone: string,
    roles: OperationalRole[],
  ): Promise<{ sessionToken: string; userId: string }> {
    const userRes = await pool.query<{ id: string }>(
      `
      INSERT INTO user_accounts (email, phone, roles, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING id;
      `,
      [email, phone, roles],
    );
    const userId = userRes.rows[0]!.id;

    const tokenRes = await pool.query<{ session_token: string }>(
      `
      INSERT INTO internal_sessions (user_id, session_token, mfa_verified, expires_at)
      VALUES ($1, md5(random()::text), TRUE, NOW() + INTERVAL '1 hour')
      RETURNING session_token;
      `,
      [userId],
    );

    return {
      sessionToken: tokenRes.rows[0]!.session_token,
      userId,
    };
  }

  describe('Authentication and RBAC boundaries', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/v1/admin/sellers');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects requests from operational users without seller-mgmt role with 403 FORBIDDEN', async () => {
      const catalogUser = await createVerifiedUser('catalog@marketplace.ir', '+989121110011', [
        'catalog',
      ]);

      const res = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${catalogUser.sessionToken}`)
        .send({
          name: 'فروشگاه تستی',
          taxpayerId: '10109990001',
          contact: { phone: '09120001122' },
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('rejects requests with unverified MFA with 403 MFA_REQUIRED', async () => {
      const userRes = await pool.query<{ id: string }>(
        `
        INSERT INTO user_accounts (email, phone, roles, status)
        VALUES ('unverified.seller@marketplace.ir', '+989121110022', ARRAY['seller-mgmt'], 'active')
        RETURNING id;
        `,
      );
      const userId = userRes.rows[0]!.id;

      const unverifiedToken = 'seller-unverified-mfa-token';
      await pool.query(
        `
        INSERT INTO internal_sessions (user_id, session_token, mfa_verified, expires_at)
        VALUES ($1, $2, FALSE, NOW() + INTERVAL '1 hour');
        `,
        [userId, unverifiedToken],
      );

      const res = await request(app)
        .get('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${unverifiedToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MFA_REQUIRED');
    });
  });

  describe('POST /api/v1/admin/sellers', () => {
    it('creates a new seller application in pending-review state', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110033', [
        'seller-mgmt',
      ]);

      const payload = {
        name: 'پارس الکترونیک خاورمیانه',
        taxpayerId: '14009876543',
        contact: {
          phone: '09121234567',
          email: 'contact@parselectronic.ir',
          address: 'تهران، خیابان جمهوری',
        },
      };

      const res = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('ok');
      expect(res.body.seller).toBeDefined();
      expect(res.body.seller.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(res.body.seller.name).toBe(payload.name);
      expect(res.body.seller.taxpayerId).toBe(payload.taxpayerId);
      expect(res.body.seller.status).toBe('pending-review');
      expect(res.body.seller.contact).toEqual(payload.contact);
    });

    it('rejects duplicate taxpayerId with 409 Conflict', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110034', [
        'seller-mgmt',
      ]);

      const payload = {
        name: 'فروشگاه آلفا',
        taxpayerId: '10105554433',
        contact: { phone: '09123332211' },
      };

      const res1 = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send(payload);
      expect(res1.status).toBe(201);

      const res2 = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه بتا با کد تکراری',
          taxpayerId: '10105554433',
          contact: { phone: '09123332222' },
        });

      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe('CONFLICT');
    });

    it('validates required fields with 400 VALIDATION_ERROR', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110035', [
        'seller-mgmt',
      ]);

      const res = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: '',
          taxpayerId: '',
          contact: {},
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.fieldErrors).toBeDefined();
    });
  });

  describe('PATCH /api/v1/admin/sellers/:id/status and Audit Trail', () => {
    it('moves seller through allowed lifecycle: pending-review -> under-review -> active and logs audit per transition', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110036', [
        'seller-mgmt',
      ]);

      // Create seller
      const createRes = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه دیجیتال آریا',
          taxpayerId: '14002233445',
          contact: { phone: '09128889900' },
        });

      expect(createRes.status).toBe(201);
      const sellerId = createRes.body.seller.id;

      // Transition 1: pending-review -> under-review
      const underReviewRes = await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          status: 'under-review',
          reason: 'شروع بررسی مدارک ثبتی و شماره شبا',
        });

      expect(underReviewRes.status).toBe(200);
      expect(underReviewRes.body.status).toBe('ok');
      expect(underReviewRes.body.seller.status).toBe('under-review');

      // Verify audit event 1
      let auditEvents = await findAuditEventsByEntity(pool, 'seller', sellerId);
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.actorType).toBe('user');
      expect(auditEvents[0]!.actorId).toBe(sellerStaff.userId);
      expect(auditEvents[0]!.action).toBe('seller.status_transition');
      expect(auditEvents[0]!.previousValue).toEqual({ status: 'pending-review' });
      expect(auditEvents[0]!.newValue).toEqual({ status: 'under-review' });
      expect(auditEvents[0]!.reason).toBe('شروع بررسی مدارک ثبتی و شماره شبا');

      // Transition 2: under-review -> active
      const activeRes = await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          status: 'active',
          reason: 'تأیید قرارداد و فعال‌سازی فروشنده در مارکت‌پلیس',
        });

      expect(activeRes.status).toBe(200);
      expect(activeRes.body.seller.status).toBe('active');

      // Verify audit event 2
      auditEvents = await findAuditEventsByEntity(pool, 'seller', sellerId);
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]!.actorType).toBe('user');
      expect(auditEvents[1]!.actorId).toBe(sellerStaff.userId);
      expect(auditEvents[1]!.action).toBe('seller.status_transition');
      expect(auditEvents[1]!.previousValue).toEqual({ status: 'under-review' });
      expect(auditEvents[1]!.newValue).toEqual({ status: 'active' });
      expect(auditEvents[1]!.reason).toBe('تأیید قرارداد و فعال‌سازی فروشنده در مارکت‌پلیس');
    });

    it('rejects invalid state transition attempts with 400 INVALID_STATE_TRANSITION', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110037', [
        'seller-mgmt',
      ]);

      const createRes = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه جهش نامعتبر',
          taxpayerId: '14003344556',
          contact: { phone: '09121112244' },
        });

      const sellerId = createRes.body.seller.id;

      // Attempt illegal jump from pending-review directly to active
      const res = await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          status: 'active',
          reason: 'جهش غیرمجاز مستقیم به فعال',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');

      // Verify no audit event was logged
      const auditEvents = await findAuditEventsByEntity(pool, 'seller', sellerId);
      expect(auditEvents).toHaveLength(0);
    });

    it('supports rejection: under-review -> rejected', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110038', [
        'seller-mgmt',
      ]);

      const createRes = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه رد صلاحیت',
          taxpayerId: '14005566778',
          contact: { phone: '09129995544' },
        });

      const sellerId = createRes.body.seller.id;

      // First move to under-review
      await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({ status: 'under-review' });

      // Then reject
      const rejectRes = await request(app)
        .patch(`/api/v1/admin/sellers/${sellerId}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          status: 'rejected',
          reason: 'عدم تطابق صنف فعالیت با مجوزهای صنفی',
        });

      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.seller.status).toBe('rejected');

      const auditEvents = await findAuditEventsByEntity(pool, 'seller', sellerId);
      expect(auditEvents).toHaveLength(2);
      expect(auditEvents[1]!.newValue).toEqual({ status: 'rejected' });
    });

    it('returns 404 NOT_FOUND when transitioning non-existent seller', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110039', [
        'seller-mgmt',
      ]);

      const res = await request(app)
        .patch('/api/v1/admin/sellers/00000000-0000-0000-0000-000000000099/status')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({ status: 'under-review' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/admin/sellers and GET /api/v1/admin/sellers/:id', () => {
    it('lists sellers and filters by state', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110040', [
        'seller-mgmt',
      ]);

      // Create two sellers
      const s1 = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشنده لیست یک',
          taxpayerId: '19000000001',
          contact: { phone: '09120000011' },
        });

      const s2 = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشنده لیست دو',
          taxpayerId: '19000000002',
          contact: { phone: '09120000022' },
        });

      // Move s2 to under-review
      await request(app)
        .patch(`/api/v1/admin/sellers/${s2.body.seller.id}/status`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({ status: 'under-review' });

      // List all
      const listAllRes = await request(app)
        .get('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(listAllRes.status).toBe(200);
      expect(listAllRes.body.status).toBe('ok');
      expect(listAllRes.body.group).toBe('seller-mgmt');
      expect(listAllRes.body.sellers).toHaveLength(2);

      // Filter by pending-review
      const pendingRes = await request(app)
        .get('/api/v1/admin/sellers?status=pending-review')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.sellers).toHaveLength(1);
      expect(pendingRes.body.sellers[0].id).toBe(s1.body.seller.id);

      // Filter by under-review
      const underReviewRes = await request(app)
        .get('/api/v1/admin/sellers?status=under-review')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(underReviewRes.status).toBe(200);
      expect(underReviewRes.body.sellers).toHaveLength(1);
      expect(underReviewRes.body.sellers[0].id).toBe(s2.body.seller.id);
    });

    it('returns full seller record by id', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110041', [
        'seller-mgmt',
      ]);

      const createRes = await request(app)
        .post('/api/v1/admin/sellers')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`)
        .send({
          name: 'فروشگاه جزئیات کامل',
          taxpayerId: '19000000099',
          contact: { phone: '09123334466', email: 'detail@seller.ir' },
        });

      const sellerId = createRes.body.seller.id;

      const getRes = await request(app)
        .get(`/api/v1/admin/sellers/${sellerId}`)
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.status).toBe('ok');
      expect(getRes.body.seller.id).toBe(sellerId);
      expect(getRes.body.seller.name).toBe('فروشگاه جزئیات کامل');
      expect(getRes.body.seller.taxpayerId).toBe('19000000099');
      expect(getRes.body.seller.contact).toEqual({
        phone: '09123334466',
        email: 'detail@seller.ir',
      });
    });

    it('returns 404 for non-existent seller id', async () => {
      const sellerStaff = await createVerifiedUser('seller.ops@marketplace.ir', '+989121110042', [
        'seller-mgmt',
      ]);

      const getRes = await request(app)
        .get('/api/v1/admin/sellers/00000000-0000-0000-0000-000000000099')
        .set('Authorization', `Bearer ${sellerStaff.sessionToken}`);

      expect(getRes.status).toBe(404);
      expect(getRes.body.code).toBe('NOT_FOUND');
    });
  });
});
```

---

### How to Verify Locally

Run the test suite commands in your terminal:

```bash
# 1. Run database migrations
npm run migrate:up

# 2. Typecheck TypeScript across all files
npm run typecheck

# 3. Run unit tests for the seller status machine
npm run test:unit tests/unit/seller-lifecycle.test.ts

# 4. Run integration tests for the service and HTTP endpoints
npm run test:integration tests/integration/seller-service.test.ts tests/integration/seller-lifecycle-api.test.ts

# 5. Run full test suite
npm test
```

---

### Acceptance Checklist

- [x] `POST /api/v1/admin/sellers` (seller-mgmt role) creates a seller application in `pending-review` state
- [x] `PATCH /api/v1/admin/sellers/:id/status` transitions state through the allowed path: `pending-review → under-review → active | rejected`; invalid transitions rejected
- [x] Seller record stores identity fields (name, taxpayer ID, contact); taxpayer ID unique
- [x] Every status transition produces an audit event (actor, previous state, new state, reason)
- [x] `GET /api/v1/admin/sellers` lists sellers filterable by state; `GET /api/v1/admin/sellers/:id` returns full record
- [x] Integration tests cover full lifecycle, invalid transition attempt, and audit entry per transition
