# RinkRat Operations Batch D1J.1

**Purpose:** quota-safe Firebase Functions deployment verification and direct D1J focused-test recovery

## Why this batch exists

RinkRat currently exports 105 Firebase Functions from `functions/src/index.ts`. Cloud Run functions (2nd gen) permits 60 write operations per minute per project and region. A broad `firebase deploy`, followed immediately by `firebase deploy --only functions`, can therefore exhaust the deployment mutation quota even when application runtime capacity is healthy.

A 429 during deployment is a control-plane rate limit. It does not mean live Function invocations exhausted runtime capacity. A failed update leaves that individual Function on its previously deployed revision until a later targeted deployment succeeds.

D1J.1 adds a read-only inventory audit that compares the one authoritative local export surface with `gcloud functions list --v2` when available and falls back to `firebase functions:list --json`. It never deploys or deletes anything.

## Firebase Functions SDK warning

The season candidate currently resolves `firebase-functions` 7.3.0 from `functions/package-lock.json` (the declared compatible range begins at 7.2.5). A CLI warning that a newer SDK exists is advisory and is separate from the 429 quota error. Do not run `npm install --save firebase-functions@latest` merely to silence the warning immediately before the season. Treat the SDK update as a controlled dependency batch with a clean install, complete Functions build, emulator verification, and full regression gate.

## D1J direct-test recovery

The focused D1J test requires `/.season-release/` in `.gitignore`. The repository automation script already restores this rule. D1J.1 makes the focused test invoke that recovery before running, so this command is self-contained:

```bash
npm run test:batchd1j:run
```

## Local versus deployed inventory audit

Install and build first:

```bash
npm ci
npm --prefix functions ci
npm --prefix functions run build
```

Then run:

```bash
npm run firebase:audit-functions -- \
  --project=nhl-fantasy-app-ab673 \
  --provider=auto \
  --write-report="$HOME/Downloads/rinkrat-firebase-functions-audit.json"
```

`auto` prefers the Cloud SDK's complete second-generation inventory and falls back to the Firebase CLI when `gcloud` is unavailable.

The audit reports:

- expected local export count;
- deployed Function count;
- missing Function names;
- unexpected deployed Function names;
- region mismatches;
- duplicate names;
- extension-owned Functions ignored through the `ext-` prefix.

A clean D1J.1 inventory expects 105 project-owned Functions in `us-central1`.

`functions:list` proves presence, identity, and region. It does not prove that every Function contains the exact newest source revision. Exact revision confidence comes from the complete local release gate plus a successful targeted deployment of the Functions changed by that release.

## Retry the known failed Function

After the mutation quota has refreshed, retry only the Function named in the failed deployment:

```bash
firebase deploy \
  --only "functions:sendInjuryEmailsOnGlobalAvailabilityChange" \
  --project nhl-fantasy-app-ab673 \
  -m "Retry failed injury email Function update after mutation quota"
```

Do not immediately follow this with another all-Functions deployment.

## Verify cumulative scoring Functions

When D1I was not previously confirmed live, deploy its exact cumulative selector rather than every Function in the project:

```bash
firebase deploy \
  --only "functions:pollCanonicalNhlImpactFeed,functions:processLeagueAutomationTask,functions:dispatchDueLeagueAutomation,functions:queueLeagueAutomationCanaryCheck,functions:getLeagueAutomationQueueControlCenter,functions:updateLeagueAutomationQueueConfig,functions:runScheduledLeagueAutomation,functions:runSeasonStartAutomation,functions:initializeSeasonAfterDraft,functions:requestLeagueLiveScoringRefresh,functions:processHistoricalReplayAdvance,functions:monitorLeagueAutomationSeasonSafety,functions:refreshLeagueAutomationCapacityEvidence" \
  --project nhl-fantasy-app-ab673 \
  -m "D1F through D1I cumulative season scoring safety"
```

D1J itself remains Hosting-only.

## Full reconciliation plan

A complete local Function plan can be printed in batches of ten:

```bash
npm run firebase:plan-function-reconcile
```

The command prints deployment commands but executes none. Use a full reconciliation only after the exact release gate passes and only when inventory or deployment evidence warrants it. Run one batch at a time and allow the regional write quota to refresh before the next batch.

Never auto-delete an unexpected remote Function. First determine whether it is an obsolete project trigger, another codebase, or an extension-owned Function.

## Commands that are alternatives, not a sequence

These commands must not be copied and run one after another:

```text
firebase deploy
firebase deploy --only functions
firebase deploy --only firestore
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

A bare `firebase deploy` already attempts every configured resource. Running an all-Functions deployment immediately afterward repeats the largest control-plane workload and can trigger the regional mutation quota. RinkRat release instructions use exact targeted selectors instead.

## Deployment scope

D1J.1 changes only local release tooling, tests, documentation, and package scripts. It requires no Firebase deployment by itself.
