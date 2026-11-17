# 07: Seller Suspension & Reinstatement

**What to build:** A seller can be immediately suspended in cases of serious risk; their offers become non-purchasable atomically. Suspension can be lifted (reinstated) by an authorised user.

**Blocked by:** 06 — Seller Application & Review Lifecycle

**Status:** ready-for-agent

- [ ] `POST /api/v1/admin/sellers/:id/suspend` (seller-mgmt role) moves seller to `suspended` state instantly; requires a mandatory reason field
- [ ] All active offers belonging to a suspended seller are marked non-purchasable in the same database transaction
- [ ] `POST /api/v1/admin/sellers/:id/reinstate` returns seller to `active`; offers restored to purchasable
- [ ] Suspension and reinstatement each produce an audit event with reason
- [ ] A suspended seller's offers do not appear in public catalog queries and cannot be added to a cart
- [ ] Integration tests: suspend → offers disappear from public catalog → reinstate → offers reappear; audit entries present for both actions
