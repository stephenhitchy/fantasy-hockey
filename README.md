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
npm run verify:batchs2b-1
```

The current S2B.1 chain runs the complete S1A/S1B/S1C/R1F history, server Projection V11 generation, canonical NHL asset validation, deterministic projection chunk/root hash verification, Draft snapshot pinning, browser-write denial, guarded integrity recovery, the TypeScript control-flow hotfix, Firestore emulator checks, release-manifest validation, and the Angular and Functions builds through the inherited verification chain.


Current release: **Release Candidate 14 / S2B.1 hotfix** — browser read-only projection snapshots, deterministic per-chunk and root hashes, exact Draft snapshot pinning, guarded integrity recovery, safe sealing of valid S2A server snapshots, and strict TypeScript build compatibility.

Inherited release verification remains available through `verify:batchr1f`, `verify:batchs1a`, `verify:batchs1b`, and `verify:batchs1c`; `verify:batchs2a` runs that complete chain before the S2A projection-authority suite; `verify:batchs2a-1` adds the Angular listener type-regression check; `verify:batchs2b` adds the deterministic projection-integrity and Draft hash-enforcement suite; `verify:batchs2b-1` adds the strict TypeScript control-flow regression checks.
Earlier queue-control checkpoints remain available through `verify:batchp1e`, `verify:batchp1f`, and `verify:batchp1f-1`.
