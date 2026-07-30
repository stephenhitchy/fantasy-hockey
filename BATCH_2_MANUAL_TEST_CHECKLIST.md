# RinkRat Batch 2 — Roster Authority Test Checklist

Batch 2 changes the authority boundary for roster actions. Ordinary managers now request roster changes through authenticated Cloud Functions instead of directly writing roster, waiver, claim, and transaction documents from the browser.

Use a **test league**, not a league whose data you care about. A completed draft is required for roster actions.

## 1. Install and run all automated checks

```bash
cd /Users/StephenH/Documents/Programming/fantasy-hockey
nvm use 22.23.1

npm ci
npm --prefix functions ci
npm run verify:batch2
```

Expected results:

- Firestore Emulator: **28 tests passed, 0 failed**.
- Angular production build completes.
- Functions `tsc` build completes without an error.
- Tests marked `[baseline exposure]` and `[temporary Batch 3/4 dependency]` are intentional transition tests described in the change summary.

Do not continue to deployment if any test or build fails.

## 2. Create the Git checkpoint

```bash
git status
git add .
git commit -m "Harden roster moves behind server authority"
git push
```

Record the commit hash shown by:

```bash
git rev-parse --short HEAD
```

## 3. Deploy in the safe order

The Functions must exist before the new web client and rules begin relying on them.

### Step A — deploy the three roster-authority Functions

```bash
firebase deploy --only functions:ensureFantasyRoster,functions:executeSecureRosterAction,functions:applyImmediateRosterMove -m "Batch 2 roster authority functions"
```

### Step B — deploy the updated site

```bash
firebase deploy --only hosting:app -m "Batch 2 roster authority client"
```

### Step C — run the pre-rules smoke test in Section 4

After it passes, deploy the tightened rules:

```bash
firebase deploy --only firestore:rules -m "Batch 2 roster authority rules"
```

### Step D — repeat the smoke test after the rules deploy

The post-rules pass is the one that approves Batch 2.

## 4. Required five-minute smoke test

Use a manager in a completed-draft test league.

1. Open Dashboard, My Team, Free Agents, and Game Center.
2. Confirm the roster and matchup load normally.
3. From Free Agents, complete one legal add/drop involving a bench slot.
4. Return to My Team and confirm:
   - the incoming asset appears in the selected bench slot;
   - the outgoing asset is no longer on the roster;
   - no duplicate copy appears elsewhere;
   - the page updates without a manual reload.
5. Open the league transaction history and confirm a new entry appears.
6. Open browser Developer Tools → Console and verify there is no red `permission-denied`, `not-found`, failed callable, or unhandled error.

In Firestore, inspect the new transaction document and confirm:

```text
authority: "cloud-function"
```

Also confirm the dropped asset has an active document under the league's `waivers` collection.

## 5. Full roster-action regression

Complete these tests before approving the batch. Use Manager A unless another account is specified.

### A. Add/drop to a bench slot

1. Add a free agent while dropping a bench asset.
2. Confirm the new asset occupies that exact bench slot.
3. Confirm the dropped asset appears on waivers.
4. Confirm one transaction document was created with `authority: "cloud-function"`.

Expected: the move applies immediately as an ownership change.

### B. Add to an open bench slot

1. Drop a bench asset to create an open bench slot.
2. Add a free agent into the open slot.

Expected: the open slot fills, no unrelated slot changes, and the added asset cannot appear on another roster.

### C. Active-slot add/drop

Test whichever path your test league currently permits:

- **Untouched current slot window:** the move may apply immediately to the current cycle.
- **Started slot window:** the move must be queued for the next fair slot boundary.

Confirm:

- the incoming asset matches the active slot's position;
- a started window is never silently rewritten;
- a queued move shows on the correct slot;
- the current matchup score/window remains intact.

### D. Cancel a queued move

1. Create a queued active-slot move.
2. Cancel it before activation.

Expected: the pending move disappears, the current asset remains, and a cancellation transaction is written. A waiver-award move should not offer a normal cancellation path.

### E. Active/bench swap

1. Select a bench asset whose position matches an active slot.
2. Perform the swap.

Expected:

- an untouched eligible window may swap immediately;
- otherwise the swap is queued;
- the bench asset remains reserved while queued;
- attempting to drop or replace that reserved bench asset is rejected with a useful message;
- no asset is duplicated.

### F. Drop from active, bench, and IR

Test each area that has an asset available.

Expected:

- the selected asset leaves only the selected roster area;
- an active waiver is created;
- the current immutable scoring window is not erased;
- a reserved bench asset cannot be dropped until its queued swap is canceled.

### G. IR movement and activation

Use an actually IR-eligible skater (`Out`, `IR`, or `LTIR`) in the test league.

1. Move an eligible active skater to IR.
2. Move an eligible bench skater to IR if one is available.
3. Attempt to move an active/healthy or day-to-day skater to IR.
4. Activate an IR player to an active slot of the matching position.
5. Activate an IR player to a bench slot.

Expected:

- only server-authoritative `Out`, `IR`, or `LTIR` statuses are accepted;
- healthy, day-to-day, suspended, and unknown players are rejected;
- goalie units cannot be placed on IR;
- all three IR slots are enforced;
- activation never creates a duplicate;
- replacing an occupied destination sends the outgoing asset to waivers.

### H. Duplicate and position protection

1. Try to add a player already on Manager A's roster.
2. Try to add a player owned by Manager B.
3. Try to place a C in an LW, RW, D, or G active slot.
4. Try to add a player who currently has an active waiver document as a normal free agent.

Expected: every attempt is rejected and no roster, waiver, or transaction document is partially changed.

## 6. Waiver regression with two managers

Use Manager A, Manager B, and the commissioner.

1. Manager A drops a bench asset to waivers.
2. Verify Manager A cannot submit a claim on their own active waiver drop.
3. Manager B submits a claim using either:
   - an open compatible slot; or
   - a valid drop slot.
4. Verify the claim appears in the UI.
5. Sign in as commissioner and process the waiver.
6. Confirm:
   - the highest-priority eligible claimant wins;
   - the asset appears once on the winning roster;
   - the waiver status becomes `claimed`;
   - `awardedToOwnerId` is set;
   - the winning manager moves to the end of waiver priority;
   - other priorities shift correctly;
   - any dropped replacement asset receives its own active waiver;
   - the transaction has `authority: "cloud-function"`.
7. Repeat with a claim whose selected slot becomes invalid before processing.

Expected: the server skips the invalid claim and considers the next eligible claimant. If no claim remains eligible, the waiver clears and a `waiver-cleared` transaction is written.

## 7. New-team roster initialization

Use a disposable account or new test league.

1. Join/create the league and allow the team to be created.
2. Open My Team or Team Settings.
3. Confirm the roster loads with:
   - 14 active slots;
   - 3 bench slots;
   - 3 IR slots.
4. Confirm there is no `permission-denied` error.
5. In Firestore, confirm `teams/{uid}/roster/current` exists with `schemaVersion: 2`.

This verifies that `ensureFantasyRoster` replaced direct browser roster creation correctly.

## 8. Manual draft transition check

Batch 3 will move drafting behind server authority. Until then, Batch 2 deliberately preserves the existing atomic manual-pick roster update.

In a disposable live draft:

1. Start the draft normally.
2. Make at least one manual pick as a non-commissioner manager.
3. Confirm the pick is recorded and placed into the correct active or bench slot.
4. Confirm the next manager goes on the clock.
5. Confirm no `permission-denied` error occurs.

Do not approve Batch 2 if manual picks fail after the rules deployment.

## 9. Commissioner cycle-boundary transition check

Batch 4 will move cycle/playoff boundary writes to the server. For now, confirm the existing commissioner process is not broken.

In a test league with a queued roster move:

1. Run or allow the normal cycle/window progression that activates the move.
2. Confirm the incoming asset activates at the intended boundary.
3. Confirm a bench swap moves the outgoing active asset to the bench.
4. Confirm an add/drop queues the outgoing asset to waivers when activated.
5. Confirm matchup and roster-window data still load.

This is the temporary reason commissioner roster/waiver/transaction writes remain permitted until Batch 4.

## 10. Browser and device checks

Run the smoke test in:

- Chrome desktop;
- Safari desktop;
- one mobile viewport or physical phone.

Check Free Agents, My Team, queued-move labels, waiver dialogs, and confirmation/error messages. Batch 2 is not a visual redesign, so unexplained layout changes are regressions.

## 11. Firestore spot checks

For each successful test action, verify:

- only the signed-in user's roster changed unless processing a commissioner waiver award;
- each asset key exists on no more than one roster, including `pendingMove.incomingAsset` reservations;
- transaction documents created by new roster actions contain `authority: "cloud-function"`;
- active waiver documents contain matching `assetKey` and `asset.assetKey`;
- roster shape remains 14 active / 3 bench / 3 IR;
- historical cycle roster picks and completed game windows were not rewritten.

## 12. Stop conditions

Stop and send the full console/terminal output if any of these occur:

- a normal roster action returns `permission-denied`;
- a valid free agent returns “not available in the authoritative player pool”;
- a successful UI action changes the wrong slot;
- an asset appears on two rosters or both active and bench/IR unexpectedly;
- a failed action leaves a partial roster, waiver, or transaction update;
- a current or completed six-game window is erased or restarted;
- a manual draft pick fails after rules deployment;
- a commissioner cycle-boundary activation fails;
- any callable returns `not-found` immediately after deployment;
- browser console shows an unhandled error.

## 13. Approval gate

Batch 2 is approved only when:

- `npm run verify:batch2` passes;
- all 28 rule tests pass;
- the pre-rules and post-rules smoke tests pass;
- the add/drop, queued move, cancel, swap, IR, and waiver paths pass;
- manual drafting still works;
- one commissioner cycle-boundary activation still works;
- no unexpected browser-console errors remain;
- no duplicate assets or partial writes are found.

## 14. Rollback

Revert the Batch 2 Git commit, rebuild, and redeploy the Batch 1 runtime/rules:

```bash
git revert <BATCH_2_COMMIT_HASH>

npm ci
npm --prefix functions ci
npm run build:all

firebase deploy --only functions:applyImmediateRosterMove,firestore:rules,hosting:app -m "Rollback Batch 2 roster authority"
```

The two new callables may remain deployed but unused after rollback; they validate authentication and ownership and are not harmful. They can be deleted later if desired. Do not manually edit production roster documents as part of a rollback.
