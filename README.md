# RinkRat Fantasy

Core project references:

- [`docs/RINKRAT_PROJECT_DOCUMENTATION.md`](docs/RINKRAT_PROJECT_DOCUMENTATION.md) — consolidated architecture, release history, deployment, and testing guidance.
- [`docs/RINKRAT_COMPETITIVE_ROADMAP.txt`](docs/RINKRAT_COMPETITIVE_ROADMAP.txt) — permanent completed/in-progress tracker from invite beta through public-scale competition.
- [`docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md`](docs/RINKRAT_INVITE_BETA_RELEASE_RUNBOOK.md) — pinned Node/npm toolchain, TTL procedure, exact-build validation export, freeze record, annotated beta tag, and application rollback rehearsal.
- [`docs/RINKRAT_FIRESTORE_BACKUP_RESTORE_RUNBOOK.md`](docs/RINKRAT_FIRESTORE_BACKUP_RESTORE_RUNBOOK.md) — native backup schedules, delete protection, optional PITR, named-database restore drills, verification, cleanup, and recovery evidence.
- [`docs/RINKRAT_BETA_OPERATIONS_RUNBOOK.md`](docs/RINKRAT_BETA_OPERATIONS_RUNBOOK.md) — beta issue severity, triage, public known issues, live evidence, privacy, deployment, and rollback.
- [`docs/RINKRAT_SECURITY_S3C_RUNBOOK.md`](docs/RINKRAT_SECURITY_S3C_RUNBOOK.md) — CI, dependency/secret auditing, CSP report-only, HSTS, TTL, cleanup, and emergency patch procedure.
- [`docs/RINKRAT_SECURITY_S3D_IDENTIFIER_BOUNDARIES.md`](docs/RINKRAT_SECURITY_S3D_IDENTIFIER_BOUNDARIES.md) — Firestore identifier policies, task/trigger boundary rules, static audit, deployment, and rollback.
- [`docs/RINKRAT_SECURITY_S3E_APP_CHECK_READINESS.md`](docs/RINKRAT_SECURITY_S3E_APP_CHECK_READINESS.md) — exact-build App Check evidence gates, supported-browser matrix, selected-callable canary handoff, compact mobile injury status, deployment, and rollback.
- [`docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md`](docs/RINKRAT_SCORING_QUEUE_ROLLOUT_RUNBOOK.md) — Shadow, Canary, staging Primary, production lock, audit, and rollback procedure.
- [`docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md`](docs/RINKRAT_HIGH_SCALE_AUTOMATION_BLUEPRINT.md) — queued-scoring foundation and remaining high-scale architecture.
- [`docs/RINKRAT_100K_CAPACITY_PLAN.md`](docs/RINKRAT_100K_CAPACITY_PLAN.md) — capacity-model interpretation and staged-load-test sequence.

## Current release and toolchain

The current runtime family is **Release Candidate 23 / Security Batch S3E**. S3E converts App Check monitor traffic into an exact-build readiness matrix across supported browsers, device classes, generalized platforms, manager-days, and high-value competitive actions. It never enables enforcement automatically; a later release must deliberately begin a selected-callable canary after the documented evidence gates pass.

The same release fixes the mobile Matchup injury presentation: an injured player now shows a compact icon, short status, and expected return date instead of a long injury article. Full injury detail remains available on the player detail page.

The competitive models remain **Scoring V3** and **Projection V11**. Draft rankings, six-game windows, roster timing, scoring behavior, Firestore Rules, and indexes are unchanged. The inherited security chains remain available through `npm run verify:batchs3d`, with `npm run verify:batchs3e` as the current verification command.

Historical verification checkpoints remain available and intentionally stay documented for regression and rollback work:

```text
verify:batchr1f
verify:batchp1e
verify:batchp1f
verify:batchp1f-1
verify:batchs1a
verify:batchs1b
verify:batchs1c
verify:batchs2a
verify:batchs2a-1
verify:batchs2b
verify:batchs2b-1
verify:batchs3a
verify:batchs3a-1
verify:batchs3a-2
verify:batchs3b
verify:batchs3b-1
verify:batchs3c
verify:batchb1a
verify:batchb1b
verify:batchb1b-1
verify:batchb1c
verify:batchs4a
verify:batchb1d
verify:batchs3d
verify:batchs3e
```

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
npm run verify:batchs3e
```

After verification and a clean commit:

```bash
npm run beta:preflight
```


## Security Batch S3E — Exact-Build App Check Readiness and Mobile Injury Clarity

S3E adds a monitor-only readiness gate to Admin Center → Live Evidence. The server evaluates only evidence produced by the exact deployed build and reports whether the documented sample, browser, device, manager-day, competitive-action, and 99% verification thresholds have been met.

A passing gate means only **ready to plan a selected-callable canary**. It does not turn enforcement on. Firestore App Check enforcement remains a separate later step.

On mobile Matchup rows, injury status is now bounded to a compact presentation such as:

```text
✚ IR · Return Sep 15
✚ Out · Return TBD
```

The full article remains on the player detail page instead of occupying the matchup lineup.

Verification:

```bash
npm run verify:batchs3e
```

Deployment requires Functions first, then Hosting:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Security S3E App Check readiness evidence"
firebase deploy --only hosting:app -m "Security S3E RC23 readiness and mobile injury clarity"
```

No Firestore Rules or index deployment is required.

## Security Batch S3D — Universal Firestore Identifier Boundary Closure

S3D adds one shared normalized resolver, server-side path guards, semantic policies for league/user/request/task/pick/slot/asset/snapshot/catalog/invite/player/feedback/fingerprint IDs, and a source-controlled boundary inventory covering 13 authority modules.

The static audit rejects direct interpolation of `event.params`, `request.auth.uid`, `request.data`, or Cloud Tasks payload IDs into Firestore paths. It also verifies every task/trigger surface uses the shared resolver and that projection/Draft/replay cross-references are validated before lookup.

Verification:

```bash
npm run verify:batchs3d
```

Deployment requires Functions first, then Hosting so the current RC22 release identity and documentation match the hardened server authorities:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only functions -m "Security S3D Firestore identifier boundary closure"
firebase deploy --only hosting:app -m "Security S3D Release Candidate 22"
```

No Firestore Rules or index deployment is required.

## Onboarding Batch B1D — Big-Play Winger Comparison Clarity

B1D replaces the football-specific label **outside wide receivers** with the more beginner-friendly **big-play wide receivers** and leads with the plain-language idea **fewer chances, bigger scoring swings**. The card explains that one limited opportunity can create a strong fantasy week, while missed chances can produce a much quieter matchup.

Verification:

```bash
npm run verify:batchb1d
```

Deployment is Hosting-only:

```bash
firebase use nhl-fantasy-app-ab673
firebase deploy --only hosting:app -m "Onboarding B1D big-play winger comparison"
```

## Security Operations Batch S4A — Firestore Backup and Restore Rehearsal

S4A adds repository-controlled disaster-recovery operations without changing the then-current RC21 application runtime:

- production Firestore delete-protection inspection and guarded activation;
- daily backups retained 14 days;
- weekly Sunday backups retained 12 weeks;
- safe refusal when an existing daily/weekly recurrence conflicts with the baseline;
- optional, separately confirmed PITR activation;
- newest-READY-backup selection and restore planning;
- restore only into a new `restore-drill-*` database;
- privacy-limited comparison of critical collections and sampled league contracts;
- guarded restore-drill cleanup;
- source-controlled TTL field overrides so future index deployments preserve all nine active policies.

Inspect the baseline:

```bash
npm run security:backup:inspect -- --project=nhl-fantasy-app-ab673
```

Follow the full rehearsal sequence in:

```text
docs/RINKRAT_FIRESTORE_BACKUP_RESTORE_RUNBOOK.md
```

S4A has **no Angular, Functions, Rules, or Hosting deployment**. Google Cloud backup schedules, delete protection, optional PITR, and a temporary named restore database are managed only through the guarded operator commands in the runbook.

## Beta Operations Batch B1C — Invite-Beta Release Freeze and Rollback Tooling

B1C adds:

- exact Node/npm release preflight;
- live RC23 manifest, HSTS, CSP report-only, App Check, Hosting target, and 9/9 TTL checks;
- exact-build Release Readiness JSON validation;
- explicit GitHub CI, Shadow-mode, and rollback-rehearsal gates;
- ignored `.beta-release/` baseline and rollback records;
- annotated-tag verification against the actual deployed source revision.

B1C has **no Firebase deployment**. Commit and push the tooling, finish the exact RC23 Release Readiness board and full-season simulator, then follow:

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

The apply command is idempotent but is not required after every ordinary deployment. Keep the local index configuration synchronized with the same policies:

```bash
npm run security:sync-ttl-index-config -- --check
```
