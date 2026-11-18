# 06: Seller Application & Review Lifecycle

**What to build:** Operational staff can record a third-party seller's application and move it through a defined lifecycle. Only sellers in `active` state can have purchasable offers.

**Blocked by:** 04 — Internal Role Middleware & RBAC, 05 — Audit Trail Shared Writer

**Status:** completed

- [x] `POST /api/v1/admin/sellers` (seller-mgmt role) creates a seller application in `pending-review` state
- [x] `PATCH /api/v1/admin/sellers/:id/status` transitions state through the allowed path: `pending-review → under-review → active | rejected`; invalid transitions rejected
- [x] Seller record stores identity fields (name, taxpayer ID, contact); taxpayer ID unique
- [x] Every status transition produces an audit event (actor, previous state, new state, reason)
- [x] `GET /api/v1/admin/sellers` lists sellers filterable by state; `GET /api/v1/admin/sellers/:id` returns full record
- [x] Integration tests cover full lifecycle, invalid transition attempt, and audit entry per transition
