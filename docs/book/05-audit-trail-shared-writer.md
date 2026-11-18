# Chapter 05: Audit Trail Shared Writer

## 1. The Goal & Big Picture

### What We Are Building

In this chapter, we implement a foundational **Append-Only Audit Trail** and a shared **Audit Writer Module** (`recordAuditEvent`) that serves as the single immutable record of truth across all modules in our Iranian e-commerce marketplace platform.

In an enterprise marketplace operating in Iran under the regulatory frameworks of the Electronic Commerce Law (*قانون تجارت الکترونیکی*), consumer protection mandates (*حمایت از حقوق مصرف‌کننده*), and tax compliance directives (*سازمان امور مالیاتی*), every operational and state transition carries legal, financial, and contractual weight:

- When an operational user approves, suspends, or reinstates a third-party seller.
- When catalog managers override product attributes or match seller offers to variants.
- When an order changes state, reservations are released, or parcels are handed to shipping carriers.
- When customer support adjusts an order address or grants an out-of-policy financial refund.
- When finance officers disburse weekly merchant settlements.

Allowing direct modifications (`UPDATE`) or deletions (`DELETE`) on audit logs undermines the integrity of the entire platform. If a rogue operator, compromised credential, or system defect could alter or delete historical records, dispute resolution and financial reconciliation become impossible.

To guarantee tamper-proof historical traceability, we deliver:

1. **`audit_events` Schema & Immutability at the Database Engine Level:** An append-only relational table in PostgreSQL that stores the timestamp, actor identity (`system` or `user`), action verb, target entity, structured previous/new values (via `JSONB`), mandatory or optional reason string, and linked event identifiers.
2. **Statement-Level Mutation & Truncation Denial Triggers:** PostgreSQL database triggers (`BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` executed `FOR EACH STATEMENT`) that raise relational exceptions (`ERRCODE = '23506'`), mathematically rendering the table immutable from any database client or SQL session.
3. **Deep Audit Writer Utility (`recordAuditEvent`):** A high-leverage function that acts as the only sanctioned write path to the audit table, enforcing domain invariants, JSON serialization, and actor validation.
4. **Guaranteed Transactional Atomicity (`withTransaction`):** An infrastructure transaction helper ensuring that domain entity state changes and their corresponding audit trail events are committed together in the same database transaction—or rolled back entirely if any failure occurs.
5. **Append-Only Corrective Event Model:** A design pattern where human or system corrections never overwrite historical rows; instead, corrective events are appended as brand-new events referencing the original via `linked_event_id`.

---

### Where It Fits

Audit trail recording is not an isolated business silo; it is a **shared cross-cutting capability** positioned directly alongside the database infrastructure tier. It intercepts state changes across every domain module:

```
+---------------------------------------------------------------------------------------------------------------+
|                                            Domain Modules & Operations                                        |
|  - Identity & Access (Admin Role Grants)                                                                      |
|  - Seller Participation (Application Approval / Suspension)                                                   |
|  - Offer & Inventory (Price Adjustments / Stock Escalations)                                                  |
|  - Order & Fulfillment (State Transitions / Carrier Handoff)                                                  |
|  - Payments & Settlement (Disbursements / Adjustments)                                                        |
+---------------------------------------------------------------------------------------------------------------+
                                                       |
                                                       | Calls with transaction client
                                                       v
+---------------------------------------------------------------------------------------------------------------+
|                                            Transactional Boundary                                             |
|                                       src/db/index.ts -> withTransaction()                                    |
|                                                                                                               |
|    BEGIN TRANSACTION                                                                                          |
|       |                                                                                                       |
|       +--> (1) Mutate Business Entity (e.g. UPDATE user_accounts, INSERT seller_applications)                  |
|       |                                                                                                       |
|       +--> (2) recordAuditEvent(client, { actorType, action, entityType, entityId, previousValue, ... })       |
|                                                                                                               |
|    COMMIT (or ROLLBACK on error)                                                                              |
+---------------------------------------------------------------------------------------------------------------+
                                                       |
                                                       | Enforces SQL INSERT & Type Rules
                                                       v
+---------------------------------------------------------------------------------------------------------------+
|                                            PostgreSQL Database Engine                                         |
|                                                                                                               |
|  TABLE: audit_events                                                                                          |
|  - id UUID (gen_random_uuid())                                                                                |
|  - occurred_at TIMESTAMPTZ (DEFAULT NOW())                                                                    |
|  - actor_type VARCHAR(20) CHECK (actor_type IN ('system', 'user'))                                             |
|  - actor_id VARCHAR(255) NULL                                                                                 |
|  - action VARCHAR(100) NOT NULL                                                                               |
|  - entity_type VARCHAR(100) NOT NULL                                                                           |
|  - entity_id VARCHAR(255) NOT NULL                                                                            |
|  - previous_value JSONB NULL                                                                                  |
|  - new_value JSONB NULL                                                                                       |
|  - reason TEXT NULL                                                                                           |
|  - linked_event_id UUID NULL                                                                                  |
|                                                                                                               |
|  ENGINE-LEVEL IMMUTABILITY GUARDS:                                                                            |
|  - TRIGGER prevent_audit_events_mutation (BEFORE UPDATE OR DELETE ... FOR EACH STATEMENT)                     |
|  - TRIGGER prevent_audit_events_truncate (BEFORE TRUNCATE ... FOR EACH STATEMENT)                             |
+---------------------------------------------------------------------------------------------------------------+
```

---

### Prerequisites

This chapter builds directly upon:

- **Chapter 01 (Project Scaffold):** PostgreSQL connection pool management (`createDbPool`), database migration harness (`node-pg-migrate`), and Vitest integration testing.
- **Chapter 03 & 04 (Identity & RBAC):** Operational user identities (`user_accounts`), operational roles, and domain error definitions (`ValidationError` in `src/errors.ts`).
- **GLOSSARY.md:** Definitions for **Operational User**, **Buyer Order**, **Seller Suborder**, and **Commercial and Financial History**.
- **`codebase-design` Vocabulary:** Designing **deep modules**, defining clean **seams**, achieving **leverage** for calling modules, and guaranteeing **locality** for data compliance.

---

## 2. Architectural Deep Dive (The "Why")

### Database-Level Enforcement vs. Application-Level Discipline

A common mistake in application engineering is relying solely on application-level logic (e.g. an ORM repository or service layer) to prevent updates or deletions of audit entries. 

While good code hygiene might avoid writing `UPDATE` statements in day-to-day services, application-level guards fail against:
1. Direct database queries executed during emergency operational fixes or incident response.
2. Accidental cascade deletes from foreign keys when parent records are dropped.
3. Automated ORM migrations or bulk cleanup scripts written by engineers unfamiliar with audit retention rules.
4. Compromised database credentials or SQL injection vulnerabilities.

By installing PostgreSQL **statement-level triggers** in `migrations/1794911942000_audit-trail-shared-writer.js`:

```sql
CREATE OR REPLACE FUNCTION prevent_audit_events_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % operations are prohibited', TG_OP
    USING ERRCODE = '23506';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_prevent_mutation
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_audit_events_mutation();
```

We move the immutability guarantee down into the database storage engine. Even a superuser running `UPDATE audit_events SET reason = 'tampered'` will be stopped dead in their tracks by PostgreSQL.

### Statement-Level vs. Row-Level Triggers: Closing the Zero-Row Mutation Loophole

During our code-review phase, a critical subtlety was uncovered:
If `BEFORE UPDATE OR DELETE` is configured `FOR EACH ROW`, the trigger only fires when a row is physically evaluated and matched. Consequently:
- If a caller executes `UPDATE audit_events SET reason = 'hack' WHERE 1 = 0;`, zero rows match, so a row-level trigger never fires, and the statement returns HTTP 200 / SQL success.
- If the table is initially empty, a blind `DELETE FROM audit_events` might execute silently without triggering an error.

By declaring `FOR EACH STATEMENT`, PostgreSQL halts and rejects **any** attempt to run an `UPDATE` or `DELETE` statement against `audit_events`, regardless of whether zero rows or ten thousand rows match the `WHERE` clause. This ensures true statement-level determinism.

### Preventing Audit Timestamp Spoofing

An audit trail must capture when an event *actually* took place on the server, not when a client claims it took place. 

If our writer utility accepted an arbitrary `occurredAt` date from callers, a compromised worker or buggy service could backdate actions or reorder financial histories. In our final implementation:
- `occurred_at` in the PostgreSQL schema defaults strictly to `NOW()`.
- `RecordAuditEventParams` intentionally does **not** accept a caller-supplied timestamp.
- The PostgreSQL database engine stamps every record at the exact millisecond of row insertion.

### Enforcing Transactional Atomicity (`withTransaction`)

An audit event is only meaningful if it is in lockstep with the state change it records:
- **Scenario A (Dual Write Without Transaction):** A module updates a seller's status to `active`, but the network drops before `recordAuditEvent` executes. Result: An active seller exists with zero audit trace.
- **Scenario B (Premature Audit Logging):** A module writes an audit entry stating "Order Cancelled", but the subsequent database update fails due to a foreign key constraint. Result: A phantom audit log claims an order was cancelled, but the order remains active in the database.

To eliminate both bugs, `recordAuditEvent` accepts a `Queryable` database handle (`pg.PoolClient` or `pg.Pool`). When combined with `withTransaction(pool, async (client) => { ... })`:
```ts
await withTransaction(pool, async (client) => {
  await client.query('UPDATE seller_applications SET status = $1 WHERE id = $2', ['active', sellerId]);
  await recordAuditEvent(client, {
    actorType: 'user',
    actorId: operatorId,
    action: 'seller.approved',
    entityType: 'seller',
    entityId: sellerId,
    previousValue: { status: 'pending-review' },
    newValue: { status: 'active' },
    reason: 'National identity and business license verified',
  });
});
```
If anything throws inside the callback, `ROLLBACK` runs automatically. Both the seller state mutation and the audit event evaporate together. If it succeeds, `COMMIT` persists both atomically.

### Append-Only Corrections (`linked_event_id`)

Because audit records can never be updated, how do we correct human mistakes? (For example, an operator enters the wrong postal code or misspells a reason string).

The solution is the **Linked Event Pattern**:
1. The original event remains permanently recorded in `audit_events`.
2. A new corrective event is inserted with an updated `newValue` or reason, carrying `linked_event_id` pointing to the original event's UUID.
3. Timeline queries (`findAuditEventsByEntity`) retrieve both events in chronological order (`occurred_at ASC, id ASC`), making both the original mistake and the subsequent correction completely auditable and transparent.

---

## 3. File Map (Build Order)

Here is the exact file sequence implemented and verified in this chapter:

- [ ] `migrations/1794911942000_audit-trail-shared-writer.js` — Migration creating `audit_events`, performance indexes, `actor_type` check constraint, and statement-level mutation/truncation prevention triggers.
- [ ] `src/db/index.ts` — Connection pool infrastructure augmented with `withTransaction` transaction lifecycle runner.
- [ ] `src/modules/audit/types.ts` — TypeScript type definitions (`Queryable`, `ActorType`, `RecordAuditEventParams`, `AuditEvent`, `AuditEventRow`).
- [ ] `src/modules/audit/writer.ts` — Deep writer module containing `recordAuditEvent`, input validations, JSONB stringification, and entity mapping.
- [ ] `src/modules/audit/reader.ts` — Read-side query helpers (`findAuditEventById`, `findAuditEventsByEntity`) for testing, monitoring, and timeline inspection.
- [ ] `src/modules/audit/index.ts` — Public interface barrel exposing audit contracts to other modules.
- [ ] `tests/unit/audit-writer.test.ts` — Unit tests verifying parameter validation and domain actor restrictions.
- [ ] `tests/integration/audit-trail.test.ts` — Integration tests verifying database immutability, statement triggers, JSONB round-trip, corrective event linkage, and transactional atomicity.

---

## 4. Step-by-Step Implementation

### Step 1: Database Migration (`audit_events` and Immutability Triggers)

#### Context & Purpose
This migration defines the append-only table in PostgreSQL, creates performance indexes for entity and actor lookups, and registers two PL/pgSQL trigger functions that reject any `UPDATE`, `DELETE`, or `TRUNCATE` operations with PostgreSQL error code `23506` (`check_violation` / prohibited mutation).

#### Verified Code
Create `migrations/1794911942000_audit-trail-shared-writer.js`:

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
    -- Create append-only audit_events table
    CREATE TABLE IF NOT EXISTS audit_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_type VARCHAR(20) NOT NULL,
      actor_id VARCHAR(255) NULL,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      entity_id VARCHAR(255) NOT NULL,
      previous_value JSONB NULL,
      new_value JSONB NULL,
      reason TEXT NULL,
      linked_event_id UUID NULL,
      CONSTRAINT chk_audit_events_actor_type CHECK (actor_type IN ('system', 'user'))
    );

    -- Indexes for querying entity histories and actor timelines
    CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at ON audit_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_type, actor_id);

    -- Function to prevent UPDATE and DELETE modifications at the statement level
    CREATE OR REPLACE FUNCTION prevent_audit_events_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'audit_events is append-only: % operations are prohibited', TG_OP
        USING ERRCODE = '23506';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS audit_events_prevent_mutation ON audit_events;
    CREATE TRIGGER audit_events_prevent_mutation
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_audit_events_mutation();

    -- Function to prevent TRUNCATE operations
    CREATE OR REPLACE FUNCTION prevent_audit_events_truncate()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'audit_events is append-only: TRUNCATE operations are prohibited'
        USING ERRCODE = '23506';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS audit_events_prevent_truncate ON audit_events;
    CREATE TRIGGER audit_events_prevent_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_audit_events_truncate();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS audit_events_prevent_truncate ON audit_events;
    DROP TRIGGER IF EXISTS audit_events_prevent_mutation ON audit_events;
    DROP FUNCTION IF EXISTS prevent_audit_events_truncate();
    DROP FUNCTION IF EXISTS prevent_audit_events_mutation();
    DROP TABLE IF EXISTS audit_events;
  `);
};
```

#### Code Walkthrough
- **Lines 13–26:** Defines the columns. `id` generates a V4 UUID via `gen_random_uuid()`. `occurred_at` defaults to `NOW()`. `previous_value` and `new_value` use PostgreSQL's native `JSONB` data type, which preserves typed attributes while allowing efficient binary querying. `CONSTRAINT chk_audit_events_actor_type` guarantees at the storage level that actors must be either `'system'` or `'user'`.
- **Lines 29–31:** Creates indexes: `idx_audit_events_entity` is a composite index on `(entity_type, entity_id, occurred_at DESC)` optimizing chronological entity lookups (e.g. seller lifecycle history).
- **Lines 34–46:** Declares the PL/pgSQL function `prevent_audit_events_mutation()` and binds it to `BEFORE UPDATE OR DELETE ON audit_events FOR EACH STATEMENT`. If any UPDATE or DELETE SQL command is issued, PostgreSQL intercepts it immediately, formats the error with `TG_OP` (`'UPDATE'` or `'DELETE'`), and aborts the transaction.
- **Lines 49–61:** Installs `prevent_audit_events_truncate()` on `BEFORE TRUNCATE ... FOR EACH STATEMENT`, stopping table wipes.
- **Lines 69–76:** Provides a clean `down` migration that drops triggers, functions, and the table in reverse order of creation.

---

### Step 2: Database Infrastructure Transaction Helper (`src/db/index.ts`)

#### Context & Purpose
To satisfy the invariant that an audit event and its corresponding business state change commit or fail as a single atomic unit, callers require a reliable transaction wrapper. `withTransaction` leases a dedicated client from `pg.Pool`, executes `BEGIN`, runs the user callback, executes `COMMIT`, rolls back on any error, and guarantees connection return in a `finally` block.

#### Verified Code
Update `src/db/index.ts`:

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

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

#### Code Walkthrough
- **Lines 39–55 (`withTransaction`):** Leases a single `PoolClient` via `await pool.connect()`.
- Wraps the operation inside `try ... catch ... finally`:
  - `await client.query('BEGIN')` initiates the transactional block.
  - Passes the scoped `client` to `fn(client)`. Any SQL statements (including calls to `recordAuditEvent(client, ...)`) executed against this `client` participate in this transaction.
  - If `fn` succeeds, `await client.query('COMMIT')` commits all changes to disk.
  - If `fn` throws, `await client.query('ROLLBACK')` undoes every mutation executed within the block and re-throws the error to the caller.
  - `finally { client.release(); }` ensures that regardless of outcome, the client connection is never leaked and returns to the pool immediately.

---

### Step 3: Domain Types (`src/modules/audit/types.ts`)

#### Context & Purpose
Defines domain types for database queryability, actors, parameters, and entities. It provides strict type safety while decoupling database row formats (`snake_case`) from domain entity models (`camelCase`).

#### Verified Code
Create `src/modules/audit/types.ts`:

```typescript
import type pg from 'pg';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow, I extends unknown[] = unknown[]>(
    queryTextOrConfig: string | pg.QueryConfig<I>,
    values?: I,
  ): Promise<pg.QueryResult<R>>;
}

export type ActorType = 'system' | 'user';

export interface RecordAuditEventParams {
  actorType: ActorType;
  actorId?: string | null | undefined;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: Record<string, unknown> | unknown[] | null | undefined;
  newValue?: Record<string, unknown> | unknown[] | null | undefined;
  reason?: string | null | undefined;
  linkedEventId?: string | null | undefined;
}

export interface AuditEvent {
  id: string;
  occurredAt: Date;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  previousValue: Record<string, unknown> | unknown[] | null;
  newValue: Record<string, unknown> | unknown[] | null;
  reason: string | null;
  linkedEventId: string | null;
}

export interface AuditEventRow {
  id: string;
  occurred_at: Date;
  actor_type: ActorType;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  previous_value: Record<string, unknown> | unknown[] | null;
  new_value: Record<string, unknown> | unknown[] | null;
  reason: string | null;
  linked_event_id: string | null;
}
```

#### Code Walkthrough
- **Lines 3–8 (`Queryable`):** Interface satisfied by both `pg.Pool` and `pg.PoolClient`. This allows functions to accept either a standalone connection pool or an active transaction client without tight coupling.
- **Line 10 (`ActorType`):** Strict TypeScript union `'system' | 'user'`. Notice we avoided speculative widening (`| string`), enforcing compile-time type safety.
- **Lines 12–22 (`RecordAuditEventParams`):** Input payload accepted by `recordAuditEvent`. `previousValue` and `newValue` can accept plain objects, arrays, or null. Crucially, notice there is no `occurredAt` field; callers cannot inject arbitrary timestamps.
- **Lines 24–36 (`AuditEvent`):** Clean TypeScript domain representation returned to callers, with dates mapped to `Date` objects and JSON values parsed.
- **Lines 38–50 (`AuditEventRow`):** Direct database representation used internally when reading from PostgreSQL.

---

### Step 4: The Shared Audit Writer (`src/modules/audit/writer.ts`)

#### Context & Purpose
`recordAuditEvent` is the deep module interface for recording audit events. It performs defensive input validation, stringifies JSON payloads for PostgreSQL JSONB columns, executes the `INSERT`, and returns the validated `AuditEvent`.

#### Verified Code
Create `src/modules/audit/writer.ts`:

```typescript
import { ValidationError } from '../../errors.js';
import type { AuditEvent, AuditEventRow, Queryable, RecordAuditEventParams } from './types.js';

export function mapAuditEventRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    occurredAt: new Date(row.occurred_at),
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    previousValue: row.previous_value,
    newValue: row.new_value,
    reason: row.reason,
    linkedEventId: row.linked_event_id,
  };
}

export async function recordAuditEvent(
  db: Queryable,
  params: RecordAuditEventParams,
): Promise<AuditEvent> {
  const actorType = params.actorType?.trim();
  if (!actorType || (actorType !== 'system' && actorType !== 'user')) {
    throw new ValidationError(
      "actorType is required and must be either 'system' or 'user' for recording an audit event",
    );
  }

  const action = params.action?.trim();
  if (!action) {
    throw new ValidationError('action is required for recording an audit event');
  }

  const entityType = params.entityType?.trim();
  if (!entityType) {
    throw new ValidationError('entityType is required for recording an audit event');
  }

  const entityId = params.entityId?.trim();
  if (!entityId) {
    throw new ValidationError('entityId is required for recording an audit event');
  }

  const actorId = params.actorId ?? null;
  const reason = params.reason ?? null;
  const linkedEventId = params.linkedEventId ?? null;

  const previousValueJson =
    params.previousValue !== undefined && params.previousValue !== null
      ? JSON.stringify(params.previousValue)
      : null;

  const newValueJson =
    params.newValue !== undefined && params.newValue !== null
      ? JSON.stringify(params.newValue)
      : null;

  const insertQuery = `
    INSERT INTO audit_events (
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      previous_value,
      new_value,
      reason,
      linked_event_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *;
  `;

  const values = [
    actorType,
    actorId,
    action,
    entityType,
    entityId,
    previousValueJson,
    newValueJson,
    reason,
    linkedEventId,
  ];

  const result = await db.query<AuditEventRow>(insertQuery, values);
  const row = result.rows[0];

  if (!row) {
    throw new Error('Failed to record audit event: No row returned from database');
  }

  return mapAuditEventRow(row);
}
```

#### Code Walkthrough
- **Lines 4–18 (`mapAuditEventRow`):** Pure transformer mapping a database `AuditEventRow` to our domain `AuditEvent`.
- **Lines 24–44 (Input Validations):** Validates required strings with `.trim()`. Missing, empty, or whitespace strings for `actorType`, `action`, `entityType`, or `entityId` throw a structured `ValidationError`. `actorType` is defensively checked to ensure it strictly equals `'system'` or `'user'`.
- **Lines 50–58 (JSONB Serialization):** Checks if `previousValue` or `newValue` are provided. If present and non-null, converts them to valid JSON strings with `JSON.stringify()`. If omitted or null, passes SQL `null`.
- **Lines 60–85 (Parameterized SQL Insert):** Executes a single parameterized `INSERT INTO audit_events (...) VALUES (...) RETURNING *`. Parameterized placeholders (`$1`–`$9`) completely eliminate SQL injection risks.
- **Lines 87–94:** Asserts row presence and returns the mapped `AuditEvent`.

---

### Step 5: Read-Side Query Helpers (`src/modules/audit/reader.ts`)

#### Context & Purpose
While Ticket 05 focuses primarily on writing, an audit trail must be verifiable. We provide two reader functions: `findAuditEventById` for retrieving a single record, and `findAuditEventsByEntity` for viewing an entity's complete chronological audit timeline.

#### Verified Code
Create `src/modules/audit/reader.ts`:

```typescript
import { mapAuditEventRow } from './writer.js';
import type { AuditEvent, AuditEventRow, Queryable } from './types.js';

export async function findAuditEventById(db: Queryable, id: string): Promise<AuditEvent | null> {
  const query = `
    SELECT *
    FROM audit_events
    WHERE id = $1
    LIMIT 1;
  `;

  const result = await db.query<AuditEventRow>(query, [id]);
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return mapAuditEventRow(row);
}

export async function findAuditEventsByEntity(
  db: Queryable,
  entityType: string,
  entityId: string,
): Promise<AuditEvent[]> {
  const query = `
    SELECT *
    FROM audit_events
    WHERE entity_type = $1 AND entity_id = $2
    ORDER BY occurred_at ASC, id ASC;
  `;

  const result = await db.query<AuditEventRow>(query, [entityType, entityId]);
  return result.rows.map(mapAuditEventRow);
}
```

#### Code Walkthrough
- **Lines 4–20 (`findAuditEventById`):** Queries `audit_events` by primary key `id`. Returns the mapped `AuditEvent` or `null` if not found.
- **Lines 22–36 (`findAuditEventsByEntity`):** Queries by `entity_type` and `entity_id`, sorting by `occurred_at ASC, id ASC`. This produces the exact chronological timeline of events for an entity (e.g. from seller onboarding through status transitions and eventual reinstatement).

---

### Step 6: Public Module Interface Barrel (`src/modules/audit/index.ts`)

#### Context & Purpose
Acts as the clean public facade for the audit module. Callers import audit types, `recordAuditEvent`, and reader functions from this single seam. (Notice that `withTransaction` is intentionally *not* re-exported here, preventing middle-man abstraction leaks; database transaction helpers are imported from `src/db/index.js`).

#### Verified Code
Create `src/modules/audit/index.ts`:

```typescript
export * from './types.js';
export { recordAuditEvent, mapAuditEventRow } from './writer.js';
export { findAuditEventById, findAuditEventsByEntity } from './reader.js';
```

---

## 5. Verification & Testing (TDD Walkthrough)

### Seam & Test Strategy

We test our implementation across two distinct boundaries:
1. **Unit Seam (`tests/unit/audit-writer.test.ts`):** Tests `recordAuditEvent` in-memory against a mock `Queryable` to verify that input validation rules immediately reject missing parameters, empty whitespace strings, and invalid actor types before any database query is issued.
2. **Database & Integration Seam (`tests/integration/audit-trail.test.ts`):** Tests against a real PostgreSQL database instance to verify:
   - Migration completeness (table columns and types).
   - Statement-level immutability triggers (blocking `UPDATE`, `DELETE`, and `TRUNCATE` unconditionally).
   - CHECK constraints on `actor_type`.
   - Complete JSONB round-trip fidelity for before/after states.
   - Corrective event linking via `linked_event_id`.
   - Transactional commit and rollback atomicity via `withTransaction`.

---

### Verified Test Code

#### 1. Unit Tests (`tests/unit/audit-writer.test.ts`)
Create `tests/unit/audit-writer.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { recordAuditEvent } from '../../src/modules/audit/index.js';
import { ValidationError } from '../../src/errors.js';
import type { Queryable } from '../../src/modules/audit/types.js';

describe('recordAuditEvent Unit Validations', () => {
  const fakeDb: Queryable = {
    query: async () => ({
      command: 'INSERT',
      rowCount: 1,
      oid: 0,
      rows: [],
      fields: [],
    }),
  };

  it('rejects recording an event with missing or invalid actorType', async () => {
    await expect(
      recordAuditEvent(fakeDb, {
        actorType: '' as unknown as 'system',
        action: 'seller.created',
        entityType: 'seller',
        entityId: 'seller-1',
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      recordAuditEvent(fakeDb, {
        actorType: 'invalid-actor' as unknown as 'system',
        action: 'seller.created',
        entityType: 'seller',
        entityId: 'seller-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects recording an event with missing or empty action', async () => {
    await expect(
      recordAuditEvent(fakeDb, {
        actorType: 'system',
        action: '   ',
        entityType: 'seller',
        entityId: 'seller-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects recording an event with missing or empty entityType', async () => {
    await expect(
      recordAuditEvent(fakeDb, {
        actorType: 'user',
        action: 'seller.approved',
        entityType: '',
        entityId: 'seller-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects recording an event with missing or empty entityId', async () => {
    await expect(
      recordAuditEvent(fakeDb, {
        actorType: 'user',
        action: 'seller.approved',
        entityType: 'seller',
        entityId: '   ',
      }),
    ).rejects.toThrow(ValidationError);
  });
});
```

---

#### 2. Integration Tests (`tests/integration/audit-trail.test.ts`)
Create `tests/integration/audit-trail.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { createDbPool, withTransaction } from '../../src/db/index.js';
import { DEFAULT_TEST_DB_URL } from '../../src/config/index.js';
import {
  findAuditEventById,
  findAuditEventsByEntity,
  recordAuditEvent,
} from '../../src/modules/audit/index.js';

describe('Audit Trail Database Immutability & Shared Writer', () => {
  let pool: Pool;
  const testDbUrl = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DB_URL;

  beforeAll(async () => {
    pool = createDbPool({ connectionString: testDbUrl });

    // Refresh migration to ensure latest trigger definition and check constraints are applied
    await runner({
      databaseUrl: testDbUrl,
      dir: 'migrations',
      direction: 'down',
      count: 1,
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    await runner({
      databaseUrl: testDbUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Database Schema & Immutability Trigger', () => {
    it('creates audit_events table with all required columns and constraints', async () => {
      const columnsResult = await pool.query<{ column_name: string; data_type: string }>(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'audit_events'
        ORDER BY ordinal_position ASC;
      `);

      const columnNames = columnsResult.rows.map((r) => r.column_name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('occurred_at');
      expect(columnNames).toContain('actor_type');
      expect(columnNames).toContain('actor_id');
      expect(columnNames).toContain('action');
      expect(columnNames).toContain('entity_type');
      expect(columnNames).toContain('entity_id');
      expect(columnNames).toContain('previous_value');
      expect(columnNames).toContain('new_value');
      expect(columnNames).toContain('reason');
      expect(columnNames).toContain('linked_event_id');
    });

    it('rejects direct SQL UPDATE queries via statement-level trigger even if zero rows match', async () => {
      const event = await recordAuditEvent(pool, {
        actorType: 'system',
        actorId: 'sys-immutability-1',
        action: 'seller.created',
        entityType: 'seller',
        entityId: 'seller-immutability-1',
        reason: 'Initial onboarding',
      });

      // Target exact row
      await expect(
        pool.query(`UPDATE audit_events SET reason = 'tampered reason' WHERE id = $1`, [event.id]),
      ).rejects.toThrow(/append-only/i);

      // Target zero rows (statement-level trigger blocks statement unconditionally)
      await expect(
        pool.query(`UPDATE audit_events SET reason = 'tampered' WHERE 1 = 0`),
      ).rejects.toThrow(/append-only/i);
    });

    it('rejects direct SQL DELETE queries via statement-level trigger even if zero rows match', async () => {
      const event = await recordAuditEvent(pool, {
        actorType: 'user',
        actorId: 'user-immutability-1',
        action: 'order.cancelled',
        entityType: 'buyer_order',
        entityId: 'ord-immutability-1',
        reason: 'Buyer cancellation',
      });

      // Target exact row
      await expect(
        pool.query(`DELETE FROM audit_events WHERE id = $1`, [event.id]),
      ).rejects.toThrow(/append-only/i);

      // Target zero rows
      await expect(pool.query(`DELETE FROM audit_events WHERE 1 = 0`)).rejects.toThrow(
        /append-only/i,
      );
    });

    it('rejects direct SQL TRUNCATE queries via database-level trigger', async () => {
      await expect(pool.query(`TRUNCATE TABLE audit_events`)).rejects.toThrow(/append-only/i);
    });

    it('enforces database check constraint rejecting invalid actor_type', async () => {
      await expect(
        pool.query(`
          INSERT INTO audit_events (
            actor_type, action, entity_type, entity_id
          ) VALUES ('invalid_actor', 'seller.created', 'seller', 's-1')
        `),
      ).rejects.toThrow(/chk_audit_events_actor_type/i);
    });
  });

  describe('Shared Writer Utility (recordAuditEvent & Readers)', () => {
    it('records an audit event with JSONB before/after values and reads it back faithfully', async () => {
      const entityId = `seller-${Date.now()}`;
      const previousValue = { status: 'pending-review', commission_rate: 0.05 };
      const newValue = { status: 'active', commission_rate: 0.08 };

      const createdEvent = await recordAuditEvent(pool, {
        actorType: 'user',
        actorId: 'admin-user-uuid',
        action: 'seller.approved',
        entityType: 'seller',
        entityId,
        previousValue,
        newValue,
        reason: 'Merchant documentation verified',
      });

      expect(createdEvent.id).toBeDefined();
      expect(createdEvent.occurredAt).toBeInstanceOf(Date);
      expect(createdEvent.actorType).toBe('user');
      expect(createdEvent.actorId).toBe('admin-user-uuid');
      expect(createdEvent.action).toBe('seller.approved');
      expect(createdEvent.entityType).toBe('seller');
      expect(createdEvent.entityId).toBe(entityId);
      expect(createdEvent.previousValue).toEqual(previousValue);
      expect(createdEvent.newValue).toEqual(newValue);
      expect(createdEvent.reason).toBe('Merchant documentation verified');
      expect(createdEvent.linkedEventId).toBeNull();

      // Read back via findAuditEventById
      const fetchedById = await findAuditEventById(pool, createdEvent.id);
      expect(fetchedById).toEqual(createdEvent);

      // Read back via findAuditEventsByEntity
      const events = await findAuditEventsByEntity(pool, 'seller', entityId);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(createdEvent);
    });

    it('records corrective audit events with linkedEventId instead of overwriting', async () => {
      const entityId = `order-${Date.now()}`;

      // 1. Initial event
      const initialEvent = await recordAuditEvent(pool, {
        actorType: 'user',
        actorId: 'support-agent-1',
        action: 'order.address_updated',
        entityType: 'buyer_order',
        entityId,
        previousValue: { postalCode: '1111111111' },
        newValue: { postalCode: '2222222222' },
        reason: 'Buyer requested address correction',
      });

      // 2. Corrective event linking back to initial event
      const correctiveEvent = await recordAuditEvent(pool, {
        actorType: 'user',
        actorId: 'support-supervisor',
        action: 'order.address_corrected',
        entityType: 'buyer_order',
        entityId,
        previousValue: { postalCode: '2222222222' },
        newValue: { postalCode: '3333333333' },
        reason: 'Supervisor override: corrected unit number and postal code',
        linkedEventId: initialEvent.id,
      });

      expect(correctiveEvent.linkedEventId).toBe(initialEvent.id);

      // Query entity timeline
      const timeline = await findAuditEventsByEntity(pool, 'buyer_order', entityId);
      expect(timeline).toHaveLength(2);
      expect(timeline[0]?.id).toBe(initialEvent.id);
      expect(timeline[1]?.id).toBe(correctiveEvent.id);
      expect(timeline[1]?.linkedEventId).toBe(initialEvent.id);

      // Verify initial event was not modified
      const originalUnchanged = await findAuditEventById(pool, initialEvent.id);
      expect(originalUnchanged?.newValue).toEqual({ postalCode: '2222222222' });
    });
  });

  describe('Transactional Atomicity with withTransaction', () => {
    it('commits both entity state change and audit event together on success', async () => {
      const phone = `+98912${Math.floor(1000000 + Math.random() * 9000000)}`;

      // Use withTransaction to insert a user account and record its creation audit event
      const result = await withTransaction(pool, async (client) => {
        const userInsertRes = await client.query<{ id: string; phone: string }>(
          `INSERT INTO user_accounts (phone, status) VALUES ($1, 'active') RETURNING id, phone;`,
          [phone],
        );
        const user = userInsertRes.rows[0]!;

        const audit = await recordAuditEvent(client, {
          actorType: 'system',
          actorId: 'system-job',
          action: 'user.created',
          entityType: 'user_account',
          entityId: user.id,
          newValue: { phone: user.phone, status: 'active' },
          reason: 'Automated user account provisioning',
        });

        return { user, audit };
      });

      // Assert user exists in database
      const userCheck = await pool.query<{ id: string }>(
        `SELECT id FROM user_accounts WHERE id = $1;`,
        [result.user.id],
      );
      expect(userCheck.rows).toHaveLength(1);

      // Assert audit event exists in database
      const auditCheck = await findAuditEventById(pool, result.audit.id);
      expect(auditCheck).not.toBeNull();
      expect(auditCheck?.entityId).toBe(result.user.id);
    });

    it('rolls back both entity state change and audit event when transaction fails', async () => {
      const phone = `+98912${Math.floor(1000000 + Math.random() * 9000000)}`;
      let capturedUserId: string | null = null;
      let capturedAuditId: string | null = null;

      await expect(
        withTransaction(pool, async (client) => {
          const userInsertRes = await client.query<{ id: string; phone: string }>(
            `INSERT INTO user_accounts (phone, status) VALUES ($1, 'active') RETURNING id, phone;`,
            [phone],
          );
          const user = userInsertRes.rows[0]!;
          capturedUserId = user.id;

          const audit = await recordAuditEvent(client, {
            actorType: 'user',
            actorId: 'operator-1',
            action: 'user.provision_attempt',
            entityType: 'user_account',
            entityId: user.id,
            newValue: { phone: user.phone },
            reason: 'Should roll back',
          });
          capturedAuditId = audit.id;

          // Intentionally throw an unhandled error inside transaction
          throw new Error('Simulated operational failure during multi-step operation');
        }),
      ).rejects.toThrow('Simulated operational failure during multi-step operation');

      // Assert business entity was rolled back
      expect(capturedUserId).not.toBeNull();
      const userCheck = await pool.query<{ id: string }>(
        `SELECT id FROM user_accounts WHERE id = $1;`,
        [capturedUserId],
      );
      expect(userCheck.rows).toHaveLength(0);

      // Assert audit event was also rolled back
      expect(capturedAuditId).not.toBeNull();
      const auditCheck = await findAuditEventById(pool, capturedAuditId!);
      expect(auditCheck).toBeNull();
    });
  });
});
```

---

### How to Verify Locally

Execute the following commands in your development terminal:

```bash
# 1. Start the PostgreSQL test database (if not already running)
npm run docker:up

# 2. Run TypeScript typechecking to ensure zero compiler issues
npm run typecheck

# 3. Run ESLint across all files
npm run lint

# 4. Run the Audit Trail Unit Tests
npx vitest run tests/unit/audit-writer.test.ts

# 5. Run the Audit Trail Integration Tests
npx vitest run tests/integration/audit-trail.test.ts

# 6. Run the complete test suite
npm test
```

Expected output:
```text
 ✓ |unit| tests/unit/audit-writer.test.ts (4 tests) 5ms
 ✓ |integration| tests/integration/audit-trail.test.ts (9 tests) 205ms

 Test Files  15 passed (15)
      Tests  114 passed (114)
```

---

### Acceptance Checklist

Review the verified acceptance criteria for Ticket 05:

- [x] `audit_events` table created via migration with fields: `id`, `occurred_at`, `actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `previous_value` (JSONB), `new_value` (JSONB), `reason`, `linked_event_id`.
- [x] Database-level constraint and statement-level triggers prevent `UPDATE`, `DELETE`, and `TRUNCATE` operations on `audit_events`.
- [x] Writer utility function `recordAuditEvent(...)` provides the single validated entrypoint for recording events.
- [x] Writer is fully transactional: audit events and state mutations are atomically committed or rolled back together via `withTransaction`.
- [x] Integration tests prove calling the writer produces a readable event and direct SQL `UPDATE` or `DELETE` queries fail at the database engine level.
