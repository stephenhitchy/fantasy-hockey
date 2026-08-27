# RinkRat Operations Batch D1J.2

**Candidate:** RC66 / D1J.2
**Purpose:** Repair false Shadow backlog evidence and stop dirty builds from appearing eligible for final validation
**Deployment:** Four targeted Functions plus Hosting

## Evidence reviewed

The production evidence showed:

- all 105 expected Firebase Functions deployed and matched;
- Production Scoring V4 and Projection V11 aligned;
- live queue mode Shadow with complete 3/3 schedule coverage, zero pending tasks, zero enqueue failures, and zero stale recoveries;
- an extremely old due-schedule age that the same report correctly described as observation-only;
- the Control Center incorrectly converted that Shadow-only age into a critical backlog alert;
- the live Hosting manifest identified a `-dirty` source revision;
- the validation report remained in testing with 2/6 teams, 31 required manual workflows untested, and one failed replay operation to review.

## Shadow due schedules are not a backlog

Shadow deliberately observes due schedules without dispatching queued scoring. The legacy scorer remains authoritative. A due age can therefore grow for weeks without indicating a queue delay.

D1J.2 now:

- stores the oldest observed due age separately from the oldest Canary/Primary-eligible due age;
- evaluates backlog age only in Canary or Primary;
- emits one informational Shadow explanation when observed schedules are old;
- prevents historical, paused, or otherwise ineligible schedules from creating a false active-queue backlog after Canary is enabled;
- keeps the watchdog streak at zero in Shadow;
- allows season-freeze evidence to distinguish healthy observation from a real active-queue backlog.

Canary and Primary retain the existing four-minute warning and ten-minute blocking thresholds.

## Dirty build gate

The Release Readiness page already displayed `uncommitted`, and the freeze CLI already rejected a non-clean revision. The invite-beta gate did not surface that condition as an immediate hard blocker.

D1J.2 adds the same clean-source requirement as a required automated Release Readiness check, so a dirty build is visible before a validation report is copied.

D1J.2 adds a required launch blocker when the deployed manifest:

- is missing;
- is `unversioned`;
- ends in `-dirty`;
- is not one clean 40-character Git revision.

The correct recovery is:

1. commit the intended release;
2. rerun the complete local gate;
3. rebuild after the commit;
4. deploy the targeted Functions and Hosting;
5. reload Release Readiness;
6. repeat validation on the new clean build ID.

## Deployment guard

Functions and Hosting now run a clean-source predeploy guard before and after their build hook. Firebase cancels the deployment when Git contains tracked or untracked work, or when HEAD is not one 40-character commit. The second guard catches a build or asset-synchronization step that unexpectedly changes tracked source.

The legacy `npm run deploy:production` and `npm run deploy:season-ready` commands now fail closed because they previously bundled broad Functions, Rules, indexes, and Hosting deployment into one routine action. Use the exact release-specific `firebase deploy --only ...` selector instead.

A new build ID intentionally starts a fresh browser validation board.

## What still must be completed manually

D1J.2 does not waive the true release blockers:

- fill the six-team validation league;
- pass all 31 required manual workflows;
- review the failed historical-replay action;
- copy fresh scoring and private-season evidence;
- freeze and tag the exact clean build.

## Verification

```bash
npm run test:documentation:run
npm run test:batchd1j1:run
npm run test:batchd1j2:run
npm run verify:batchd1j2
npm run build:all
```

## Targeted deployment

```bash
firebase deploy \
  --only "functions:dispatchDueLeagueAutomation,functions:getLeagueAutomationQueueControlCenter,functions:monitorLeagueAutomationSeasonSafety,functions:updateLeagueAutomationQueueConfig" \
  --project nhl-fantasy-app-ab673 \
  -m "D1J.2 repair Shadow backlog evidence"

firebase deploy \
  --only hosting:app \
  --project nhl-fantasy-app-ab673 \
  -m "D1J.2 clean-build validation gate"
```

No Firestore Rules, indexes, TTL policies, database migration, scoring value, or Projection V11 change is required.
