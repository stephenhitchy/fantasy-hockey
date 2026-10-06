# RinkRat B1V — Instant Injury Replacement

## Product contract

RinkRat rosters have 14 active slots, five flexible bench slots, and three
Injured Reserve slots. Existing roster documents are normalized to add empty
`B-4` and `B-5` slots; there is no bulk production migration.

An active skater with an authoritative `Out`, `IR`, or `LTIR` status may be
replaced immediately by a same-position bench skater when an IR slot is open.
The operation is one server transaction:

1. The injured starter moves to the open IR slot.
2. The selected bench skater moves into the active slot.
3. Every NHL game that had reached its exact puck-drop boundary remains owned
   by the outgoing skater, including a live game.
4. Unstarted outgoing games are removed. The incoming skater receives the
   exact number of future games needed to leave the active slot with six total
   owned games.
5. Games and points earned while the incoming player was benched never move
   into the active score.

The current replacement remains the starter. A later replacement uses the
same rules only if that current starter also becomes IR-eligible. Each segment
stores its scoring asset and exact provider game IDs, so retries, settlement,
and a second injury cannot duplicate or move an already-started game.

## Scoring and rollover

The scorer resolves each owned game against the player assigned to that game,
not merely the slot's current player. Final-game reuse also verifies that
game-to-player assignment before retaining a saved score. The combined window
must normalize to exactly six unique games or scoring fails visibly and
retries without writing a partial result.

When the matchup completes, only the current replacement segment advances the
player-window continuity cursor. Earlier injured-player games remain in the
completed matchup and do not become history for the replacement player.

## Draft effects

New drafts use 19 rounds: 14 starters plus five bench picks. Auto-Draft targets
three reserve forwards and two reserve defensemen, with no reserve Team Goalie
Unit. Draft Ranking V4 uses the same demand model. Projection V11 formulas,
hashes, and scoring values are unchanged.

## Release and rollback

This change requires Hosting plus the targeted roster, scoring, draft, and
projection Functions listed in the release handoff. It does not require a
Firestore Rules, index, TTL, App Check, queue-mode, or data-migration change.

Rollback is code-only: restore the prior Hosting build and prior targeted
Function revisions. Do not delete injury-replacement fields from completed or
active windows; the prior scorer does not understand those mixed-player
windows, so any active replacement window must remain on the B1V-capable
scoring Functions until it settles.
