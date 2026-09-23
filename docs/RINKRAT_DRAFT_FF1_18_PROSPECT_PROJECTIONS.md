# RinkRat Prospect Projection Layer V1

Date: 2026-09-22
Status: implemented behind a disabled-by-default server evidence gate; no live
prospect provider is connected.

## Outcome

Prospect Projection Layer V1 is an optional input adapter for Projection V11.
It does not replace Projection V11, Production Scoring V4, Draft Ranking V3,
the canonical NHL asset catalog, or the six-game window scheduler.

When valid evidence is enabled, the server performs this path:

```text
validated pre-NHL evidence
  -> category-specific league translation
  -> stat-specific blend with NHL evidence in Projection V11
  -> exact scheduled-game appearance probabilities
  -> existing RinkRat fantasy-point calculation
  -> Draft Ranking V3 replacement/scarcity and demand calculation
  -> immutable server projection snapshot
```

When the evidence document is absent or has `mode: "disabled"`, the prospect
layer supplies no priors and legacy Projection V11 calculations remain
unchanged. Prospect Layer V1 is versioned separately from Projection V11.

## Authority and data boundary

The server reads one bounded document:

```text
appData/prospectProjectionEvidence
```

There is no browser read or write path for this document. The existing
Firestore default-deny rule protects it from ordinary managers and league
commissioners. The validator is offline and performs no writes.

Only players already present in the current server-built canonical NHL roster
catalog may receive a prospect prior. A matching NHL player ID, position, and
organization are required. Imported evidence cannot create a draft-eligible
identity. That is deliberate: a future off-roster/camp-player expansion needs
an approved identity and eligibility source rather than a scouting import.

No live AHL, NCAA, CHL, European-league, draft, depth-chart, or prospect-rating
provider currently exists in this repository. Layer V1 therefore supplies the
validated ingestion boundary and model, not claimed production coverage.

## Evidence contract

Enabled evidence is strict and fail-closed:

- schema version and Prospect Layer model version must both match;
- player IDs must be unique and explicitly identity-verified;
- season/competition keys must be unique;
- regular season and playoffs remain separate; only regular-season rows feed
  the current prior;
- every non-NHL league used by a row needs one explicit translation profile;
- scenario probabilities must sum to one;
- appearance probabilities must be between zero and one;
- opportunity date windows cannot overlap;
- negative counts, non-finite numbers, invalid timestamps, and unsupported
  positions are rejected;
- missing statistics remain absent rather than becoming observed zeroes.

An enabled malformed document stops generation and preserves the previous
ready shared snapshot. A disabled document intentionally ignores stale payload
content so it remains a reliable rollback switch.

Validate an operator-authored JSON file without writing Firestore:

```bash
npm run prospects:validate -- path/to/prospect-evidence.json
```

Use `--print-normalized` to inspect the deterministic normalized payload. The
disabled rollback template is
`config/prospect-evidence.disabled.example.json`.

## Ability model

Observed categories are translated independently:

- goals, assists, power-play points, short-handed points, game-winning goals,
  and overtime goals use the profile's scoring factor;
- shots use the shot factor;
- hits and blocks use the physical factor;
- time on ice uses the time-on-ice factor;
- plus/minus is not translated from pre-NHL evidence in V1.

Profiles carry their source, as-of date, and provisional status. No unexplained
league constants are compiled into the application. An approved calibration
file must supply them.

Recent seasons receive more weight than older seasons. Sample influence grows
with the square root of games up to 60 games. Draft selection can add at most
four confidence points; it does not directly add fantasy points or rank.
Missing categories are supplied later by Projection V11's existing positional
priors and are recorded in the output explanation fields.

Birth date is retained as evidence, but V1 does not apply an age-development
multiplier. RinkRat does not yet have a leakage-safe, held-out calibration set
that would justify one. Likewise, opportunity scenarios can change expected
appearances and conditional time on ice, but V1 does not apply an additional
uncalibrated role multiplier to every production category.

These initial weighting and confidence settings are provisional. They are
correctness-tested, but they are not claimed to be calibrated for forecasting
accuracy until historical held-out evaluation is run.

## NHL evidence blend

The prospect prior is added to Projection V11's existing historical-rate
ensemble. Its influence decays continuously as NHL evidence grows. Each
category uses the existing V11 stabilization horizon, so shots and time on ice
move toward NHL observations faster than goals, assists, plus/minus, or rare
bonuses. There is no arbitrary games-played cutoff.

No-evidence and disabled calls retain the same V11 calculations. Established
players are unchanged unless a validated record is deliberately supplied for
their NHL player ID; even then, the prior fades with NHL sample size.

## Opportunity and six-game ownership

Ability is calculated conditional on playing. Opportunity is then applied once
for each game returned by the existing `getTargetCycleGames` scheduler. The
combined expectation is:

```text
medical availability probability
  x prospect appearance probability
  x conditional projected production
```

Date-bounded role scenarios override the record's explicit default appearance
probability. A missed appearance reduces expected contribution but never adds
another scheduled game. The seventh scheduled NHL team game remains outside
the current six-game window.

Prospect appearance probability is specifically non-medical lineup/assignment
availability. The server multiplies it by the existing medical availability
probability exactly once; evidence authors must not pre-combine injury risk
into this field.

Prospect opportunity also adjusts the draft-horizon cycle value before it
enters Draft Ranking V3. Medical availability keeps its existing behavior; the
prospect factor is not applied twice.

## Draft Ranking V3 integration

Draft Ranking V3 preserves the league-size roster forecast of two bench
forwards, one bench defender, and no bench goalie unit. It changes the skater
side of that forecast from a binary boundary into a gradual transition across
the first team-sized reserve band. One place in a position ranking therefore
cannot collapse an otherwise comparable rookie or veteran to the deep-reserve
weight.

Goalie-unit behavior stays deliberately stronger. Every league's projected
starting goalie units remain inside its modeled 17-round draft pool, and every
reserve goalie unit remains outside it. Regression coverage proves that
behavior for 4-, 6-, 8-, 10-, and 12-team leagues. This avoids a late-draft
goalie stack without creating default bench demand for an injury-proof asset.

Draft Ranking V3 is separately versioned from Projection V11. A server or
browser will reject an older ranking snapshot rather than silently mixing the
two ranking contracts.

## Authoritative output and explanation

Published prospect-backed assets include:

- Prospect Layer model version and evidence snapshot ID;
- source and evidence as-of date;
- evidence and translation confidence;
- remaining prospect-prior weight and accumulated NHL-evidence weight;
- role label and role confidence;
- appearance probability and expected appearances;
- opportunity adjustment;
- missing categories, quality flags, and provisional status.

The existing Projection Lab and Free Agents explanation labels distinguish
translated pre-NHL evidence from a prospect/NHL blend. The fields travel with
drafted and rostered assets and are preserved when a future window freezes.
Generating a new evidence revision creates a new projection snapshot; it does
not rewrite started windows or completed history.

## Offline evaluation

The evaluation command accepts frozen historical observations whose evidence
date is not later than the forecast date:

```bash
npm run prospects:evaluate -- path/to/historical-evaluation.json
```

It reports prospect-layer and legacy-baseline window MAE plus appearance Brier
score. A release-eligible input must identify its frozen dataset and source,
declare itself held out, include at least 100 observations, and include at
least 25 NHL entrants and 25 non-entrants. The calibration gate passes only
when the candidate beats the legacy baseline and its appearance Brier score is
no greater than 0.25.

Small fictional fixtures require the explicit
`--allow-small-synthetic-fixture` flag. Their output is always marked
`fixture-only`, `releaseGateEligible: false`, and
`calibrationGatePassed: false`, even when their candidate error is lower. The
harness no longer emits an `accuracyClaimSupported` field. RinkRat still needs
licensed/approved historical minor-league, role, schedule, and outcome data
divided into tuning and held-out sets before the disabled provider gate can be
considered for release.

## Enable and rollback

Enable only after Stephen or an approved audited admin pipeline writes a fully
validated document with `mode: "enabled"`. This implementation intentionally
does not add a production writer or deploy anything.

An optional record-level `reviewAfter` date is validated and preserved by the
normalized evidence document for an operator or future audited import job.
V1 does not automatically expire an entire record at that date because doing
so without a replacement could create an abrupt projection cliff. Time-bound
role assumptions expire through their required opportunity-window dates; an
overdue `reviewAfter` is therefore a review signal, not a silent model change.

Rollback is data-only and forward-safe:

1. validate and publish a schema-valid document with `mode: "disabled"`;
2. generate a new shared projection snapshot for future/draft use;
3. retain existing snapshots and frozen windows unchanged.

Code rollback removes the Prospect Layer V1 integration and leaves stored
optional fields backward-compatible. Never delete or rewrite historical
projection snapshots as part of rollback.

## Protected contracts

Unchanged:

- Production Scoring V4 formulas and weights;
- Projection V11 version and established no-evidence behavior;
- six-game ownership and seventh-game rollover;
- started/frozen windows and completed scoring;
- Draft Ranking V3 goalie demand, replacement logic, and roster construction;
- position eligibility and roster construction;
- Rules, indexes, TTLs, App Check, queue modes, and scoring authority.

Changed only when the feature is enabled with valid evidence:

- Projection V11 receives a separately versioned pre-NHL prior for matching
  skaters;
- prospect appearance probability is combined once with existing medical
  availability;
- resulting values flow through the existing draft-ranking system.

Changed independently of enabling prospect evidence:

- Draft Ranking V3 smooths the skater demand transition while retaining the
  goalie starter guarantee and reserve-goalie suppression described above.
