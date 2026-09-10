import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  assertExactFunctionSourceManifest,
  acquireFf132EvidenceLock,
  assertFf132AlreadyCurrentCompletionLog,
  assertFf132AvailabilityTaskQueue,
  assertFf132CloudRunDeployment,
  assertFf132DraftClockTaskQueue,
  assertFf132DraftAutomationSuccessMarker,
  assertFf132DraftInventory,
  assertFf132DuplicateSchedulerRequestLogs,
  assertFf132MarkerOnlyProbeSequence,
  assertFf132MarkerOnlySchedulerBaseline,
  assertFf132MarkerOnlySchedulerRequestLog,
  assertFf132ProjectionSnapshotIntegrity,
  assertFf132FirstFailedTaskAttempt,
  assertFf132ManualSchedulerCompletion,
  assertFf132NaturalSchedulerAttempt,
  assertFf132OwnedClockQueueTasks,
  assertFf132ProjectionTaskQueue,
  assertFf132ProjectionRequest,
  assertFf132RequestLogs,
  assertFf132RetryRequestLogs,
  assertFf132SchedulerRunAuditProvenance,
  assertFf132SchedulerJob,
  assertFf132SingleQueueTask,
  assertFf132SourceArchiveBuffer,
  assertFf132StagingFunctionInventory,
  assertFf132StagingSafety,
  assertFf132SyntheticDraftSafety,
  assertFf132UtcWindow,
  assertSafeArchiveEntries,
  assertStrictSchema2AvailabilityBaseline,
  buildPublicFf132Evidence,
  boundFf132TimeoutBeforeDeadline,
  buildFf132MarkerOnlySchedulerProbe,
  buildFf132ProjectionRequestId,
  FF132_AVAILABILITY_TASK_QUEUE,
  FF132_DRAFT_CLOCK_TASK_QUEUE,
  FF132_DRAFT_SCHEDULER_JOB,
  FF132_EVIDENCE_LOCK_PATH,
  FF132_PROJECTION_TASK_QUEUE,
  FF132_REGION,
  FF132_REQUIRED_STAGING_FUNCTIONS,
  FF132_STAGING_ACKNOWLEDGEMENT,
  FF132_STAGING_MAINTENANCE_ACKNOWLEDGEMENT,
  FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
  Ff132PublicEvidenceError,
  Ff132SafetyTransactionDeadlineError,
  canAttemptFf132CleanupRequiredMarker,
  getFf132AvailabilityRestorePatch,
  getFf132NaturalSchedulerRequestWindow,
  getNextSafeNaturalSchedulerMinute,
  hashFf132DocumentData,
  isFf132NaturalSchedulerAttemptObserved,
  buildFf132ScheduledDraftStartTaskId,
  prepareFf132InitialEvidenceState,
  parkFf132FinalDraftBeforeDeadline,
  reconcileFf132FixtureOwnership,
  readCleanPushedToolingState,
  runFf132CleanupStages,
  runFf132SingleAttemptTransactionBeforeDeadline,
  runFf132EvidenceCli,
  verifyFf132DeployedFunctionSourceArchives,
  verifyFf132StagingManifest,
  waitForFf132NaturalSchedulerAttempt,
} from '../../scripts/capacity/run-ff132-server-owned-draft-preparation-staging-evidence.mjs';
import {
  createProjectionSnapshotHashBundle,
  PROJECTION_SNAPSHOT_HASH_ALGORITHM,
  PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
} from '../../functions/src/shared/core/projection/projection-snapshot-hash.util.ts';
import { D1N_STAGING_PROJECT_ID } from '../../scripts/capacity/prepare-d1n-staging-hosting.mjs';
import { D1N_FIXTURE_LEAGUE_ID } from '../../scripts/capacity/seed-d1n-route-fixture.mjs';

const ROOT = new URL('../../', import.meta.url);
const REVISION = 'a'.repeat(40);
const TOOLING_REVISION = 'b'.repeat(40);
const SOURCE_HASH = 'c'.repeat(40);
const SERVICE_ACCOUNT =
  `ff132-runtime@${D1N_STAGING_PROJECT_ID}.iam.gserviceaccount.com`;

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function writeFixtureFile(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function runGit(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function buildSourceZip(entryInputs, endOverrides = {}) {
  const entries = [];
  const localParts = [];
  let localOffset = 0;

  for (const input of entryInputs) {
    const name = input.name;
    const localName = input.localName ?? name;
    const flags = input.flags ?? 0;
    const localFlags = input.localFlags ?? flags;
    const method = input.method ?? 0;
    const localMethod = input.localMethod ?? method;
    const contents = Buffer.isBuffer(input.contents)
      ? input.contents
      : Buffer.from(input.contents ?? '');
    const compressedContents = input.compressedContents ?? (
      method === 8 ? deflateRawSync(contents) : contents
    );
    const nameBytes = Buffer.from(name, flags & 0x800 ? 'utf8' : 'ascii');
    const localNameBytes = Buffer.from(
      localName,
      localFlags & 0x800 ? 'utf8' : 'ascii',
    );
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(localFlags, 6);
    localHeader.writeUInt16LE(localMethod, 8);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(
      input.localCompressedBytes ?? compressedContents.byteLength,
      18,
    );
    localHeader.writeUInt32LE(
      input.localExpandedBytes ?? contents.byteLength,
      22,
    );
    localHeader.writeUInt16LE(localNameBytes.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    const local = Buffer.concat([localHeader, localNameBytes, compressedContents]);
    localParts.push(local);
    entries.push({
      ...input,
      nameBytes,
      flags,
      method,
      contents,
      compressedContents,
      localOffset: input.localOffset ?? localOffset,
    });
    localOffset += local.byteLength;
  }

  const centralParts = entries.map((entry) => {
    const central = Buffer.alloc(46);
    const isDirectory = entry.name.endsWith('/');
    const host = entry.host ?? 3;
    const mode = entry.unixMode ?? (isDirectory ? 0o040755 : 0o100644);
    const externalAttributes = entry.externalAttributes ?? ((mode << 16) >>> 0);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((host << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(
      entry.centralCompressedBytes ?? entry.compressedContents.byteLength,
      20,
    );
    central.writeUInt32LE(
      entry.centralExpandedBytes ?? entry.contents.byteLength,
      24,
    );
    central.writeUInt16LE(entry.nameBytes.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(entry.startDisk ?? 0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(entry.localOffset, 42);
    return Buffer.concat([central, entry.nameBytes]);
  });
  const localBytes = Buffer.concat(localParts);
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(endOverrides.diskNumber ?? 0, 4);
  end.writeUInt16LE(endOverrides.centralDirectoryDisk ?? 0, 6);
  end.writeUInt16LE(endOverrides.diskEntryCount ?? entries.length, 8);
  end.writeUInt16LE(endOverrides.entryCount ?? entries.length, 10);
  end.writeUInt32LE(endOverrides.centralDirectorySize ?? centralBytes.byteLength, 12);
  end.writeUInt32LE(endOverrides.centralDirectoryOffset ?? localBytes.byteLength, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBytes, centralBytes, end]);
}

function sourceManifest(files) {
  return new Map(Object.entries(files).map(([relativePath, contents]) => {
    const bytes = Buffer.from(contents);
    return [relativePath, {
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }];
  }));
}

function safeEnvironment(overrides = {}) {
  return {
    FF132_STAGING_PROJECT_ID: D1N_STAGING_PROJECT_ID,
    FF132_STAGING_ACK: FF132_STAGING_ACKNOWLEDGEMENT,
    FF132_STAGING_MAINTENANCE_ACK:
      FF132_STAGING_MAINTENANCE_ACKNOWLEDGEMENT,
    FF132_DEPLOYED_RELEASE_REVISION: REVISION,
    ...overrides,
  };
}

function strictAvailabilityBaseline(overrides = {}) {
  const lastSuccessfulSyncAt = new Date(Date.now() - 10 * 60 * 1_000);

  return {
    status: 'success',
    trigger: 'draft-readiness-server',
    updatedBy: 'server:draft-readiness-injury-refresh',
    refreshAttemptId: 'strict-source-attempt-1',
    draftReadinessSourceSchemaVersion: 2,
    draftReadinessSourceComplete: true,
    draftReadinessSourceAttemptId: 'strict-source-attempt-1',
    draftReadinessSourceIssues: [],
    draftReadinessSourceObservedAt: new Date(lastSuccessfulSyncAt.getTime() - 1_000),
    draftReadinessNhlRosterIdentityHash: 'd'.repeat(64),
    draftReadinessNhlTeamCount: 32,
    // ESPN reports only NHL teams represented by its current injury feed.
    draftReadinessEspnTeamCount: 25,
    draftReadinessEspnTeamGroupCount: 25,
    draftReadinessEspnMalformedTeamGroupCount: 0,
    draftReadinessEspnMalformedInjuryEntryCount: 0,
    draftReadinessEspnDuplicateTeamGroupCount: 0,
    draftReadinessAmbiguousIdentityCount: 0,
    draftReadinessMissingAliasTargetCount: 0,
    draftReadinessConsecutiveFailureCount: 0,
    draftReadinessRetryAfterAt: null,
    draftReadinessEspnInjuryEntryCount: 61,
    draftReadinessNameNotFoundAdvisoryCount: 2,
    records: [
      { playerId: 1, status: 'healthy' },
      { playerId: 2, status: 'out' },
    ],
    syncedRecordCount: 2,
    lastSuccessfulSyncAt,
    lastDailySyncKey: lastSuccessfulSyncAt.toISOString().slice(0, 10),
    ...overrides,
  };
}

function deployedFunctionInventory() {
  return FF132_REQUIRED_STAGING_FUNCTIONS.map((name) => {
    const serviceName = name.toLowerCase();
    const source = {
      bucket: `gcf-v2-sources-817415114086-${FF132_REGION}`,
      object: `${name}/function-source.zip`,
      generation: '1788999999000000',
    };

    return {
      name:
        `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/functions/${name}`,
      state: 'ACTIVE',
      labels: { 'firebase-functions-hash': SOURCE_HASH },
      buildConfig: {
        runtime: 'nodejs22',
        entryPoint: name,
        build:
          `projects/817415114086/locations/${FF132_REGION}/builds/` +
          '11111111-2222-3333-4444-555555555555',
        serviceAccount:
          `projects/${D1N_STAGING_PROJECT_ID}/serviceAccounts/${SERVICE_ACCOUNT}`,
        source: { storageSource: source },
        sourceProvenance: { resolvedStorageSource: source },
      },
      serviceConfig: {
        revision: `${serviceName}-00001-abc`,
        allTrafficOnLatestRevision: true,
        service:
          `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/services/${serviceName}`,
        uri: `https://${serviceName}-abcdefghijkl-uc.a.run.app`,
        serviceAccountEmail: SERVICE_ACCOUNT,
      },
    };
  });
}

function cloudRunDeployment(deployedFunction) {
  const storageUri =
    `gs://${deployedFunction.source.bucket}/${deployedFunction.source.object}` +
    `#${deployedFunction.source.generation}`;
  const buildId = deployedFunction.buildName.split('/').at(-1);
  const imageDigest =
    `us-docker.pkg.dev/${D1N_STAGING_PROJECT_ID}/gcf-artifacts/` +
    `${deployedFunction.serviceName}@sha256:${'e'.repeat(64)}`;

  return {
    service: {
      metadata: {
        name: deployedFunction.serviceName,
        labels: { 'firebase-functions-hash': deployedFunction.sourceHash },
        annotations: {
          'run.googleapis.com/build-name': deployedFunction.buildName,
          'run.googleapis.com/build-source-location': storageUri,
          'run.googleapis.com/build-function-target': deployedFunction.name,
        },
      },
      spec: {
        template: {
          metadata: {
            labels: { 'firebase-functions-hash': deployedFunction.sourceHash },
          },
        },
      },
      status: {
        latestCreatedRevisionName: deployedFunction.revision,
        latestReadyRevisionName: deployedFunction.revision,
        url: deployedFunction.uri,
        traffic: [{ revisionName: deployedFunction.revision, percent: 100 }],
      },
    },
    revision: {
      metadata: {
        name: deployedFunction.revision,
        labels: { 'firebase-functions-hash': deployedFunction.sourceHash },
        annotations: {
          'run.googleapis.com/build-id': JSON.stringify({ worker: buildId }),
          'run.googleapis.com/build-source-location': JSON.stringify({
            worker: storageUri,
          }),
        },
      },
      spec: {
        serviceAccountName: deployedFunction.serviceAccountEmail,
        containers: [{ image: imageDigest }],
      },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
        imageDigest,
      },
    },
  };
}

function schedulerJob(overrides = {}) {
  const uri =
    'https://runscheduleddraftautomation-abcdefghijkl-uc.a.run.app/scheduler';
  const baseline = {
    name:
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/jobs/` +
      FF132_DRAFT_SCHEDULER_JOB,
    state: 'ENABLED',
    schedule: '* * * * *',
    timeZone: 'UTC',
    attemptDeadline: '540s',
    lastAttemptTime: '2026-09-09T20:00:00.000Z',
    scheduleTime: '2026-09-09T20:01:00.000Z',
    status: {},
    httpTarget: {
      httpMethod: 'POST',
      uri,
      oidcToken: {
        audience: uri,
        serviceAccountEmail: SERVICE_ACCOUNT,
      },
    },
    retryConfig: {
      retryCount: 0,
      maxRetryDuration: '0s',
      minBackoffDuration: '5s',
      maxBackoffDuration: '3600s',
      maxDoublings: 5,
    },
  };

  return { ...baseline, ...overrides };
}

function schedulerFunction() {
  return {
    name: 'runScheduledDraftAutomation',
    uri: 'https://runscheduleddraftautomation-abcdefghijkl-uc.a.run.app/scheduler',
    serviceAccountEmail: SERVICE_ACCOUNT,
  };
}

function availabilityQueue(overrides = {}) {
  const baseline = {
    name:
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/` +
      FF132_AVAILABILITY_TASK_QUEUE,
    state: 'RUNNING',
    rateLimits: { maxConcurrentDispatches: 1 },
    retryConfig: {
      maxAttempts: 3,
      minBackoff: '30s',
      maxBackoff: '120s',
      maxDoublings: 2,
    },
  };

  return { ...baseline, ...overrides };
}

function projectionQueue(overrides = {}) {
  const baseline = {
    name:
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/` +
      FF132_PROJECTION_TASK_QUEUE,
    state: 'RUNNING',
    rateLimits: {
      maxConcurrentDispatches: 2,
      maxDispatchesPerSecond: 500,
      maxBurstSize: 100,
    },
    retryConfig: {
      maxAttempts: 1,
      minBackoff: '0.100s',
      maxBackoff: '3600s',
      maxDoublings: 16,
    },
  };

  return { ...baseline, ...overrides };
}

function draftClockQueue(overrides = {}) {
  const baseline = {
    name:
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/` +
      FF132_DRAFT_CLOCK_TASK_QUEUE,
    state: 'RUNNING',
    rateLimits: {
      maxConcurrentDispatches: 10,
      maxDispatchesPerSecond: 500,
      maxBurstSize: 100,
    },
    retryConfig: {
      maxAttempts: 5,
      minBackoff: '2s',
      maxBackoff: '3600s',
      maxDoublings: 16,
    },
  };

  return { ...baseline, ...overrides };
}

function cloudRunRequestLog(deployedFunction, status, timestamp) {
  return {
    timestamp: new Date(timestamp).toISOString(),
    resource: {
      type: 'cloud_run_revision',
      labels: {
        project_id: D1N_STAGING_PROJECT_ID,
        location: FF132_REGION,
        service_name: deployedFunction.serviceName,
        revision_name: deployedFunction.revision,
      },
    },
    labels: { 'firebase-functions-hash': deployedFunction.sourceHash },
    httpRequest: {
      requestMethod: 'POST',
      userAgent: 'Google-Cloud-Tasks; (+https://cloud.google.com/tasks)',
      status,
      latency: '0.500s',
    },
  };
}

function draftAutomationMarker(timestamp, overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'success',
    activeDraftCount: 1,
    picksMade: 0,
    failedDraftCount: 0,
    failures: [],
    durationMilliseconds: 750,
    lastRunAt: new Date(timestamp).toISOString(),
    ...overrides,
  };
}

function publicEvidenceInput(overrides = {}) {
  return {
    deployedRuntimeRevision: REVISION,
    toolingRevision: TOOLING_REVISION,
    releaseManifestMatched: true,
    cleanPushedToolingDelta: true,
    requiredStagingFunctionsActive: true,
    exactFunctionSourceMatched: true,
    cloudRunRevisionMatched: true,
    schedulerConfigurationMatched: true,
    taskQueueConfigurationMatched: true,
    boundedDraftInventory: true,
    availabilityQueueInitiallyEmpty: true,
    projectionQueueInitiallyEmpty: true,
    draftClockQueueInitiallyEmpty: true,
    strictSchema2Baseline: true,
    availabilityRecordsUnchanged: true,
    naturalAvailabilityBoundary: true,
    naturalAvailabilitySchedulerObserved: true,
    availabilityBoundaryLatencyMilliseconds: 1_200,
    activeLeaseFirstDelivery: true,
    exactFirstTaskFailureObserved: true,
    duplicateAvailabilityQueueConverged: true,
    retryUsedCurrentBaseline: true,
    retryEvidenceScope: 'singleton-revision-correlated',
    availabilityRetryDelayMilliseconds: 31_000,
    nearZeroStayedFailClosed: true,
    rescheduleRecovered: true,
    naturalProjectionBoundary: true,
    naturalProjectionSchedulerObserved: true,
    projectionBoundaryLatencyMilliseconds: 1_500,
    authoritativeProjectionRequestCount: 1,
    projectionVersion: 11,
    scoringRulesVersion: 4,
    teamScheduleInputComplete: true,
    duplicateProjectionDeliveryConverged: true,
    clockStayedStopped: true,
    pickCount: 0,
    projectionAuditRetained: true,
    draftClockQueueCleaned: true,
    cleanupComplete: true,
    lockReleased: true,
    ...overrides,
  };
}

test('FF1.32 safety requires the exact project, operation, maintenance lease, and revision', () => {
  assert.deepEqual(assertFf132StagingSafety(safeEnvironment()), {
    deployedRevision: REVISION,
    timeoutMilliseconds: 30 * 60 * 1_000,
  });

  assert.throws(
    () => assertFf132StagingSafety(
      safeEnvironment({ FF132_STAGING_PROJECT_ID: 'nhl-fantasy-app-ab673' }),
    ),
    /must equal rinkrat-staging-d1nc-2026/,
  );
  assert.throws(
    () => assertFf132StagingSafety(safeEnvironment({ FF132_STAGING_ACK: 'yes' })),
    /does not authorize this exact isolated staging run/,
  );
  assert.throws(
    () => assertFf132StagingSafety(
      safeEnvironment({ FF132_STAGING_MAINTENANCE_ACK: 'yes' }),
    ),
    /must reserve the isolated shared-state window/,
  );

  for (const deployedRevision of ['', 'abc123', 'A'.repeat(40), 'a'.repeat(39)]) {
    assert.throws(
      () => assertFf132StagingSafety(
        safeEnvironment({ FF132_DEPLOYED_RELEASE_REVISION: deployedRevision }),
      ),
      /exact 40-character staging revision/,
    );
  }
});

test('FF1.32 safety refuses emulators and unbounded runtimes', () => {
  for (const emulatorVariable of [
    'FIRESTORE_EMULATOR_HOST',
    'FIREBASE_AUTH_EMULATOR_HOST',
    'FIREBASE_DATABASE_EMULATOR_HOST',
  ]) {
    assert.throws(
      () => assertFf132StagingSafety(
        safeEnvironment({ [emulatorVariable]: '127.0.0.1:8080' }),
      ),
      /refuses every Emulator Suite environment/,
    );
  }

  for (const timeout of ['899999', '2700001', '900000.5', 'not-a-number']) {
    assert.throws(
      () => assertFf132StagingSafety(
        safeEnvironment({ FF132_STAGING_TIMEOUT_MILLISECONDS: timeout }),
      ),
      /integer from 900000 through 2700000/,
    );
  }

  assert.equal(assertFf132StagingSafety(
    safeEnvironment({ FF132_STAGING_TIMEOUT_MILLISECONDS: '900000' }),
  ).timeoutMilliseconds, 900_000);
  assert.equal(assertFf132StagingSafety(
    safeEnvironment({ FF132_STAGING_TIMEOUT_MILLISECONDS: '2700000' }),
  ).timeoutMilliseconds, 2_700_000);
});

test('clean tooling provenance requires local main to equal its exact origin/main upstream', () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'rinkrat-ff132-git-'));
  const remoteRoot = path.join(temporaryRoot, 'remote.git');
  const repositoryRoot = path.join(temporaryRoot, 'repository');

  try {
    mkdirSync(repositoryRoot, { recursive: true });
    runGit(temporaryRoot, ['init', '--bare', remoteRoot]);
    runGit(repositoryRoot, ['init', '--initial-branch=main']);
    runGit(repositoryRoot, ['config', 'user.name', 'FF1.32 Test']);
    runGit(repositoryRoot, ['config', 'user.email', 'ff132@example.invalid']);
    writeFixtureFile(repositoryRoot, 'package.json', JSON.stringify({
      name: 'ff132-git-fixture',
      scripts: { inherited: 'node --version' },
    }, null, 2));
    runGit(repositoryRoot, ['add', '.']);
    runGit(repositoryRoot, ['commit', '-m', 'runtime baseline']);
    const deployedRevision = runGit(repositoryRoot, ['rev-parse', 'HEAD']);

    for (const relativePath of [
      'docs/RINKRAT_CODEX_HANDOFF.md',
      'docs/RINKRAT_FF1_32_SERVER_OWNED_DRAFT_PREPARATION_STAGING.md',
      'scripts/capacity/run-ff132-server-owned-draft-preparation-staging-evidence.mjs',
      'test/batchff1-16-server-owned-draft-preparation-staging/server-owned-draft-preparation-staging.test.mjs',
    ]) {
      writeFixtureFile(repositoryRoot, relativePath, `${relativePath}\n`);
    }
    writeFixtureFile(repositoryRoot, 'package.json', JSON.stringify({
      name: 'ff132-git-fixture',
      scripts: {
        inherited: 'node --version',
        'staging:ff1:exercise-server-preparation':
          'node --no-warnings --experimental-strip-types scripts/capacity/run-ff132-server-owned-draft-preparation-staging-evidence.mjs',
        'test:batchff1-16:run':
          'node --no-warnings --experimental-strip-types --test --test-concurrency=1 test/batchff1-16-server-owned-draft-preparation-staging/*.test.mjs',
        'verify:batchff1-16:core':
          'npm run verify:batchff1-15:core && npm run test:batchff1-16:run && npm run validate:release-manifest',
        'verify:batchff1-16':
          'npm run toolchain:verify && npm run verify:batchff1-16:core && npm run security:dependency-audit',
      },
    }, null, 2));
    runGit(repositoryRoot, ['add', '.']);
    runGit(repositoryRoot, ['commit', '-m', 'tooling slice']);
    runGit(repositoryRoot, ['remote', 'add', 'origin', remoteRoot]);
    runGit(repositoryRoot, ['push', '--set-upstream', 'origin', 'main']);

    const exact = readCleanPushedToolingState(deployedRevision, repositoryRoot);
    assert.equal(exact.changedPathCount, 5);
    assert.equal(exact.toolingRevision, runGit(repositoryRoot, ['rev-parse', 'origin/main']));

    runGit(remoteRoot, ['update-ref', 'refs/heads/main', deployedRevision]);
    assert.throws(
      () => readCleanPushedToolingState(deployedRevision, repositoryRoot),
      /live origin\/main ref/,
    );
    runGit(remoteRoot, ['update-ref', 'refs/heads/main', exact.toolingRevision]);

    writeFixtureFile(
      repositoryRoot,
      'docs/RINKRAT_CODEX_HANDOFF.md',
      'unpushed local main must fail\n',
    );
    runGit(repositoryRoot, ['add', '.']);
    runGit(repositoryRoot, ['commit', '-m', 'unpublished change']);
    assert.throws(() => readCleanPushedToolingState(deployedRevision, repositoryRoot));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('the staging manifest gate requires the exact revision, Scoring V4, and Projection V11', async () => {
  const manifest = {
    schemaVersion: 1,
    releaseLabel: 'Release Candidate 65',
    sourceRevision: REVISION,
    scoringRulesVersion: 4,
    projectionVersion: 11,
  };
  const response = (value, ok = true) => async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => value,
  });

  assert.deepEqual(await verifyFf132StagingManifest(REVISION, response(manifest)), manifest);
  await assert.rejects(
    verifyFf132StagingManifest(REVISION, response({ ...manifest, schemaVersion: 2 })),
    /manifest schema/,
  );
  await assert.rejects(
    verifyFf132StagingManifest(REVISION, response({ ...manifest, releaseLabel: 'Unreviewed' })),
    /release label/,
  );
  await assert.rejects(
    verifyFf132StagingManifest('f'.repeat(40), response(manifest)),
    /runtime revision is not exact/,
  );
  await assert.rejects(
    verifyFf132StagingManifest(REVISION, response({ ...manifest, scoringRulesVersion: 5 })),
    /Scoring V4/,
  );
  await assert.rejects(
    verifyFf132StagingManifest(REVISION, response({ ...manifest, projectionVersion: 12 })),
    /Projection V11/,
  );
  await assert.rejects(
    verifyFf132StagingManifest(REVISION, response({}, false)),
    /HTTP 503/,
  );
});

test('all nine Functions require one exact source generation and complete deployment identity', () => {
  const inventory = deployedFunctionInventory();
  const verified = assertFf132StagingFunctionInventory(inventory);

  assert.equal(verified.length, FF132_REQUIRED_STAGING_FUNCTIONS.length);
  assert.deepEqual(verified.map((entry) => entry.name), FF132_REQUIRED_STAGING_FUNCTIONS);
  assert.equal(new Set(verified.map((entry) => entry.sourceHash)).size, 1);
  assert.equal(verified.every((entry) => entry.source.generation === '1788999999000000'), true);

  const cases = [
    [inventory.slice(1), /required staging Function .* is missing/],
    [inventory.map((entry, index) => index === 0
      ? { ...entry, state: 'FAILED' }
      : entry), /not ACTIVE/],
    [inventory.map((entry, index) => index === 0
      ? { ...entry, buildConfig: { ...entry.buildConfig, runtime: 'nodejs20' } }
      : entry), /not on Node 22/],
    [inventory.map((entry, index) => index === 0
      ? {
          ...entry,
          buildConfig: {
            ...entry.buildConfig,
            sourceProvenance: {
              resolvedStorageSource: {
                ...entry.buildConfig.source.storageSource,
                generation: '2',
              },
            },
          },
        }
      : entry), /resolved deployed source/],
    [inventory.map((entry, index) => index === 0
      ? { ...entry, labels: { 'firebase-functions-hash': 'f'.repeat(40) } }
      : entry), /do not share one exact deployed source package/],
  ];

  for (const [invalid, pattern] of cases) {
    assert.throws(() => assertFf132StagingFunctionInventory(invalid), pattern);
  }
});

test('Cloud Run must route 100 percent to the verified immutable revision and image', () => {
  const [deployedFunction] = assertFf132StagingFunctionInventory(deployedFunctionInventory());
  const baseline = cloudRunDeployment(deployedFunction);

  assert.equal(assertFf132CloudRunDeployment(
    deployedFunction,
    baseline.service,
    baseline.revision,
  ), true);

  const invalidDeployments = [
    (copy) => { copy.service.status.traffic[0].percent = 90; },
    (copy) => {
      copy.revision.metadata.annotations['run.googleapis.com/build-source-location'] =
        JSON.stringify({ worker: 'gs://other/source.zip#1' });
    },
    (copy) => { copy.revision.spec.containers[0].image = 'image:latest'; },
    (copy) => { copy.revision.status.conditions[0].status = 'False'; },
  ];

  for (const mutate of invalidDeployments) {
    const invalid = structuredClone(baseline);
    mutate(invalid);
    assert.throws(() => assertFf132CloudRunDeployment(
      deployedFunction,
      invalid.service,
      invalid.revision,
    ));
  }
});

test('Function archive proof compares exact paths, byte lengths, and hashes', () => {
  const local = new Map([
    ['package.json', { byteLength: 81, sha256: '1'.repeat(64) }],
    ['src/lib/runtime.ts', { byteLength: 144, sha256: '2'.repeat(64) }],
    ['scripts/lib/deploy-input.mjs', { byteLength: 233, sha256: '3'.repeat(64) }],
  ]);

  assert.equal(assertExactFunctionSourceManifest(local, new Map(local)), 3);

  const wrongLength = new Map(local);
  wrongLength.set('src/lib/runtime.ts', {
    ...wrongLength.get('src/lib/runtime.ts'),
    byteLength: 145,
  });
  assert.throws(() => assertExactFunctionSourceManifest(local, wrongLength), /differs/);

  const wrongHash = new Map(local);
  wrongHash.set('scripts/lib/deploy-input.mjs', {
    ...wrongHash.get('scripts/lib/deploy-input.mjs'),
    sha256: '4'.repeat(64),
  });
  assert.throws(() => assertExactFunctionSourceManifest(local, wrongHash), /differs/);

  const missing = new Map(local);
  missing.delete('package.json');
  assert.throws(() => assertExactFunctionSourceManifest(local, missing), /differs/);

  const extra = new Map(local);
  extra.set('src/unreviewed.ts', { byteLength: 1, sha256: '5'.repeat(64) });
  assert.throws(() => assertExactFunctionSourceManifest(local, extra), /differs/);
});

test('Function archives allow nested lib source while rejecting unsafe or duplicate paths', () => {
  assert.equal(assertSafeArchiveEntries([
    'package.json',
    'src/lib/runtime.ts',
    'scripts/lib/deploy-input.mjs',
  ]), 3);

  for (const entries of [
    [],
    ['/absolute.ts'],
    ['../outside.ts'],
    ['src/../outside.ts'],
    ['src/runtime\0.ts'],
    ['a'.repeat(501)],
    Array.from({ length: 1_001 }, (_, index) => `src/${index}.ts`),
    ['src/runtime.ts', 'src\\runtime.ts'],
  ]) {
    assert.throws(() => assertSafeArchiveEntries(entries));
  }
});

test('source ZIP metadata rejects unsafe paths, types, encryption, and size/header divergence', () => {
  const files = {
    'package.json': '{"name":"functions"}\n',
    'src/lib/runtime.ts': 'export const runtime = true;\n',
  };
  const manifest = sourceManifest(files);
  const entries = Object.entries(files).map(([name, contents]) => ({ name, contents }));

  assert.equal(assertFf132SourceArchiveBuffer(buildSourceZip(entries), manifest), 2);
  assert.equal(assertFf132SourceArchiveBuffer(buildSourceZip(
    entries.map((entry) => ({ ...entry, method: 8 })),
  ), manifest), 2);
  assert.equal(assertFf132SourceArchiveBuffer(buildSourceZip([
    { name: 'src/', contents: '' },
    ...entries,
  ]), manifest), 3);

  const invalidArchives = [
    buildSourceZip([{ ...entries[0], flags: 1 }, entries[1]]),
    buildSourceZip([{ ...entries[0], method: 99 }, entries[1]]),
    buildSourceZip([{ ...entries[0], unixMode: 0o120777 }, entries[1]]),
    buildSourceZip([{ ...entries[0], host: 7 }, entries[1]]),
    buildSourceZip([{ ...entries[0], startDisk: 1 }, entries[1]]),
    buildSourceZip([{ ...entries[0], centralExpandedBytes: 999 }, entries[1]]),
    buildSourceZip([{ ...entries[0], localName: 'other.json' }, entries[1]]),
    buildSourceZip([{ ...entries[0], localMethod: 8 }, entries[1]]),
    buildSourceZip([{ name: '/package.json', contents: entries[0].contents }, entries[1]]),
    buildSourceZip([{ name: '../package.json', contents: entries[0].contents }, entries[1]]),
    buildSourceZip([{ name: 'src/\u0001runtime.ts', contents: entries[0].contents }, entries[1]]),
    buildSourceZip(entries, { diskNumber: 1 }),
    buildSourceZip(entries, { centralDirectoryDisk: 1 }),
    buildSourceZip(entries, { diskEntryCount: 1 }),
    buildSourceZip(entries, { centralDirectorySize: 1 }),
  ];

  for (const archive of invalidArchives) {
    assert.throws(() => assertFf132SourceArchiveBuffer(archive, manifest));
  }

  const backslashContents = 'backslash';
  assert.throws(
    () => assertFf132SourceArchiveBuffer(
      buildSourceZip([{ name: 'src\\runtime.ts', contents: backslashContents }]),
      sourceManifest({ 'src/runtime.ts': backslashContents }),
    ),
    /path|backslash/i,
  );
  const caseFiles = { 'src/A.ts': 'one', 'src/a.ts': 'two' };
  assert.throws(
    () => assertFf132SourceArchiveBuffer(
      buildSourceZip(Object.entries(caseFiles).map(([name, contents]) => ({ name, contents }))),
      sourceManifest(caseFiles),
    ),
    /Case-colliding/,
  );
  const unicodeFiles = {
    'src/caf\u00e9.ts': 'composed',
    'src/cafe\u0301.ts': 'decomposed',
  };
  assert.throws(
    () => assertFf132SourceArchiveBuffer(
      buildSourceZip(Object.entries(unicodeFiles).map(([name, contents]) => ({
        name,
        contents,
        flags: 0x800,
      }))),
      sourceManifest(unicodeFiles),
    ),
    /Case-colliding/,
  );

  assert.throws(() => assertFf132SourceArchiveBuffer(Buffer.from('not-a-zip'), manifest));
  assert.throws(() => assertFf132SourceArchiveBuffer(buildSourceZip(entries), new Map()));

  const bombContents = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const forgedBomb = buildSourceZip([{
    name: 'package.json',
    contents: bombContents,
    method: 8,
    localExpandedBytes: 1,
    centralExpandedBytes: 1,
  }]);
  assert.ok(forgedBomb.byteLength < 10_000, 'The regression fixture must remain compact.');
  assert.throws(
    () => assertFf132SourceArchiveBuffer(
      forgedBomb,
      sourceManifest({ 'package.json': 'x' }),
    ),
    /output length|expanded|larger/i,
  );

  const sameLengthWrongHash = new Map(manifest);
  sameLengthWrongHash.set('package.json', {
    byteLength: Buffer.byteLength(files['package.json']),
    sha256: '0'.repeat(64),
  });
  assert.throws(
    () => assertFf132SourceArchiveBuffer(buildSourceZip(entries), sameLengthWrongHash),
    /hash changed/,
  );
});

test('source-archive orchestration installs the clean Git tree before exact byte comparison', async () => {
  const sourceFiles = new Map([
    ['package.json', '{"scripts":{"build":"tsc"}}\n'],
    ['src/lib/runtime.ts', 'export const runtime = true;\n'],
  ]);
  const deployedFunction = {
    name: 'executeDraftCommand',
    source: {
      bucket: `gcf-v2-sources-817415114086-${FF132_REGION}`,
      object: 'executeDraftCommand/function-source.zip',
      generation: '1788999999000000',
    },
  };

  function commandRunner(deployedRuntime = sourceFiles.get('src/lib/runtime.ts')) {
    const calls = [];
    const writeTree = (root, runtime) => {
      for (const [relativePath, contents] of sourceFiles) {
        const absolutePath = path.join(root, relativePath);
        mkdirSync(path.dirname(absolutePath), { recursive: true });
        writeFileSync(
          absolutePath,
          relativePath === 'src/lib/runtime.ts' ? runtime : contents,
        );
      }
    };

    return {
      calls,
      run(command, args, options = {}) {
        calls.push({ command, args: [...args], options: { ...options } });

        if (command === 'tar') {
          writeTree(path.join(args.at(-1), 'functions'), sourceFiles.get('src/lib/runtime.ts'));
        } else if (command === 'gcloud') {
          writeFileSync(args[3], buildSourceZip(
            [...sourceFiles].map(([name, contents]) => ({ name, contents })),
          ));
        } else if (command === 'unzip' && args[0] === '-qq') {
          writeTree(args.at(-1), deployedRuntime);
        }

        return '';
      },
    };
  }

  const exact = commandRunner();
  assert.equal(await verifyFf132DeployedFunctionSourceArchives(
    [deployedFunction],
    REVISION,
    { commandRunner: exact.run.bind(exact) },
  ), 1);
  assert.deepEqual(exact.calls.map(({ command, args }) => `${command}:${args[0]}`), [
    'git:archive',
    'tar:-xf',
    'npm:ci',
    'npm:run',
    'gcloud:storage',
    'unzip:-qq',
  ]);
  assert.deepEqual(exact.calls[2].args, [
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  assert.deepEqual(exact.calls[3].args, ['run', 'build']);
  assert.equal(exact.calls[2].options.cwd, exact.calls[3].options.cwd);
  assert.equal(path.basename(exact.calls[2].options.cwd), 'functions');
  assert.equal(exact.calls[2].args.includes('--prefix'), false);
  assert.equal(exact.calls[3].args.includes('--prefix'), false);
  assert.equal(
    exact.calls[4].args[2],
    'gs://gcf-v2-sources-817415114086-us-central1/' +
      'executeDraftCommand/function-source.zip#1788999999000000',
  );

  const mismatch = commandRunner('export const runtime = false;\n');
  await assert.rejects(
    verifyFf132DeployedFunctionSourceArchives(
      [deployedFunction],
      REVISION,
      { commandRunner: mismatch.run.bind(mismatch) },
    ),
    /differs from local source/,
  );
});

test('the natural scheduler is exact and leaves retry evidence inside one five-minute bucket', () => {
  const now = Date.UTC(2026, 8, 9, 20, 0, 1);
  const candidate = getNextSafeNaturalSchedulerMinute(now, 60_000);

  assert.ok(candidate - now >= 60_000);
  assert.equal(Math.floor(candidate / 60_000) % 5, 0);
  assert.ok(FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS < 60_000);

  const before = { lastAttemptMilliseconds: candidate - 60_000 };
  const after = { lastAttemptMilliseconds: candidate + 1_250 };
  assert.equal(assertFf132NaturalSchedulerAttempt(before, after, candidate), 1_250);
  assert.equal(assertFf132NaturalSchedulerAttempt(
    before,
    {
      lastAttemptMilliseconds:
        candidate + FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
    },
    candidate,
  ), FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS);
  assert.throws(() => assertFf132NaturalSchedulerAttempt(after, after, candidate));
  assert.throws(() => assertFf132NaturalSchedulerAttempt(
    before,
    {
      lastAttemptMilliseconds:
        candidate + FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS + 1,
    },
    candidate,
  ));

  assert.doesNotThrow(() => assertFf132UtcWindow(now, now + 30 * 60 * 1_000));
  assert.throws(
    () => assertFf132UtcWindow(
      Date.UTC(2026, 8, 9, 23, 50),
      Date.UTC(2026, 8, 10, 0, 20),
    ),
    /refuses to cross a UTC daily-task boundary/,
  );
});

test('natural scheduler evidence polls through stale metadata and rejects late propagation', async () => {
  const expectedSchedulerMilliseconds = Date.UTC(2026, 8, 9, 20, 0);
  const before = {
    lastAttemptMilliseconds: expectedSchedulerMilliseconds - 60_000,
  };
  const observed = {
    lastAttemptMilliseconds: expectedSchedulerMilliseconds + 12_500,
  };
  const late = {
    lastAttemptMilliseconds:
      expectedSchedulerMilliseconds +
      FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS +
      1,
  };
  const states = [before, { ...before }, observed];
  let readCount = 0;
  const boundedPoll = async (label, readValue, predicate, timeoutMilliseconds) => {
    assert.equal(label, 'test natural scheduler metadata');
    assert.equal(timeoutMilliseconds, 90_000);

    for (let index = 0; index < states.length; index += 1) {
      const state = await readValue();
      if (predicate(state)) {
        return state;
      }
    }

    throw new Error(`${label} did not reach the required state before the bounded timeout.`);
  };

  const result = await waitForFf132NaturalSchedulerAttempt({
    label: 'test natural scheduler metadata',
    before,
    expectedSchedulerMilliseconds,
    readScheduler: async () => states[readCount++],
    timeoutMilliseconds: 90_000,
    waitForImplementation: boundedPoll,
  });
  assert.deepEqual(result, observed);
  assert.equal(readCount, 3);
  assert.equal(
    isFf132NaturalSchedulerAttemptObserved(before, before, expectedSchedulerMilliseconds),
    false,
  );
  assert.equal(
    isFf132NaturalSchedulerAttemptObserved(before, late, expectedSchedulerMilliseconds),
    false,
  );

  await assert.rejects(
    waitForFf132NaturalSchedulerAttempt({
      label: 'test natural scheduler metadata',
      before,
      expectedSchedulerMilliseconds,
      readScheduler: async () => late,
      timeoutMilliseconds: 90_000,
      waitForImplementation: boundedPoll,
    }),
    /did not reach the required state before the bounded timeout/,
  );
});

test('the initial natural scheduler log window excludes later manual duplicate probes', () => {
  const deployedFunction = assertFf132StagingFunctionInventory(
    deployedFunctionInventory(),
  ).find(({ name }) => name === 'runScheduledDraftAutomation');
  const expectedSchedulerMilliseconds = Date.UTC(2026, 8, 9, 20, 0);
  const firstProbeStartedMilliseconds = expectedSchedulerMilliseconds + 30_000;
  const schedulerLog = (timestamp) => {
    const entry = cloudRunRequestLog(deployedFunction, 200, timestamp);
    entry.httpRequest.userAgent =
      'Google-Cloud-Scheduler; (+https://cloud.google.com/scheduler)';
    return entry;
  };
  const entries = [
    schedulerLog(expectedSchedulerMilliseconds + 5_000),
    schedulerLog(expectedSchedulerMilliseconds + 65_000),
    schedulerLog(firstProbeStartedMilliseconds - 2_000),
  ];
  const naturalMaximum = Math.min(
    expectedSchedulerMilliseconds + FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
    firstProbeStartedMilliseconds - 2_000 - 1,
  );

  assert.deepEqual(
    assertFf132RequestLogs(entries, {
      deployedFunction,
      userAgent: 'Google-Cloud-Scheduler',
      minimumTimestamp: expectedSchedulerMilliseconds - 2_000,
      maximumTimestamp: naturalMaximum,
      expectedStatuses: [200],
    }),
    [expectedSchedulerMilliseconds + 5_000],
  );
  assert.throws(() => assertFf132RequestLogs(entries.slice(1), {
    deployedFunction,
    userAgent: 'Google-Cloud-Scheduler',
    minimumTimestamp: expectedSchedulerMilliseconds - 2_000,
    maximumTimestamp: naturalMaximum,
    expectedStatuses: [200],
  }));
});

test('manual scheduler evidence correlates one accepted completion before the next minute', () => {
  const deployedFunction = assertFf132StagingFunctionInventory(
    deployedFunctionInventory(),
  ).find(({ name }) => name === 'runScheduledDraftAutomation');
  const triggerStartedMilliseconds = Date.UTC(2026, 8, 9, 20, 0, 10);
  const maximumCompletionMilliseconds = triggerStartedMilliseconds + 40_000;
  const requestLog = cloudRunRequestLog(
    deployedFunction,
    200,
    triggerStartedMilliseconds + 1_250,
  );
  requestLog.httpRequest.userAgent =
    'Google-Cloud-Scheduler; (+https://cloud.google.com/scheduler)';
  const input = {
    beforeScheduler: {
      lastAttemptMilliseconds: triggerStartedMilliseconds - 30_000,
    },
    afterScheduler: {
      lastAttemptMilliseconds: triggerStartedMilliseconds + 750,
    },
    beforeAutomationMilliseconds: triggerStartedMilliseconds - 30_000,
    afterAutomationMarker: draftAutomationMarker(triggerStartedMilliseconds + 1_500),
    triggerStartedMilliseconds,
    maximumCompletionMilliseconds,
    requestLogs: [requestLog],
    deployedFunction,
    minimumRequestTimestamp: triggerStartedMilliseconds - 2_000,
  };

  assert.equal(assertFf132ManualSchedulerCompletion(input), 1_500);

  const invalidCases = [
    {
      ...input,
      afterScheduler: { ...input.beforeScheduler },
    },
    {
      ...input,
      afterScheduler: {
        lastAttemptMilliseconds: maximumCompletionMilliseconds + 1,
      },
    },
    {
      ...input,
      afterAutomationMarker: draftAutomationMarker(input.beforeAutomationMilliseconds),
    },
    {
      ...input,
      afterAutomationMarker: draftAutomationMarker(maximumCompletionMilliseconds + 1),
    },
    {
      ...input,
      afterScheduler: {
        lastAttemptMilliseconds: triggerStartedMilliseconds + 10_000,
      },
      afterAutomationMarker: draftAutomationMarker(triggerStartedMilliseconds + 1_500),
    },
    {
      ...input,
      requestLogs: [requestLog, structuredClone(requestLog)],
    },
    {
      ...input,
      requestLogs: [{
        ...structuredClone(requestLog),
        httpRequest: { ...requestLog.httpRequest, status: 500 },
      }],
    },
    {
      ...input,
      requestLogs: [{
        ...structuredClone(requestLog),
        labels: { 'firebase-functions-hash': '0'.repeat(40) },
      }],
    },
    {
      ...input,
      afterAutomationMarker: draftAutomationMarker(
        triggerStartedMilliseconds + 1_500,
        { status: 'partial-error', failedDraftCount: 1 },
      ),
    },
    {
      ...input,
      afterAutomationMarker: draftAutomationMarker(
        triggerStartedMilliseconds + 1_500,
        { picksMade: 1 },
      ),
    },
  ];

  for (const invalid of invalidCases) {
    assert.throws(() => assertFf132ManualSchedulerCompletion(invalid));
  }
});

test('Draft automation markers require one successful zero-pick fixture scan', () => {
  const triggerStartedMilliseconds = Date.UTC(2026, 8, 9, 20, 0, 10);
  const markerAt = triggerStartedMilliseconds + 1_500;
  const window = {
    priorLastRunMilliseconds: triggerStartedMilliseconds - 30_000,
    triggerStartedMilliseconds,
    maximumCompletionMilliseconds: triggerStartedMilliseconds + 40_000,
  };
  assert.equal(
    assertFf132DraftAutomationSuccessMarker(draftAutomationMarker(markerAt), window),
    markerAt,
  );

  for (const overrides of [
    { schemaVersion: 2 },
    { status: 'partial-error', failedDraftCount: 1 },
    { activeDraftCount: 0 },
    { activeDraftCount: 2 },
    { picksMade: 1 },
    { failedDraftCount: 1 },
    { failures: [{ message: 'private' }] },
    { durationMilliseconds: -1 },
    { durationMilliseconds: 540_001 },
    { durationMilliseconds: 1.5 },
    { lastRunAt: new Date(window.priorLastRunMilliseconds).toISOString() },
    { lastRunAt: new Date(window.maximumCompletionMilliseconds + 1).toISOString() },
  ]) {
    assert.throws(() => assertFf132DraftAutomationSuccessMarker(
      draftAutomationMarker(markerAt, overrides),
      window,
    ));
  }
});

test('serialized duplicate Scheduler logs map exactly to disjoint successful probe windows', () => {
  const deployedFunction = assertFf132StagingFunctionInventory(
    deployedFunctionInventory(),
  ).find(({ name }) => name === 'runScheduledDraftAutomation');
  const firstTrigger = Date.UTC(2026, 8, 9, 20, 0, 10);
  const probes = [
    {
      triggerStartedMilliseconds: firstTrigger,
      afterAutomationMilliseconds: firstTrigger + 2_000,
    },
    {
      triggerStartedMilliseconds: firstTrigger + 3_000,
      afterAutomationMilliseconds: firstTrigger + 5_000,
    },
  ];
  const schedulerLog = (timestamp, overrides = {}) => {
    const entry = cloudRunRequestLog(deployedFunction, 200, timestamp);
    entry.httpRequest.userAgent =
      'Google-Cloud-Scheduler; (+https://cloud.google.com/scheduler)';
    return Object.assign(entry, overrides);
  };
  const entries = [
    schedulerLog(firstTrigger + 1_000),
    schedulerLog(firstTrigger + 4_000),
  ];
  const options = {
    deployedFunction,
    minimumTimestamp: firstTrigger - 2_000,
    maximumTimestamp: firstTrigger + 7_000,
    probes,
  };

  assert.deepEqual(assertFf132DuplicateSchedulerRequestLogs(entries, options), [
    firstTrigger + 1_000,
    firstTrigger + 4_000,
  ]);
  assert.throws(() => assertFf132DuplicateSchedulerRequestLogs(
    [entries[0]],
    options,
  ));
  assert.throws(() => assertFf132DuplicateSchedulerRequestLogs(
    [entries[0], schedulerLog(firstTrigger + 4_000, {
      labels: { 'firebase-functions-hash': '0'.repeat(40) },
    })],
    options,
  ));
  const wrongStatus = structuredClone(entries);
  wrongStatus[1].httpRequest.status = 500;
  assert.throws(() => assertFf132DuplicateSchedulerRequestLogs(wrongStatus, options));
  const outsideWindow = structuredClone(entries);
  outsideWindow[1].timestamp = new Date(firstTrigger + 7_001).toISOString();
  assert.throws(() => assertFf132DuplicateSchedulerRequestLogs(outsideWindow, {
    ...options,
    maximumTimestamp: firstTrigger + 8_000,
  }));
  assert.throws(() => assertFf132DuplicateSchedulerRequestLogs(entries, {
    ...options,
    probes: [probes[0], {
      triggerStartedMilliseconds: firstTrigger + 1_500,
      afterAutomationMilliseconds: firstTrigger + 5_000,
    }],
  }));
});

test('marker-only Projection probes reserve the Draft-open boundary and disjoint log windows', () => {
  const deployedFunction = assertFf132StagingFunctionInventory(
    deployedFunctionInventory(),
  ).find(({ name }) => name === 'runScheduledDraftAutomation');
  const minuteStart = Date.UTC(2026, 8, 9, 20, 0, 0);
  const deadlineMilliseconds = minuteStart + 50_000;
  const baselineMarker = draftAutomationMarker(minuteStart + 5_000);
  assert.deepEqual(
    assertFf132MarkerOnlySchedulerBaseline(baselineMarker, {
      observedAtMilliseconds: minuteStart + 10_000,
      deadlineMilliseconds,
    }),
    {
      lastRunMilliseconds: minuteStart + 5_000,
      nextNaturalMinuteMilliseconds: minuteStart + 60_000,
    },
  );
  assert.throws(() => assertFf132MarkerOnlySchedulerBaseline(baselineMarker, {
    observedAtMilliseconds: minuteStart + 41_000,
    deadlineMilliseconds: minuteStart + 70_000,
  }), /next natural minute/);
  assert.throws(() => assertFf132MarkerOnlySchedulerBaseline(baselineMarker, {
    observedAtMilliseconds: minuteStart + 10_000,
    deadlineMilliseconds: minuteStart + 29_999,
  }), /Draft-open safety time/);
  assert.throws(() => assertFf132MarkerOnlySchedulerBaseline(
    draftAutomationMarker(minuteStart - 1),
    {
      observedAtMilliseconds: minuteStart + 10_000,
      deadlineMilliseconds,
    },
  ), /current natural minute/);

  const first = buildFf132MarkerOnlySchedulerProbe({
    priorLastRunMilliseconds: minuteStart + 5_000,
    triggerStartedMilliseconds: minuteStart + 10_000,
    afterAutomationMarker: draftAutomationMarker(minuteStart + 12_000),
    deadlineMilliseconds,
    nextNaturalMinuteMilliseconds: minuteStart + 60_000,
  });
  const second = buildFf132MarkerOnlySchedulerProbe({
    priorLastRunMilliseconds: minuteStart + 12_000,
    triggerStartedMilliseconds: minuteStart + 14_001,
    afterAutomationMarker: draftAutomationMarker(minuteStart + 16_000),
    deadlineMilliseconds,
    nextNaturalMinuteMilliseconds: minuteStart + 60_000,
  });
  assert.throws(() => buildFf132MarkerOnlySchedulerProbe({
    priorLastRunMilliseconds: minuteStart + 5_000,
    triggerStartedMilliseconds: minuteStart + 10_000,
    afterAutomationMarker: draftAutomationMarker(minuteStart + 12_000),
    deadlineMilliseconds,
    nextNaturalMinuteMilliseconds: minuteStart + 120_000,
  }), /natural-minute boundary/);
  assert.throws(() => buildFf132MarkerOnlySchedulerProbe({
    priorLastRunMilliseconds: minuteStart + 12_000,
    triggerStartedMilliseconds: minuteStart + 14_000,
    afterAutomationMarker: draftAutomationMarker(minuteStart + 16_000),
    deadlineMilliseconds,
    nextNaturalMinuteMilliseconds: minuteStart + 60_000,
  }), /clock-skew gap/);
  assert.deepEqual(buildFf132MarkerOnlySchedulerProbe({
    priorLastRunMilliseconds: minuteStart + 5_000,
    triggerStartedMilliseconds: minuteStart + 10_000,
    afterAutomationMarker: draftAutomationMarker(minuteStart + 9_000),
    deadlineMilliseconds,
    nextNaturalMinuteMilliseconds: minuteStart + 60_000,
  }), {
    triggerStartedMilliseconds: minuteStart + 10_000,
    afterAutomationMilliseconds: minuteStart + 9_000,
    minimumRequestMilliseconds: minuteStart + 8_000,
    maximumRequestMilliseconds: minuteStart + 9_000,
  });
  assert.deepEqual(first, {
    triggerStartedMilliseconds: minuteStart + 10_000,
    afterAutomationMilliseconds: minuteStart + 12_000,
    minimumRequestMilliseconds: minuteStart + 8_000,
    maximumRequestMilliseconds: minuteStart + 12_000,
  });
  assert.deepEqual(
    assertFf132MarkerOnlyProbeSequence([first, second]),
    [first, second],
  );
  assert.throws(() => assertFf132MarkerOnlyProbeSequence([first]));
  assert.throws(() => assertFf132MarkerOnlyProbeSequence([
    first,
    { ...second, minimumRequestMilliseconds: first.maximumRequestMilliseconds },
  ]), /overlap/);

  const schedulerLog = (timestamp, overrides = {}) => {
    const entry = cloudRunRequestLog(deployedFunction, 200, timestamp);
    entry.httpRequest.userAgent =
      'Google-Cloud-Scheduler; (+https://cloud.google.com/scheduler)';
    return Object.assign(entry, overrides);
  };
  const firstLog = schedulerLog(minuteStart + 11_000);
  assert.equal(assertFf132MarkerOnlySchedulerRequestLog([firstLog], {
    deployedFunction,
    probe: first,
  }), minuteStart + 11_000);
  assert.throws(() => assertFf132MarkerOnlySchedulerRequestLog(
    [firstLog, schedulerLog(minuteStart + 11_500)],
    { deployedFunction, probe: first },
  ));
  assert.throws(() => assertFf132MarkerOnlySchedulerRequestLog(
    [schedulerLog(minuteStart + 11_000, {
      labels: { 'firebase-functions-hash': '0'.repeat(40) },
    })],
    { deployedFunction, probe: first },
  ));
  const wrongStatus = schedulerLog(minuteStart + 11_000);
  wrongStatus.httpRequest.status = 500;
  assert.throws(() => assertFf132MarkerOnlySchedulerRequestLog(
    [wrongStatus],
    { deployedFunction, probe: first },
  ));

  const naturalWindow = getFf132NaturalSchedulerRequestWindow(
    first.minimumRequestMilliseconds - 30_000,
    first,
  );
  assert.deepEqual(naturalWindow, {
    minimumRequestMilliseconds: first.minimumRequestMilliseconds - 32_000,
    maximumRequestMilliseconds: first.minimumRequestMilliseconds - 1,
  });
});

test('natural T-20 proof excludes manual RunJob audits and owns exactly two probe calls', () => {
  const minuteStart = Date.UTC(2026, 8, 9, 20, 0, 0);
  const probes = [
    {
      triggerStartedMilliseconds: minuteStart + 10_000,
      afterAutomationMilliseconds: minuteStart + 12_000,
      minimumRequestMilliseconds: minuteStart + 8_000,
      maximumRequestMilliseconds: minuteStart + 12_000,
    },
    {
      triggerStartedMilliseconds: minuteStart + 15_000,
      afterAutomationMilliseconds: minuteStart + 17_000,
      minimumRequestMilliseconds: minuteStart + 13_000,
      maximumRequestMilliseconds: minuteStart + 17_000,
    },
  ];
  const naturalWindow = {
    minimumRequestMilliseconds: minuteStart - 60_000,
    maximumRequestMilliseconds: minuteStart - 1,
  };
  const schedulerResource =
    `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/jobs/` +
    FF132_DRAFT_SCHEDULER_JOB;
  const runAudit = (timestamp, overrides = {}) => ({
    logName:
      `projects/${D1N_STAGING_PROJECT_ID}/logs/` +
      'cloudaudit.googleapis.com%2Factivity',
    timestamp: new Date(timestamp).toISOString(),
    protoPayload: {
      '@type': 'type.googleapis.com/google.cloud.audit.AuditLog',
      serviceName: 'cloudscheduler.googleapis.com',
      methodName: 'google.cloud.scheduler.v1.CloudScheduler.RunJob',
      resourceName: schedulerResource,
      request: { name: schedulerResource },
      authorizationInfo: [{
        permission: 'cloudscheduler.jobs.run',
        granted: true,
      }],
      status: {},
      ...overrides,
    },
  });
  const requests = [
    runAudit(minuteStart + 10_500),
    runAudit(minuteStart + 15_500),
  ];
  const responseDuplicates = requests.map((entry) => ({
    ...structuredClone(entry),
    protoPayload: {
      ...structuredClone(entry.protoPayload),
      response: { name: schedulerResource },
    },
  }));
  const options = { naturalWindow, probes };

  assert.deepEqual(
    assertFf132SchedulerRunAuditProvenance(
      [...requests, ...responseDuplicates],
      options,
    ),
    [minuteStart + 10_500, minuteStart + 15_500],
  );
  assert.throws(() => assertFf132SchedulerRunAuditProvenance(
    [runAudit(minuteStart - 30_000), ...requests],
    options,
  ), /claimed natural T-20/);
  assert.throws(() => assertFf132SchedulerRunAuditProvenance(
    [requests[0]],
    options,
  ), /probe 2/);
  assert.throws(() => assertFf132SchedulerRunAuditProvenance(
    [runAudit(minuteStart + 3_000), ...requests],
    options,
  ), /unowned manual RunJob/);
  assert.throws(() => assertFf132SchedulerRunAuditProvenance([
    requests[0],
    runAudit(minuteStart + 15_500, {
      resourceName: `${schedulerResource}-other`,
    }),
  ], options), /probe 2/);
});

test('absolute Draft-open safety timeouts cannot extend through the deadline', () => {
  assert.equal(boundFf132TimeoutBeforeDeadline(60_000, 150_000, 100_000), 50_000);
  assert.equal(boundFf132TimeoutBeforeDeadline(10_000, 150_000, 100_000), 10_000);
  assert.throws(() => boundFf132TimeoutBeforeDeadline(60_000, 100_000, 100_000));
  assert.throws(() => boundFf132TimeoutBeforeDeadline(0, 150_000, 100_000));
});

test('safety transactions use one attempt, reserve the full ceiling, and retain timeouts', async () => {
  const successfulOptions = [];
  const successfulPending = new Set();
  const value = await runFf132SingleAttemptTransactionBeforeDeadline({
    firestore: {
      async runTransaction(updateFunction, options) {
        successfulOptions.push(options);
        return updateFunction({ marker: 'transaction' });
      },
    },
    updateFunction: async (transaction) => transaction.marker,
    deadlineMilliseconds: Date.now() + 271_000,
    pendingTransactions: successfulPending,
  });
  assert.equal(value, 'transaction');
  assert.deepEqual(successfulOptions, [{ maxAttempts: 1 }]);
  assert.equal(successfulPending.size, 0);

  let insufficientReserveCalls = 0;
  await assert.rejects(
    runFf132SingleAttemptTransactionBeforeDeadline({
      firestore: {
        async runTransaction() {
          insufficientReserveCalls += 1;
        },
      },
      updateFunction: async () => {},
      deadlineMilliseconds: Date.now() + 269_000,
      pendingTransactions: new Set(),
    }),
    Ff132SafetyTransactionDeadlineError,
  );
  assert.equal(insufficientReserveCalls, 0);

  let settleTransaction;
  let timeoutCalls = 0;
  const timeoutPending = new Set();
  const transaction = new Promise((resolve) => { settleTransaction = resolve; });
  await assert.rejects(
    runFf132SingleAttemptTransactionBeforeDeadline({
      firestore: {
        runTransaction(_updateFunction, options) {
          timeoutCalls += 1;
          assert.deepEqual(options, { maxAttempts: 1 });
          return transaction;
        },
      },
      updateFunction: async () => {},
      deadlineMilliseconds: Date.now() + 271_000,
      pendingTransactions: timeoutPending,
      scheduleDeadline: (callback) => {
        queueMicrotask(callback);
        return Symbol('deadline');
      },
      cancelDeadline: () => {},
    }),
    Ff132SafetyTransactionDeadlineError,
  );
  assert.equal(timeoutCalls, 1);
  assert.equal(timeoutPending.size, 1);
  settleTransaction();
  await Promise.all([...timeoutPending]);
  await Promise.resolve();
  assert.equal(timeoutPending.size, 0);
});

test('final safety parking reconciles commit-response loss and refuses an unowned schedule', async () => {
  const now = Date.now();
  const expectedStartAt = new Date(now + 25 * 60 * 1_000);
  const parkedStartAt = new Date(now + 7 * 24 * 60 * 60 * 1_000);
  const Timestamp = { fromMillis: (milliseconds) => new Date(milliseconds) };
  const FieldValue = {
    delete: () => Symbol('delete'),
    serverTimestamp: () => new Date(),
  };
  let draft = {
    status: 'scheduled',
    clockStatus: 'stopped',
    scheduledStartAt: expectedStartAt,
    startedAt: null,
    completedAt: null,
    nextOverallPick: 1,
    draftedAssetKeys: [],
  };
  const transactionOptions = [];
  let loseFirstCommitResponse = true;
  const snapshot = () => ({ exists: true, data: () => draft });
  const firestore = {
    async runTransaction(updateFunction, options) {
      transactionOptions.push(options);
      const writes = [];
      await updateFunction({
        get: async () => snapshot(),
        set: (_reference, value) => writes.push(value),
      });
      for (const value of writes) {
        draft = { ...draft, ...value };
      }
      if (loseFirstCommitResponse) {
        loseFirstCommitResponse = false;
        throw new Error('private-commit-response-lost');
      }
    },
  };
  const draftRef = {
    firestore,
    get: async () => snapshot(),
    collection: () => ({
      limit: () => ({ get: async () => ({ empty: true, size: 0 }) }),
    }),
  };

  await parkFf132FinalDraftBeforeDeadline({
    draftRef,
    FieldValue,
    Timestamp,
    expectedScheduledStartAt: expectedStartAt,
    parkedStartAt,
    completionDeadlineMilliseconds: now + 10 * 60 * 1_000,
    pendingTransactions: new Set(),
  });
  assert.equal(draft.scheduledStartAt.getTime(), parkedStartAt.getTime());
  assert.deepEqual(transactionOptions, [{ maxAttempts: 1 }]);

  draft = { ...draft, scheduledStartAt: new Date(expectedStartAt.getTime() + 60_000) };
  await assert.rejects(
    parkFf132FinalDraftBeforeDeadline({
      draftRef,
      FieldValue,
      Timestamp,
      expectedScheduledStartAt: expectedStartAt,
      parkedStartAt,
      completionDeadlineMilliseconds: now + 10 * 60 * 1_000,
      pendingTransactions: new Set(),
    }),
    /changed outside runner ownership/,
  );
  assert.equal(transactionOptions.length, 1);
});

test('the scheduler configuration must target the exact verified Function identity and path', () => {
  const job = schedulerJob();
  const fn = schedulerFunction();
  const evidence = assertFf132SchedulerJob(job, fn);

  assert.deepEqual(evidence, {
    lastAttemptMilliseconds: Date.parse(job.lastAttemptTime),
    scheduleTimeMilliseconds: Date.parse(job.scheduleTime),
  });

  const wrongCases = [
    [{ state: 'PAUSED' }, /not enabled/],
    [{ schedule: '*/5 * * * *' }, /not every minute/],
    [{ timeZone: 'America/Los_Angeles' }, /not UTC/],
    [{ attemptDeadline: '60s' }, /deadline changed/],
    [
      { name: job.name.replace(FF132_DRAFT_SCHEDULER_JOB, 'other-job') },
      /identity is unexpected/,
    ],
    [{ httpTarget: { ...job.httpTarget, httpMethod: 'GET' } }, /not POST/],
    [
      { httpTarget: { ...job.httpTarget, uri: fn.uri.replace('/scheduler', '/wrong') } },
      /does not target the verified Function URI/,
    ],
    [
      { httpTarget: { ...job.httpTarget, uri: `${fn.uri}?raw=private` } },
      /Expected values to be strictly equal/,
    ],
    [
      {
        httpTarget: {
          ...job.httpTarget,
          uri: fn.uri.replace('https://', 'https://user:password@'),
        },
      },
      /Expected values to be strictly equal/,
    ],
    [
      {
        httpTarget: {
          ...job.httpTarget,
          oidcToken: { ...job.httpTarget.oidcToken, audience: `${fn.uri}#private` },
        },
      },
      /Expected values to be strictly equal/,
    ],
    [
      {
        httpTarget: {
          ...job.httpTarget,
          oidcToken: {
            ...job.httpTarget.oidcToken,
            serviceAccountEmail: 'other@example.invalid',
          },
        },
      },
      /service account diverges/,
    ],
    [{ retryConfig: { ...job.retryConfig, retryCount: 1 } }, /unexpectedly retries/],
    [{ status: { code: 13 } }, /unhealthy prior attempt/],
  ];

  for (const [override, pattern] of wrongCases) {
    assert.throws(() => assertFf132SchedulerJob(schedulerJob(override), fn), pattern);
  }
  assert.throws(() => assertFf132SchedulerJob(job, { ...fn, name: 'otherFunction' }));
});

test('the availability task queue preserves the reviewed concurrency and retry policy', () => {
  assert.equal(assertFf132AvailabilityTaskQueue(availabilityQueue()), true);

  const queue = availabilityQueue();
  const cases = [
    { state: 'PAUSED' },
    { name: queue.name.replace(FF132_AVAILABILITY_TASK_QUEUE, 'other') },
    { rateLimits: { maxConcurrentDispatches: 2 } },
    { retryConfig: { ...queue.retryConfig, maxAttempts: 4 } },
    { retryConfig: { ...queue.retryConfig, minBackoff: '10s' } },
    { retryConfig: { ...queue.retryConfig, maxBackoff: '300s' } },
    { retryConfig: { ...queue.retryConfig, maxDoublings: 3 } },
  ];

  for (const override of cases) {
    assert.throws(() => assertFf132AvailabilityTaskQueue(availabilityQueue(override)));
  }
});

test('the Projection task queue preserves its exact no-retry dispatch policy', () => {
  assert.equal(assertFf132ProjectionTaskQueue(projectionQueue()), true);

  const queue = projectionQueue();
  const cases = [
    { state: 'PAUSED' },
    { name: queue.name.replace(FF132_PROJECTION_TASK_QUEUE, 'other') },
    { rateLimits: { ...queue.rateLimits, maxConcurrentDispatches: 3 } },
    { rateLimits: { ...queue.rateLimits, maxDispatchesPerSecond: 499 } },
    { rateLimits: { ...queue.rateLimits, maxBurstSize: 99 } },
    { retryConfig: { ...queue.retryConfig, maxAttempts: 2 } },
    { retryConfig: { ...queue.retryConfig, minBackoff: '1s' } },
    { retryConfig: { ...queue.retryConfig, maxBackoff: '120s' } },
    { retryConfig: { ...queue.retryConfig, maxDoublings: 15 } },
  ];

  for (const override of cases) {
    assert.throws(() => assertFf132ProjectionTaskQueue(projectionQueue(override)));
  }
});

test('the Draft-clock queue preserves its exact retry and concurrency policy', () => {
  assert.equal(assertFf132DraftClockTaskQueue(draftClockQueue()), true);

  const queue = draftClockQueue();
  const cases = [
    { state: 'PAUSED' },
    { name: queue.name.replace(FF132_DRAFT_CLOCK_TASK_QUEUE, 'other') },
    { rateLimits: { ...queue.rateLimits, maxConcurrentDispatches: 11 } },
    { rateLimits: { ...queue.rateLimits, maxDispatchesPerSecond: 499 } },
    { rateLimits: { ...queue.rateLimits, maxBurstSize: 99 } },
    { retryConfig: { ...queue.retryConfig, maxAttempts: 4 } },
    { retryConfig: { ...queue.retryConfig, minBackoff: '1s' } },
    { retryConfig: { ...queue.retryConfig, maxBackoff: '120s' } },
    { retryConfig: { ...queue.retryConfig, maxDoublings: 15 } },
  ];

  for (const override of cases) {
    assert.throws(() => assertFf132DraftClockTaskQueue(draftClockQueue(override)));
  }
});

test('scheduled-start task identities are deterministic and cleanup accepts only run-owned IDs', () => {
  const firstStart = 1_789_000_000_000;
  const secondStart = firstStart + 60_000;
  const thirdStart = secondStart + 60_000;
  const fourthStart = thirdStart + 60_000;
  const firstId = buildFf132ScheduledDraftStartTaskId(firstStart);
  const secondId = buildFf132ScheduledDraftStartTaskId(secondStart);
  const thirdId = buildFf132ScheduledDraftStartTaskId(thirdStart);
  const fourthId = buildFf132ScheduledDraftStartTaskId(fourthStart);
  const task = (taskId) => ({
    name:
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/` +
      `${FF132_DRAFT_CLOCK_TASK_QUEUE}/tasks/${taskId}`,
  });

  assert.equal(firstId, 'e0e9c8f8c308b7de274cfb0397b26496b7bae630');
  assert.equal(buildFf132ScheduledDraftStartTaskId(firstStart), firstId);
  assert.notEqual(secondId, firstId);
  assert.notEqual(thirdId, secondId);
  assert.throws(() => buildFf132ScheduledDraftStartTaskId(1.5));
  assert.throws(() => buildFf132ScheduledDraftStartTaskId(Number.MAX_SAFE_INTEGER + 1));

  const allowed = new Set([firstId, secondId, thirdId, fourthId]);
  assert.deepEqual(assertFf132OwnedClockQueueTasks([], allowed), []);
  assert.throws(() => assertFf132OwnedClockQueueTasks([], new Set()));
  assert.deepEqual(
    assertFf132OwnedClockQueueTasks([task(firstId), task(thirdId)], allowed),
    [firstId, thirdId],
  );
  assert.throws(() => assertFf132OwnedClockQueueTasks(
    [task('f'.repeat(40))],
    allowed,
  ), /not owned by this evidence run/);
  assert.throws(() => assertFf132OwnedClockQueueTasks(
    [task(firstId), task(firstId)],
    allowed,
  ), /duplicate IDs/);
  assert.throws(() => assertFf132OwnedClockQueueTasks(
    [task('malformed')],
    allowed,
  ), /identity is malformed/);
  assert.throws(() => assertFf132OwnedClockQueueTasks(
    [{ ...task(firstId), name: task(firstId).name.replace(
      FF132_DRAFT_CLOCK_TASK_QUEUE,
      FF132_AVAILABILITY_TASK_QUEUE,
    ) }],
    allowed,
  ), /full resource identity changed/);
  assert.throws(() => assertFf132OwnedClockQueueTasks(
    Array.from({ length: 11 }, () => task(firstId)),
    allowed,
  ), /unexpectedly large/);
  assert.throws(() => assertFf132OwnedClockQueueTasks(
    [],
    new Set([firstId, secondId, thirdId, fourthId, 'f'.repeat(40)]),
  ));
});

test('Projection requests use one exact availability-bound identity and bounded timestamp order', () => {
  const scheduledStartMilliseconds = 1_789_000_000_000;
  const availabilityRevision = 'a'.repeat(64);
  const requestId = buildFf132ProjectionRequestId(
    scheduledStartMilliseconds,
    availabilityRevision,
  );
  const projectionBoundaryMilliseconds = scheduledStartMilliseconds - 20 * 60 * 1_000;
  const runStartedMilliseconds = projectionBoundaryMilliseconds - 60_000;
  const createdMilliseconds = projectionBoundaryMilliseconds + 1_000;
  const startedMilliseconds = createdMilliseconds + 1_000;
  const completedMilliseconds = startedMilliseconds + 30_000;
  const observedAtMilliseconds = completedMilliseconds + 1_000;
  const temporalEvidence = {
    runStartedMilliseconds,
    projectionBoundaryMilliseconds,
    observedAtMilliseconds,
  };
  const request = {
    schemaVersion: 1,
    requestId,
    status: 'ready',
    leagueId: D1N_FIXTURE_LEAGUE_ID,
    requestedBy: 'server:draft-automation',
    generationReason: 'pre-draft',
    targetCycleNumber: 1,
    teamCount: 10,
    requiredGamesPerCycle: 6,
    availabilityRevision,
    payloadHash: 'b'.repeat(64),
    snapshotId: 'ff132-projection-snapshot',
    snapshotContentHash: 'c'.repeat(64),
    createdAt: new Date(createdMilliseconds),
    startedAt: new Date(startedMilliseconds),
    completedAt: new Date(completedMilliseconds),
    durationMilliseconds: 30_000,
  };

  assert.equal(requestId, 'projection-draft-192cff9347425266d2c1ca068ebb2f50');
  assert.equal(assertFf132ProjectionRequest(
    request,
    requestId,
    availabilityRevision,
    temporalEvidence,
  ), true);
  assert.equal(
    buildFf132ProjectionRequestId(scheduledStartMilliseconds, availabilityRevision),
    requestId,
  );
  assert.notEqual(
    buildFf132ProjectionRequestId(scheduledStartMilliseconds + 1, availabilityRevision),
    requestId,
  );
  assert.notEqual(
    buildFf132ProjectionRequestId(scheduledStartMilliseconds, 'd'.repeat(64)),
    requestId,
  );
  assert.throws(() => buildFf132ProjectionRequestId(1.5, availabilityRevision));
  assert.throws(() => buildFf132ProjectionRequestId(
    Number.MAX_SAFE_INTEGER + 1,
    availabilityRevision,
  ));
  assert.throws(() => buildFf132ProjectionRequestId(scheduledStartMilliseconds, 'private'));

  const invalidRequests = [
    { ...request, requestId: `projection-draft-${'f'.repeat(32)}` },
    { ...request, availabilityRevision: 'd'.repeat(64) },
    {
      ...request,
      createdAt: new Date(projectionBoundaryMilliseconds - 2_001),
    },
    {
      ...request,
      createdAt: new Date(
        projectionBoundaryMilliseconds +
          FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS +
          1,
      ),
      startedAt: new Date(
        projectionBoundaryMilliseconds +
          FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS +
          1,
      ),
      completedAt: new Date(
        projectionBoundaryMilliseconds +
          FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS +
          1,
      ),
    },
    { ...request, createdAt: new Date(startedMilliseconds + 1) },
    { ...request, startedAt: new Date(completedMilliseconds + 1) },
    {
      ...request,
      completedAt: new Date(observedAtMilliseconds + 5_001),
    },
    { ...request, completedAt: null },
    { ...request, durationMilliseconds: -1 },
    { ...request, durationMilliseconds: Number.NaN },
    { ...request, durationMilliseconds: 91_001 },
    { ...request, durationMilliseconds: 30 * 60 * 1_000 + 1 },
  ];

  for (const invalid of invalidRequests) {
    assert.throws(() => assertFf132ProjectionRequest(
      invalid,
      requestId,
      availabilityRevision,
      temporalEvidence,
    ));
  }
  assert.throws(() => assertFf132ProjectionRequest(
    request,
    requestId,
    availabilityRevision,
    {
      ...temporalEvidence,
      runStartedMilliseconds: projectionBoundaryMilliseconds + 1,
    },
  ));
});

test('FF1.32 recomputes the canonical Projection V11 chunk and root hash chain', () => {
  const snapshotId = 'ff132-projection-snapshot';
  const assets = Array.from({ length: 26 }, (_, index) => ({
    assetKey: `player:${index + 1}`,
    displayName: `Fixture Player ${index + 1}`,
    position: index % 6 === 0 ? 'G' : 'C',
    seasonDraftRank: index + 1,
    nested: { beta: index, alpha: true },
  }));
  const chunkInputs = [
    { chunkId: 'chunk-0001', chunkIndex: 0, assets: assets.slice(0, 25) },
    { chunkId: 'chunk-0002', chunkIndex: 1, assets: assets.slice(25) },
  ];
  const metadataInput = {
    snapshotId,
    projectionVersion: 11,
    scoringRulesVersion: 4,
    projectionAsOfDate: '2026-09-09',
    projectionContext: 'live',
    projectionSeason: '20262027',
    teamCount: 10,
    targetCycleNumber: 1,
    requiredGamesPerCycle: 6,
    assetCount: assets.length,
    assetDocumentCount: chunkInputs.length,
    catalogSnapshotId: 'catalog-20262027',
    catalogHash: 'a'.repeat(64),
  };
  const bundle = createProjectionSnapshotHashBundle(metadataInput, chunkInputs);
  const metadata = {
    ...metadataInput,
    activeSnapshotId: snapshotId,
    generatedByAuthority: 'server',
    authoritySchemaVersion: 2,
    snapshotHashSchemaVersion: PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
    snapshotHashAlgorithm: PROJECTION_SNAPSHOT_HASH_ALGORITHM,
    snapshotContentHash: bundle.snapshotContentHash,
    snapshotChunkHashes: bundle.chunkHashes,
  };
  const documents = chunkInputs.map((chunk, index) => ({
    id: chunk.chunkId,
    data: {
      schemaVersion: 3,
      ...chunk,
      assetCount: chunk.assets.length,
      sharedProjectionSnapshotId: snapshotId,
      snapshotHashSchemaVersion: PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
      snapshotHashAlgorithm: PROJECTION_SNAPSHOT_HASH_ALGORITHM,
      chunkHash: bundle.chunkHashes[index],
      snapshotContentHash: bundle.snapshotContentHash,
    },
  }));

  const verified = assertFf132ProjectionSnapshotIntegrity(
    metadata,
    [...documents].reverse(),
  );
  assert.deepEqual(verified.assets, assets);
  assert.deepEqual(verified.chunkHashes, bundle.chunkHashes);
  assert.equal(verified.snapshotContentHash, bundle.snapshotContentHash);

  const assetMutation = structuredClone(documents);
  assetMutation[0].data.assets[0].displayName = 'Tampered Player';
  assert.throws(() => assertFf132ProjectionSnapshotIntegrity(metadata, assetMutation));

  assert.throws(() => assertFf132ProjectionSnapshotIntegrity({
    ...metadata,
    snapshotChunkHashes: [...metadata.snapshotChunkHashes].reverse(),
  }, documents));
  assert.throws(() => assertFf132ProjectionSnapshotIntegrity({
    ...metadata,
    scoringRulesVersion: 5,
  }, documents));
  assert.throws(() => assertFf132ProjectionSnapshotIntegrity({
    ...metadata,
    snapshotHashSchemaVersion: 1,
  }, documents), /current Projection snapshot hash schema/);

  const documentIdMutation = structuredClone(documents);
  documentIdMutation[0].id = 'chunk-0099';
  assert.throws(() => assertFf132ProjectionSnapshotIntegrity(metadata, documentIdMutation));
  const missingStoredChunkId = structuredClone(documents);
  delete missingStoredChunkId[0].data.chunkId;
  assert.throws(() => assertFf132ProjectionSnapshotIntegrity(
    metadata,
    missingStoredChunkId,
  ));
  const duplicateIndex = structuredClone(documents);
  duplicateIndex[1].data.chunkIndex = 0;
  assert.throws(() => assertFf132ProjectionSnapshotIntegrity(metadata, duplicateIndex));
  const gappedIndex = structuredClone(documents);
  gappedIndex[1].data.chunkIndex = 2;
  assert.throws(() => assertFf132ProjectionSnapshotIntegrity(metadata, gappedIndex));
  const chunkAuthorityMutation = structuredClone(documents);
  chunkAuthorityMutation[1].data.sharedProjectionSnapshotId = 'other-snapshot';
  assert.throws(() => assertFf132ProjectionSnapshotIntegrity(
    metadata,
    chunkAuthorityMutation,
  ));

  const shortFirstChunkInputs = [
    { chunkId: 'chunk-0001', chunkIndex: 0, assets: assets.slice(0, 24) },
    { chunkId: 'chunk-0002', chunkIndex: 1, assets: assets.slice(24) },
  ];
  const shortBundle = createProjectionSnapshotHashBundle(
    metadataInput,
    shortFirstChunkInputs,
  );
  const shortDocuments = shortFirstChunkInputs.map((chunk, index) => ({
    id: chunk.chunkId,
    data: {
      schemaVersion: 3,
      ...chunk,
      assetCount: chunk.assets.length,
      sharedProjectionSnapshotId: snapshotId,
      snapshotHashSchemaVersion: PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION,
      snapshotHashAlgorithm: PROJECTION_SNAPSHOT_HASH_ALGORITHM,
      chunkHash: shortBundle.chunkHashes[index],
      snapshotContentHash: shortBundle.snapshotContentHash,
    },
  }));
  assert.throws(() => assertFf132ProjectionSnapshotIntegrity({
    ...metadata,
    snapshotContentHash: shortBundle.snapshotContentHash,
    snapshotChunkHashes: shortBundle.chunkHashes,
  }, shortDocuments), /non-final Projection snapshot chunk is not full/);
});

test('one expected task identity is required before inspecting its first failed delivery', () => {
  const taskId = 'f'.repeat(40);
  const task = {
    name:
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/` +
      `${FF132_AVAILABILITY_TASK_QUEUE}/tasks/${taskId}`,
  };

  assert.equal(assertFf132SingleQueueTask([task], taskId), task);
  assert.throws(() => assertFf132SingleQueueTask([], taskId));
  assert.throws(() => assertFf132SingleQueueTask([
    { ...task, name: task.name.replace(taskId, 'e'.repeat(40)) },
  ], taskId));
  assert.throws(() => assertFf132SingleQueueTask([
    {
      ...task,
      name: task.name.replace(FF132_AVAILABILITY_TASK_QUEUE, FF132_PROJECTION_TASK_QUEUE),
    },
  ], taskId), /full resource identity changed/);
  assert.throws(() => assertFf132SingleQueueTask([task, task], taskId));
});

test('the exact first failed task attempt correlates its deterministic task, 500, and lease', () => {
  const taskId = 'f'.repeat(40);
  const runStartedAt = Date.UTC(2026, 8, 9, 20, 0, 0);
  const createAt = runStartedAt + 1_000;
  const failedRequestStartedAt = runStartedAt + 3_000;
  const failedRequestLatency = 1_250;
  const failedResponseAt = failedRequestStartedAt + failedRequestLatency;
  const leaseEventAt = failedRequestStartedAt + 500;
  const deployedFunction = assertFf132StagingFunctionInventory(
    deployedFunctionInventory(),
  ).find(({ name }) => name === FF132_AVAILABILITY_TASK_QUEUE);
  const failedRequestLog = cloudRunRequestLog(
    deployedFunction,
    500,
    failedRequestStartedAt,
  );
  failedRequestLog.httpRequest.latency = '1.250s';
  const task = {
    name:
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/` +
      `${FF132_AVAILABILITY_TASK_QUEUE}/tasks/${taskId}`,
    createTime: new Date(createAt).toISOString(),
    dispatchCount: 1,
    responseCount: 0,
  };
  const input = {
    task,
    expectedTaskId: taskId,
    runStartedAt,
    leaseEventMilliseconds: leaseEventAt,
    requestLogs: [failedRequestLog],
    deployedFunction,
    minimumTimestamp: failedRequestStartedAt - 1_000,
    maximumTimestamp: failedResponseAt + 1_000,
  };

  assert.deepEqual(assertFf132FirstFailedTaskAttempt(input), {
    createMilliseconds: createAt,
    failedRequestStartedMilliseconds: failedRequestStartedAt,
    failedResponseMilliseconds: failedResponseAt,
  });
  assert.doesNotThrow(() => assertFf132FirstFailedTaskAttempt({
    ...input,
    task: {
      name: task.name,
      createTime: task.createTime,
    },
  }));
  for (const responseCount of [0, 1]) {
    assert.doesNotThrow(() => assertFf132FirstFailedTaskAttempt({
      ...input,
      task: {
        ...task,
        dispatchCount: 0,
        responseCount,
        scheduleTime: 'not-required',
        firstAttempt: null,
        lastAttempt: null,
      },
    }));
  }
  for (const [latency, expectedLatencyMilliseconds] of [
    ['0s', 0],
    ['0.000000001s', 0.000001],
    ['1.000000000s', 1_000],
    ['540s', 540_000],
  ]) {
    const valid = structuredClone(failedRequestLog);
    valid.httpRequest.latency = latency;
    assert.equal(assertFf132FirstFailedTaskAttempt({
      ...input,
      leaseEventMilliseconds: failedRequestStartedAt,
      requestLogs: [valid],
    }).failedResponseMilliseconds, failedRequestStartedAt + expectedLatencyMilliseconds);
  }

  for (const mutateTask of [
    (copy) => { copy.dispatchCount = -1; },
    (copy) => { copy.dispatchCount = 2; },
    (copy) => { copy.dispatchCount = '1'; },
    (copy) => { copy.responseCount = -1; },
    (copy) => { copy.responseCount = 2; },
    (copy) => { copy.responseCount = '1'; },
    (copy) => { copy.createTime = new Date(runStartedAt - 5_001).toISOString(); },
    (copy) => { copy.createTime = new Date(failedRequestStartedAt + 5_001).toISOString(); },
    (copy) => { delete copy.createTime; },
    (copy) => { copy.name = copy.name.replace(taskId, 'e'.repeat(40)); },
  ]) {
    const invalid = structuredClone(task);
    mutateTask(invalid);
    assert.throws(() => assertFf132FirstFailedTaskAttempt({ ...input, task: invalid }));
  }

  for (const mutateLog of [
    (copy) => { copy.resource.labels.revision_name = 'wrong-revision-00001-abc'; },
    (copy) => { copy.labels['firebase-functions-hash'] = '0'.repeat(40); },
    (copy) => { copy.httpRequest.userAgent = 'curl/8.0'; },
    (copy) => { copy.httpRequest.requestMethod = 'GET'; },
    (copy) => { copy.httpRequest.status = 204; },
  ]) {
    const invalid = structuredClone(failedRequestLog);
    mutateLog(invalid);
    assert.throws(() => assertFf132FirstFailedTaskAttempt({
      ...input,
      requestLogs: [invalid],
    }));
  }

  assert.throws(() => assertFf132FirstFailedTaskAttempt({
    ...input,
    requestLogs: [failedRequestLog, structuredClone(failedRequestLog)],
  }));

  for (const latency of [
    null,
    1,
    '',
    '-1s',
    '.5s',
    '1.s',
    '01s',
    '1e3s',
    '1.0000000000s',
    '540.000000001s',
    '541s',
    ' 1s',
  ]) {
    const invalid = structuredClone(failedRequestLog);
    invalid.httpRequest.latency = latency;
    assert.throws(() => assertFf132FirstFailedTaskAttempt({
      ...input,
      requestLogs: [invalid],
    }), String(latency));
  }

  for (const leaseEventMilliseconds of [
    failedRequestStartedAt - 2_001,
    failedResponseAt + 2_001,
  ]) {
    assert.throws(() => assertFf132FirstFailedTaskAttempt({
      ...input,
      leaseEventMilliseconds,
    }));
  }
});

test('request and application logs correlate only the verified revision and source hash', () => {
  const [deployedFunction] = assertFf132StagingFunctionInventory(deployedFunctionInventory());
  const firstAt = Date.UTC(2026, 8, 9, 20, 0, 0);
  const secondAt = firstAt + 31_000;
  const noise = cloudRunRequestLog(deployedFunction, 418, firstAt + 5_000);
  noise.resource.labels.revision_name = 'other-revision-00001-abc';
  const entries = [
    cloudRunRequestLog(deployedFunction, 500, firstAt),
    noise,
    cloudRunRequestLog(deployedFunction, 204, secondAt),
  ];

  assert.deepEqual(assertFf132RequestLogs(entries, {
    deployedFunction,
    userAgent: 'Google-Cloud-Tasks',
    minimumTimestamp: firstAt - 1_000,
    maximumTimestamp: secondAt + 1_000,
    expectedStatuses: [500, 204],
  }), [firstAt, secondAt]);
  assert.throws(() => assertFf132RequestLogs(entries, {
    deployedFunction,
    userAgent: 'Google-Cloud-Tasks',
    minimumTimestamp: firstAt - 1_000,
    maximumTimestamp: secondAt + 1_000,
    expectedStatuses: [200],
  }));

  const firstResponseAt = firstAt + 500;
  assert.equal(assertFf132RetryRequestLogs(entries, {
    deployedFunction,
    minimumTimestamp: firstAt - 1_000,
    maximumTimestamp: secondAt + 1_000,
    firstRequestStartedMilliseconds: firstAt,
    firstResponseMilliseconds: firstResponseAt,
  }), secondAt - firstResponseAt);

  for (const retryDelayMilliseconds of [25_000, 300_000]) {
    const retryAt = firstResponseAt + retryDelayMilliseconds;
    assert.equal(assertFf132RetryRequestLogs([
      cloudRunRequestLog(deployedFunction, 500, firstAt),
      cloudRunRequestLog(deployedFunction, 204, retryAt),
    ], {
      deployedFunction,
      minimumTimestamp: firstAt - 1_000,
      maximumTimestamp: retryAt + 1_000,
      firstRequestStartedMilliseconds: firstAt,
      firstResponseMilliseconds: firstResponseAt,
    }), retryDelayMilliseconds);
  }

  for (const retryDelayMilliseconds of [24_999, 300_001]) {
    const retryAt = firstResponseAt + retryDelayMilliseconds;
    assert.throws(() => assertFf132RetryRequestLogs([
      cloudRunRequestLog(deployedFunction, 500, firstAt),
      cloudRunRequestLog(deployedFunction, 204, retryAt),
    ], {
      deployedFunction,
      minimumTimestamp: firstAt - 1_000,
      maximumTimestamp: retryAt + 1_000,
      firstRequestStartedMilliseconds: firstAt,
      firstResponseMilliseconds: firstResponseAt,
    }));
  }
  assert.throws(() => assertFf132RetryRequestLogs(entries, {
    deployedFunction,
    minimumTimestamp: firstAt - 1_000,
    maximumTimestamp: secondAt + 1_000,
    firstRequestStartedMilliseconds: firstAt + 1,
    firstResponseMilliseconds: firstResponseAt,
  }));
  assert.throws(() => assertFf132RetryRequestLogs(entries, {
    deployedFunction,
    minimumTimestamp: firstAt - 1_000,
    maximumTimestamp: secondAt + 1_000,
    firstRequestStartedMilliseconds: firstAt,
    firstResponseMilliseconds: firstAt - 1,
  }));
  assert.throws(() => assertFf132RetryRequestLogs([
    cloudRunRequestLog(deployedFunction, 500, firstAt),
    cloudRunRequestLog(deployedFunction, 200, secondAt),
  ], {
    deployedFunction,
    minimumTimestamp: firstAt - 1_000,
    maximumTimestamp: secondAt + 1_000,
    firstRequestStartedMilliseconds: firstAt,
    firstResponseMilliseconds: firstResponseAt,
  }));

  const completion = {
    resource: {
      labels: {
        service_name: deployedFunction.serviceName,
        revision_name: deployedFunction.revision,
      },
    },
    labels: { 'firebase-functions-hash': deployedFunction.sourceHash },
    jsonPayload: {
      message: 'Automatic Draft availability preparation completed.',
      status: 'already-current',
    },
  };
  const completionNoise = structuredClone(completion);
  completionNoise.labels['firebase-functions-hash'] = '0'.repeat(40);
  const textCompletion = {
    resource: {
      labels: {
        service_name: deployedFunction.serviceName,
        revision_name: deployedFunction.revision,
      },
    },
    labels: { 'firebase-functions-hash': deployedFunction.sourceHash },
    textPayload:
      "Automatic Draft availability preparation completed. { status: 'already-current' }",
  };

  assert.equal(assertFf132AlreadyCurrentCompletionLog(
    [completionNoise, completion],
    deployedFunction,
  ), true);
  assert.equal(assertFf132AlreadyCurrentCompletionLog(
    [completionNoise, textCompletion],
    deployedFunction,
  ), true);
  assert.throws(() => assertFf132AlreadyCurrentCompletionLog([], deployedFunction));
  assert.throws(() => assertFf132AlreadyCurrentCompletionLog(
    [completion, structuredClone(completion)],
    deployedFunction,
  ));
  assert.throws(() => assertFf132AlreadyCurrentCompletionLog(
    [completion, textCompletion],
    deployedFunction,
  ));

  for (const invalid of [
    {
      ...structuredClone(completion),
      jsonPayload: {
        message: 'Automatic Draft availability preparation completed.',
      },
    },
    {
      ...structuredClone(textCompletion),
      textPayload:
        "Automatic Draft availability preparation completed. { status: 'already-currently' }",
    },
    {
      ...structuredClone(textCompletion),
      textPayload: "Unrelated operation completed { status: 'already-current' }",
    },
    {
      ...structuredClone(textCompletion),
      textPayload:
        "prefix Automatic Draft availability preparation completed. { status: 'already-current' }",
    },
    {
      ...structuredClone(textCompletion),
      textPayload:
        "Automatic Draft availability preparation completed. { status: 'already-current' } suffix",
    },
    completionNoise,
  ]) {
    assert.throws(() => assertFf132AlreadyCurrentCompletionLog(
      [invalid],
      deployedFunction,
    ));
  }
});

test('strict schema-2 availability permits a complete zero-or-partial ESPN feed', () => {
  const data = strictAvailabilityBaseline();
  const attestation = assertStrictSchema2AvailabilityBaseline(
    data,
    Date.now() + 30 * 60 * 1_000,
  );

  assert.equal(attestation.attemptId, data.refreshAttemptId);
  assert.equal(attestation.sourceIdentityHash, data.draftReadinessNhlRosterIdentityHash);
  assert.match(attestation.recordsHash, /^[a-f0-9]{64}$/);
  assert.match(attestation.sourceHash, /^[a-f0-9]{64}$/);

  const zeroInjuryFeed = strictAvailabilityBaseline({
    draftReadinessEspnTeamCount: 0,
    draftReadinessEspnTeamGroupCount: 0,
    draftReadinessEspnInjuryEntryCount: 0,
    records: [],
    syncedRecordCount: 0,
  });
  assert.doesNotThrow(() => assertStrictSchema2AvailabilityBaseline(
    zeroInjuryFeed,
    Date.now() + 30 * 60 * 1_000,
  ));
});

test('strict schema-2 availability rejects incomplete or internally inconsistent evidence', () => {
  const rejectionCases = [
    ['non-server trigger', { trigger: 'manual' }],
    ['wrong schema', { draftReadinessSourceSchemaVersion: 1 }],
    ['incomplete source', { draftReadinessSourceComplete: false }],
    ['attempt mismatch', { draftReadinessSourceAttemptId: 'other-attempt' }],
    ['source issues', { draftReadinessSourceIssues: ['espn-malformed-team-group'] }],
    ['missing NHL team', { draftReadinessNhlTeamCount: 31 }],
    ['unresolved ESPN group', { draftReadinessEspnTeamGroupCount: 26 }],
    ['malformed ESPN group', { draftReadinessEspnMalformedTeamGroupCount: 1 }],
    ['malformed injury entry', { draftReadinessEspnMalformedInjuryEntryCount: 1 }],
    ['duplicate ESPN group', { draftReadinessEspnDuplicateTeamGroupCount: 1 }],
    ['ambiguous identity', { draftReadinessAmbiguousIdentityCount: 1 }],
    ['missing alias target', { draftReadinessMissingAliasTargetCount: 1 }],
    ['active failure sequence', { draftReadinessConsecutiveFailureCount: 1 }],
    ['active retry gate', { draftReadinessRetryAfterAt: new Date() }],
    ['record-count mismatch', { syncedRecordCount: 1 }],
  ];

  for (const [label, overrides] of rejectionCases) {
    assert.throws(
      () => assertStrictSchema2AvailabilityBaseline(
        strictAvailabilityBaseline(overrides),
        Date.now() + 30 * 60 * 1_000,
      ),
      undefined,
      label,
    );
  }

  const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  assert.throws(
    () => assertStrictSchema2AvailabilityBaseline(
      strictAvailabilityBaseline({
        lastSuccessfulSyncAt: staleAt,
        lastDailySyncKey: staleAt.toISOString().slice(0, 10),
        draftReadinessSourceObservedAt: new Date(staleAt.getTime() - 1_000),
      }),
      Date.now() + 30 * 60 * 1_000,
    ),
    /strict availability baseline will expire/i,
  );
});

test('Draft inventory requires the isolated fixture and refuses every competing active Draft', () => {
  const now = Date.UTC(2026, 8, 9, 20, 0, 0);
  const fixture = {
    documentId: 'current',
    leagueId: D1N_FIXTURE_LEAGUE_ID,
    draft: {
      status: 'scheduled',
      scheduledStartAt: new Date(now + 30 * 60 * 1_000),
    },
  };
  const terminal = {
    documentId: 'current',
    leagueId: 'other-fixture',
    draft: {
      status: 'complete',
      scheduledStartAt: new Date(now + 3 * 60 * 60 * 1_000),
    },
  };
  const setup = {
    documentId: 'current',
    leagueId: 'setup-fixture',
    draft: { status: 'setup' },
  };

  assert.equal(assertFf132DraftInventory([fixture, terminal, setup], now), 3);
  assert.throws(
    () => assertFf132DraftInventory([terminal], now),
    /isolated D1N Draft fixture is missing/,
  );
  assert.throws(
    () => assertFf132DraftInventory([
      fixture,
      { ...terminal, draft: { status: 'live' } },
    ], now),
    /full server automation scan/,
  );
  for (const scheduledStartAt of [
    new Date(now + 30 * 60 * 1_000),
    new Date(now + 30 * 24 * 60 * 60 * 1_000),
  ]) {
    assert.throws(
      () => assertFf132DraftInventory([
        fixture,
        {
          ...terminal,
          draft: { status: 'scheduled', scheduledStartAt },
        },
      ], now),
      /full server automation scan/,
    );
  }
  assert.throws(
    () => assertFf132DraftInventory(Array.from({ length: 51 }, () => fixture), now),
    /inventory is not bounded/,
  );
});

test('the synthetic Draft fixture remains safely scheduled and untouched before ownership', () => {
  const minimumStartMilliseconds = Date.UTC(2026, 8, 9, 20, 2, 0);
  const safeStartMilliseconds = minimumStartMilliseconds + 60_000;
  const safeDraft = {
    status: 'scheduled',
    clockStatus: 'stopped',
    scheduledStartAt: new Date(safeStartMilliseconds),
    startedAt: null,
    completedAt: null,
    pickStartedAt: null,
    nextOverallPick: 1,
    draftedAssetKeys: [],
  };

  assert.equal(
    assertFf132SyntheticDraftSafety(safeDraft, minimumStartMilliseconds),
    safeStartMilliseconds,
  );

  const unsafeDrafts = [
    { ...safeDraft, scheduledStartAt: new Date(minimumStartMilliseconds - 1) },
    { ...safeDraft, scheduledStartAt: null },
    { ...safeDraft, status: 'live' },
    { ...safeDraft, clockStatus: 'running' },
    { ...safeDraft, startedAt: new Date(minimumStartMilliseconds - 1_000) },
    { ...safeDraft, completedAt: new Date(minimumStartMilliseconds - 1_000) },
    { ...safeDraft, pickStartedAt: new Date(minimumStartMilliseconds - 1_000) },
    { ...safeDraft, nextOverallPick: 2 },
    { ...safeDraft, draftedAssetKeys: ['must-not-exist'] },
  ];

  for (const draft of unsafeDrafts) {
    assert.throws(() => assertFf132SyntheticDraftSafety(
      draft,
      minimumStartMilliseconds,
    ));
  }
  assert.throws(() => assertFf132SyntheticDraftSafety(safeDraft, 1.5));
});

test('availability cleanup returns only a compare-and-set status/lease patch', () => {
  const baseline = strictAvailabilityBaseline();
  const baselineAttestation = assertStrictSchema2AvailabilityBaseline(
    baseline,
    Date.now() + 30 * 60 * 1_000,
  );
  const overlayLeaseMilliseconds = Date.now() + 15 * 60 * 1_000;
  const current = {
    ...baseline,
    status: 'running',
    leaseExpiresAt: new Date(overlayLeaseMilliseconds),
  };
  const deleteSentinel = Symbol('delete');

  const patch = getFf132AvailabilityRestorePatch({
    current,
    baseline,
    baselineAttestation,
    overlayLeaseMilliseconds,
    deleteSentinel,
  });
  assert.deepEqual(patch, {
    status: 'success',
    leaseExpiresAt: deleteSentinel,
  });
  assert.equal(Object.hasOwn(patch, 'records'), false);
  assert.equal(getFf132AvailabilityRestorePatch({
    current: baseline,
    baseline,
    baselineAttestation,
    overlayLeaseMilliseconds,
    deleteSentinel,
  }), null);

  const baselineWithLease = {
    ...baseline,
    leaseExpiresAt: new Date(Date.now() - 1_000),
  };
  const withLeaseAttestation = assertStrictSchema2AvailabilityBaseline(
    baselineWithLease,
    Date.now() + 30 * 60 * 1_000,
  );
  const withLeasePatch = getFf132AvailabilityRestorePatch({
    current: {
      ...baselineWithLease,
      status: 'running',
      leaseExpiresAt: new Date(overlayLeaseMilliseconds),
    },
    baseline: baselineWithLease,
    baselineAttestation: withLeaseAttestation,
    overlayLeaseMilliseconds,
    deleteSentinel,
  });
  assert.equal(withLeasePatch.leaseExpiresAt, baselineWithLease.leaseExpiresAt);
});

test('availability compare-and-set refuses changed records, metadata, lease, or ownership', () => {
  const baseline = strictAvailabilityBaseline();
  const baselineAttestation = assertStrictSchema2AvailabilityBaseline(
    baseline,
    Date.now() + 30 * 60 * 1_000,
  );
  const overlayLeaseMilliseconds = Date.now() + 15 * 60 * 1_000;
  const current = {
    ...baseline,
    status: 'running',
    leaseExpiresAt: new Date(overlayLeaseMilliseconds),
  };
  const restore = (candidate) => getFf132AvailabilityRestorePatch({
    current: candidate,
    baseline,
    baselineAttestation,
    overlayLeaseMilliseconds,
    deleteSentinel: Symbol('delete'),
  });

  for (const candidate of [
    { ...current, status: 'success' },
    { ...current, leaseExpiresAt: new Date(overlayLeaseMilliseconds + 1) },
    { ...current, refreshAttemptId: 'newer-attempt' },
    { ...current, draftReadinessSourceAttemptId: 'newer-attempt' },
    { ...current, records: [...current.records, { playerId: 3, status: 'out' }] },
    { ...current, newServerField: true },
  ]) {
    assert.throws(() => restore(candidate));
  }
});

test('document hashing preserves Firestore timestamp nanoseconds during CAS comparisons', () => {
  const timestamp = (nanoseconds) => ({
    seconds: 1_789_000_000,
    nanoseconds,
    toMillis() {
      return this.seconds * 1_000 + Math.floor(this.nanoseconds / 1_000_000);
    },
  });
  const first = timestamp(100);
  const second = timestamp(900_000);
  assert.equal(first.toMillis(), second.toMillis());
  assert.notEqual(
    hashFf132DocumentData({ observedAt: first }),
    hashFf132DocumentData({ observedAt: second }),
  );
  assert.equal(
    hashFf132DocumentData({ b: 2, a: first }),
    hashFf132DocumentData({ a: first, b: 2 }),
  );

  const baseline = strictAvailabilityBaseline({ evidenceTimestamp: first });
  const baselineAttestation = assertStrictSchema2AvailabilityBaseline(
    baseline,
    Date.now() + 30 * 60 * 1_000,
  );
  const overlayLeaseMilliseconds = Date.now() + 15 * 60 * 1_000;
  assert.throws(() => getFf132AvailabilityRestorePatch({
    current: {
      ...baseline,
      evidenceTimestamp: second,
      status: 'running',
      leaseExpiresAt: new Date(overlayLeaseMilliseconds),
    },
    baseline,
    baselineAttestation,
    overlayLeaseMilliseconds,
    deleteSentinel: Symbol('delete'),
  }), /changed outside the two runner-owned lease fields/);
});

test('ambiguous lock acquisition reconciles committed ownership without hiding the error', async () => {
  const runId = 'ff132-run-id';
  const timeoutMilliseconds = 15 * 60 * 1_000;
  const Timestamp = {
    fromMillis(milliseconds) {
      return {
        seconds: Math.floor(milliseconds / 1_000),
        nanoseconds: (milliseconds % 1_000) * 1_000_000,
        toMillis: () => milliseconds,
      };
    },
  };
  const snapshot = (data = null) => ({
    exists: data !== null,
    get: (field) => data?.[field],
  });
  const lockRef = { get: async () => snapshot(null) };

  const successful = await acquireFf132EvidenceLock({
    runTransaction: async (callback) => callback({
      get: async () => snapshot(null),
      set: () => {},
    }),
  }, lockRef, Timestamp, runId, timeoutMilliseconds);
  assert.deepEqual(successful, {
    lockOwned: true,
    ownershipUncertain: false,
    acquisitionError: null,
  });

  const ambiguousError = new Error('private-commit-response-lost');
  let committedLock = null;
  const ambiguousLockRef = {
    get: async () => snapshot(committedLock),
  };
  const ambiguous = await acquireFf132EvidenceLock({
    runTransaction: async (callback) => {
      let pendingLock = null;
      await callback({
        get: async () => snapshot(null),
        set: (_ref, value) => { pendingLock = value; },
      });
      committedLock = pendingLock;
      throw ambiguousError;
    },
  }, ambiguousLockRef, Timestamp, runId, timeoutMilliseconds);
  assert.equal(ambiguous.lockOwned, true);
  assert.equal(ambiguous.ownershipUncertain, false);
  assert.equal(ambiguous.acquisitionError, ambiguousError);

  const rejectedError = new Error('private-rejected-before-commit');
  const rejected = await acquireFf132EvidenceLock({
    runTransaction: async () => { throw rejectedError; },
  }, lockRef, Timestamp, runId, timeoutMilliseconds);
  assert.deepEqual(rejected, {
    lockOwned: false,
    ownershipUncertain: false,
    acquisitionError: rejectedError,
  });

  const uncertain = await acquireFf132EvidenceLock({
    runTransaction: async () => { throw rejectedError; },
  }, {
    get: async () => { throw new Error('private-reconciliation-read-failed'); },
  }, Timestamp, runId, timeoutMilliseconds);
  assert.deepEqual(uncertain, {
    lockOwned: false,
    ownershipUncertain: true,
    acquisitionError: rejectedError,
  });
});

test('an ambiguous atomic Draft and availability commit is recognized for safe cleanup', async () => {
  const Timestamp = {
    fromMillis(milliseconds) {
      return {
        seconds: Math.floor(milliseconds / 1_000),
        nanoseconds: (milliseconds % 1_000) * 1_000_000,
        toMillis: () => milliseconds,
      };
    },
  };
  const deleted = Symbol('delete');
  const FieldValue = {
    delete: () => deleted,
    serverTimestamp: () => Timestamp.fromMillis(Date.now()),
  };
  const draftRef = { path: 'leagues/d1n-capacity-league/drafts/current' };
  const availabilityRef = { path: 'appData/draftPlayerAvailability' };
  const initialStartAt = new Date(Date.now() + 30 * 60 * 1_000);
  const leaseExpiresAt = Timestamp.fromMillis(Date.now() + 60 * 60 * 1_000);
  const draftBaseline = {
    status: 'scheduled',
    clockStatus: 'stopped',
    scheduledStartAt: Timestamp.fromMillis(initialStartAt.getTime() - 60_000),
    startedAt: null,
    completedAt: null,
    pickSeconds: 120,
    nextOverallPick: 1,
    draftedAssetKeys: [],
  };
  const availabilityBaseline = strictAvailabilityBaseline();
  const availabilityAttestation = assertStrictSchema2AvailabilityBaseline(
    availabilityBaseline,
    initialStartAt.getTime(),
  );
  const documents = new Map([
    [draftRef, draftBaseline],
    [availabilityRef, availabilityBaseline],
  ]);
  const snapshot = (reference) => ({
    exists: documents.has(reference),
    data: () => documents.get(reference),
  });
  const commitResponseLost = new Error('private-atomic-commit-response-lost');
  const firestore = {
    async runTransaction(callback) {
      const writes = [];
      await callback({
        get: async (reference) => snapshot(reference),
        set: (reference, value, options) => writes.push({ reference, value, options }),
      });
      for (const { reference, value, options } of writes) {
        documents.set(
          reference,
          options?.merge ? { ...documents.get(reference), ...value } : value,
        );
      }
      throw commitResponseLost;
    },
  };

  await assert.rejects(
    prepareFf132InitialEvidenceState({
      firestore,
      FieldValue,
      Timestamp,
      draftRef,
      availabilityRef,
      baseline: availabilityBaseline,
      baselineAttestation: availabilityAttestation,
      initialStartAt,
      leaseExpiresAt,
    }),
    (error) => error === commitResponseLost,
  );

  const ownershipInput = {
    draft: documents.get(draftRef),
    draftBaselineHash: hashFf132DocumentData(draftBaseline),
    plannedScheduledStartMilliseconds: new Set([initialStartAt.getTime()]),
    availability: documents.get(availabilityRef),
    availabilityBaseline,
    availabilityAttestation,
    overlayLeaseMilliseconds: leaseExpiresAt.toMillis(),
  };
  assert.deepEqual(reconcileFf132FixtureOwnership(ownershipInput), {
    draftMutated: true,
    availabilityOverlayOwned: true,
  });
  const parkedStartMilliseconds = initialStartAt.getTime() + 7 * 24 * 60 * 60 * 1_000;
  assert.deepEqual(reconcileFf132FixtureOwnership({
    ...ownershipInput,
    draft: {
      ...ownershipInput.draft,
      scheduledStartAt: Timestamp.fromMillis(parkedStartMilliseconds),
      clockUpdatedBy: 'ff132-staging-evidence-availability-park',
    },
    plannedScheduledStartMilliseconds: new Set([
      initialStartAt.getTime(),
      parkedStartMilliseconds,
    ]),
  }), {
    draftMutated: true,
    availabilityOverlayOwned: true,
  });
  assert.throws(() => reconcileFf132FixtureOwnership({
    ...ownershipInput,
    draft: {
      ...ownershipInput.draft,
      scheduledStartAt: Timestamp.fromMillis(initialStartAt.getTime() + 1),
    },
  }), /unowned schedule/);
  assert.throws(() => reconcileFf132FixtureOwnership({
    ...ownershipInput,
    availability: {
      ...ownershipInput.availability,
      records: [...ownershipInput.availability.records, { playerId: 3, status: 'out' }],
    },
  }));
});

test('atomic preparation rejects a fixture that became near-due or started before ownership', async () => {
  const Timestamp = {
    fromMillis(milliseconds) {
      return {
        seconds: Math.floor(milliseconds / 1_000),
        nanoseconds: (milliseconds % 1_000) * 1_000_000,
        toMillis: () => milliseconds,
      };
    },
  };
  const FieldValue = {
    delete: () => Symbol('delete'),
    serverTimestamp: () => Timestamp.fromMillis(Date.now()),
  };
  const draftRef = { path: 'leagues/d1n-capacity-league/drafts/current' };
  const availabilityRef = { path: 'appData/draftPlayerAvailability' };
  const availability = strictAvailabilityBaseline();
  const initialStartAt = new Date(Date.now() + 30 * 60 * 1_000);
  const baselineAttestation = assertStrictSchema2AvailabilityBaseline(
    availability,
    initialStartAt.getTime(),
  );
  const safeDraft = {
    status: 'scheduled',
    clockStatus: 'stopped',
    scheduledStartAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1_000),
    startedAt: null,
    completedAt: null,
    pickStartedAt: null,
    pickSeconds: 120,
    nextOverallPick: 1,
    draftedAssetKeys: [],
  };
  const unsafeDrafts = [
    {
      label: 'near-due',
      draft: {
        ...safeDraft,
        scheduledStartAt: Timestamp.fromMillis(Date.now() + 60_000),
      },
    },
    { label: 'live status', draft: { ...safeDraft, status: 'live' } },
    { label: 'running clock', draft: { ...safeDraft, clockStatus: 'running' } },
    {
      label: 'started timestamp',
      draft: { ...safeDraft, startedAt: Timestamp.fromMillis(Date.now()) },
    },
    {
      label: 'completed timestamp',
      draft: { ...safeDraft, completedAt: Timestamp.fromMillis(Date.now()) },
    },
    {
      label: 'pick-started timestamp',
      draft: { ...safeDraft, pickStartedAt: Timestamp.fromMillis(Date.now()) },
    },
  ];

  for (const { label, draft } of unsafeDrafts) {
    let transactionSetCount = 0;
    const snapshot = (value) => ({ exists: true, data: () => value });
    const firestore = {
      runTransaction: async (callback) => callback({
        get: async (reference) => snapshot(
          reference === draftRef ? draft : availability,
        ),
        set: () => { transactionSetCount += 1; },
      }),
    };

    await assert.rejects(
      prepareFf132InitialEvidenceState({
        firestore,
        FieldValue,
        Timestamp,
        draftRef,
        availabilityRef,
        baseline: availability,
        baselineAttestation,
        initialStartAt,
        leaseExpiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1_000),
      }),
      undefined,
      label,
    );
    assert.equal(transactionSetCount, 0, label);
  }
});

test('cleanup succeeds only after every independent stage and releases the lock last', async () => {
  const order = [];
  const operation = (name) => async () => { order.push(name); };
  const outcome = await runFf132CleanupStages({
    resetDraft: operation('reset-draft'),
    drainDraftClockQueue: operation('drain-draft-clock-queue'),
    awaitProjectionTerminal: operation('await-projection-terminal'),
    drainProjectionQueue: operation('drain-projection-queue'),
    restoreAvailability: operation('restore-availability'),
    drainAvailabilityQueue: operation('drain-availability-queue'),
    verifyDraftInventory: operation('verify-draft-inventory'),
    markCleanupRequired: operation('mark-cleanup-required'),
    releaseLock: operation('release-lock'),
  });

  assert.deepEqual(order, [
    'reset-draft',
    'drain-draft-clock-queue',
    'await-projection-terminal',
    'drain-projection-queue',
    'restore-availability',
    'drain-availability-queue',
    'verify-draft-inventory',
    'release-lock',
  ]);
  assert.deepEqual(outcome, {
    cleanupComplete: true,
    lockReleased: true,
    failedStageCount: 0,
  });
});

test('cleanup retains a cleanup-required lock after the final park deadline is missed', async () => {
  const order = [];
  const outcome = await runFf132CleanupStages({
    verifyDraftInventory: async () => { order.push('verify-draft-inventory'); },
    markCleanupRequired: async () => { order.push('mark-cleanup-required'); },
    releaseLock: async () => { order.push('release-lock'); },
    retainLock: true,
  });

  assert.deepEqual(order, ['verify-draft-inventory', 'mark-cleanup-required']);
  assert.deepEqual(outcome, {
    cleanupComplete: false,
    lockReleased: false,
    failedStageCount: 1,
  });
});

test('an unproven near-term schedule returns without a cleanup-marker mutation', () => {
  assert.equal(
    canAttemptFf132CleanupRequiredMarker({
      finalScheduleActive: true,
      finalDraftParkUnproven: true,
    }),
    false,
  );
  assert.equal(
    canAttemptFf132CleanupRequiredMarker({
      finalScheduleActive: false,
      finalDraftParkUnproven: true,
    }),
    true,
  );
  assert.equal(
    canAttemptFf132CleanupRequiredMarker({
      finalScheduleActive: true,
      finalDraftParkUnproven: false,
    }),
    true,
  );
});

test('cleanup failure injection runs later stages, retains the lock, and fails closed', async () => {
  const stages = [
    'reset-draft',
    'drain-draft-clock-queue',
    'await-projection-terminal',
    'drain-projection-queue',
    'restore-availability',
    'drain-availability-queue',
    'verify-draft-inventory',
  ];

  for (const failedStage of stages) {
    const order = [];
    const operation = (name) => async () => {
      order.push(name);
      if (name === failedStage) {
        throw new Error(`private-${name}`);
      }
    };
    const outcome = await runFf132CleanupStages({
      resetDraft: operation('reset-draft'),
      drainDraftClockQueue: operation('drain-draft-clock-queue'),
      awaitProjectionTerminal: operation('await-projection-terminal'),
      drainProjectionQueue: operation('drain-projection-queue'),
      restoreAvailability: operation('restore-availability'),
      drainAvailabilityQueue: operation('drain-availability-queue'),
      verifyDraftInventory: operation('verify-draft-inventory'),
      markCleanupRequired: operation('mark-cleanup-required'),
      releaseLock: operation('release-lock'),
    });

    assert.equal(order.includes('verify-draft-inventory'), true, failedStage);
    assert.equal(order.includes('mark-cleanup-required'), true, failedStage);
    assert.equal(order.includes('release-lock'), false, failedStage);
    assert.equal(
      order.includes('restore-availability'),
      failedStage !== 'reset-draft',
      failedStage,
    );
    assert.equal(
      order.includes('drain-draft-clock-queue'),
      failedStage !== 'reset-draft',
      failedStage,
    );
    assert.deepEqual(outcome, {
      cleanupComplete: false,
      lockReleased: false,
      failedStageCount: failedStage === 'reset-draft' ? 3 : 1,
    });
  }
});

test('cleanup reports lock-release and cleanup-marker failures without raw errors', async () => {
  const order = [];
  const releaseFailure = await runFf132CleanupStages({
    releaseLock: async () => {
      order.push('release-lock');
      throw new Error('private-lock-identity');
    },
    markCleanupRequired: async () => { order.push('mark-cleanup-required'); },
  });
  assert.deepEqual(order, ['release-lock', 'mark-cleanup-required']);
  assert.deepEqual(releaseFailure, {
    cleanupComplete: false,
    lockReleased: false,
    failedStageCount: 1,
  });

  const markerFailure = await runFf132CleanupStages({
    resetDraft: async () => { throw new Error('private-draft'); },
    markCleanupRequired: async () => { throw new Error('private-lock'); },
    releaseLock: async () => assert.fail('must not release'),
  });
  assert.deepEqual(markerFailure, {
    cleanupComplete: false,
    lockReleased: false,
    failedStageCount: 2,
  });
});

test('public evidence has a fixed aggregate schema and excludes private identities', () => {
  const evidence = buildPublicFf132Evidence({
    ...publicEvidenceInput(),
    projectId: 'must-not-leak-project',
    leagueId: 'must-not-leak-league',
    commissionerId: 'must-not-leak-account',
    taskId: 'must-not-leak-task',
    requestId: 'must-not-leak-request',
    snapshotId: 'must-not-leak-snapshot',
    availabilityRevision: 'must-not-leak-source',
    recordsHash: 'must-not-leak-records',
    rawError: 'must-not-leak-error',
  });
  const serialized = JSON.stringify(evidence);

  assert.deepEqual(Object.keys(evidence), [
    'environment',
    'deployedRuntimeRevision',
    'toolingRevision',
    'releaseManifestMatched',
    'cleanPushedToolingDelta',
    'requiredStagingFunctionsActive',
    'exactFunctionSourceMatched',
    'cloudRunRevisionMatched',
    'schedulerConfigurationMatched',
    'taskQueueConfigurationMatched',
    'boundedDraftInventory',
    'availabilityQueueInitiallyEmpty',
    'projectionQueueInitiallyEmpty',
    'draftClockQueueInitiallyEmpty',
    'strictSchema2Baseline',
    'availabilityRecordsUnchanged',
    'naturalAvailabilityBoundary',
    'naturalAvailabilitySchedulerObserved',
    'availabilityBoundaryLatencyMilliseconds',
    'activeLeaseFirstDelivery',
    'exactFirstTaskFailureObserved',
    'duplicateAvailabilityQueueConverged',
    'retryUsedCurrentBaseline',
    'retryEvidenceScope',
    'availabilityRetryDelayMilliseconds',
    'nearZeroStayedFailClosed',
    'rescheduleRecovered',
    'naturalProjectionBoundary',
    'naturalProjectionSchedulerObserved',
    'projectionBoundaryLatencyMilliseconds',
    'authoritativeProjectionRequestCount',
    'projectionVersion',
    'scoringRulesVersion',
    'teamScheduleInputComplete',
    'duplicateProjectionDeliveryConverged',
    'clockStayedStopped',
    'pickCount',
    'projectionAuditRetained',
    'draftClockQueueCleaned',
    'cleanupComplete',
    'lockReleased',
    'safeResetDays',
  ]);
  assert.equal(evidence.environment, 'isolated-staging');
  assert.equal(evidence.deployedRuntimeRevision, REVISION);
  assert.equal(evidence.toolingRevision, TOOLING_REVISION);
  assert.equal(evidence.retryEvidenceScope, 'singleton-revision-correlated');
  assert.equal(evidence.taskQueueConfigurationMatched, true);
  assert.equal(evidence.projectionQueueInitiallyEmpty, true);
  assert.equal(evidence.draftClockQueueInitiallyEmpty, true);
  assert.equal(evidence.authoritativeProjectionRequestCount, 1);
  assert.equal(evidence.pickCount, 0);
  assert.equal(evidence.draftClockQueueCleaned, true);
  assert.equal(evidence.safeResetDays, 7);
  assert.doesNotMatch(serialized, /must-not-leak/);
  assert.doesNotMatch(
    serialized,
    /projectId|leagueId|commissionerId|taskId|requestId|snapshotId|availabilityRevision|recordsHash|rawError|playerId|assetKey|email/i,
  );
});

test('public evidence rejects untrusted revisions, strings, timings, counts, and versions', () => {
  const rawSecret = 'raw-private-string';
  const evidence = buildPublicFf132Evidence(publicEvidenceInput({
    deployedRuntimeRevision: 'not-a-revision',
    toolingRevision: 'also-invalid',
    retryEvidenceScope: 'exact-task-claimed-without-proof',
    taskQueueConfigurationMatched: rawSecret,
    projectionQueueInitiallyEmpty: rawSecret,
    draftClockQueueInitiallyEmpty: rawSecret,
    availabilityBoundaryLatencyMilliseconds: rawSecret,
    availabilityRetryDelayMilliseconds: rawSecret,
    projectionBoundaryLatencyMilliseconds: rawSecret,
    authoritativeProjectionRequestCount: '1',
    projectionVersion: '11',
    scoringRulesVersion: '4',
    pickCount: '0',
    draftClockQueueCleaned: rawSecret,
  }));

  assert.equal(evidence.deployedRuntimeRevision, null);
  assert.equal(evidence.toolingRevision, null);
  assert.equal(evidence.retryEvidenceScope, 'unverified');
  assert.equal(evidence.taskQueueConfigurationMatched, false);
  assert.equal(evidence.projectionQueueInitiallyEmpty, false);
  assert.equal(evidence.draftClockQueueInitiallyEmpty, false);
  assert.equal(evidence.availabilityBoundaryLatencyMilliseconds, null);
  assert.equal(evidence.availabilityRetryDelayMilliseconds, null);
  assert.equal(evidence.projectionBoundaryLatencyMilliseconds, null);
  assert.equal(evidence.authoritativeProjectionRequestCount, null);
  assert.equal(evidence.projectionVersion, null);
  assert.equal(evidence.scoringRulesVersion, null);
  assert.equal(evidence.pickCount, null);
  assert.equal(evidence.draftClockQueueCleaned, false);
  assert.equal(JSON.stringify(evidence).includes(rawSecret), false);
  assert.equal(
    buildPublicFf132Evidence(publicEvidenceInput({
      availabilityBoundaryLatencyMilliseconds:
        FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
    })).availabilityBoundaryLatencyMilliseconds,
    FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS,
  );

  for (const [field, value] of [
    [
      'availabilityBoundaryLatencyMilliseconds',
      FF132_NATURAL_SCHEDULER_CORRELATION_MAX_MILLISECONDS + 1,
    ],
    ['availabilityRetryDelayMilliseconds', 300_001],
    ['projectionBoundaryLatencyMilliseconds', -1],
    ['authoritativeProjectionRequestCount', 2],
    ['projectionVersion', 12],
    ['scoringRulesVersion', 5],
    ['pickCount', 1],
  ]) {
    assert.equal(buildPublicFf132Evidence(
      publicEvidenceInput({ [field]: value }),
    )[field], null, field);
  }
});

test('CLI failures expose only bounded checkpoint, cleanup, and failure-detail enums', async () => {
  const stdout = [];
  const stderr = [];
  const rawSecret = 'private-account-task-request-hash';
  const genericExit = await runFf132EvidenceCli({
    runner: async () => { throw new Error(rawSecret); },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  assert.equal(genericExit, 1);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr.map((line) => JSON.parse(line)), [{
    errorCode: 'FF132_EVIDENCE_FAILED',
    checkpoint: 'preflight',
    cleanupState: 'not-required',
    failureDetail: 'unclassified',
  }]);
  assert.equal([...stdout, ...stderr].join('\n').includes(rawSecret), false);

  stdout.length = 0;
  stderr.length = 0;
  const boundedExit = await runFf132EvidenceCli({
    runner: async () => {
      throw new Ff132PublicEvidenceError(
        'availability-boundary',
        'cleanup-required',
        'availability-failure-log',
      );
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  assert.equal(boundedExit, 1);
  assert.deepEqual(JSON.parse(stderr[0]), {
    errorCode: 'FF132_EVIDENCE_FAILED',
    checkpoint: 'availability-boundary',
    cleanupState: 'cleanup-required',
    failureDetail: 'availability-failure-log',
  });

  const allowedDetails = [
    'unclassified',
    'fixture-ownership',
    'availability-boundary-state',
    'availability-scheduler-proof',
    'availability-task-visible',
    'availability-lease-marker',
    'availability-failure-log',
    'availability-restored',
    'availability-draft-parked',
    'availability-duplicate-probe-1',
    'availability-duplicate-probe-2',
    'availability-retry-correlation',
    'near-zero-fail-closed',
    'projection-scheduler-proof',
    'projection-request-validation',
    'projection-ready-binding',
    'projection-post-ready-duplicate',
    'projection-final-park',
    'projection-log-correlation',
    'projection-request-uniqueness',
    'projection-snapshot-validation',
    'duplicate-convergence',
    'cleanup-reconciliation',
  ];
  for (const failureDetail of allowedDetails) {
    const bounded = new Ff132PublicEvidenceError(
      'availability-boundary',
      'cleanup-required',
      failureDetail,
    );
    assert.deepEqual(bounded.toJSON(), {
      errorCode: 'FF132_EVIDENCE_FAILED',
      checkpoint: 'availability-boundary',
      cleanupState: 'cleanup-required',
      failureDetail,
    });
    assert.deepEqual(Object.keys(bounded.toJSON()), [
      'errorCode',
      'checkpoint',
      'cleanupState',
      'failureDetail',
    ]);
  }

  for (const invalidDetail of [
    rawSecret,
    'Availability-Failure-Log',
    '',
    null,
    { rawError: rawSecret },
  ]) {
    const sanitizedDetail = new Ff132PublicEvidenceError(
      'availability-boundary',
      'cleanup-required',
      invalidDetail,
    );
    assert.equal(sanitizedDetail.failureDetail, 'unclassified');
    assert.equal(sanitizedDetail.message.includes(rawSecret), false);
    assert.equal(JSON.stringify(sanitizedDetail).includes(rawSecret), false);
  }

  const sanitized = new Ff132PublicEvidenceError(
    'private-checkpoint',
    'private-cleanup',
    rawSecret,
  );
  assert.deepEqual(sanitized.toJSON(), {
    errorCode: 'FF132_EVIDENCE_FAILED',
    checkpoint: 'preflight',
    cleanupState: 'not-required',
    failureDetail: 'unclassified',
  });
});

test('CLI success prints only the already-sanitized public evidence contract', async () => {
  const stdout = [];
  const stderr = [];
  const evidence = buildPublicFf132Evidence(publicEvidenceInput());
  const exitCode = await runFf132EvidenceCli({
    runner: async () => evidence,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.length, 0);
  assert.equal(stdout[0], 'FF1.32 server-owned Draft preparation staging evidence passed.');
  assert.deepEqual(JSON.parse(stdout[1]), evidence);
  assert.match(stdout[2], /Projection audit state was retained/);
});

test('runner source has no deployment command, Production target, or Projection rewind path', async () => {
  const source = await read(
    'scripts/capacity/run-ff132-server-owned-draft-preparation-staging-evidence.mjs',
  );

  assert.equal(D1N_STAGING_PROJECT_ID, 'rinkrat-staging-d1nc-2026');
  assert.equal(FF132_REGION, 'us-central1');
  assert.equal(
    FF132_DRAFT_SCHEDULER_JOB,
    'firebase-schedule-runScheduledDraftAutomation-us-central1',
  );
  assert.equal(FF132_AVAILABILITY_TASK_QUEUE, 'refreshDraftPlayerAvailabilityTask');
  assert.equal(FF132_PROJECTION_TASK_QUEUE, 'processProjectionGenerationTask');
  assert.equal(FF132_DRAFT_CLOCK_TASK_QUEUE, 'processDraftClockDeadline');
  assert.equal(
    FF132_EVIDENCE_LOCK_PATH,
    'appData/ff132ServerOwnedDraftPreparationEvidenceLock',
  );

  for (const requiredBoundary of [
    'FF132_STAGING_MAINTENANCE_ACK',
    'verifyFf132DeployedFunctionSourceArchives',
    'inspectFf132CloudRunDeployments',
    'inspectFf132SchedulerJob',
    'inspectFf132AvailabilityTaskQueue',
    'inspectFf132ProjectionTaskQueue',
    'inspectFf132DraftClockTaskQueue',
    'assertFf132ManualSchedulerCompletion',
    'assertFf132SchedulerRunAuditProvenance',
    'verifyProjectionSnapshotHashChain',
    '../../functions/src/shared/core/projection/projection-snapshot-hash.util.ts',
    'assertFf132SyntheticDraftSafety',
    'acquireFf132EvidenceLock',
    'prepareFf132InitialEvidenceState',
    'reconcileFf132FixtureOwnership',
    'drainFf132OwnedClockQueueTasks',
    'assertMaintenanceCheckpoint',
    'runFf132CleanupStages',
    "failureDetail = assertFailureDetail('fixture-ownership')",
    "failureDetail = assertFailureDetail('availability-boundary-state')",
    "failureDetail = assertFailureDetail('availability-scheduler-proof')",
    "failureDetail = assertFailureDetail('availability-task-visible')",
    "failureDetail = assertFailureDetail('availability-lease-marker')",
    "failureDetail = assertFailureDetail('availability-failure-log')",
    "failureDetail = assertFailureDetail('availability-restored')",
    "failureDetail = assertFailureDetail('availability-draft-parked')",
    "failureDetail = assertFailureDetail('availability-duplicate-probe-1')",
    "failureDetail = assertFailureDetail('availability-duplicate-probe-2')",
    "failureDetail = assertFailureDetail('availability-retry-correlation')",
    "failureDetail = assertFailureDetail('near-zero-fail-closed')",
    "failureDetail = assertFailureDetail('projection-scheduler-proof')",
    "failureDetail = assertFailureDetail('projection-request-validation')",
    "failureDetail = assertFailureDetail('projection-ready-binding')",
    "failureDetail = assertFailureDetail('projection-post-ready-duplicate')",
    "failureDetail = assertFailureDetail('projection-final-park')",
    "failureDetail = assertFailureDetail('projection-log-correlation')",
    "failureDetail = assertFailureDetail('projection-request-uniqueness')",
    "failureDetail = assertFailureDetail('projection-snapshot-validation')",
    "failureDetail = assertFailureDetail('cleanup-reconciliation')",
    "['ci', '--ignore-scripts', '--no-audit', '--no-fund']",
    'cwd: cleanFunctionsRoot',
  ]) {
    assert.equal(source.includes(requiredBoundary), true, requiredBoundary);
  }
  assert.equal(
    source.match(/assertFf132SyntheticDraftSafety\(/g)?.length,
    3,
    'The shared Draft-safety validator must guard the initial read and atomic recheck.',
  );

  const markerProbeStart = source.indexOf(
    'async function runFf132MarkerOnlySchedulerProbeBeforeDeadline({',
  );
  const markerProbeEnd = source.indexOf(
    'async function runCorrelatedFf132DraftScheduler({',
    markerProbeStart,
  );
  const markerProbe = source.slice(markerProbeStart, markerProbeEnd);
  const markerBaselineReadIndex = markerProbe.indexOf(
    'const automation = await readDraftAutomationState(draftAutomationRef);',
  );
  const markerObservationIndex = markerProbe.indexOf(
    'const observedAtMilliseconds = Date.now();',
  );
  assert.ok(markerProbeStart >= 0 && markerProbeEnd > markerProbeStart);
  assert.ok(
    markerBaselineReadIndex >= 0 && markerObservationIndex > markerBaselineReadIndex,
    'The baseline minute must be measured after the Firestore read to avoid a boundary-crossing false failure.',
  );

  const availabilityBoundaryStart = source.indexOf(
    "checkpoint = assertCheckpoint('availability-boundary')",
  );
  const availabilityBoundaryEnd = source.indexOf(
    "checkpoint = assertCheckpoint('availability-retry')",
    availabilityBoundaryStart,
  );
  const availabilityBoundary = source.slice(
    availabilityBoundaryStart,
    availabilityBoundaryEnd,
  );
  const initialOverlayOwnershipIndex = availabilityBoundary.indexOf(
    'availabilityOverlayOwned = true;',
  );
  const initialDraftOwnershipIndex = availabilityBoundary.indexOf('draftMutated = true;');
  const initialPrepareIndex = availabilityBoundary.indexOf(
    'await prepareFf132InitialEvidenceState({',
  );
  assert.ok(availabilityBoundaryStart >= 0 && availabilityBoundaryEnd > availabilityBoundaryStart);
  assert.ok(initialOverlayOwnershipIndex >= 0);
  assert.ok(initialDraftOwnershipIndex > initialOverlayOwnershipIndex);
  assert.ok(
    initialPrepareIndex > initialDraftOwnershipIndex,
    'Cleanup ownership must be conservative before an ambiguous atomic commit response.',
  );
  const leaseMarkerIndex = availabilityBoundary.indexOf(
    "failureDetail = assertFailureDetail('availability-lease-marker')",
  );
  const firstDuplicateProbeIndex = availabilityBoundary.indexOf(
    "failureDetail = assertFailureDetail('availability-duplicate-probe-1')",
    leaseMarkerIndex,
  );
  const secondDuplicateProbeIndex = availabilityBoundary.indexOf(
    "failureDetail = assertFailureDetail('availability-duplicate-probe-2')",
    firstDuplicateProbeIndex,
  );
  const parkOwnershipIndex = availabilityBoundary.indexOf(
    'plannedScheduledStartMilliseconds.add(safetyParkStartAt.getTime())',
    secondDuplicateProbeIndex,
  );
  const atomicParkRestoreIndex = availabilityBoundary.indexOf(
    'await parkDraftAndRestoreAvailabilityWithCas({',
    parkOwnershipIndex,
  );
  const postRestoreMaintenanceIndex = availabilityBoundary.indexOf(
    'await assertMaintenanceCheckpoint({',
    atomicParkRestoreIndex,
  );
  const naturalSchedulerMetadataIndex = availabilityBoundary.indexOf(
    'await waitForFf132NaturalSchedulerAttempt({',
  );
  const naturalSchedulerCutoffIndex = availabilityBoundary.indexOf(
    'const naturalSchedulerLogMaximum =',
  );
  const naturalSchedulerLogIndex = availabilityBoundary.indexOf(
    "'The verified natural T-25 scheduler request log'",
  );
  const failureLogIndex = availabilityBoundary.indexOf(
    "failureDetail = assertFailureDetail('availability-failure-log')",
  );
  assert.ok(leaseMarkerIndex >= 0);
  assert.ok(
    firstDuplicateProbeIndex > leaseMarkerIndex &&
      secondDuplicateProbeIndex > firstDuplicateProbeIndex,
    'The two duplicate probes must be serialized after the active-lease marker.',
  );
  assert.ok(
    parkOwnershipIndex > secondDuplicateProbeIndex &&
      atomicParkRestoreIndex > parkOwnershipIndex,
    'The safe parked schedule must be conservatively owned before the atomic transition.',
  );
  assert.equal(
    availabilityBoundary
      .slice(secondDuplicateProbeIndex, atomicParkRestoreIndex)
      .includes('await assertMaintenanceCheckpoint({'),
    false,
    'No unbounded maintenance read may intervene before the atomic park-and-restore.',
  );
  assert.ok(
    postRestoreMaintenanceIndex > atomicParkRestoreIndex &&
      naturalSchedulerCutoffIndex > postRestoreMaintenanceIndex &&
      naturalSchedulerLogIndex > naturalSchedulerCutoffIndex &&
      failureLogIndex > postRestoreMaintenanceIndex,
    'The Draft must be parked and availability restored before metadata or log waits.',
  );
  assert.equal(
    naturalSchedulerMetadataIndex,
    -1,
    'Post-probe Scheduler metadata cannot be attributed to the initial natural delivery.',
  );
  assert.equal(
    availabilityBoundary.match(/naturalSchedulerLogMaximum/g)?.length,
    4,
    'The initial natural log proof must use one disjoint pre-probe cutoff throughout.',
  );

  const clockDrainStart = source.indexOf('async function drainFf132OwnedClockQueueTasks(');
  const clockDrainEnd = source.indexOf(
    'export function assertFf132SingleQueueTask(',
    clockDrainStart,
  );
  const clockDrain = source.slice(clockDrainStart, clockDrainEnd);
  const clockListIndex = clockDrain.indexOf(
    'listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE)',
  );
  const clockAllowlistIndex = clockDrain.indexOf(
    'assertFf132OwnedClockQueueTasks(tasks, expectedTaskIds)',
  );
  const clockDeleteIndex = clockDrain.indexOf('deleteFf132ClockQueueTask(taskId)');
  assert.ok(clockDrainStart >= 0 && clockDrainEnd > clockDrainStart);
  assert.ok(clockListIndex >= 0);
  assert.ok(clockAllowlistIndex > clockListIndex);
  assert.ok(
    clockDeleteIndex > clockAllowlistIndex,
    'No Draft-clock task may be deleted before the exact ownership allowlist passes.',
  );

  const nearZeroStart = source.indexOf("checkpoint = assertCheckpoint('near-zero')");
  const nearZeroEnd = source.indexOf(
    "checkpoint = assertCheckpoint('projection-boundary')",
    nearZeroStart,
  );
  const nearZero = source.slice(nearZeroStart, nearZeroEnd);
  const leaseIndex = nearZero.indexOf(
    'Date.now() + timeoutMilliseconds + LOCK_CLEANUP_RESERVE_MILLISECONDS',
  );
  const rescheduleIndex = nearZero.indexOf(
    'await rescheduleDraft(draftRef, FieldValue, Timestamp, rescheduledStartAt)',
  );
  const stoppedIndex = nearZero.indexOf(
    'assertScheduledStoppedZero((await draftRef.get()).data() ?? {}, rescheduledStartAt)',
  );
  const restoreDeadlineIndex = nearZero.indexOf(
    'boundFf132TimeoutBeforeDeadline(1, finalEvidenceSafetyDeadlineMilliseconds)',
  );
  const preRestoreMaintenanceIndex = nearZero.indexOf(
    'await assertMaintenanceCheckpoint({',
    restoreDeadlineIndex,
  );
  const secondRestoreDeadlineIndex = nearZero.indexOf(
    'boundFf132TimeoutBeforeDeadline(1, finalEvidenceSafetyDeadlineMilliseconds)',
    restoreDeadlineIndex + 1,
  );
  const restoreIndex = nearZero.indexOf('await restoreAvailabilityWithCas({');
  assert.ok(nearZeroStart >= 0 && nearZeroEnd > nearZeroStart);
  assert.ok(leaseIndex >= 0, 'The near-zero lease must cover the run plus cleanup reserve.');
  assert.ok(rescheduleIndex > leaseIndex, 'The near-zero Draft must be rescheduled while leased.');
  assert.ok(stoppedIndex > rescheduleIndex, 'The rescheduled Draft must be proven stopped.');
  assert.ok(
    restoreDeadlineIndex > stoppedIndex,
    'The absolute T-15 deadline must be rechecked after rescheduling.',
  );
  assert.ok(
    preRestoreMaintenanceIndex > restoreDeadlineIndex &&
      secondRestoreDeadlineIndex > preRestoreMaintenanceIndex,
    'Maintenance must finish under the invalid lease before the restore deadline is rechecked.',
  );
  assert.ok(
    restoreIndex > secondRestoreDeadlineIndex,
    'Availability may restore only after safe maintenance and the second deadline recheck.',
  );
  assert.match(
    nearZero,
    /transactionDeadlineMilliseconds: finalEvidenceSafetyDeadlineMilliseconds/,
    'The restoring transaction itself must honor the absolute pre-open deadline.',
  );
  assert.match(
    nearZero,
    /verificationDeadlineMilliseconds: finalEvidenceSafetyDeadlineMilliseconds/,
    'The post-restore read must use the absolute pre-open deadline.',
  );
  assert.match(
    nearZero,
    /pendingTransactions: pendingFinalAvailabilityTransactions/,
    'A late restoring transaction must remain tracked through final reconciliation.',
  );

  const finalPhaseStart = source.indexOf(
    'const finalEvidenceSafetyDeadlineMilliseconds =',
    nearZeroStart,
  );
  const finalPhaseEnd = source.indexOf('provisionalEvidence = {', finalPhaseStart);
  const finalPhase = source.slice(finalPhaseStart, finalPhaseEnd);
  const finalOwnershipIndex = finalPhase.indexOf('finalScheduleActive = true;');
  const terminalRequestIndex = finalPhase.indexOf(
    "'The authoritative Projection V11 request'",
  );
  const readyBindingIndex = finalPhase.indexOf(
    "failureDetail = assertFailureDetail('projection-ready-binding')",
    terminalRequestIndex,
  );
  const readyStateIndex = finalPhase.indexOf(
    "'The exact schedule-bound ready state'",
    readyBindingIndex,
  );
  const postReadyDuplicateIndex = finalPhase.indexOf(
    "failureDetail = assertFailureDetail('projection-post-ready-duplicate')",
    readyStateIndex,
  );
  const duplicateStateIndex = finalPhase.indexOf(
    "'The duplicate-ready Draft snapshot'",
    postReadyDuplicateIndex,
  );
  const finalParkDetailIndex = finalPhase.indexOf(
    "failureDetail = assertFailureDetail('projection-final-park')",
    duplicateStateIndex,
  );
  const immediateDeadlineIndex = finalPhase.indexOf(
    'boundFf132TimeoutBeforeDeadline(1, finalEvidenceSafetyDeadlineMilliseconds)',
    finalParkDetailIndex,
  );
  const finalParkIndex = finalPhase.lastIndexOf(
    'await parkFf132FinalDraftBeforeDeadline({',
  );
  const finalRestoreIndex = finalPhase.indexOf('await restoreAvailabilityWithCas({');
  const finalMaintenanceIndex = finalPhase.lastIndexOf(
    'await assertMaintenanceCheckpoint({',
  );
  const logCorrelationIndex = finalPhase.indexOf(
    "failureDetail = assertFailureDetail('projection-log-correlation')",
    finalParkIndex,
  );
  const retainedRequestIndex = finalPhase.indexOf(
    'const retainedRequestSnapshot = await requestRef.get();',
    logCorrelationIndex,
  );
  const uniquenessIndex = finalPhase.indexOf(
    "failureDetail = assertFailureDetail('projection-request-uniqueness')",
    retainedRequestIndex,
  );
  const snapshotValidationIndex = finalPhase.indexOf(
    'const metadata = await assertProjectionSnapshot(',
    uniquenessIndex,
  );
  assert.ok(finalPhaseStart > nearZeroStart && finalPhaseEnd > finalPhaseStart);
  assert.match(
    source,
    /const FINAL_DRAFT_OPEN_SAFETY_MARGIN_MILLISECONDS = 15 \* 60 \* 1000;/,
    'Final evidence must reserve fifteen minutes for fail-closed parking.',
  );
  assert.match(
    source,
    /const FINAL_DRAFT_PARK_COMPLETION_MARGIN_MILLISECONDS = 5 \* 60 \* 1000;/,
    'The authoritative final park must be proven by T-5.',
  );
  assert.match(
    source,
    /const FIRESTORE_SINGLE_ATTEMPT_MAX_MILLISECONDS = 270 \* 1000;/,
    'A complete documented Firestore attempt must fit before either deadline.',
  );
  assert.ok(finalOwnershipIndex >= 0);
  assert.ok(
    terminalRequestIndex > finalOwnershipIndex &&
      readyBindingIndex > terminalRequestIndex &&
      readyStateIndex > readyBindingIndex &&
      postReadyDuplicateIndex > readyStateIndex &&
      duplicateStateIndex > postReadyDuplicateIndex &&
      finalParkDetailIndex > duplicateStateIndex &&
      immediateDeadlineIndex > finalParkDetailIndex &&
      finalParkIndex > immediateDeadlineIndex,
    'The Projection endgame must prove ready/duplicate state and immediately park.',
  );
  assert.equal(
    finalPhase
      .slice(terminalRequestIndex, finalParkIndex)
      .match(/runFf132MarkerOnlySchedulerProbeBeforeDeadline\(\{/g)?.length,
    2,
    'The Projection endgame requires one ready-binding and one duplicate probe.',
  );
  assert.ok(
    finalMaintenanceIndex > finalParkIndex &&
      logCorrelationIndex > finalMaintenanceIndex &&
      retainedRequestIndex > logCorrelationIndex &&
      uniquenessIndex > retainedRequestIndex &&
      snapshotValidationIndex > uniquenessIndex,
    'Slow logs, request history, and hash-chain validation must follow the final park.',
  );
  const preParkProjectionEndgame = finalPhase.slice(terminalRequestIndex, finalParkIndex);
  for (const forbiddenBeforePark of [
    'inspectFf132SchedulerJob(',
    'waitForFf132NaturalSchedulerAttempt(',
    'runCorrelatedFf132DraftScheduler(',
    'readFf132RequestLogs(',
    'readFf132SchedulerRunAuditLogs(',
    'assertOneOwnedProjectionRequest(',
    'assertProjectionSnapshot(',
  ]) {
    assert.equal(
      preParkProjectionEndgame.includes(forbiddenBeforePark),
      false,
      `${forbiddenBeforePark} must not run before the final park.`,
    );
  }
  assert.equal(
    finalPhase
      .slice(finalRestoreIndex, finalParkIndex)
      .includes('await assertMaintenanceCheckpoint({'),
    false,
    'No retrying maintenance transaction may run after availability restore and before parking.',
  );
  assert.match(
    finalPhase,
    /The pre-projection-boundary Draft snapshot[\s\S]+The immediately pre-T-20 Draft snapshot/,
    'Both pre-T-20 Draft reads must use the absolute deadline helper.',
  );
  for (const label of [
    'The server-owned Projection V11 request',
    'The authoritative Projection V11 request',
    'The exact schedule-bound ready state',
  ]) {
    const labelIndex = finalPhase.indexOf(label);
    assert.ok(labelIndex >= 0);
    assert.ok(
      finalPhase.lastIndexOf('waitForFf132BeforeDeadline(', labelIndex) >= 0,
      `${label} must use the absolute deadline helper.`,
    );
  }
  const cleanupFinallyIndex = source.indexOf('} finally {', finalPhaseEnd);
  const fallbackParkIndex = source.indexOf(
    'await parkFf132FinalDraftBeforeDeadline({',
    cleanupFinallyIndex,
  );
  const pendingSettlementIndex = source.indexOf(
    'waitForFf132PendingSafetyTransactions([',
    cleanupFinallyIndex,
  );
  const ownershipReconciliationIndex = source.indexOf(
    'let ownershipReconciled = false;',
    cleanupFinallyIndex,
  );
  assert.ok(
    fallbackParkIndex > cleanupFinallyIndex &&
      pendingSettlementIndex > fallbackParkIndex &&
      ownershipReconciliationIndex > pendingSettlementIndex,
    'Failure cleanup must park the final schedule before ownership reconciliation.',
  );
  assert.equal(
    source.includes(
      'await rescheduleDraft(draftRef, FieldValue, Timestamp, safetyParkStartAt)',
    ),
    false,
    'The final safety park may not use the default-retrying reschedule helper.',
  );
  assert.equal(
    source.match(/await parkFf132FinalDraftBeforeDeadline\(\{/g)?.length,
    3,
    'Normal, failure, and exact-state reconciled retry paths must share the bounded park.',
  );
  assert.match(
    source.slice(cleanupFinallyIndex),
    /pendingFinalDraftParkTransactions\.size === 0[\s\S]+await parkFf132FinalDraftBeforeDeadline/,
    'A failure-path retry requires an exact read and no ambiguous Draft mutation.',
  );
  const safetyTransactionStart = source.indexOf(
    'export async function runFf132SingleAttemptTransactionBeforeDeadline',
  );
  const safetyTransactionEnd = source.indexOf(
    'function timestampMilliseconds',
    safetyTransactionStart,
  );
  const safetyTransaction = source.slice(safetyTransactionStart, safetyTransactionEnd);
  assert.match(safetyTransaction, /\{ maxAttempts: 1 \}/);
  assert.match(
    safetyTransaction,
    /remainingMilliseconds < FIRESTORE_SINGLE_ATTEMPT_MAX_MILLISECONDS/,
  );
  const resetStart = source.indexOf('async function resetDraftFirst(');
  const resetEnd = source.indexOf(
    'export async function runFf132CleanupStages',
    resetStart,
  );
  assert.match(
    source.slice(resetStart, resetEnd),
    /\}, \{ maxAttempts: 1 \}\);/,
    'The cleanup fallback must not multiply the final safety transaction ceiling.',
  );
  assert.match(
    source.slice(cleanupFinallyIndex),
    /finalDraftParkDeadlineMissed \|\| unresolvedFinalSafetyTransactions/,
    'Missing the T-5 proof must retain a cleanup-required lock.',
  );
  assert.match(
    source.slice(cleanupFinallyIndex),
    /!unresolvedFinalSafetyTransactions[\s\S]+let attempt = 0;/,
    'Unresolved mutating promises must block cleanup ownership reconciliation.',
  );
  const unresolvedOwnershipIndex = source.indexOf(
    'if (!ownershipReconciled) {',
    cleanupFinallyIndex,
  );
  const cleanupOutcomeIndex = source.indexOf(
    'cleanupOutcome = {',
    unresolvedOwnershipIndex,
  );
  const unresolvedOwnership = source.slice(unresolvedOwnershipIndex, cleanupOutcomeIndex);
  assert.match(
    unresolvedOwnership,
    /canAttemptFf132CleanupRequiredMarker\(\{[\s\S]+finalScheduleActive,[\s\S]+finalDraftParkUnproven/,
    'An unproven near-term schedule must skip the cleanup-marker transaction and return promptly.',
  );

  for (const forbidden of [
    'nhl-fantasy-app-ab673',
    'firebase deploy',
    'gcloud functions deploy',
    'gcloud run deploy',
    '.recursiveDelete(',
    '.bulkDelete(',
    'firebase functions:delete',
    "'--prefix'",
    'captureProjectionState',
    'restoreProjectionStateWhenOwned',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
