# 37: Weekly Settlement Run & Finance Confirmation Gate

**What to build:** An automated periodic settlement engine that aggregates net payable balances per seller, surfaces draft runs for authorized finance review, and requires explicit confirmation before payout initiation.

**Blocked by:** 34 — Seller Ledger & Commission Calculation, 35 — Tax Snapshot & Invoice Linkage Per Line, 36 — Disputed-Amount Withholding from Settlement

**Status:** ready-for-agent

- [ ] Periodic scheduled job generates a draft settlement run for the prior week per active seller: gross sales − commissions − refunds − withheld amounts
- [ ] `GET /api/v1/admin/finance/settlements` (finance role) lists draft and finalized settlement runs
- [ ] `GET /api/v1/admin/finance/settlements/:id` displays itemized breakdown of included suborders and deductions
- [ ] `POST /api/v1/admin/finance/settlements/:id/confirm` requires finance role and `Idempotency-Key`; finalizes the settlement run and queues bank payout task
- [ ] Unauthorized users or non-finance internal roles receive 403 on confirmation attempt
- [ ] Audit trail records confirmation with confirming user ID and finalized totals
- [ ] Integration tests verify aggregation accuracy, withholding deduction, finance confirmation gate, and idempotency of payout dispatch
