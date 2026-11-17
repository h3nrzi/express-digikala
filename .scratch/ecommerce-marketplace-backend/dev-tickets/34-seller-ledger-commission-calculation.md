# 34: Seller Ledger & Commission Calculation

**What to build:** Maintain an auditable financial ledger per seller suborder tracking gross sales of kept units, commission deductions (excluding shipping and separately-stated tax), refunds, and net settlement balances.

**Blocked by:** 24 — Late-Success Refund, 29 — Cancellation Refund Initiation, 33 — Return Refund Trigger (Same-Day on Acceptance)

**Status:** ready-for-agent

- [ ] `seller_ledger_entries` table: suborder ID, seller ID, entry type (`gross_sale`, `commission`, `cancellation_refund`, `return_refund`, `adjustment`), amount, tax snapshot reference, timestamp
- [ ] Domain calculation rules:
  - Commission base is computed strictly on item price of kept goods (excludes shipping fees and separately stated VAT)
  - Commission rate is configurable per seller or category (not hard-coded)
- [ ] Return and cancellation refunds generate corresponding debit entries against the seller's gross balance
- [ ] `GET /api/v1/admin/finance/sellers/:id/ledger` (finance role) returns paginated ledger entries with running balance
- [ ] Integration tests verify pure calculation logic, ledger row immutability, and running balance accuracy across order lifecycle events
