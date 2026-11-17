# 35: Tax Snapshot & Invoice Linkage Per Line

**What to build:** Snapshot tax rules (VAT rate, exemption status, effective date) at order line level upon checkout, and link each suborder's invoicing record to the seller's verified taxpayer ID to satisfy electronic invoice obligations.

**Blocked by:** 19 — Atomic Multi-Seller Checkout & Inventory Reservation

**Status:** ready-for-agent

- [ ] Configurable tax rule lookup service based on SKU category, taxpayer status, and effective date (not hard-coded)
- [ ] At order placement, immutable tax snapshot stored on each order line: `vat_rate`, `vat_amount`, `is_exempt`, `tax_rule_effective_date`
- [ ] Each seller suborder links to the verified `taxpayer_id` of the seller (or platform for direct sales)
- [ ] Platform generates distinct sales invoice records per suborder tied to the seller's taxpayer ID, plus separate invoice for platform commission
- [ ] Future changes to tax rates do not affect historical line-level tax computations or invoices
- [ ] Integration tests verify line-level tax snapshotting, historical immutability under rate changes, and taxpayer ID linkage
