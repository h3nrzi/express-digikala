# 15: Saved Delivery Addresses CRUD

**What to build:** An authenticated buyer can manage a personal address book. Addresses are used at checkout but do not reserve any resource; they are purely buyer-owned data.

**Blocked by:** 02 — Buyer OTP Auth

**Status:** ready-for-agent

- [ ] `POST /api/v1/account/addresses` (buyer auth) creates a saved address; fields: recipient name, phone, province, city, postal code, street address
- [ ] `GET /api/v1/account/addresses` lists the buyer's own addresses only
- [ ] `PATCH /api/v1/account/addresses/:id` updates an address
- [ ] `DELETE /api/v1/account/addresses/:id` soft-deletes; addresses referenced by historical orders are retained
- [ ] A buyer cannot read or modify another buyer's addresses (enforced by filtering on `buyer_id`)
- [ ] Integration tests: create → list → update → delete lifecycle; buyer A cannot access buyer B's addresses
