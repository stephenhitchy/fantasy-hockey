# Scoring V5 Candidate — Shootout Scoring

**Status:** implemented and testable, not activated in Production
**Production default:** Scoring V4
**Projection model:** Projection V11, numerically unchanged
**Migration authority:** guarded preseason-only administrator scripts
**Primary change:** explicit shootout-goal fantasy event
**Unchanged:** ordinary goals and assists, overtime scoring, official NHL season
statistics, six-game windows, seventh-game rollover, roster timing, frozen
projections, server authority, and completed-window immutability

## Decision

RinkRat already handles an overtime goal as an ordinary NHL goal plus the
existing game-winning-goal and overtime-goal bonuses. It did not previously
award a skater category for a successful shootout attempt. The NHL box score
also intentionally excludes shootout attempts from ordinary goals, shots,
goals against, saves, and save percentage.

Scoring V5 adds a separate fantasy category instead of changing any ordinary
stat:

```text
shootoutGoals × 2.0
```

Every successful attempt counts, including a second successful attempt by the
same skater in a long shootout. A miss or save is worth zero.

## Exact skater behavior

| Shootout event | Fantasy effect |
|---|---:|
| Successful attempt | **+2.0** |
| Missed or saved attempt | 0 |
| Ordinary goal | 0 additional |
| Shot on goal | 0 |
| Assist | 0 |
| Power-play/short-handed bonus | 0 |
| Game-winning-goal bonus | 0 |
| Overtime-goal bonus | 0 |
| Plus/minus | 0 |

The value is flat for forwards and defensemen. A regulation goal and a
successful shootout attempt are represented separately as `goals: 1` and
`shootoutGoals: 1`; they are never combined into `goals: 2`. This prevents a
shootout attempt from affecting position-specific goal values, multi-goal or
hat-trick treatment, NHL season totals, normal shots, or goal-rate
projections.

## Exact team-goalie behavior

Shootout attempts do not alter saves, shots against, goals against, save
percentage, save-quality scoring, or workload. The final NHL result still
determines the normal RinkRat team-goalie win bonus.

Scoring V5 adds one RinkRat-specific shutout rule:

> A successful shootout goal breaks the opposing team-goalie unit's shutout.

Therefore, in a 0–0 game after overtime:

- a 1–0 shootout winner earns the win and shutout; the losing unit earns
  neither;
- if both clubs score in the shootout, neither unit earns a shutout and the
  winning unit still earns the win;
- all official saves and save-percentage inputs remain exactly as they were at
  the end of overtime.

This is an explicit fantasy rule. It does not rewrite the NHL provider's
official goalie statistics.

## NHL source and canonical facts

The approved NHL play-by-play feed represents shootout rounds with
`periodType: "SO"`. Only an event with `typeDescKey: "goal"`, a stable scorer
ID, and a scoring-team ID matching one of the selected game's teams becomes a
shootout goal. `shot-on-goal`, `missed-shot`, and malformed or cross-game team
events do not score.

Final V5 scoring requires a valid box-score game outcome and validated
play-by-play evidence. When the box score says the game ended in a shootout,
the feed must contain both at least one attributable shootout goal and the
provider's `shootout-complete` terminal event. This prevents a partial feed or
missing play-by-play from being interpreted as proof that the shootout is
complete. Canonical NHL facts use schema version 3 to retain the two team IDs,
box-score outcome, terminal-event state, shootout scorer/team identity, and
goalie-in-net identity needed for deterministic reconstruction. The terminal
state participates in the source hash so a late completion event retriggers
scoring even when no other statistic changes. Older canonical schemas cannot
settle V5 and fall back to the established direct source path.

Requests remain on-demand/shared through the existing NHL cache and canonical
pipeline. No browser owns the competitive result.

## Projection V11 and Draft behavior

Projection V11 does not project shootout goals. Its formulas and protected
source remain unchanged because shootout occurrence, shooter selection, and
attempt order are too volatile for the initial category. A V4 projection
snapshot cannot be reused for a V5 league: snapshot identity carries the exact
scoring-rules version and mutable pointers must be regenerated during a
preseason transition.

## Six-game ownership

One NHL game remains one game in the player's or team-goalie unit's six-game
window. Shootout length and attempt count cannot create another appearance,
move the game to another matchup, or alter seventh-game rollover.

## Version and activation boundary

The source supports Scoring V5, but these production defaults remain pinned:

```text
CURRENT_SCORING_RULES_VERSION = 4
defaultScoringRules = scoringRulesV4
```

Stored V5-only fields are ignored and removed when a V3 or V4 league is
normalized. A future scoring version is rejected instead of being coerced.
League creation therefore remains V4 until a deliberate, separately approved
activation changes the default.

The V5 migration is dry-run-only unless the explicit apply guard is supplied.
It permits only canonical V4 → V5 for a league with no competition cycle,
Draft pick, or live/completed Draft. It invalidates mutable projection
pointers and Draft projection pins while retaining immutable Projection V11
snapshot assets as evidence. There is no mixed-history bypass.

Rollback is permitted only at the same clean preseason boundary. Once V5
competition history exists, freeze the league and preserve evidence; do not
silently rewrite it as V4.

## Acceptance coverage

The focused V5 suite verifies:

- V4 remains the current/default contract;
- one and multiple successful shootout attempts score exactly two points each;
- forward and defense values are identical;
- Scoring V4 ignores the new category;
- a shootout success cannot produce an ordinary goal, shot, assist, special-
  teams, game-winning, or overtime bonus;
- one-sided and two-sided shootout scoring apply the goalie shutout rule while
  leaving saves and save quality unchanged;
- provider parsing counts only valid successful attempts;
- direct and canonical final-settlement evidence is version-aware;
- canonical schema/hash identity separates the new evidence;
- V5 migration and rollback remain preseason-only; and
- Projection V11 contains no shootout projection input.

Before activation, run the inherited full release gate and manually verify a
regulation final, an overtime final, a one-sided shootout, a shootout in which
both teams score, and a long shootout in a disposable non-production league.

## Deployment scope

No deployment or production-data change was performed with this implementation.
A future approved cutover requires the full V5-aware Functions codebase and
Hosting client to be released and old Functions revisions/in-flight work to be
drained before migrating any exact league. Hosting-first or migration during a
mixed Functions rollout is unsafe because an older worker does not understand
V5 evidence. Firestore Rules, indexes,
TTLs, App Check mode, scoring queue mode, worker limits, Production Scoring V4
values, and Projection V11 formulas do not change.
