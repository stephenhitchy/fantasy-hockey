# RinkRat D1N Capacity Evidence

## Scope

D1N-A and D1N-B are observability and planning evidence only. They close a known listener-count
blind spot, correct one source-audited capacity assumption, and add bounded route evidence before
any queue, scoring, or data-model change is attempted.

The Projection V11 snapshot-pointer stream and the bounded projection-generation request stream now
use the existing client-health listener monitor. The monitor records only stable category labels and
listener duration. It does not store league IDs, manager IDs, roster contents, scores, or projection
data.

This wrapper does not add or remove a Firestore listener, change either query, or change the existing
unsubscribe, timeout, success, or error behavior.

## Available Players listener model

The capacity model previously assigned four listeners to Available Players. The current route source
actually opens:

- six fixed route listeners for replay control, the Projection V11 pointer, Draft, cycles, waivers,
  and teams;
- one roster listener per fantasy team; and
- one team-window collection listener per active cycle.

The planning model now derives the route total as:

```text
6 + managersPerLeague + assumedActiveCycles
```

The current explicit assumption is one active cycle. At ten managers per league the route estimate is
17 listeners; at the supported twelve-manager maximum it is 19. Regression tests bind that model to
the eight listener-creation sites and the route cleanup paths.

Cold-start document reads remain an explicit planning assumption. Listener count is not document
count: a collection listener can return many documents. First-snapshot document-count telemetry is a
separate measurement from listener count and is required before 100,000-user certification.

## D1N-B route evidence

All 25 browser `onSnapshot` streams now report lifecycle evidence through the same shared monitor.
The observer reads only the Firestore SDK snapshot shape:

- query `size`, or document `exists()`, for an observed document count;
- `metadata.fromCache` for cache, server, or unknown origin;
- `metadata.hasPendingWrites` for local-write evidence; and
- stable, source-controlled listener labels.

It never reads document fields, document IDs, league IDs, manager IDs, player IDs, scores, roster
contents, or projection contents. Routes are sanitized to templates such as
`/leagues/:leagueId/draft` before they reach the monitor or Analytics. Redirected navigations are
attributed to the final sanitized route rather than the pre-redirect URL.

Each successful navigation opens a three-second observation window. The window records starting,
ending, and peak listener counts; opened and closed listeners; first-snapshot observed documents;
cache/server/unknown origin; cache-to-server transitions; explicit retry starts; post-reconnect
snapshots; hidden-tab snapshots; listener errors; navigation cleanup; and listeners that had not
produced a first snapshot when the window closed. Closed-listener total and maximum lifetime are
recorded in milliseconds; the existing snapshot continues to expose the longest active lifetime.

The browser retains at most 24 settled route samples per session. Its local client-health report
calculates nearest-rank p50, p95, and maximum envelopes for peak listeners and first-snapshot
documents. A `firestore_route_evidence` Analytics event carries the same bounded aggregate counts.
The local `rinkratHealth=1` diagnostic additionally prints JSON evidence for manual verification.

### Interpretation limits

- `firstSnapshotDocumentCount` is the number of documents observed in the first SDK snapshot. It is
  not a Firebase billing record and must not be reported as exact billed reads.
- A measured zero is retained when an empty query or missing document was actually observed.
  Snapshots whose document count cannot be derived are counted separately as unknown, never silently
  converted to zero.
- A cached first snapshot followed by a server snapshot is recorded as a cache-to-server transition.
  A listener that does not request metadata changes may not receive a second callback when server
  data is identical, so absence of that transition is not proof that no server validation occurred.
- A reconnect snapshot means the first callback from a still-active listener after the browser's
  offline-to-online event. It is not a claim about Firestore billing.
- Retry counts are explicit resubscriptions after known listener failures. Routine route navigation
  and multiple same-label roster listeners are not mislabeled as retries.
- Hidden-tab counts use `document.visibilityState`. Navigation cleanup is counted while Angular is
  transitioning routes or when cleanup is explicitly labeled.
- `awaitingFirstSnapshotCount` means no first callback was observed inside the bounded window. It is
  visible evidence, not an authoritative zero.

## Acceptance and edge cases

- Both projection `onSnapshot` streams appear in the existing client-health snapshot.
- Blank league IDs still create no projection listener.
- Projection-generation success, server error, listener error, and nine-minute timeout all retain an
  unsubscribe path.
- Repeated cleanup remains harmless through the existing idempotent monitor wrapper.
- Team removal and active-cycle completion continue to remove their dynamic route listeners.
- Changing the configured managers-per-league assumption changes the modeled roster listener count.
- The report continues to identify itself as an estimate rather than a live load test.
- All 25 browser Firestore streams report a snapshot and an error signal without changing their
  callbacks, queries, or unsubscribe ownership.
- An observed empty query remains distinguishable from an unavailable document count.
- Cached, server, reconnect, retry, hidden-tab, pending-write, listener-error, and navigation-cleanup
  evidence remain separate counters.
- Route samples use sanitized templates and are capped at 24 per session.
- p50, p95, and maximum envelopes use deterministic nearest-rank calculations.

## Manual verification status

The local development build emitted sanitized three-second samples for `/support` and
`/scoring-guide`; both correctly reported zero active Firestore listeners and zero observed
documents. The public signed-out surface was visually checked at 320, 390, 430, and 1,440 pixels.
At each width, document width equaled scroll width and no horizontal overflow was observed.

Available Players, Matchup, Draft, League Home, and Projection require an authenticated league.
They were not manually sampled because the isolated browser session had no authenticated local or
staging fixture. No production account was created and no production write was made to manufacture
evidence. Those five route profiles remain the next evidence gate.

## Security, authority, and deployment

Scoring V4 and Projection V11 are unchanged. Six-game ownership, seventh-game rollover, immutable
started windows, Draft, transactions, standings, playoffs, Rules, indexes, TTL policies, App Check,
queue mode, worker limits, and canonical authority are unchanged.

No Functions or Firebase configuration changes are included. If this slice is later released, only
the existing Firebase Hosting target contains changed runtime bytes. Do not perform a broad Firebase
deployment.

Rollback is a Hosting-only return to the preceding verified release manifest, plus reverting this
client observability slice. No Functions, Rules, index, TTL, App Check, queue, or worker rollback is
required.

## Next gate

Use authenticated, non-production fixtures to collect repeated Available Players, Matchup, Draft,
League Home, and Projection samples on real mobile and desktop clients. Verify cleanup by navigating
from each route to a zero-listener public route and confirming the listener count returns to zero.
Record p50, p95, maximum, cache/server mix, awaiting-first-snapshot count, and reconnect behavior.

Only after those profiles are accepted should D1N-C build the staged load harness in a separate
billed staging Firebase project. No large load test may target production.
