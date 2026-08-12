# RinkRat Fantasy

Core project references:

- [`docs/RINKRAT_PROJECT_DOCUMENTATION.md`](docs/RINKRAT_PROJECT_DOCUMENTATION.md) — consolidated architecture, release history, deployment, and testing guidance.
- [`docs/RINKRAT_COMPETITIVE_ROADMAP.txt`](docs/RINKRAT_COMPETITIVE_ROADMAP.txt) — permanent completed/in-progress tracker from invite beta through public-scale competition.
- [`docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md`](docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md) — pinned Node/npm toolchain, TTL procedure, exact-build validation export, freeze record, annotated beta tag, and rollback rehearsal.
- [`docs/RINKRAT_BETA_OPERATIONS_RUNBOOK.md`](docs/RINKRAT_BETA_OPERATIONS_RUNBOOK.md) — beta issue severity, triage, public known issues, live evidence, privacy, deployment, and rollback.
- [`docs/RINKRAT_SECURITY_S3C_RUNBOOK.md`](docs/RINKRAT_SECURITY_S3C_RUNBOOK.md) — CI, dependency/secret auditing, CSP report-only, HSTS, TTL, cleanup, and emergency patch procedure.
- [`docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md`](docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md) — Shadow, Canary, staging Primary, production lock, audit, and rollback procedure.
- [`docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md`](docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md) — queued-scoring foundation and remaining high-scale architecture.
- [`docs/RINKRAT_100K_CAPACITY_PLAN.md`](docs/RINKRAT_100K_CAPACITY_PLAN.md) — capacity-model interpretation and staged-load-test sequence.

## Current release and toolchain

The deployed competitive runtime remains **Release Candidate 21 / Beta Operations B1B.1**. B1C is repository-only release tooling; it does not change or redeploy the Angular client, Cloud Functions, Firestore Rules, Scoring V3, or Projection V11.
The inherited runtime family remains **Release Candidate 21 / Beta Operations Batch B1B**, and its exact hotfix verification remains available through `npm run verify:batchb1b-1`.
The inherited security baseline remains available through `npm run verify:batchs3c`.
Named historical checkpoints remain available: `verify:batchr1f`, `verify:batchp1e`, `verify:batchp1f`, `verify:batchp1f-1`, `verify:batchs1a`, `verify:batchs1b`, `verify:batchs1c`, `verify:batchs2a`, `verify:batchs2b`, `verify:batchs3a`, `verify:batchs3a-1`, `verify:batchs3a-2`, `verify:batchs3b`, `verify:batchs3b-1`, `verify:batchb1a`, `verify:batchb1b`, and `verify:batchb1b-1`.

RinkRat pins:

```text
Node 22.23.1
npm 11.17.0
```

Do not automatically follow npm major-version notices. Restore the pinned version unless a named maintenance release deliberately changes `packageManager` and revalidates the complete project.

## Current verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
npm install -g npm@11.17.0
npm ci
npm --prefix functions ci
npm run verify:batchb1c
```

After verification and a clean commit:

```bash
npm run beta:preflight
```

## Beta Operations Batch B1C — Invite-Beta Release Freeze and Rollback Tooling

B1C adds:

- exact Node/npm release preflight;
- live RC21 manifest, HSTS, CSP report-only, App Check, Hosting target, and 9/9 TTL checks;
- exact-build Release Readiness JSON validation;
- explicit GitHub CI, Shadow-mode, and rollback-rehearsal gates;
- ignored `.beta-release/` baseline and rollback records;
- annotated-tag verification against the actual deployed source revision.

B1C has **no Firebase deployment**. Commit and push the tooling, finish the exact RC21 Release Readiness board and full-season simulator, then follow:

```text
docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md
```

## Firestore TTL operating rule

Inspect first:

```bash
npm run security:inspect-ttl -- --project=nhl-fantasy-app-ab673
```

Apply only when a policy is missing, creating, unhealthy, or newly added to the source baseline:

```bash
RINKRAT_APPLY_TTL_SECURITY=APPLY \
npm run security:apply-ttl-baseline -- \
  --project=nhl-fantasy-app-ab673
```

The apply command is idempotent but is not required after every ordinary deployment.
