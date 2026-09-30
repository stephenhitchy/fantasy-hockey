# FF1-42 Late-Season Opening Window

## Product contract

Fantasy matchup numbering is local to a league. A newly drafted league always
opens **Fantasy Matchup 1**, even when the NHL season is already underway.

The NHL games behind that matchup are selected independently:

1. Load the complete regular-season schedule for all 32 active NHL clubs.
2. For each club, count the longest chronological prefix whose games are
   officially `FINAL` or `OFF`.
3. Take the minimum of those 32 counts.
4. Select the first six-game NHL block that is not already complete for every
   club: `floor(minimum / 6) + 1`.

Examples:

- A club at five final games keeps Fantasy Matchup 1 on NHL games 1–6.
- Every club at six through eleven final games moves Fantasy Matchup 1 to NHL
  games 7–12.
- Every club at twelve through seventeen final games moves Fantasy Matchup 1
  to NHL games 13–18.

Earlier NHL blocks are skipped. They do not create fantasy matchups, standings
rows, or historical results in the new league.

## Freeze and compatibility rules

- The server freezes the opening NHL block only after the T-40 membership and
  Draft-order cutoff succeeds.
- The evidence is bound to the exact NHL season, scheduled start, and Draft
  schedule generation. Canceling, postponing, or rescheduling invalidates it.
- All 32 club schedules and every game ID required through the league's final
  playoff source block must be available. Missing, truncated, or malformed
  evidence blocks Draft readiness rather than substituting zero or a partial
  schedule.
- The ordered source-game plan is frozen for every remaining regular-season
  and playoff window, not only the opening six. Projection and scoring select
  those exact IDs, so a later provider insertion or reorder cannot move an
  assigned game across a matchup boundary.
- Fantasy Matchup `N` after opening uses NHL source block
  `initialNhlBlockNumber + N - 1`. The seventh eligible NHL game still belongs
  to that slot's next fantasy matchup.
- Skipped NHL blocks shorten the new league's regular season by the same
  number of blocks. The standard playoff-round count is preserved and must
  still finish within complete six-game blocks through NHL Game 78. A Draft
  that starts too late to leave at least one regular-season matchup plus every
  playoff round fails readiness visibly.
- Legacy leagues without the new anchor fields retain their historical mapping
  (`Fantasy Matchup N` uses NHL block `N`). No migration rewrites an existing
  started window.
- A pre-FF1.40 Draft that is still scheduled with zero picks is upgraded only
  at its existing T-40 cutoff. The server binds it to explicit generation `0`,
  preserves an exact existing order without rerandomizing it, and then freezes
  the opening source block. A stale task, canceled schedule, or locked order
  that does not exactly match the current teams fails closed and requires the
  commissioner to postpone and reopen; the server does not repair it silently.

If the NHL schedule no longer contains a complete six-game block for every
club, the server fails visibly. It never wraps to earlier games or silently
weakens RinkRat's six-game contract.

## Competitive boundaries

This change does not alter Production Scoring V4 values, Projection V11
formulas, roster eligibility, waiver timing, matchup pairings, or standings
rules. It changes only which immutable NHL schedule block a new late-season
league uses as its starting source window and carries that explicit offset
through projection and scoring selection.

## Mixed-version release requirement

Anchored Projection V11 snapshots use integrity hash schema 3 so the NHL
source block and season-window evidence hash are sealed with the existing
projection output. New Hosting reads both legacy schema 2 and anchored schema
3; pre-change Hosting reads schema 2 only. Release Hosting before Functions so
an older browser bundle never receives a newly published schema-3 pointer.

Rollback is similarly ordered: stop publishing schema-3 snapshots before
rolling Hosting back. Old Functions cannot consume a schema-3 pointer; if a
Functions rollback is required after schema 3 has published, republish a
compatible schema-2 projection pointer before relying on old workers. No
Firestore migration or historical-window rewrite is part of this feature.
