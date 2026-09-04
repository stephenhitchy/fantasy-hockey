# FF1.21 — Adversarial Draft Readiness Staging Evidence

Status: source candidate; it must be independently reviewed, merged, and bound
to the exact staging Hosting manifest before execution.

## Purpose

FF1.20 proved the positive no-browser and duplicate-delivery path. FF1.21 adds
a separate, guarded staging exercise for the failure and supersession paths of
the already-deployed FF1.19 server readiness state machine. It changes no
Function or application runtime.

The runner refuses Production and every emulator environment, requires the
exact billed staging project and acknowledgement, requires clean Git and an
exact matching live manifest, and checks the bounded D1N fixture before any
write. It uses only the existing Cloud Scheduler job and Projection V11 task
queue.

## Acceptance criteria

1. A delayed or missing-success availability state persists `waiting-injury`,
   keeps the Draft scheduled, keeps the clock stopped, and creates no request
   or pick.
2. Changing the scheduled start while the first request is active or complete
   prevents that request from satisfying readiness for the new start.
3. Changing one synthetic injury record changes the availability revision and
   requires a different request and verified snapshot before readiness returns.
4. A terminal Projection request error creates visible bounded backoff of
   approximately 60 seconds on attempt one while the clock remains stopped.
5. Advancing only that synthetic backoff produces attempt two with a different
   deterministic request and returns to `ready`.
6. Every phase remains on Projection V11, produces zero Draft picks, and never
   changes the Draft to `live`.
7. Success or failure restores the exact synthetic availability input, resets
   the Draft seven days ahead, and preserves projection request/snapshot audit
   records.

## Edge cases and stop conditions

- The run stops before writing if the exact ten-team D1N fixture is absent,
  started, contains picks, has drafted assets, uses a non-V4 scoring version,
  or includes commissioner availability overrides.
- Wrong project, missing acknowledgement, dirty Git, manifest mismatch,
  Scoring/Projection version mismatch, emulator variables, or an invalid
  timeout fails closed.
- The reschedule phase intentionally leaves the old readiness fields present
  while changing only the synthetic start. This is stricter than the normal
  setup path and proves that server compare-and-set logic cannot bind the old
  result to the new schedule.
- Deterministically racing a live Cloud Task is unreliable. The retry phase
  therefore marks only the exact already-verified synthetic request as a
  clearly labelled terminal staging failure, then observes the real scheduled
  worker's backoff and retry behavior. Source tests separately cover a real
  changed-input failure inside Projection generation.
- A scheduler or task timeout fails visibly and invokes cleanup. If the local
  process is force-killed before `finally`, rerun the command or reseed only the
  D1N staging fixture.

## Verification

Run the focused tests with `npm run test:batchff1-5:run`. The inherited release
gate is `npm run verify:batchff1-5`, followed by `npm run build:all`, `git diff
--check`, and `npm run release:verify-clean-deploy-source` from a clean commit.

After independent review, merge, and an exact staging Hosting manifest update,
run:

```bash
FF1_ADVERSARIAL_STAGING_PROJECT_ID=rinkrat-staging-d1nc-2026 \
FF1_ADVERSARIAL_STAGING_ACK=exercise-ff1-draft-readiness-adversarial-in-rinkrat-staging-d1nc-2026 \
npm run staging:ff1:exercise-readiness-adversarial
```

The command uses Application Default Credentials. It does not need or print a
fixture password.

## Deployment resources

This slice changes no Firebase runtime resource. Updating only the site-pinned
staging Hosting target after a clean merge is required to bind evidence to the
exact source revision. Do not deploy Functions, Rules, indexes, TTL, App Check,
queues, workers, or any Production resource.

## Observability

The public result contains bounded booleans, retry seconds, attempt count, and
pick count. It emits no account, player, Draft, request, snapshot, asset, or
availability-revision identity. Detailed request, snapshot, and Draft status
documents remain in isolated staging. The injected request is explicitly
labelled `ff1-readiness-adversarial` so it cannot be mistaken for an organic
runtime failure.

## Rollback

Before execution, revert this tooling-only commit. During execution, `finally`
restores the saved synthetic availability document and resets the synthetic
Draft seven days ahead while clearing readiness/start evidence. Request and
snapshot records stay available under existing retention policies. A staging
Hosting rollback restores the preceding verified manifest; no Function
rollback is associated with FF1.21.

## Protected contracts

FF1.21 does not change Production Scoring V4, Projection V11 formulas or
hashes, six-game ownership, seventh-game rollover, immutable started windows,
Draft pick authority, add/drop, waiver, IR, transaction, standings, playoff,
or scoring authority. It changes no Firestore Rule, index, TTL, App Check mode,
canonical authority, queue mode, worker concurrency, or pending-task limit.
