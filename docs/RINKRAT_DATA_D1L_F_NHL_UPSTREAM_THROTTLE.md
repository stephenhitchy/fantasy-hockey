# RinkRat Data D1L-F: NHL Upstream Throttle Recovery

## Problem

The 2026-10-05 live scoring recovery exposed repeated NHL `429 Too Many
Requests` responses while several leagues were simultaneously catching up on
newly final games. The existing retry policy correctly failed closed, but each
six-request batch woke on nearly the same retry clock and could reproduce the
same rejected burst. League scores remained unchanged and safe, but recovery
could span repeated scheduled sweeps.

## Behavior

`nhl-api.service.ts` now uses one process-wide adaptive retry gate:

- healthy NHL requests retain their existing concurrency and cache behavior;
- the gate activates only after an actual HTTP 429 response;
- the provider's existing bounded retry delay becomes the shared not-before
  boundary;
- concurrent attempts queue behind that boundary and start at least 750
  milliseconds apart;
- a later 429 extends the boundary without releasing a retry burst;
- non-429 retryable failures retain their existing independent backoff; and
- a terminal failure still propagates to the scorer, which preserves the last
  published score and retries later.

This is an in-process recovery control. It does not promote the Firestore
Shadow cache, make stale data authoritative, add a second retry owner, or claim
distributed NHL quota coordination across Cloud Run instances.

## Production follow-up

The first D1L-F deployment substantially reduced the broad retry burst, and
later sweeps returned every observed league to success. Read-only Production
logs still recorded two later schedule-load failures, at
`2026-10-05T22:49:01Z` and `2026-10-05T22:59:53Z`. Both exhausted the original
three attempts for Winnipeg and Washington before a later sweep recovered.
That residual pattern is consistent with independent Cloud Run instances
sharing the NHL provider limit but not the process-local gate.

The follow-up keeps the gate and adds two narrow recovery controls:

- HTTP 429 cooldowns receive at most 750 milliseconds of random jitter so
  independent instances do not deterministically retry together;
- critical NHL team-schedule reads receive five attempts instead of three,
  extending their bounded recovery window without changing ordinary NHL
  request retries; and
- scheduled-sweep failures log the exact league ID so any remaining failure is
  immediately attributable.

The legacy scorer remains at two parallel leagues and the queue worker remains
at four concurrent dispatches. Adding workers while the provider is returning
429 would increase pressure and is intentionally excluded.

## Protected contracts

Production Scoring V4 values, Projection V11 formulas and hashes, six-game
window ownership, seventh-game rollover, immutable started windows, direct NHL
scoring authority, Firestore Rules, indexes, TTLs, App Check mode, queue mode,
worker limits, and canonical authority are unchanged.

## Deployment

Deploy only the five live scoring entrypoints that need the adaptive NHL retry
gate:

```bash
firebase deploy --project nhl-fantasy-app-ab673 \
  --only "functions:processLeagueAutomationTask,functions:runScheduledLeagueAutomation,functions:runSeasonStartAutomation,functions:initializeSeasonAfterDraft,functions:requestLeagueLiveScoringRefresh"
```

No Hosting, Firestore, queue, roster-action, or canonical-ingestion deployment
is required.

## Acceptance evidence

- A healthy request receives a permit without delay.
- One observed 429 serializes concurrent retry permits behind the same bounded
  cooldown.
- A later 429 extends the shared cooldown.
- The request path gates every attempt and activates shared recovery only for
  HTTP 429.
- A critical schedule exhausts exactly five attempts, then still fails closed.
- Cross-instance 429 jitter remains between zero and 750 milliseconds.
- Scheduled-sweep errors identify the affected league.
- Production league schedules return to `lastOutcome: success` with
  `consecutiveFailureCount: 0` without moving completed games or manufacturing
  zeroes.

## Rollback

Revert the D1L-F follow-up source commit, rebuild, and deploy the same five
Function selectors. Existing scoring snapshots and identity evidence remain
valid; no data migration or cleanup is required. The original three-attempt
process-local gate is the immediate rollback behavior.
