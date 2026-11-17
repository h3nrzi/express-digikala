# 17: Delivery Area Validation

**What to build:** Checkout is blocked for any delivery address whose postal code is not in the active coverage allowlist. The allowlist is managed by ops and is configurable without a code deploy.

**Blocked by:** 01 — Project Scaffold

**Status:** ready-for-agent

- [ ] `postal_code_allowlist` table stores covered codes with an optional label (e.g. "Tehran metro"); managed via migration or seed
- [ ] `GET /api/v1/admin/delivery/coverage` (order-ops role) lists all allowed postal codes
- [ ] `POST /api/v1/admin/delivery/coverage` and `DELETE /api/v1/admin/delivery/coverage/:code` (order-ops role) add and remove codes without a deploy
- [ ] `POST /api/v1/delivery/validate` (buyer auth) accepts a postal code and returns whether it is serviceable; used by checkout (ticket 19) and optionally by address save
- [ ] Integration tests: validate in-coverage code → serviceable; validate out-of-coverage code → not serviceable; add code → code becomes serviceable; remove code → code becomes non-serviceable
