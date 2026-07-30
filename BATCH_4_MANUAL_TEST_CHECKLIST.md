# RinkRat Batch 4 Testing Checklist

## Goal

Batch 4 makes scoring, cycle progression, standings, roster-window transitions,
and playoff records server-authoritative. The browser may display these records
and request authenticated server actions, but it may not directly rewrite the
outcome of a fantasy competition.

Use a disposable completed-draft test league. Keep the successful Batch 3 test
league because it already has realistic teams, rosters, and draft records.

Do not use Firebase Console edits as a security test. Console/Admin SDK writes
bypass Firestore Security Rules.

---

## 1. Preparation

Before replacing the project, record the current Git commit:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
git rev-parse --short HEAD
git status
```

Save the commit hash. The working tree should be clean except for Firebase's
generated hosting cache. That cache may be discarded with:

```bash
git restore .firebase/hosting.ZGlzdC9mYW50YXN5LWhvY2tleS9icm93c2Vy.cache
```

In Firebase Console, take screenshots of these records in the test league so
there is a before/after reference:

- `leagues/{leagueId}/teams/{ownerId}` for both teams
- `leagues/{leagueId}/cycles/cycle-1`
- One document under `cycles/cycle-1/matchups`
- One document under `cycles/cycle-1/teamWindows`
- `leagues/{leagueId}/liveScoring/control`
- `leagues/{leagueId}/playoffs/current`, when present

Do not deploy while a real user draft is active. A normal active scoring period
is supported, but testing during a quiet period is easier to interpret.

---

## 2. Automated verification

Run:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch4
```

Expected results:

- **40** Firestore rules tests passed
- **7** draft-engine tests passed
- **2** league-onboarding contract tests passed
- **4** competition-authority contract tests passed
- Angular production build completed
- Functions TypeScript build completed
- Zero failed tests

The rules suite uses `demo-rinkrat-rules` and the local Auth/Firestore
emulators. It must not access production data.

Stop here if any test or build fails.

---

## 3. Commit checkpoint

After verification passes:

```bash
git status
git add .
git commit -m "Move competition state behind server authority"
git push

git rev-parse --short HEAD
```

Save the new commit hash as the Batch 4 checkpoint.

---

## 4. Safe deployment order

### A. Deploy server authority first

```bash
firebase deploy --only functions:runScheduledLeagueAutomation,functions:runSeasonStartAutomation,functions:initializeSeasonAfterDraft,functions:requestLeagueLiveScoringRefresh,functions:openNextCompetitionPeriod,functions:releaseLeagueLiveScoringHandoff,functions:clearExpiredOrErroredLiveScoringLease,functions:advanceHistoricalReplayDay -m "Batch 4 competition authority functions"
```

### B. Deploy the read-only browser client

```bash
firebase deploy --only hosting:app -m "Batch 4 competition authority client"
```

Do **not** deploy the new rules yet. Complete Section 5 first.

---

## 5. Pre-rules smoke test

Use the commissioner account in the completed-draft test league.

### League and matchup loading

1. Open Dashboard, League HQ, My Team, and Game Center.
2. Confirm all pages load without a blank screen.
3. Confirm scores, roster cards, game markers, and roster-game progress display.
4. Open browser Developer Tools → Console.
5. Confirm there are no new red errors or `permission-denied` messages.

### Server scoring refresh

1. Open Game Center → Dev Controls.
2. Click **Refresh Shared Scores**.
3. Confirm the button shows a processing state and then succeeds.
4. Confirm the shared score snapshot remains visible.
5. Confirm `liveScoring/control` returns to `status: "idle"`.
6. Confirm its refresh fields update, including the last-completed time and a
   manual trigger/reason.

### Historical replay test

Use only a disposable historical-replay league.

1. Click **Start Replay + Advance One Day** or **Advance One NHL Day**.
2. Confirm the action succeeds without a browser write permission error.
3. Confirm the simulated date advances exactly once.
4. Confirm the released-game count and shared scores update when that date has
   games.
5. Confirm cycle/matchup/team-window records are written by the server.

### Existing secured workflows

Perform one legal action from each applicable area:

- Rename your team.
- Change the league profile icon.
- Make an active/bench move or legal add/drop.
- Create or cancel a queued roster move when the test state permits it.
- Submit one waiver claim when a waiver is available.

These actions must continue to use their secure Batch 2 Functions and must not
produce permission errors.

Stop before rules deployment if any pre-rules action fails.

---

## 6. Deploy the hardened rules

```bash
firebase deploy --only firestore:rules -m "Batch 4 competition authority rules"
```

Hard-refresh the site after deployment:

- Chrome on Mac: **Command + Shift + R**

Then repeat all relevant tests in Section 5.

---

## 7. Post-rules role tests

### Commissioner

Verify that the commissioner can:

- Read every team, roster, matchup, cycle, and playoff record in the league.
- Rename their own team and change their profile icon.
- Request a shared score refresh.
- Use historical replay in a dedicated test league.
- Complete legal roster and waiver actions through the secure UI.
- Open an already completed period's next cycle through the server fallback
  button, when such a test state exists.

The commissioner must not receive a browser-side permission error during any
legitimate action.

### Ordinary manager

Sign in as the second manager and verify:

- Dashboard, My Team, Game Center, standings, and playoff pages load.
- The manager sees the same shared scores as the commissioner.
- Team-name and profile-icon changes still save.
- Legal roster moves still work through the secure roster Function.
- Commissioner-only scoring controls are not visible.
- No red console errors appear.

### League outsider

Sign in with an account that is not a member of the league and paste a direct
Game Center or playoff URL.

Expected result:

- Access is denied or redirected by the league guard.
- No team, roster, scoring, cycle, or playoff data appears.

---

## 8. Cycle-transition regression

This is the most important behavior test for Batch 4.

In the disposable historical-replay league, advance the simulated NHL calendar
until one complete fantasy matchup period resolves.

Confirm all of the following:

1. Each roster slot retains its independent six-game window.
2. A slot that finishes Game 6 can begin its next window without waiting for
   every other slot.
3. The seventh scheduled NHL team game is not lost or counted twice.
4. Matchup scores update from the server snapshot.
5. The matchup becomes complete only when both sides' required windows finish.
6. The cycle document changes to `status: "complete"`.
7. Winner and final scores are stored on the matchup document.
8. Wins, losses, ties, points for, and points against update once—not twice.
9. Queued roster moves activate at the correct slot boundary.
10. Exactly one next-cycle document is created.
11. Refreshing or opening the next period again does not create a duplicate.
12. The next cycle contains the correct immutable roster-slot snapshots.

If server automation already opened the next period, the commissioner fallback
button should return/open the existing period rather than creating another.

---

## 9. Playoff regression

When a test league reaches the postseason, verify before public launch:

1. The playoff bracket is created from final regular-season standings.
2. Seeds and byes match the intended format.
3. Early NHL games continue accumulating in immutable per-slot playoff banks.
4. Once the prior round resolves, already-played games are assigned/backfilled
   into the correct championship, third-place, fifth-place, or consolation
   matchup.
5. Winners advance and losers move to the proper placement matchup.
6. No game disappears, duplicates, or moves between a slot's immutable windows.
7. Final placements are saved once.
8. Re-running scoring is idempotent and does not change a completed bracket.
9. Ordinary managers can read the bracket but cannot alter it.

A full postseason replay is a release gate before opening the app publicly. It
is not necessary to manufacture a live playoff state solely to deploy this
batch when the emulator suite and regular-season transition test pass.

---

## 10. Firestore spot checks

After a server refresh or transition, inspect:

### Shared scoring control

`leagues/{leagueId}/liveScoring/control`

Expected characteristics:

- `automationMode` is `server` or `historical-replay`.
- `status` returns to `idle` after a successful run.
- `holderClientId` is empty after completion.
- Successful-refresh and snapshot counters increase appropriately.
- `lastError` is empty.

### Cycle

`leagues/{leagueId}/cycles/cycle-{number}`

Check:

- Status, phase, expected-window counts, and completion counts agree.
- `standingsAppliedAt` appears only after completion.
- Projection-accuracy fields may update independently but do not alter scores.

### Matchup

`cycles/cycle-{number}/matchups/{matchupId}`

Check:

- Team scores match the shared scoring snapshot.
- Winner and completion fields are populated only when ready.

### Team standings

`leagues/{leagueId}/teams/{ownerId}`

Check:

- Identity fields remain intact.
- Record and point totals change only through server completion.
- Refreshing an already finalized cycle does not increment them again.

### Windows and playoffs

Check team-window and playoff-bank documents for stable slot IDs, game IDs,
and window numbers. Repeated refreshes should update scoring state without
creating duplicate windows.

---

## 11. Stop conditions

Stop testing and do not continue to the next batch if any of these occur:

- A legal roster, waiver, scoring-refresh, or identity action receives
  `permission-denied`.
- A cycle remains active after every required roster window is complete and a
  server refresh finishes.
- A next cycle is duplicated.
- Standings increment more than once.
- A player's seventh NHL team game is skipped or counted in both windows.
- Playoff banks or bracket assignments disappear.
- Ordinary managers see different shared scores than the commissioner.
- Browser console errors repeat during ordinary page use.
- Scheduled automation remains in `refreshing` or `error` state.

Record the league ID, cycle number, screenshots, browser console output, and the
relevant Cloud Function log before changing production data.

---

## 12. Rollback

Use the pre-Batch-4 commit hash saved in Section 1.

```bash
git checkout <PRE_BATCH_4_COMMIT>
npm ci
npm --prefix functions ci
npm run build:all
```

For a functional rollback, restore server code first, then the matching rules,
then hosting so the old browser and rules are never mismatched longer than
necessary:

```bash
firebase deploy --only functions -m "Rollback Batch 4 functions"
firebase deploy --only firestore:rules -m "Rollback Batch 4 rules"
firebase deploy --only hosting:app -m "Rollback Batch 4 client"
```

After recovery, return to `main` and investigate the captured failing league in
a disposable environment before attempting another production deployment.
