# Projection Engine V8 Report

## Goals

Projection Engine V8 improves the accuracy, explainability, freshness, and roster-move behavior of six-game cycle projections.

## Projection layers

Each cycle projection is now built in this order:

1. **Stable talent baseline**
   - Blends current-season scoring pace with prior-season history.
   - Uses a second previous season when available to stabilize small samples.
   - Applies position-specific sample caps so a hot first week cannot create an unrealistic full-season pace.

2. **Current form**
   - Uses 3-, 5-, 10-, and 20-appearance fantasy-point rates.
   - Weights the 10- and 20-game samples most heavily while retaining a small signal from the last 3 and 5 games.
   - Partial appearances are down-weighted so an injury-shortened game does not look like a normal poor performance.

3. **Role / ice time**
   - Compares recent TOI with season TOI.
   - Applies a bounded role adjustment for skaters so promotion or demotion matters without overpowering talent.

4. **Exact six-game schedule**
   - Evaluates the actual opponents assigned to the target fantasy cycle.
   - Blends current-season opponent results with prior-season strength early in the year.
   - Includes opponent offense, defensive difficulty, overall strength, home/road, back-to-backs, opponent back-to-backs, and rest advantage.
   - Uses separate skater and team-goalie sensitivities.
   - The layer is confidence-weighted and capped so schedule cannot dominate player talent.

5. **Availability / injury expectation**
   - Evaluates each scheduled NHL game separately.
   - A game before an expected return contributes zero expected availability.
   - Games immediately after an expected return receive a conservative probability because return dates are not guarantees.
   - A confirmed one-game absence therefore behaves close to a 5-of-6 projection, while an uncertain return can be discounted further.
   - Stores expected games available and expected games missed.

6. **Reliability and manager-facing calibration**
   - Reliability considers sample size, consistency, recent missed team games, and availability status.
   - The prior heavy hidden projection discount was reduced. Version 8 uses 98% for forwards, 97% for defensemen, and 96% for team goalie units so forecasts remain slightly conservative without systematically undershooting almost everyone.

## Schedule model bounds

The exact schedule adjustment is deliberately bounded:

- Skaters: approximately -6% to +6%
- Team goalie units: approximately -8% to +7%

Individual game factors are also bounded before confidence weighting. This prevents one perceived easy opponent from overwhelming the talent and form layers.

## Stale roster-swap projection fix

The immediate roster-move Cloud Function now:

1. Identifies the incoming asset.
2. Loads the shared projection snapshot for the exact target cycle when available.
3. Falls back to the current Version 8 shared snapshot only when it matches the target cycle.
4. Removes any frozen projection inherited from an old bench, IR, or prior-slot assignment.
5. Creates a new immutable projection for the incoming player and target roster slot.
6. Rewrites the untouched cycle window and roster-pick snapshot with that incoming projection.

This fixes the issue where replacing a player before either one had started could leave the outgoing player's projection displayed on the slot.

## Projection freshness

- Shared projection schema/version increased from 7 to 8.
- Existing Version 7 snapshots are intentionally rejected and must be regenerated.
- Exact-cycle snapshots are considered fresh for six hours instead of twenty hours, allowing form, schedule, and injury changes to reach future windows sooner.
- Already-started slot projections remain immutable, preserving fairness.

## Projection Lab visibility

Projection Lab now shows:

- Schedule point adjustment
- Favorable / neutral / difficult label
- Difficulty rating
- Schedule-data confidence
- Home and road count
- Back-to-back count
- Rest advantages
- Exact opponent abbreviations
- Expected games available and availability impact

Projection Accuracy records now retain the schedule and expected-missed-game context, allowing later calibration by position and cause.

## Files and systems affected

- Draft and cycle player-pool projection generation
- Shared projection snapshot Version 8
- Cycle and playoff projection metadata
- Roster and draft projection models
- Projection Accuracy history
- Projection Lab
- Immediate add/drop, bench activation, and IR activation
- Browser and Cloud Functions copies of shared cycle logic

## Required rollout step

After deployment, a commissioner must open Projection Lab and select **Refresh Shared Projections**. This creates the first Version 8 current/target snapshot. Existing frozen projections for windows that have already started are intentionally not changed.

## Validation performed

- All 141 TypeScript files passed syntax transpilation.
- The schedule engine and player-pool projection service passed strict standalone TypeScript checking.
- Focused schedule tests confirmed favorable-opponent uplift and bounded back-to-back effects.
- The pre-existing `assetType` TypeScript error in `cycle-projection.util.spec.ts` was corrected, removing the projection-test blocker reported by earlier builds.
- Browser and Functions projection model fields were checked for parity.
- The replacement package was applied to a clean copy before archive creation.

The final Angular and Firebase Functions builds must be run locally because the packaging environment could not complete npm dependency installation.
