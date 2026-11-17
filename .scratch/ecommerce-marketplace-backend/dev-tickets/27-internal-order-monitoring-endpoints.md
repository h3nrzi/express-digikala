# 27: Internal Order Monitoring Endpoints

**What to build:** Operational endpoints for internal order-operations staff to inspect, filter, and monitor all buyer orders and seller suborders across the platform to prioritize fulfillment tasks and identify delayed parcels.

**Blocked by:** 25 — Buyer Order & Seller Suborder State Machine

**Status:** ready-for-agent

- [ ] `GET /api/v1/admin/orders` (order-ops role) supports cursor-based pagination and filtering by state, buyer ID, date range
- [ ] `GET /api/v1/admin/suborders` (order-ops role) filters by suborder state, seller ID, and preparation/shipping age
- [ ] `GET /api/v1/admin/orders/:id` returns comprehensive order detail including customer info, payment refs, audit history link, and all suborders
- [ ] Role enforcement restricts endpoint access strictly to authorized internal roles (`order-ops`, `support`)
- [ ] Integration tests verify multi-criteria filtering, cursor pagination, and role security boundaries
