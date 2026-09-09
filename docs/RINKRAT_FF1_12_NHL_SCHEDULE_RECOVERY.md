# FF1.28 — Paced NHL Schedule Recovery for Draft Readiness

Status: source implementation candidate; independent review and isolated
staging evidence are required before Production release or Draft GO.

## Approved problem

Exact FF1.27 staging evidence naturally received NHL `429 Too Many Requests`
responses. Two consecutive strict Projection requests each completed with only
24 of 32 team schedules. FF1.27 behaved safely: both requests became explicit
errors, the preceding `fixture-v11` pointer remained current, and the synthetic
Draft stayed scheduled, stopped, at next pick one, and at zero picks. However,
the existing batch shape repeated the same upstream burst after cooldown and
did not recover.

## Architecture recommendation

The long-term scalable design remains one shared, durable NHL schedule fact per
team/season that Projection workers reuse. Promoting the existing Shadow cache
to authority requires its own parity, freshness, corruption, and rollback
evidence and is not part of FF1.28.

For the private-season gate, pace only strict Draft-opening schedule requests.
Load one team at a time and leave three seconds between calls. Stop the pass
after two terminal team failures so a broad outage cannot consume the
Projection task deadline. The existing request error and Draft-readiness
backoff remain the single recovery owner. This deliberately trades background
preparation time for upstream safety during the existing 20-minute readiness
window. Ordinary projections retain their current bounded batches and tolerant
fallback.

## Implemented behavior

- `pre-draft` and `draft-start-fallback` schedule loads run sequentially with a
  three-second interval.
- A pass stops after two terminal team failures and marks every unrequested
  remainder as rejected. It never converts skipped input into empty schedules.
- A team that fails remains rejected. FF1.27 then leaves the request in
  `error`, retains the preceding Projection V11 pointer, and lets the existing
  Draft-readiness backoff own the only next task attempt.
- Non-Draft generation retains the existing eight-team batches, 80-millisecond
  batch delay, and neutral-schedule fallback.
- No browser request, Firestore listener, queue, minimum instance, or
  concurrency control was added.

## Acceptance criteria

1. Strict schedule loading never has more than one in-flight NHL team request
   per Projection task.
2. The initial 32-team pass leaves three seconds between requests.
3. One request receives only the NHL client's established retry policy; FF1.28
   does not add a competing in-task recovery loop.
4. A broad outage stops after two terminal team failures and leaves the rest
   rejected so FF1.27 fails visibly within the task deadline.
5. A later readiness attempt after the existing server-owned backoff may retry
   the same exact schedule and availability input.
6. A complete pass yields the same ordered 32-team inputs used by existing
   Projection V11 code.
7. Any remaining failure still produces FF1.27's explicit incomplete-input
   error and cannot publish or move a snapshot pointer.
8. The Draft remains scheduled, stopped, at next pick one, and zero picks while
   recovery or the existing readiness retry is active.
9. Duplicate scheduler/task delivery continues to converge through the
   existing deterministic request and control identities.
10. Tolerant non-Draft generation behavior is unchanged.
11. Production Scoring V4, Projection V11 formulas and hash schema, six-game
   ownership, Game 7 rollover, and every competitive write boundary are
   unchanged.

## Edge cases

- An empty but fulfilled regular-season schedule remains a fulfilled source;
  completeness is about source availability, not assuming an empty schedule is
  a failure.
- A permanent error remains visible afterward; the helper never converts it to
  an empty success or adds another retry owner.
- One failed club does not stop the pass; later clubs remain paced so the final
  completeness count is accurate when the service is partially available.
- A second terminal club failure stops further upstream calls. Unrequested
  teams become explicit rejected results, preserving headroom inside the
  unchanged 540-second Projection task deadline.
- Two simultaneous Projection task instances may still share an upstream
  service quota. FF1.28 does not claim high-scale Draft-start capacity; D1N
  staged concurrency and queue-age evidence remains required.
- A schedule or availability revision that changes during preparation still
  requires a new deterministic request under the existing authority checks.

## Tests

Focused tests prove sequential maximum concurrency, exact pacing, single-
attempt ownership, bounded broad-outage cutoff, rejected-result preservation,
strict-only routing, retained tolerant batches, unchanged task concurrency,
Production Scoring V4, and Projection V11.

Before release run `npm run verify:batchff1-12`, `npm run build:all`, `git diff
--check`, and `npm run release:verify-clean-deploy-source` from a clean exact
commit.

Isolated staging must first retain the two natural FF1.27 incomplete-input
requests and Function logs as evidence. Then deploy only the exact producer and
rerun the guarded adversarial scenario. The existing readiness backoff must
recover on a later complete attempt, publish one complete 32-team snapshot,
preserve request/snapshot identity under duplicate delivery, remain stopped
with zero picks before start, and pass the 25-minute exact-start rehearsal.
Physical iPhone/Android and the six-manager rehearsal remain separate Draft-GO
gates.

## Deployment resources

After independent review, a clean exact commit, successful build/gate, and no
unresolved P0/P1 finding, deploy only:

1. `functions:processProjectionGenerationTask` to the isolated staging project;
2. the site-pinned staging Hosting target so its live manifest identifies the
   exact source commit.

FF1.27's consumers are already deployed and unchanged. Do not include another
Function, Firestore Rules, indexes, TTL, App Check, queue configuration, worker
limit, or Production resource. After staging and Draft-gate approval, use the
same single Function selector in Production, followed by `hosting:app` only for
the exact release manifest.

## Observability

Retain bounded Projection request status, duration, attempt count, readiness
retry time, aggregate loaded/expected team counts, pointer identity, Draft
status/clock/next-pick state, pick count, natural NHL 429 logs, recovery result,
and exact Hosting manifest. Do not record manager, roster, invite, or raw player
identifiers in public evidence.

Review Projection task duration and the number of recovered clubs. A high
recovery rate or a task approaching its 540-second deadline blocks Draft GO and
requires shared-source work rather than shorter pacing.

## Rollback

Restore the preceding verified `processProjectionGenerationTask` revision,
then restore the preceding Hosting release if its manifest was advanced.
Preserve failed/successful request, snapshot, readiness, task, and Function-log
evidence. Do not edit a real Draft or Projection pointer directly.

Rollback removes pacing but retains FF1.27's strict incomplete-input failure,
so a Draft remains fail-closed. Do not conduct a real Draft until the recovery
release is restored or a separately reviewed operational decision is recorded.

## Protected contracts

Production Scoring V4 values, Projection V11 formulas and hashes, six-game
ownership, Game 7 rollover, immutable started windows, Draft/roster/waiver/IR/
transaction/standings/playoff authority, Rules, indexes, TTL, App Check mode,
scoring queue mode, canonical authority, task concurrency, worker limits,
dependencies, and direct NHL scoring authority are unchanged.
