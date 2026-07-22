# Roster V2, Flexible Bench, and Goalie Projection Upgrade

## Final roster format

| Roster area | Slots | Scores fantasy points? |
|---|---:|---|
| Left Wing | 3 | Yes |
| Center | 3 | Yes |
| Right Wing | 3 | Yes |
| Defense | 4 | Yes |
| Team Goalie Unit | 1 | Yes |
| Flexible Bench | 3 | No |
| Injured Reserve | 3 | No |

Each team drafts 17 assets. Only the 14 active slots create immutable six-game
scoring windows. Bench and IR assets remain owned but never contribute points
until they legally enter an active slot.

## Goalie projection correction

The goalie model previously clamped both draft and next-cycle forecasts to a
minimum of 100 points. Any calculated result below 100 therefore appeared as
exactly 100. The lower bound is now zero while the six-game maximum remains 180
(30 points per game times six games).

The separate normalized 0–100 goalie rating remains intentional and is labeled
**Goalie Rating** so it cannot be confused with projected fantasy points.

Projection snapshot schema/model Version 7 forces stale Version 6 boards to be
regenerated.

## Draft behavior

- Draft length increases from 14 to 17 rounds per team.
- Required active slots fill before an extra player at that position is sent to
  the bench.
- A manager may draft additional LW, C, RW, D, or team-goalie units while a
  flexible bench spot remains open.
- Once a position's active requirement and all three bench spots are filled,
  that position is disabled.
- The draft button changes to **Draft to Bench** when appropriate.
- A horizontal roster-needs strip shows active requirements and bench capacity.
- Auto-draft prioritizes missing starters before legal bench depth.
- Queue assets stay queued when temporarily ineligible.
- The UI protects starter supply at every position. The transaction layer also
  enforces the materially scarce goalie-unit reserve so no manager can hoard an
  extra goalie while another team still needs G1.
- Two consecutive expired turns still enable persistent auto-draft.

## Cycle-safe bench logic

A bench asset is evaluated against its NHL team's immutable six-game blocks at
the moment a lineup transaction is submitted.

The activation cycle is the later of:

1. the active roster slot's next available cycle; and
2. the incoming asset's first cycle whose games had not begun before the
   transaction.

Example:

- Active Player A is in Cycle 5.
- Bench Player B is already in Cycle 6, Game 2.
- Player B cannot receive those known Cycle 6 results.
- The earliest eligible activation is Cycle 7.

The transaction locks that fair cycle when submitted. Games that occur later
cannot retroactively change the manager's already-committed decision.

When the swap activates, the outgoing active asset moves into the same bench
slot atomically. No player is accidentally dropped and no frozen window is
rewritten.

## Free agency and waivers

The mobile two-step add/drop interface now supports:

- open active slots;
- replacing an active same-position asset;
- open flexible bench slots; and
- replacing any bench asset.

A bench acquisition is owned immediately, but the UI separately displays its
first legal active scoring cycle. This prevents the phrase “activates now” from
implying that already-played games will count.

Bench assets count as owned for free-agent and waiver availability. Waiver
claims store whether the destination is active or bench, and waiver processing
preserves that destination and cycle eligibility.

## Injured Reserve

- IR capacity is three skater-only slots.
- Active and bench skaters can move to IR when availability data says they are
  eligible.
- Bench-to-IR moves are immediate because neither area scores.
- An IR skater can return to an open bench slot or deliberately replace an
  occupied bench asset; the replaced asset goes to waivers.
- A bench asset reserved for a queued active-lineup swap cannot be dropped,
  moved to IR, or replaced until the pending swap is canceled or activated.
- Returning an IR player to an active slot retains the asynchronous cycle
  boundary protections.

## Regular season and playoffs

The browser and Cloud Functions copies of the roster, cycle, projection, and
playoff models were updated together.

- Cycle snapshots are created from `activeSlots` only.
- Bench and IR assets create no matchup windows and score zero.
- Matchup completion still expects the same 14 active slot windows.
- Pending active/bench swaps activate identically in regular-season and playoff
  window-bank paths.
- The scheduled server worker remains authoritative when browsers are closed.
- Automatic Cycle 1 creation after draft completion now waits for all 17 picks
  per team, then snapshots only the 14 active slots.

## Data and rule changes

Roster documents now use schema Version 2:

```text
schemaVersion: 2
activeSlots: 14
benchSlots: 3
irSlots: 3
```

Draft documents use schema Version 3 and include three bench slots and 17
rounds. In-progress legacy drafts are normalized to 17 rounds. Completed
14-round drafts are deliberately not rewritten because retroactively extending
a completed snake draft would change draft order and competitive fairness.

Firestore rules require the new exact roster shape and allow the new owner
transaction types for active/bench swaps and bench/IR moves.

## Migration behavior

Opening an older roster through `getOrCreateFantasyRoster()` persists the new
schema. A player stored in legacy IR-4 moves into the first open bench slot.
This protects the asset, but a clean new league remains the safest production
validation path because old completed drafts did not contain the three added
rounds.

## Validation performed in the build environment

- TypeScript syntax transpilation: 134 files, zero syntax errors.
- Angular HTML control-flow brace smoke check: passed.
- CSS brace check: passed.
- Firestore Rules brace check: passed.
- App TypeScript diagnostics introduced versus the untouched source: zero.
- Functions TypeScript diagnostics introduced versus the untouched source:
  zero after normalizing the dependency-missing baseline.
- Client/server shared roster, cycle, and playoff copies were compared; their
  logic matches apart from expected browser/Admin SDK imports.
- The exact replacement overlay was applied to an untouched project copy for a
  second validation pass.

The sandbox could not run the real Angular or Functions production compilers
because npm dependencies were unavailable there. The package must therefore be
validated locally with `npm install`, `npm run build`, and
`npm --prefix functions run build` before deployment. No claim is made that a
production build ran inside the sandbox.
