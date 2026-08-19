# Product Batch A1H — Exact-Position Roster Fit and Weekly Power Rankings

**Runtime release:** Release Candidate 46

**Competitive models:** Production Scoring V3 and Projection V11

## Purpose

A1H corrects the Roster Fit comparison so every candidate is evaluated only against legal **exact-position** roster options, makes Roster Fit the default Add / Drop ordering, and completes the optional weekly Power Rankings roadmap item.

## Exact-position Roster Fit

Roster Fit now compares:

```text
LW with LW
C with C
RW with RW
D with D
Team Goalie Unit with Team Goalie Unit
```

A weak player at another position is never used to inflate a candidate's fit. Bench players count only when they share the candidate's exact position and are legal transaction choices. An available compatible roster slot may still produce an open-slot comparison because no player would be dropped.

When no same-position replacement or legal open slot exists, the result is **Not enough data** rather than an unfair cross-position comparison.

Roster Fit is now the default Add / Drop sort. Managers may still choose Next 6, Season Points, overall rank, position rank, rest-of-season projection, reliability, or name.

## Weekly Power Rankings

League Standings now has two clearly separated views:

```text
Official Standings
Power Rankings
```

Official Standings remains the default and remains the only table used for playoff qualification and seeding. Weekly Power Rankings is **entertainment only** and never changes records, standings, playoffs, waiver priority, or any competitive record.

The transparent league-relative score is:

```text
35% official record
25% points per completed matchup
20% point differential per completed matchup
20% last-three regular-season form
```

Last-three form itself blends 60% result rate and 40% recent point differential, normalized against the other teams in that league.

Only completed regular-season two-team matchups with recognized owners and finite scores are included. Active scores, projected results, playoff games, byes, and malformed records are ignored.

Every power-ranking row shows:

- Power rank and score out of 100.
- Official rank.
- Movement versus official rank, not a fabricated week-over-week history.
- Record, scoring rate, point differential, and last-three form.
- An optional inline score breakdown with the exact weights and contributions.

When every input is tied, ordering remains deterministic by team name and owner identifier.

## Mobile and information density

Power Rankings is an optional tab rather than another default-visible panel. Official Standings remains the first view. Explanation details stay collapsed until requested.

On narrow screens:

- View controls remain at least 44 pixels tall.
- Ranking rows stack vertically.
- Factors remain inside ordinary page flow.
- No modal, fuzzy backdrop, fixed card, or sticky panel is introduced.

## Architecture and deployment

A1H is **Hosting-only**. It adds no Cloud Function, Firestore listener, Rule, index, TTL policy, migration, scheduled job, or competitive write.

It preserves:

- Production Scoring V3.
- Projection V11 calculation.
- Independent immutable six-game roster-slot windows.
- Seventh-game rollover.
- Server-authoritative Draft, roster, scoring, waiver, and transaction actions.
- App Check Monitor and inactive exact-callable canary controls.
- Scoring queue Shadow mode.
- Shared NHL-cache Shadow mode and disabled authoritative reads.

Roadmap item A1.16 remains work in progress: historical-replay player-data catch-up is correct but still slower than desired, and future optimization must not couple snapshot generation to scoring authority.

## Verification

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm use 22.23.1

git restore -- public/assets/team-identity-logos

npm run verify:batcha1h && echo "A1H VERIFICATION PASSED"
```

## Deployment

After verification, cleanup, commit, push, and a fresh committed build:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1H exact-position fit and power rankings Release Candidate 46"
```

No Functions, Firestore Rules, indexes, TTL policies, App Check settings, scoring-queue configuration, or NHL-cache configuration belong in A1H.

## Site-first proof

### Roster Fit

1. Open Add / Drop and confirm **Roster fit (for you)** is selected by default.
2. Check a center candidate and confirm only centers are considered as replacement comparisons.
3. Confirm a weaker wing or defenseman does not affect that center's fit.
4. Repeat for LW, RW, D, and Team Goalie Units.
5. Confirm a legal open slot remains a valid open-slot comparison.
6. Confirm managers may switch to Next 6 or another sort at any time.

### Power Rankings

1. Open League Standings and confirm Official Standings remains the default.
2. Open Power Rankings.
3. Confirm it is labeled **Entertainment** and says official standings decide playoffs.
4. Confirm the displayed official ranks match the official table.
5. Expand one score breakdown and verify the four weights total 100%.
6. Confirm active matchups and playoff results do not change the power table.
7. Check the layout on a narrow phone and confirm normal vertical scrolling.

When those visible checks pass, no routine logs, TTL inspection, NHL-cache inspection, or Function listing is required.
