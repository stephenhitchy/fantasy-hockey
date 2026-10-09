# RinkRat B2C — Immediate Injury Replacement Action

## Purpose

B2C makes the existing B1V/B1Z instant injury-replacement path the clear
primary action on My Team. It does not change which statuses are eligible,
Scoring V4 values, six-game ownership, or the saved mixed-player plan.

When an active skater is authoritatively listed as Out, IR, or LTIR, an IR
slot is open, and a compatible bench skater is available, the roster action
sheet leads with **Replace Injured Player Now**. That action opens the bench
picker and submits the existing server-authoritative injury-replacement
request. It does not run the ordinary lineup timing preview and never queues a
normal next-matchup swap.

The separate action is labeled **Move to IR Without a Replacement**. Its copy
states that it does not start a bench player immediately and that a started
six-game assignment remains protected until its fair boundary. This preserves
the older ownership-only operation without presenting it as the instant
replacement workflow.

## Exact queued bench-swap promotion

A manager may have scheduled the same active/bench swap before the starter's
injury became eligible. The client exposes immediate promotion only when all
saved evidence identifies that exact pairing:

- the pending move belongs to the current manager and active slot;
- its outgoing asset is still the active player;
- `sourceBenchSlotId` is the selected bench slot;
- its incoming asset is still the player in that bench slot;
- the move has a bench destination and no waiver source; and
- both players have the same roster position.

Any free-agent reservation, awarded waiver, different bench reservation,
changed asset, or other queued move remains review/cancel-only. The Function
must repeat these checks transactionally before clearing the queued move.

## Release and rollback

The client portion requires Hosting. It is paired with the narrowly scoped
server change that permits the exact queued bench-swap promotion through
`applyImmediateRosterMove`; do not release the client promotion UI without
that Function revision.

Rollback by restoring the preceding Hosting release and matching Function
revision. No Firestore migration, Rules, indexes, TTL, App Check, scoring
queue, Projection V11, or scoring-value change is required.
