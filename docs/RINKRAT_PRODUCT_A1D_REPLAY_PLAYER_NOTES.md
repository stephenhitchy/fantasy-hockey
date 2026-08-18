# Product Batch A1D — Replay-Accurate Player Data and Private Notes

**Runtime release:** Release Candidate 42

**Competitive models:** Production Scoring V3 and Projection V11

**Primary surfaces:** Add / Drop and Player Intel

## Purpose

A1D corrects a historical-replay data-alignment defect discovered during RC41 site testing and completes roadmap item A1.6 with private player notes.

RC41 successfully queued a Projection V11 rebuild after replay scoring and the browser correctly followed the current snapshot pointer. The generated snapshot was still built from the wrong season relationship: target-season dates were compared to source-season game rows, so replayed Season Points, ranks, stat breakdowns, and six-game markers could remain unchanged even though authoritative scoring had advanced.

A1D changes the replay inputs—not the Projection V11 formula.

## Replay-accurate player data

Historical replay uses:

```text
Target season: schedule and simulated dates
Source season: progressively revealed NHL game statistics
Previous seasons: the two seasons before the source season
```

The projection worker now:

1. Loads source-season skater and goalie game rows.
2. Loads target- and source-season schedules in bounded team batches.
3. Reconstructs each skater’s source team-game timeline, including trade segments.
4. Maps target schedule positions to source game identifiers.
5. Releases only source game rows whose mapped target date is at or before the simulated date.
6. Marks released target opportunities final while retaining future games in the six-game block.
7. Rebuilds Season Points, stat breakdowns, recent form, overall rank, position rank, and Projection V11 inputs from the released rows.
8. Publishes the new verified snapshot through the existing exact current pointer.

The full team schedule—not a past-games-only slice—is used for current Matchup markers. This preserves played, missed, and upcoming dots in the same six-game block.

A compact **Updating player data…** status appears only when historical replay has advanced beyond the currently loaded snapshot. It disappears when the new snapshot becomes authoritative.

Projection generation remains non-blocking. A failed player-data refresh cannot roll back or invalidate a completed replay scoring day.

## Private player notes

Player Intel now contains one compact, inline **My note** section.

A verified manager can:

- add a plain-text note;
- edit it;
- remove it;
- use up to 500 characters and eight lines;
- save notes for up to 100 players.

Notes are account-wide and private. They are stored in a server-owned document derived from the authenticated user ID. The browser never supplies an owner ID and cannot read another manager’s notes.

The note editor uses no modal, fuzzy backdrop, fixed panel, or sticky content. When no note exists, only the small **Add note** action is visible.

Permanent account deletion removes the private notes document.

## Preserved systems

A1D changes no:

- Production Scoring V3 calculation;
- Projection V11 calculation;
- immutable independent six-game roster-slot windows;
- seventh-game rollover;
- Draft, roster, waiver, transaction, or scoring authority;
- transaction and waiver privacy;
- Firestore Rules or indexes;
- TTL policies;
- App Check Monitor or the inactive exact-callable canary;
- scoring queue Shadow mode;
- shared NHL cache Shadow mode or authoritative-read setting.

## Verification

```bash
npm run verify:batcha1d && echo "A1D VERIFICATION PASSED"
```

The release may continue only when the final success line appears.

## Targeted deployment

Deploy the projection worker and private-note/account-cleanup callables before Hosting:

```bash
firebase deploy \
  --only functions:processProjectionGenerationTask,functions:getPlayerNote,functions:setPlayerNote,functions:deleteMyAccount \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1D replay player data and private notes"

firebase deploy \
  --only hosting:app \
  --project=nhl-fantasy-app-ab673 \
  -m "Product A1D Release Candidate 42"
```

No Rules, indexes, TTL, App Check, scoring-queue, or NHL-cache configuration belongs to this deployment.

## Site-first proof

### Replay data

1. Open Add / Drop in a historical test league and record a player’s Season Points, rank, Matchup number, and six dots.
2. Advance a replay date containing NHL games.
3. Confirm **Updating player data…** appears while the snapshot is behind.
4. Confirm it disappears after the new snapshot publishes.
5. Confirm Season Points and ranks change for players with released source-game production.
6. Confirm the six dots retain future games and mark released appearances played or missed.
7. Advance another game date and confirm the same automatic flow repeats without manual Projection regeneration.

### Private notes

1. Open Player Intel.
2. Add a note and save it.
3. Refresh and confirm it persists.
4. Edit it and confirm the updated text persists.
5. Sign in as another manager and confirm the note is not visible.
6. Remove the note and confirm the compact empty state returns.
7. Check the editor on a phone and confirm normal vertical scrolling.

## Fallback diagnostics

Only when replay scoring succeeds but the player snapshot never catches up:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only processProjectionGenerationTask
```

Only when private notes fail:

```bash
firebase functions:log \
  --project=nhl-fantasy-app-ab673 \
  --only getPlayerNote,setPlayerNote,deleteMyAccount
```
