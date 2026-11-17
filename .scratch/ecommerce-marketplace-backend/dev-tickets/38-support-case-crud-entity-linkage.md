# 38: Support Case CRUD & Order/Return Linkage

**What to build:** Internal operations and support staff can create, manage, and resolve support cases linked to buyer orders, suborders, payments, or returns, enforcing a 4-hour initial response SLA tracking on blocking issues.

**Blocked by:** 04 — Internal Role Middleware & RBAC, 25 — Buyer Order & Seller Suborder State Machine, 30 — Return Request Submission & Withdrawal-Window Enforcement

**Status:** ready-for-agent

- [ ] `POST /api/v1/support/cases` (buyer auth or support role) creates support case with subject, description, priority (`low`, `medium`, `blocking`), and entity linkage (`order_id`, `suborder_id`, `payment_id`, `return_id`)
- [ ] Blocking issues record target initial-response deadline: 4 working hours from intake
- [ ] `GET /api/v1/support/cases` (buyer auth) lists only caller's own support tickets
- [ ] `GET /api/v1/admin/support/cases` (support or order-ops role) lists all tickets with filtering by priority, SLA breach status, and entity
- [ ] `PATCH /api/v1/admin/support/cases/:id` allows internal notes, status transitions (`open`, `in-progress`, `resolved`), and SLA resolution timestamps
- [ ] Integration tests verify cross-entity linkage, SLA deadline calculation, role security, and buyer data isolation
