# Social Batch C1F — Matchup Round Recaps

**Runtime release:** Release Candidate 32
**Competitive models:** Production Scoring V3 and Projection V11
**Primary experience:** Mobile League HQ / League Wire
**Authority:** Server-created, immutable activity projection

## Purpose

C1F adds one compact regular-season recap only after the entire authoritative matchup round is complete. It gives managers a useful shared story without turning League Wire into a live-score ticker or duplicating every Game Final.

## Published recap

An eligible recap contains only:

- the completed matchup number;
- the number of real two-team matchups;
- the owner IDs tied for the highest team score and the bounded score;
- the two teams in the closest finish, the winner when one exists, and the bounded margin;
- whether the top score is strictly above the prior C1F high-water mark.

The browser resolves current team names and profile icons through its existing league-team input. Raw cycle IDs, matchup IDs, ledgers, player scoring, projections, seeds, request IDs, administrative notes, and private transaction data are never copied.

## Authority and idempotency

`publishLeagueRoundRecapActivity` observes:

```text
leagues/{leagueId}/cycles/{cycleId}
```

It runs only on the first transition from a non-complete state to `complete` when the saved phase is `regular_season`. The authoritative cycle finalizer commits every expected matchup result and the cycle completion atomically before this trigger reads the matchups.

The activity identity is a deterministic hash of the source kind and cycle identity. The trigger creates the recap and updates the server-only high-water document in one Firestore transaction. Retries cannot create a duplicate.

## High-water semantics

The server-only document is:

```text
leagues/{leagueId}/socialMilestones/regular-season-scoring
```

The first eligible future round establishes a baseline and is not labeled a new record. Only a strictly higher later score is called a new League Wire scoring high. This is intentionally a **League Wire-era** milestone; C1F does not backfill older rounds or claim an all-time record without historical evidence.

Malformed milestone data fails closed and produces no recap until corrected.

The publisher also guards against out-of-order trigger delivery. Only the immediately next observed cycle may receive new-high wording; an older or skipped-cycle event can update the silent high-water evidence but cannot overclaim a record.

## Noise and integrity exclusions

C1F publishes nothing for:

- live score changes or temporary leads;
- playoff rounds;
- scheduled byes;
- a one-game round already represented by one Game Final;
- existing completed rounds from before deployment;
- incomplete, mixed-cycle, duplicate-owner, malformed-score, or inconsistent-winner data.

## Mobile behavior

C1F reuses the existing ordered 40-item League Wire listener and five-item collapsed view. It adds no listener, modal, backdrop, bottom sheet, sticky control, or duplicate dialog. Commissioner announcements and the exact-document pinned-announcement listener from C1E remain unchanged.

## Protected systems

C1F changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation;
- six-game roster-slot window or seventh-game rollover behavior;
- roster, Draft, waiver, or transaction authority;
- transaction/waiver privacy projection;
- Firestore Rule, index, or TTL policy;
- App Check Monitor or exact-league/callable canary state;
- scoring queue Shadow or shared NHL cache Shadow authority.

## Verification

```bash
npm run verify:batchc1f
```

The complete gate inherits C1E and every earlier competitive, authority, mobile, design, capacity, documentation, and security regression before running the C1F tests.

The normal owner workflow uses one automated gate, one targeted Function deployment, RC32 Hosting, and a site-first smoke test.

## Targeted deployment

Deploy only the new trigger, then Hosting:

```bash
firebase deploy \
  --only functions:publishLeagueRoundRecapActivity \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1F League Wire round recap publisher"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Social C1F Release Candidate 32"
```

Do not deploy Rules, indexes, TTL, or unrelated Functions for C1F.

## Site-first smoke test

Use a disposable Internal Test league with at least four managers and one active regular-season round:

1. Note the current League Wire entries.
2. Finish every real matchup in the round through the normal scoring or historical replay workflow.
3. Confirm each two-team Game Final appears as before.
4. Confirm exactly one **Round Recap** appears after the whole round closes.
5. Confirm the top score, closest finish, team names, and matchup number are correct.
6. Refresh or run scoring again and confirm no duplicate recap appears.
7. Complete a later round with a strictly higher team score and confirm the new-high wording appears only then.
8. Confirm commissioner announcements, pinning, inline expansion, and narrow-phone scrolling still work.

## Fallback diagnostics

Only when the site recap is missing or wrong:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only publishLeagueRoundRecapActivity
```

## Rollback

The trigger is additive. A Hosting rollback removes recap rendering, while existing sanitized activity records remain harmless member-readable history. A Functions rollback stops future recaps. Do not change scoring, cycle, Rules, index, TTL, App Check, scoring queue, or NHL cache settings as part of a C1F rollback.
