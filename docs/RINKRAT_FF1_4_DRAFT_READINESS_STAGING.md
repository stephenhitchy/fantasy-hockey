# FF1.20 — Guarded Draft Readiness Staging Evidence

Status: source candidate; it must be independently reviewed, merged, and bound
to the exact staging Hosting manifest before execution.

## Purpose

This slice supplies a repeatable, no-browser staging exercise for the FF1.19
server Draft-readiness behavior. It does not alter the Draft worker, Projection
V11, or any deployed runtime. The runner refuses Production, requires the exact
isolated staging project and acknowledgement, requires clean Git, and requires
the live staging manifest to match that exact commit.

## Acceptance criteria

1. The minute worker begins preparation inside the T-20 window without an open
   browser.
2. The exact fresh daily availability revision and its deterministic
   Projection V11 request reach `ready` before zero.
3. The Draft stays `scheduled`, the clock stays stopped, and no pick is created.
4. Duplicate scheduler delivery retains one request, snapshot, hash, and
   attempt identity.
5. Public output contains bounded statuses and counts only; it contains no
   account, player, Draft, request, snapshot, or availability-revision ID.
6. Success or failure restores the synthetic Draft seven days ahead and clears
   readiness/start fields so the exercise cannot later start accidentally.
7. Projection request and snapshot records are preserved for audit.

## Edge cases and stop conditions

- The runner stops before writing if the fixture is missing, has a non-V4
  league, contains a Draft pick, contains commissioner availability overrides,
  has started, or is not the exact bounded ten-team D1N fixture.
- A dirty worktree, manifest mismatch, wrong model version, wrong project,
  Emulator environment, bad acknowledgement, or invalid timeout fails closed.
- A task error, changed request identity, changed snapshot identity, clock
  start, or pick creation fails the run and still invokes cleanup.
- Old projection requests and snapshots are not deleted. They are evidence and
  remain subject to the existing retention policies.

## Verification

Run the focused source suite with `npm run test:batchff1-4:run`. The inherited
release gate is `npm run verify:batchff1-4`, followed by `npm run build:all`,
`git diff --check`, and `npm run release:verify-clean-deploy-source` from a
clean commit.

After the exact commit is merged and the staging Hosting manifest matches it,
Stephen may run:

```bash
FF1_READINESS_STAGING_PROJECT_ID=rinkrat-staging-d1nc-2026 \
FF1_READINESS_STAGING_ACK=exercise-ff1-draft-readiness-in-rinkrat-staging-d1nc-2026 \
npm run staging:ff1:exercise-readiness
```

The command uses Application Default Credentials and the existing Cloud
Scheduler job. It does not require or print the fixture password.

## Deployment resources

No Firebase runtime resource changes in this slice. To bind the evidence to its
exact source commit, update only the site-pinned staging Hosting target after a
clean merge; do not redeploy Functions, Rules, indexes, TTL, App Check, queues,
or workers. No Production deployment is required.

## Observability

The runner checks the existing Draft readiness status, attempt count, exact
request status, exact snapshot/hash relationship, clock state, and bounded pick
count. Its terminal report exposes only aggregate booleans, statuses, and
counts. Existing request, projection snapshot, and Draft automation documents
remain the detailed server audit trail.

## Rollback

Before execution, rollback is a reviewed revert of this tooling-only commit.
During execution, the `finally` cleanup resets the exact synthetic Draft seven
days ahead and removes readiness/start evidence from the Draft document while
preserving request and snapshot audit records. If the process is terminated
before cleanup, rerun the command or reseed only the D1N synthetic staging
fixture. Do not edit a real league or Production Firestore.

## Protected contracts

This slice does not change Production Scoring V4, Projection V11, six-game
ownership, Game 7 rollover, immutable started windows, Draft pick authority,
transactions, standings, playoffs, Firestore Rules, indexes, TTL, App Check,
canonical authority, queue mode, worker concurrency, or pending-task limits.
