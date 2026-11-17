# 26: Carrier Handoff Recording

**What to build:** Internal operations staff can manually record parcel carrier handoff events for third-party seller suborders when automated carrier integrations are unavailable, advancing the suborder to shipped status.

**Blocked by:** 25 — Buyer Order & Seller Suborder State Machine

**Status:** ready-for-agent

- [ ] `POST /api/v1/admin/suborders/:id/handoff` (order-ops role) records handoff metadata: carrier name, tracking code, handoff timestamp
- [ ] Validates suborder is currently in `preparing` state before allowing transition to `shipped`
- [ ] Updates suborder tracking attributes and creates an immutable audit event
- [ ] Buyer order view reflects updated shipping status and carrier tracking reference
- [ ] Integration tests verify state advance to `shipped`, persistence of carrier tracking details, and audit record generation
