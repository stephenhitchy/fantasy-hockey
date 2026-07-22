# Fantasy Hockey Scoring V3 — Position Identity Balance

## Design goals

Scoring V3 gives each roster group a distinct fantasy identity while preserving the app's immutable, asynchronous six-game asset windows.

- **Forwards remain the stars.** Their scoring values are unchanged from V2 so goals, primary assists, multi-goal games, and special-teams production continue to create the largest superstar performances.
- **Defensemen become the foundation.** A little more value comes from repeatable TOI, blocks, and hits, while goals and assists have slightly stronger diminishing returns. This raises the dependable floor and controls the ceiling.
- **Goalie units remain the heartbeat.** A bad game can hurt and an excellent game can swing a matchup, but save percentage is now scored on a smooth curve instead of hard tier cliffs.

## Version

- Scoring rules version: **3**
- Six scheduled NHL team games per asset window: unchanged
- Forward scoring: unchanged
- No league-wide cycle start/end assumption was introduced

## Defense changes

| Rule | V2 | V3 |
|---|---:|---:|
| First goal | 5.00 | 4.50 |
| Second goal | 3.25 | 2.75 |
| Additional goals | 2.00 | 1.50 |
| First primary assist | 4.25 | 4.00 |
| Second primary assist | 3.00 | 2.75 |
| Additional primary assists | 2.00 | 1.50 |
| First secondary assist | 2.00 | 1.75 |
| Second secondary assist | 1.25 | 1.00 |
| Additional secondary assists | 0.50 | 0.40 |
| Shot | 0.45 | 0.40 |
| Hit | 0.50 | 0.55 |
| Block | 0.90 | 1.05 |
| Power-play point | 1.00 | 0.85 |
| TOI base multiplier | 0.25 | 0.27 |
| Plus/minus TOI modifier | 0.03 | 0.015 |
| TOI multiplier floor | 0.18 | 0.24 |
| TOI multiplier ceiling | 0.36 | 0.31 |

A synthetic scoreless 22-minute defense game with two shots, one hit, and two blocks moves from about **8.70** to **9.39** points, an approximately **8% floor increase**. A strong one-goal, one-primary-assist performance remains highly valuable but is slightly compressed at the top.

## Goalie changes

| Rule | V2 | V3 |
|---|---:|---:|
| Completed team-game base | 0 | 3.00 |
| Save | 0.30 | 0.27 |
| Win | 4.00 | 3.50 |
| Shutout | 6.00 | 4.00 |
| Save quality | Hard tiers | Continuous curve |
| Save-quality baseline | N/A | .900 |
| Baseline quality points | N/A | 4.00 |
| Points per percentage point from baseline | N/A | 1.20 |
| Quality minimum | 0 | -3.00 |
| Quality maximum | 15.00 | 10.00 |
| Per-game maximum | 30 | 28 |

Save quality is calculated continuously around the frozen `.900` scoring-environment baseline. The baseline is stored as part of the scoring rules so historical game scores remain deterministic. It can be deliberately revised in a future scoring-rules version before a season if the NHL environment changes materially.

### Example V3 goalie games

| Performance | Fantasy points |
|---|---:|
| Pulled: 10 saves on 15 shots | 2.70 |
| Poor loss: 24 saves on 30 shots | 6.48 |
| Average loss: 27 saves on 30 shots | 14.29 |
| Average win: 27 saves on 30 shots | 17.79 |
| Strong win: 28 saves on 30 shots | 22.06 |
| Elite win: 29 saves on 30 shots | 24.33 |
| 30-save shutout win | 28.00 cap |

## Compatibility and migration

Older league documents remain readable. Both the Angular app and the server automation normalize leagues below Scoring V3 in memory:

- Forward rules are preserved.
- Defense and goalie sections move to the V3 defaults.
- Existing asynchronous asset-window boundaries are unchanged.
- The scoring fingerprint changes, so active scoring snapshots can be rebuilt under V3.

Because this is a scoring-version change, it should be deployed before real season windows begin. Old completed test windows may continue to display their stored test totals until the league/test data is reset or recalculated.

## Projection alignment

Goalie draft and cycle projections now use the same continuous save-quality function as live scoring. The goalie fallback baseline and high-end cap were recalibrated to the new per-game distribution.

## Validation completed

- Browser and Functions scoring rule files are byte-for-byte equivalent.
- The two scoring engine files are byte-for-byte equivalent.
- Scoring rules and scoring engine passed isolated strict TypeScript compilation.
- Firebase Functions passed a full TypeScript build.
- Synthetic goalie and defense scenarios were calculated through the actual V3 scoring engine.
