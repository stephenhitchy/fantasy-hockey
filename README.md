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
npm run verify:batchs1a
```

The current S1A chain runs the complete R1F verification history, the new server-authoritative league-creation and immutable-setting tests, Firestore emulator checks, release-manifest validation, and the Angular and Functions builds through the inherited verification chain.


Current release: **Release Candidate 10** — server-authoritative league creation and immutable competition settings.

Inherited release verification remains available through `verify:batchr1f`; `verify:batchs1a` runs that complete chain before the S1A security suite.
Earlier queue-control checkpoints remain available through `verify:batchp1e`, `verify:batchp1f`, and `verify:batchp1f-1`.
