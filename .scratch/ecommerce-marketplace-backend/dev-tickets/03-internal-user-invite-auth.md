# 03: Internal User Invite & Personal Account Auth

**What to build:** Operational users are onboarded by invitation; they log in with a personal account and must pass a second-factor check before accessing any internal endpoint. No self-registration.

**Blocked by:** 01 — Project Scaffold

**Status:** ready-for-agent

- [ ] `POST /api/v1/admin/users/invite` (access-admin only placeholder — full RBAC comes in ticket 04) sends an invite to a new operational user
- [ ] Invited user completes account setup (sets credentials) via a time-limited invite token
- [ ] Login endpoint issues a session that is not fully trusted until a second factor is verified
- [ ] Second-factor verification endpoint promotes the session to `mfa-verified`; internal routes reject sessions that have not passed MFA
- [ ] Invite tokens expire and cannot be reused
- [ ] Integration tests cover happy-path invite → setup → login → MFA; expired invite; MFA-unverified session rejected from an internal route
