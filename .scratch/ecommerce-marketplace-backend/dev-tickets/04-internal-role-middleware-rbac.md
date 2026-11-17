# 04: Internal Role Middleware & RBAC

**What to build:** Every internal API route is guarded by a role check. The six operational roles are enforced at the middleware layer: a user without the required role receives a 403; an unauthenticated request receives a 401. The access-admin role explicitly cannot perform financial or order operations.

**Blocked by:** 03 — Internal User Invite & Personal Account Auth

**Status:** ready-for-agent

- [ ] Six roles defined and stored on user records: `seller-mgmt`, `catalog`, `order-ops`, `support`, `finance`, `access-admin`
- [ ] Role middleware factory (`requireRole(...roles)`) applied to every internal route group
- [ ] `access-admin` role explicitly excluded from `finance` and `order-ops` route groups even if assigned both
- [ ] `POST /api/v1/admin/users/:id/roles` (access-admin only) grants or revokes roles; the granting user cannot grant roles they do not hold
- [ ] Integration tests: each role can reach its own routes and is rejected from every other role's routes; `access-admin` cannot reach finance or order-ops routes; unauthenticated requests rejected everywhere
