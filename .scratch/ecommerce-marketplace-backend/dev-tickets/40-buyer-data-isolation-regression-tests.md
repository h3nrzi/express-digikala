# 40: Buyer Data Isolation Regression Tests

**What to build:** An automated integration regression suite demonstrating strict multi-tenant buyer data isolation: no buyer can read or modify another buyer's orders, cart, addresses, return requests, or support tickets, and unauthenticated requests are strictly rejected.

**Blocked by:** 14 — Cart Persistence & Session Handling, 25 — Buyer Order & Seller Suborder State Machine, 30 — Return Request Submission & Withdrawal-Window Enforcement, 38 — Support Case CRUD & Order/Return Linkage

**Status:** ready-for-agent

- [ ] Suite seeds two distinct authenticated buyers: Buyer A and Buyer B with complete fixtures (cart, addresses, orders, returns, support tickets)
- [ ] Asserts Buyer A receives 403 or 404 when querying Buyer B's cart
- [ ] Asserts Buyer A cannot read, update, or delete Buyer B's saved addresses
- [ ] Asserts Buyer A cannot access or cancel Buyer B's orders or suborders
- [ ] Asserts Buyer A cannot inspect or submit return requests against Buyer B's order lines
- [ ] Asserts Buyer A cannot read Buyer B's support cases
- [ ] Asserts unauthenticated requests across all buyer endpoints are rejected with 401
- [ ] Executable via standard test command `npm run test:security:buyer` and integrated into CI
