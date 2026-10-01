# D1L-E: Midseason NHL Player-Team Transfer Continuity

## Product decision

RinkRat follows the stable NHL player ID, not the team abbreviation copied
onto a fantasy roster card. A real NHL trade changes only the unsettled
remainder of that player's current six-game window.

- A game that has started, finished, or already has stable-player-ID
  appearance evidence never moves to another club.
- Future unsettled places in the window come from the player's newly confirmed
  NHL club.
- Later fantasy windows continue after every NHL game already assigned to the
  same uninterrupted fantasy slot/player stint. This prevents repeats when the
  destination club is ahead and skips when it is behind.
- A fantasy drop, benching/activation boundary, replacement, or later
  reacquisition starts a new fantasy stint. It does not inherit the former
  stint's schedule cursor.
- Team-goalie units remain club assets and do not use individual-player trade
  continuity.

This does not change Scoring V4 category values, Projection V11 formulas,
six-game limits, seventh-game rollover, or already-started game ownership.

## Evidence and cutover rules

The shared server identity catalog reads all supported NHL clubs and stores:

- stable NHL player ID;
- current NHL club;
- catalog observation-start timestamp;
- first retained confirmation time for the player's current uninterrupted
  club assignment; and
- a deterministic player/team identity hash.

The observation-start timestamp is deliberately captured before the provider
read. A multi-club refresh that begins before puck drop and finishes afterward
is not treated as wholly post-puck-drop evidence.

The scoring data fingerprint hashes a deterministic, player-ID-sorted subset
of this evidence for skaters in the current picks: stable player ID, resolved
club, and retained club-confirmation timestamp. The full 32-club catalog hash
and observation time remain on the result as audit provenance, but do not enter
the fingerprint. An unrelated NHL roster change therefore does not rewrite an
otherwise identical league score, while relevant player identity evidence does.

The aggregate catalog must be refreshed after the latest relevant puck-drop
boundary before a scoring pass may publish. The player's retained club
confirmation time then decides which destination games are unambiguous:

- destination games at or after club confirmation progress normally, including
  an ordinary scratch;
- a destination final before confirmation is accepted only when the stable
  player ID appears in that exact game; and
- a destination game already live before confirmation is not guessed. The
  scoring pass stays unchanged and retries after final appearance evidence is
  available.

A live or final game without exact `startTimeUTC` cannot prove which side of
an identity cutover it belongs to. Scoring fails closed and retries; it never
substitutes a date-derived noon timestamp for puck drop. A game already owned
by the same fantasy stint is excluded before this ambiguity check, so a shared
former-club-versus-destination-club game cannot block its own continuation.

If the provider omits a rostered player, assigns one stable ID to conflicting
clubs, omits a club roster, or cannot provide required final appearance
evidence, scoring fails visibly and retries. Missing evidence is never replaced
with zero.

When a complete 32-club refresh still omits a required stable player ID, the
server retains bounded negative-coverage evidence for five minutes. Calls keep
failing visibly during that cooldown without repeatedly downloading every club
roster; a newer puck-drop or roster-action evidence boundary can bypass the
older miss and request a fresh check.

## Persistent continuity

Each active skater slot carries schema-1 `PlayerWindowContinuity` evidence:

- an owner/slot/asset/stint identity;
- all NHL game IDs assigned by earlier completed windows in that stint; and
- the NHL club that supplied the immediately preceding completed window.

The full cursor is stored with the cycle roster pick and team window. Aggregate
score summaries keep only the compact continuity ID, avoiding cumulative array
growth in shared scoring documents.

Cycle/window publication uses transactionally checked asset and continuity
identity. A stale scoring worker cannot overwrite a newer roster move. Regular
rollover, queued move activation, first-playoff-window creation, later playoff
banks, and immediate untouched moves either carry or reset the cursor according
to the same fantasy-stint rule.

For assigned playoff banks, the active cycle and bank are updated together.
Bank scoring re-reads the current authority and rejects stale pick, assignment,
or score state instead of restoring an older bank. Incoming picks derive their
direct target IDs from the new NHL club and never keep the outgoing club's
direct frozen-ID list.

My Team continues to keep the stable player identity and headshot, while its
club label and small team badge prefer the current scoring window's resolved
schedule club. Team-goalie units retain their fixed NHL club identity.

## Legacy behavior

An active regular-season cycle without the schema marker is bootstrapped once
from every contiguous persisted, started window for the same owner/slot/asset
stint. Pick and team-window copies are written atomically with the cycle marker.
Conflicting, missing, divergent, or unstarted historical ownership evidence
fails closed.

Legacy playoff banks created before schema 1 remain deliberately fail-closed
at the next-bank boundary. They require a separate, evidence-preserving bank
migration before they can advance; the implementation does not guess their
history. New playoff banks are schema 1, so this affects only banks that already
existed before rollout.

## Examples

### Trade while the old club is playing

If Game 2 for the former club is already live when the trade is confirmed,
Game 2 remains in the current window. Only the remaining future positions move
to the new club.

### Destination club already played more games

Final destination games before confirmation are skipped unless the stable
player ID proves the player appeared. The cursor then continues from the next
eligible destination game; it does not blindly copy the former club's schedule
ordinal.

### Destination club is behind

The current window starts with the destination club's first eligible game.
Later windows consume the persisted cursor, so no destination game is repeated.

### A to B to A

All game IDs from the uninterrupted fantasy stint remain reserved. Returning
to Club A cannot reuse the Club A games owned before the player left.

### Fantasy drop and reacquisition

The reacquired player receives a new continuity ID and a hard activation-time
boundary. Games that started before reacquisition are ineligible even if later
provider evidence shows an appearance.

## Rollout and rollback

This is a mixed-writer schema change. Deploy all roster/cycle/playoff writers
and scoring readers in one drained automation window, with no scoring or roster
move jobs in flight. A partial rollout can let an old writer omit or overwrite
continuity evidence.

Before rollout, confirm there are no active legacy playoff banks. If any exist,
do not enable schema enforcement until they have an approved migration plan.

Rollback before schema-1 documents are published is ordinary Function revision
rollback. After publication, rolling back only some writers is unsafe. Restore
the complete prior Function set together or roll forward; do not delete cursor
fields or rewrite game ownership.
