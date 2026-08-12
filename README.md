# RinkRat Fantasy

Core project references:

- [`docs/RINKRAT_PROJECT_DOCUMENTATION.md`](docs/RINKRAT_PROJECT_DOCUMENTATION.md) — consolidated architecture, update history, deployment, and testing guidance.
- [`docs/RINKRAT_100K_CAPACITY_PLAN.md`](docs/RINKRAT_100K_CAPACITY_PLAN.md) — current capacity-model interpretation and safe staged-test sequence.
- [`docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md`](docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md) — the implemented queued-scoring foundation plus the exact canary, NHL-data, observability, and high-user rollout work that remains.
- [`docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md`](docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md) — exact Shadow, Canary, staging Primary, production lock, audit, and rollback procedure.
- [`docs/RINKRAT_COMPETITIVE_ROADMAP.txt`](docs/RINKRAT_COMPETITIVE_ROADMAP.txt) — permanent completed/in-progress tracker from secure public growth through social features and large-scale readiness.
- [`docs/RINKRAT_SECURITY_S3A_SETUP.md`](docs/RINKRAT_SECURITY_S3A_SETUP.md) — App Check monitor-mode registration, Authentication baseline, recent-login step-up, deployment, and validation runbook.
- [`docs/RINKRAT_SECURITY_S3C_RUNBOOK.md`](docs/RINKRAT_SECURITY_S3C_RUNBOOK.md) — CI, dependency/secret auditing, CSP report-only monitoring, HSTS checks, Firestore TTL, scheduled cleanup, and emergency patch procedure.
- [`docs/RINKRAT_BETA_OPERATIONS_RUNBOOK.md`](docs/RINKRAT_BETA_OPERATIONS_RUNBOOK.md) — beta issue severity, triage, public known-issue publishing, evidence interpretation, privacy, deployment, and rollback.

## Current verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm ci
npm --prefix functions ci
npm run verify:batchb1b-1
```

The current B1B.1 chain runs the complete inherited release, emulator, Draft, scoring, projection, roster, App Check, password, NHL proxy, onboarding, CI, CSP, retention, and B1B evidence suites; then verifies the concrete server scoring-duration overview types used to sort trigger aggregates during the Functions TypeScript build.


Manual macOS file replacement is protected by `npm run security:sync-repository-automation`, which restores missing hidden CI files before S3C verification.

Current release: **Release Candidate 21 / Beta Operations Batch B1B.1 TypeScript Build Hotfix** — preserves the complete B1B operations system while correcting the strict Functions TypeScript type for server scoring trigger totals; no beta evidence, scoring, Draft, roster, or privacy behavior changes.

Inherited release verification remains available through `verify:batchr1f`, `verify:batchs1a`, `verify:batchs1b`, and `verify:batchs1c`; `verify:batchs2a` and `verify:batchs2b` cover server-authoritative Projection V11 generation and Draft-pool integrity; `verify:batchs2b-1` covers the strict TypeScript hotfix; `verify:batchs3a` adds the App Check and Authentication hardening suite; `verify:batchs3a-1` verifies the configured App Check client state after the public site key is applied; `verify:batchs3a-2` adds the roster-overlay teardown and readiness-guidance hotfix. `verify:batchs3b` adds the dynamic password-policy, document-ID validation, and NHL proxy security suite; `verify:batchs3b-1` adds pregame historical-replay roster-timing recovery; `verify:batchb1a` adds the Training Camp fantasy-football position translation and beginner/mobile integrity checks; `verify:batchs3c` adds CI, dependency, secret, browser-header, and retention-policy security gates; `verify:batchb1b` adds the Beta Operations Center and live-season evidence checks; `verify:batchb1b-1` adds the strict Functions TypeScript aggregation hotfix check.
Earlier queue-control checkpoints remain available through `verify:batchp1e`, `verify:batchp1f`, and `verify:batchp1f-1`.
