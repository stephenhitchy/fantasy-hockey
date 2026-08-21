# Operations Batch O1H — Public Fairness Report

**Runtime release:** Release Candidate 58
**Competition models:** Production Scoring V4 and Projection V11
**Operations API:** v1, unchanged
**Deployment:** Hosting only
**Primary routes:** `/fairness` and `/scoring-guide`

## Purpose

O1H turns RinkRat's private scoring and simulation audit into one public, versioned methodology surface. It explains the six-game format without exposing a private league, tester, manager, roster, score, waiver, transaction, incident, research response, or account record.

The page is educational evidence, not an advertising claim that every future matchup will reproduce the historical averages.

## Public content

The report explains:

- exactly six scheduled NHL team games per active roster-slot window;
- seventh-game rollover;
- independent roster-slot windows;
- completed-window immutability;
- server-authoritative scoring;
- what six-game opportunity equalizes;
- what injuries, skill, roster decisions, and matchup variance deliberately remain;
- historical position distributions;
- Production Scoring V4 goalie sensitivity estimates;
- 12-team matchup simulation results;
- archetype and exploit checks;
- internal acceptance ranges;
- protected competitive invariants;
- every important evidence limitation.

## Evidence basis

Report v1 uses the recovered audit baseline:

```text
Regular seasons:                 2013-14 through 2017-18
Regular-season NHL games:        6,191
Skater-game records:             222,857
Team-goalie game records:        12,382
Complete skater six-game windows: 38,623
Complete goalie six-game windows: 1,963
Simulated 12-team leagues:       5,000
Simulated matchups:              390,000
Simulated first rounds:          20,000
```

Calendar weeks were not used.

## Limitations

The public page must continue saying that:

- the dataset predates the modern NHL scoring environment;
- exact historical primary/secondary assist sequencing was unavailable;
- player-level historical GWG/OT bonuses were omitted;
- V4 goalie distributions and matchup effects are sensitivity estimates;
- recent exact-data replication remains open under D1.22–D1.25.

These limitations are part of the report contract and cannot be removed merely to strengthen marketing copy.

## Reproducible exports

Canonical source:

```text
config/public-fairness-report-source.json
```

Generator:

```text
scripts/fairness/generate-public-fairness-assets.mjs
```

Generated public assets:

```text
public/data/rinkrat-fairness-report-v1.json
public/data/rinkrat-fairness-report-v1.csv
```

Generate:

```bash
npm run fairness:generate-report
```

Verify without changing files:

```bash
npm run fairness:verify-report
```

The generator verifies Scoring V4, Projection V11, the six-game rule, and byte-for-byte client/server scoring-rule parity before computing the report's SHA-256 evidence fingerprint.

CSV cells beginning with spreadsheet formula characters are escaped.

## Public Scoring Guide

O1H exposes the existing standard Scoring Guide at:

```text
/scoring-guide
```

The signed-in `/scoring` route remains available for normal manager navigation and league-specific rules. The public route shows only the current standard new-league rules and does not read a private league.

## Navigation

The Fairness Report is linked from:

- Support;
- the signed-out login footer;
- the signed-in site footer;
- Commissioner Guide;
- Scoring Guide.

## Protected boundaries

O1H changes no:

- Scoring V4 formula;
- legacy V3 reconstruction;
- Projection V11 calculation;
- Draft ranking;
- roster construction;
- position eligibility;
- six-game boundary;
- seventh-game rollover;
- completed window;
- server competition authority;
- Function;
- Firestore Rule;
- index;
- TTL policy;
- App Check mode;
- scoring queue mode;
- shared NHL-cache authority.

## Verification

```bash
npm run verify:batcho1h
```

The gate includes:

- inherited RC57 regression;
- Operations API v1 compatibility;
- fairness JSON/CSV regeneration check;
- public route and navigation checks;
- privacy-boundary checks;
- methodology and limitation checks;
- position and matchup evidence checks;
- design-system, accessibility, mobile, and copy-density audits;
- release-manifest validation.

## Deployment

Operations API v1 remains compatible, so O1H is Hosting-only:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1H Public Fairness Report Release Candidate 58"
```

Do not redeploy unchanged private-season, incident, research, or privacy Functions for O1H.

## Live proof

1. Sign out.
2. Open `/fairness`.
3. Confirm the report loads without authentication.
4. Confirm `/scoring-guide` loads without authentication.
5. Download both JSON and CSV.
6. Confirm limitations remain visible.
7. Confirm no private league or tester evidence appears.
8. Test the position table and methodology sections on a narrow phone.
9. Confirm no modal, fuzzy backdrop, fixed panel, sticky obstruction, or horizontal page scrolling appears.
