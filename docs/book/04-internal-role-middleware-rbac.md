# Chapter 04: Internal Role Middleware & RBAC

## 1. The Goal & Big Picture

### What We Are Building

In this chapter, we implement a robust **Role-Based Access Control (RBAC)** architecture and role-enforcement middleware for the internal operations of our Iranian e-commerce marketplace backend.

In Chapter 03, we established invitation-only internal user onboarding and two-factor authentication (MFA). However, having a valid internal session alone does not grant access to every operational tool. In an enterprise marketplace, operations staff specialize in discrete domain areas:

- **Seller Management (`seller-mgmt`):** Onboards, vets, suspends, and reinstates third-party sellers.
- **Catalog Operations (`catalog`):** Creates product families, reviews variant attributes, matches seller offers, and approves catalog listings.
- **Order Operations (`order-ops`):** Monitors order and suborder lifecycle transitions, oversees parcel packing and carrier handoffs, and manages delivery coverage.
- **Customer Support (`support`):** Handles buyer dispute tickets, investigates delivery discrepancies, and coordinates with operations.
- **Finance Controllers (`finance`):** Manages seller commission calculations, audits VAT snapshots, and confirms weekly settlement payout runs.
- **Access Administration (`access-admin`):** Invites internal staff and manages assigned roles.

To enforce these security boundaries, we deliver:

1. **Middleware-Layer Role Enforcement (`requireRole(...roles)`):** Every internal route group is protected by a factory that evaluates the authenticated user's active roles and rejects unauthorized requests with HTTP 403 Forbidden, and unauthenticated requests with HTTP 401 Unauthorized.
2. **Strict Separation of Duties (SoD) Invariant:** To prevent rogue operations or catastrophic fraud, an `access-admin` user is **explicitly barred from executing financial or order operations**, even if assigned `finance` or `order-ops` roles concurrently.
3. **Delegated Role Management Endpoint (`POST /api/v1/admin/users/:id/roles`):** An administrative endpoint allowing `access-admin` users to assign or revoke roles for team members, guarded by the non-escalation rule: **a granting user cannot grant roles they do not personally hold**.
4. **Complete 6×6 RBAC Boundary Matrix:** Exhaustive integration testing demonstrating that every operational role can access its dedicated endpoints and is completely locked out of all other route groups.

---

### Where It Fits

Role-based authorization sits directly at the perimeter of all internal administrative modules, intercepting HTTP traffic immediately after authentication and MFA validation:

```
+---------------------------------------------------------------------------------------------------------------+
|                                    HTTP Client (Internal Operational Staff)                                   |
+-------------------+---------------------+---------------------+---------------------+---------------------+
                    |                     |                     |                     |
 (1) Seller Ops     | (2) Catalog Ops     | (3) Order Ops       | (4) Finance Ops     | (5) Access Admin
  GET /admin/sellers|  GET /admin/catalog |  GET /admin/orders  |  GET /admin/finance |  POST /admin/users/
                    |                     |                     |                     |       :id/roles
                    v                     v                     v                     v
+---------------------------------------------------------------------------------------------------------------+
|                                                Express Pipeline                                               |
|  - traceMiddleware (Assigns req.traceId / X-Trace-Id)                                                         |
|  - express.json()                                                                                             |
|  - errorHandler (Structured JSON error bodies with Persian messages: { code, message, traceId, fieldErrors? })|
+---------------------------------------------------------------------------------------------------------------+
                    |                     |                     |                     |
                    v                     v                     v                     v
+---------------------------------------------------------------------------------------------------------------+
|                                           Internal Authentication                                             |
|  - requireInternalAuth: Validates session token, checks status = 'active', enforces mfa_verified = true       |
+---------------------------------------------------------------------------------------------------------------+
                    |                     |                     |                     |
                    v                     v                     v                     v
+---------------------------------------------------------------------------------------------------------------+
|                                        Role Middleware (requireRole)                                          |
|  - Enforces allowedRoles.some(r => user.roles.includes(r))                                                    |
|  - SEPARATION OF DUTIES (SoD) GATE: access-admin strictly forbidden on 'finance' & 'order-ops' routes         |
+---------------------------------------------------------------------------------------------------------------+
         |                     |                     |                     |                     |
         v                     v                     v                     v                     v
+-----------------+   +-----------------+   +-----------------+   +-----------------+   +-----------------+
|  /admin/sellers |   |  /admin/catalog |   |  /admin/orders  |   |  /admin/finance |   |  /admin/users   |
|  (seller-mgmt)  |   |    (catalog)    |   |   (order-ops)   |   |    (finance)    |   |  (access-admin) |
+-----------------+   +-----------------+   +-----------------+   +-----------------+   +-----------------+
                                                                                                 |
                                                                                                 v
                                                                                +--------------------------------+
                                                                                |  IdentityService (Deep Module) |
                                                                                |  updateUserRoles():            |
                                                                                |  - Validates UUID & roles      |
                                                                                |  - Checks granter holds roles  |
                                                                                |  - Persists to user_accounts   |
                                                                                +--------------------------------+
```

---

### Prerequisites

This chapter builds directly upon:

- **Chapter 01 (Project Scaffold):** PostgreSQL connection pool, structured error handling (`errorHandler`), and testing harness.
- **Chapter 02 (Buyer OTP Auth):** Structured validation errors and domain tokens.
- **Chapter 03 (Internal User Invite & Auth):** `user_accounts` table with `roles TEXT[]`, `internal_sessions` table with MFA tracking, and `createInternalAuthMiddleware`.
- **GLOSSARY.md:** Definitions for **Operational Role**, **Operational User**, and **Access Administrator**.
- **`codebase-design` Vocabulary:** Understanding **seams**, **module depth**, **interfaces**, and **Separation of Duties (SoD)**.

---

## 2. Architectural Deep Dive (The "Why")

### Separation of Duties (SoD): Neutralizing the Super-Admin Risk

In naive web applications, administrative systems frequently rely on a monolithic `"admin"` role or `"is_superuser: true"` flag. A superuser can create accounts, edit prices, clear inventory discrepancies, and release banking disbursements.

In an e-commerce platform processing millions of Tomans in third-party merchant transactions, this architecture presents severe internal threat vulnerabilities:

1. **Collusion and Unauthorized Transfers:** An employee with user-administration access could create a dummy seller account, assign themselves finance permissions, and authorize fraudulent ledger payouts.
2. **Regulatory & Audit Non-Compliance:** Financial and tax directives in Iran (such as banking regulations and e-commerce consumer protection directives) require strict audit segregation between operational actors and financial disbursement authorities.

To eliminate this class of vulnerabilities at the structural layer, our system enforces **Separation of Duties (SoD)**:

```ts
const isRestrictedRouteGroup = allowedRoles.some(
  (role) => role === 'finance' || role === 'order-ops',
);
if (isRestrictedRouteGroup && userRoles.includes(ACCESS_ADMIN_ROLE)) {
  throw new ForbiddenError('کاربران با نقش راهبر دسترسی مجاز به عملیات مالی یا سفارشات نیستند.');
}
```

Even if a rogue database query or administrator adds `finance` or `order-ops` to an `access-admin` user record, the middleware **explicitly drops the hammer**. To perform financial disbursements, a user must forfeit `access-admin` access and operate under an independent account subject to separate authorization.

---

### Role Delegation and Privilege Escalation Prevention

When managing roles via `POST /api/v1/admin/users/:id/roles`, how do we prevent privilege escalation?

Consider this scenario:

- An administrator holds roles `['access-admin', 'catalog']`.
- They want to promote a junior colleague to manage seller onboarding (`seller-mgmt`) or approve bank payouts (`finance`).

If the administrator could grant any operational role, they could indirectly grant permissions they do not possess themselves—bypassing governance reviews. Our domain service enforces a fundamental invariant:

$$\text{Newly Granted Roles} = \text{Target Roles} \setminus \text{Current Target Roles}$$
$$\forall r \in \text{Newly Granted Roles}: r \in \text{Granter Roles}$$

```ts
const grantedRoles = targetRoles.filter((role) => !currentRoles.includes(role));
const granterRoles = params.granterUser.roles ?? [];
const disallowedGrants = grantedRoles.filter((role) => !granterRoles.includes(role));

if (disallowedGrants.length > 0) {
  throw new ForbiddenError(
    'کاربر اعطاکننده نمی‌تواند نقشی را که خود دارا نیست، به کاربر دیگری اختصاص دهد.',
  );
}
```

Notice what this rule achieves:

- **Revocation is unrestricted:** An access-admin can revoke _any_ role (e.g., when an employee leaves the company or shifts responsibilities).
- **Existing roles are preserved:** If the target user already had `finance`, an admin holding only `catalog` can update the user's other roles without triggering an error, because `finance` was not newly granted.
- **Privilege escalation is impossible:** An admin cannot grant `finance` or `order-ops` unless they personally hold that role.

---

### Deep Module Design: Dynamic Session Re-Evaluation

When a user's roles are updated in the database via `POST /api/v1/admin/users/:id/roles`, should their active sessions be terminated?

In JWT-based role models where roles are encoded into an immutable token payload, updating roles requires token revocation lists, blacklists, or waiting for token expiry. In our architecture:

1. `internal_sessions` stores an opaque 256-bit cryptographically random token string in PostgreSQL.
2. On every request, `createInternalAuthMiddleware` calls `identityService.validateInternalSession(token)`.
3. The validation query performs an active SQL join with `user_accounts`:
   ```sql
   SELECT s.id, s.user_id, s.session_token, s.mfa_verified, s.expires_at,
          u.email, u.phone, u.roles, u.status
   FROM internal_sessions s
   JOIN user_accounts u ON u.id = s.user_id
   WHERE s.session_token = $1;
   ```
4. As a result, role updates take effect **immediately across all active sessions**, without caching anomalies or complex distributed cache invalidation pipelines.

---

### Lessons from Automated Code Review

During implementation, parallel automated code-review agents surfaced key improvements:

1. **Guarding the `/me` Endpoint:** Initially, `GET /api/v1/admin/me` was only checked for authentication. While harmless, ticket specifications required that _every_ internal route enforce role checks. Adding `requireRole(...OPERATIONAL_ROLES)` ensures unassigned accounts cannot probe internal operational state.
2. **Avoiding Speculative Generality in APIs:** An initial draft accepted `{ grant: [...], revoke: [...] }` alongside `{ roles: [...] }`. Code review flagged this dual mutation model as speculative scope creep. Simplifying to `{ roles: OperationalRole[] }` made the interface cleaner, unambiguous, and easier to validate.
3. **Structured Field Errors on Validation:** When request bodies or parameters are missing, custom errors must supply `fieldErrors` conforming to the platform's REST contract (`spec.md`).

---

## 3. File Map (Build Order)

Here is the exact build order for this chapter:

- [ ] `GLOSSARY.md` — Domain glossary alignment clarifying that `access-admin` is explicitly barred from financial and order operations under Separation of Duties.
- [ ] `src/errors.ts` — Addition of `NotFoundError` (HTTP 404) for missing entities.
- [ ] `src/middleware/auth.ts` — Role middleware factory `requireRole(...allowedRoles)` with Separation of Duties enforcement and `requireAccessAdmin` delegator.
- [ ] `src/modules/identity/service.ts` — `UpdateUserRolesParams` interface and `updateUserRoles` method enforcing the delegation rule.
- [ ] `src/modules/identity/routes.ts` — Mounting of operational route groups (`/sellers`, `/catalog`, `/orders`, `/support`, `/finance`) and `/users/:id/roles`.
- [ ] `tests/unit/role-middleware.test.ts` — Unit tests for the role middleware factory and SoD edge cases.
- [ ] `tests/integration/role-management-service.test.ts` — Integration tests for role delegation rules against real PostgreSQL.
- [ ] `tests/integration/rbac-role-enforcement.test.ts` — Integration tests verifying the complete 6×6 RBAC route matrix, SoD exclusions, and unauthenticated/unverified rejections.

---

## 4. Step-by-Step Implementation

### Step 1: Update Domain Glossary (`GLOSSARY.md`)

Align the glossary definition of **Access Administrator** with our strict Separation of Duties policy.

```markdown
**Access Administrator**:
An operational user authorized to invite users and grant or revoke roles. Under strict Separation of Duties (SoD), this role explicitly cannot perform order or financial operations, even if assigned both roles.
```

---

### Step 2: Define `NotFoundError` (`src/errors.ts`)

Add the standard `NotFoundError` (HTTP 404) domain error class to `src/errors.ts`.

#### Verified Code: `src/errors.ts`

```typescript
export class NotFoundError extends AppError {
  constructor(message: string = 'منبع مورد نظر یافت نشد.', code: string = 'NOT_FOUND') {
    super({
      message,
      statusCode: 404,
      code,
    });
    this.name = 'NotFoundError';
  }
}
```

#### Code Walkthrough

- Inherits from `AppError`, ensuring `errorHandler` catches it and serializes `{ code: 'NOT_FOUND', message, traceId }`.
- Sets `statusCode: 404` for RFC-compliant REST responses when a requested resource ID does not exist in the database.

---

### Step 3: Implement Role Middleware Factory (`src/middleware/auth.ts`)

Implement `requireRole(...allowedRoles: OperationalRole[])` to guard internal route groups, check active sessions, and enforce Separation of Duties.

#### Verified Code: `src/middleware/auth.ts`

```typescript
import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, MfaRequiredError, UnauthorizedError } from '../errors.js';
import { verifyBuyerToken } from '../modules/identity/domain/tokens.js';
import type { IdentityService, InternalSessionUser } from '../modules/identity/service.js';
import { ACCESS_ADMIN_ROLE, type OperationalRole } from '../modules/identity/domain/roles.js';

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

/**
 * Role middleware factory that verifies the authenticated internal user possesses at least one
 * of the allowed operational roles, while strictly enforcing Separation of Duties (SoD):
 * the `access-admin` role is explicitly barred from financial and order operations.
 */
export function requireRole(...allowedRoles: OperationalRole[]) {
  return function roleMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const user = req.internalUser ?? (req.user as InternalSessionUser | undefined);

    if (!user) {
      throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
    }

    if (!user.mfaVerified) {
      throw new MfaRequiredError(
        'برای دسترسی به این بخش، تکمیل احراز هویت دو مرحله‌ای (MFA) الزامی است.',
      );
    }

    const userRoles = user.roles ?? [];

    // Critical Separation of Duties (SoD) invariant:
    // access-admin cannot perform financial or order operations even if assigned both roles.
    const isRestrictedRouteGroup = allowedRoles.some(
      (role) => role === 'finance' || role === 'order-ops',
    );
    if (isRestrictedRouteGroup && userRoles.includes(ACCESS_ADMIN_ROLE)) {
      throw new ForbiddenError(
        'کاربران با نقش راهبر دسترسی مجاز به عملیات مالی یا سفارشات نیستند.',
      );
    }

    const hasAllowedRole = allowedRoles.some((role) => userRoles.includes(role));
    if (!hasAllowedRole) {
      throw new ForbiddenError('دسترسی غیرمجاز. شما مجوز لازم برای انجام این عملیات را ندارید.');
    }

    next();
  };
}

export const requireAccessAdmin = requireRole(ACCESS_ADMIN_ROLE);
```

#### Code Walkthrough

- `requireRole(...allowedRoles)` accepts a variadic list of `OperationalRole` strings, allowing routes to accept single roles (e.g. `requireRole('finance')`) or multiple authorized roles (e.g. `requireRole('support', 'order-ops')`).
- If no authenticated session is present on `req.internalUser` or `req.user`, it throws `UnauthorizedError` (401), ensuring fail-safe protection even if middleware order is accidentally swapped.
- If the session exists but has not completed MFA verification (`mfaVerified === false`), it throws `MfaRequiredError` (403).
- **Separation of Duties check:** If any of the `allowedRoles` touches `'finance'` or `'order-ops'`, and the user holds `access-admin`, it throws `ForbiddenError` (403), strictly upholding our SoD invariant.
- **Allowed role check:** Verifies that `userRoles` contains at least one of the `allowedRoles`. If not, it throws `ForbiddenError` (403).
- `requireAccessAdmin` is exported as an alias to `requireRole(ACCESS_ADMIN_ROLE)` to provide backwards compatibility with Chapter 03 routers.

---

### Step 4: Implement Role Management in `IdentityService` (`src/modules/identity/service.ts`)

Extend `IdentityService` with the `updateUserRoles` method to validate role names, verify granter permissions, and update PostgreSQL.

#### Verified Code: Excerpt from `src/modules/identity/service.ts`

```typescript
export interface UpdateUserRolesParams {
  userId: string;
  granterUser: InternalSessionUser;
  roles: OperationalRole[];
}

export class IdentityService {
  // ... existing methods ...

  /**
   * Updates an operational user's assigned roles, strictly enforcing the delegation rule:
   * the granting user cannot grant roles they do not hold.
   */
  async updateUserRoles(params: UpdateUserRolesParams): Promise<UserAccount> {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!params.userId || !uuidRegex.test(params.userId)) {
      throw new ValidationError('شناسه کاربر نامعتبر است.', [
        { field: 'userId', message: 'شناسه کاربر نامعتبر است.' },
      ]);
    }

    const targetUser = await this.getUserById(params.userId);
    if (!targetUser) {
      throw new NotFoundError('کاربر مورد نظر یافت نشد.');
    }

    if (!Array.isArray(params.roles)) {
      throw new ValidationError('فیلد roles باید به صورت آرایه‌ای از نقش‌ها ارسال شود.', [
        { field: 'roles', message: 'فیلد roles باید به صورت آرایه‌ای از نقش‌ها ارسال شود.' },
      ]);
    }

    for (const role of params.roles) {
      if (!isValidOperationalRole(role)) {
        throw new ValidationError(`نقش عملیاتی "${role}" نامعتبر است.`, [
          { field: 'roles', message: `نقش عملیاتی "${role}" نامعتبر است.` },
        ]);
      }
    }

    const targetRoles = Array.from(new Set(params.roles));
    const currentRoles: OperationalRole[] = targetUser.roles ?? [];

    // Identify newly granted roles (roles present in targetRoles that targetUser did not already have)
    const grantedRoles = targetRoles.filter((role) => !currentRoles.includes(role));

    // Invariant: The granting user cannot grant roles they do not hold
    const granterRoles = params.granterUser.roles ?? [];
    const disallowedGrants = grantedRoles.filter((role) => !granterRoles.includes(role));
    if (disallowedGrants.length > 0) {
      throw new ForbiddenError(
        'کاربر اعطاکننده نمی‌تواند نقشی را که خود دارا نیست، به کاربر دیگری اختصاص دهد.',
      );
    }

    const query = `
      UPDATE user_accounts
      SET roles = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, phone, email, roles, status, created_at AS "createdAt", updated_at AS "updatedAt";
    `;

    const result = await this.pool.query<UserAccount>(query, [targetRoles, params.userId]);
    return result.rows[0]!;
  }
}
```

#### Code Walkthrough

- Validates the `userId` format against a standard 36-character hexadecimal UUID pattern with field-level error messages.
- Looks up the target user via `getUserById`. If not found, throws `NotFoundError` (404).
- Checks that `params.roles` is an array and that every element passes `isValidOperationalRole`.
- Removes duplicates via `new Set(params.roles)`.
- Calculates `grantedRoles`: only those roles in `targetRoles` that the target user did not already have. Existing roles are never counted as new grants.
- Enforces non-escalation: If any role in `grantedRoles` is missing from `params.granterUser.roles`, it throws `ForbiddenError` (403).
- Executes atomic SQL update on `user_accounts`, returning the updated user record.

---

### Step 5: Mount Route Groups & Endpoints (`src/modules/identity/routes.ts`)

Wire `POST /api/v1/admin/users/:id/roles`, guard `GET /api/v1/admin/me` with operational role checks, and mount each operational route group.

#### Verified Code: Excerpt from `src/modules/identity/routes.ts`

```typescript
import { Router, type Request, type Response } from 'express';
import type { IdentityService, InternalSessionUser } from './service.js';
import type { RequestHandler } from 'express';
import { UnauthorizedError, ValidationError } from '../../errors.js';
import type { BuyerTokenPayload } from './domain/tokens.js';
import { requireRole } from '../../middleware/auth.js';
import { OPERATIONAL_ROLES, type OperationalRole } from './domain/roles.js';

// ... createIdentityRouter ...

export function createAdminRouter(
  identityService: IdentityService,
  requireInternalAuth: RequestHandler,
  requireAccessAdmin: RequestHandler,
): Router {
  const router = Router();

  // Public operational auth routes
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

  // GET /api/v1/admin/me (Protected internal route, guarded by operational role check)
  router.get(
    '/me',
    requireInternalAuth,
    requireRole(...OPERATIONAL_ROLES),
    (req: Request, res: Response) => {
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
    },
  );

  // ---------------------------------------------------------------------------
  // Internal Route Groups (RBAC guarded)
  // ---------------------------------------------------------------------------

  // Group: User & Access Management (access-admin only)
  const usersRouter = Router();
  usersRouter.use(requireInternalAuth, requireAccessAdmin);

  // POST /api/v1/admin/users/invite
  usersRouter.post('/invite', async (req: Request, res: Response, next) => {
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
  });

  // POST /api/v1/admin/users/:id/roles
  usersRouter.post('/:id/roles', async (req: Request, res: Response, next) => {
    try {
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!id) {
        throw new ValidationError('شناسه کاربر الزامی است.', [
          { field: 'id', message: 'شناسه کاربر الزامی است.' },
        ]);
      }

      const { roles } = req.body ?? {};
      if (!roles) {
        throw new ValidationError('فیلد roles الزامی است.', [
          { field: 'roles', message: 'فیلد roles الزامی است.' },
        ]);
      }

      const granter = req.internalUser ?? (req.user as InternalSessionUser | undefined);
      if (!granter) {
        throw new UnauthorizedError('توکن احراز هویت ارسال نشده است.');
      }

      const updatedUser = await identityService.updateUserRoles({
        userId: id,
        granterUser: granter,
        roles,
      });

      res.status(200).json({
        success: true,
        message: 'نقش‌های کاربر با موفقیت به‌روزرسانی شد.',
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          phone: updatedUser.phone,
          roles: updatedUser.roles,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.use('/users', usersRouter);

  // Operational Route Groups (seller-mgmt, catalog, order-ops, support, finance)
  const operationalGroups: Array<{ path: string; role: OperationalRole }> = [
    { path: '/sellers', role: 'seller-mgmt' },
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

#### Code Walkthrough

- `GET /me` uses `requireRole(...OPERATIONAL_ROLES)` so every request to the endpoint verifies that the user holds a valid operational role.
- `usersRouter` mounts at `/users` under `adminRouter`, providing `POST /api/v1/admin/users/invite` and `POST /api/v1/admin/users/:id/roles`.
- It validates `req.params.id` and `req.body.roles` with structured field errors.
- The 5 operational groups (`/sellers`, `/catalog`, `/orders`, `/support`, `/finance`) are dynamically mounted via a clean loop over `operationalGroups`, associating each route with `requireInternalAuth` and `requireRole(group.role)`.
- Sentinel `GET /` endpoints return `{ status: 'ok', group: '<role>' }`, ready to be expanded in upcoming domain tickets.

---

## 5. Verification & Testing (TDD Walkthrough)

### Seam & Test Strategy

We verify our RBAC implementation across three distinct seams:

1. **Unit Middleware Seam (`tests/unit/role-middleware.test.ts`):** Tests `requireRole` in isolation using mock Express request/response objects. Verifies authentication presence, MFA completion, single-role matching, multi-role OR matching, role absence rejection, and Separation of Duties rules.
2. **Domain Service Seam (`tests/integration/role-management-service.test.ts`):** Tests `identityService.updateUserRoles` against a live PostgreSQL instance. Validates UUID format parsing, 404 handling, invalid role detection, self-delegation constraints, and role revocation.
3. **HTTP API Perimeter Seam (`tests/integration/rbac-role-enforcement.test.ts`):** Tests the end-to-end HTTP pipeline using Supertest against all route groups:
   - **401 checks:** Asserts unauthenticated calls to all 8 internal endpoints are rejected.
   - **403 MFA checks:** Asserts sessions with `mfa_verified = false` receive `MFA_REQUIRED`.
   - **6×6 Matrix tests:** Verifies every operational role can access its route and is rejected (403) from all other 5 route groups.
   - **SoD checks:** Asserts `access-admin` is rejected from `/finance` and `/orders` even when assigned both roles.
   - **Role management tests:** Asserts non-admin users cannot call `POST /api/v1/admin/users/:id/roles`, admins cannot grant unheld roles, and admins can grant held roles or revoke roles.

---

### Verified Test Code

#### 1. Unit Tests: `tests/unit/role-middleware.test.ts`

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireRole } from '../../src/middleware/auth.js';
import { ForbiddenError, MfaRequiredError, UnauthorizedError } from '../../src/errors.js';
import type { InternalSessionUser } from '../../src/modules/identity/service.js';

describe('Role Middleware Factory (requireRole)', () => {
  function createMockContext(user?: Partial<InternalSessionUser>) {
    const req = {
      internalUser: user ? (user as InternalSessionUser) : undefined,
      user: user ? (user as InternalSessionUser) : undefined,
    } as unknown as Request;

    const res = {} as Response;
    const next = vi.fn();

    return { req, res, next };
  }

  describe('Authentication and MFA verification', () => {
    it('throws UnauthorizedError when request is unauthenticated', () => {
      const middleware = requireRole('catalog');
      const { req, res, next } = createMockContext(undefined);

      expect(() => middleware(req, res, next)).toThrow(UnauthorizedError);
      expect(next).not.toHaveBeenCalled();
    });

    it('throws MfaRequiredError when session has not completed MFA', () => {
      const middleware = requireRole('catalog');
      const { req, res, next } = createMockContext({
        id: 'u1',
        email: 'u1@marketplace.ir',
        phone: '+989120000001',
        roles: ['catalog'],
        mfaVerified: false,
      });

      expect(() => middleware(req, res, next)).toThrow(MfaRequiredError);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Role-based authorization', () => {
    it('allows access when user possesses the required role', () => {
      const middleware = requireRole('catalog');
      const { req, res, next } = createMockContext({
        id: 'u1',
        email: 'catalog@marketplace.ir',
        phone: '+989120000001',
        roles: ['catalog'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows access when user has one of several accepted roles', () => {
      const middleware = requireRole('support', 'order-ops');
      const { req, res, next } = createMockContext({
        id: 'u2',
        email: 'ops@marketplace.ir',
        phone: '+989120000002',
        roles: ['order-ops'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('throws ForbiddenError when user does not hold the required role', () => {
      const middleware = requireRole('seller-mgmt');
      const { req, res, next } = createMockContext({
        id: 'u3',
        email: 'support@marketplace.ir',
        phone: '+989120000003',
        roles: ['support'],
        mfaVerified: true,
      });

      expect(() => middleware(req, res, next)).toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Separation of Duties (SoD) enforcement for access-admin', () => {
    it('blocks access-admin from finance routes even if finance role is also assigned', () => {
      const middleware = requireRole('finance');
      const { req, res, next } = createMockContext({
        id: 'u4',
        email: 'admin.finance@marketplace.ir',
        phone: '+989120000004',
        roles: ['access-admin', 'finance'],
        mfaVerified: true,
      });

      expect(() => middleware(req, res, next)).toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });

    it('blocks access-admin from order-ops routes even if order-ops role is also assigned', () => {
      const middleware = requireRole('order-ops');
      const { req, res, next } = createMockContext({
        id: 'u5',
        email: 'admin.ops@marketplace.ir',
        phone: '+989120000005',
        roles: ['access-admin', 'order-ops'],
        mfaVerified: true,
      });

      expect(() => middleware(req, res, next)).toThrow(ForbiddenError);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows pure finance role without access-admin into finance routes', () => {
      const middleware = requireRole('finance');
      const { req, res, next } = createMockContext({
        id: 'u6',
        email: 'finance.lead@marketplace.ir',
        phone: '+989120000006',
        roles: ['finance'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows pure order-ops role without access-admin into order-ops routes', () => {
      const middleware = requireRole('order-ops');
      const { req, res, next } = createMockContext({
        id: 'u7',
        email: 'order.lead@marketplace.ir',
        phone: '+989120000007',
        roles: ['order-ops'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('allows access-admin to access access-admin routes', () => {
      const middleware = requireRole('access-admin');
      const { req, res, next } = createMockContext({
        id: 'u8',
        email: 'admin@marketplace.ir',
        phone: '+989120000008',
        roles: ['access-admin'],
        mfaVerified: true,
      });

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
```

---

#### 2. Service Integration Tests: `tests/integration/role-management-service.test.ts`

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createDbPool } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/index.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { InMemorySmsSender } from '../../src/modules/identity/ports/sms-sender.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/errors.js';
import type { InternalSessionUser } from '../../src/modules/identity/service.js';
import type { OperationalRole } from '../../src/modules/identity/domain/roles.js';

describe('IdentityService.updateUserRoles Seam', () => {
  let pool: Pool;
  let identityService: IdentityService;
  let smsSender: InMemorySmsSender;

  beforeAll(async () => {
    const config = loadConfig({}, { loadDotenv: false });
    pool = createDbPool({ connectionString: config.testDatabaseUrl });
    smsSender = new InMemorySmsSender();
    identityService = new IdentityService(pool, smsSender, {
      jwtSecret: 'test-secret',
      jwtExpiresIn: '1h',
      otpTtlSeconds: 120,
      otpRateLimitMaxAttempts: 5,
      otpRateLimitWindowSeconds: 60,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM internal_sessions');
    await pool.query('DELETE FROM user_invites');
    await pool.query('DELETE FROM otp_requests');
    await pool.query('DELETE FROM user_accounts');
  });

  async function createTestUser(email: string, phone: string, roles: string[] = []) {
    const res = await pool.query<{ id: string; email: string; phone: string; roles: string[] }>(
      `
      INSERT INTO user_accounts (email, phone, password_hash, roles, status)
      VALUES ($1, $2, 'dummyhash', $3, 'active')
      RETURNING id, email, phone, roles;
      `,
      [email, phone, roles],
    );
    return res.rows[0]!;
  }

  it('allows granter to grant roles that they hold', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin.catalog@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin', 'catalog'],
      mfaVerified: true,
    };

    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', []);

    const updated = await identityService.updateUserRoles({
      userId: targetUser.id,
      granterUser: granter,
      roles: ['catalog'],
    });

    expect(updated.roles).toEqual(['catalog']);

    const persisted = await identityService.getUserById(targetUser.id);
    expect(persisted?.roles).toEqual(['catalog']);
  });

  it('rejects granter from granting roles they do NOT hold with ForbiddenError', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'pure.admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', []);

    await expect(
      identityService.updateUserRoles({
        userId: targetUser.id,
        granterUser: granter,
        roles: ['finance'],
      }),
    ).rejects.toThrow(ForbiddenError);

    const persisted = await identityService.getUserById(targetUser.id);
    expect(persisted?.roles).toEqual([]);
  });

  it('allows granter to revoke roles even if granter does not hold the revoked role', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'pure.admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', ['finance']);

    const updated = await identityService.updateUserRoles({
      userId: targetUser.id,
      granterUser: granter,
      roles: [],
    });

    expect(updated.roles).toEqual([]);
  });

  it('allows granter to grant role A (which they hold) while retaining existing role B', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin.catalog@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin', 'catalog'],
      mfaVerified: true,
    };

    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', ['finance']);

    const updated = await identityService.updateUserRoles({
      userId: targetUser.id,
      granterUser: granter,
      roles: ['finance', 'catalog'],
    });

    expect(updated.roles).toContain('finance');
    expect(updated.roles).toContain('catalog');
  });

  it('throws NotFoundError when target user does not exist', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    await expect(
      identityService.updateUserRoles({
        userId: '11111111-1111-1111-1111-111111111111',
        granterUser: granter,
        roles: [],
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError when userId format is not a valid UUID', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    await expect(
      identityService.updateUserRoles({
        userId: 'not-a-valid-uuid',
        granterUser: granter,
        roles: [],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError with fieldErrors when roles is not an array', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', []);

    await expect(
      identityService.updateUserRoles({
        userId: targetUser.id,
        granterUser: granter,
        roles: 'not-an-array' as unknown as OperationalRole[],
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      fieldErrors: [{ field: 'roles' }],
    });
  });

  it('throws ValidationError when role name is invalid', async () => {
    const granter: InternalSessionUser = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@marketplace.ir',
      phone: '+989121110001',
      roles: ['access-admin'],
      mfaVerified: true,
    };

    const targetUser = await createTestUser('target@marketplace.ir', '+989120000002', []);

    await expect(
      identityService.updateUserRoles({
        userId: targetUser.id,
        granterUser: granter,
        roles: ['super-god-role' as unknown as OperationalRole],
      }),
    ).rejects.toThrow(ValidationError);
  });
});
```

---

#### 3. Full HTTP Matrix Integration Tests: `tests/integration/rbac-role-enforcement.test.ts`

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
import type { OperationalRole } from '../../src/modules/identity/domain/roles.js';

describe('RBAC & Internal Role Middleware Integration', () => {
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
        jwtSecret: 'test-rbac-secret-key-that-is-long-enough',
        otpTtlSeconds: 120,
        otpRateLimitMaxAttempts: 5,
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

  async function createVerifiedUserWithRoles(
    email: string,
    phone: string,
    roles: OperationalRole[],
  ): Promise<{ sessionToken: string; userId: string; email: string }> {
    const userRes = await pool.query<{ id: string }>(
      `
      INSERT INTO user_accounts (email, phone, password_hash, roles, status)
      VALUES ($1, $2, 'dummyhash', $3, 'active')
      RETURNING id;
      `,
      [email, phone, roles],
    );
    const userId = userRes.rows[0]!.id;

    const sessionToken = `test-token-${email.replace(/[^a-z0-9]/gi, '')}-${Date.now()}-${Math.random()}`;
    await pool.query(
      `
      INSERT INTO internal_sessions (user_id, session_token, mfa_verified, expires_at)
      VALUES ($1, $2, TRUE, NOW() + INTERVAL '24 hours');
      `,
      [userId, sessionToken],
    );

    return { sessionToken, userId, email };
  }

  describe('Unauthenticated and Unverified Access Rejections', () => {
    const internalEndpoints = [
      { method: 'get', path: '/api/v1/admin/me' },
      { method: 'get', path: '/api/v1/admin/sellers' },
      { method: 'get', path: '/api/v1/admin/catalog' },
      { method: 'get', path: '/api/v1/admin/orders' },
      { method: 'get', path: '/api/v1/admin/support' },
      { method: 'get', path: '/api/v1/admin/finance' },
      { method: 'post', path: '/api/v1/admin/users/invite' },
      { method: 'post', path: '/api/v1/admin/users/00000000-0000-0000-0000-000000000001/roles' },
    ];

    it.each(internalEndpoints)(
      'rejects unauthenticated request to $method $path with 401 Unauthorized',
      async ({ method, path }) => {
        const res =
          method === 'get' ? await request(app).get(path) : await request(app).post(path).send({});
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
      },
    );

    it('rejects unverified MFA sessions with 403 MFA_REQUIRED', async () => {
      const userRes = await pool.query<{ id: string }>(
        `
        INSERT INTO user_accounts (email, phone, roles, status)
        VALUES ('unverified@marketplace.ir', '+989129998877', ARRAY['catalog'], 'active')
        RETURNING id;
        `,
      );
      const userId = userRes.rows[0]!.id;

      const unverifiedToken = 'unverified-session-token-xyz';
      await pool.query(
        `
        INSERT INTO internal_sessions (user_id, session_token, mfa_verified, expires_at)
        VALUES ($1, $2, FALSE, NOW() + INTERVAL '1 hour');
        `,
        [userId, unverifiedToken],
      );

      const res = await request(app)
        .get('/api/v1/admin/catalog')
        .set('Authorization', `Bearer ${unverifiedToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MFA_REQUIRED');
    });
  });

  describe('Operational Role Matrix & Boundary Enforcement', () => {
    const roleRoutes: Array<{
      role: OperationalRole;
      method: 'get' | 'post';
      path: string;
      body?: Record<string, unknown>;
      name: string;
    }> = [
      {
        role: 'seller-mgmt',
        method: 'get',
        path: '/api/v1/admin/sellers',
        name: 'Seller Management',
      },
      { role: 'catalog', method: 'get', path: '/api/v1/admin/catalog', name: 'Catalog' },
      { role: 'order-ops', method: 'get', path: '/api/v1/admin/orders', name: 'Order Operations' },
      { role: 'support', method: 'get', path: '/api/v1/admin/support', name: 'Support' },
      { role: 'finance', method: 'get', path: '/api/v1/admin/finance', name: 'Finance' },
      {
        role: 'access-admin',
        method: 'post',
        path: '/api/v1/admin/users/invite',
        body: { email: 'cross.invite@marketplace.ir', phone: '09128881122' },
        name: 'Access Admin',
      },
    ];

    it('allows each single role to reach its dedicated route group', async () => {
      for (let i = 0; i < roleRoutes.length; i++) {
        const target = roleRoutes[i]!;
        const user = await createVerifiedUserWithRoles(
          `${target.role}@marketplace.ir`,
          `+9891200000${i + 10}`,
          [target.role],
        );

        if (target.method === 'get') {
          const res = await request(app)
            .get(target.path)
            .set('Authorization', `Bearer ${user.sessionToken}`);

          expect(res.status).toBe(200);
          expect(res.body.status).toBe('ok');
          expect(res.body.group).toBe(target.role);
        } else {
          const res = await request(app)
            .post(target.path)
            .set('Authorization', `Bearer ${user.sessionToken}`)
            .send(target.body);

          expect(res.status).toBe(201);
          expect(res.body.success).toBe(true);
        }
      }
    });

    it('rejects each single role from every OTHER role route group with 403 Forbidden', async () => {
      for (let i = 0; i < roleRoutes.length; i++) {
        const currentUserDef = roleRoutes[i]!;
        const user = await createVerifiedUserWithRoles(
          `isolated.${currentUserDef.role}@marketplace.ir`,
          `+9891211100${i + 20}`,
          [currentUserDef.role],
        );

        for (const targetRoute of roleRoutes) {
          if (targetRoute.role !== currentUserDef.role) {
            const req =
              targetRoute.method === 'get'
                ? request(app).get(targetRoute.path)
                : request(app).post(targetRoute.path).send(targetRoute.body);

            const res = await req.set('Authorization', `Bearer ${user.sessionToken}`);

            expect(res.status).toBe(403);
            expect(res.body.code).toBe('FORBIDDEN');
          }
        }
      }
    });
  });

  describe('Separation of Duties (SoD): access-admin Exclusions', () => {
    it('strictly forbids access-admin from reaching finance routes', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.alone@marketplace.ir',
        '+989123000001',
        ['access-admin'],
      );

      const res = await request(app)
        .get('/api/v1/admin/finance')
        .set('Authorization', `Bearer ${admin.sessionToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('strictly forbids access-admin from reaching order-ops routes', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.alone2@marketplace.ir',
        '+989123000002',
        ['access-admin'],
      );

      const res = await request(app)
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${admin.sessionToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('strictly excludes access-admin from finance even if assigned BOTH access-admin and finance', async () => {
      const dualUser = await createVerifiedUserWithRoles(
        'admin.finance.dual@marketplace.ir',
        '+989123000003',
        ['access-admin', 'finance'],
      );

      const res = await request(app)
        .get('/api/v1/admin/finance')
        .set('Authorization', `Bearer ${dualUser.sessionToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('strictly excludes access-admin from order-ops even if assigned BOTH access-admin and order-ops', async () => {
      const dualUser = await createVerifiedUserWithRoles(
        'admin.ops.dual@marketplace.ir',
        '+989123000004',
        ['access-admin', 'order-ops'],
      );

      const res = await request(app)
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${dualUser.sessionToken}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  describe('Role Management Endpoint (POST /api/v1/admin/users/:id/roles)', () => {
    it('rejects non-access-admin caller with 403 Forbidden', async () => {
      const nonAdmin = await createVerifiedUserWithRoles(
        'finance.user@marketplace.ir',
        '+989124000001',
        ['finance'],
      );

      const target = await createVerifiedUserWithRoles(
        'target.user@marketplace.ir',
        '+989124000002',
        ['support'],
      );

      const res = await request(app)
        .post(`/api/v1/admin/users/${target.userId}/roles`)
        .set('Authorization', `Bearer ${nonAdmin.sessionToken}`)
        .send({ roles: ['support', 'catalog'] });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('rejects access-admin from granting roles they do NOT hold', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.only@marketplace.ir',
        '+989124000003',
        ['access-admin'],
      );

      const target = await createVerifiedUserWithRoles(
        'target.user2@marketplace.ir',
        '+989124000004',
        ['support'],
      );

      const res = await request(app)
        .post(`/api/v1/admin/users/${target.userId}/roles`)
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({ roles: ['support', 'finance'] });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');

      const targetInDb = await identityService.getUserById(target.userId);
      expect(targetInDb?.roles).toEqual(['support']);
    });

    it('allows access-admin to grant roles they DO hold', async () => {
      const privilegedAdmin = await createVerifiedUserWithRoles(
        'admin.catalog@marketplace.ir',
        '+989124000005',
        ['access-admin', 'catalog'],
      );

      const target = await createVerifiedUserWithRoles(
        'target.user3@marketplace.ir',
        '+989124000006',
        ['support'],
      );

      const res = await request(app)
        .post(`/api/v1/admin/users/${target.userId}/roles`)
        .set('Authorization', `Bearer ${privilegedAdmin.sessionToken}`)
        .send({ roles: ['support', 'catalog'] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.roles).toContain('support');
      expect(res.body.user.roles).toContain('catalog');

      const targetInDb = await identityService.getUserById(target.userId);
      expect(targetInDb?.roles).toContain('catalog');
    });

    it('allows access-admin to revoke roles from a user', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.revoker@marketplace.ir',
        '+989124000007',
        ['access-admin'],
      );

      const target = await createVerifiedUserWithRoles(
        'target.user4@marketplace.ir',
        '+989124000008',
        ['catalog', 'support'],
      );

      const res = await request(app)
        .post(`/api/v1/admin/users/${target.userId}/roles`)
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({ roles: ['catalog'] });

      expect(res.status).toBe(200);
      expect(res.body.user.roles).toEqual(['catalog']);

      const targetInDb = await identityService.getUserById(target.userId);
      expect(targetInDb?.roles).toEqual(['catalog']);
    });

    it('returns 404 NOT_FOUND when target user does not exist', async () => {
      const admin = await createVerifiedUserWithRoles(
        'admin.lookup@marketplace.ir',
        '+989124000009',
        ['access-admin'],
      );

      const res = await request(app)
        .post('/api/v1/admin/users/00000000-0000-0000-0000-999999999999/roles')
        .set('Authorization', `Bearer ${admin.sessionToken}`)
        .send({ roles: ['access-admin'] });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });
});
```

---

### How to Verify Locally

Run the following terminal commands to execute the verification pipeline in your repository:

```bash
# 1. Typecheck the TypeScript codebase
npm run typecheck

# 2. Lint for standards conformance
npm run lint

# 3. Check Prettier code formatting
npm run format:check

# 4. Run the unit test suite
npm run test:unit

# 5. Run the integration test suite
npm run test:integration

# 6. Run the full test suite
npm test
```

Expected output:

```text
Test Files  13 passed (13)
     Tests  101 passed (101)
```

---

### Acceptance Checklist

- [x] Six roles defined and stored on user records: `seller-mgmt`, `catalog`, `order-ops`, `support`, `finance`, `access-admin`
- [x] Role middleware factory (`requireRole(...roles)`) applied to every internal route group
- [x] `access-admin` role explicitly excluded from `finance` and `order-ops` route groups even if assigned both
- [x] `POST /api/v1/admin/users/:id/roles` (access-admin only) grants or revokes roles; the granting user cannot grant roles they do not hold
- [x] Integration tests: each role can reach its own routes and is rejected from every other role's routes; `access-admin` cannot reach finance or order-ops routes; unauthenticated requests rejected everywhere
