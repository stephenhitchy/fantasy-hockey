# RinkRat B1Z — Injury Replacement Integrity and Presentation

## Purpose

B1Z hardens the B1V instant injury-replacement contract and makes its mixed-
player score understandable. It does not change Scoring V4 values, Projection
V11, the six-game allowance, or the rule that a started NHL game stays with
the player who owned it at puck drop.

An injury-replacement roster slot is one six-game competitive window that can
contain several immutable player segments. The browser may describe those
segments, but the saved server plan remains the authority.

## Required ownership behavior

- Preserve an outgoing segment even when zero of its games had started. The
  empty segment is audit evidence that the replacement happened; it must not
  consume a game.
- A newly built plan must round-trip through the same normalizer used by
  scoring and must own exactly the required number of unique provider game
  IDs. Builder output that the scorer would reject is never persisted.
- Present-but-invalid or conflicting pick/window ownership evidence fails
  visibly. It must never silently fall back to scoring every game as the
  current player.
- The regular-cycle pick/window copies and, during playoffs, the assigned-bank
  pick/window copies must all either contain the plan or all omit it. A move
  resolves compatible scorer-managed evolution from those copies before slow
  NHL work, fingerprints that exact authority, and repeats the same resolution
  inside the committing transaction. A missing copy, conflicting lineage, or
  preflight race aborts without partially rewriting the bank.
- The latest segment may legitimately evolve when its player changes NHL
  clubs, but prior segments are immutable. Every owned game carries its exact
  source club so a later trade or repeated injury cannot reassign history.
- Replacement activation boundaries are finite, nonnegative, equal across the
  segment and its continuity evidence, and monotonic across repeated moves.
  Segment IDs, player identity, slot position, owner/slot continuity scope,
  schedule, and game-to-player map are validated as one contract.
- Completed, live, incomplete-final, appearance, and live/final scored games
  are protected evidence. A compatible trade refresh may replace only
  unstarted current-segment IDs; it cannot drop, reassign, or change the source
  club of a protected game.
- A selected bench player reserved by an unrelated queued lineup move remains
  ineligible for an immediate replacement. The one allowed promotion is the
  exact ordinary bench swap already queued for the same active slot, outgoing
  player, bench slot, incoming player, and manager. Waiver-backed moves and
  any different or duplicate reservation fail closed.
- That exact queued swap is fingerprinted before expensive NHL work and
  reread inside the committing transaction. The injury mutation clears the
  pending roster move atomically and its audit record stores the superseded
  queued-move ID; a changed fingerprint aborts without moving either player.
- B2D automation may promote that saved move without another manager action,
  but only from fresh server availability evidence. Its deterministic receipt
  binds the exact pending-move fingerprint, and the transaction rechecks that
  the same matchup is still active before changing the roster.
- Promotion changes only the pending move's timing. Started games remain with
  the injured player, the replacement receives only the still-unstarted
  positions in the same six-game window, and a window with no remaining games
  is not rewritten.
- Immediately before the roster write, transaction-fresh cycle and playoff
  windows are compared with the preflight plan. A game that became live or
  final during schedule verification aborts the attempt rather than being
  filtered from the saved window; a retry rebuilds the plan around that newly
  protected game.
- The unattended B2D path additionally rechecks the exact puck-drop times for
  all outgoing and incoming games whose ownership would change. If any crosses
  its boundary before the transaction attempt, automation aborts even when the
  scorer has not yet written live evidence. The manager-triggered path retains
  the established server action-start boundary.
- Out/IR/LTIR eligibility is reread inside the Firestore transaction. A player
  who becomes ineligible while the request is being verified is not moved.
- Schedule verification uses the saved source team for every owned game, not
  only the player's current NHL team. Shared NHL fetching supplies bounded
  retry, throttling, request coalescing, and near-live cache behavior.
- Schedule discovery can recover ownership from a valid prior scoring result
  when a legacy pick copy lacks the plan. Canonical impact routing includes
  every segment player and source club so retained outgoing games continue to
  target the league for live and final processing.
- Final-score reconciliation resolves the segment owner for each NHL game and
  refuses malformed or conflicting game-to-player evidence. It remains an
  audit-only detector; B1Z does not enable automatic score correction.
- Regular-season asynchronous rollover and playoff-bank rollover advance only
  the latest replacement segment. Earlier players' games never become history
  for the current replacement.
- Playoff banks retain the plan, exact game-to-player map, and those fields in
  fingerprints and previous-score reconstruction.

The ordinary secure roster-action path repeats IR eligibility and queued-bench
reservation checks inside its transaction as well. Injury replacement must not
have a weaker race boundary merely because it is initiated from a different
screen.

IR capacity, roster identity, position, bench identity, roster pick, scoring
window, playoff bank, and audit transaction remain part of the atomic server
transaction. Concurrent changes fail closed and can be retried from fresh
state.

## Presentation contract

Mixed-player cards label the authoritative combined value **Slot total**.
They separately show each player's owned-game contribution and a persistent
game-range legend. Every prior segment carries the established injury-cross
icon so the split immediately explains why the player changed; the aggregate
screen-reader label names prior players as injured and the current player as
the replacement. Labels still say “owned games” rather than “points before
injury” because a retained live game or later NHL stat correction can change
after the roster transaction.

Six-game dots retain their played, missed, live, and upcoming fill. Ownership
is an additional treatment: the first dot in each replacement segment has a
non-color swap boundary, replacement-owned dots have an outline, and every dot
has an accessible label naming the player who owns that NHL game. A zero-game
outgoing segment is shown as “No games.”

The split is rendered only when the saved plan is valid, every begun game has
finite score evidence, and segment totals reconcile to the authoritative slot
total. Otherwise the combined authoritative score remains visible and the
split waits for consistent evidence; the UI never invents a zero.

Game Film resolves each saved game against its segment asset, loads that
player's NHL log, and names the credited player on the row. It must not apply
the current replacement player's statistics to an outgoing player's retained
game.

## Release guard and verification

Firebase predeploy runs the protected roster runtime contract. B1Z extends it
to require zero-game audit segments, plan round-tripping, strict malformed-plan
handling, transactional availability, reserved-bench rejection, current-
segment rollover in both regular season and playoffs, and playoff ownership
persistence. It also blocks releases that remove exact owner-map validation,
protected-game preservation, canonical segment routing, or per-game final
reconciliation. The B1Z regression suite covers zero-start and repeat
replacement, duplicate/overlapping IDs, NHL-team changes, opponent-overlap
game IDs, per-game source-team evidence, playoff copy races, canonical impact
routing, prior-result recovery, mixed-player reconciliation and presentation,
and the source contracts for every UI surface.

Future defense-in-depth work should add Firestore emulator race fixtures for
availability, bench-reservation, active-assignment, and playoff-bank changes
between preflight and commit; behavior-level rollover fixtures for repeated
replacements; and one end-to-end stale-pick plus trade-evolved-window case.
Those are test-depth improvements rather than known authority gaps. The
transaction checks, copy fingerprints, protected-game validation, and release
guard remain mandatory even after those fixtures exist.

## Release and rollback

The code change requires `hosting:app` and exactly these Function exports:

- `applyImmediateRosterMove`
- `executeSecureRosterAction`
- `getFinalScoreReconciliationPage`
- `initializeSeasonAfterDraft`
- `openNextCompetitionPeriod`
- `pollCanonicalNhlImpactFeed`
- `processHistoricalReplayAdvance`
- `processLeagueAutomationTask`
- `requestLeagueLiveScoringRefresh`
- `runScheduledLeagueAutomation`
- `runSeasonStartAutomation`

This list was traced from the changed handlers and their callers in
`functions/src/index.ts`; the repository's all-Functions reconciliation tool
is not a changed-source recipient planner. B1Z requires no Rules, index, TTL,
App Check, queue-mode, scoring-value, projection, or data-migration change.

Rollback is code-only, but do not deploy a scorer, roster authority, rollover,
or playoff-bank revision that predates B1Z while an injury-replacement window
is active. Existing mixed-player fields are authoritative evidence and must not
be deleted. If the presentation alone regresses, Hosting can be rolled back
without rolling back the hardened Functions.
