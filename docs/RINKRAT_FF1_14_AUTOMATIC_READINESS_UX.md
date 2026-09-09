# FF1.30 — Automatic Draft Readiness UX

## Architecture recommendation

Draft projection preparation must remain server-owned. A commissioner must
never need to open Projection Lab, press a refresh control, or keep a browser
open for a scheduled Draft to receive its exact Projection V11 board.

The existing once-per-minute scheduled worker already begins the deterministic
pre-Draft request inside the twenty-minute readiness window. A separate future
server slice should use measured staging p95/p99 generation time to define a
pre-lobby preparation budget, start preparation before the one-hour lobby
opens, and align the minimum unprepared scheduling lead with that budget. It
must also address stale daily injury evidence without adding a browser-owned
fallback. Merely changing twenty minutes to sixty minutes would start work at
the same moment the lobby opens and would not guarantee a populated lobby.

## Implemented behavior

This slice changes only the Angular client:

- the existing Draft document listener observes the server's exact readiness
  snapshot ID and content hash;
- a tab opened before readiness automatically loads that exact snapshot when
  the server marks it ready;
- rescheduling or invalidating readiness removes the old board instead of
  falling back to an unrelated league-wide current pointer;
- first load waits for the Draft document before selecting a projection
  snapshot, avoiding a stale-pointer race;
- setup-only pages retain their existing shared Projection view;
- live and completed Drafts continue to use their frozen server snapshot;
- copy now states that RinkRat prepares Draft rankings automatically and that
  `Reload Rankings` retries only the current device's read.

No new Firestore listener, browser generation request, competitive write, or
commissioner prerequisite is introduced.

## Acceptance criteria

- A scheduled Draft with no exact ready binding shows a calm, accessible
  server-preparation state and no stale player board.
- When readiness changes to `ready`, an already-open tab loads the exact
  snapshot ID and verifies its SHA-256 content hash without user action.
- Unrelated Draft updates and repeated listener delivery do not reload the
  player pool.
- A schedule or availability revision that clears readiness immediately hides
  the superseded board.
- Reconnect and duplicate tabs independently converge on the same binding.
- The Draft remains scheduled, stopped, and at zero picks while evidence is
  incomplete; the browser gains no Draft authority.
- Loading, slow-read, error, retry, stale-tab, and navigation cleanup behavior
  remain explicit and accessible.

## Edge cases

- A first listener snapshot that is already ready loads once.
- A cached readiness snapshot followed by the same server snapshot does not
  cause a second reload.
- Scheduled readiness with a changed timestamp, missing request ID, missing
  availability revision, missing snapshot, or malformed hash is rejected.
- A verified snapshot whose stored ID or content hash differs from the Draft
  binding fails visibly.
- An NHL timeout, 429, incomplete 32-team schedule, or stale injury revision
  cannot expose an older board as current and cannot start the clock.
- Setup retains its existing shared Projection view. A live or completed Draft
  with no complete frozen snapshot binding fails visibly instead of borrowing
  a different board; no data is migrated or rewritten.

## Tests

The FF1.30 focused suite covers exact scheduled bindings, timestamp receiver
safety, frozen live/complete bindings, readiness-to-frozen identity, first
listener load, binding-change reload, single-listener preservation,
scheduled-pointer refusal, server-owned copy, and absence of browser
generation calls. The inherited FF1 gate, Angular and Functions builds,
whitespace check, and clean-source guard remain required from the clean commit.

Staging evidence should open a lobby before readiness, retain two tabs,
reconnect one, and prove both populate from the same exact binding when the
server reaches `ready`. Physical iPhone Safari and Android Chrome remain
required for the public-scale claim.

## Deployment resources

This slice requires only the site-pinned Hosting target:

```text
hosting:app
```

No Function, Rule, index, TTL policy, App Check mode, queue, worker, or
Firestore data deployment is part of this slice.

## Observability

Use the existing Draft listener evidence and client route envelope to record
the transition from no binding to one exact snapshot/hash, player count after
load, listener errors, reconnect snapshots, and listener cleanup after
navigation. Server readiness request ID, attempt count, retry time, 32/32
schedule completeness, and preparation duration remain the server-side
evidence for the later pre-lobby timing change.

Do not treat client snapshot document counts as exact billed Firestore reads.

## Rollback

Restore the preceding verified Hosting release. If the source is merged, use a
reviewed Git revert of the FF1.30 commit. No server revision or competitive
record needs rollback because this slice performs no server or data write.

## Protected contracts

Production Scoring V4, Projection V11 formulas and hashes, six-game ownership,
Game 7 rollover, exact-once Draft transactions, immutable started windows,
roster and transaction authority, standings, playoffs, Rules, indexes, TTL,
App Check, queue mode, worker limits, and canonical authority are unchanged.
