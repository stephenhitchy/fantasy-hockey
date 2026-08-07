# RinkRat Fantasy

Core project references:

- [`docs/RINKRAT_PROJECT_DOCUMENTATION.md`](docs/RINKRAT_PROJECT_DOCUMENTATION.md) — consolidated architecture, update history, deployment, and testing guidance.
- [`docs/RINKRAT_100K_CAPACITY_PLAN.md`](docs/RINKRAT_100K_CAPACITY_PLAN.md) — current capacity-model interpretation and safe staged-test sequence.
- [`docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md`](docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md) — the implemented queued-scoring foundation plus the exact canary, NHL-data, observability, and high-user rollout work that remains.
- [`docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md`](docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md) — exact Shadow, Canary, staging Primary, production lock, audit, and rollback procedure.
- [`docs/RINKRAT_COMPETITIVE_ROADMAP.txt`](docs/RINKRAT_COMPETITIVE_ROADMAP.txt) — permanent completed/in-progress tracker from secure public growth through social features and large-scale readiness.

## Current verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm ci
npm --prefix functions ci
npm run verify:batchs1b
```

The current S1B chain runs the complete S1A/R1F verification history, atomic server-joining and invite-lock tests, Firestore emulator checks, release-manifest validation, and the Angular and Functions builds through the inherited verification chain.


Current release: **Release Candidate 11** — atomic server-authoritative league joining, Draft-order invite locking, and account lifecycle quotas.

Inherited release verification remains available through `verify:batchr1f` and `verify:batchs1a`; `verify:batchs1b` runs that complete chain before the S1B security suite.
Earlier queue-control checkpoints remain available through `verify:batchp1e`, `verify:batchp1f`, and `verify:batchp1f-1`.
