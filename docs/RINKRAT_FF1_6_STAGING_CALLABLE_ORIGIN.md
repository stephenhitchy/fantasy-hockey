# FF1.22 — Exact Staging Callable Origin

Status: source candidate; it must be independently reviewed, merged, deployed
only to the named staging Functions below, and proven through the supported UI
before Draft evidence resumes.

## Purpose

The FF1.21 adversarial runner passed on exact staging source `0150ad98`, but a
subsequent supported Commissioner Draft Setup rehearsal could not reach
`executeDraftCommand`. The browser's preflight from the dedicated staging
Hosting origin returned no `Access-Control-Allow-Origin`, Cloud Function logs
contained only `OPTIONS`, and the saved server schedule remained unchanged.

The shared callable allowlist trusted Production, legacy Hosting, and local
development, but not the two exact Hosting origins for the isolated billed
staging project. FF1.22 adds only those exact origins. CORS determines which
browsers may send a request; it does not replace Firebase Authentication,
commissioner authorization, App Check posture, or server Draft authority.

## Acceptance criteria

1. Preflight from `https://rinkrat-staging-d1nc-2026.web.app` and its exact
   `firebaseapp.com` counterpart returns that same origin in
   `Access-Control-Allow-Origin` for each deployed callable.
2. Production, legacy Hosting, and local-development origins remain accepted.
3. HTTP staging, preview channels, unrelated Firebase projects, suffix
   lookalikes, and wildcard project origins remain denied.
4. Saving Draft settings through the authenticated staging UI sends a `POST`,
   reaches server Draft authority, and changes only the isolated fixture.
5. The Draft remains scheduled, the clock remains stopped, and no pick is
   created while the new start is in the lobby/readiness window.
6. Projection readiness remains bound to the exact schedule, Projection V11
   request, availability revision, snapshot, and hash.
7. Reload, reconnect, and a duplicate tab converge on the same authoritative
   schedule and private queue without direct Firestore repair.

## Edge cases and stop conditions

- Do not use a wildcard such as `*.web.app`; Firebase project origins outside
  the named staging project must stay rejected.
- A successful preflight is not sufficient. Stop if there is no authenticated
  `POST`, the callable returns an authorization error for the commissioner,
  the schedule changes only locally, the clock starts, or a pick appears.
- Stop if a non-commissioner can save Draft settings, if an unauthenticated
  request succeeds, or if a stale tab overwrites a newer schedule.
- Do not edit the Draft document directly to make the rehearsal pass.
- The existing exact FF1.21 fixture reset remains authoritative. Reseed only
  the bounded D1N staging fixture if its documented safety checks pass.

## Verification

Run `npm run test:batchff1-6:run` while developing. From the clean committed
candidate run `npm run verify:batchff1-6`, `npm run build:all`, `git diff
--check`, and `npm run release:verify-clean-deploy-source`.

After the targeted staging deployment, repeat the exact-origin preflights and
save one schedule through Draft Setup. Confirm the Function request logs show
authenticated `POST` success, the UI shows the saved server schedule, the
clock stays stopped, and the pick count stays zero. Then continue controlled
reconnect and duplicate-tab evidence.

## Deployment resources

Deploy only these staging Functions from the reviewed clean merge commit:

- `functions:requestProjectionSnapshotGeneration` — queues an exact fresh
  Projection V11 Draft snapshot when the saved schedule requires it.
- `functions:executeDraftCommand` — owns Commissioner schedule and Draft clock
  commands.
- `functions:repairDraftTurnHandoff` — owns bounded reconnect/stale-turn repair.
- `functions:makeSecureDraftPick` — owns authenticated server Draft picks for
  the later six-manager rehearsal.
- `functions:reconcileTeamIdentityChallenges` — removes the independently
  observed staging-origin failure on the authenticated Draft route.

Deploy staging Hosting only after those Functions so its release manifest
identifies the exact source. Do not deploy every Function. Do not deploy Rules,
indexes, TTL, App Check, queues, workers, scoring resources, or Production.

## Observability

Capture the clean Git revision and matching live staging manifest, the
preflight status and allowed-origin response, the presence of the subsequent
authenticated `POST`, callable success/error counts, the server-rendered
scheduled start after reload, readiness status, clock state, and pick count.
Keep account, league, team, Draft, request, snapshot, player, and queue
identifiers out of shared evidence.

## Rollback

Restore the preceding verified revisions in reverse consumer order:
`reconcileTeamIdentityChallenges`, `makeSecureDraftPick`,
`repairDraftTurnHandoff`, `executeDraftCommand`, then
`requestProjectionSnapshotGeneration`; finally restore the preceding staging
Hosting release. A Git rollback is a reviewed revert of this slice. Confirm the
fixture remains scheduled, its clock is stopped, and its pick count is zero.

## Protected contracts

FF1.22 does not change Production Scoring V4, Projection V11 formulas or
hashes, six-game ownership, seventh-game rollover, immutable started windows,
Draft authorization or transaction logic, add/drop, waiver, IR, standings,
playoff, or scoring authority. It changes no Firestore Rule, index, TTL, App
Check mode, canonical authority, queue mode, worker concurrency, pending-task
limit, Function name, region, memory, timeout, or instance limit.
