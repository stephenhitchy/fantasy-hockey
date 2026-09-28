# FF1.41 — Auto-Draft Liveness and Turn-Bound Deadline Authority

Status: implementation candidate; not deployed

## Verified symptom classification

The recurring single-team observation is primarily an indicator/timing issue,
not a proved skipped automatic pick or stalled Draft.

RinkRat intentionally enables its fast missed-turn Auto-Draft mode only after
the same manager allows two turns to expire. In a snake Draft, position one is
the only position whose second turn occurs after every other position's second
turn: overall pick 8, 12, 16, 20, or 24 in the supported 4, 6, 8, 10, and 12
team formats. At that point every other absent manager can display Auto-Draft
while position one still correctly remains in manual-with-deadline mode. That
manager is still protected by the authoritative full-clock fallback and cannot
stall the Draft indefinitely.

The client also cannot reliably display another manager's private queue mode
to an ordinary member. Commissioners may read every queue; other members may
read only their own. The prior clock label therefore treated an unavailable
queue record as Auto-Draft off. It now states that every manual turn will
auto-pick at 0:00 instead of implying that an unseen mode is unprotected.

Two related defects were confirmed in source:

- picks after timeout-forced activation were stored as
  `manager-auto-mode` because `autoDraftEnabled` was checked before the
  timeout marker, obscuring the difference between a user's preference and
  temporary missed-turn handling;
- a deadline task rechecked pick identity before calling the automation
  processor, but the exact Draft session, pick, owner, start timestamp, and
  action deadline were not carried into the pick transaction. A manual pick
  could advance the Draft in that gap and allow the old invocation to evaluate
  the next turn. Firestore still prevented two commits to the same turn, but
  the old job was not transactionally forbidden from acting on a later turn.

## Read-only deployed evidence

Production Hosting was read as exact source `6aacd7df6d` during this audit; the
local FF1.40/FF1.41 branch is later and must not be treated as deployed.

Bounded read-only Cloud logs and retained Draft documents were reviewed without
retaining manager names, emails, team names, or raw identifiers in the audit
result. Six still-existing live/completed Draft documents referenced by the
September clock logs were inspected. Managers with zero manual picks reached
automatic mode and completed their turns. The only managers with two or more
timer-expiry picks but no timeout mode also had 10, 14, or 15 manual picks, so
their missed turns were non-consecutive and the reset was expected. No retained
Draft proved an indefinitely skipped absent manager. Cloud logs contained
retryable lease-contention deliveries, but no no-candidate or automatic-pick
failure explaining a single excluded team.

This evidence cannot prove the exact historic screen state from a deleted or
no-longer-retained Draft. The regression suite therefore covers the full state
space rather than claiming an unavailable production root cause.

## Implemented authority contract

`functions/src/draft-autodraft-state.util.ts` defines three effective modes:

- `manual-with-deadline`: the manager has the normal clock, followed by the
  legal server fallback;
- `manager-auto`: the manager explicitly enabled fast Auto-Draft;
- `timeout-auto`: two consecutive missed turns activated the existing fast
  fallback without erasing why it was activated.

Missing, null, false, and legacy queue fields normalize to
`manual-with-deadline`. The first and second expired turns remain
`timer-expired`; later forced-mode picks are now recorded as
`timeout-auto-mode`, while explicit picks remain `manager-auto-mode`. The
temporary timeout marker no longer overwrites `autoDraftEnabled`, which remains
the manager's explicit preference. The Draft Room presents either stored mode
as active, explains when two missed turns caused it, and lets the manager clear
the temporary mode without first converting it into an explicit preference.
The existing two-missed-turn policy, queue order, legal fallback, ranking,
starter-first behavior, 2F/1D/0G bench coverage, and goalie-unit rules do not
change.

The Draft queue Rule now permits the new server-authored marker-only shape,
allows its owner to preserve that shape while reordering the queue or clear it,
and denies a browser attempt to activate the missed-turn marker. This is a
shape/authority refinement only; it does not broaden queue reads, writes, or
Draft authority.

Every newly scheduled pick-deadline task carries the exact overall pick, owner,
pick-start timestamp, due timestamp, and Draft-start session timestamp. The
automatic-pick Firestore transaction reevaluates that complete expectation
with the current queue mode and server time before reading rosters or writing a
pick. Legacy tasks without the new optional owner/session fields remain
compatible; the consumer derives their current owner after matching the saved
pick and start timestamp, then applies the same transactional guard.

Manual and automatic picks continue to serialize on the Draft transaction.
Duplicate jobs converge on one pick. An old job returns stale and cannot act on
the later turn. Disabling Auto-Draft while a short task is in flight moves
eligibility back to the full server deadline; enabling it creates the existing
short task. The minute worker remains the bounded recovery path if exact task
delivery is missed.

Invalid or empty candidate pools continue to fail visibly through
`serverAutomationStatus: error`; no fabricated asset or silent skipped team is
introduced. Structured logs include league ID, Draft document ID, overall
pick, a one-way team correlation hash, effective mode, automatic reason,
blocked reason, and commit outcome. They do not add names, emails, queue
contents, or player selections.

## Regression coverage

`npm run test:batchff1-41` uses the Firestore Emulator and proves:

- position zero/first, last, and every middle position across 4, 6, 8, 10,
  and 12 teams;
- commissioner present and absent, one absent manager, several absent, and
  everyone absent;
- managers who never open the room and missing/null legacy queue fields;
- explicit on/off, timeout activation, reconnect, and multiple-tab-neutral
  state evaluation without a new presence system;
- first pick, both snake boundaries, and consecutive endpoint turns;
- complete unattended 68, 102, 136, 170, and 204-pick Drafts through the real
  automatic-pick transaction, with complete 17-asset rosters;
- duplicate deadline delivery, stale task rejection, and recovery of the next
  missed worker turn;
- exact session/pick/owner/start/deadline rejection;
- visible failure for an invalid empty candidate pool;
- distinct UI explanations for timer expiry, explicit Auto-Draft, and
  missed-turn Auto-Draft.

`npm run test:rules` separately proves that a manager cannot forge the
server-owned missed-turn marker, can reorder while it remains active, and can
turn it off.

The inherited six-client rehearsal remains the end-to-end manual/automatic
race, reconnect, duplicate-tab, queue privacy, clock, completion, and
post-Draft lifecycle proof. A fresh staging run is still required before
Production release because this audit did not mutate or rehearse a production
Draft.

## Deployment and rollback

Expected targeted resources are:

- `firestore:rules`
- `executeDraftCommand`
- `repairDraftTurnHandoff`
- `processDraftClockDeadline`
- `runScheduledDraftAutomation`
- `continueServerDraftAutomation`
- `processAutoDraftQueueChange`
- `reconcileDraftTurnAfterCommittedPick`
- `hosting:app`

Deploy the backward-compatible Rules refinement first so both the old combined
timeout shape and the new marker-only shape are accepted during rollout. Then
deploy the deadline consumer, followed by every producer/recovery trigger that
can schedule or continue the shared deadline path, and finally Hosting.
`makeSecureDraftPick` does not require a runtime deployment for this slice;
its transaction source is unchanged. `executeDraftCommand` and
`repairDraftTurnHandoff` are included because starting/resuming or explicitly
repairing a turn can call the shared deadline producer. No index, TTL, queue
configuration, App Check mode, scoring worker, Projection Function, or
dependency deployment belongs to FF1.41.

For rollback, restore Hosting first, then stop new payload production by
restoring `processAutoDraftQueueChange`, `continueServerDraftAutomation`, and
`runScheduledDraftAutomation`, followed by `executeDraftCommand` and
`repairDraftTurnHandoff`; restore the handoff trigger and deadline consumer
last. New payload fields are optional, so the preceding consumer
ignores them safely. Picks already written with `timeout-auto-mode` remain
valid historical evidence; old clients treat them as an automatic pick and do
not gain write authority. Restore the preceding Rules only after the old
deadline consumer is back; otherwise marker-only queue documents written by
the new server could reject an old client's queue update until that manager
turns the temporary mode off.

## Protected contracts

Production Scoring V4, Projection V11 formulas and hashes, six-game ownership,
seventh-game rollover, immutable started windows, roster-fit strategy,
transactions, waivers, IR, standings, playoffs, indexes, TTLs, App Check mode,
queue rate/concurrency, Function limits, and canonical scoring authority are
unchanged. Draft authority is narrowed by adding an exact transactional
stale-task guard, keeping timeout mode separate from the explicit preference,
and preventing browser activation of the server missed-turn marker. The only
Firestore Rules change is that narrowly tested queue-shape transition.
