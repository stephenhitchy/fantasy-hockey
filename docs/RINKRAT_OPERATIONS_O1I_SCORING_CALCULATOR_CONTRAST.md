# Operations Batch O1I — Public Scoring Calculator and Contrast-Safe Scoring

**Runtime release:** Release Candidate 59
**Competitive models:** Production Scoring V4 · Projection V11
**Operations API:** v1 unchanged
**Deployment:** Hosting only

## Purpose

O1I makes scoring easier to understand and easier to read without changing the formula. It adds one unauthenticated scoring calculator and removes favorite-team color dependence from scoring-reference values and completed Game Center scoring breakdowns.

## Public calculator

The public route is:

```text
/scoring-calculator
```

It calls the existing browser scoring implementation directly:

```text
calculateSkaterGameBreakdown
calculateGoalieGameBreakdown
defaultScoringRules
```

There is no duplicate calculator-only scoring model. Forward mode is the shared LW/C/RW formula; defense mode uses the existing defense TOI/plus-minus multiplier; goalie mode uses the existing uncapped Production Scoring V4 Team Goalie Unit formula.

The calculator validates impossible or malformed inputs, shows every category contribution, displays save percentage for goalie units, and offers a repeated-six-game scale example. The scale example is explicitly not a projection.

## Contrast-safe scoring values

The public Scoring Guide uses a fixed scoring-reference accent and action palette instead of favorite-team variables. Numeric values use the normal semantic text color.

The completed Game Center matchup breakdown uses this fixed dark-scoreboard palette:

```text
Primary:  #f8fafc
Muted:    #cbd5e1
Subtle:   #9fb0c7
Positive: #4ade80
Negative: #fb7185
Neutral:  #facc15
```

These values remain independent of team identity colors, so a dark team palette cannot make the scoring totals or deltas disappear into the background.

## Boundaries

O1I changes no:

- Production Scoring V4 value;
- legacy Scoring V3 reconstruction;
- Projection V11 calculation;
- Draft or roster ranking;
- six-game window or seventh-game rollover;
- server competitive authority;
- Function, Rule, index, TTL policy, App Check mode, scoring queue, or shared NHL-cache mode.

## Verification

```bash
npm run test:batcho1i:run
npm run audit:product-copy-density
npm run verify:batcho1i
```

## Deployment

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1I Public Scoring Calculator Release Candidate 59"
```

## Live checks

1. Open `/scoring-calculator` while signed out.
2. Confirm the example totals and category lines update immediately.
3. Confirm invalid goalie and special-team stat lines fail visibly.
4. Switch between multiple team identities and themes.
5. Confirm Scoring Guide values remain readable.
6. Open a completed Game Center matchup and confirm totals, deltas, and impact rows remain readable under every team palette.


## O1I.1 TypeScript 6 verification hotfix

The first O1I package passed explicit scoring source files directly to `tsc`. TypeScript 6 reports TS5112 when a repository configuration exists and source files are supplied that way. O1I.1 writes one temporary isolated Node16 `tsconfig.json` and invokes `tsc --project`, retaining strict semantic checking and changing no runtime source.
