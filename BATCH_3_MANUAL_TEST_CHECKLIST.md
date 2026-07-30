# RinkRat Batch 3 — Draft Authority Test Checklist

Batch 3 makes the draft server-authoritative. Use a **disposable test league** with at least two separate manager accounts. Do not deploy this batch during an active real draft.

## 1. Production safety check before running or deploying

In the Firebase console, check each document at:

```text
leagues/{leagueId}/draft/current
```

For any draft where `status` is `live` and `nextOverallPick` is greater than `1`, confirm:

```text
serverDraftProjectionSnapshotId: "non-empty snapshot ID"
```

Stop before deployment if a live draft already has picks but does not have that field. Batch 3 intentionally refuses to continue a legacy live draft without a frozen pool because silently selecting from a different snapshot would be unfair.

Also confirm no real draft is actively running during deployment.

## 2. Install and run all automated checks

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch3
```

Expected results:

- Firestore Emulator: **32 tests passed, 0 failed**.
- Angular production build completes.
- Functions `tsc` build completes without an error.
- Draft authority engine: **7 tests passed, 0 failed**.
- Tests still labeled `[baseline exposure]` or `[temporary Batch 4 dependency]` cover systems scheduled for Batch 4; they do not represent final release permissions.

Do not deploy if any test or build fails.

## 3. Create the Git checkpoint

```bash
git status
git add .
git commit -m "Harden draft picks behind server authority"
git push

git rev-parse --short HEAD
```

Keep the displayed commit hash for rollback.

## 4. Deploy in the safe order

### Step A — deploy draft Functions and changed automation first

```bash
firebase deploy --only functions:executeDraftCommand,functions:makeSecureDraftPick,functions:runScheduledDraftAutomation,functions:processDraftClockDeadline,functions:continueServerDraftAutomation,functions:processAutoDraftQueueChange -m "Batch 3 draft authority functions"
```

Confirm the deployment reports all six Functions successfully created or updated.

### Step B — deploy the updated site

```bash
firebase deploy --only hosting:app -m "Batch 3 draft authority client"
```

### Step C — complete the pre-rules smoke test in Section 5

At this stage the new client should already use the Functions, while the previous rules remain available as a rollback cushion.

### Step D — deploy the hardened rules

Only after Section 5 passes:

```bash
firebase deploy --only firestore:rules -m "Batch 3 draft authority rules"
```

### Step E — repeat Sections 5 through 9

The post-rules pass is the one that approves Batch 3.

## 5. Required smoke test

Use a new two-manager test league.

1. Sign in as commissioner and open Draft Setup.
2. Set a 30-second clock and schedule the draft a few minutes in the future.
3. Save the settings.
4. Confirm the success message reports verified shared projections.
5. Open browser Developer Tools → Console and confirm there is no red callable, `permission-denied`, or unhandled error.
6. In Firestore, inspect `draft/current` and confirm:
   - `status` is `scheduled`;
   - `roundOneOrder` contains every team once;
   - `pickSeconds` is `30`;
   - `nextOverallPick` is `1`;
   - `draftedAssetKeys` is empty.
7. At the scheduled time, confirm the draft becomes `live` and the clock starts.
8. As the manager on the clock, make one manual pick.
9. Confirm:
   - the pick appears immediately;
   - the asset is placed into the correct roster slot;
   - the next manager goes on the clock;
   - the selected asset disappears from available players and queues;
   - no duplicate copy appears on any roster;
   - no console error appears.
10. Inspect the pick document and confirm:

```text
authority: "cloud-function"
projectionSnapshotId: "same ID as draft/current.serverDraftProjectionSnapshotId"
selectionType: "manual"
selectedByUserId: "manager UID"
```

## 6. Scheduled opening with browsers closed

This verifies the scheduled server path rather than only the commissioner fallback.

1. Create another disposable draft scheduled at least three minutes in the future.
2. Close every RinkRat tab before the start time.
3. Reopen the site after the scheduled time.
4. Confirm the draft is live and the first clock/automatic handling occurred without a browser being open.
5. Confirm `serverDraftProjectionSnapshotId` is populated.
6. Confirm the server automation fields report a healthy/opened state.

Expected: a scheduled draft does not depend on the commissioner leaving a browser tab open.

## 7. Manual-pick authority and race tests

### A. Wrong manager

1. Keep Manager A on the clock.
2. Sign in as Manager B in another browser/profile.
3. Attempt to select a player.

Expected: Manager B cannot submit the pick. No pick, roster, queue, or draft state changes.

### B. Double-click or two-tab race

1. As the manager on the clock, open the draft in two tabs.
2. Submit a pick nearly simultaneously from both tabs, or double-click rapidly.

Expected:

- exactly one pick document is created;
- `nextOverallPick` advances by exactly one;
- exactly one asset is placed on the roster;
- the losing request reports that the turn or asset is no longer valid;
- no duplicate asset appears.

### C. Expired manual request

1. Allow the visible clock to reach zero.
2. Attempt a manual pick after expiration.

Expected: the manual request is rejected and server automation owns the expired turn. The browser must not overwrite the automatic selection.

### D. Draft settings lock

After the first pick, return to Draft Setup and attempt to save a new order or clock.

Expected: settings are locked and the existing live draft remains unchanged.

## 8. Queue and automatic-draft tests

### A. Owner-only queue

1. Manager A adds several legal assets to their queue and reorders them.
2. Toggle Manager A's own Auto Draft control.
3. Confirm the queue updates normally.
4. Sign in as commissioner and confirm the commissioner can view the current manager's auto-draft state but no longer has a control to change another manager's preference.

Expected: each manager controls only their own queue. The commissioner cannot manipulate another team's queue or auto-draft mode.

### B. Queued automatic selection

1. Put a legal, undrafted player first in Manager A's queue.
2. Enable Manager A's auto-draft before their turn.
3. Let the server process the turn.

Expected:

- the first legal queued asset is selected;
- the pick has `selectionType: "queue"`;
- the pick has `authority: "cloud-function"`;
- the pick has the frozen `projectionSnapshotId`;
- the selected key is removed from the queue;
- roster and draft progression update atomically.

### C. Invalid queued entry fallback

1. Put an already-drafted asset first and a legal asset second in a queue.
2. Enable auto-draft or allow the timer to expire.

Expected: the server skips the drafted entry and selects the next legal queued asset. If no queued asset is legal, it selects the highest-ranked legal canonical asset.

### D. Two consecutive clock expirations

1. Leave one manager on manual mode.
2. Allow two of that manager's turns to expire.

Expected after the second expiration:

```text
autoDraftEnabled: true
consecutiveClockExpirations: 2
autoDraftActivatedByTimeout: true
```

Future turns should auto-process until that manager changes their own preference where allowed by the existing timeout policy.

## 9. Commissioner clock controls

1. As commissioner, pause a running clock.
2. Confirm the countdown stops for all signed-in managers.
3. Confirm a manager cannot pick while paused.
4. Resume the clock.
5. Confirm it resumes from the preserved remaining seconds, not a fresh full clock.
6. Try pause/resume as a non-commissioner.

Expected: only the commissioner can request pause/resume, and the server writes the clock state.

## 10. Frozen player-pool test

1. Once the draft is live, confirm the Draft Room does not offer a button to rebuild shared projections.
2. Make several picks and verify every pick document uses the same `projectionSnapshotId`.
3. Confirm `draft/current.serverDraftProjectionSnapshotId` does not change.
4. Run the Firestore Emulator suite and confirm the live projection-tampering test passes.

Expected: the player pool and asset details stay frozen for the entire live draft.

Do not try to manually edit production Firestore documents to test denial; the emulator tests already perform those hostile-write checks safely.

## 11. Roster-feasibility regression

Continue a small test draft far enough to check these behaviors, using auto-draft to accelerate it when useful:

- Starting LW, C, RW, D, and G slots fill before automatic bench picks.
- A player is placed only into a compatible active slot.
- Bench auto-draft avoids duplicating forward/defense/goalie roles until all three roles are represented.
- A bench goalie selection cannot consume the last goalie unit needed by another team's starting G slot.
- No asset is drafted twice.
- Every pick has one corresponding roster placement.
- The number of `draftedAssetKeys` equals the number of pick documents.

For a fully completed two-team test draft, confirm:

- 34 total picks exist;
- both teams have 14 active and 3 bench assets;
- `status` and `clockStatus` are `complete`;
- the normal post-draft season initialization still begins;
- My Team, Game Center, Free Agents, and League HQ load without errors.

## 12. Firestore consistency spot-check

After at least five mixed manual/automatic picks, verify:

```text
pick document count == draft/current.draftedAssetKeys.length
nextOverallPick == pick document count + 1
```

For each pick:

- the pick's `asset.assetKey` occurs once in `draftedAssetKeys`;
- it occurs on exactly one league roster;
- `rosterArea` and `rosterSlotId` match the actual roster location;
- `projectionSnapshotId` matches the draft's pinned snapshot;
- `authority` is `cloud-function`.

Also confirm no stale duplicate asset remains in a manager queue after it is selected.

## 13. Role-based browser regression

### Commissioner

- Draft Setup saves before the draft.
- Scheduled opening works.
- Pause/resume works.
- Draft Room and all queues are readable.
- There is no control to change another manager's auto-draft preference.

### Manager

- Own queue add/remove/reorder works.
- Own auto-draft toggle works.
- Manual pick works only on their turn and before expiration.
- Opponent queue remains unreadable.

### Outsider

- Cannot read the private draft or queues.
- Cannot call draft actions successfully.

### Signed-out browser

- Cannot call draft Functions or read league draft data.

## 14. Browser and responsive smoke test

Test the Draft Room in current Chrome/Safari desktop and one narrow mobile viewport.

Confirm:

- player rows and draft buttons remain usable;
- clock state updates without a reload;
- queue controls remain usable;
- removed commissioner/repair controls do not leave an awkward blank area;
- manual and automatic pick messages remain understandable;
- no layout regression appears in the header, sidebar, recent picks, roster, or player pool.

## 15. Stop conditions

Do not approve Batch 3 if any of these occur:

- a browser receives unexplained `permission-denied` errors during normal use;
- a manual pick writes client-supplied asset details that differ from the frozen snapshot;
- two simultaneous requests create two picks for one turn;
- an automatic pick lacks `authority` or `projectionSnapshotId`;
- the draft snapshot changes during a live draft;
- a commissioner can modify another manager's queue;
- pick, roster, queue, and draft progression partially update;
- the timer can be restarted or extended by a normal manager;
- draft completion no longer initializes the season correctly;
- Angular, Functions, rules, or engine tests fail.

## 16. Rollback

Use the Batch 3 commit hash recorded in Section 3.

```bash
git revert <BATCH_3_COMMIT_HASH>
git push
npm run build:all
```

Deploy the reverted runtime first:

```bash
firebase deploy --only functions:executeDraftCommand,functions:makeSecureDraftPick,functions:runScheduledDraftAutomation,functions:processDraftClockDeadline,functions:continueServerDraftAutomation,functions:processAutoDraftQueueChange,hosting:app -m "Rollback Batch 3 runtime"
```

Then restore the previous rules:

```bash
firebase deploy --only firestore:rules -m "Rollback Batch 3 rules"
```

A rollback reopens the temporary Batch 2 browser draft permissions, so use it only as an emergency bridge and do not run a real public draft until Batch 3 is repaired and redeployed.

## Approval record

Record the following before starting Batch 4:

```text
Batch 3 commit:
Automated verification date:
32 rules tests passed: yes / no
7 draft-engine tests passed: yes / no
Pre-rules smoke test passed: yes / no
Post-rules smoke test passed: yes / no
Scheduled no-browser test passed: yes / no
Manual race test passed: yes / no
Automatic draft test passed: yes / no
Completed-draft regression passed: yes / no
Console clean: yes / no
Approved for Batch 4: yes / no
Notes:
```
