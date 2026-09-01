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

The capacity model previously assigned four listeners to Available Players, and the first source
audit raised that to 17. Authenticated measurement consistently observed 20 and exposed three
omitted streams. The current route source actually opens:

- seven fixed route listeners for replay control, the Projection V11 pointer, Draft, cycles, two
  waiver streams behind one service call, and teams;
- two league-context availability listeners for the shared report and commissioner overrides;
- one roster listener per fantasy team; and
- one team-window collection listener per active cycle.

The planning model now derives the route total as:

```text
9 + managersPerLeague + assumedActiveCycles
```

The current explicit assumption is one active cycle. At ten managers per league the route estimate is
20 listeners; at the supported twelve-manager maximum it is 22. Regression tests bind that model to
the route call sites, the waiver service's two-stream fan-out, both availability streams, and the
route cleanup paths.

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

Each successful navigation opens a five-second observation window. The initial three-second window
could settle after a previous route cleaned up but before a warm authenticated route opened its
dynamic listeners, producing a partial route sample. The five-second bound covers that observed
startup gap without creating or retaining any listener. The window records starting,
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

Authenticated, non-production fixtures were represented by one synthetic league measured against
the loopback-only Firebase Auth and Firestore emulators under project ID `demo-rinkrat-d1n`. No
production account or document was read or written. The fixture contains ten synthetic teams and
rosters, one active-cycle window document per team, 100 synthetic Projection V11 assets in one
chunk, and 20 synthetic activity records.

The final five-second implementation received 20 full-navigation samples per route: ten at
390 × 844 and ten at 1,440 × 1,000. Every sample had zero listener errors, zero unknown document
counts, and zero listeners awaiting a first snapshot. Values were identical at both widths, so each
p50, p95, and maximum below is the same:

| Sanitized route | Samples | Peak listeners p50/p95/max | First-snapshot documents p50/p95/max | First-snapshot origins per sample |
| --- | ---: | ---: | ---: | --- |
| Available Players | 20 | 20 / 20 / 20 | 26 / 26 / 26 | 1 cache, 19 server |
| Matchup | 20 | 13 / 13 / 13 | 18 / 18 / 18 | 1 cache, 12 server |
| Draft, live fixture | 20 | 5 / 5 / 5 | 12 / 12 / 12 | 0 cache, 5 server |
| League Home, scheduled-Draft fixture | 20 | 10 / 10 / 10 | 27 / 27 / 27 | 2 cache, 8 server |
| Projection Lab | 20 | 0 / 0 / 0 | 0 / 0 / 0 | no live listener |

Projection Lab loads its snapshot through bounded Firestore reads. Its zero in this table means it
opens no monitored `onSnapshot` stream; it does not mean the route performs zero reads or incurs no
billed reads.

Warm in-app spot checks verified the corrected five-second window after the three-second window had
misclassified late dynamic startup. Available Players reached 20 listeners and 34 first-snapshot
documents; Matchup reached 13 and 17; Draft reached 5 and 12; Projection Lab retained only the two
league-context availability listeners while its bounded load completed. Warm first snapshots were
cache-heavy and produced separate cache-to-server transitions. Navigation to `/support` then reduced
the listener count to zero. The final League Home cleanup sample started at 10, closed all 10, ended
at zero, recorded no error or awaiting snapshot, and had a maximum closed-listener lifetime of
12,031 milliseconds.

At both measured widths, document width equaled scroll width on all five routes. No horizontal
overflow was observed. Route-loaded focus reached the main landmark on Available Players, Matchup,
League Home, and Projection Lab; Draft retained body focus and therefore remains a focused keyboard
review item rather than a claimed pass.

### Contention and remaining evidence

A separate four-tab stale-session stress pass produced a degraded Available Players sample with a
peak of 18, ten listeners awaiting their first snapshot, and only six observed documents. Increasing
the local run to six authenticated tabs saturated the emulator's long-poll connections: a membership
check timed out and the league guard failed closed to Access Denied. Closing the extra tabs restored
the stable normal envelope. This is useful stale-tab pressure evidence, but it is not a production
capacity measurement and cannot distinguish browser-client pressure from single-emulator limits.

No controlled browser-network toggle was available in the isolated browser run, so a real
offline-to-online reconnect sample was not manufactured. The reconnect generation and aggregation
logic is unit-tested, but authenticated reconnect evidence and physical mobile-device evidence remain
open. D1N-C must not claim that gate as complete.

The connected Firebase account exposed only the production project. No separate billed staging
project was available, and none was created or deployed from this task. Exact billed reads, Key
Visualizer evidence, real-device reconnects, and staged concurrency remain unmeasured.

## Reproducing the local fixture

Use the required Node 22.23.1/npm 11.17.0 toolchain. In one terminal:

```bash
npm run fixture:d1n:emulators
```

In a second terminal, seed the live-Draft fixture for Draft measurements:

```bash
npm run fixture:d1n:seed
```

For League Home measurements, reseed with a future scheduled Draft so the product's correct
live-Draft redirect does not replace League Home:

```bash
npm run fixture:d1n:seed:league-home
```

Start Angular and open `http://127.0.0.1:4200/?d1nEmulator=1&rinkratHealth=1`. Sign in with the
source-controlled synthetic credentials printed by the seed command. The client switch is ignored
on every non-loopback hostname, and the seed refuses missing, remote, or nonstandard emulator ports.

Do not add the Functions emulator to this fixture. Loading the full Functions surface also loads
unrelated Firestore triggers and can expose non-emulated external integrations. Auth+Firestore is
the deliberate boundary; expected callable-unavailable warnings are excluded from route-listener
results but must remain visible during manual review.

## Security, authority, and deployment

Scoring V4 and Projection V11 are unchanged. Six-game ownership, seventh-game rollover, immutable
started windows, Draft, transactions, standings, playoffs, Rules, indexes, TTL policies, App Check,
queue mode, worker limits, and canonical authority are unchanged.

No Functions source, Rules, indexes, TTLs, App Check policy, queue configuration, worker limits, or
Firebase resource configuration changed. The browser has a new explicit loopback-only demo-project
switch; it cannot activate on Hosting or another non-loopback hostname. If this slice is later
released, only the existing Firebase Hosting target contains changed runtime bytes. Do not perform a
broad Firebase deployment.

Rollback is a Hosting-only return to the preceding verified release manifest, plus reverting this
client observability slice. No Functions, Rules, index, TTL, App Check, queue, or worker rollback is
required.

## Next gate

Complete the remaining authenticated evidence on real mobile and desktop clients with controlled
offline-to-online reconnects. Investigate the Draft Room's initial body focus and confirm the
multi-tab awaiting-snapshot behavior against a separate billed staging project rather than treating a
single local emulator as production evidence.

Only after those profiles are accepted should D1N-C build the scoring and Draft load harness in that
separate billed staging Firebase project. Follow with canonical fan-out scaling, Draft recovery
pagination/starvation protection, and staged App Check/abuse/queue-promotion evidence. No large load
test may target production.
