# 36: Disputed-Amount Withholding from Settlement

**What to build:** When a return request, support case, or claim is opened against an order line, the disputed funds are withheld from the seller's payable settlement balance until the dispute is resolved.

**Blocked by:** 30 — Return Request Submission & Withdrawal-Window Enforcement, 34 — Seller Ledger & Commission Calculation

**Status:** ready-for-agent

- [ ] Opening a return request or disputed support claim marks the contested suborder amount as `withheld_from_settlement`
- [ ] Settlement calculation engine excludes withheld amounts from the payable settlement balance
- [ ] If dispute resolves in buyer's favor (return accepted), withheld amount is permanently debited via refund ledger entry
- [ ] If dispute resolves in seller's favor (return rejected/claim closed), withheld amount is released back to payable balance
- [ ] Settlement withholding events produce an audit trail entry
- [ ] Integration tests verify withholding on dispute opening, exclusion from payable totals, and proper debit/release upon dispute resolution
