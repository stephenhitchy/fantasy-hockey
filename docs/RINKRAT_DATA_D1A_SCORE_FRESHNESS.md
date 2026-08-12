# RinkRat Data Quality Batch D1A — Score Freshness and Recovery Clarity

**Runtime:** Release Candidate 25  
**Competitive model:** Production Scoring V3 · Projection V11  
**Primary goal:** Show managers when RinkRat last checked and published fantasy scores without claiming an NHL upstream timestamp that RinkRat does not yet possess.

## What managers now see

The detailed Game Center matchup and the all-matchups overview now show one compact score-timing panel with:

- Last checked — the last completed shared league scoring pass.
- Last score change — the last shared cycle snapshot that changed fantasy totals or progress.
- Next check — the server-owned next scheduled check when one is recorded.
- A clear state: Live, On schedule, Due, Delayed, Updating, Needs attention, Replay, or Final.

The panel updates its relative-time labels every 30 seconds without opening another Firestore listener.

## Honest freshness language

RinkRat distinguishes three different concepts:

1. **Last checked:** when the trusted RinkRat server scorer completed a pass.
2. **Last score change:** when RinkRat last published a different fantasy snapshot.
3. **Official NHL corrections:** upstream stat changes that may arrive later.

The page never describes a RinkRat timestamp as the NHL's official update or correction time. Exact NHL-update-to-visible-score measurement remains an evidence task for live-season ingestion.

## Cadence behavior

The status is derived from the existing server-owned `liveScoring/control` document:

- `refreshing` shows Updating.
- `error` shows Needs attention and the bounded server error.
- A completed matchup shows Final.
- Historical replay uses Replay language.
- A future `nextRefreshAt` shows On schedule.
- A check more than five minutes overdue shows Due.
- A check more than fifteen minutes overdue shows Delayed.

Those grace periods affect only the explanation shown to managers. They do not change scoring cadence, worker retries, queue routing, or competitive data.

## Mobile and accessibility

- The timing metrics become a two-column grid on narrow phones.
- The final metric spans the full row, preventing horizontal scrolling.
- A dedicated live region announces meaningful status changes without repeatedly announcing the 30-second relative-time refresh.
- Exact timestamps remain available through titles and explicit accessible labels.
- The informational explanation is collapsed by default.
- Motion is disabled when the user requests reduced motion.

## Firestore recovery diagnostic correction

Google Cloud CLI versions may return a weekly backup as:

```json
{
  "weeklyRecurrence": {
    "day": "SUNDAY"
  }
}
```

The recovery parser now accepts `weeklyRecurrence.day` in addition to older `dayOfWeek` forms. The existing Sunday/12-week production schedule therefore reports `ACTIVE` rather than the false `CONFLICTING_RECURRENCE` warning.

This parser correction does not create, delete, or update a backup schedule.

## First restore drill record

The first production backup rehearsal completed on 2026-08-12:

- Backup snapshot: `2026-08-12T06:35:32.587486Z`
- Isolated destination: `restore-drill-20260812t193124z`
- Restore operation: successful, 100%
- Privacy-limited verification: PASS
- Sampled restored leagues: 4
- Scoring V3 contracts preserved: 4
- Six-game contracts explicitly present: 3
- Verification report SHA-256: `157d0b876c350148ea5ff65d17471f74ed3637c9d13a127b4183bf1eba494a75`
- Drill database: deleted after verification
- Production `(default)` database: untouched, delete protection and PITR remained enabled

The one sampled league without an explicit six-game contract remains a legacy-data follow-up, not a restore failure; every active league should still pass current authority and six-game Release Readiness checks.

## Competitive behavior preserved

D1A does not change:

- Production Scoring V3 mathematics
- Projection V11 mathematics or rankings
- Draft order, queue, clock, or Auto-Draft
- Six-game roster-slot windows
- Seventh-game rollover
- Add/drop, waiver, lineup, or IR timing
- Historical replay results
- Scoring worker cadence
- Scoring queue mode
- App Check canary mode
- Firestore Rules, indexes, TTL, PITR, or backup schedules

## Deployment

D1A changes only Angular Hosting content. The recovery parser is local repository tooling.

```bash
firebase deploy --only hosting:app \
  -m "Data D1A RC25 score freshness clarity"
```

Do not deploy Functions, Firestore Rules, indexes, TTL policies, or backup schedules for D1A.

## Validation checklist

1. Open a detailed active matchup and confirm Last checked, Last score change, and Next check appear.
2. Open the matchup overview and confirm the same timing panel appears once above the matchup list.
3. Confirm a live scoring pass changes Last checked even when no score changed.
4. Confirm Last score change moves only when a shared snapshot changes.
5. Confirm refreshing, error, historical replay, delayed, and completed states use the correct language.
6. Check 320px, 390px, 430px, tablet, and desktop widths.
7. Confirm no horizontal page scrolling.
8. Confirm reduced-motion disables the pulse animation.
9. Run `npm run security:backup:inspect` and confirm the Sunday weekly schedule reports ACTIVE.
10. Confirm App Check remains in Monitor and the league scoring queue remains in Shadow.
