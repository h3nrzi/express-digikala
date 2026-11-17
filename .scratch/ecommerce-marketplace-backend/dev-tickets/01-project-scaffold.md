# 01: Project Scaffold

**What to build:** Bootstrap the entire repository so every subsequent ticket has a working foundation to build on. A developer should be able to clone the repo, run one command, and have a local Postgres instance, a passing empty test suite, and a linting check — all green.

**Blocked by:** None (can start immediately)

**Status:** completed

- [x] TypeScript project initialised with strict mode; ESLint and Prettier configured and passing on an empty codebase
- [x] Docker Compose brings up a Postgres instance; connection verified in a smoke test
- [x] Migration runner integrated (e.g. db-migrate or similar); at least one baseline migration applied cleanly
- [x] Test harness configured (integration test runner pointing at a test database, unit test runner for pure functions); `npm test` exits green on an empty suite
- [x] CI pipeline stub runs lint, type-check, and tests on every push; pipeline is green
- [x] `README` documents the one-command local setup
