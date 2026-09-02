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
Once that explicit flag is observed, diagnostic logging remains enabled only in memory for the
current page lifetime. Angular navigation can therefore remove the query parameter without hiding
the cleanup sample for the destination route. Reloading a URL without the flag starts disabled
again; the diagnostic does not write a cookie, local-storage value, or Firestore document.

Pending-write snapshots are also attributed to the same stable, source-controlled listener labels
already used by the local listener-count diagnostic. The page-lifetime diagnostic retains at most
32 pending-write labels and folds any additional label into `other-listener`. Analytics receives
only the aggregate pending-write snapshot count; it never receives the label map. This attribution
reads only snapshot metadata and is intended to identify a route's pending-write producer without
capturing a document field, document ID, league ID, manager ID, player ID, or game ID.

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
- An explicit health query remains active through same-page navigation so cleanup is observable,
  but a new page load without an explicit query or local developer opt-in starts disabled.

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

### Billed staging authenticated evidence

The separate billed project `rinkrat-staging-d1nc-2026` was prepared manually without using
Production. Its live Hosting manifest reported clean commit
`f3b27d0000289df9233d7c8819a43bd51044d420`, Release Candidate 65, Production Scoring V4, and
Projection V11. The deployed Firestore Rules matched that clean commit, the source-controlled index
and TTL configuration was present, Email/Password authentication was enabled, and no Functions were
deployed. The fixture seeder wrote only its fixed synthetic user and league paths.

An initial authenticated pass collected 20 full-navigation samples per route: ten at 390 × 844 and
ten at 1,440 × 1,000. Every sample settled with zero listener errors, zero unknown document counts,
zero listeners awaiting a first snapshot, and no horizontal overflow. Viewport size did not change
the observed envelope:

| Sanitized route | Samples | Peak listeners p50/p95/max | First-snapshot documents p50/p95/max | Pending-write snapshots per sample | Route focus |
| --- | ---: | ---: | ---: | ---: | --- |
| Available Players | 20 | 20 / 20 / 20 | 26 / 26 / 26 | 1 | Main landmark |
| Matchup | 20 | 13 / 13 / 13 | 18 / 18 / 18 | 0 | Main landmark |
| Draft, live fixture | 20 | 5 / 5 / 5 | 12 / 12 / 12 | 0 | Body; open defect |
| League Home, scheduled-Draft fixture | 20 | 10 / 10 / 10 | 27 / 27 / 27 | 1 | Main landmark |
| Projection Lab | 20 | 0 / 0 / 0 | 0 / 0 / 0 | 0 | Main landmark |

The Projection Lab zero retains the same bounded-read limitation described above. The repeated one
pending-write snapshot on Available Players and League Home is an investigation item, not a claimed
pass. The current aggregate does not identify which shared listener produced it. Draft retained body
focus in every mobile and desktop sample, reproducing the keyboard-focus defect.

A separate four-tab Available Players pass remained stable in billed staging: all four tabs reached
20 listeners and 26 first-snapshot documents with no error, unknown count, awaiting snapshot, or
overflow. The three additional tabs were then closed. This is bounded stale-tab evidence, not a
load-test or Functions-concurrency result.

The deployed staging Hosting configuration intentionally contains no Function rewrite. Expected
callable failures stayed visible. NHL proxy URLs therefore returned the Hosting shell and produced
schedule JSON warnings, so this pass is valid only for Firestore route-listener evidence; it is not
end-to-end NHL, callable, or production-parity evidence. No controlled reconnect or physical-device
sample was completed. The page-lifetime diagnostic fix in this slice was not part of the measured
`f3b27d0` deployment, so same-page navigation cleanup must be repeated after a reviewed Hosting-only
staging update.

The project has billing enabled, one registered staging web app, Owner access for the active project
account, and a project-filtered $25 USD monthly alert budget at 50%, 80%, 100%, and 100% forecast.
The budget sends alerts; it is not a hard spending cap. Exact billed reads, Key Visualizer evidence,
real-device reconnects, and staged Functions concurrency remain unmeasured.

A later staging recheck at clean commit `c75ba05` reproduced the open Draft defect after both a cold
route load and same-page entry: focus returned to `body` when the loading heading was replaced by
the live Draft heading. The follow-up client repair watches only the existing main landmark for a
bounded five-second startup period, transfers focus to the replacement `h1` only while focus is
still on the route target or document body, and disconnects on user focus, navigation, timeout, or
component destruction. That repair remains source behavior until a reviewed Hosting-only staging
deployment proves it in the live fixture.

The repaired Hosting build was then verified at clean commit `60780a3`. Draft focus reached the
replacement league `h1` after both cold and same-page entry at 320, 390, 430, and 1,440 pixel widths,
with no horizontal document overflow. A four-tab authenticated pass collected 11 additional mobile
and 12 desktop Draft samples, plus 12 samples per viewport for Available Players, Matchup, and
Projection Lab. Draft remained at 5 listeners and 12 first-snapshot documents; Available Players at
20 and 26; Matchup at 13 and 18; and Projection Lab at zero live listeners. All route-to-Support
cleanup samples ended at zero listeners with no listener errors, unknown document counts, or
listeners awaiting a first snapshot.

Every additional Available Players sample reported one pending-write snapshot. The bounded label
attribution in the follow-up source slice identifies `team:list` as the producer in the isolated
emulator, including on a fresh browser origin. A before/after Admin read showed unchanged synthetic
team document update times, so this evidence does not indicate a committed team mutation. The
pending-write source still requires a controlled reconnect and clean-device comparison before it is
classified as harmless cache behavior. League Home staging samples remain pending because switching
the shared bounded fixture from live to scheduled Draft requires the separately held staging
fixture credential.

## Billed staging isolation gate

The source-controlled `staging` Angular configuration replaces the Firebase web identity at compile
time with the exact D1N staging app, keeps the production-safe runtime configuration, and replaces
App Check with a staging-only disabled baseline. Production Firebase and App Check source remain
unchanged. The staging artifact therefore cannot silently connect to the production project.

`npm run staging:d1n:prepare-hosting` generates an ignored, site-pinned
`.d1n-staging.firebase.json` at the repository root. It retains the reviewed Hosting headers and
Angular rewrite, removes all Function rewrites, and builds with `npm run build:staging`. The command
never deploys.

The initial authenticated pass completed these non-production-only prerequisites manually:

1. Create the staging `(default)` Firestore database in `us-west4`, matching the current production
   database location for a more comparable latency envelope.
2. Enable Email/Password authentication for the staging project.
3. From a reviewed clean commit, deploy only the unchanged staging copies of Firestore Rules and
   indexes; do not target the production project.
4. Generate the staging Hosting config and deploy only the exact staging Hosting site.
5. Verify the live staging `/release-manifest.json` reports that same clean commit before seeding.

The intended manual selectors are:

```bash
firebase deploy --project rinkrat-staging-d1nc-2026 --only firestore:rules
firebase deploy --project rinkrat-staging-d1nc-2026 --only firestore:indexes
npm run staging:d1n:prepare-hosting
firebase deploy \
  --project rinkrat-staging-d1nc-2026 \
  --config .d1n-staging.firebase.json \
  --only hosting
```

No Function deployment is required for route-listener evidence. Expected unavailable-callable
messages must stay visible and excluded from listener measurements, as in the local fixture.

After those prerequisites, seed only the bounded synthetic fixture using Application Default
Credentials and a password supplied in the shell environment. The seeder refuses every project
except the exact staging project, refuses Emulator Suite variables, requires an exact acknowledgement,
never prints the password, and writes only the fixed synthetic fixture paths:

```bash
D1N_STAGING_PROJECT_ID=rinkrat-staging-d1nc-2026 \
D1N_STAGING_ACK=seed-synthetic-fixture-in-rinkrat-staging-d1nc-2026 \
D1N_STAGING_FIXTURE_PASSWORD='<20+ character secret>' \
npm run staging:d1n:seed
```

The remaining authenticated gate must use `rinkratHealth=1`, reach at least 20 samples per route and
viewport across the required cold, warm, and reconnect profiles, navigate to a listener-free route
after each cleanup sample, and stop immediately on an unexpected project identity, listener error,
unknown document count, awaiting first snapshot, or listener count that fails to return to baseline.

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

Merge and deploy only the reviewed Hosting slices that repair initial Draft focus and retain the
explicit diagnostic through same-page navigation. Then complete ten additional samples per route at
each viewport, including controlled navigation to a listener-free route, and investigate the shared
pending-write snapshot. Complete the remaining authenticated evidence on real mobile and desktop
clients with controlled offline-to-online reconnects. The four-tab billed-staging pass is useful
bounded evidence but is not production evidence.

Only after those profiles are accepted should D1N-C build the scoring and Draft load harness in that
separate billed staging Firebase project. Follow with canonical fan-out scaling, Draft recovery
pagination/starvation protection, and staged App Check/abuse/queue-promotion evidence. No large load
test may target production.
