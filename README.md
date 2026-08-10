# RinkRat Fantasy

Core project references:

- [`docs/RINKRAT_PROJECT_DOCUMENTATION.md`](docs/RINKRAT_PROJECT_DOCUMENTATION.md) — consolidated architecture, update history, deployment, and testing guidance.
- [`docs/RINKRAT_100K_CAPACITY_PLAN.md`](docs/RINKRAT_100K_CAPACITY_PLAN.md) — current capacity-model interpretation and safe staged-test sequence.
- [`docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md`](docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md) — the implemented queued-scoring foundation plus the exact canary, NHL-data, observability, and high-user rollout work that remains.
- [`docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md`](docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md) — exact Shadow, Canary, staging Primary, production lock, audit, and rollback procedure.
- [`docs/RINKRAT_COMPETITIVE_ROADMAP.txt`](docs/RINKRAT_COMPETITIVE_ROADMAP.txt) — permanent completed/in-progress tracker from secure public growth through social features and large-scale readiness.
- [`docs/RINKRAT_SECURITY_S3A_SETUP.md`](docs/RINKRAT_SECURITY_S3A_SETUP.md) — App Check monitor-mode registration, Authentication baseline, recent-login step-up, deployment, and validation runbook.

## Current verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm ci
npm --prefix functions ci
npm run verify:batchs3a
```

The current S3A chain runs the complete S1/S2/R1 history, the App Check monitor-client and token-health checks, stronger registration-password validation, Firebase Authentication policy inspection, recent-login enforcement for protected administrator and destructive actions, Firestore emulator checks, release-manifest validation, and the Angular and Functions builds through the inherited verification chain.


Current release: **Release Candidate 15 / Security S3A.1** — App Check monitor-mode foundation, 12–128 character password baseline, email-enumeration readiness, inline administrator password step-up, and recent-authentication enforcement for high-impact operations.

Inherited release verification remains available through `verify:batchr1f`, `verify:batchs1a`, `verify:batchs1b`, and `verify:batchs1c`; `verify:batchs2a` and `verify:batchs2b` cover server-authoritative Projection V11 generation and Draft-pool integrity; `verify:batchs2b-1` covers the strict TypeScript hotfix; `verify:batchs3a` adds the App Check and Authentication hardening suite; `verify:batchs3a-1` also verifies the configured App Check client state after the public site key is applied.
Earlier queue-control checkpoints remain available through `verify:batchp1e`, `verify:batchp1f`, and `verify:batchp1f-1`.
