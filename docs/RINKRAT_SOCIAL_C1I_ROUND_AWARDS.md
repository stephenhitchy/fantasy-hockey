# Social Batch C1I — Round Recap Awards

**Runtime release:** Release Candidate 35

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surface:** League HQ → League Wire → regular-season Round Recap

## Purpose

C1I completes the compact regular-season recap without adding another page, browser listener, modal, or live-score event. The existing recap now includes two optional server-derived honors:

- **Pickup of the Round** — the highest-scoring skater acquired for that same matchup cycle through a completed add or waiver outcome.
- **Biggest Upset** — the final winner who entered the matchup with the largest deficit in frozen six-game team projection points.

The existing Top team, Player of the Round, and Closest finish remain unchanged.

## Authoritative inputs

The existing `publishLeagueRoundRecapActivity` trigger runs only when an authoritative regular-season cycle first becomes complete. It reads:

1. final matchup documents for the cycle;
2. each real matchup owner's completed immutable team-window document;
3. at most 256 canonical transactions whose `effectiveCycleNumber` matches the completed cycle.

No browser value selects either award.

## Pickup of the Round

Eligible acquisition outcomes are:

```text
add-drop
add-open-slot
waiver-award
slot-move-activated
```

Queued plans, pending claims, cancellations, drops, bench-only swaps, and old-cycle transactions do not qualify. The server matches the acquired asset key and owner to a completed expected skater slot window in the same cycle, then ranks final fantasy points. Team Goalie Units are excluded because they represent an NHL club rather than one pickup.

Ties are deterministic. At most three pickup summaries are published, while the full tie count is retained. When the transaction query exceeds its 256-document bound, or a qualifying transaction is malformed, only the optional pickup line is omitted; the rest of a valid recap remains available.

## Biggest Upset

The server sums `frozenProjectionPoints` across every expected completed roster-slot window for each real matchup owner. A completed winner qualifies only when that frozen team total was lower than the opponent's.

Candidates are ranked by:

1. largest projected underdog gap;
2. largest actual winning margin;
3. deterministic owner identifiers.

The public recap stores only winner, loser, projected gap, and the two frozen team totals. When any relevant expected window lacks valid frozen projection evidence, the optional upset line is omitted rather than guessed.

## Privacy and data minimization

League Wire never stores raw transaction IDs, roster-slot IDs, game ledgers, claim arrays, waiver priority, request IDs, stat rows, or projection source metadata for these awards. Public award data is limited to manager identity, safe asset summary, final fantasy points, and bounded projection totals.

## Mobile presentation

The recap remains one compact pre-line text block inside the existing activity card:

```text
Top team: Rink Raiders · 54.25
Player of the Round: Connor McDavid (Rink Raiders) · 87.4
Pickup of the Round: Brock Boeser (Blue Line Bandits) · 61.8
Biggest upset: Ice Rats over Rink Raiders · 14.2-point projected underdog
Closest: Ice Rats by 0.75
```

Optional lines are simply absent when no trustworthy qualifying evidence exists. No sticky content, overlay, duplicate dialog, or new listener is introduced.

## Preserved systems

C1I changes no Production Scoring V3 calculation, Projection V11 calculation, immutable six-game slot-window lifecycle, seventh-game rollover, Draft/roster/waiver authority, transaction privacy, Firestore Rules, indexes, TTL policies, App Check Monitor state, selected-callable canary state, scoring queue Shadow mode, or shared NHL cache Shadow authority.

## Verification

```bash
npm run verify:batchc1i && echo "C1I VERIFICATION PASSED"
```

## Targeted deployment

```bash
firebase deploy \
  --only functions:publishLeagueRoundRecapActivity \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1I round recap awards"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1I Release Candidate 35"
```

No Firestore Rules, indexes, TTL policies, App Check settings, scoring-queue configuration, or NHL-cache setting belongs in this deployment.

## Site-first proof

Use a disposable regular-season league with at least four managers and two real matchups. Before completing the round, create one same-cycle completed acquisition and arrange one matchup where the frozen-projection underdog wins. After the round closes, confirm one recap includes the expected Player, Pickup, Upset, Top team, and Closest lines; refresh again and confirm no duplicate appears. Also confirm a round with no qualifying pickup or no complete projection evidence still publishes the valid core recap without an invented optional award.

## Diagnostics

Only when the recap is missing or incorrect:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only publishLeagueRoundRecapActivity
```
