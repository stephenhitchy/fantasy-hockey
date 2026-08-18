# Product Batch A1F — Decision History

**Runtime release:** Release Candidate 44

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surface:** Add / Drop → Decision history

## Purpose

A1F completes roadmap item A1.7 with a private place for managers to revisit completed Add / Drop decisions without adding another default-visible panel to League HQ or the Dashboard.

Decision History is intentionally retrospective rather than advisory. It pairs each recorded completed move with the current Player Board snapshot and labels the result as **today's comparison**. It does not pretend to preserve a frozen grade from the original transaction date and does not issue a black-box recommendation.

## Included decisions

The page includes only completed outcomes from the signed-in manager's private transaction projection:

```text
add-drop
add-open-slot
waiver-award
slot-move-activated
```

It excludes pending waiver claims, queued moves that have not activated, cancellations, losing claims, commissioner processing records, and internal transaction identifiers.

## Current comparison

Each decision shows:

- transaction date;
- effective Matchup when available;
- added player or Team Goalie Unit;
- dropped player or open slot;
- each asset's current ownership/availability;
- current Season Points;
- current next-six Projection V11 points;
- current exact-position rank;
- transparent current deltas calculated as added minus dropped.

The deltas are simple arithmetic over visible current metrics. They are not a grade, recommendation, or model output.

## Navigation

Decision History is reachable from:

```text
Add / Drop header
Team Settings → Recent Transactions
```

Selecting either player opens the existing league-aware Player Intel page. The Player Intel back link returns to Decision History when it was opened from that route.

## Privacy and data access

A1F reads only:

- the signed-in manager's owner-private transaction projection;
- the existing bounded league Player Board data;
- the existing public claim-free waiver pool.

The private transaction query is a one-time read capped at 75 documents. A1F adds no Firestore listener, Cloud Function, Rule, index, TTL policy, migration, scheduled job, or competitive write.

Other managers and commissioners cannot use this page to read another manager's private transaction history.

## Mobile experience

The page is separate from the default player pool so Add / Drop remains focused. Decision cards stack added and dropped players vertically on narrow phones, preserve 44-pixel actions, and use no modal, fuzzy backdrop, fixed panel, or sticky content.

## Replay player-data latency follow-up

A1E made the Add / Drop and Player Intel trackers correct by waiting for the authoritative roster-slot windows and replay-refreshed Projection V11 snapshot. Site testing showed that the final data can still take longer to arrive than desired.

Roadmap item **A1.16** is now in progress to measure and reduce the complete catch-up path:

```text
queue wait
NHL retrieval
projection calculation
chunk publication
pointer update
browser reload
```

That future optimization must not couple projection generation to scoring authority or roll back a completed replay day.

## Verification

```bash
npm run verify:batcha1f && echo "A1F VERIFICATION PASSED"
```

## Deployment

A1F is browser-only:

```bash
firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1F Decision History Release Candidate 44"
```

Do not deploy Functions, Firestore Rules, indexes, TTL policies, App Check settings, scoring-queue configuration, or NHL-cache configuration for A1F.

## Site-first smoke test

1. Open Add / Drop and select **Decision history**.
2. Confirm only the signed-in manager's completed moves appear.
3. Confirm pending, queued, canceled, and losing waiver records are absent.
4. Confirm added and dropped players show current Season, Next 6, and position-rank values.
5. Confirm current deltas equal added minus dropped.
6. Open Player Intel for each side and return to Decision History.
7. Search by either player name.
8. Refresh and confirm the page remains bounded and usable.
9. Check a narrow phone viewport for vertical stacking and normal scrolling.

No routine production log, TTL, or NHL-cache inspection is required because A1F adds no backend behavior.
