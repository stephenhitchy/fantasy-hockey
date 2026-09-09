import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDraftAvailabilityRefreshTaskId,
  DRAFT_AVAILABILITY_PREPARATION_WINDOW_MILLISECONDS,
  DRAFT_AVAILABILITY_MAX_ERROR_BACKOFF_MILLISECONDS,
  DRAFT_AVAILABILITY_OVERDUE_RECOVERY_MILLISECONDS,
  DRAFT_AVAILABILITY_REFRESH_BUCKET_MILLISECONDS,
  DRAFT_AVAILABILITY_STANDARD_ERROR_COOLDOWN_MILLISECONDS,
  DRAFT_AVAILABILITY_TASK_ERROR_COOLDOWN_MILLISECONDS,
  getDraftAvailabilityDailyKey,
  getDraftAvailabilityErrorBackoffMilliseconds,
  getDraftAvailabilityPreparationState,
  isDraftAvailabilityEvidenceUsable,
  isDraftAvailabilityRefreshInErrorCooldown,
  isDraftAvailabilityTaskRetryAfterActive,
} from '../../functions/src/draft-readiness.util.ts';
import {
  collectExpectedFirebaseFunctionNames,
} from '../../scripts/release/firebase-functions-deployment-audit.util.mjs';
import {
  DRAFT_AVAILABILITY_MIN_NHL_DEFENSEMEN_PER_TEAM,
  DRAFT_AVAILABILITY_MIN_NHL_FORWARDS_PER_TEAM,
  DRAFT_AVAILABILITY_MIN_NHL_SKATERS_PER_TEAM,
  DRAFT_AVAILABILITY_SOURCE_SCHEMA_VERSION,
  createDraftNhlRosterIdentityHash,
  evaluateDraftAvailabilityIdentityCompleteness,
  evaluateDraftAvailabilitySourceCompleteness,
  isDraftNhlTeamRosterComplete,
  isDraftNhlRosterIdentityHash,
} from '../../functions/src/shared/core/player/draft-availability-source-completeness.util.ts';
import {
  criticalDraftFunctions,
} from '../../scripts/release/ff1-draft-preflight.mjs';

const ROOT = new URL('../../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const START = Date.parse('2026-10-06T01:00:00.000Z');
const REVISION = 'a'.repeat(64);
const TEST_PROJECT_ID = 'demo-rinkrat-ff1-15';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const require = createRequire(import.meta.url);
const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);

process.env.GCLOUD_PROJECT = TEST_PROJECT_ID;
process.env.GOOGLE_CLOUD_PROJECT = TEST_PROJECT_ID;

const {
  updateScheduledDraftReadinessDocument,
} = require(`${ROOT_PATH}functions/lib/shared/core/draft/draft-readiness-write.service.js`);
const {
  invalidateDraftAvailabilityAttestationForRosterMismatch,
} = require(`${ROOT_PATH}functions/lib/shared/core/player/draft-availability-attestation-write.service.js`);
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore');

let adminApp;
let firestore;

before(() => {
  assert.ok(
    FIRESTORE_EMULATOR_HOST,
    'FF1.31 authority tests must run inside the Firestore emulator.',
  );
  adminApp = initializeApp(
    { projectId: TEST_PROJECT_ID },
    `ff1-15-${randomUUID()}`,
  );
  firestore = getFirestore(adminApp);
});

after(async () => {
  if (adminApp) {
    await deleteApp(adminApp);
  }
});

test('availability preparation starts at T-25 and continues after zero while scheduled', () => {
  assert.equal(DRAFT_AVAILABILITY_PREPARATION_WINDOW_MILLISECONDS, 25 * 60 * 1000);
  assert.equal(DRAFT_AVAILABILITY_OVERDUE_RECOVERY_MILLISECONDS, 60 * 60 * 1000);
  assert.equal(getDraftAvailabilityPreparationState({
    draftStatus: 'scheduled',
    scheduledStartMilliseconds: START,
    nowMilliseconds: START - 25 * 60 * 1000 - 1,
  }), 'outside-window');
  assert.equal(getDraftAvailabilityPreparationState({
    draftStatus: 'scheduled',
    scheduledStartMilliseconds: START,
    nowMilliseconds: START - 25 * 60 * 1000,
  }), 'prepare');
  assert.equal(getDraftAvailabilityPreparationState({
    draftStatus: 'scheduled',
    scheduledStartMilliseconds: START,
    nowMilliseconds: START + 10 * 60 * 1000,
  }), 'prepare');
  assert.equal(getDraftAvailabilityPreparationState({
    draftStatus: 'scheduled',
    scheduledStartMilliseconds: START,
    nowMilliseconds: START + 60 * 60 * 1000,
  }), 'prepare');
  assert.equal(getDraftAvailabilityPreparationState({
    draftStatus: 'scheduled',
    scheduledStartMilliseconds: START,
    nowMilliseconds: START + 60 * 60 * 1000 + 1,
  }), 'recovery-expired');
  assert.equal(getDraftAvailabilityPreparationState({
    draftStatus: 'live',
    scheduledStartMilliseconds: START,
    nowMilliseconds: START - 20 * 60 * 1000,
  }), 'unavailable');
});

test('global task identity coalesces leagues and duplicate delivery by UTC five-minute bucket', () => {
  const dailyKey = getDraftAvailabilityDailyKey(START);
  assert.equal(dailyKey, '2026-10-06');
  assert.equal(DRAFT_AVAILABILITY_REFRESH_BUCKET_MILLISECONDS, 5 * 60 * 1000);

  const first = buildDraftAvailabilityRefreshTaskId({
    dailyKey,
    nowMilliseconds: START + 1,
  });
  const duplicate = buildDraftAvailabilityRefreshTaskId({
    dailyKey,
    nowMilliseconds: START + 4 * 60 * 1000,
  });
  const nextBucket = buildDraftAvailabilityRefreshTaskId({
    dailyKey,
    nowMilliseconds: START + 5 * 60 * 1000,
  });

  assert.match(first, /^[0-9a-f]{40}$/);
  assert.equal(duplicate, first);
  assert.notEqual(nextBucket, first);
  assert.equal(getDraftAvailabilityDailyKey(Number.NaN), null);
  assert.equal(getDraftAvailabilityDailyKey(Number.MAX_VALUE), null);
});

test('private Draft retries make real attempts while ordinary refreshes retain the 15-minute cooldown', () => {
  const failedAt = START;

  assert.equal(DRAFT_AVAILABILITY_TASK_ERROR_COOLDOWN_MILLISECONDS, 25_000);
  assert.equal(
    DRAFT_AVAILABILITY_STANDARD_ERROR_COOLDOWN_MILLISECONDS,
    15 * 60 * 1000,
  );
  assert.equal(isDraftAvailabilityRefreshInErrorCooldown({
    lastAttemptMilliseconds: failedAt,
    nowMilliseconds: failedAt + 24_999,
    strictDraftTask: true,
  }), true);
  assert.equal(isDraftAvailabilityRefreshInErrorCooldown({
    lastAttemptMilliseconds: failedAt,
    nowMilliseconds: failedAt + 30_000,
    strictDraftTask: true,
  }), false);
  assert.equal(isDraftAvailabilityRefreshInErrorCooldown({
    lastAttemptMilliseconds: failedAt,
    nowMilliseconds: failedAt + 30_000,
    strictDraftTask: false,
  }), true);

  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 99].map(
      getDraftAvailabilityErrorBackoffMilliseconds,
    ),
    [25_000, 50_000, 100_000, 200_000, 400_000, 800_000, 900_000, 900_000],
  );
  assert.equal(
    getDraftAvailabilityErrorBackoffMilliseconds(0),
    DRAFT_AVAILABILITY_MAX_ERROR_BACKOFF_MILLISECONDS,
  );
  const retryAfterMilliseconds = failedAt + 5 * 60 * 1000;
  assert.equal(isDraftAvailabilityTaskRetryAfterActive({
    strictDraftTask: true,
    previousFailureWasStrictDraftTask: true,
    sameTaskBucketRetry: false,
    retryAfterMilliseconds,
    nowMilliseconds: failedAt + 60_000,
  }), true);
  assert.equal(isDraftAvailabilityTaskRetryAfterActive({
    strictDraftTask: true,
    previousFailureWasStrictDraftTask: true,
    sameTaskBucketRetry: true,
    retryAfterMilliseconds,
    nowMilliseconds: failedAt + 60_000,
  }), false);
  assert.equal(isDraftAvailabilityTaskRetryAfterActive({
    strictDraftTask: true,
    previousFailureWasStrictDraftTask: false,
    sameTaskBucketRetry: false,
    retryAfterMilliseconds,
    nowMilliseconds: failedAt + 60_000,
  }), false);
});

test('only current successful attested availability with its own daily key is reusable', () => {
  const base = {
    revision: REVISION,
    lastSuccessfulAt: new Date(START - 60_000).toISOString(),
    lastDailySyncKey: '2026-10-06',
    status: 'success',
    draftReadinessSourceComplete: true,
    draftReadinessSourceAttemptId: 'availability-attempt-1',
    refreshAttemptId: 'availability-attempt-1',
    nowMilliseconds: START,
  };

  assert.equal(isDraftAvailabilityEvidenceUsable(base), true);
  assert.equal(isDraftAvailabilityEvidenceUsable({ ...base, status: 'error' }), false);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    ...base,
    lastDailySyncKey: '2026-10-05',
  }), false);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    ...base,
    revision: null,
  }), false);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    ...base,
    draftReadinessSourceComplete: false,
  }), false);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    ...base,
    refreshAttemptId: 'newer-writer-attempt',
  }), false);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    ...base,
    lastSuccessfulAt: '2026-10-05T23:59:00.000Z',
    lastDailySyncKey: '2026-10-05',
    nowMilliseconds: Date.parse('2026-10-06T00:05:00.000Z'),
  }), true);
  assert.equal(isDraftAvailabilityEvidenceUsable({
    ...base,
    lastSuccessfulAt: new Date(START - 23 * 60 * 60 * 1000 - 50 * 60 * 1000).toISOString(),
    lastDailySyncKey: '2026-10-05',
    requiredThroughMilliseconds: START + 25 * 60 * 1000,
  }), false);
});

test('identity ambiguity blocks readiness while name-not-found stays a bounded D1B advisory', () => {
  assert.deepEqual(evaluateDraftAvailabilityIdentityCompleteness({
    nameNotFoundCount: 11,
    ambiguousNameCount: 0,
    aliasTargetMissingCount: 0,
  }), {
    complete: true,
    issues: [],
    nameNotFoundAdvisoryCount: 11,
  });
  assert.deepEqual(evaluateDraftAvailabilityIdentityCompleteness({
    nameNotFoundCount: 0,
    ambiguousNameCount: 1,
    aliasTargetMissingCount: 2,
  }), {
    complete: false,
    issues: [
      'injury-identity-ambiguous',
      'injury-alias-target-missing',
    ],
    nameNotFoundAdvisoryCount: 0,
  });
  assert.deepEqual(evaluateDraftAvailabilityIdentityCompleteness({
    nameNotFoundCount: -1,
    ambiguousNameCount: 0,
    aliasTargetMissingCount: 0,
  }), {
    complete: false,
    issues: ['injury-identity-count-invalid'],
    nameNotFoundAdvisoryCount: 0,
  });
});

test('the Draft roster identity hash is order-independent and changes with the matching universe', () => {
  const identities = [
    {
      id: 8478402,
      fullName: ' Jack Hughes ',
      position: 'C',
      nhlTeamAbbreviation: 'njd',
    },
    {
      id: 8477492,
      fullName: 'Cale Makar',
      position: 'D',
      nhlTeamAbbreviation: 'COL',
    },
  ];
  const original = createDraftNhlRosterIdentityHash(identities);
  const reordered = createDraftNhlRosterIdentityHash([...identities].reverse());
  const changedName = createDraftNhlRosterIdentityHash([
    { ...identities[0], fullName: 'Jack Q. Hughes' },
    identities[1],
  ]);

  assert.equal(DRAFT_AVAILABILITY_SOURCE_SCHEMA_VERSION, 2);
  assert.equal(isDraftNhlRosterIdentityHash(original), true);
  assert.equal(reordered, original);
  assert.notEqual(changedName, original);
  assert.throws(
    () => createDraftNhlRosterIdentityHash([identities[0], identities[0]]),
    /unique/,
  );
});

test('pre-Draft availability requires complete NHL rosters and a fresh structured ESPN response', () => {
  const complete = {
    expectedNhlTeamCount: 32,
    loadedNhlTeamCount: 32,
    failedNhlTeamCount: 0,
    espnStatus: 'success',
    espnTimestamp: new Date(START - 60_000).toISOString(),
    espnInjuriesArrayPresent: true,
    espnTeamGroupCount: 25,
    espnRecognizedTeamCount: 25,
    espnUnrecognizedTeamCount: 0,
    espnDuplicateTeamGroupCount: 0,
    espnMalformedTeamGroupCount: 0,
    espnMalformedInjuryEntryCount: 0,
    nowMilliseconds: START,
  };

  assert.deepEqual(evaluateDraftAvailabilitySourceCompleteness(complete), {
    complete: true,
    issues: [],
  });

  const partialRoster = evaluateDraftAvailabilitySourceCompleteness({
    ...complete,
    loadedNhlTeamCount: 31,
    failedNhlTeamCount: 1,
  });
  assert.equal(partialRoster.complete, false);
  assert.ok(partialRoster.issues.includes('nhl-roster-coverage-incomplete'));

  const fewerInjuredTeams = evaluateDraftAvailabilitySourceCompleteness({
    ...complete,
    espnTeamGroupCount: 4,
    espnRecognizedTeamCount: 4,
  });
  assert.deepEqual(fewerInjuredTeams, { complete: true, issues: [] });

  const legitimateZeroInjuries = evaluateDraftAvailabilitySourceCompleteness({
    ...complete,
    espnTeamGroupCount: 0,
    espnRecognizedTeamCount: 0,
  });
  assert.deepEqual(legitimateZeroInjuries, { complete: true, issues: [] });
});

test('a syntactically successful but position-incomplete NHL roster cannot attest readiness', () => {
  assert.equal(DRAFT_AVAILABILITY_MIN_NHL_SKATERS_PER_TEAM, 12);
  assert.equal(DRAFT_AVAILABILITY_MIN_NHL_FORWARDS_PER_TEAM, 6);
  assert.equal(DRAFT_AVAILABILITY_MIN_NHL_DEFENSEMEN_PER_TEAM, 3);
  assert.equal(isDraftNhlTeamRosterComplete({
    forwardsArrayPresent: true,
    defensemenArrayPresent: true,
    validForwardCount: 9,
    validDefensemanCount: 4,
    uniqueSkaterCount: 13,
  }), true);
  assert.equal(isDraftNhlTeamRosterComplete({
    forwardsArrayPresent: true,
    defensemenArrayPresent: false,
    validForwardCount: 20,
    validDefensemanCount: 0,
    uniqueSkaterCount: 20,
  }), false);
  assert.equal(isDraftNhlTeamRosterComplete({
    forwardsArrayPresent: true,
    defensemenArrayPresent: true,
    validForwardCount: 1,
    validDefensemanCount: 1,
    uniqueSkaterCount: 2,
  }), false);
  assert.equal(isDraftNhlTeamRosterComplete({
    forwardsArrayPresent: true,
    defensemenArrayPresent: true,
    validForwardCount: 10,
    validDefensemanCount: 4,
    uniqueSkaterCount: 2,
  }), false);
});

test('malformed, stale, unknown-team, and missing ESPN evidence cannot authorize a Draft board', () => {
  const base = {
    expectedNhlTeamCount: 32,
    loadedNhlTeamCount: 32,
    failedNhlTeamCount: 0,
    espnStatus: 'error',
    espnTimestamp: 'not-a-timestamp',
    espnInjuriesArrayPresent: false,
    espnTeamGroupCount: 1,
    espnRecognizedTeamCount: 25,
    espnUnrecognizedTeamCount: 1,
    espnDuplicateTeamGroupCount: 1,
    espnMalformedTeamGroupCount: 1,
    espnMalformedInjuryEntryCount: 1,
    nowMilliseconds: START,
  };
  const malformed = evaluateDraftAvailabilitySourceCompleteness(base);

  assert.equal(malformed.complete, false);
  assert.deepEqual(malformed.issues, [
    'espn-status-incomplete',
    'espn-timestamp-invalid',
    'espn-structure-incomplete',
    'espn-team-unrecognized',
    'espn-team-duplicate',
  ]);

  const stale = evaluateDraftAvailabilitySourceCompleteness({
    ...base,
    espnStatus: 'success',
    espnTimestamp: new Date(START - 30 * 60 * 1000 - 1).toISOString(),
    espnInjuriesArrayPresent: true,
    espnTeamGroupCount: 1,
    espnRecognizedTeamCount: 1,
    espnUnrecognizedTeamCount: 0,
    espnDuplicateTeamGroupCount: 0,
    espnMalformedTeamGroupCount: 0,
    espnMalformedInjuryEntryCount: 0,
  });
  assert.equal(stale.complete, false);
  assert.deepEqual(stale.issues, ['espn-timestamp-stale']);
});

test('the existing server Draft paths queue availability before Projection readiness without a browser', async () => {
  const source = await read('functions/src/draft-automation.ts');
  const scheduleStart = source.indexOf('async function scheduleDraftAvailabilityRefreshIfNeeded(');
  const scheduleEnd = source.indexOf('\nfunction buildDraftClockTaskId(', scheduleStart);
  const schedule = source.slice(scheduleStart, scheduleEnd);
  const processStart = source.indexOf('async function processLeagueDraftAutomation(');
  const processEnd = source.indexOf('async function getAutomatedDraftLeagueIds(', processStart);
  const process = source.slice(processStart, processEnd);
  const availabilityCall = process.indexOf('scheduleDraftAvailabilityRefreshIfNeeded');
  const projectionCall = process.indexOf('prepareScheduledDraftReadiness');

  assert.ok(availabilityCall > 0);
  assert.ok(projectionCall > availabilityCall);
  assert.match(source, /taskQueue<DraftAvailabilityRefreshTaskPayload>\(\s*'refreshDraftPlayerAvailabilityTask'/);
  assert.match(source, /buildDraftAvailabilityRefreshTaskId/);
  assert.match(source, /isTaskAlreadyExistsError/);
  assert.match(source, /No commissioner action is required/);
  assert.doesNotMatch(source, /scheduleDraftAvailabilityRefreshIfNeeded[\s\S]{0,4000}verifyLeagueMembership/);
  assert.ok(
    schedule.indexOf("serverDraftReadinessStatus: 'waiting-injury'") <
      schedule.indexOf('getDraftAvailabilityRefreshTaskQueue().enqueue'),
  );
  assert.match(
    schedule,
    /serverDraftReadinessProjectionRequestId:\s*null[\s\S]*?serverDraftReadinessProjectionSnapshotId:\s*null[\s\S]*?serverDraftReadinessProjectionSnapshotHash:\s*null/,
  );
  assert.match(schedule, /projectionPreparationRequestId:\s*null/);
  assert.match(
    schedule,
    /Unable to queue automatic Draft availability preparation[\s\S]*?serverDraftReadinessStatus:\s*'error'[\s\S]*?projectionPreparationStatus:\s*'error'/,
  );
});

test('readiness writes converge and stale workers cannot mutate a rescheduled Draft', async () => {
  const leagueId = `ff1-15-${randomUUID()}`;
  const draftRef = firestore.doc(`leagues/${leagueId}/draft/current`);
  const scheduledStartMilliseconds = START;
  const payload = {
    serverDraftReadinessStatus: 'waiting-injury',
    serverDraftReadinessProjectionRequestId: null,
    serverDraftReadinessProjectionSnapshotId: null,
    serverDraftReadinessProjectionSnapshotHash: null,
    projectionPreparationRequestId: null,
  };

  await draftRef.set({
    status: 'scheduled',
    scheduledStartAt: Timestamp.fromMillis(scheduledStartMilliseconds),
    clockStatus: 'stopped',
    nextOverallPick: 1,
    picks: [],
  });

  const duplicateResults = await Promise.all([
    updateScheduledDraftReadinessDocument(
      draftRef,
      scheduledStartMilliseconds,
      payload,
    ),
    updateScheduledDraftReadinessDocument(
      draftRef,
      scheduledStartMilliseconds,
      payload,
    ),
  ]);
  assert.deepEqual(duplicateResults, [true, true]);

  const converged = (await draftRef.get()).data();
  assert.equal(converged?.['status'], 'scheduled');
  assert.equal(converged?.['clockStatus'], 'stopped');
  assert.equal(converged?.['nextOverallPick'], 1);
  assert.deepEqual(converged?.['picks'], []);
  assert.equal(converged?.['serverDraftReadinessStatus'], 'waiting-injury');
  assert.equal(converged?.['serverDraftReadinessProjectionSnapshotId'], null);

  const rescheduledStartMilliseconds = scheduledStartMilliseconds + 60_000;
  await draftRef.set({
    scheduledStartAt: Timestamp.fromMillis(rescheduledStartMilliseconds),
    serverDraftReadinessStatus: 'unavailable',
  }, { merge: true });

  assert.equal(await updateScheduledDraftReadinessDocument(
    draftRef,
    scheduledStartMilliseconds,
    {
      serverDraftReadinessStatus: 'ready',
      serverDraftReadinessProjectionSnapshotId: 'stale-snapshot',
    },
  ), false);

  const afterStaleWorker = (await draftRef.get()).data();
  assert.equal(afterStaleWorker?.['status'], 'scheduled');
  assert.equal(afterStaleWorker?.['clockStatus'], 'stopped');
  assert.equal(afterStaleWorker?.['serverDraftReadinessStatus'], 'unavailable');
  assert.equal(afterStaleWorker?.['serverDraftReadinessProjectionSnapshotId'], null);
});

test('roster mismatch invalidation is compare-and-set and cannot clear newer source evidence', async () => {
  const reference = firestore.doc(`appData/playerAvailability-${randomUUID()}`);
  const firstHash = createDraftNhlRosterIdentityHash([{
    id: 8478402,
    fullName: 'Jack Hughes',
    position: 'C',
    nhlTeamAbbreviation: 'NJD',
  }]);
  const newerHash = createDraftNhlRosterIdentityHash([{
    id: 8477492,
    fullName: 'Cale Makar',
    position: 'D',
    nhlTeamAbbreviation: 'COL',
  }]);

  await reference.set({
    draftReadinessSourceSchemaVersion:
      DRAFT_AVAILABILITY_SOURCE_SCHEMA_VERSION,
    draftReadinessSourceComplete: true,
    draftReadinessSourceAttemptId: 'attempt-1',
    refreshAttemptId: 'attempt-1',
    draftReadinessNhlRosterIdentityHash: firstHash,
    draftReadinessSourceIssues: [],
  });

  assert.equal(await invalidateDraftAvailabilityAttestationForRosterMismatch({
    reference,
    expectedSourceAttemptId: 'attempt-1',
    expectedRosterIdentityHash: firstHash,
  }), true);

  const invalidated = (await reference.get()).data();
  assert.equal(invalidated?.['draftReadinessSourceComplete'], false);
  assert.deepEqual(
    invalidated?.['draftReadinessSourceIssues'],
    ['nhl-roster-identity-changed'],
  );

  await reference.set({
    draftReadinessSourceComplete: true,
    draftReadinessSourceAttemptId: 'attempt-2',
    refreshAttemptId: 'attempt-2',
    draftReadinessNhlRosterIdentityHash: newerHash,
    draftReadinessSourceIssues: [],
  }, { merge: true });

  assert.equal(await invalidateDraftAvailabilityAttestationForRosterMismatch({
    reference,
    expectedSourceAttemptId: 'attempt-1',
    expectedRosterIdentityHash: firstHash,
  }), false);

  const preserved = (await reference.get()).data();
  assert.equal(preserved?.['draftReadinessSourceComplete'], true);
  assert.equal(preserved?.['draftReadinessSourceAttemptId'], 'attempt-2');
  assert.equal(preserved?.['draftReadinessNhlRosterIdentityHash'], newerHash);
});

test('recovery-expired readiness remains scheduled, stopped, and at zero picks', async () => {
  const leagueId = `ff1-15-expired-${randomUUID()}`;
  const draftRef = firestore.doc(`leagues/${leagueId}/draft/current`);

  await draftRef.set({
    status: 'scheduled',
    scheduledStartAt: Timestamp.fromMillis(START),
    clockStatus: 'stopped',
    nextOverallPick: 1,
    picks: [],
  });

  assert.equal(await updateScheduledDraftReadinessDocument(
    draftRef,
    START,
    {
      serverDraftReadinessStatus: 'error',
      serverDraftReadinessProjectionRequestId: null,
      serverDraftReadinessProjectionSnapshotId: null,
      serverDraftReadinessProjectionSnapshotHash: null,
      serverDraftReadinessRetryAfterAt: null,
      serverDraftReadinessMessage:
        'Automatic Draft preparation could not recover within one hour of the scheduled start.',
    },
  ), true);

  const saved = (await draftRef.get()).data();
  assert.equal(saved?.['status'], 'scheduled');
  assert.equal(saved?.['clockStatus'], 'stopped');
  assert.equal(saved?.['nextOverallPick'], 1);
  assert.deepEqual(saved?.['picks'], []);
  assert.equal(saved?.['serverDraftReadinessStatus'], 'error');
});

test('the refresh task is private server authority with bounded retry and concurrency', async () => {
  const [indexSource, utilitySource] = await Promise.all([
    read('functions/src/index.ts'),
    read('functions/src/draft-readiness.util.ts'),
  ]);
  const start = indexSource.indexOf('export const refreshDraftPlayerAvailabilityTask');
  const end = indexSource.indexOf('export const refreshGlobalPlayerAvailabilityScheduled', start);
  const task = indexSource.slice(start, end);
  const payloadStart = utilitySource.indexOf('export interface DraftAvailabilityRefreshTaskPayload');
  const payloadEnd = utilitySource.indexOf('\n}', payloadStart) + 2;
  const payload = utilitySource.slice(payloadStart, payloadEnd);

  assert.ok(start > 0 && end > start);
  assert.match(task, /onTaskDispatched<DraftAvailabilityRefreshTaskPayload>/);
  assert.match(task, /maxAttempts:\s*3/);
  assert.match(task, /maxConcurrentDispatches:\s*1/);
  assert.match(task, /trigger:\s*'draft-readiness-server'/);
  assert.match(task, /result\.status === 'in-progress'/);
  assert.doesNotMatch(task, /onCall|request\.auth|verifyLeagueMembership/);
  assert.doesNotMatch(payload, /leagueId|userId|managerId/);
});

test('same-day error, cooldown, and active lease behavior preserve one refresh authority', async () => {
  const source = await read('functions/src/index.ts');
  const start = source.indexOf('async function runGlobalInjuryRefresh(');
  const end = source.indexOf('export const refreshDraftPlayerAvailabilityTask', start);
  const refresh = source.slice(start, end);

  assert.match(
    refresh,
    /data\?\.\['status'\] === 'running'[\s\S]*?leaseExpires\.getTime\(\) > nowMilliseconds/,
  );
  assert.match(
    refresh,
    /data\?\.\['status'\] === 'error'[\s\S]*?isDraftAvailabilityRefreshInErrorCooldown[\s\S]*?strictDraftTask:\s*requireStrictDraftSource[\s\S]*?!force/,
  );
  assert.match(
    refresh,
    /requireStrictDraftSource[\s\S]*?\? draftReadinessDailySuccess[\s\S]*?: dailySuccess/,
  );
  assert.match(
    refresh,
    /requireStrictDraftSource[\s\S]*?requiredThroughMilliseconds:[\s\S]*?DRAFT_AVAILABILITY_PREPARATION_WINDOW_MILLISECONDS/,
  );
  assert.match(refresh, /leaseExpiresAt:\s*Timestamp\.fromMillis/);
  assert.match(refresh, /evaluateDraftAvailabilitySourceCompleteness/);
  assert.match(refresh, /evaluateDraftAvailabilityIdentityCompleteness/);
  assert.match(refresh, /requireStrictDraftSource && !draftReadinessSourceComplete/);
  assert.match(refresh, /draftReadinessSourceComplete,/);
  assert.match(refresh, /draftReadinessSourceAttemptId:\s*claimId/);
  assert.match(refresh, /draftReadinessNhlRosterIdentityHash/);
  assert.match(refresh, /draftReadinessFailedTaskBucketMilliseconds/);
  assert.match(refresh, /draftReadinessRetryAfterAt/);
  assert.match(refresh, /getDraftAvailabilityErrorBackoffMilliseconds/);
  assert.match(refresh, /sameTaskBucketRetry/);
  assert.match(refresh, /draftReadinessNameNotFoundAdvisoryCount:/);
  assert.doesNotMatch(refresh, /draftReadinessUnresolvedNonRosterCount:/);
  assert.match(source, /isDraftNhlTeamRosterComplete\(rosterCompleteness\)/);
  assert.match(source, /roster failed Draft completeness/);
  assert.match(refresh, /feedLooksCompleteEnoughToClear = draftSourceCompleteness\.complete/);

  const taskStart = source.indexOf('export const refreshDraftPlayerAvailabilityTask');
  const taskEnd = source.indexOf('export const refreshGlobalPlayerAvailabilityScheduled', taskStart);
  const task = source.slice(taskStart, taskEnd);
  assert.match(task, /result\.status === 'in-progress'/);
  assert.match(task, /result\.status === 'cooldown'/);
  assert.match(task, /waiting for its guarded retry time/);
});

test('strict Projection generation uses and recovers the exact attested NHL roster identity set', async () => {
  const [projectionSource, poolSource, nhlSource, indexSource] = await Promise.all([
    read('functions/src/shared/core/projection/projection-snapshot.service.ts'),
    read('functions/src/shared/core/draft/draft-player-pool.service.ts'),
    read('functions/src/shared/core/nhl/nhl-api.service.ts'),
    read('functions/src/index.ts'),
  ]);
  const strictPoolLoad = poolSource.slice(
    poolSource.indexOf('export async function loadDraftPlayerPool('),
    poolSource.indexOf('/*\n   * Load projection seasons', poolSource.indexOf('export async function loadDraftPlayerPool(')),
  );

  assert.match(indexSource, /createDraftNhlRosterIdentityHash\(nhlRosterResult\.skaters\)/);
  assert.match(indexSource, /draftReadinessNhlRosterIdentityHash,/);
  assert.match(
    projectionSource,
    /draftReadinessNhlRosterIdentityHash[\s\S]*?records:\s*orderedRecords/,
  );
  assert.match(
    projectionSource,
    /expectedNhlRosterIdentityHash:[\s\S]*?enforcedAvailabilityRosterIdentityHash/,
  );
  assert.match(
    projectionSource,
    /const enforcedAvailabilityRosterIdentityHash =[\s\S]*?requireCompleteTeamScheduleInput[\s\S]*?projectionContext === 'live'[\s\S]*?draftReadinessNhlRosterIdentityHash[\s\S]*?: null/,
  );
  assert.match(
    projectionSource,
    /availabilityRosterIdentityHash:\s*enforcedAvailabilityRosterIdentityHash/,
  );
  assert.match(
    projectionSource,
    /DraftNhlRosterIdentityMismatchError[\s\S]*?invalidateDraftAvailabilityAttestationForRosterMismatch/,
  );
  assert.ok(
    strictPoolLoad.indexOf('clearCurrentNhlDraftSkaterCache()') <
      strictPoolLoad.indexOf('getCurrentNhlDraftSkaters()'),
  );
  assert.match(
    strictPoolLoad,
    /createDraftNhlRosterIdentityHash\(skaters\)[\s\S]*?DraftNhlRosterIdentityMismatchError/,
  );
  assert.match(nhlSource, /export function clearCurrentNhlDraftSkaterCache/);
});

test('an abandoned stopped Draft reaches a visible finite recovery horizon before enqueue', async () => {
  const source = await read('functions/src/draft-automation.ts');
  const start = source.indexOf('async function scheduleDraftAvailabilityRefreshIfNeeded(');
  const end = source.indexOf('\nfunction buildDraftClockTaskId(', start);
  const schedule = source.slice(start, end);
  const expired = schedule.indexOf("preparationState === 'recovery-expired'");
  const enqueue = schedule.indexOf('getDraftAvailabilityRefreshTaskQueue().enqueue');

  assert.ok(expired > 0 && enqueue > expired);
  assert.match(
    schedule.slice(expired, enqueue),
    /clock remains stopped at zero picks[\s\S]*?commissioner must choose a new start time/,
  );
  assert.match(schedule.slice(expired, enqueue), /return 'recovery-expired'/);
});

test('incomplete availability and Projection evidence still fail closed', async () => {
  const source = await read('functions/src/draft-automation.ts');
  const start = source.indexOf('async function prepareScheduledDraftReadiness(');
  const end = source.indexOf('async function openScheduledDraftIfReady(', start);
  const preparation = source.slice(start, end);
  const waitingStart = preparation.indexOf("serverDraftReadinessStatus: 'waiting-injury'");
  const waiting = preparation.slice(waitingStart, waitingStart + 1_500);

  assert.ok(waitingStart > 0);
  assert.match(waiting, /serverDraftReadinessProjectionRequestId:\s*null/);
  assert.match(waiting, /serverDraftReadinessProjectionSnapshotId:\s*null/);
  assert.match(waiting, /serverDraftReadinessProjectionSnapshotHash:\s*null/);
  assert.doesNotMatch(waiting, /status:\s*'live'|nextOverallPick|pickStartedAt/);
  assert.match(source, /const projection = openingScheduledDraft[\s\S]*?loadPreparedProjectionSnapshotForScheduledDraft/);
  assert.match(source, /if \(!projection\)[\s\S]*?if \(openingScheduledDraft\)[\s\S]*?return false/);

  const projectionSource = await read(
    'functions/src/shared/core/projection/projection-snapshot.service.ts',
  );
  assert.match(
    projectionSource,
    /requireCompleteTeamScheduleInput[\s\S]*?isDraftAvailabilityEvidenceUsable\([\s\S]*?draftReadinessSourceComplete/,
  );
  assert.match(
    projectionSource,
    /Draft availability source is incomplete or no longer current/,
  );
});

test('the source inventory and Draft preflight include the new automatic task', async () => {
  const indexSource = await read('functions/src/index.ts');
  const names = collectExpectedFirebaseFunctionNames(indexSource);

  assert.equal(names.length, 108);
  assert.ok(names.includes('refreshDraftPlayerAvailabilityTask'));
  assert.ok(criticalDraftFunctions.includes('refreshDraftPlayerAvailabilityTask'));
});

test('FF1.31 records narrow deployment, rollback, and protected contracts', async () => {
  const [documentation, handoff, packageSource, scoring, projection] = await Promise.all([
    read('docs/RINKRAT_FF1_15_SERVER_OWNED_DRAFT_INPUT_PREPARATION.md'),
    read('docs/RINKRAT_CODEX_HANDOFF.md'),
    read('package.json'),
    read('functions/src/shared/core/scoring/scoring-rules.ts'),
    read('functions/src/shared/core/projection/projection-v11.util.ts'),
  ]);
  const packageJson = JSON.parse(packageSource);

  for (const value of [
    'Architecture recommendation',
    'Implemented behavior',
    'Acceptance criteria',
    'Edge cases',
    'Tests',
    'Deployment resources',
    'Observability',
    'Rollback',
    'Production Scoring V4',
    'Projection V11',
    'six-game',
    'Game 7',
    'exact-once',
  ]) {
    assert.match(documentation, new RegExp(value, 'i'));
  }

  assert.match(documentation, /functions:refreshDraftPlayerAvailabilityTask/);
  assert.match(documentation, /functions:refreshGlobalPlayerAvailabilityScheduled/);
  assert.match(documentation, /functions:refreshDailyPlayerAvailability/);
  assert.match(documentation, /functions:processProjectionGenerationTask/);
  assert.match(documentation, /functions:executeDraftCommand/);
  assert.match(documentation, /functions:runScheduledDraftAutomation/);
  assert.match(documentation, /functions:continueServerDraftAutomation/);
  assert.match(documentation, /functions:processDraftClockDeadline/);
  assert.match(documentation, /functions:processAutoDraftQueueChange/);
  assert.match(documentation, /hosting:app/);
  assert.doesNotMatch(documentation, /firebase deploy(?!ment)|--only functions\b|--only firestore/);
  const deploymentSection = documentation.slice(
    documentation.indexOf('## Deployment resources'),
    documentation.indexOf('## Observability'),
  );
  const deploymentOrder = [
    'functions:refreshDraftPlayerAvailabilityTask',
    'functions:refreshGlobalPlayerAvailabilityScheduled',
    'functions:refreshDailyPlayerAvailability',
    'functions:processProjectionGenerationTask',
    'functions:executeDraftCommand',
    'functions:processDraftClockDeadline',
    'functions:processAutoDraftQueueChange',
    'functions:continueServerDraftAutomation',
    'functions:runScheduledDraftAutomation',
    'hosting:app',
  ].map((resource) => deploymentSection.indexOf(resource));
  assert.ok(deploymentOrder.every((index) => index >= 0));
  assert.deepEqual(deploymentOrder, [...deploymentOrder].sort((a, b) => a - b));
  assert.match(deploymentSection, /not.*Draft is live|Draft is live.*not/is);
  assert.match(deploymentSection, /scheduled to start within\s+30 minutes/i);
  assert.match(handoff, /FF1\.31/);
  assert.equal(
    packageJson.scripts['verify:batchff1-15:core'],
    'npm run verify:batchff1-14:core && npm run test:batchff1-15 && npm run validate:release-manifest',
  );
  assert.match(packageJson.scripts['test:batchff1-15'], /emulators:exec/);
  assert.equal(
    createHash('sha256').update(scoring).digest('hex'),
    '74107aa688b4a3825c52fe14003cd824485197fd3559822fab4134bff940e2da',
  );
  assert.equal(
    createHash('sha256').update(projection).digest('hex'),
    'e6f3111b1feccc7107e857aa24c5317451c65a84a36c71f8158947636f20d80a',
  );
});
