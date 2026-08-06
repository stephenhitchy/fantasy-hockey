# RinkRat Fantasy

Core project references:

- [`docs/RINKRAT_PROJECT_DOCUMENTATION.md`](docs/RINKRAT_PROJECT_DOCUMENTATION.md) — consolidated architecture, update history, deployment, and testing guidance.
- [`docs/RINKRAT_100K_CAPACITY_PLAN.md`](docs/RINKRAT_100K_CAPACITY_PLAN.md) — current capacity-model interpretation and safe staged-test sequence.
- [`docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md`](docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md) — the implemented queued-scoring foundation plus the exact canary, NHL-data, observability, and high-user rollout work that remains.

## Current verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm ci
npm --prefix functions ci
npm run verify:batchp1e
```

The current chain includes the existing authority, Firestore-rules, design, accessibility, mobile, projection, replay, release-safety, invite-beta launch-gate, and capacity-model checks, followed by the Angular and Functions builds through the inherited verification chain.
