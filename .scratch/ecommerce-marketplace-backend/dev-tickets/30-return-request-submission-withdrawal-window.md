# 30: Return Request Submission & Withdrawal-Window Enforcement

**What to build:** An authenticated buyer can submit a return request for delivered order lines within the statutory 7-working-day withdrawal window. Return status is tracked separately from parcel delivery status, and defect claims are routed directly to support claims.

**Blocked by:** 02 — Buyer OTP Auth, 25 — Buyer Order & Seller Suborder State Machine

**Status:** ready-for-agent

- [ ] `POST /api/v1/returns` (buyer auth) requires `Idempotency-Key` and accepts suborder ID, line ID, quantity, and reason
- [ ] Validates suborder is in `delivered` state
- [ ] Calculates statutory withdrawal window: at least 7 working days starting from the later of delivery timestamp and required information provision timestamp (tagged with provisional-policy marker)
- [ ] Requests submitted past withdrawal window are rejected unless flagged as defect/wrong-item (which automatically routes to a support claim instead)
- [ ] Creates `return_request` entity tracking `requested_quantity`; parcel delivery status remains `delivered`
- [ ] Original order quantity remains completely immutable
- [ ] Integration tests verify window calculation, defect rerouting, independent return state creation, and buyer ownership validation
