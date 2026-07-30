# Batch 1 test checklist

Do not continue to Batch 2 until every required item below passes.

## 1. Prerequisites

Use the Node version required by the project:

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1
node --version
firebase --version
java -version
```

The Firestore Emulator requires Java. The project already uses the Firebase CLI for deployment, so `firebase --version` should normally work.

## 2. Install and build

```bash
npm ci
npm --prefix functions ci
npm run build:all
```

**Pass condition:** Angular and Functions both compile with no errors.

## 3. Run the local security suite

```bash
npm run test:rules
```

Expected result:

- 24 tests pass
- 0 tests fail
- the command uses `demo-rinkrat-rules`
- no production league or account data changes

Several passing tests include **`[baseline exposure]`** in their names. That is intentional for Batch 1. They document permissions that later batches must remove.

## 4. Review the most important baseline findings

The following tests should currently pass as exposure documentation:

- an owner can overwrite a roster with forged and duplicate assets
- a commissioner can overwrite another team roster
- a manual draft pick accepts a non-canonical client asset
- a commissioner can alter draft records and competition records
- a transaction can contain an arbitrary client payload
- a waiver can contain an arbitrary client asset
- a commissioner can write global player availability
- a signed-in user can retrieve another full profile document

Do not interpret these passes as approval. They are the red tests that later batches will convert into denials.

## 5. Commit the checkpoint

After the build and rules tests pass:

```bash
git status
git add .
git commit -m "Add security test foundation and server scoring controls"
git push
```

## 6. Deploy only the Batch 1 runtime changes

Firestore rules are unchanged in this batch. Deploy the three new callable Functions and the updated site:

```bash
firebase deploy --only functions:requestLeagueLiveScoringRefresh,functions:releaseLeagueLiveScoringHandoff,functions:clearExpiredOrErroredLiveScoringLease,hosting:app -m "Batch 1 security test foundation"
```

## 7. Manual commissioner live-scoring test

Use a test league whose draft is complete.

1. Sign in as the commissioner.
2. Open **League HQ → Commissioner Tools → Live Scoring**.
3. Confirm the page title is **Server NHL Scorer**.
4. Open the browser developer console and clear existing messages.
5. Press **Refresh Scores Now** once.
6. Wait for the success message.
7. Confirm there is no `permission-denied` error in the console.
8. Confirm the page returns to **Server automation ready** after the refresh.
9. Confirm **Last completed refresh** changes to the current time.
10. Confirm **Last refresh reason** displays **Commissioner request**.
11. Press **Refresh Scores Now** again without waiting for NHL data to change.
12. Confirm the second pass completes and the unchanged/skipped count increases or remains consistent with no changed scoring snapshot.

**Pass condition:** the commissioner refresh runs through the Cloud Function and the browser never attempts a direct live-scoring write.

## 8. Manual role test

### Ordinary manager

1. Sign in as a non-commissioner manager in the same league.
2. Open the matchup page.
3. Confirm current scores and progress information load.
4. Confirm no live-scoring `permission-denied` errors appear in the console.
5. Attempt to open the Live Scoring developer route directly.

**Expected:** the manager can read shared scoring but cannot open commissioner diagnostics or request a refresh.

### League outsider

1. Sign in with an account that is not in the league.
2. Attempt to open the league URL directly.

**Expected:** league data is not displayed.

### Signed out

1. Sign out.
2. Attempt to open the league URL directly.

**Expected:** authentication is required and protected league data is not displayed.

## 9. Recovery-control test

Only run this while the diagnostics page says **Server automation ready**, not while a refresh is active.

1. Press **Clear Stale Control Lease**.
2. Confirm the success message appears.
3. Confirm no scoring snapshot, matchup score, cycle, or roster document is deleted.
4. Press **Refresh Scores Now** and confirm scoring still runs normally.

**Pass condition:** stale-control recovery works and does not change competition data.

## 10. Firestore spot check

In the Firebase console, inspect:

`leagues/{testLeagueId}/liveScoring/control`

After a manual refresh, confirm:

- `schemaVersion` is `2`
- `automationMode` is `server`
- `serverAutomationEnabled` is `true`
- `status` returns to `idle`
- `holderUserId` is `null`
- `holderClientId` is empty after completion
- `serverTrigger` is `manual`
- `lastRefreshReason` is `manual`
- `lastError` is empty
- `lastRefreshCompletedAt` is recent

## 11. Stop conditions

Do not proceed to Batch 2 when any of these occur:

- fewer than 24 rules tests pass
- an unexpected permission denial appears
- an ordinary manager can open commissioner diagnostics
- Refresh Scores Now writes from the browser instead of the Function
- a manual refresh remains stuck at `refreshing`
- a scoring refresh unexpectedly changes roster ownership or historical windows
- Angular or Functions build fails

## 12. Rollback

Use the checkpoint commit created before deployment:

```bash
git log --oneline -5
git revert <batch-1-commit-hash>
git push
npm run build:all
firebase deploy --only functions,hosting:app -m "Rollback Batch 1"
```
