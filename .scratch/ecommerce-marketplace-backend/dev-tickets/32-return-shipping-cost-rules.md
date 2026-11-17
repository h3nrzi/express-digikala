# 32: Return Shipping Cost Rules

**What to build:** A configurable business rule engine to determine whether the platform/seller or the buyer bears the cost of return shipping based on the claim type (statutory withdrawal vs defect/fault).

**Blocked by:** 31 — Ops Return Inspection & Accept/Reject Per Unit

**Status:** ready-for-agent

- [ ] Domain service evaluating return shipping liability:
  - If fault is seller or platform (defective, wrong item, damaged on arrival), platform bears return shipping cost
  - If standard withdrawal (change of mind within 7-day window), buyer bears return shipping cost (provisional-policy marker tagged)
- [ ] Evaluates and records shipping deduction/reimbursement on the return decision record
- [ ] Internal configuration allows adjustment of return shipping deduction tariffs without code deploy
- [ ] Integration tests verify shipping cost assignment across both scenarios and inspect recorded liabilities
