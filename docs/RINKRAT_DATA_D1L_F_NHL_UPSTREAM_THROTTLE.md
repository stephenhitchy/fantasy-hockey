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
- Production league schedules return to `lastOutcome: success` with
  `consecutiveFailureCount: 0` without moving completed games or manufacturing
  zeroes.

## Rollback

Revert the D1L-F source commit, rebuild, and deploy the same five Function
selectors. Existing scoring snapshots and identity evidence remain valid; no
data migration or cleanup is required.
