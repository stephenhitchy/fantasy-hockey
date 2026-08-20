# Operations Batch O1C — Private Season Health

**Runtime release:** Release Candidate 53
**Competitive models:** Production Scoring V4 and Projection V11
**Deployment shape:** selected Functions, then Hosting
**Authority:** server-owned operational evidence; no competitive mutation

## Purpose

O1C turns the tester-season activation and retention targets into a privacy-limited operating dashboard. It complements the O1B Private Season Control Center:

- O1B defines the exact cohort and records the formal go/no-go decision.
- O1C measures whether those tracked leagues fill, Draft, use Game Center, complete a roster or waiver action, return four weeks later, and remain supportable.

The dashboard is evidence for an administrator. It cannot approve the private season, promote App Check, change scoring-queue mode, change NHL-cache authority, or alter a league.

## Route and access

Platform administrators can open:

```text
/admin/private-season/health
```

The route uses the existing platform-admin guard. Weekly record changes additionally require verified email, recent authentication, the expected stored revision, and an audit reason.

## Automatic league evidence

For each active O1B tester league, the server reads:

- live team count;
- Draft status;
- first successfully loaded Game Center view recorded after RC53 deployment;
- first authoritative roster or waiver transaction;
- privacy-limited active-manager counts over the last seven days;
- privacy-limited Week 4 active-manager counts.

No browser writes directly to Firestore. A verified league member may send one bounded engagement category through `recordPrivateSeasonEngagement`. The server verifies that the league is actively tracked in the O1B plan and stores only a deterministic account/league hash, date key, category set, release, and build. It does not store the manager UID, email address, team, score, roster, player, or route parameters.

Game Center is recorded only after its live league data loads successfully. Ordinary league-route activity is recorded once per category, manager, league, and UTC day in the browser session, with a server daily limit.

## Activation definitions

The operating definitions are:

```text
Filled league
At least six teams/managers are present.

Drafted league
A filled league whose authoritative Draft status is complete.

Activated league
At least six managers + completed Draft + first successful Game Center view.

First-week activation evidence
An activated league with at least one authoritative roster or waiver action.
```

The first-week action is evidence, not an additional requirement for the launch-plan definition of an activated league.

## Four-week retention

The initial tester-season definition is deliberately explicit:

```text
Observation begins: Day 22 after activation
Metric is due: Day 28
Observation closes: Day 35
Required active managers: max(3, ceil(team count × 50%))
```

A manager counts once when at least one tracked league route is successfully recorded during the observation window. This is an initial operating definition, not a universal product-market-fit standard. Change it only through documented evidence and a later versioned release.

## Launch metrics

O1C displays these launch-plan thresholds:

| Metric | Green threshold |
|---|---:|
| Unresolved P0 integrity defects | 0 |
| Confirmed exact-build core-action reliability | at least 99.5% after 20 samples |
| Tracked leagues reaching six managers | at least 60% |
| Six-manager leagues completing Draft | at least 75% |
| Four-week retained activated leagues | at least 70% |
| Median support minutes per active league/week | below 20 |
| Positive commissioner return intent | at least 70% |

First-week activation and cost per activated league/week are displayed as evidence metrics without inventing a green threshold.

A red metric does not automatically stop traffic. The administrator must use O1B and the documented incident/release process to make the formal decision. O1C never automatically changes production behavior.

## Weekly founder evidence

The administrator can save one audited record per week ending date with:

- platform and operating cost;
- support minutes for each tracked league;
- number of founder interventions;
- commissioner return intent;
- a bounded privacy-limited note.

Do not place names, contact information, private league content, medical information, or raw incident evidence in the note. Use the normal feedback/incident systems for detailed reports.

Weekly records use optimistic revision checks and immutable change-audit documents. A stale editor must refresh before overwriting a newer record.

## Firestore layout

Server-only documents:

```text
platformOperations/privateSeason2026-27
  /leagueEngagement/{leagueId}
  /leagueEngagement/{leagueId}/managerDays/{managerDayId}
  /weeklyHealth/{weekEnding}
  /weeklyHealthChanges/{changeId}
```

Account deletion removes the account-derived manager-day records from every tracked league and removes the account hash from an existing league summary.

## Bounds

```text
Tracked leagues: inherited O1B maximum of 4
Tracked managers: inherited O1B maximum of 30 aliases
Engagement categories: 6
Per-account engagement calls: maximum 24/day
Manager-day query: maximum 1,000 documents per league/query
Exact-build beta evidence: maximum 2,000 documents over 35 days
Integrity reports inspected: maximum 200
Transactions inspected per league: maximum 100
Weekly records loaded: maximum 12
Weekly note: maximum 400 characters
```

## Preserved systems

O1C does not change:

- Scoring V4 or legacy V3 reconstruction;
- Projection V11 calculations;
- immutable six-game roster-slot windows;
- seventh-game rollover;
- Draft, roster, waiver, transaction, standings, or scoring authority;
- Firestore Rules or indexes;
- TTL policies;
- App Check Monitor or canary controls;
- scoring queue Shadow mode;
- shared NHL-cache Shadow/non-authoritative status.

## Verification

```bash
npm run verify:batcho1c
```

## Functions and Hosting deployment

Deploy the updated private-season authority, new O1C authority, and account-deletion cleanup before Hosting:

```bash
firebase deploy \
  --only functions:getPrivateSeasonControlCenter,functions:updatePrivateSeasonPlan,functions:recordPrivateSeasonGateDecision,functions:recordPrivateSeasonEngagement,functions:getPrivateSeasonHealthDashboard,functions:updatePrivateSeasonWeeklyHealth,functions:deleteMyAccount \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1C private season health authority"
```

Then deploy Hosting:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Operations O1C Private Season Health Release Candidate 53"
```

Do not deploy Rules, indexes, TTL, App Check settings, scoring-queue configuration, or NHL-cache configuration with O1C.

## Site proof

1. Configure the exact tester leagues in O1B.
2. Open a tracked league as a verified manager and successfully load Game Center.
3. Refresh Private Season Health and confirm the Game Center step is recorded.
4. Complete a disposable authoritative roster or waiver action and confirm the action date appears.
5. Save one weekly support/cost/intent record with an audit reason.
6. Refresh and confirm the revision/history persists.
7. Verify an ordinary manager cannot open the admin route.
8. Verify an untracked league does not appear and its route call returns `not-tracked`.
9. Confirm the dashboard reports collecting/not-due rather than pretending early retention evidence is green.
10. Confirm no score, Draft, roster, waiver, cycle, App Check, queue, or cache control changed.
