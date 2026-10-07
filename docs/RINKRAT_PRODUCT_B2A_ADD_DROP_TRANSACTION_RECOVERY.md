# B2A — Add/Drop Transaction Latency and Exact Recovery

Date: 2026-10-06

## Problem

Direct add/drop actions could take longer than the browser's 20-second wait.
The largest delay was a post-click current-team check that refreshed all 32 NHL
club rosters for one or two involved skaters. A callable was still allowed to
run for 60 seconds, so the browser could show an uncertainty error and unlock
while the server later committed the player to the bench.

The two add/drop callable paths also lacked a stable submission identifier.
After a committed response was lost, a retry could not distinguish an exact
replay from a new request. Finally, a drop named only a roster slot; a stale tab
did not prove that the player still in that slot was the player the manager had
confirmed dropping.

## Contract

Updated Hosting sends one opaque `submissionId` for each direct add/open-slot
intent. The same identifier and normalized payload are reused by a bounded
transport retry. Updated Functions accept missing identifiers for one rollout
window so Functions can deploy before Hosting.

For identified requests, both `executeSecureRosterAction` and
`applyImmediateRosterMove` derive the same owner/league-bound private
transaction document ID. That canonical transaction stores:

- the submission identifier;
- a SHA-256 fingerprint of normalized intent;
- the exact callable result.

The receipt is read after authentication, App Check, and membership checks and
again inside the competitive Firestore transaction. Exact replays return the
saved result without another roster, waiver, scoring-window, or activity
mutation. Reusing an identifier for different intent fails closed. Legacy open
tabs keep the former random-transaction path until Hosting updates.

The immediate active-slot path reads other teams separately for league-wide
ownership, but it also checks the already-read caller roster inside the same
transaction. An incoming asset already owned or reserved anywhere on that
roster cannot be duplicated into a second slot.

New identified add/drop requests include `expectedOutgoingAssetKey`. The server
compares that asset with the selected slot inside the committing transaction.
If another tab changed the slot, no player is dropped and the manager must
review the move again.

## Latency path

Interactive add/drop no longer refreshes the shared 32-club identity catalog.
It force-loads the NHL landing record for only the distinct skaters involved in
that request, in parallel, after the action boundary. Scoring workers retain the
full shared identity catalog; canonical scoring authority is unchanged.

Incoming and outgoing schedule checks run in parallel through the bounded,
coalesced NHL schedule client. A cached provider `FUT` state is never trusted
across puck drop: the exact `startTimeUTC` is compared with the server action
boundary and the move advances to the next six-game block when that boundary
has passed. Missing puck-drop evidence fails closed unless the NHL explicitly
marks the game postponed or cancelled; that deferred evidence keeps the old or
temporarily absent start time from creating a false puck-drop boundary.

The browser reuses a matching preview for 30 seconds instead of repeating its
NHL request immediately before every direct callable. Older previews refresh
before dispatch. The preview remains UX only; Functions still revalidate every
competitive condition.

## Browser recovery

The roster listener and callable response remain the fastest success paths.
After 2.5 seconds, the UI changes to a neutral “still confirming” state and
performs bounded server-source reads of the manager's existing roster document.
It does not create another listener. Exact committed roster state returns the
authoritative mode and effective cycle.

Transport-shaped failures can receive one quick replay with the same submission
identifier when the first failure arrives within ten seconds. Both callable
clients, that retry allowance, and the browser confirmation loop share one
82-second envelope: 65 seconds for the last callable, ten seconds in which a
retry may begin, and seven seconds for final reconciliation. Explicit
authentication, permission, validation, and precondition rejections surface
after an immediate exact read.

A successful source-of-truth read distinguishes a matching commit from a
confirmed absence. If that final read itself is unavailable, the browser keeps
the outcome explicitly uncertain and tells the manager to inspect My Team
before retrying; it never describes a failed read as proof that no move
committed. This closes the former false-error window while preserving a finite
UI escape hatch.

## Security and competitive invariants

- Authentication, App Check, league membership, Draft completion, unique
  ownership, waiver state, slot position, and six-game timing remain
  server-authoritative.
- Started windows and seventh-game ownership do not move.
- Exact current-team and puck-drop evidence fail closed.
- Submission evidence is stored only on the server-only canonical transaction;
  existing activity projections do not publish unknown fields.
- No Firestore Rule, index, TTL, App Check mode, queue mode, Scoring V4, or
  Projection V11 change is required.

## Verification

`test/batchb2a-add-drop-transaction-recovery` covers deterministic IDs,
fingerprint conflicts, concurrent duplicate delivery, lost-response replay,
single-write Firestore emulator behavior, structured roster reconciliation,
transport error classification, retry-envelope timing, unavailable-versus-
absent final reads, exact puck-drop boundary handling for add/drop and active-
bench activation, same-roster duplicate rejection, and source contract guards.
The inherited release gate is `verify:batchb2a` followed by `build:all`.

## Release and rollback

Deploy Functions first, then Hosting:

```bash
firebase deploy --project nhl-fantasy-app-ab673 --only "functions:executeSecureRosterAction,functions:applyImmediateRosterMove"
firebase deploy --project nhl-fantasy-app-ab673 --only "hosting:app"
```

Rollback Hosting first if browser recovery regresses. Restore both roster
callables together from the last known-good clean post-B1Z revision if the
server path regresses. Do not delete completed transaction/waiver/roster data
or private receipt fields; exact replay evidence is additive and harmless to an
older client.
