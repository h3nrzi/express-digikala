# 02: Buyer OTP Auth

**What to build:** A buyer can authenticate using only their Iranian mobile phone number and a one-time code. After verification a short-lived Bearer token is issued. No password is ever set or stored.

**Blocked by:** 01 — Project Scaffold

**Status:** resolved

- [x] `POST /api/v1/auth/otp/send` accepts an Iranian-format phone number, generates a short-lived OTP, and delivers it (adapter-stubbed in tests)
- [x] `POST /api/v1/auth/otp/verify` checks the code and issues a signed short-lived JWT Bearer token on success; rejects expired or wrong codes
- [x] Iranian phone number format validated (11-digit `09xx…` or E.164 `+98xx…`); malformed numbers rejected with a structured error
- [x] Token carries buyer identity and is verified by auth middleware on protected buyer routes
- [x] Rate-limiting on OTP send to prevent abuse (configurable threshold)
- [x] Integration tests cover happy path, wrong code, expired code, malformed phone number, and rate-limit breach
