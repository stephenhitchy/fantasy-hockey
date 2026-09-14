# League Lifecycle L1C — Reopen a Scheduled Draft to Change League Size

## Scope and behavior

L1B still permits ordinary league-size edits only before Draft order is saved.
L1C adds an explicit commissioner-confirmed exception for an unstarted,
scheduled Draft **more than 24 hours before its exact start instant**. This is
an elapsed-time cutoff, not a browser-local calendar-day boundary.

Changing size in that state requires fresh password authentication and a
verified email. One server transaction verifies the exact saved schedule and
settings submission, current member/team/order authority, invite authority,
zero picks and competition history, and the cutoff. It changes the capacity,
reopens the same unexpired invite if there is room, moves the Draft back to
`setup`, clears its order, scheduled start, and exact Projection preparation
binding, and creates one deterministic audit. Current members, teams, rosters,
the invite code, and the Projection V11 formula are not changed. An expired
invite stays inactive.

The commissioner must wait for any new managers, then use Draft Setup to save
a **new complete order and start time**. The existing safe scheduling lead
and server-owned readiness checks apply. A stale exact-start task sees `setup`
and no schedule and cannot open the Draft. Ordinary pre-Draft capacity edits
retain their L1B request/audit compatibility and do not reset Draft settings.

This does not allow member removal after a saved Draft, and it does not permit
resizing a live, completed, started, or otherwise competitive league.

## Acceptance criteria and edge cases

- A scheduled, stopped, zero-pick Draft at T-24h plus one millisecond can
  expand or shrink to at least the joined count; at T-24h or later it cannot.
- The request must explicitly confirm reset and carry the current schedule
  instant and settings submission. A stale tab, reschedule, duplicate request
  with another payload, or concurrent capacity edit cannot reset twice.
- An unexpected join lock, invite lock, incomplete Draft order, missing
  settings submission, running clock, started timestamp, pick, cycle,
  transaction, or waiver fails before any write.
- The original invite code and all current membership/team/roster documents
  remain. Expired invites are never reactivated.
- Reset clears Draft-specific readiness and order, but does not alter global
  Projection snapshots or their hashes. No old start task may start this Draft.
- Draft Setup cannot schedule until the order contains every current team;
  server preparation must regenerate or prove exact current Projection V11
  readiness before zero.

## Verification and staging evidence

`npm run test:batchl1b` includes L1C emulator regressions for the transaction,
duplicate/stale requests, cutoff, started state, competitive history, invite
expiry, and stale exact-start task. Run the inherited `verify:batchl1b`,
`build:all`, `git diff --check`, and clean-source guard on a reviewed clean
commit. Before release, use a disposable staging scheduled Draft to prove the
supported commissioner UI, password step, same invite, new manager joining,
full resaved order/time, two-tab convergence, and a normal T-25/T-20 readiness
and exact-start transition. Check 320/390/430/desktop, keyboard, zoom, and
the app themes. Do not use a real league as the first exercise.

Monitor bounded callable success/errors and p95 latency. Investigate
`failed-precondition`/`aborted` spikes, stale start-task skips, and any Draft
remaining in `setup` after commissioner reset. The per-league deterministic
audit records the prior scheduled instant and reset requirement without
putting invite codes, account IDs, or team IDs in aggregate logs.

## Deployment and rollback

Codex does not deploy. After independent review and staging proof, deploy
only `functions:updateLeagueCapacitySecure` and then `hosting:app` from the
same clean commit. Verify the Function revision and live Hosting manifest
independently. No Rules, indexes, TTL, App Check, queue, or worker deployment.

Before anyone uses the new action, restore the preceding verified Hosting
release and callable revision if necessary. After a successful reset, do
**not** blindly restore the former Draft order or start in Firestore. The
commissioner should save a new complete order/time through supported Draft
Setup; preserve the audit for review. A real Draft must not proceed until its
server readiness and exact-source release evidence pass.

Production Scoring V4, Projection V11 formulas and hashes, six-game/Game 7
ownership, roster transactions, standings, playoffs, Rules, indexes, TTL,
canonical authority, queue mode, and worker limits are unchanged. This slice
changes only the narrow pre-start Draft setup transition and capacity UI.
