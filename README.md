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
npm run verify:batchb1a
```

The current B1A chain runs the complete S1/S2/S3B.1/R1 history, the App Check monitor-client and token-health checks, dynamic Firebase password-policy guidance, shared Firestore document-ID validation, App Check-aware NHL proxy abuse protection, the new Training Camp fantasy-football position guide checks, Firestore emulator checks, release-manifest validation, and the Angular and Functions builds through the inherited verification chain.


Current release: **Release Candidate 19 / Onboarding Batch B1A** — adds a fantasy-football position translation to Training Camp while preserving Security S3B.1 pregame roster timing, password-policy guidance, document-ID validation, and NHL proxy hardening.

Inherited release verification remains available through `verify:batchr1f`, `verify:batchs1a`, `verify:batchs1b`, and `verify:batchs1c`; `verify:batchs2a` and `verify:batchs2b` cover server-authoritative Projection V11 generation and Draft-pool integrity; `verify:batchs2b-1` covers the strict TypeScript hotfix; `verify:batchs3a` adds the App Check and Authentication hardening suite; `verify:batchs3a-1` verifies the configured App Check client state after the public site key is applied; `verify:batchs3a-2` adds the roster-overlay teardown and readiness-guidance hotfix. `verify:batchs3b` adds the dynamic password-policy, document-ID validation, and NHL proxy security suite; `verify:batchs3b-1` adds pregame historical-replay roster-timing recovery; `verify:batchb1a` adds the Training Camp fantasy-football position translation and beginner/mobile integrity checks.
Earlier queue-control checkpoints remain available through `verify:batchp1e`, `verify:batchp1f`, and `verify:batchp1f-1`.
