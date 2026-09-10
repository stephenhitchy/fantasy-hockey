import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertExistingFf1SixClientFixtureSafety,
  assertFf1SixClientDraftInventory,
  assertFf1SixClientExcludedRuntimeAbsent,
  assertFf1SixClientCompletedRoster,
  assertFf1SixClientFunctionTopology,
  assertFf1SixClientFixtureRunOwnership,
  assertFf1SixClientGuardedRuntimeProvenance,
  assertFf1SixClientHistoricalReplayRequestsQuiet,
  assertFf1SixClientLeagueAutomationQueueConfig,
  assertFf1SixClientMergedToolingRevision,
  assertFf1SixClientPackageDelta,
  assertFf1SixClientPickHandoffEvidence,
  assertFf1SixClientProjectionRequest,
  assertFf1SixClientRetainedFixtureSafe,
  assertFf1SixClientRetainedV1FixturePresent,
  assertFf1SixClientScheduledStartTaskProvenance,
  assertFf1SixClientSchedulerTopology,
  assertFf1SixClientStagingSafety,
  assertFf1SixClientSupportingAuthoritySafety,
  assertFf1SixClientTeamAuthority,
  assertFf1SixClientToolingPaths,
  assertFf1SixClientTaskQueueTopology,
  assertFf1SixClientTriggerRequestLogs,
  assertFf1SixClientWindowProjectionAuthority,
  assertOnlyFf1SixClientScheduledStartTask,
  buildFf1SixClientAvailabilityRevision,
  buildFf1SixClientDraftPickHandoffCorrelationHash,
  buildFf1SixClientScheduledDraftStartTaskId,
  buildPublicFf1SixClientEvidence,
  canReleaseFf1SixClientEvidenceLock,
  Ff1SixClientPublicEvidenceError,
  FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
  FF1_SIX_CLIENT_FIXTURE_INVITE_CODE,
  FF1_SIX_CLIENT_FIXTURE_TYPE,
  FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT,
  FF1_SIX_CLIENT_FORBIDDEN_SHARED_FUNCTIONS,
  FF1_SIX_CLIENT_FORBIDDEN_SHARED_SCHEDULER_JOBS,
  FF1_SIX_CLIENT_FUNCTION_TOPOLOGY,
  FF1_SIX_CLIENT_GUARDED_RUNTIME_SOURCE_HASHES,
  FF1_SIX_CLIENT_MANAGER_COUNT,
  FF1_SIX_CLIENT_MINIMUM_GUARDED_RUNTIME_REVISION,
  FF1_SIX_CLIENT_STAGING_ACKNOWLEDGEMENT,
  FF1_SIX_CLIENT_STAGING_MAINTENANCE_ACKNOWLEDGEMENT,
  FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS,
  FF1_SIX_CLIENT_SCHEDULER_TOPOLOGY,
  FF1_SIX_CLIENT_TOTAL_PICKS,
  FF1_SIX_CLIENT_TASK_QUEUE_TOPOLOGY,
  runFf1SixClientDraftRehearsalCli,
  selectExpectedEmptyQueueStarterCandidate,
  assertFf1SixClientRetainedV1BoundaryStable,
  verifyFf1SixClientFirestoreRules,
} from '../../scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const STAGING_PROJECT_ID = 'rinkrat-staging-d1nc-2026';
const RELEASE_REVISION = 'a'.repeat(40);
const TASK_SERVICE_ACCOUNT =
  '817415114086-compute@developer.gserviceaccount.com';
assert.equal(TASK_SERVICE_ACCOUNT, FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT);
const FIXTURE_RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIXTURE_MANAGER_IDS = Array.from(
  { length: FF1_SIX_CLIENT_MANAGER_COUNT },
  (_, index) => `ff1-six-client-aaaaaaaaaaaa-manager-${index + 1}`,
);
const EXPECTED_PACKAGE_SCRIPTS = Object.freeze({
  'staging:ff1:exercise-server-preparation':
    'node --no-warnings --experimental-strip-types scripts/capacity/run-ff132-server-owned-draft-preparation-staging-evidence.mjs',
  'staging:ff1:exercise-six-client':
    'node --no-warnings --experimental-strip-types scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs',
  'test:batchff1-16:run':
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchff1-16-server-owned-draft-preparation-staging/*.test.mjs',
  'verify:batchff1-16:core':
    'npm run verify:batchff1-15:core && npm run test:batchff1-16:run && npm run validate:release-manifest',
  'verify:batchff1-16':
    'npm run toolchain:verify && npm run verify:batchff1-16:core && npm run security:dependency-audit',
  'pretest:batchff1-17:run': 'npm --prefix functions run build',
  'test:batchff1-17:run':
    'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchff1-17-historical-replay-lease-guard/*.test.mjs',
  'test:batchff1-17':
    'firebase emulators:exec --project demo-rinkrat-ff1-17 --only firestore "npm run test:batchff1-17:run"',
  'verify:batchff1-17:core':
    'npm run verify:batchff1-16:core && npm run test:batchff1-17 && npm run validate:release-manifest',
  'verify:batchff1-17':
    'npm run toolchain:verify && npm run verify:batchff1-17:core && npm run security:dependency-audit',
});

function validEnvironment(overrides = {}) {
  return {
    FF1_SIX_CLIENT_STAGING_PROJECT_ID: STAGING_PROJECT_ID,
    FF1_SIX_CLIENT_STAGING_ACK: FF1_SIX_CLIENT_STAGING_ACKNOWLEDGEMENT,
    FF1_SIX_CLIENT_STAGING_MAINTENANCE_ACK:
      FF1_SIX_CLIENT_STAGING_MAINTENANCE_ACKNOWLEDGEMENT,
    FF1_SIX_CLIENT_DEPLOYED_RELEASE_REVISION: RELEASE_REVISION,
    ...overrides,
  };
}

function functionTopologyEntry(name) {
  const expected = FF1_SIX_CLIENT_FUNCTION_TOPOLOGY[name];
  const labels = {
    'deployment-tool': 'cli-firebase',
    'firebase-functions-hash': 'f'.repeat(40),
  };
  if (expected.kind === 'callable') {
    labels['deployment-callable'] = 'true';
  } else if (expected.kind === 'schedule') {
    labels['deployment-scheduled'] = 'true';
  } else if (expected.kind === 'task') {
    labels['deployment-taskqueue'] = 'true';
  }
  const serviceConfig = {
    timeoutSeconds: expected.timeoutSeconds,
    availableMemory: `${expected.memoryMiB}Mi`,
    maxInstanceRequestConcurrency: expected.concurrency ?? 80,
    serviceAccountEmail: TASK_SERVICE_ACCOUNT,
    environmentVariables: {
      FUNCTION_TARGET: name,
      ...(expected.kind === 'firestore'
        ? { FUNCTION_SIGNATURE_TYPE: 'cloudevent' }
        : expected.kind === 'callable'
          ? { FUNCTION_SIGNATURE_TYPE: 'http' }
          : {}),
    },
  };
  if (expected.maxInstances !== null) {
    serviceConfig.maxInstanceCount = expected.maxInstances;
  }
  const entry = {
    name: `projects/${STAGING_PROJECT_ID}/locations/us-central1/functions/${name}`,
    labels,
    buildConfig: {
      serviceAccount:
        `projects/${STAGING_PROJECT_ID}/serviceAccounts/${TASK_SERVICE_ACCOUNT}`,
    },
    serviceConfig,
  };
  if (expected.kind === 'firestore') {
    entry.eventTrigger = {
      eventType: `google.cloud.firestore.document.v1.${expected.event}`,
      eventFilters: [
        {
          attribute: 'document',
          operator: 'match-path-pattern',
          value: expected.document,
        },
        { attribute: 'database', value: '(default)' },
        { attribute: 'namespace', value: '(default)' },
      ],
      retryPolicy: expected.retry
        ? 'RETRY_POLICY_RETRY'
        : 'RETRY_POLICY_DO_NOT_RETRY',
      serviceAccountEmail: TASK_SERVICE_ACCOUNT,
      trigger:
        `projects/${STAGING_PROJECT_ID}/locations/us-west4/triggers/` +
        `${name.toLowerCase()}-123456`,
      triggerRegion: 'us-west4',
      pubsubTopic:
        `projects/${STAGING_PROJECT_ID}/topics/eventarc-us-west4-` +
        `${name.toLowerCase()}-123456-789`,
    };
  }
  return entry;
}

function schedulerTopologyJob(name) {
  const expected = FF1_SIX_CLIENT_SCHEDULER_TOPOLOGY[name];
  const uri = `https://${name.toLowerCase()}-example-uc.a.run.app/`;
  return {
    name:
      `projects/${STAGING_PROJECT_ID}/locations/us-central1/jobs/` +
      `firebase-schedule-${name}-us-central1`,
    state: 'ENABLED',
    schedule: expected.schedule,
    timeZone: expected.timeZone,
    attemptDeadline: `${FF1_SIX_CLIENT_FUNCTION_TOPOLOGY[name].timeoutSeconds}s`,
    httpTarget: {
      httpMethod: 'POST',
      uri,
      oidcToken: { audience: uri, serviceAccountEmail: TASK_SERVICE_ACCOUNT },
    },
    retryConfig: {
      retryCount: expected.retryCount,
      maxRetryDuration: '0s',
      minBackoffDuration: '5s',
      maxBackoffDuration: '3600s',
      maxDoublings: 5,
    },
    status: {},
  };
}

function taskQueueTopologyEntry(name) {
  const expected = FF1_SIX_CLIENT_TASK_QUEUE_TOPOLOGY[name];
  return {
    name: `projects/${STAGING_PROJECT_ID}/locations/us-central1/queues/${name}`,
    state: 'RUNNING',
    rateLimits: {
      maxBurstSize: 100,
      maxConcurrentDispatches: expected.maxConcurrentDispatches,
      maxDispatchesPerSecond: 500,
    },
    retryConfig: {
      maxAttempts: expected.maxAttempts,
      minBackoff: expected.minBackoff,
      maxBackoff: expected.maxBackoff,
      maxDoublings: expected.maxDoublings,
    },
  };
}

function pickHandoffEventId(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function pickHandoffRequestEntry(deployedFunction, timestamp, eventId) {
  return {
    timestamp,
    resource: {
      type: 'cloud_run_revision',
      labels: {
        project_id: STAGING_PROJECT_ID,
        location: 'us-central1',
        service_name: deployedFunction.serviceName,
        revision_name: deployedFunction.revision,
      },
    },
    labels: {
      'firebase-functions-hash': deployedFunction.sourceHash,
      'run.googleapis.com/cloud_event_id': eventId,
      'run.googleapis.com/cloud_event_source':
        `//firestore.googleapis.com/projects/${STAGING_PROJECT_ID}/databases/(default)`,
    },
    httpRequest: {
      requestMethod: 'POST',
      requestUrl:
        `${deployedFunction.uri}/?__GCP_CloudEventsMode=CE_PUBSUB_BINDING`,
      status: 204,
    },
  };
}

function pickHandoffMarkerEntry({
  deployedFunction,
  timestamp,
  eventId,
  pickId,
}) {
  const finalPick = Number(pickId) === FF1_SIX_CLIENT_TOTAL_PICKS;
  return {
    timestamp,
    severity: 'INFO',
    resource: {
      type: 'cloud_run_revision',
      labels: {
        project_id: STAGING_PROJECT_ID,
        location: 'us-central1',
        service_name: deployedFunction.serviceName,
        revision_name: deployedFunction.revision,
      },
    },
    labels: {
      'firebase-functions-hash': deployedFunction.sourceHash,
    },
    jsonPayload: {
      message: 'Committed Draft pick handoff reconciled.',
      eventId,
      draftPickCorrelationHash:
        buildFf1SixClientDraftPickHandoffCorrelationHash(pickId),
      draftStatus: finalPick ? 'complete' : 'live',
      nextDeadlineScheduled: !finalPick,
    },
  };
}

test('the six-client runner is hard-locked to the isolated billed staging project', () => {
  const safety = assertFf1SixClientStagingSafety(validEnvironment());

  assert.equal(safety.deployedReleaseRevision, RELEASE_REVISION);
  assert.equal(safety.readinessTimeoutMilliseconds, 1_200_000);
  assert.throws(
    () => assertFf1SixClientStagingSafety(validEnvironment({
      FF1_SIX_CLIENT_STAGING_PROJECT_ID: 'nhl-fantasy-app-ab673',
    })),
    /must equal rinkrat-staging-d1nc-2026/,
  );
  assert.throws(
    () => assertFf1SixClientStagingSafety(validEnvironment({
      FF1_SIX_CLIENT_STAGING_ACK: 'yes',
    })),
    /does not authorize/,
  );
  assert.throws(
    () => assertFf1SixClientStagingSafety(validEnvironment({
      FF1_SIX_CLIENT_STAGING_MAINTENANCE_ACK: 'yes',
    })),
    /does not reserve the shared staging window/,
  );
  assert.throws(
    () => assertFf1SixClientStagingSafety(validEnvironment({
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    })),
    /refuses every Emulator Suite environment/,
  );
  assert.throws(
    () => assertFf1SixClientStagingSafety(validEnvironment({
      FF1_SIX_CLIENT_DEPLOYED_RELEASE_REVISION: 'main',
    })),
    /full Git revision/,
  );
});

test('all required Functions, Scheduler jobs, and task queues have exact protected topology', () => {
  const functionEntries = FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.map(
    functionTopologyEntry,
  );
  assert.equal(assertFf1SixClientFunctionTopology(functionEntries), true);
  const binaryMemoryUnit = structuredClone(functionEntries);
  binaryMemoryUnit
    .find((entry) => entry.name.endsWith('/processProjectionGenerationTask'))
    .serviceConfig.availableMemory = '2Gi';
  assert.equal(assertFf1SixClientFunctionTopology(binaryMemoryUnit), true);
  const callableWithImplicitHttpSignature = structuredClone(functionEntries);
  delete callableWithImplicitHttpSignature
    .find((entry) => entry.name.endsWith('/refreshDailyPlayerAvailability'))
    .serviceConfig.environmentVariables.FUNCTION_SIGNATURE_TYPE;
  assert.equal(
    assertFf1SixClientFunctionTopology(callableWithImplicitHttpSignature),
    true,
  );

  const wrongEventPath = structuredClone(functionEntries);
  wrongEventPath
    .find((entry) => entry.name.endsWith('/initializeSeasonAfterDraft'))
    .eventTrigger.eventFilters[0].value = 'leagues/{leagueId}/draft/wrong';
  assert.throws(() => assertFf1SixClientFunctionTopology(wrongEventPath));
  const wrongRetry = structuredClone(functionEntries);
  wrongRetry
    .find((entry) => entry.name.endsWith('/reconcileDraftTurnAfterCommittedPick'))
    .eventTrigger.retryPolicy = 'RETRY_POLICY_DO_NOT_RETRY';
  assert.throws(() => assertFf1SixClientFunctionTopology(wrongRetry));
  const wrongWorkerLimit = structuredClone(functionEntries);
  wrongWorkerLimit
    .find((entry) => entry.name.endsWith('/processDraftClockDeadline'))
    .serviceConfig.maxInstanceCount = 21;
  assert.throws(
    () => assertFf1SixClientFunctionTopology(wrongWorkerLimit),
    /protected max-instance ceiling/,
  );
  const wrongMarker = structuredClone(functionEntries);
  wrongMarker
    .find((entry) => entry.name.endsWith('/executeDraftCommand'))
    .labels['deployment-taskqueue'] = 'true';
  assert.throws(
    () => assertFf1SixClientFunctionTopology(wrongMarker),
    /trigger marker/,
  );
  const collusiveWrongServiceIdentity = structuredClone(functionEntries);
  const wrongIdentityEntry = collusiveWrongServiceIdentity.find((entry) =>
    entry.name.endsWith('/initializeSeasonAfterDraft'));
  const alternateServiceAccount =
    'alternate-runtime@rinkrat-staging-d1nc-2026.iam.gserviceaccount.com';
  wrongIdentityEntry.serviceConfig.serviceAccountEmail = alternateServiceAccount;
  wrongIdentityEntry.buildConfig.serviceAccount =
    `projects/${STAGING_PROJECT_ID}/serviceAccounts/${alternateServiceAccount}`;
  wrongIdentityEntry.eventTrigger.serviceAccountEmail = alternateServiceAccount;
  assert.throws(
    () => assertFf1SixClientFunctionTopology(collusiveWrongServiceIdentity),
    /reviewed runtime service identity/,
  );

  const deployedFunctions = Object.keys(FF1_SIX_CLIENT_SCHEDULER_TOPOLOGY).map(
    (name) => ({
      name,
      serviceAccountEmail: TASK_SERVICE_ACCOUNT,
      uri: `https://${name.toLowerCase()}-example-uc.a.run.app/`,
    }),
  );
  const schedulerJobs = Object.keys(FF1_SIX_CLIENT_SCHEDULER_TOPOLOGY).map(
    schedulerTopologyJob,
  );
  assert.equal(
    assertFf1SixClientSchedulerTopology(schedulerJobs, deployedFunctions),
    true,
  );
  const wrongSchedulerTarget = structuredClone(schedulerJobs);
  wrongSchedulerTarget[0].httpTarget.uri = 'https://unverified.example.invalid/';
  wrongSchedulerTarget[0].httpTarget.oidcToken.audience =
    'https://unverified.example.invalid/';
  assert.throws(
    () => assertFf1SixClientSchedulerTopology(
      wrongSchedulerTarget,
      deployedFunctions,
    ),
    /unverified endpoint/,
  );
  const wrongSchedulerIdentity = structuredClone(schedulerJobs);
  wrongSchedulerIdentity[0].httpTarget.oidcToken.serviceAccountEmail =
    'alternate-scheduler@rinkrat-staging-d1nc-2026.iam.gserviceaccount.com';
  assert.throws(
    () => assertFf1SixClientSchedulerTopology(
      wrongSchedulerIdentity,
      deployedFunctions,
    ),
    /reviewed Scheduler service identity/,
  );

  const queues = Object.keys(FF1_SIX_CLIENT_TASK_QUEUE_TOPOLOGY).map(
    taskQueueTopologyEntry,
  );
  assert.equal(assertFf1SixClientTaskQueueTopology(queues), true);
  const wrongQueueConcurrency = structuredClone(queues);
  wrongQueueConcurrency[0].rateLimits.maxConcurrentDispatches += 1;
  assert.throws(() => assertFf1SixClientTaskQueueTopology(wrongQueueConcurrency));
  const wrongQueueRetry = structuredClone(queues);
  wrongQueueRetry[0].retryConfig.maxAttempts += 1;
  assert.throws(() => assertFf1SixClientTaskQueueTopology(wrongQueueRetry));
  const wrongReplayQueueConcurrency = structuredClone(queues);
  wrongReplayQueueConcurrency
    .find((queue) => queue.name.endsWith('/processHistoricalReplayAdvance'))
    .rateLimits.maxConcurrentDispatches = 2;
  assert.throws(
    () => assertFf1SixClientTaskQueueTopology(wrongReplayQueueConcurrency),
  );
  assert.equal(queues.length, 5);

  assert.equal(
    assertFf1SixClientExcludedRuntimeAbsent(functionEntries, schedulerJobs),
    true,
  );
  for (const name of FF1_SIX_CLIENT_FORBIDDEN_SHARED_FUNCTIONS) {
    assert.throws(
      () => assertFf1SixClientExcludedRuntimeAbsent(
        [...functionEntries, {
          name: `projects/${STAGING_PROJECT_ID}/locations/us-central1/functions/${name}`,
        }],
        schedulerJobs,
      ),
      new RegExp(`${name} must be absent`),
    );
  }
  for (const name of FF1_SIX_CLIENT_FORBIDDEN_SHARED_SCHEDULER_JOBS) {
    assert.throws(
      () => assertFf1SixClientExcludedRuntimeAbsent(
        functionEntries,
        [...schedulerJobs, {
          name: `projects/${STAGING_PROJECT_ID}/locations/us-central1/jobs/${name}`,
        }],
      ),
      new RegExp(`${name} must be absent`),
    );
  }
});

test('trigger evidence accepts only successful POSTs to the exact deployed revision', () => {
  const minimumTimestamp = Date.parse('2026-09-09T10:00:00.000Z');
  const maximumTimestamp = minimumTimestamp + 60_000;
  const deployedFunction = {
    name: 'reconcileDraftTurnAfterCommittedPick',
    serviceName: 'reconciledraftturnaftercommittedpick',
    revision: 'reconciledraftturnaftercommittedpick-00001-abc',
    sourceHash: 'f'.repeat(40),
    uri: 'https://reconciledraftturnaftercommittedpick-example-uc.a.run.app',
  };
  const successfulRequest = {
    timestamp: new Date(minimumTimestamp + 1_000).toISOString(),
    resource: {
      type: 'cloud_run_revision',
      labels: {
        project_id: STAGING_PROJECT_ID,
        location: 'us-central1',
        service_name: deployedFunction.serviceName,
        revision_name: deployedFunction.revision,
      },
    },
    labels: {
      'firebase-functions-hash': deployedFunction.sourceHash,
      'run.googleapis.com/cloud_event_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'run.googleapis.com/cloud_event_source':
        `//firestore.googleapis.com/projects/${STAGING_PROJECT_ID}/databases/(default)`,
    },
    httpRequest: {
      requestMethod: 'POST',
      requestUrl:
        `${deployedFunction.uri}/?__GCP_CloudEventsMode=CE_PUBSUB_BINDING`,
      status: 204,
    },
  };
  const secondSuccessfulRequest = structuredClone(successfulRequest);
  secondSuccessfulRequest.labels['run.googleapis.com/cloud_event_id'] =
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  assert.equal(assertFf1SixClientTriggerRequestLogs(
    [successfulRequest, secondSuccessfulRequest],
    {
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
      minimumSuccessfulRequests: 2,
    },
  ), 2);
  assert.throws(() => assertFf1SixClientTriggerRequestLogs(
    [successfulRequest, structuredClone(successfulRequest)],
    {
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
      minimumSuccessfulRequests: 2,
    },
  ), /too few successful trigger deliveries/);

  for (const mutate of [
    (entry) => { entry.resource.labels.project_id = 'nhl-fantasy-app-ab673'; },
    (entry) => { entry.resource.labels.revision_name = 'wrong-00001-abc'; },
    (entry) => { entry.labels['firebase-functions-hash'] = 'e'.repeat(40); },
    (entry) => { delete entry.labels['run.googleapis.com/cloud_event_id']; },
    (entry) => { entry.labels['run.googleapis.com/cloud_event_source'] = '//other'; },
    (entry) => { entry.httpRequest.requestMethod = 'GET'; },
    (entry) => { entry.httpRequest.requestUrl = `${deployedFunction.uri}/`; },
    (entry) => { entry.httpRequest.status = 500; },
    (entry) => { entry.timestamp = new Date(maximumTimestamp + 1).toISOString(); },
  ]) {
    const changed = structuredClone(successfulRequest);
    mutate(changed);
    assert.throws(() => assertFf1SixClientTriggerRequestLogs([changed], {
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
      minimumSuccessfulRequests: 1,
    }), /too few successful trigger deliveries/);
  }
});

test('every committed pick requires its exact privacy-safe handoff marker', () => {
  const minimumTimestamp = Date.parse('2026-09-09T10:00:00.000Z');
  const maximumTimestamp = minimumTimestamp + 60_000;
  const deployedFunction = {
    name: 'reconcileDraftTurnAfterCommittedPick',
    serviceName: 'reconciledraftturnaftercommittedpick',
    revision: 'reconciledraftturnaftercommittedpick-00001-abc',
    sourceHash: 'f'.repeat(40),
    uri: 'https://reconciledraftturnaftercommittedpick-example-uc.a.run.app',
  };
  const expectedPickIds = Array.from(
    { length: FF1_SIX_CLIENT_TOTAL_PICKS },
    (_, index) => String(index + 1).padStart(3, '0'),
  );
  const requests = expectedPickIds.map((pickId, index) =>
    pickHandoffRequestEntry(
      deployedFunction,
      new Date(minimumTimestamp + index + 1).toISOString(),
      pickHandoffEventId(index + 1),
    ));
  const markers = expectedPickIds.map((pickId, index) =>
    pickHandoffMarkerEntry({
      deployedFunction,
      timestamp: new Date(minimumTimestamp + index + 1).toISOString(),
      eventId: pickHandoffEventId(index + 1),
      pickId,
    }));

  assert.deepEqual(
    assertFf1SixClientPickHandoffEvidence(requests, markers, {
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
      expectedPickIds,
    }),
    {
      successfulRequestCount: FF1_SIX_CLIENT_TOTAL_PICKS,
      markerCount: FF1_SIX_CLIENT_TOTAL_PICKS,
      duplicateMarkerCount: 0,
    },
  );

  assert.deepEqual(
    assertFf1SixClientPickHandoffEvidence(
      requests,
      [...markers, structuredClone(markers[0])],
      {
        deployedFunction,
        minimumTimestamp,
        maximumTimestamp,
        expectedPickIds,
      },
    ),
    {
      successfulRequestCount: FF1_SIX_CLIENT_TOTAL_PICKS,
      markerCount: FF1_SIX_CLIENT_TOTAL_PICKS,
      duplicateMarkerCount: 1,
    },
    'At-least-once delivery may repeat an identical marker.',
  );

  const delayedCompleteDuplicate = structuredClone(markers[0]);
  delayedCompleteDuplicate.jsonPayload.draftStatus = 'complete';
  delayedCompleteDuplicate.jsonPayload.nextDeadlineScheduled = false;
  assert.equal(
    assertFf1SixClientPickHandoffEvidence(
      requests,
      [...markers, delayedCompleteDuplicate],
      {
        deployedFunction,
        minimumTimestamp,
        maximumTimestamp,
        expectedPickIds,
      },
    ).duplicateMarkerCount,
    1,
    'A delayed duplicate may observe the same pick after the Draft completed.',
  );

  assert.throws(() => assertFf1SixClientPickHandoffEvidence(
    requests,
    markers.slice(1),
    {
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
      expectedPickIds,
    },
  ), /did not emit a successful marker for every committed pick/);

  const changedDuplicate = structuredClone(markers[0]);
  changedDuplicate.jsonPayload.nextDeadlineScheduled = false;
  assert.throws(() => assertFf1SixClientPickHandoffEvidence(
    requests,
    [...markers, changedDuplicate],
    {
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
      expectedPickIds,
    },
  ), /incoherent Draft\/deadline outcome/);

  const differentEventDuplicate = structuredClone(markers[0]);
  differentEventDuplicate.jsonPayload.eventId = pickHandoffEventId(999);
  const differentEventRequest = pickHandoffRequestEntry(
    deployedFunction,
    differentEventDuplicate.timestamp,
    differentEventDuplicate.jsonPayload.eventId,
  );
  assert.throws(() => assertFf1SixClientPickHandoffEvidence(
    [...requests, differentEventRequest],
    [...markers, differentEventDuplicate],
    {
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
      expectedPickIds,
    },
  ), /claimed by different trigger events/);

  const unexpectedMarker = structuredClone(markers[0]);
  unexpectedMarker.jsonPayload.draftPickCorrelationHash = '0'.repeat(64);
  assert.throws(() => assertFf1SixClientPickHandoffEvidence(
    requests,
    [...markers.slice(1), unexpectedMarker],
    {
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
      expectedPickIds,
    },
  ), /outside the fixture Draft/);

  assert.throws(() => assertFf1SixClientPickHandoffEvidence(
    requests.slice(1),
    markers,
    {
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
      expectedPickIds,
    },
  ), /no successful exact-revision trigger request/);

  for (const mutate of [
    (entry) => { entry.resource.labels.revision_name = 'wrong-00001-abc'; },
    (entry) => { entry.severity = 'ERROR'; },
    (entry) => { entry.timestamp = new Date(maximumTimestamp + 1).toISOString(); },
  ]) {
    const changedMarker = structuredClone(markers[0]);
    mutate(changedMarker);
    assert.throws(() => assertFf1SixClientPickHandoffEvidence(
      requests,
      [changedMarker, ...markers.slice(1)],
      {
        deployedFunction,
        minimumTimestamp,
        maximumTimestamp,
        expectedPickIds,
      },
    ), /did not emit a successful marker for every committed pick/);
  }
});

test('existing fixture diagnosis accepts only the exact bounded run-scoped identity', () => {
  assert.doesNotThrow(() => assertExistingFf1SixClientFixtureSafety({
    exists: false,
    data: undefined,
    pickCount: 0,
  }));
  assert.doesNotThrow(() => assertExistingFf1SixClientFixtureSafety({
    exists: true,
    data: {
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      name: 'FF1 Six-Client Draft Rehearsal',
      maxTeams: FF1_SIX_CLIENT_MANAGER_COUNT,
      teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
      fixtureRunId: FIXTURE_RUN_ID,
    },
    pickCount: FF1_SIX_CLIENT_TOTAL_PICKS,
    draft: {
      status: 'complete',
      roundOneOrder: FIXTURE_MANAGER_IDS,
      fixtureRunId: FIXTURE_RUN_ID,
    },
  }));
  assert.throws(() => assertExistingFf1SixClientFixtureSafety({
    exists: true,
    data: {
      fixtureType: 'family-league',
      id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      name: 'FF1 Six-Client Draft Rehearsal',
      maxTeams: FF1_SIX_CLIENT_MANAGER_COUNT,
      teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
    },
    pickCount: 0,
    draft: { status: 'setup', roundOneOrder: FIXTURE_MANAGER_IDS },
  }));
  assert.throws(() => assertExistingFf1SixClientFixtureSafety({
    exists: true,
    data: {
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      name: 'FF1 Six-Client Draft Rehearsal',
      maxTeams: FF1_SIX_CLIENT_MANAGER_COUNT,
      teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
      fixtureRunId: FIXTURE_RUN_ID,
    },
    pickCount: FF1_SIX_CLIENT_TOTAL_PICKS + 1,
    draft: {
      status: 'complete',
      roundOneOrder: FIXTURE_MANAGER_IDS,
      fixtureRunId: FIXTURE_RUN_ID,
    },
  }), /more Draft picks/);
  assert.throws(() => assertExistingFf1SixClientFixtureSafety({
    exists: true,
    data: {
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      name: 'FF1 Six-Client Draft Rehearsal',
      maxTeams: FF1_SIX_CLIENT_MANAGER_COUNT,
      teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
      fixtureRunId: FIXTURE_RUN_ID,
    },
    pickCount: 0,
    draft: {
      status: 'scheduled',
      roundOneOrder: FIXTURE_MANAGER_IDS,
      fixtureRunId: FIXTURE_RUN_ID,
    },
  }), /still scheduled or live/);
});

test('tooling delta allows only reviewed evidence files and package scripts', () => {
  const allowedPaths = [
    'docs/RINKRAT_CODEX_HANDOFF.md',
    'docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md',
    'docs/RINKRAT_FF1_32_SERVER_OWNED_DRAFT_PREPARATION_STAGING.md',
    'package.json',
    'scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs',
    'scripts/capacity/run-ff132-server-owned-draft-preparation-staging-evidence.mjs',
    'test/batchff1-13-six-client-rehearsal/six-client-rehearsal.test.mjs',
  ];
  for (const path of allowedPaths) {
    assert.doesNotThrow(() => assertFf1SixClientToolingPaths([path]));
  }
  for (const path of [
    'functions/src/index.ts',
    'functions/package.json',
    'functions/package-lock.json',
    'package-lock.json',
    'firebase.json',
    '.firebaserc',
    'firestore.rules',
    'firestore.indexes.json',
    'src/app/app.ts',
    'scripts/release/verify-clean-deploy-source.mjs',
  ]) {
    assert.throws(
      () => assertFf1SixClientToolingPaths([path]),
      /runtime or deployment-input changes/,
    );
  }

  const baseline = {
    name: 'rinkrat',
    dependencies: { angular: '22.0.0' },
    scripts: { build: 'ng build', old: 'same' },
  };
  const tooling = {
    ...baseline,
    scripts: { ...baseline.scripts, ...EXPECTED_PACKAGE_SCRIPTS },
  };
  assert.deepEqual(
    new Set(assertFf1SixClientPackageDelta(baseline, tooling)),
    new Set(Object.keys(EXPECTED_PACKAGE_SCRIPTS)),
  );
  assert.throws(
    () => assertFf1SixClientPackageDelta(baseline, {
      ...baseline,
      dependencies: { angular: '23.0.0' },
    }),
    /dependencies/,
  );
  assert.throws(
    () => assertFf1SixClientPackageDelta(baseline, {
      ...tooling,
      scripts: { ...tooling.scripts, build: 'skip-build' },
    }),
    /unreviewed package script/,
  );
  assert.throws(
    () => assertFf1SixClientPackageDelta(baseline, {
      ...tooling,
      scripts: {
        ...tooling.scripts,
        'staging:ff1:exercise-six-client': 'node destructive-command.mjs',
      },
    }),
    /exact expected value/,
  );
  const missingScript = structuredClone(tooling);
  delete missingScript.scripts['verify:batchff1-16'];
  assert.throws(
    () => assertFf1SixClientPackageDelta(baseline, missingScript),
    /exact expected value/,
  );
  assert.equal(assertFf1SixClientMergedToolingRevision({
    branch: 'main',
    toolingRevision: RELEASE_REVISION,
    originMainRevision: RELEASE_REVISION,
  }), RELEASE_REVISION);
  assert.throws(() => assertFf1SixClientMergedToolingRevision({
    branch: 'codex/unmerged',
    toolingRevision: RELEASE_REVISION,
    originMainRevision: RELEASE_REVISION,
  }), /merged main/);
  assert.throws(() => assertFf1SixClientMergedToolingRevision({
    branch: 'main',
    toolingRevision: RELEASE_REVISION,
    originMainRevision: 'b'.repeat(40),
  }), /exact pushed origin\/main/);
});

test('the declared runtime must contain the exact reviewed FF1.33 guard source', () => {
  assert.equal(assertFf1SixClientGuardedRuntimeProvenance({
    deployedReleaseRevision: FF1_SIX_CLIENT_MINIMUM_GUARDED_RUNTIME_REVISION,
    guardIsAncestor: true,
    guardedSourceHashes: FF1_SIX_CLIENT_GUARDED_RUNTIME_SOURCE_HASHES,
  }), true);
  assert.throws(() => assertFf1SixClientGuardedRuntimeProvenance({
    deployedReleaseRevision: RELEASE_REVISION,
    guardIsAncestor: false,
    guardedSourceHashes: FF1_SIX_CLIENT_GUARDED_RUNTIME_SOURCE_HASHES,
  }), /does not contain the reviewed FF1\.33/);
  assert.throws(() => assertFf1SixClientGuardedRuntimeProvenance({
    deployedReleaseRevision: RELEASE_REVISION,
    guardIsAncestor: true,
    guardedSourceHashes: {
      ...FF1_SIX_CLIENT_GUARDED_RUNTIME_SOURCE_HASHES,
      'functions/src/draft-automation.ts': '0'.repeat(64),
    },
  }), /changed the reviewed FF1\.33 guard or Draft marker source/);
});

test('the active staging Rules source must exactly match the deployed revision', async () => {
  const expectedRulesSource = 'rules_version = \'2\';\nservice cloud.firestore {}\n';
  const releaseName = `projects/${STAGING_PROJECT_ID}/releases/cloud.firestore`;
  const rulesetName = `projects/${STAGING_PROJECT_ID}/rulesets/ruleset_123`;
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/releases/cloud.firestore')
      ? {
          ok: true,
          json: async () => ({ name: releaseName, rulesetName }),
        }
      : {
          ok: true,
          json: async () => ({
            name: rulesetName,
            source: { files: [{ name: 'firestore.rules', content: expectedRulesSource }] },
          }),
        };
  };
  const evidence = await verifyFf1SixClientFirestoreRules(RELEASE_REVISION, {
    accessToken: 'test-access-token',
    expectedRulesSource,
    fetchImplementation,
  });

  assert.equal(evidence.releaseName, releaseName);
  assert.equal(evidence.rulesetName, rulesetName);
  assert.equal(
    evidence.sourceHash,
    createHash('sha256').update(expectedRulesSource).digest('hex'),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) =>
    call.options.headers.Authorization === 'Bearer test-access-token'), true);
  await assert.rejects(
    () => verifyFf1SixClientFirestoreRules(RELEASE_REVISION, {
      accessToken: 'test-access-token',
      expectedRulesSource: `${expectedRulesSource}// changed\n`,
      fetchImplementation,
    }),
    /do not exactly match/,
  );
  await assert.rejects(
    () => verifyFf1SixClientFirestoreRules(RELEASE_REVISION, {
      accessToken: 'test-access-token',
      expectedRulesSource,
      fetchImplementation: async (url) => url.endsWith('/releases/cloud.firestore')
        ? {
            ok: true,
            json: async () => ({ name: releaseName, rulesetName }),
          }
        : {
            ok: true,
            json: async () => ({
              name: rulesetName,
              source: {
                files: [
                  { name: 'firestore.rules', content: expectedRulesSource },
                  { name: 'unexpected.rules', content: 'service firebase.storage {}' },
                ],
              },
            }),
          },
    }),
    /source manifest must contain exactly one file/,
  );
});

test('the rehearsal preserves shadow queue mode and selects the deterministic empty-queue starter', () => {
  const config = {
    mode: 'shadow',
    canaryLeagueIds: ['another-fixture'],
    internalTestLeagueIds: [],
    canonicalAuthorityLeagueIds: [],
    maxEnqueuePerRun: 10,
    revision: 4,
  };
  const configEvidence = assertFf1SixClientLeagueAutomationQueueConfig(config);

  assert.equal(configEvidence.mode, 'shadow');
  assert.equal(configEvidence.revision, 4);
  assert.match(configEvidence.sourceHash, /^[a-f0-9]{64}$/);
  assert.throws(
    () => assertFf1SixClientLeagueAutomationQueueConfig({ ...config, mode: 'canary' }),
    /remain shadow/,
  );
  assert.throws(
    () => assertFf1SixClientLeagueAutomationQueueConfig({
      ...config,
      internalTestLeagueIds: [FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID],
    }),
    /must not be enrolled/,
  );

  const selected = selectExpectedEmptyQueueStarterCandidate({
    roster: {
      activeSlots: [
        { slotId: 'LW-1', position: 'LW', asset: null },
        { slotId: 'C-1', position: 'C', asset: null },
      ],
    },
    draft: { draftedAssetKeys: ['skater:drafted'] },
    assets: [
      {
        assetKey: 'skater:lower',
        assetType: 'skater',
        position: 'LW',
        draftScore: 8,
        player: { fullName: 'Lower' },
      },
      {
        assetKey: 'skater:best',
        assetType: 'skater',
        position: 'C',
        draftScore: 12,
        player: { fullName: 'Best' },
      },
      {
        assetKey: 'skater:drafted',
        assetType: 'skater',
        position: 'C',
        draftScore: 99,
        player: { fullName: 'Drafted' },
      },
      {
        assetKey: 'goalie:closed-position',
        assetType: 'goalie-unit',
        position: 'G',
        draftScore: 100,
        teamName: 'Closed',
      },
    ],
  });
  assert.equal(selected.assetKey, 'skater:best');
});

test('the shared availability revision and exact future task identity are deterministic', () => {
  const lastSuccessfulSyncAt = {
    toDate: () => new Date('2026-09-09T12:00:00.000Z'),
  };
  const availability = {
    lastSuccessfulSyncAt,
    lastDailySyncKey: '2026-09-09',
    draftReadinessNhlRosterIdentityHash: 'b'.repeat(64),
    records: [
      {
        playerId: 2,
        playerName: 'Second',
        status: 'out',
        note: 'test',
        updatedAt: lastSuccessfulSyncAt,
        updatedBy: 'server:draft-readiness-injury-refresh',
        source: 'espn',
      },
      {
        playerId: 1,
        playerName: 'First',
        status: 'active',
        updatedBy: 'server:draft-readiness-injury-refresh',
      },
    ],
  };
  const reordered = { ...availability, records: [...availability.records].reverse() };
  const expectedRevision = createHash('sha256')
    .update(JSON.stringify({
      lastSuccessfulAt: lastSuccessfulSyncAt.toDate().toISOString(),
      lastDailySyncKey: '2026-09-09',
      draftReadinessNhlRosterIdentityHash: 'b'.repeat(64),
      records: [
        {
          playerId: 1,
          status: 'active',
          note: '',
          updatedAt: '',
          updatedBy: 'server:draft-readiness-injury-refresh',
          source: 'espn',
          externalStatus: '',
          externalReturnDate: '',
          externalInjuryDate: '',
          syncedAt: '',
        },
        {
          playerId: 2,
          status: 'out',
          note: 'test',
          updatedAt: lastSuccessfulSyncAt.toDate().toISOString(),
          updatedBy: 'server:draft-readiness-injury-refresh',
          source: 'espn',
          externalStatus: '',
          externalReturnDate: '',
          externalInjuryDate: '',
          syncedAt: '',
        },
      ],
    }))
    .digest('hex');
  assert.equal(buildFf1SixClientAvailabilityRevision(availability), expectedRevision);
  assert.equal(
    buildFf1SixClientAvailabilityRevision(availability),
    buildFf1SixClientAvailabilityRevision(reordered),
  );

  const start = Date.parse('2026-09-09T13:00:00.000Z');
  const expectedTaskId = createHash('sha256')
    .update(`scheduled-draft-start:${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}:${start}`)
    .digest('hex')
    .slice(0, 40);
  assert.equal(buildFf1SixClientScheduledDraftStartTaskId(start), expectedTaskId);
  const resource =
    `projects/${STAGING_PROJECT_ID}/locations/us-central1/queues/` +
    `processDraftClockDeadline/tasks/${expectedTaskId}`;
  assert.deepEqual(
    assertOnlyFf1SixClientScheduledStartTask([{ name: resource }], expectedTaskId),
    [expectedTaskId],
  );
  const taskUrl =
    `https://us-central1-${STAGING_PROJECT_ID}.cloudfunctions.net/` +
    'processDraftClockDeadline';
  const fullTask = {
    name: resource,
    scheduleTime: new Date(start - 10_000).toISOString(),
    dispatchDeadline: '60s',
    dispatchCount: 0,
    responseCount: 0,
    httpRequest: {
      httpMethod: 'POST',
      url: taskUrl,
      headers: { 'Content-Type': 'application/json' },
      oidcToken: {
        serviceAccountEmail: TASK_SERVICE_ACCOUNT,
        audience: taskUrl,
      },
      body: Buffer.from(JSON.stringify({
        data: {
          taskType: 'scheduled-start',
          leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
          expectedScheduledStartAtMilliseconds: start,
        },
      })).toString('base64'),
    },
  };
  assert.deepEqual(
    assertFf1SixClientScheduledStartTaskProvenance({
      task: fullTask,
      expectedTaskId,
      scheduledStartMilliseconds: start,
      serviceAccountEmail: TASK_SERVICE_ACCOUNT,
    }),
    { taskId: expectedTaskId, inFlight: false },
  );
  const inFlightTask = structuredClone(fullTask);
  inFlightTask.dispatchCount = 1;
  assert.deepEqual(
    assertFf1SixClientScheduledStartTaskProvenance({
      task: inFlightTask,
      expectedTaskId,
      scheduledStartMilliseconds: start,
      serviceAccountEmail: TASK_SERVICE_ACCOUNT,
    }),
    { taskId: expectedTaskId, inFlight: true },
  );
  for (const mutate of [
    (task) => { task.httpRequest.url = `${taskUrl}/wrong`; },
    (task) => { task.httpRequest.oidcToken.serviceAccountEmail = 'other@example.invalid'; },
    (task) => { task.httpRequest.body = Buffer.from('{}').toString('base64'); },
    (task) => { task.scheduleTime = new Date(start).toISOString(); },
    (task) => { task.dispatchDeadline = '120s'; },
    (task) => { task.responseCount = 1; },
  ]) {
    const invalidTask = structuredClone(fullTask);
    mutate(invalidTask);
    assert.throws(() => assertFf1SixClientScheduledStartTaskProvenance({
      task: invalidTask,
      expectedTaskId,
      scheduledStartMilliseconds: start,
      serviceAccountEmail: TASK_SERVICE_ACCOUNT,
    }));
  }
  const collusiveWrongTaskIdentity = structuredClone(fullTask);
  const alternateTaskIdentity =
    'alternate-task@rinkrat-staging-d1nc-2026.iam.gserviceaccount.com';
  collusiveWrongTaskIdentity.httpRequest.oidcToken.serviceAccountEmail =
    alternateTaskIdentity;
  assert.throws(
    () => assertFf1SixClientScheduledStartTaskProvenance({
      task: collusiveWrongTaskIdentity,
      expectedTaskId,
      scheduledStartMilliseconds: start,
      serviceAccountEmail: alternateTaskIdentity,
    }),
    /producer service identity changed/,
  );
  assert.throws(() => assertFf1SixClientScheduledStartTaskProvenance({
    task: { name: resource },
    expectedTaskId,
    scheduledStartMilliseconds: start,
    serviceAccountEmail: TASK_SERVICE_ACCOUNT,
  }));
  assert.throws(
    () => assertOnlyFf1SixClientScheduledStartTask(
      [{ name: resource.replace(expectedTaskId, 'c'.repeat(40)) }],
      expectedTaskId,
    ),
    /not owned/,
  );
});

test('Projection readiness request is bound to the exact six-client authority payload', () => {
  const scheduledStartMilliseconds = Date.parse('2026-09-09T13:30:00.000Z');
  const availabilityRevision = 'b'.repeat(64);
  const requestId = `projection-draft-${'c'.repeat(32)}`;
  const snapshotId = 'snapshot-six-client';
  const snapshotContentHash = 'd'.repeat(64);
  const metadata = {
    snapshotHashSchemaVersion: 2,
    assetDocumentCount: 3,
    assetCount: 240,
    canonicalAssetCount: 240,
    catalogSnapshotId: 'catalog-six-client',
    catalogHash: 'e'.repeat(64),
    catalogCacheHit: true,
  };
  const createdMilliseconds = scheduledStartMilliseconds - 20 * 60 * 1000;
  const startedMilliseconds = createdMilliseconds + 1_000;
  const completedMilliseconds = startedMilliseconds + 2_500;
  const observedAtMilliseconds = completedMilliseconds + 1_000;
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({
      requestedBy: 'server:draft-automation',
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      generationReason: 'pre-draft',
      targetCycleNumber: 1,
      availabilityRevision,
    }))
    .digest('hex');
  const request = {
    schemaVersion: 1,
    requestId,
    status: 'ready',
    leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
    requestedBy: 'server:draft-automation',
    generationReason: 'pre-draft',
    targetCycleNumber: 1,
    teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
    requiredGamesPerCycle: 6,
    availabilityRevision,
    payloadHash,
    snapshotId,
    snapshotContentHash,
    snapshotHashSchemaVersion: metadata.snapshotHashSchemaVersion,
    snapshotChunkCount: metadata.assetDocumentCount,
    canonicalAssetCount: metadata.assetCount,
    catalogSnapshotId: metadata.catalogSnapshotId,
    catalogHash: metadata.catalogHash,
    catalogCacheHit: metadata.catalogCacheHit,
    lastError: '',
    createdAt: new Date(createdMilliseconds),
    startedAt: new Date(startedMilliseconds),
    completedAt: new Date(completedMilliseconds),
    updatedAt: new Date(completedMilliseconds),
    expiresAt: new Date(completedMilliseconds + 24 * 60 * 60 * 1000),
    durationMilliseconds: 2_500,
  };
  const expected = {
    requestId,
    snapshotId,
    snapshotContentHash,
    availabilityRevision,
    scheduledStartMilliseconds,
    observedAtMilliseconds,
    metadata,
  };

  assert.equal(assertFf1SixClientProjectionRequest(request, expected), true);
  for (const mutate of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.leagueId = 'another-league'; },
    (value) => { value.requestedBy = 'fixture-admin'; },
    (value) => { value.generationReason = 'manual'; },
    (value) => { value.targetCycleNumber = 2; },
    (value) => { value.teamCount = 10; },
    (value) => { value.requiredGamesPerCycle = 7; },
    (value) => { value.payloadHash = 'e'.repeat(64); },
    (value) => { value.snapshotChunkCount = 2; },
    (value) => { value.canonicalAssetCount = 239; },
    (value) => { value.catalogHash = 'f'.repeat(64); },
    (value) => {
      value.createdAt = new Date(scheduledStartMilliseconds - 31 * 60 * 1000);
    },
    (value) => { value.durationMilliseconds = 9 * 60 * 1000 + 1; },
  ]) {
    const changed = structuredClone(request);
    mutate(changed);
    assert.throws(() => assertFf1SixClientProjectionRequest(changed, expected));
  }
});

test('Cycle 1 six-game ownership is independently bound to the verified Projection asset', () => {
  const games = Array.from({ length: 6 }, (_, index) => ({
    gameId: 2026020001 + index,
    gameDate: `2026-10-${String(index + 1).padStart(2, '0')}`,
    opponentAbbreviation: 'SEA',
    venue: index % 2 === 0 ? 'home' : 'away',
    status: 'upcoming',
  }));
  const authoritativeProjectionAsset = {
    assetType: 'skater',
    assetKey: 'skater-8478402',
    position: 'C',
    player: { id: 8478402, fullName: 'Fixture Skater' },
    currentTeamCycleNumber: 1,
    currentTeamCycleGames: games,
    sharedProjectionSnapshotId: 'projection-snapshot-six-client',
  };
  const window = {
    id: 'manager-1__C-1__cycle-1',
    ownerId: 'manager-1',
    rosterSlotId: 'C-1',
    cycleNumber: 1,
    assetKey: authoritativeProjectionAsset.assetKey,
    position: 'C',
    asset: {
      assetType: 'skater',
      assetKey: authoritativeProjectionAsset.assetKey,
      position: 'C',
      player: structuredClone(authoritativeProjectionAsset.player),
    },
    scheduledGameIds: games.map((game) => game.gameId),
    scheduledGameDates: games.map((game) => game.gameDate),
    frozenProjectionSource: 'shared-snapshot',
    frozenProjectionVersion: 11,
    frozenProjectionSnapshotId: authoritativeProjectionAsset.sharedProjectionSnapshotId,
  };

  assert.equal(
    assertFf1SixClientWindowProjectionAuthority(window, authoritativeProjectionAsset),
    true,
  );

  const tautologicallyWrongWindow = structuredClone(window);
  tautologicallyWrongWindow.scheduledGameIds[0] = 9999999999;
  tautologicallyWrongWindow.frozenProjectionTargetGameIds =
    [...tautologicallyWrongWindow.scheduledGameIds];
  assert.throws(
    () => assertFf1SixClientWindowProjectionAuthority(
      tautologicallyWrongWindow,
      authoritativeProjectionAsset,
    ),
    /independently verified Projection V11 game IDs/,
  );
  const wrongIdentity = structuredClone(window);
  wrongIdentity.asset.player.id = 1;
  assert.throws(
    () => assertFf1SixClientWindowProjectionAuthority(
      wrongIdentity,
      authoritativeProjectionAsset,
    ),
    /verified Draft asset identity/,
  );
  const wrongWindowIdentity = structuredClone(window);
  wrongWindowIdentity.id = 'manager-1__C-2__cycle-1';
  assert.throws(
    () => assertFf1SixClientWindowProjectionAuthority(
      wrongWindowIdentity,
      authoritativeProjectionAsset,
    ),
    /canonical owner\/slot\/cycle identity/,
  );
  const wrongWindowPosition = structuredClone(window);
  wrongWindowPosition.position = 'LW';
  assert.throws(
    () => assertFf1SixClientWindowProjectionAuthority(
      wrongWindowPosition,
      authoritativeProjectionAsset,
    ),
  );
});

test('CLI failures expose only a bounded public enum and never raw staging identities', async () => {
  const stderr = [];
  const secret = 'ff1-six-client-sensitive-manager-and-request-id';
  const exitCode = await runFf1SixClientDraftRehearsalCli({
    runner: async () => {
      throw new Error(secret);
    },
    stdout: () => assert.fail('A failed rehearsal must not write success output.'),
    stderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr.length, 1);
  assert.deepEqual(JSON.parse(stderr[0]), {
    errorCode: 'FF1_SIX_CLIENT_EVIDENCE_FAILED',
    checkpoint: 'rehearsal',
    cleanupState: 'cleanup-required',
    failureDetail: 'unclassified',
  });
  assert.doesNotMatch(stderr[0], new RegExp(secret));

  const bounded = new Ff1SixClientPublicEvidenceError(
    'cleanup',
    'complete',
    'cleanup-reconciliation',
  );
  assert.deepEqual(bounded.toJSON(), {
    errorCode: 'FF1_SIX_CLIENT_EVIDENCE_FAILED',
    checkpoint: 'cleanup',
    cleanupState: 'complete',
    failureDetail: 'cleanup-reconciliation',
  });
});

test('the retained FF1.29 fixture must exist before the v2 rehearsal can write', () => {
  assert.equal(assertFf1SixClientRetainedV1FixturePresent(true), true);
  assert.throws(
    () => assertFf1SixClientRetainedV1FixturePresent(false),
    /immutable boundary cannot be proven/,
  );
});

test('the evidence lock cannot release after any retained-v1 boundary drift', () => {
  const baseline = {
    documents: [{ path: 'leagues/ff1-six-client-draft', exists: true, hash: 'a'.repeat(64) }],
    activity: [{ path: 'leagues/ff1-six-client-draft/activity/one', exists: true, hash: 'b'.repeat(64) }],
    audit: [],
    projectionAssets: [{ path: 'leagues/ff1-six-client-draft/projectionSnapshots/one/assets/0', exists: true, hash: 'c'.repeat(64) }],
  };
  assert.equal(
    assertFf1SixClientRetainedV1BoundaryStable(structuredClone(baseline), baseline),
    true,
  );
  for (const mutate of [
    (value) => value.activity.push({
      path: 'leagues/ff1-six-client-draft/activity/two',
      exists: true,
      hash: 'd'.repeat(64),
    }),
    (value) => value.audit.push({
      path: 'leagues/ff1-six-client-draft/audit/one',
      exists: true,
      hash: 'e'.repeat(64),
    }),
    (value) => { value.projectionAssets[0].hash = 'f'.repeat(64); },
    (value) => { value.documents[0].exists = false; value.documents[0].hash = null; },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(
      () => assertFf1SixClientRetainedV1BoundaryStable(changed, baseline),
      /audit boundary changed/,
    );
  }
  assert.throws(
    () => assertFf1SixClientRetainedV1BoundaryStable(baseline, null),
    /starting boundary was not captured/,
  );

  const safeCleanup = {
    completed: false,
    safeFailureParked: true,
    clientSessionsSafe: true,
    fixtureAccountsSafe: true,
    queuesClean: true,
    retainedV1BoundaryStable: true,
    historicalReplayRequestsQuiet: true,
    sharedGuardedTaskQueuesQuiet: true,
  };
  assert.equal(canReleaseFf1SixClientEvidenceLock(safeCleanup), true);
  assert.equal(
    canReleaseFf1SixClientEvidenceLock({
      ...safeCleanup,
      retainedV1BoundaryStable: false,
    }),
    false,
  );
  assert.equal(
    canReleaseFf1SixClientEvidenceLock({
      ...safeCleanup,
      completed: true,
      safeFailureParked: false,
      retainedV1BoundaryStable: false,
    }),
    false,
  );
  assert.equal(
    canReleaseFf1SixClientEvidenceLock({
      ...safeCleanup,
      historicalReplayRequestsQuiet: false,
    }),
    false,
  );
  assert.equal(
    canReleaseFf1SixClientEvidenceLock({
      ...safeCleanup,
      sharedGuardedTaskQueuesQuiet: false,
    }),
    false,
  );
  assert.equal(assertFf1SixClientHistoricalReplayRequestsQuiet(0), true);
  assert.throws(
    () => assertFf1SixClientHistoricalReplayRequestsQuiet(1),
    /queued or processing/,
  );
});

test('shared maintenance rejects another active Draft and failure cleanup remains stopped', () => {
  const safeResetAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  assert.equal(assertFf1SixClientDraftInventory([
    {
      documentId: 'current',
      leagueId: 'd1n-capacity-league',
      draft: {
        status: 'scheduled',
        clockStatus: 'stopped',
        nextOverallPick: 1,
        draftedAssetKeys: [],
        scheduledStartAt: new Date(safeResetAt),
      },
    },
    {
      documentId: 'current',
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      draft: { status: 'complete' },
    },
  ]), 2);
  assert.throws(() => assertFf1SixClientDraftInventory([
    {
      documentId: 'current',
      leagueId: 'someone-else',
      draft: { status: 'live' },
    },
  ]), /Another staging Draft/);
  assert.doesNotThrow(() => assertFf1SixClientRetainedFixtureSafe({
    status: 'scheduled',
    clockStatus: 'stopped',
    scheduledStartAt: new Date(safeResetAt),
  }, 0));
  assert.doesNotThrow(() => assertFf1SixClientRetainedFixtureSafe({
    status: 'live',
    clockStatus: 'paused',
    pickStartedAt: null,
  }, 4));
  assert.doesNotThrow(() => assertFf1SixClientRetainedFixtureSafe({
    status: 'complete',
  }, FF1_SIX_CLIENT_TOTAL_PICKS));
  assert.throws(() => assertFf1SixClientRetainedFixtureSafe({
    status: 'scheduled',
    clockStatus: 'stopped',
    scheduledStartAt: new Date(safeResetAt),
  }, 1), /zero picks/);
  assert.throws(() => assertFf1SixClientRetainedFixtureSafe({
    status: 'complete',
  }, FF1_SIX_CLIENT_TOTAL_PICKS - 1), /full Draft/);
  assert.throws(() => assertFf1SixClientRetainedFixtureSafe({
    status: 'live',
    clockStatus: 'running',
  }, 4));

  const fixtureRunId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.doesNotThrow(() => assertFf1SixClientFixtureRunOwnership(
    {
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      fixtureRunId,
    },
    { fixtureRunId },
    fixtureRunId,
  ));
  assert.throws(() => assertFf1SixClientFixtureRunOwnership(
    {
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      fixtureRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
    { fixtureRunId },
    fixtureRunId,
  ), /another rehearsal run/);

  assert.equal(assertFf1SixClientSupportingAuthoritySafety({
    leagueExists: true,
    fixtureRunId,
    invite: {
      exists: true,
      data: {
        fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
        fixtureRunId,
        leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
        inviteCode: FF1_SIX_CLIENT_FIXTURE_INVITE_CODE,
      },
    },
    lifecycleStates: FIXTURE_MANAGER_IDS.map((uid) => ({
      exists: true,
      uid,
      data: {
        uid,
        fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
        fixtureRunId,
        fixtureLeagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      },
    })),
  }), FF1_SIX_CLIENT_MANAGER_COUNT + 1);
  assert.throws(() => assertFf1SixClientSupportingAuthoritySafety({
    leagueExists: false,
    fixtureRunId,
    invite: {
      exists: true,
      data: {
        fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
        fixtureRunId,
        leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
        inviteCode: FF1_SIX_CLIENT_FIXTURE_INVITE_CODE,
      },
    },
    lifecycleStates: [],
  }), /without the guarded fixture league/);
});

test('a completed Draft must preserve the exact starter, bench, and empty IR shape', () => {
  const starterSlots = [
    ['LW', 1], ['LW', 2], ['LW', 3],
    ['C', 1], ['C', 2], ['C', 3],
    ['RW', 1], ['RW', 2], ['RW', 3],
    ['D', 1], ['D', 2], ['D', 3], ['D', 4],
    ['G', 1],
  ];
  const cycleScore = { cycleNumber: 1, gamesCounted: 0, fantasyPoints: 0 };
  const expectedAssets = Array.from({ length: 17 }, (_, index) => ({
    assetKey: `asset-${index + 1}`,
    assetType: 'skater',
    position: index < 14 ? starterSlots[index][0] : 'LW',
    player: {
      id: index + 1,
      fullName: `Synthetic player ${index + 1}`,
    },
    cycleScore: 100 - index,
    projectionVersion: 11,
  }));
  const activeSlots = starterSlots.map(([position, slotNumber], index) => ({
    slotId: `${position}-${slotNumber}`,
    position,
    slotNumber,
    asset: {
      ...expectedAssets[index],
      rosterStatus: 'active',
      cycleScore,
    },
    pendingMove: null,
    openFromCycleNumber: null,
  }));
  const benchSlots = Array.from({ length: 3 }, (_, index) => ({
    slotId: `B-${index + 1}`,
    slotNumber: index + 1,
    asset: {
      ...expectedAssets[index + 14],
      rosterStatus: 'benched',
      cycleScore,
    },
  }));
  const roster = {
    schemaVersion: 2,
    activeSlots,
    benchSlots,
    irSlots: Array.from({ length: 3 }, (_, index) => ({
      slotId: `IR-${index + 1}`,
      slotNumber: index + 1,
      asset: null,
    })),
  };
  assert.deepEqual(
    assertFf1SixClientCompletedRoster(roster, expectedAssets),
    expectedAssets.map((asset) => asset.assetKey),
  );
  const wrongPosition = structuredClone(roster);
  wrongPosition.activeSlots[0].asset.position = 'C';
  assert.throws(
    () => assertFf1SixClientCompletedRoster(wrongPosition, expectedAssets),
  );
  const corruptedBenchIdentity = structuredClone(roster);
  corruptedBenchIdentity.benchSlots[0].asset.player.fullName = 'Wrong player';
  assert.throws(
    () => assertFf1SixClientCompletedRoster(corruptedBenchIdentity, expectedAssets),
    /does not preserve its authoritative Projection V11 asset/,
  );
  const occupiedIr = structuredClone(roster);
  occupiedIr.irSlots[0].asset = structuredClone(roster.activeSlots[0].asset);
  assert.throws(
    () => assertFf1SixClientCompletedRoster(occupiedIr, expectedAssets),
    /must not place an asset directly into IR/,
  );
  const emptyBench = structuredClone(roster);
  emptyBench.benchSlots[0].asset = null;
  assert.throws(
    () => assertFf1SixClientCompletedRoster(emptyBench, expectedAssets),
    /empty after Draft completion/,
  );
});

test('synthetic teams start with canonical zero standings and unique waiver authority', () => {
  const identity = {
    uid: FIXTURE_MANAGER_IDS[2],
    alias: 'manager-3',
    teamName: 'team-3',
  };
  const team = {
    schemaVersion: 1,
    id: identity.uid,
    ownerId: identity.uid,
    teamName: identity.teamName,
    managerName: identity.alias,
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    waiverPriority: 3,
    draftPosition: 3,
    authority: 'league-lifecycle-authority',
  };

  assert.equal(assertFf1SixClientTeamAuthority(team, identity, 2), true);
  for (const mutate of [
    (value) => { value.wins = 10; },
    (value) => { value.pointsFor = 1_000; },
    (value) => { value.waiverPriority = 1; },
    (value) => { value.authority = 'capacity-fixture'; },
  ]) {
    const changed = structuredClone(team);
    mutate(changed);
    assert.throws(() => assertFf1SixClientTeamAuthority(changed, identity, 2));
  }
});

test('public rehearsal evidence is aggregate and contains no account or player identity', () => {
  const evidence = buildPublicFf1SixClientEvidence({
    deployedReleaseRevision: RELEASE_REVISION,
    toolingRevision: 'b'.repeat(40),
    authenticatedClientCount: 6,
    independentListenerCount: 6,
    projectionVersion: 11,
    scoringRulesVersion: 4,
    firestoreRulesVerified: true,
    firestoreRulesSourceHash: 'c'.repeat(64),
    strictServerAvailabilityReused: true,
    serverSnapshotVerified: true,
    projectionHashChainVerified: true,
    offClockSubmissionRejected: true,
    duplicateSubmissionStable: true,
    staleSubmissionRejected: true,
    crossManagerQueueWriteRejected: true,
    queueTimeoutPickCount: 2,
    unavailableQueueEntrySkipped: true,
    emptyQueueAutoPickCount: 1,
    pausePreservedPickCount: true,
    resumedDeadlineExactOnce: true,
    reconnectConverged: true,
    snakeBoundaryVerified: true,
    pickHandoffTriggerVerified: true,
    draftCompletionTriggerVerified: true,
    directDraftCompletionLifecycleObserved: true,
    sharedLeagueAutomationQueueRemainedEmpty: true,
    retainedPriorDraftBoundaryPreserved: true,
    completedPickCount: 102,
    uniqueAssetCount: 102,
    completedRosterCount: 6,
    cycleOneStarted: true,
    cycleOneActiveWindowCount: 84,
    cycleOneMatchupCount: 3,
    recurringScoringParked: true,
    leagueActivityPublicationCount: 106,
    leagueAutomationQueueMode: 'shadow',
    postDraftRemovalRejected: true,
    postDraftRemovalBlockReason: 'membership-locked',
    exactOnceOutcome: true,
    fixtureAccountsDisabled: true,
    sharedMaintenanceLockReleased: true,
    password: 'must-not-leak',
    managerEmail: 'must-not-leak@example.com',
    assetKey: 'must-not-leak',
  });
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.authenticatedClientCount, 6);
  assert.equal(evidence.leagueLabel, 'draft-a');
  assert.equal(evidence.completedPickCount, 102);
  assert.equal(evidence.uniqueAssetCount, 102);
  assert.equal(evidence.cycleOneActiveWindowCount, 84);
  assert.equal(evidence.leagueActivityPublicationCount, 106);
  assert.equal(evidence.leagueAutomationQueueMode, 'shadow');
  assert.equal(evidence.projectionHashChainVerified, true);
  assert.equal(evidence.pickHandoffTriggerVerified, true);
  assert.equal(evidence.draftCompletionTriggerVerified, true);
  assert.equal(evidence.directDraftCompletionLifecycleObserved, true);
  assert.equal(evidence.sharedLeagueAutomationQueueRemainedEmpty, true);
  assert.equal(evidence.retainedPriorDraftBoundaryPreserved, true);
  assert.equal(evidence.sharedMaintenanceLockReleased, true);
  assert.equal(evidence.crossManagerQueueWriteRejected, true);
  assert.equal(evidence.postDraftRemovalBlockReason, 'membership-locked');
  assert.equal(evidence.fixtureRetainedForAudit, true);
  assert.equal('firestoreRulesSourceHash' in evidence, false);
  assert.doesNotMatch(
    serialized,
    /must-not-leak|@|assetKey|password|managerEmail|ff1-six-client-draft-v2|c{64}/,
  );
  assert.throws(
    () => buildPublicFf1SixClientEvidence({ ...evidence, exactOnceOutcome: false }),
    /did not pass/,
  );
});

test('the rehearsal uses six authenticated clients and ordinary Draft authorities', async () => {
  const source = await read('scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs');

  assert.match(source, /signInWithEmailAndPassword/);
  assert.match(source, /makeSecureDraftPick/);
  assert.match(source, /executeDraftCommand/);
  assert.match(source, /removeLeagueMemberSecure/);
  assert.match(source, /'makeSecureDraftPick'/);
  assert.match(source, /'removeLeagueMemberSecure'/);
  assert.match(source, /setDoc\([\s\S]*queues/);
  assert.match(source, /disableNetwork/);
  assert.match(source, /enableNetwork/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /assertStrictSchema2AvailabilityBaseline/);
  assert.match(source, /assertFf132ProjectionSnapshotIntegrity/);
  assert.match(source, /acquireFf132EvidenceLock/);
  assert.match(source, /fixtureRunId/);
  assert.match(source, /verifyAndActivatePreparedFixtureDraft/);
  assert.match(source, /runTransaction/);
  assert.match(source, /buildFf1SixClientScheduledDraftStartTaskId/);
  assert.match(source, /deleteExactFf1SixClientScheduledStartTask/);
  assert.match(source, /selectionType, 'queue'/);
  assert.match(source, /permission-denied\$/);
  assert.match(source, /membership-locked/);
  assert.match(source, /crossManagerQueueWriteRejected/);
  assert.match(source, /offClockSubmissionRejected/);
  assert.match(source, /unavailableQueueEntrySkipped/);
  assert.match(source, /resumedDeadlineExactOnce/);
  assert.match(source, /timer-expired/);
  assert.match(source, /manager-auto-mode/);
  assert.match(source, /selectExpectedEmptyQueueStarterCandidate/);
  assert.match(source, /deterministic best legal Projection V11 asset/);
  assert.match(source, /status, 'complete'/);
  assert.match(source, /completed roster does not exactly match its authoritative Draft picks/i);
  assert.match(source, /completed rosters do not exactly equal the global authoritative pick set/i);
  assert.match(source, /assertFf1SixClientCompletedRoster/);
  assert.match(source, /revokeRefreshTokens/);
  assert.match(source, /failures\.push\(identity\.alias\)/);
  assert.match(source, /firebaserules\.googleapis\.com/);
  assert.match(source, /listCollections/);
  assert.match(source, /listDocuments/);
  assert.match(source, /projectionGenerationRequests/);
  assert.match(source, /firestore\.batch\(\)/);
  assert.match(source, /batch\.create/);
  assert.match(source, /parkFf1SixClientRecurringAutomationUntilQuiescent/);
  assert.match(source, /SERVER_AUTOMATION_QUIESCENCE_MILLISECONDS/);
  assert.match(source, /cleanFf1SixClientTaskQueuesUntilQuiescent/);
  assert.match(source, /--response-view=full/);
  assert.match(source, /assertFf1SixClientScheduledStartTaskProvenance/);
  assert.match(source, /if \(provenance\.inFlight\)/);
  assert.match(source, /clientSessionsSafe/);
  assert.match(source, /authenticated-client-cleanup/);
  assert.match(source, /DRAFT_TRIGGER_QUIESCENCE_MILLISECONDS/);
  assert.match(source, /DRAFT_TASK_QUEUE_QUIESCENCE_MILLISECONDS/);
  assert.match(source, /frozenProjectionTargetGameIds/);
  assert.match(source, /authoritativeAssetsByKey/);
  assert.match(source, /pickHandoffTriggerVerified/);
  assert.match(source, /draftCompletionTriggerVerified/);
  assert.match(source, /directDraftCompletionLifecycleObserved/);
  assert.match(source, /cycleOneCreatedInLastRun/);
  assert.match(source, /assertEmptyFf1SixClientSharedGuardedTaskQueues/);
  assert.match(source, /readAndAssertFf1SixClientHistoricalReplayRequestsQuiet/);
  assert.match(source, /assertFf1SixClientExcludedRuntimeAbsent/);
  assert.match(source, /'functions', 'list', '--v2'/);
  assert.match(source, /'scheduler', 'jobs', 'list'/);
  assert.match(source, /readAndAssertFf1SixClientRetainedV1Boundary/);
  assert.match(source, /FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS\.flatMap/);
  assert.match(source, /requireSuccessfulCycleOne: false/);
  assert.match(source, /fixture-post-queue-safety-park/);
  const cleanupStart = source.indexOf('} finally {');
  const clientsClosed = source.indexOf('await closeClients(', cleanupStart);
  const firstFailurePark = source.indexOf(
    'await parkRetainedFixtureAfterFailure(',
    clientsClosed,
  );
  const queueCleanup = source.indexOf(
    'await cleanFf1SixClientTaskQueuesUntilQuiescent(',
    firstFailurePark,
  );
  const finalFailurePark = source.lastIndexOf(
    'await parkRetainedFixtureAfterFailure(',
  );
  const lockRelease = source.indexOf(
    'await releaseSharedEvidenceLock(',
    finalFailurePark,
  );
  const finalRetainedV1Proof = source.lastIndexOf(
    'await readAndAssertFf1SixClientRetainedV1Boundary(firestore)',
  );
  assert.ok(cleanupStart >= 0);
  assert.ok(clientsClosed > cleanupStart);
  assert.ok(firstFailurePark > clientsClosed);
  assert.ok(queueCleanup > firstFailurePark);
  assert.ok(finalFailurePark > queueCleanup);
  assert.ok(finalRetainedV1Proof > finalFailurePark);
  assert.ok(lockRelease > finalFailurePark);
  assert.ok(lockRelease > finalRetainedV1Proof);
  assert.doesNotMatch(source, /prepareSharedAvailability/);
  assert.doesNotMatch(source, /doc\('appData\/playerAvailability'\)\.set/);
  assert.doesNotMatch(source, /transaction\.set\(availabilityRef/);
  assert.doesNotMatch(source, /transaction\.delete\(availabilityRef/);
  assert.doesNotMatch(source, /updateUser\([^\n]+disabled: true[^\n]+\.catch/);
  assert.doesNotMatch(source, /signOut\([^)]*\)\.catch/);
  assert.doesNotMatch(source, /deleteClientApp\([^)]*\)\.catch/);
  assert.doesNotMatch(source, /bulkWriter|recursiveDelete/);
  assert.equal(
    source.match(/firestore\.doc\(`users\/\$\{ownerId\}`\)/g)?.length ?? 0,
    1,
    'Retained user documents may only be addressed by the bounded read boundary.',
  );
  assert.equal(
    source.match(/firestore\.doc\(`publicProfiles\/\$\{ownerId\}`\)/g)?.length ?? 0,
    1,
    'Retained public profiles may only be addressed by the bounded read boundary.',
  );
  assert.match(source, /firestore\.getAll\(\.\.\.documentRefs\)/);
  assert.doesNotMatch(
    source,
    /(?:transaction|batch)\.(?:set|update|delete)\(\s*(?:user|profile|documentRefs)/i,
  );
  assert.doesNotMatch(source, /firebase deploy|nhl-fantasy-app-ab673/);
  assert.match(source, /fixtureRunId\.replaceAll\('-', ''\)\.slice\(0, 12\)/);
  assert.deepEqual(
    FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS,
    [...FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS].sort(),
  );
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.includes('makeSecureDraftPick'), true);
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.includes('removeLeagueMemberSecure'), true);
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.includes('initializeSeasonAfterDraft'), true);
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.includes('publishLeagueDraftPickActivity'), true);
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.length, 19);
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.includes('processLeagueAutomationTask'), true);
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.includes('processHistoricalReplayAdvance'), true);
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.includes('advanceHistoricalReplayDay'), true);
  assert.equal(FF1_SIX_CLIENT_FORBIDDEN_SHARED_FUNCTIONS.length, 8);
  assert.equal(FF1_SIX_CLIENT_FORBIDDEN_SHARED_SCHEDULER_JOBS.length, 6);
  assert.equal(Object.keys(FF1_SIX_CLIENT_TASK_QUEUE_TOPOLOGY).length, 5);
  assert.equal(FF1_SIX_CLIENT_FORBIDDEN_SHARED_FUNCTIONS.includes('requestLeagueLiveScoringRefresh'), true);
  assert.equal(FF1_SIX_CLIENT_FORBIDDEN_SHARED_FUNCTIONS.includes('queueLeagueAutomationCanaryCheck'), true);
  assert.equal(FF1_SIX_CLIENT_FORBIDDEN_SHARED_FUNCTIONS.includes('pollCanonicalNhlImpactFeed'), true);
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.includes('runSeasonStartAutomation'), false);
  assert.equal(FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.includes('runScheduledLeagueAutomation'), false);
});

test('FF1.33 documents the hardened boundary without weakening physical UI evidence', async () => {
  const [runbook, handoff, packageSource] = await Promise.all([
    read('docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md'),
    read('docs/RINKRAT_CODEX_HANDOFF.md'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(runbook, /guarded six-client staging rehearsal/i);
  assert.match(runbook, /Admin SDK is limited to one-shot fixture provisioning/i);
  assert.match(runbook, /never creates, replaces, updates, or deletes[\s\S]*shared source/i);
  assert.match(runbook, /fixed v2 fixture namespace[\s\S]*empty/i);
  assert.match(runbook, /never deletes or replaces it/i);
  assert.match(runbook, /server-worker lifetime/i);
  assert.match(runbook, /Draft-trigger lifetime/i);
  assert.match(runbook, /all 16 runtime authorities[\s\S]+three[\s\S]+guard prerequisites/i);
  assert.match(runbook, /four exercised FF1\.33 lifecycle\/publication[\s\S]*three present exercised authorities/i);
  assert.match(runbook, /common `firebase-functions-hash` is not required/i);
  assert.match(runbook, /focused replay-lease guard is reviewed and merged/i);
  assert.match(runbook, /deploy exactly[\s\S]+19 staging Functions/i);
  assert.match(runbook, /no additional\s+Scheduler job is\s+introduced/i);
  assert.match(runbook, /do not deploy\s+`runSeasonStartAutomation`/i);
  assert.match(runbook, /retain four concurrent dispatches/i);
  assert.match(runbook, /five\s+task queues/i);
  assert.match(runbook, /eight[\s\S]+must remain absent/i);
  assert.match(runbook, /retained D1L[\s\S]+forward repair/i);
  assert.match(runbook, /complete bounded[\s\S]+retained v1 fixture/i);
  assert.match(runbook, /pre-guard revision rollback is intentionally[\s\S]+unavailable/i);
  assert.match(runbook, /cleanup-required/);
  assert.match(runbook, /FF1_SIX_CLIENT_STAGING_MAINTENANCE_ACK/);
  assert.match(runbook, /does not replace physical-device/i);
  assert.match(runbook, /two-manager supported-UI rehearsal/i);
  assert.match(handoff, /FF1\.33/);
  for (const [name, expectedValue] of Object.entries(EXPECTED_PACKAGE_SCRIPTS)) {
    assert.equal(packageJson.scripts[name], expectedValue);
  }
  assert.equal(
    packageJson.scripts['verify:batchff1-13:core'],
    'npm run verify:batchff1-12:core && npm run test:batchff1-13:run && npm run validate:release-manifest',
  );
});

test('the harness changes no protected runtime, Rules, indexes, TTL, or rollout mode', async () => {
  const source = await read('scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs');

  assert.match(source, /projectionVersion, 11/);
  assert.match(source, /scoringRulesVersion, 4/);
  assert.match(source, /firebaserules\.googleapis\.com/);
  assert.match(source, /expectedRulesSource/);
  assert.doesNotMatch(source, /scoringRules\s*=|requiredGamesPerCycle\s*=/i);
  assert.doesNotMatch(source, /tasks["'\s]+queues["'\s]+update|queues["'\s]+update/i);
  assert.doesNotMatch(
    source,
    /firebase deploy|firestore\.indexes|ttlPolicies|app.?check.*enforce/i,
  );
});
