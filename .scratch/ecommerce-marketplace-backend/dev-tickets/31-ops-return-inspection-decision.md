# 31: Ops Return Inspection & Accept/Reject Per Unit

**What to build:** Internal operations staff can record physical inspection outcomes for returned parcels, accepting or rejecting individual units. Only accepted units that pass physical inspection restore resalable inventory.

**Blocked by:** 04 — Internal Role Middleware & RBAC, 30 — Return Request Submission & Withdrawal-Window Enforcement

**Status:** ready-for-agent

- [ ] `POST /api/v1/admin/returns/:id/inspection` (order-ops role) records inspection counts: `inspected_quantity`, `accepted_quantity`, `rejected_quantity`, inspection notes
- [ ] Enforces `accepted_quantity + rejected_quantity == inspected_quantity <= requested_quantity`
- [ ] For units accepted as resalable, atomically increments seller offer `physical_count`
- [ ] Defective/damaged units do NOT increment available inventory
- [ ] Records detailed audit trail entry with inspector ID, unit counts, and inspection notes
- [ ] Transitions return request to `inspected` / `decision-rendered` state
- [ ] Integration tests verify partial acceptance/rejection, inventory restoration only for resalable units, and strict count validation
