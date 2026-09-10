import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { deleteApp as deleteClientApp, initializeApp as initializeClientApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  disableNetwork,
  doc,
  enableNetwork,
  getDocFromServer,
  getFirestore as getClientFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

import { D1N_STAGING_PROJECT_ID } from './prepare-d1n-staging-hosting.mjs';
import {
  buildD1nFixtureDocuments,
  D1N_FIXTURE_LEAGUE_ID,
} from './seed-d1n-route-fixture.mjs';
import {
  readCleanGitRevision,
  verifyFf1ReadinessStagingManifest,
} from './run-ff1-draft-readiness-staging-evidence.mjs';
import {
  buildScheduledDraftStartTaskId,
  DRAFT_START_TASK_WARMUP_LEAD_MILLISECONDS,
} from '../../functions/src/draft-readiness.util.ts';
import {
  acquireFf132EvidenceLock,
  assertFf132ProjectionSnapshotIntegrity,
  assertFf132StagingFunctionInventory,
  assertStrictSchema2AvailabilityBaseline,
  FF132_AVAILABILITY_TASK_QUEUE,
  FF132_DRAFT_CLOCK_TASK_QUEUE,
  FF132_EVIDENCE_LOCK_PATH,
  FF132_PROJECTION_TASK_QUEUE,
  FF132_REQUIRED_STAGING_FUNCTIONS,
  FF132_REGION,
  hashFf132DocumentData,
  inspectFf132CloudRunDeployments,
  listFf132QueueTasks,
  verifyFf132DeployedFunctionSourceArchives,
} from './run-ff132-server-owned-draft-preparation-staging-evidence.mjs';

export const FF1_SIX_CLIENT_STAGING_ACKNOWLEDGEMENT =
  `exercise-ff1-six-client-draft-in-${D1N_STAGING_PROJECT_ID}`;
export const FF1_SIX_CLIENT_STAGING_MAINTENANCE_ACKNOWLEDGEMENT =
  `reserve-exclusive-shared-availability-window-in-${D1N_STAGING_PROJECT_ID}`;
export const FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID = 'ff1-six-client-draft-v2';
export const FF1_SIX_CLIENT_FIXTURE_TYPE = 'ff1-six-client-draft-v2';
export const FF1_SIX_CLIENT_FIXTURE_INVITE_CODE = 'FF1V2X';
const FF1_SIX_CLIENT_RETAINED_V1_LEAGUE_ID = 'ff1-six-client-draft';
const FF1_SIX_CLIENT_RETAINED_V1_FIXTURE_TYPE = 'ff1-six-client-draft-v1';
export const FF1_SIX_CLIENT_MANAGER_COUNT = 6;
export const FF1_SIX_CLIENT_TOTAL_ROUNDS = 17;
export const FF1_SIX_CLIENT_TOTAL_PICKS =
  FF1_SIX_CLIENT_MANAGER_COUNT * FF1_SIX_CLIENT_TOTAL_ROUNDS;
export const FF1_SIX_CLIENT_MINIMUM_GUARDED_RUNTIME_REVISION =
  '48ebbefe3d94af6b7db2be9e758ed1e396a22ac4';
export const FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT =
  '817415114086-compute@developer.gserviceaccount.com';
const FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT_RESOURCE =
  `projects/rinkrat-staging-d1nc-2026/serviceAccounts/` +
  FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT;
export const FF1_SIX_CLIENT_GUARDED_RUNTIME_SOURCE_HASHES = Object.freeze({
  'functions/src/draft-automation.ts':
    '2f6b4df3744bae7ed2e3367e3979ddbfece6e63c0b6736303d554647ac677bc4',
  'functions/src/league-automation.ts':
    '21eccaeb0071357a7a1ad4630b5f23b0b2ea4c7e4a1d113a7b4b2bb1cccb2538',
  'functions/src/shared/core/live-scoring/historical-replay-lease-guard.util.ts':
    'c056d9a4c1fd052f3a26ace8a01348e8a1eced684cb1e6e3513b5160cde01bce',
  'functions/src/shared/core/live-scoring/historical-replay-lease-write.service.ts':
    '0af887c6069081fa344d96bb957168b1c02e55fc62e27c45045f545cdc11f221',
});
export const FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS = Object.freeze([
  ...FF132_REQUIRED_STAGING_FUNCTIONS,
  'advanceHistoricalReplayDay',
  'initializeSeasonAfterDraft',
  'makeSecureDraftPick',
  'publishLeagueAuditActivity',
  'publishLeagueDraftControlActivity',
  'publishLeagueDraftPickActivity',
  'processHistoricalReplayAdvance',
  'processLeagueAutomationTask',
  'reconcileDraftTurnAfterCommittedPick',
  'removeLeagueMemberSecure',
].sort());
export const FF1_SIX_CLIENT_FORBIDDEN_SHARED_FUNCTIONS = Object.freeze([
  'bootstrapLeagueAutomationSchedules',
  'dispatchDueLeagueAutomation',
  'pollCanonicalNhlImpactFeed',
  'queueLeagueAutomationCanaryCheck',
  'recoverStaleLeagueAutomationQueue',
  'requestLeagueLiveScoringRefresh',
  'runScheduledLeagueAutomation',
  'runSeasonStartAutomation',
].sort());
export const FF1_SIX_CLIENT_FORBIDDEN_SHARED_SCHEDULER_JOBS = Object.freeze(
  [
    'bootstrapLeagueAutomationSchedules',
    'dispatchDueLeagueAutomation',
    'pollCanonicalNhlImpactFeed',
    'recoverStaleLeagueAutomationQueue',
    'runScheduledLeagueAutomation',
    'runSeasonStartAutomation',
  ]
    .map((name) => `firebase-schedule-${name}-${FF132_REGION}`)
    .sort(),
);
export const FF1_SIX_CLIENT_FUNCTION_TOPOLOGY = Object.freeze({
  advanceHistoricalReplayDay: {
    kind: 'callable', timeoutSeconds: 60, memoryMiB: 256, maxInstances: 20,
  },
  continueServerDraftAutomation: {
    kind: 'firestore', event: 'written', document: 'leagues/{leagueId}/draft/current',
    retry: false, timeoutSeconds: 120, memoryMiB: 512, maxInstances: 20,
  },
  executeDraftCommand: {
    kind: 'callable', timeoutSeconds: 60, memoryMiB: 256, maxInstances: 20,
  },
  initializeSeasonAfterDraft: {
    kind: 'firestore', event: 'written', document: 'leagues/{leagueId}/draft/current',
    retry: false, timeoutSeconds: 540, memoryMiB: 1024, maxInstances: null,
  },
  makeSecureDraftPick: {
    kind: 'callable', timeoutSeconds: 60, memoryMiB: 512, maxInstances: 100,
  },
  processAutoDraftQueueChange: {
    kind: 'firestore', event: 'written',
    document: 'leagues/{leagueId}/draft/current/queues/{ownerId}',
    retry: false, timeoutSeconds: 120, memoryMiB: 512, maxInstances: 20,
  },
  processDraftClockDeadline: {
    kind: 'task', timeoutSeconds: 120, memoryMiB: 512, maxInstances: 20,
  },
  processHistoricalReplayAdvance: {
    kind: 'task', timeoutSeconds: 540, memoryMiB: 1024, maxInstances: 20,
  },
  processLeagueAutomationTask: {
    kind: 'task', timeoutSeconds: 540, memoryMiB: 1024, maxInstances: 20,
  },
  processProjectionGenerationTask: {
    kind: 'task', timeoutSeconds: 540, memoryMiB: 2048, maxInstances: 20,
  },
  publishLeagueAuditActivity: {
    kind: 'firestore', event: 'created', document: 'leagues/{leagueId}/audit/{auditId}',
    retry: true, timeoutSeconds: 60, memoryMiB: 256, maxInstances: 80,
  },
  publishLeagueDraftControlActivity: {
    kind: 'firestore', event: 'updated', document: 'leagues/{leagueId}/draft/current',
    retry: true, timeoutSeconds: 60, memoryMiB: 256, maxInstances: 80,
  },
  publishLeagueDraftPickActivity: {
    kind: 'firestore', event: 'created',
    document: 'leagues/{leagueId}/draft/current/picks/{pickId}',
    retry: true, timeoutSeconds: 60, memoryMiB: 256, maxInstances: 80,
  },
  reconcileDraftTurnAfterCommittedPick: {
    kind: 'firestore', event: 'written',
    document: 'leagues/{leagueId}/draft/current/picks/{pickId}',
    retry: true, timeoutSeconds: 60, memoryMiB: 256, maxInstances: null,
  },
  refreshDailyPlayerAvailability: {
    kind: 'callable', timeoutSeconds: 540, memoryMiB: 1024, maxInstances: 2,
    concurrency: 4,
  },
  refreshDraftPlayerAvailabilityTask: {
    kind: 'task', timeoutSeconds: 540, memoryMiB: 1024, maxInstances: 20,
  },
  refreshGlobalPlayerAvailabilityScheduled: {
    kind: 'schedule', timeoutSeconds: 540, memoryMiB: 1024, maxInstances: 1,
  },
  removeLeagueMemberSecure: {
    kind: 'callable', timeoutSeconds: 45, memoryMiB: 256, maxInstances: 40,
  },
  runScheduledDraftAutomation: {
    kind: 'schedule', timeoutSeconds: 540, memoryMiB: 1024, maxInstances: 1,
  },
});
export const FF1_SIX_CLIENT_SCHEDULER_TOPOLOGY = Object.freeze({
  refreshGlobalPlayerAvailabilityScheduled: {
    schedule: 'every 6 hours', timeZone: 'America/Los_Angeles', retryCount: 1,
  },
  runScheduledDraftAutomation: {
    schedule: '* * * * *', timeZone: 'UTC', retryCount: 0,
  },
});
export const FF1_SIX_CLIENT_TASK_QUEUE_TOPOLOGY = Object.freeze({
  processDraftClockDeadline: {
    maxAttempts: 5, minBackoff: '2s', maxBackoff: '3600s', maxDoublings: 16,
    maxConcurrentDispatches: 10,
  },
  processLeagueAutomationTask: {
    maxAttempts: 5, minBackoff: '30s', maxBackoff: '3600s', maxDoublings: 16,
    maxConcurrentDispatches: 4,
  },
  processHistoricalReplayAdvance: {
    maxAttempts: 1, minBackoff: '0.100s', maxBackoff: '3600s', maxDoublings: 16,
    maxConcurrentDispatches: 1,
  },
  processProjectionGenerationTask: {
    maxAttempts: 1, minBackoff: '0.100s', maxBackoff: '3600s', maxDoublings: 16,
    maxConcurrentDispatches: 2,
  },
  refreshDraftPlayerAvailabilityTask: {
    maxAttempts: 3, minBackoff: '30s', maxBackoff: '120s', maxDoublings: 2,
    maxConcurrentDispatches: 1,
  },
});

const FIREBASE_OPTIONS = Object.freeze({
  apiKey: 'AIzaSyDejIpv-Pi1iDcuKSgDyVK_5h2s9kZ05sY',
  authDomain: 'rinkrat-staging-d1nc-2026.firebaseapp.com',
  projectId: D1N_STAGING_PROJECT_ID,
  storageBucket: 'rinkrat-staging-d1nc-2026.firebasestorage.app',
  messagingSenderId: '817415114086',
  appId: '1:817415114086:web:d8be39fcb0b05074b28ca7',
});
const ALLOWED_TOOLING_PATHS = Object.freeze([
  'docs/RINKRAT_CODEX_HANDOFF.md',
  'docs/RINKRAT_FF1_33_HISTORICAL_REPLAY_LEASE_GUARD.md',
  'docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md',
  'docs/RINKRAT_FF1_32_SERVER_OWNED_DRAFT_PREPARATION_STAGING.md',
  'package.json',
  'scripts/capacity/run-ff1-six-client-draft-rehearsal.mjs',
  'scripts/capacity/run-ff132-server-owned-draft-preparation-staging-evidence.mjs',
  'test/batchff1-13-six-client-rehearsal/six-client-rehearsal.test.mjs',
  'test/batchff1-17-historical-replay-lease-guard/historical-replay-lease-guard.test.mjs',
]);
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
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const DEFAULT_READINESS_TIMEOUT_MILLISECONDS = 20 * 60 * 1000;
const DEFAULT_ACTION_TIMEOUT_MILLISECONDS = 90 * 1000;
const DEFAULT_LIFECYCLE_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;
const DRAFT_START_OFFSET_MILLISECONDS = 30 * 60 * 1000;
const DRAFT_PICK_SECONDS = 30;
const DRAFT_CLOCK_TASK_DISPATCH_DEADLINE = '60s';
const SERVER_DRAFT_ACTOR = 'server:draft-automation';
const POLL_INTERVAL_MILLISECONDS = 500;
const SERVER_AUTOMATION_MAX_EXECUTION_MILLISECONDS = 9 * 60 * 1000;
const SERVER_AUTOMATION_QUIESCENCE_GRACE_MILLISECONDS = 30 * 1000;
const SERVER_AUTOMATION_QUIESCENCE_MILLISECONDS =
  SERVER_AUTOMATION_MAX_EXECUTION_MILLISECONDS +
  SERVER_AUTOMATION_QUIESCENCE_GRACE_MILLISECONDS;
const SERVER_AUTOMATION_PARK_TIMEOUT_MILLISECONDS = 20 * 60 * 1000;
const DRAFT_TRIGGER_MAX_EXECUTION_MILLISECONDS = 120 * 1000;
const DRAFT_TRIGGER_QUIESCENCE_MILLISECONDS =
  DRAFT_TRIGGER_MAX_EXECUTION_MILLISECONDS + 30 * 1000;
const DRAFT_TASK_QUEUE_QUIESCENCE_MILLISECONDS =
  SERVER_AUTOMATION_QUIESCENCE_MILLISECONDS;
const DRAFT_TASK_QUEUE_CLEANUP_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;
const FF1_SIX_CLIENT_SHARED_GUARDED_TASK_QUEUES = Object.freeze([
  'processHistoricalReplayAdvance',
  'processLeagueAutomationTask',
]);
const MAX_DRAFT_INVENTORY = 50;
const MAX_PROJECTION_SNAPSHOT_CHUNKS = 100;
const SAFE_RESET_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const SHARED_LOCK_TIMEOUT_RESERVE_MILLISECONDS = 15 * 60 * 1000;
const FIXTURE_MANAGER_UID_PATTERN =
  /^ff1-six-client-[a-f0-9]{12}-manager-[1-6]$/;
const FF1_SIX_CLIENT_PUBLIC_FAILURE_CODE = 'FF1_SIX_CLIENT_EVIDENCE_FAILED';
const FF1_SIX_CLIENT_PUBLIC_CHECKPOINTS = Object.freeze([
  'preflight',
  'rehearsal',
  'cleanup',
]);
const FF1_SIX_CLIENT_PUBLIC_FAILURE_DETAILS = Object.freeze([
  'unclassified',
  'fixture-execution',
  'cleanup-reconciliation',
]);
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));

export class Ff1SixClientPublicEvidenceError extends Error {
  constructor(
    checkpoint = 'preflight',
    cleanupState = 'not-required',
    failureDetail = 'unclassified',
  ) {
    const safeCheckpoint = FF1_SIX_CLIENT_PUBLIC_CHECKPOINTS.includes(checkpoint)
      ? checkpoint
      : 'preflight';
    const safeCleanupState = cleanupState === 'complete'
      ? 'complete'
      : cleanupState === 'cleanup-required'
        ? 'cleanup-required'
        : 'not-required';
    const safeFailureDetail = FF1_SIX_CLIENT_PUBLIC_FAILURE_DETAILS.includes(failureDetail)
      ? failureDetail
      : 'unclassified';

    super(
      `${FF1_SIX_CLIENT_PUBLIC_FAILURE_CODE}:${safeCheckpoint}:${safeCleanupState}:${safeFailureDetail}`,
    );
    this.name = 'Ff1SixClientPublicEvidenceError';
    this.code = FF1_SIX_CLIENT_PUBLIC_FAILURE_CODE;
    this.checkpoint = safeCheckpoint;
    this.cleanupState = safeCleanupState;
    this.failureDetail = safeFailureDetail;
  }

  toJSON() {
    return {
      errorCode: this.code,
      checkpoint: this.checkpoint,
      cleanupState: this.cleanupState,
      failureDetail: this.failureDetail,
    };
  }
}

function runGitRaw(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });

  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed.`);
  }

  return result.stdout;
}

function runGit(args) {
  return runGitRaw(args).trim();
}

function gitRevisionIsAncestor(ancestorRevision, descendantRevision) {
  assert.match(ancestorRevision, GIT_REVISION_PATTERN);
  assert.match(descendantRevision, GIT_REVISION_PATTERN);
  const result = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', ancestorRevision, descendantRevision],
    {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
    },
  );

  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error('The guarded runtime ancestry check could not be completed.');
  }

  return result.status === 0;
}

export function assertFf1SixClientGuardedRuntimeProvenance({
  deployedReleaseRevision,
  guardRevision = FF1_SIX_CLIENT_MINIMUM_GUARDED_RUNTIME_REVISION,
  guardIsAncestor,
  guardedSourceHashes,
}) {
  assert.match(deployedReleaseRevision, GIT_REVISION_PATTERN);
  assert.equal(guardRevision, FF1_SIX_CLIENT_MINIMUM_GUARDED_RUNTIME_REVISION);
  assert.equal(
    guardIsAncestor,
    true,
    'The declared runtime does not contain the reviewed FF1.33 replay-lease guard commit.',
  );
  assert.deepEqual(
    guardedSourceHashes,
    FF1_SIX_CLIENT_GUARDED_RUNTIME_SOURCE_HASHES,
    'The declared runtime changed the reviewed FF1.33 guard or Draft marker source.',
  );
  return true;
}

function verifyFf1SixClientGuardedRuntimeProvenance(deployedReleaseRevision) {
  const guardedSourceHashes = Object.fromEntries(
    Object.keys(FF1_SIX_CLIENT_GUARDED_RUNTIME_SOURCE_HASHES).map((path) => [
      path,
      createHash('sha256')
        .update(runGitRaw(['show', `${deployedReleaseRevision}:${path}`]))
        .digest('hex'),
    ]),
  );
  return assertFf1SixClientGuardedRuntimeProvenance({
    deployedReleaseRevision,
    guardIsAncestor: gitRevisionIsAncestor(
      FF1_SIX_CLIENT_MINIMUM_GUARDED_RUNTIME_REVISION,
      deployedReleaseRevision,
    ),
    guardedSourceHashes,
  });
}

function runGcloud(args) {
  const result = spawnSync('gcloud', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });

  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n')
      .trim()
      .slice(-1_000);
    throw new Error(`gcloud ${args.join(' ')} failed.${detail ? ` ${detail}` : ''}`);
  }

  return result.stdout.trim();
}

function assertEmptyFf1SixClientSharedGuardedTaskQueues() {
  for (const queueName of FF1_SIX_CLIENT_SHARED_GUARDED_TASK_QUEUES) {
    const tasks = JSON.parse(runGcloud([
      'tasks', 'list',
      `--project=${D1N_STAGING_PROJECT_ID}`,
      `--location=${FF132_REGION}`,
      `--queue=${queueName}`,
      '--format=json',
    ]));
    assert.equal(Array.isArray(tasks), true);
    assert.deepEqual(
      tasks,
      [],
      `The shared staging ${queueName} task queue is not empty.`,
    );
  }
  return true;
}

function normalizeTopologyUrl(value) {
  const url = new URL(value ?? 'https://invalid.invalid');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}

function topologyMemoryMiB(value) {
  const match = /^(\d+)(Mi|Gi)$/.exec(value ?? '');
  assert.ok(match, 'A deployed Function memory limit is malformed.');
  const amount = Number(match[1]);
  return match[2] === 'Gi' ? amount * 1024 : amount;
}

export function assertFf1SixClientFunctionTopology(entries) {
  assert.equal(Array.isArray(entries), true);
  assert.deepEqual(
    Object.keys(FF1_SIX_CLIENT_FUNCTION_TOPOLOGY).sort(),
    FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS,
    'The reviewed Function topology does not cover the exact required inventory.',
  );
  assert.equal(entries.length, FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.length);
  const byName = new Map(entries.map((entry) => [
    String(entry?.name ?? '').split('/').at(-1),
    entry,
  ]));
  assert.equal(byName.size, entries.length, 'The deployed Function topology contains duplicates.');

  for (const name of FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS) {
    const entry = byName.get(name);
    const expected = FF1_SIX_CLIENT_FUNCTION_TOPOLOGY[name];
    assert.ok(entry, `The required staging Function ${name} is missing.`);
    assert.equal(entry.labels?.['deployment-tool'], 'cli-firebase');
    assert.equal(entry.serviceConfig?.timeoutSeconds, expected.timeoutSeconds);
    assert.equal(
      topologyMemoryMiB(entry.serviceConfig?.availableMemory),
      expected.memoryMiB,
    );
    assert.equal(
      entry.serviceConfig?.maxInstanceCount ?? null,
      expected.maxInstances,
      `The protected max-instance ceiling changed for ${name}.`,
    );
    assert.equal(
      entry.serviceConfig?.maxInstanceRequestConcurrency,
      expected.concurrency ?? 80,
      `The protected request concurrency changed for ${name}.`,
    );
    assert.equal(entry.serviceConfig?.minInstanceCount ?? 0, 0);
    assert.equal(entry.serviceConfig?.environmentVariables?.FUNCTION_TARGET, name);
    assert.equal(
      entry.serviceConfig?.serviceAccountEmail,
      FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT,
      `The reviewed runtime service identity changed for ${name}.`,
    );
    assert.equal(
      entry.buildConfig?.serviceAccount,
      FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT_RESOURCE,
      `The reviewed build service identity changed for ${name}.`,
    );

    const markerLabels = {
      callable: entry.labels?.['deployment-callable'] === 'true',
      schedule: entry.labels?.['deployment-scheduled'] === 'true',
      task: entry.labels?.['deployment-taskqueue'] === 'true',
    };
    for (const marker of Object.keys(markerLabels)) {
      assert.equal(
        markerLabels[marker],
        expected.kind === marker,
        `The deployed trigger marker for ${name} does not match ${expected.kind}.`,
      );
    }

    if (expected.kind !== 'firestore') {
      assert.equal(entry.eventTrigger ?? null, null);
      if (expected.kind === 'callable') {
        assert.ok(
          [undefined, 'http'].includes(
            entry.serviceConfig?.environmentVariables?.FUNCTION_SIGNATURE_TYPE,
          ),
          `The callable signature for ${name} is unexpected.`,
        );
      } else {
        assert.notEqual(
          entry.serviceConfig?.environmentVariables?.FUNCTION_SIGNATURE_TYPE,
          'cloudevent',
        );
      }
      continue;
    }

    assert.equal(
      entry.serviceConfig?.environmentVariables?.FUNCTION_SIGNATURE_TYPE,
      'cloudevent',
    );
    const eventTrigger = entry.eventTrigger;
    assert.ok(eventTrigger && typeof eventTrigger === 'object');
    assert.equal(
      eventTrigger.eventType,
      `google.cloud.firestore.document.v1.${expected.event}`,
    );
    assert.equal(eventTrigger.triggerRegion, 'us-west4');
    assert.equal(
      eventTrigger.serviceAccountEmail,
      FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT,
      `The reviewed Eventarc service identity changed for ${name}.`,
    );
    assert.equal(
      eventTrigger.retryPolicy,
      expected.retry ? 'RETRY_POLICY_RETRY' : 'RETRY_POLICY_DO_NOT_RETRY',
    );
    const eventFilters = new Map(
      (eventTrigger.eventFilters ?? []).map((filter) => [filter.attribute, filter]),
    );
    assert.equal(eventFilters.size, 3);
    assert.deepEqual(eventFilters.get('document'), {
      attribute: 'document',
      operator: 'match-path-pattern',
      value: expected.document,
    });
    assert.deepEqual(eventFilters.get('database'), {
      attribute: 'database',
      value: '(default)',
    });
    assert.deepEqual(eventFilters.get('namespace'), {
      attribute: 'namespace',
      value: '(default)',
    });
    assert.match(
      eventTrigger.trigger ?? '',
      new RegExp(
        `^projects/${D1N_STAGING_PROJECT_ID}/locations/us-west4/triggers/${name.toLowerCase()}-[a-z0-9-]+$`,
      ),
      `The Eventarc trigger identity for ${name} is unexpected.`,
    );
    assert.match(
      eventTrigger.pubsubTopic ?? '',
      new RegExp(
        `^projects/${D1N_STAGING_PROJECT_ID}/topics/eventarc-us-west4-${name.toLowerCase()}-[a-z0-9-]+$`,
      ),
      `The Eventarc transport topic for ${name} is unexpected.`,
    );
  }

  return true;
}

export function assertFf1SixClientSchedulerTopology(jobs, deployedFunctions) {
  assert.equal(Array.isArray(jobs), true);
  assert.equal(Array.isArray(deployedFunctions), true);
  const expectedNames = Object.keys(FF1_SIX_CLIENT_SCHEDULER_TOPOLOGY).sort();
  assert.equal(jobs.length, expectedNames.length);
  const jobsByName = new Map(jobs.map((job) => [String(job?.name ?? '').split('/').at(-1), job]));
  const functionsByName = new Map(deployedFunctions.map((entry) => [entry.name, entry]));
  assert.equal(jobsByName.size, jobs.length);

  for (const name of expectedNames) {
    const jobId = `firebase-schedule-${name}-${FF132_REGION}`;
    const job = jobsByName.get(jobId);
    const deployedFunction = functionsByName.get(name);
    const expected = FF1_SIX_CLIENT_SCHEDULER_TOPOLOGY[name];
    assert.ok(job && deployedFunction, `The verified scheduler topology is missing ${name}.`);
    assert.equal(
      job.name,
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/jobs/${jobId}`,
    );
    assert.equal(job.state, 'ENABLED');
    assert.equal(job.schedule, expected.schedule);
    assert.equal(job.timeZone, expected.timeZone);
    assert.equal(job.attemptDeadline, `${FF1_SIX_CLIENT_FUNCTION_TOPOLOGY[name].timeoutSeconds}s`);
    assert.equal(job.httpTarget?.httpMethod, 'POST');
    const targetUrl = normalizeTopologyUrl(job.httpTarget?.uri);
    const allowedTargets = new Set([
      normalizeTopologyUrl(deployedFunction.uri),
      normalizeTopologyUrl(
        `https://${FF132_REGION}-${D1N_STAGING_PROJECT_ID}.cloudfunctions.net/${name}`,
      ),
    ]);
    assert.equal(
      allowedTargets.has(targetUrl),
      true,
      `The Scheduler job for ${name} targets an unverified endpoint.`,
    );
    assert.equal(
      normalizeTopologyUrl(job.httpTarget?.oidcToken?.audience),
      targetUrl,
    );
    assert.equal(
      job.httpTarget?.oidcToken?.serviceAccountEmail,
      FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT,
      `The reviewed Scheduler service identity changed for ${name}.`,
    );
    assert.equal(Number(job.retryConfig?.retryCount ?? 0), expected.retryCount);
    assert.equal(job.retryConfig?.maxRetryDuration, '0s');
    assert.equal(job.retryConfig?.minBackoffDuration, '5s');
    assert.equal(job.retryConfig?.maxBackoffDuration, '3600s');
    assert.equal(job.retryConfig?.maxDoublings, 5);
    assert.equal(Number(job.status?.code ?? 0), 0);
  }

  return true;
}

export function assertFf1SixClientTaskQueueTopology(queues) {
  assert.equal(Array.isArray(queues), true);
  const expectedNames = Object.keys(FF1_SIX_CLIENT_TASK_QUEUE_TOPOLOGY).sort();
  assert.equal(queues.length, expectedNames.length);
  const byName = new Map(queues.map((queue) => [String(queue?.name ?? '').split('/').at(-1), queue]));
  assert.equal(byName.size, queues.length);

  for (const name of expectedNames) {
    const queue = byName.get(name);
    const expected = FF1_SIX_CLIENT_TASK_QUEUE_TOPOLOGY[name];
    assert.ok(queue, `The required task queue ${name} is missing.`);
    assert.equal(
      queue.name,
      `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/${name}`,
    );
    assert.equal(queue.state, 'RUNNING');
    assert.equal(queue.rateLimits?.maxBurstSize, 100);
    assert.equal(queue.rateLimits?.maxDispatchesPerSecond, 500);
    assert.equal(
      queue.rateLimits?.maxConcurrentDispatches,
      expected.maxConcurrentDispatches,
    );
    assert.equal(queue.retryConfig?.maxAttempts, expected.maxAttempts);
    assert.equal(queue.retryConfig?.minBackoff, expected.minBackoff);
    assert.equal(queue.retryConfig?.maxBackoff, expected.maxBackoff);
    assert.equal(queue.retryConfig?.maxDoublings, expected.maxDoublings);
  }

  return true;
}

export function assertFf1SixClientExcludedRuntimeAbsent(
  functionEntries,
  schedulerJobs,
) {
  assert.equal(Array.isArray(functionEntries), true);
  assert.equal(Array.isArray(schedulerJobs), true);
  const deployedFunctionNames = new Set(functionEntries.map((entry) =>
    String(entry?.name ?? entry?.id ?? '').split('/').at(-1)));
  const deployedSchedulerJobNames = new Set(schedulerJobs.map((entry) =>
    String(entry?.name ?? entry?.id ?? '').split('/').at(-1)));

  for (const name of FF1_SIX_CLIENT_FORBIDDEN_SHARED_FUNCTIONS) {
    assert.equal(
      deployedFunctionNames.has(name),
      false,
      `The shared staging Function ${name} must be absent during FF1.33.`,
    );
  }
  for (const name of FF1_SIX_CLIENT_FORBIDDEN_SHARED_SCHEDULER_JOBS) {
    assert.equal(
      deployedSchedulerJobNames.has(name),
      false,
      `The shared staging Scheduler job ${name} must be absent during FF1.33.`,
    );
  }

  return true;
}

function inspectFf1SixClientRuntimeTopology() {
  const fullFunctionInventory = JSON.parse(runGcloud([
    'functions', 'list', '--v2', `--regions=${FF132_REGION}`,
    `--project=${D1N_STAGING_PROJECT_ID}`, '--format=json',
  ]));
  const fullSchedulerInventory = JSON.parse(runGcloud([
    'scheduler', 'jobs', 'list', `--location=${FF132_REGION}`,
    `--project=${D1N_STAGING_PROJECT_ID}`, '--format=json',
  ]));
  assertFf1SixClientExcludedRuntimeAbsent(
    fullFunctionInventory,
    fullSchedulerInventory,
  );
  const entries = FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.map((name) =>
    JSON.parse(runGcloud([
      'functions', 'describe', name, '--gen2',
      `--region=${FF132_REGION}`,
      `--project=${D1N_STAGING_PROJECT_ID}`,
      '--format=json',
    ])));
  assertFf1SixClientFunctionTopology(entries);
  const deployedFunctions = FF1_SIX_CLIENT_REQUIRED_STAGING_FUNCTIONS.flatMap(
    (name) => assertFf132StagingFunctionInventory(
      entries.filter((entry) => String(entry?.name ?? '').endsWith(`/functions/${name}`)),
      [name],
    ),
  );
  const schedulerJobs = Object.keys(FF1_SIX_CLIENT_SCHEDULER_TOPOLOGY).map((name) =>
    JSON.parse(runGcloud([
      'scheduler', 'jobs', 'describe',
      `firebase-schedule-${name}-${FF132_REGION}`,
      `--location=${FF132_REGION}`,
      `--project=${D1N_STAGING_PROJECT_ID}`,
      '--format=json',
    ])));
  assertFf1SixClientSchedulerTopology(schedulerJobs, deployedFunctions);
  const taskQueues = Object.keys(FF1_SIX_CLIENT_TASK_QUEUE_TOPOLOGY).map((name) =>
    JSON.parse(runGcloud([
      'tasks', 'queues', 'describe', name,
      `--location=${FF132_REGION}`,
      `--project=${D1N_STAGING_PROJECT_ID}`,
      '--format=json',
    ])));
  assertFf1SixClientTaskQueueTopology(taskQueues);
  return deployedFunctions;
}

function relevantFf1SixClientTriggerRequestLogs(
  entries,
  deployedFunction,
  minimumTimestamp,
  maximumTimestamp,
) {
  assert.equal(Array.isArray(entries), true);
  assert.ok(deployedFunction && typeof deployedFunction === 'object');
  const exactCloudEventSource =
    `//firestore.googleapis.com/projects/${D1N_STAGING_PROJECT_ID}/databases/(default)`;
  const relevant = entries.filter((entry) => {
    const timestamp = timestampMilliseconds(entry?.timestamp);
    const status = Number(entry?.httpRequest?.status);
    const eventId = entry?.labels?.['run.googleapis.com/cloud_event_id'];
    const requestUrl = (() => {
      try {
        return new URL(entry?.httpRequest?.requestUrl ?? '');
      } catch {
        return null;
      }
    })();
    const expectedUrl = new URL(deployedFunction.uri);
    return (
      entry?.resource?.type === 'cloud_run_revision' &&
      entry?.resource?.labels?.project_id === D1N_STAGING_PROJECT_ID &&
      entry?.resource?.labels?.location === FF132_REGION &&
      entry?.resource?.labels?.service_name === deployedFunction.serviceName &&
      entry?.resource?.labels?.revision_name === deployedFunction.revision &&
      entry?.labels?.['firebase-functions-hash'] === deployedFunction.sourceHash &&
      entry?.labels?.['run.googleapis.com/cloud_event_source'] === exactCloudEventSource &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
        .test(eventId ?? '') &&
      entry?.httpRequest?.requestMethod === 'POST' &&
      requestUrl?.origin === expectedUrl.origin &&
      requestUrl?.pathname.replace(/\/+$/, '') === expectedUrl.pathname.replace(/\/+$/, '') &&
      requestUrl?.search === '?__GCP_CloudEventsMode=CE_PUBSUB_BINDING' &&
      status >= 200 &&
      status < 300 &&
      timestamp !== null &&
      timestamp >= minimumTimestamp &&
      timestamp <= maximumTimestamp
    );
  });
  return [...new Map(relevant.map((entry) => [
    entry.labels['run.googleapis.com/cloud_event_id'],
    entry,
  ])).values()];
}

const FF1_SIX_CLIENT_PICK_HANDOFF_SUCCESS_MESSAGE =
  'Committed Draft pick handoff reconciled.';

export function buildFf1SixClientDraftPickHandoffCorrelationHash(pickId) {
  assert.match(pickId, /^\d{3}$/);
  const overallPick = Number(pickId);
  assert.ok(overallPick >= 1 && overallPick <= FF1_SIX_CLIENT_TOTAL_PICKS);
  return createHash('sha256')
    .update(
      `rinkrat:draft-pick-handoff:v1:${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}:${pickId}`,
    )
    .digest('hex');
}

function relevantFf1SixClientPickHandoffMarkerLogs(
  entries,
  deployedFunction,
  minimumTimestamp,
  maximumTimestamp,
) {
  assert.equal(Array.isArray(entries), true);
  return entries.filter((entry) => {
    const timestamp = timestampMilliseconds(entry?.timestamp);
    const payload = entry?.jsonPayload;
    return (
      entry?.resource?.type === 'cloud_run_revision' &&
      entry?.resource?.labels?.project_id === D1N_STAGING_PROJECT_ID &&
      entry?.resource?.labels?.location === FF132_REGION &&
      entry?.resource?.labels?.service_name === deployedFunction.serviceName &&
      entry?.resource?.labels?.revision_name === deployedFunction.revision &&
      entry?.labels?.['firebase-functions-hash'] === deployedFunction.sourceHash &&
      entry?.severity === 'INFO' &&
      payload?.message === FF1_SIX_CLIENT_PICK_HANDOFF_SUCCESS_MESSAGE &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
        .test(payload?.eventId ?? '') &&
      SHA256_PATTERN.test(payload?.draftPickCorrelationHash ?? '') &&
      ['live', 'complete'].includes(payload?.draftStatus) &&
      typeof payload?.nextDeadlineScheduled === 'boolean' &&
      timestamp !== null &&
      timestamp >= minimumTimestamp &&
      timestamp <= maximumTimestamp
    );
  });
}

export function assertFf1SixClientPickHandoffEvidence(
  requestEntries,
  markerEntries,
  {
    deployedFunction,
    minimumTimestamp,
    maximumTimestamp,
    expectedPickIds,
  },
) {
  assert.equal(Array.isArray(expectedPickIds), true);
  assert.equal(expectedPickIds.length, FF1_SIX_CLIENT_TOTAL_PICKS);
  assert.equal(new Set(expectedPickIds).size, FF1_SIX_CLIENT_TOTAL_PICKS);
  assert.deepEqual(
    [...expectedPickIds].sort(),
    Array.from(
      { length: FF1_SIX_CLIENT_TOTAL_PICKS },
      (_, index) => String(index + 1).padStart(3, '0'),
    ),
    'The committed-pick evidence input is not the exact 102-document Draft.',
  );

  const successfulRequests = relevantFf1SixClientTriggerRequestLogs(
    requestEntries,
    deployedFunction,
    minimumTimestamp,
    maximumTimestamp,
  );
  const successfulRequestEventIds = new Set(successfulRequests.map(
    (entry) => entry.labels['run.googleapis.com/cloud_event_id'],
  ));
  const markers = relevantFf1SixClientPickHandoffMarkerLogs(
    markerEntries,
    deployedFunction,
    minimumTimestamp,
    maximumTimestamp,
  );
  assert.ok(
    markers.length >= FF1_SIX_CLIENT_TOTAL_PICKS,
    'The verified trigger did not emit a successful marker for every committed pick.',
  );

  const markersByHash = new Map();
  const markerHashByEventId = new Map();
  const expectedCorrelationHashes = new Set(expectedPickIds.map(
    buildFf1SixClientDraftPickHandoffCorrelationHash,
  ));
  const finalPickCorrelationHash =
    buildFf1SixClientDraftPickHandoffCorrelationHash(
      String(FF1_SIX_CLIENT_TOTAL_PICKS).padStart(3, '0'),
    );
  for (const marker of markers) {
    const payload = marker.jsonPayload;
    assert.equal(
      expectedCorrelationHashes.has(payload.draftPickCorrelationHash),
      true,
      'The exact-revision trigger emitted a marker outside the fixture Draft.',
    );
    assert.equal(
      successfulRequestEventIds.has(payload.eventId),
      true,
      'A committed-pick marker has no successful exact-revision trigger request.',
    );
    const priorHash = markerHashByEventId.get(payload.eventId);
    assert.ok(
      priorHash === undefined || priorHash === payload.draftPickCorrelationHash,
      'One trigger event claimed more than one committed pick.',
    );
    markerHashByEventId.set(payload.eventId, payload.draftPickCorrelationHash);

    const coherentLiveOutcome =
      payload.draftStatus === 'live' && payload.nextDeadlineScheduled === true;
    const coherentCompleteOutcome =
      payload.draftStatus === 'complete' && payload.nextDeadlineScheduled === false;
    assert.equal(
      coherentLiveOutcome || coherentCompleteOutcome,
      true,
      'A committed-pick marker contains an incoherent Draft/deadline outcome.',
    );
    if (payload.draftPickCorrelationHash === finalPickCorrelationHash) {
      assert.equal(
        coherentCompleteOutcome,
        true,
        'The final committed pick did not observe completed Draft authority.',
      );
    }

    const priorMarker = markersByHash.get(payload.draftPickCorrelationHash);
    if (priorMarker) {
      assert.equal(
        payload.eventId,
        priorMarker.jsonPayload.eventId,
        'One committed-pick hash was claimed by different trigger events.',
      );
    } else {
      markersByHash.set(payload.draftPickCorrelationHash, marker);
    }
  }

  for (const pickId of expectedPickIds) {
    const marker = markersByHash.get(
      buildFf1SixClientDraftPickHandoffCorrelationHash(pickId),
    );
    assert.ok(marker, `The committed Draft pick ${pickId} has no exact handoff marker.`);
  }

  return Object.freeze({
    successfulRequestCount: successfulRequests.length,
    markerCount: markersByHash.size,
    duplicateMarkerCount: markers.length - markersByHash.size,
  });
}

export function assertFf1SixClientTriggerRequestLogs(
  entries,
  {
    deployedFunction,
    minimumTimestamp,
    maximumTimestamp,
    minimumSuccessfulRequests,
  },
) {
  assert.equal(Number.isSafeInteger(minimumTimestamp), true);
  assert.equal(Number.isSafeInteger(maximumTimestamp), true);
  assert.ok(maximumTimestamp >= minimumTimestamp);
  assert.ok(Number.isSafeInteger(minimumSuccessfulRequests));
  assert.ok(minimumSuccessfulRequests > 0 && minimumSuccessfulRequests <= 500);
  const relevant = relevantFf1SixClientTriggerRequestLogs(
    entries,
    deployedFunction,
    minimumTimestamp,
    maximumTimestamp,
  );
  assert.ok(
    relevant.length >= minimumSuccessfulRequests,
    `The verified ${deployedFunction.name} revision has too few successful trigger deliveries.`,
  );
  return relevant.length;
}

function readFf1SixClientTriggerRequestLogs(
  deployedFunction,
  minimumTimestamp,
  maximumTimestamp,
) {
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.project_id="${D1N_STAGING_PROJECT_ID}"`,
    `resource.labels.location="${FF132_REGION}"`,
    `resource.labels.service_name="${deployedFunction.serviceName}"`,
    `resource.labels.revision_name="${deployedFunction.revision}"`,
    'labels."run.googleapis.com/cloud_event_id"!=""',
    'labels."run.googleapis.com/cloud_event_source"=' +
      `"//firestore.googleapis.com/projects/${D1N_STAGING_PROJECT_ID}/databases/(default)"`,
    'httpRequest.requestMethod="POST"',
    `timestamp>="${new Date(minimumTimestamp).toISOString()}"`,
    `timestamp<="${new Date(maximumTimestamp).toISOString()}"`,
  ].join(' AND ');
  return JSON.parse(runGcloud([
    'logging', 'read', filter,
    `--project=${D1N_STAGING_PROJECT_ID}`,
    '--order=asc',
    '--limit=500',
    '--format=json',
  ]));
}

function readFf1SixClientPickHandoffMarkerLogs(
  deployedFunction,
  minimumTimestamp,
  maximumTimestamp,
) {
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.project_id="${D1N_STAGING_PROJECT_ID}"`,
    `resource.labels.location="${FF132_REGION}"`,
    `resource.labels.service_name="${deployedFunction.serviceName}"`,
    `resource.labels.revision_name="${deployedFunction.revision}"`,
    `labels."firebase-functions-hash"="${deployedFunction.sourceHash}"`,
    'severity="INFO"',
    `jsonPayload.message="${FF1_SIX_CLIENT_PICK_HANDOFF_SUCCESS_MESSAGE}"`,
    `timestamp>="${new Date(minimumTimestamp).toISOString()}"`,
    `timestamp<="${new Date(maximumTimestamp).toISOString()}"`,
  ].join(' AND ');
  return JSON.parse(runGcloud([
    'logging', 'read', filter,
    `--project=${D1N_STAGING_PROJECT_ID}`,
    '--order=asc',
    '--limit=500',
    '--format=json',
  ]));
}

async function waitForFf1SixClientPickHandoffEvidence({
  deployedFunction,
  minimumTimestamp,
  maximumTimestamp,
  expectedPickIds,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    const requestEntries = readFf1SixClientTriggerRequestLogs(
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
    );
    const markerEntries = readFf1SixClientPickHandoffMarkerLogs(
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
    );

    try {
      return assertFf1SixClientPickHandoffEvidence(
        requestEntries,
        markerEntries,
        {
          deployedFunction,
          minimumTimestamp,
          maximumTimestamp,
          expectedPickIds,
        },
      );
    } catch (error) {
      if (error?.code !== 'ERR_ASSERTION') {
        throw error;
      }
    }

    await wait(2_000);
  }

  throw new Error('The exact committed-pick handoff markers did not converge in time.');
}

async function waitForFf1SixClientTriggerRequestLogs({
  deployedFunction,
  minimumTimestamp,
  maximumTimestamp,
  minimumSuccessfulRequests,
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    const entries = readFf1SixClientTriggerRequestLogs(
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
    );
    const relevant = relevantFf1SixClientTriggerRequestLogs(
      entries,
      deployedFunction,
      minimumTimestamp,
      maximumTimestamp,
    );
    if (relevant.length >= minimumSuccessfulRequests) {
      return assertFf1SixClientTriggerRequestLogs(entries, {
        deployedFunction,
        minimumTimestamp,
        maximumTimestamp,
        minimumSuccessfulRequests,
      });
    }
    await wait(5_000);
  }
  throw new Error(`The ${deployedFunction.name} trigger logs did not converge in time.`);
}

export function assertFf1SixClientStagingSafety(environment = process.env) {
  if (
    environment.FIRESTORE_EMULATOR_HOST ||
    environment.FIREBASE_AUTH_EMULATOR_HOST ||
    environment.FIREBASE_DATABASE_EMULATOR_HOST
  ) {
    throw new Error('FF1 six-client staging evidence refuses every Emulator Suite environment.');
  }

  if (environment.FF1_SIX_CLIENT_STAGING_PROJECT_ID !== D1N_STAGING_PROJECT_ID) {
    throw new Error(`FF1_SIX_CLIENT_STAGING_PROJECT_ID must equal ${D1N_STAGING_PROJECT_ID}.`);
  }

  if (
    environment.FF1_SIX_CLIENT_STAGING_ACK !==
    FF1_SIX_CLIENT_STAGING_ACKNOWLEDGEMENT
  ) {
    throw new Error('FF1_SIX_CLIENT_STAGING_ACK does not authorize the exact rehearsal.');
  }

  if (
    environment.FF1_SIX_CLIENT_STAGING_MAINTENANCE_ACK !==
    FF1_SIX_CLIENT_STAGING_MAINTENANCE_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      'FF1_SIX_CLIENT_STAGING_MAINTENANCE_ACK does not reserve the shared staging window.',
    );
  }

  const deployedReleaseRevision =
    environment.FF1_SIX_CLIENT_DEPLOYED_RELEASE_REVISION?.trim() ?? '';

  if (!GIT_REVISION_PATTERN.test(deployedReleaseRevision)) {
    throw new Error('FF1_SIX_CLIENT_DEPLOYED_RELEASE_REVISION must be one full Git revision.');
  }

  const readinessTimeoutMilliseconds = Number(
    environment.FF1_SIX_CLIENT_READINESS_TIMEOUT_MILLISECONDS ??
      DEFAULT_READINESS_TIMEOUT_MILLISECONDS,
  );

  if (
    !Number.isInteger(readinessTimeoutMilliseconds) ||
    readinessTimeoutMilliseconds < 5 * 60 * 1000 ||
    readinessTimeoutMilliseconds > 20 * 60 * 1000
  ) {
    throw new Error(
      'FF1_SIX_CLIENT_READINESS_TIMEOUT_MILLISECONDS must be 300000 through 1200000.',
    );
  }

  return { deployedReleaseRevision, readinessTimeoutMilliseconds };
}

export function assertFf1SixClientToolingPaths(changedPaths) {
  assert.equal(Array.isArray(changedPaths), true);
  const unexpectedPaths = changedPaths.filter((path) => !ALLOWED_TOOLING_PATHS.includes(path));

  assert.deepEqual(
    unexpectedPaths,
    [],
    'The reviewed tooling revision contains runtime or deployment-input changes after the deployed release.',
  );
  return changedPaths;
}

export function assertFf1SixClientLeagueAutomationQueueConfig(data) {
  assert.ok(data && typeof data === 'object');
  assert.equal(
    data.mode,
    'shadow',
    'The six-client rehearsal requires the protected league-automation queue mode to remain shadow.',
  );
  for (const field of [
    'canaryLeagueIds',
    'internalTestLeagueIds',
    'canonicalAuthorityLeagueIds',
  ]) {
    const leagueIds = Array.isArray(data[field]) ? data[field] : [];
    assert.equal(
      leagueIds.includes(FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID),
      false,
      `The one-shot fixture must not be enrolled in ${field}.`,
    );
  }
  assert.ok(
    Number.isSafeInteger(data.maxEnqueuePerRun) && data.maxEnqueuePerRun > 0,
    'The protected league-automation queue batch limit is missing or invalid.',
  );
  assert.ok(
    Number.isSafeInteger(data.revision) && data.revision >= 0,
    'The protected league-automation queue revision is missing or invalid.',
  );

  return Object.freeze({
    sourceHash: hashFf132DocumentData(data),
    mode: data.mode,
    revision: data.revision,
    maxEnqueuePerRun: data.maxEnqueuePerRun,
  });
}

export function assertFf1SixClientMergedToolingRevision({
  branch,
  toolingRevision,
  originMainRevision,
}) {
  assert.equal(branch, 'main', 'FF1 six-client evidence must run from merged main.');
  assert.match(toolingRevision, GIT_REVISION_PATTERN);
  assert.match(originMainRevision, GIT_REVISION_PATTERN);
  assert.equal(
    toolingRevision,
    originMainRevision,
    'FF1 six-client evidence requires the exact pushed origin/main revision.',
  );
  return toolingRevision;
}

export function assertFf1SixClientPackageDelta(deployedPackage, toolingPackage) {
  assert.ok(deployedPackage && typeof deployedPackage === 'object');
  assert.ok(toolingPackage && typeof toolingPackage === 'object');
  const { scripts: deployedScripts = {}, ...deployedNonScripts } = deployedPackage;
  const { scripts: toolingScripts = {}, ...toolingNonScripts } = toolingPackage;

  assert.deepEqual(
    toolingNonScripts,
    deployedNonScripts,
    'The tooling revision changed package metadata, dependencies, or build configuration.',
  );

  const changedScripts = [...new Set([
    ...Object.keys(deployedScripts),
    ...Object.keys(toolingScripts),
  ])].filter((name) => deployedScripts[name] !== toolingScripts[name]);
  const expectedScriptNames = Object.keys(EXPECTED_PACKAGE_SCRIPTS);
  const unexpectedScripts = changedScripts.filter((name) => !expectedScriptNames.includes(name));

  assert.deepEqual(
    unexpectedScripts,
    [],
    'The tooling revision changed an unreviewed package script.',
  );

  for (const [name, expectedValue] of Object.entries(EXPECTED_PACKAGE_SCRIPTS)) {
    assert.equal(
      toolingScripts[name],
      expectedValue,
      `The reviewed package script ${name} does not have its exact expected value.`,
    );
  }

  return changedScripts;
}

export function assertFf1SixClientToolingDelta(
  deployedReleaseRevision,
  toolingRevision = readCleanGitRevision(),
) {
  runGit(['fetch', '--quiet', 'origin', 'main']);
  assertFf1SixClientMergedToolingRevision({
    branch: runGit(['branch', '--show-current']),
    toolingRevision,
    originMainRevision: runGit(['rev-parse', 'origin/main']),
  });
  verifyFf1SixClientGuardedRuntimeProvenance(deployedReleaseRevision);
  assert.equal(
    gitRevisionIsAncestor(deployedReleaseRevision, toolingRevision),
    true,
    'The declared guarded runtime must be an ancestor of the reviewed tooling commit.',
  );
  const changedPaths = runGit([
    'diff',
    '--name-only',
    `${deployedReleaseRevision}..${toolingRevision}`,
  ]).split('\n').filter(Boolean);
  assertFf1SixClientToolingPaths(changedPaths);
  assert.deepEqual(
    [...changedPaths].sort(),
    [...ALLOWED_TOOLING_PATHS].sort(),
    'The pushed tooling delta does not exactly match the reviewed FF1.32/FF1.33 evidence slice.',
  );

  if (changedPaths.includes('package.json')) {
    assertFf1SixClientPackageDelta(
      JSON.parse(runGit(['show', `${deployedReleaseRevision}:package.json`])),
      JSON.parse(runGit(['show', `${toolingRevision}:package.json`])),
    );
  }

  return { toolingRevision, changedPaths };
}

export async function verifyFf1SixClientFirestoreRules(
  deployedReleaseRevision,
  {
    accessToken = null,
    expectedRulesSource = null,
    fetchImplementation = globalThis.fetch,
  } = {},
) {
  assert.match(deployedReleaseRevision, GIT_REVISION_PATTERN);
  assert.equal(typeof fetchImplementation, 'function');
  const token = accessToken ?? runGcloud(['auth', 'print-access-token']);
  assert.ok(typeof token === 'string' && token.length > 0);
  const releaseName =
    `projects/${D1N_STAGING_PROJECT_ID}/releases/cloud.firestore`;
  const requestOptions = {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
  const releaseResponse = await fetchImplementation(
    `https://firebaserules.googleapis.com/v1/${releaseName}`,
    requestOptions,
  );

  if (!releaseResponse?.ok) {
    throw new Error(
      `The exact staging Firestore Rules release could not be read (HTTP ${releaseResponse?.status ?? 'unknown'}).`,
    );
  }

  const release = await releaseResponse.json();
  assert.equal(release?.name, releaseName);
  assert.match(
    release?.rulesetName ?? '',
    new RegExp(
      `^projects/${D1N_STAGING_PROJECT_ID}/rulesets/[A-Za-z0-9_-]+$`,
    ),
    'The active staging Firestore release points at an unexpected Rules project.',
  );
  const rulesetResponse = await fetchImplementation(
    `https://firebaserules.googleapis.com/v1/${release.rulesetName}`,
    requestOptions,
  );

  if (!rulesetResponse?.ok) {
    throw new Error(
      `The active staging Firestore Rules source could not be read (HTTP ${rulesetResponse?.status ?? 'unknown'}).`,
    );
  }

  const ruleset = await rulesetResponse.json();
  assert.equal(ruleset?.name, release.rulesetName);
  const files = Array.isArray(ruleset?.source?.files) ? ruleset.source.files : [];
  assert.equal(
    files.length,
    1,
    'The active staging Ruleset source manifest must contain exactly one file.',
  );
  assert.equal(
    files[0]?.name,
    'firestore.rules',
    'The active staging Ruleset source file has an unexpected name.',
  );
  const deployedRulesSource = files[0]?.content;
  const sourceAtRelease = expectedRulesSource ?? runGitRaw([
    'show',
    `${deployedReleaseRevision}:firestore.rules`,
  ]);

  assert.equal(typeof deployedRulesSource, 'string');
  assert.equal(
    deployedRulesSource,
    sourceAtRelease,
    'The active staging Firestore Rules do not exactly match the deployed runtime revision.',
  );

  return Object.freeze({
    releaseName,
    rulesetName: release.rulesetName,
    sourceHash: createHash('sha256').update(deployedRulesSource).digest('hex'),
  });
}

export function assertExistingFf1SixClientFixtureSafety({
  exists,
  data,
  pickCount,
  draft,
}) {
  if (!exists) {
    assert.equal(pickCount, 0);
    assert.equal(draft, undefined);
    return;
  }

  assert.equal(data?.fixtureType, FF1_SIX_CLIENT_FIXTURE_TYPE);
  assert.equal(data?.id, FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID);
  assert.equal(data?.name, 'FF1 Six-Client Draft Rehearsal');
  assert.equal(data?.maxTeams, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(data?.teamCount, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.match(
    data?.fixtureRunId ?? '',
    /^[a-f0-9-]{36}$/,
    'A prior guarded fixture is missing its exact run identity.',
  );
  assert.ok(Number.isInteger(pickCount) && pickCount >= 0);
  assert.ok(
    pickCount <= FF1_SIX_CLIENT_TOTAL_PICKS,
    'The guarded fixture contains more Draft picks than one six-manager Draft.',
  );
  assert.ok(draft && typeof draft === 'object', 'The guarded fixture Draft is missing.');
  assertFf1SixClientFixtureRunOwnership(data, draft, data.fixtureRunId);
  const roundOneOrder = Array.isArray(draft.roundOneOrder) ? draft.roundOneOrder : [];
  assert.equal(roundOneOrder.length, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(new Set(roundOneOrder).size, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(
    roundOneOrder.every((ownerId) => FIXTURE_MANAGER_UID_PATTERN.test(ownerId)),
    true,
    'A prior guarded fixture contains an unexpected manager identity.',
  );
  assert.deepEqual(
    roundOneOrder,
    Array.from({ length: FF1_SIX_CLIENT_MANAGER_COUNT }, (_, index) =>
      managerIdentity(index, data.fixtureRunId).uid),
    'A prior guarded fixture does not belong to its exact run-scoped managers.',
  );
  assert.ok(
    ['setup', 'complete'].includes(draft.status),
    'A prior guarded fixture is still scheduled or live and requires diagnosis.',
  );

  if (draft.status === 'setup') {
    assert.equal(pickCount, 0, 'A setup fixture must not contain Draft picks.');
  } else {
    assert.equal(
      pickCount,
      FF1_SIX_CLIENT_TOTAL_PICKS,
      'A completed fixture must contain exactly one six-manager Draft.',
    );
  }
}

export function assertFf1SixClientSupportingAuthoritySafety({
  leagueExists,
  fixtureRunId,
  invite,
  lifecycleStates,
}) {
  assert.equal(Array.isArray(lifecycleStates), true);
  const supportingDocuments = [invite, ...lifecycleStates]
    .filter((entry) => entry?.exists === true);

  if (supportingDocuments.length === 0) {
    assert.equal(
      leagueExists,
      false,
      'A run-scoped fixture league is missing its complete supporting authority.',
    );
    return 0;
  }

  assert.equal(
    leagueExists,
    true,
    'Synthetic supporting authority exists without the guarded fixture league.',
  );
  assert.match(
    fixtureRunId ?? '',
    /^[a-f0-9-]{36}$/,
    'Synthetic supporting authority is missing its guarded fixture run identity.',
  );
  assert.equal(
    invite?.exists,
    true,
    'Synthetic supporting authority is missing its canonical invite document.',
  );
  assert.equal(
    lifecycleStates.length,
    FF1_SIX_CLIENT_MANAGER_COUNT,
    'Synthetic supporting authority has an unexpected lifecycle-state count.',
  );
  assert.equal(
    lifecycleStates.every((entry) => entry?.exists === true),
    true,
    'Synthetic supporting authority is missing a manager lifecycle state.',
  );

  assert.equal(invite.data?.fixtureType, FF1_SIX_CLIENT_FIXTURE_TYPE);
  assert.equal(invite.data?.fixtureRunId, fixtureRunId);
  assert.equal(invite.data?.leagueId, FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID);
  assert.equal(invite.data?.inviteCode, FF1_SIX_CLIENT_FIXTURE_INVITE_CODE);

  for (const lifecycle of lifecycleStates) {
    assert.equal(lifecycle.data?.fixtureType, FF1_SIX_CLIENT_FIXTURE_TYPE);
    assert.equal(lifecycle.data?.fixtureRunId, fixtureRunId);
    assert.equal(lifecycle.data?.fixtureLeagueId, FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID);
    assert.equal(lifecycle.data?.uid, lifecycle.uid);
  }

  return supportingDocuments.length;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForValue(readValue, predicate, timeoutMilliseconds, label) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const value = await readValue();

    if (predicate(value)) {
      return value;
    }

    await wait(POLL_INTERVAL_MILLISECONDS);
  }

  throw new Error(`${label} did not converge before the bounded timeout.`);
}

export function buildFf1SixClientScheduledDraftStartTaskId(scheduledStartMilliseconds) {
  assert.equal(Number.isSafeInteger(scheduledStartMilliseconds), true);
  return buildScheduledDraftStartTaskId({
    leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
    scheduledStartMilliseconds,
  });
}

function ff1SixClientClockQueueTaskId(task) {
  const prefix =
    `projects/${D1N_STAGING_PROJECT_ID}/locations/${FF132_REGION}/queues/` +
    `${FF132_DRAFT_CLOCK_TASK_QUEUE}/tasks/`;
  const name = String(task?.name ?? '');

  assert.equal(name.startsWith(prefix), true, 'A Draft-clock task has an unexpected resource.');
  const taskId = name.slice(prefix.length);
  assert.match(taskId, SHA1_PATTERN, 'A Draft-clock task ID is malformed.');
  return taskId;
}

function expectedFf1SixClientDraftClockTaskUrl() {
  return `https://${FF132_REGION}-${D1N_STAGING_PROJECT_ID}.cloudfunctions.net/` +
    FF132_DRAFT_CLOCK_TASK_QUEUE;
}

function decodeExactFf1SixClientTaskBody(encodedBody) {
  assert.equal(typeof encodedBody, 'string', 'The Draft-clock task body is missing.');
  assert.match(
    encodedBody,
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    'The Draft-clock task body is not canonical base64.',
  );
  const decoded = Buffer.from(encodedBody, 'base64');
  assert.equal(
    decoded.toString('base64'),
    encodedBody,
    'The Draft-clock task body has ambiguous base64 encoding.',
  );
  return JSON.parse(decoded.toString('utf8'));
}

export function assertFf1SixClientScheduledStartTaskProvenance({
  task,
  expectedTaskId,
  scheduledStartMilliseconds,
  serviceAccountEmail,
}) {
  assert.equal(Number.isSafeInteger(scheduledStartMilliseconds), true);
  assert.match(expectedTaskId, SHA1_PATTERN);
  assert.equal(
    serviceAccountEmail,
    FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT,
    'The verified Draft-clock producer service identity changed.',
  );
  assert.equal(ff1SixClientClockQueueTaskId(task), expectedTaskId);

  const expectedUrl = expectedFf1SixClientDraftClockTaskUrl();
  assert.equal(task?.httpRequest?.httpMethod, 'POST');
  assert.equal(task?.httpRequest?.url, expectedUrl);
  const contentType = Object.entries(task?.httpRequest?.headers ?? {})
    .filter(([name]) => name.toLowerCase() === 'content-type');
  assert.deepEqual(contentType.map(([, value]) => value), ['application/json']);
  assert.equal(
    task?.httpRequest?.oidcToken?.serviceAccountEmail,
    FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT,
    'The Draft-clock task uses an unreviewed service identity.',
  );
  assert.ok(
    task?.httpRequest?.oidcToken?.audience === undefined ||
      task.httpRequest.oidcToken.audience === expectedUrl,
    'The Draft-clock task OIDC audience does not resolve to the exact worker.',
  );
  assert.deepEqual(
    decodeExactFf1SixClientTaskBody(task?.httpRequest?.body),
    {
      data: {
        taskType: 'scheduled-start',
        leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
        expectedScheduledStartAtMilliseconds: scheduledStartMilliseconds,
      },
    },
    'The Draft-clock task payload is not owned by the exact rehearsal schedule.',
  );
  assert.equal(task?.dispatchDeadline, DRAFT_CLOCK_TASK_DISPATCH_DEADLINE);
  assert.equal(
    Date.parse(task?.scheduleTime ?? ''),
    scheduledStartMilliseconds - DRAFT_START_TASK_WARMUP_LEAD_MILLISECONDS,
    'The Draft-clock task dispatch time does not match the exact warm-start contract.',
  );

  const dispatchCount = Number(task?.dispatchCount ?? 0);
  const responseCount = Number(task?.responseCount ?? 0);
  assert.ok(Number.isSafeInteger(dispatchCount) && dispatchCount >= 0);
  assert.ok(Number.isSafeInteger(responseCount) && responseCount >= 0);
  assert.ok(
    responseCount <= dispatchCount,
    'The Draft-clock task attempt counters are inconsistent.',
  );

  return {
    taskId: expectedTaskId,
    inFlight: dispatchCount > responseCount,
  };
}

function describeFf1SixClientDraftClockTask(taskId) {
  assert.match(taskId, SHA1_PATTERN);
  const output = runGcloud([
    'tasks',
    'describe',
    taskId,
    '--project',
    D1N_STAGING_PROJECT_ID,
    '--location',
    FF132_REGION,
    '--queue',
    FF132_DRAFT_CLOCK_TASK_QUEUE,
    '--response-view=full',
    '--format=json',
  ]);
  const task = JSON.parse(output);
  assert.equal(task && typeof task === 'object' && !Array.isArray(task), true);
  return task;
}

export function assertOnlyFf1SixClientScheduledStartTask(tasks, expectedTaskId) {
  assert.equal(Array.isArray(tasks), true);
  assert.match(expectedTaskId, SHA1_PATTERN);
  assert.ok(tasks.length <= 1, 'More than one Draft-clock task remained after bounded draining.');
  const taskIds = tasks.map(ff1SixClientClockQueueTaskId);
  assert.equal(
    taskIds.every((taskId) => taskId === expectedTaskId),
    true,
    'A Draft-clock task not owned by the exact rehearsal schedule remained queued.',
  );
  return taskIds;
}

function deleteExactFf1SixClientScheduledStartTask(taskId) {
  assert.match(taskId, SHA1_PATTERN);
  runGcloud([
    'tasks',
    'delete',
    taskId,
    '--project',
    D1N_STAGING_PROJECT_ID,
    '--location',
    FF132_REGION,
    '--queue',
    FF132_DRAFT_CLOCK_TASK_QUEUE,
    '--quiet',
  ]);
}

async function cleanFf1SixClientTaskQueues(
  scheduledStartMilliseconds,
  serviceAccountEmail,
  timeoutMilliseconds = 90_000,
) {
  const startedAt = Date.now();
  const expectedTaskId = scheduledStartMilliseconds === null
    ? null
    : buildFf1SixClientScheduledDraftStartTaskId(scheduledStartMilliseconds);

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const availabilityTasks = listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE);
    const projectionTasks = listFf132QueueTasks(FF132_PROJECTION_TASK_QUEUE);
    const clockTasks = listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE);

    if (availabilityTasks.length === 0 && projectionTasks.length === 0) {
      if (clockTasks.length === 0) {
        return true;
      }

      if (expectedTaskId !== null) {
        const taskIds = clockTasks.map(ff1SixClientClockQueueTaskId);

        if (taskIds.length <= 1 && taskIds.every((taskId) => taskId === expectedTaskId)) {
          const remainingTaskIds = assertOnlyFf1SixClientScheduledStartTask(
            clockTasks,
            expectedTaskId,
          );

          if (remainingTaskIds.length === 1) {
            let describedTask;
            try {
              describedTask = describeFf1SixClientDraftClockTask(expectedTaskId);
            } catch (error) {
              const afterDescribeRace = listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE);

              if (afterDescribeRace.length !== 0) {
                throw error;
              }
              continue;
            }
            const provenance = assertFf1SixClientScheduledStartTaskProvenance({
              task: describedTask,
              expectedTaskId,
              scheduledStartMilliseconds,
              serviceAccountEmail,
            });

            // A Cloud Task delete does not cancel an HTTP request already in
            // flight. Wait for its response so queue emptiness cannot hide a
            // worker that still owns pre-cleanup state.
            if (provenance.inFlight) {
              await wait(5_000);
              continue;
            }

            try {
              deleteExactFf1SixClientScheduledStartTask(expectedTaskId);
            } catch (error) {
              const afterDeleteRace = listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE);

              if (afterDeleteRace.length !== 0) {
                throw error;
              }
            }
          }

          const [remainingAvailability, remainingProjection, remainingClock] = [
            listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE),
            listFf132QueueTasks(FF132_PROJECTION_TASK_QUEUE),
            listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE),
          ];

          if (
            remainingAvailability.length === 0 &&
            remainingProjection.length === 0 &&
            remainingClock.length === 0
          ) {
            return true;
          }
        }
      }
    }

    await wait(5_000);
  }

  throw new Error('The staging task queues did not return to zero after exact fixture cleanup.');
}

async function cleanFf1SixClientTaskQueuesUntilQuiescent(
  scheduledStartMilliseconds,
  serviceAccountEmail,
  timeoutMilliseconds = DRAFT_TASK_QUEUE_CLEANUP_TIMEOUT_MILLISECONDS,
) {
  const startedAt = Date.now();
  let continuouslyEmptySince = null;

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const observedTaskCount = [
      FF132_AVAILABILITY_TASK_QUEUE,
      FF132_PROJECTION_TASK_QUEUE,
      FF132_DRAFT_CLOCK_TASK_QUEUE,
    ].reduce(
      (total, queue) => total + listFf132QueueTasks(queue).length,
      0,
    );

    if (observedTaskCount > 0) {
      continuouslyEmptySince = null;
    }

    await cleanFf1SixClientTaskQueues(
      scheduledStartMilliseconds,
      serviceAccountEmail,
      90_000,
    );
    const remainingTaskCount = [
      FF132_AVAILABILITY_TASK_QUEUE,
      FF132_PROJECTION_TASK_QUEUE,
      FF132_DRAFT_CLOCK_TASK_QUEUE,
    ].reduce(
      (total, queue) => total + listFf132QueueTasks(queue).length,
      0,
    );

    if (remainingTaskCount === 0) {
      continuouslyEmptySince ??= Date.now();
      if (
        Date.now() - continuouslyEmptySince >=
        DRAFT_TASK_QUEUE_QUIESCENCE_MILLISECONDS
      ) {
        return true;
      }
    } else {
      continuouslyEmptySince = null;
    }

    await wait(5_000);
  }

  throw new Error(
    'The staging task queues did not remain empty beyond the Draft-trigger lifetime.',
  );
}

function managerIdentity(index, fixtureRunId) {
  assert.match(fixtureRunId, /^[a-f0-9-]{36}$/);
  const ordinal = index + 1;
  const runLabel = fixtureRunId.replaceAll('-', '').slice(0, 12);

  return {
    alias: `manager-${ordinal}`,
    uid: `ff1-six-client-${runLabel}-manager-${ordinal}`,
    email: `manager-${ordinal}-${runLabel}@ff1-draft.rinkrat.test`,
    teamName: `FF1 Rehearsal Team ${ordinal}`,
  };
}

function createPassword() {
  return `Ff1!${randomBytes(28).toString('base64url')}`;
}

async function readFf1SixClientLeagueAutomationQueueConfig(firestore) {
  const snapshot = await firestore.doc('appData/leagueAutomationQueueConfig').get();

  assert.ok(
    snapshot.exists,
    'The protected staging league-automation queue configuration is missing.',
  );
  return assertFf1SixClientLeagueAutomationQueueConfig(snapshot.data() ?? {});
}

async function readStrictSharedAvailability(firestore, requiredThroughMilliseconds) {
  const snapshot = await firestore.doc('appData/playerAvailability').get();

  assert.ok(snapshot.exists, 'The server-attested staging availability baseline is missing.');
  return assertStrictSchema2AvailabilityBaseline(
    snapshot.data() ?? {},
    requiredThroughMilliseconds,
  );
}

function timestampMilliseconds(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

const VALID_AVAILABILITY_STATUSES = new Set([
  'active',
  'day-to-day',
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
  'suspended',
  'personal-leave',
  'unknown',
]);

function availabilityIsoDate(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }

  return '';
}

export function buildFf1SixClientAvailabilityRevision(data) {
  assert.ok(data && typeof data === 'object');
  const recordsByPlayerId = new Map();

  for (const value of Array.isArray(data.records) ? data.records : []) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const playerId = value.playerId;
    const playerName = value.playerName;
    const status = value.status;

    if (
      typeof playerId !== 'number' ||
      !Number.isFinite(playerId) ||
      typeof playerName !== 'string' ||
      typeof status !== 'string' ||
      !VALID_AVAILABILITY_STATUSES.has(status)
    ) {
      continue;
    }

    recordsByPlayerId.set(playerId, {
      playerId,
      status,
      note: typeof value.note === 'string' ? value.note : '',
      updatedAt: availabilityIsoDate(value.updatedAt),
      updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : '',
      source: value.source === 'commissioner' ? 'commissioner' : 'espn',
      externalStatus: typeof value.externalStatus === 'string' ? value.externalStatus : '',
      externalReturnDate:
        typeof value.externalReturnDate === 'string' ? value.externalReturnDate : '',
      externalInjuryDate:
        typeof value.externalInjuryDate === 'string' ? value.externalInjuryDate : '',
      syncedAt: availabilityIsoDate(value.syncedAt),
    });
  }

  const lastSuccessfulAt = availabilityIsoDate(data.lastSuccessfulSyncAt) || null;
  const orderedRecords = [...recordsByPlayerId.values()]
    .sort((left, right) => left.playerId - right.playerId);

  return createHash('sha256')
    .update(JSON.stringify({
      lastSuccessfulAt,
      lastDailySyncKey: typeof data.lastDailySyncKey === 'string'
        ? data.lastDailySyncKey
        : '',
      draftReadinessNhlRosterIdentityHash:
        typeof data.draftReadinessNhlRosterIdentityHash === 'string'
          ? data.draftReadinessNhlRosterIdentityHash
          : '',
      records: orderedRecords,
    }))
    .digest('hex');
}

export function assertFf1SixClientDraftInventory(entries, now = Date.now()) {
  assert.equal(Array.isArray(entries), true);
  assert.ok(entries.length <= MAX_DRAFT_INVENTORY, 'The staging Draft inventory is not bounded.');

  for (const entry of entries) {
    if (entry.documentId !== 'current') {
      continue;
    }

    const leagueId = entry.leagueId ?? '';
    const draft = entry.draft ?? {};

    if (leagueId === D1N_FIXTURE_LEAGUE_ID && draft.status === 'scheduled') {
      assert.equal(draft.clockStatus, 'stopped');
      assert.equal(draft.nextOverallPick, 1);
      assert.deepEqual(draft.draftedAssetKeys ?? [], []);
      const scheduledStartMilliseconds = timestampMilliseconds(draft.scheduledStartAt);
      assert.ok(
        scheduledStartMilliseconds !== null &&
          scheduledStartMilliseconds >= now + 60 * 60 * 1000,
        'The D1N staging fixture is inside the six-client rehearsal window.',
      );
      continue;
    }

    assert.equal(
      ['scheduled', 'live'].includes(draft.status),
      false,
      'Another staging Draft could be touched by server automation during the rehearsal.',
    );
  }

  return entries.length;
}

async function assertBoundedDraftInventory(firestore) {
  const snapshot = await firestore.collectionGroup('draft').limit(MAX_DRAFT_INVENTORY + 1).get();

  return assertFf1SixClientDraftInventory(
    snapshot.docs.map((document) => ({
      documentId: document.id,
      leagueId: document.ref.parent.parent?.id ?? '',
      draft: document.data() ?? {},
    })),
  );
}

async function releaseSharedEvidenceLock(firestore, lockRef, runId) {
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lockRef);

    assert.ok(snapshot.exists, 'The shared staging evidence lock disappeared before release.');
    assert.equal(snapshot.get('status'), 'running');
    assert.equal(snapshot.get('runId'), runId);
    transaction.delete(lockRef);
  });
}

async function retainSharedEvidenceLockForCleanup(firestore, lockRef, runId) {
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lockRef);

    assert.ok(
      snapshot.exists,
      'The shared staging evidence lock disappeared before cleanup retention.',
    );
    assert.equal(
      snapshot.get('runId'),
      runId,
      'The shared staging evidence lock belongs to another evidence run.',
    );
    assert.ok(
      ['running', 'cleanup-required'].includes(snapshot.get('status')),
      'The shared staging evidence lock has an unsafe status for cleanup retention.',
    );

    transaction.set(lockRef, {
      status: 'cleanup-required',
      cleanupRequiredAt: new Date(),
    }, { merge: true });
  });

  const retainedSnapshot = await lockRef.get();
  assert.ok(retainedSnapshot.exists);
  assert.equal(retainedSnapshot.get('runId'), runId);
  assert.equal(retainedSnapshot.get('status'), 'cleanup-required');
}

export function assertFf1SixClientRetainedV1BoundaryStable(actual, expected) {
  assert.ok(
    expected && typeof expected === 'object',
    'The retained FF1.29 starting boundary was not captured.',
  );
  assert.deepEqual(
    actual,
    expected,
    'The retained FF1.29 no-Cycle-1 audit boundary changed during FF1.33.',
  );
  return true;
}

export function canReleaseFf1SixClientEvidenceLock({
  completed,
  safeFailureParked,
  clientSessionsSafe,
  fixtureAccountsSafe,
  queuesClean,
  retainedV1BoundaryStable,
  historicalReplayRequestsQuiet,
  sharedGuardedTaskQueuesQuiet,
}) {
  return Boolean(
    (completed || safeFailureParked) &&
      clientSessionsSafe &&
      fixtureAccountsSafe &&
      queuesClean &&
      retainedV1BoundaryStable &&
      historicalReplayRequestsQuiet &&
      sharedGuardedTaskQueuesQuiet,
  );
}

export function assertFf1SixClientHistoricalReplayRequestsQuiet(requestCount) {
  assert.equal(Number.isSafeInteger(requestCount), true);
  assert.equal(
    requestCount,
    0,
    'A Historical Replay request is queued or processing in isolated staging.',
  );
  return true;
}

async function readAndAssertFf1SixClientHistoricalReplayRequestsQuiet(firestore) {
  const snapshot = await firestore
    .collection('historicalReplayRequests')
    .where('status', 'in', ['queued', 'processing'])
    .limit(1)
    .get();
  return assertFf1SixClientHistoricalReplayRequestsQuiet(snapshot.size);
}

export function assertFf1SixClientRetainedFixtureSafe(draft, pickCount, now = Date.now()) {
  assert.ok(draft && typeof draft === 'object');
  assert.ok(Number.isInteger(pickCount) && pickCount >= 0);
  assert.ok(pickCount <= FF1_SIX_CLIENT_TOTAL_PICKS);

  if (draft.status === 'scheduled') {
    assert.equal(pickCount, 0, 'A safely parked scheduled fixture must contain zero picks.');
    assert.equal(draft.clockStatus, 'stopped');
    assert.ok(
      (timestampMilliseconds(draft.scheduledStartAt) ?? 0) >=
        now + SAFE_RESET_MILLISECONDS - 60_000,
      'A failed scheduled rehearsal was not moved to the safe reset horizon.',
    );
  } else if (draft.status === 'live') {
    assert.equal(draft.clockStatus, 'paused');
    assert.equal(draft.pickStartedAt ?? null, null);
  } else if (draft.status === 'setup') {
    assert.equal(pickCount, 0, 'A safely retained setup fixture must contain zero picks.');
  } else {
    assert.equal(draft.status, 'complete');
    assert.equal(
      pickCount,
      FF1_SIX_CLIENT_TOTAL_PICKS,
      'A complete retained fixture must contain the full Draft exactly once.',
    );
  }

  return true;
}

export function assertFf1SixClientFixtureRunOwnership(league, draft, fixtureRunId) {
  assert.match(fixtureRunId, /^[a-f0-9-]{36}$/);
  assert.equal(league?.fixtureType, FF1_SIX_CLIENT_FIXTURE_TYPE);
  assert.equal(league?.id, FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID);
  assert.equal(
    league?.fixtureRunId,
    fixtureRunId,
    'Fixture ownership belongs to another rehearsal run.',
  );
  assert.equal(
    draft?.fixtureRunId,
    fixtureRunId,
    'Draft ownership belongs to another rehearsal run.',
  );
  return true;
}

function ff1SixClientRecurringAutomationReferences(firestore) {
  const leagueRef = firestore.doc(`leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`);

  return {
    leagueRef,
    draftRef: leagueRef.collection('draft').doc('current'),
    cycleRef: leagueRef.collection('cycles').doc('cycle-1'),
    controlRef: leagueRef.collection('liveScoring').doc('control'),
    replayControlRef: leagueRef.collection('historicalReplay').doc('control'),
    scheduleRef: firestore.doc(
      `leagueAutomationSchedules/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`,
    ),
  };
}

async function writeFf1SixClientRecurringAutomationPark({
  firestore,
  FieldValue,
  Timestamp,
  fixtureRunId,
  requireSuccessfulCycleOne,
  expectedDraftStatus = 'complete',
  installHistoricalReplayGuard = false,
}) {
  const {
    leagueRef,
    draftRef,
    cycleRef,
    controlRef,
    replayControlRef,
    scheduleRef,
  } = ff1SixClientRecurringAutomationReferences(firestore);
  const fixtureTasksQuery = firestore
    .collection('leagueAutomationTasks')
    .where('leagueId', '==', FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID)
    .limit(1);
  const replayDate = new Date().toISOString().slice(0, 10);

  await firestore.runTransaction(async (transaction) => {
    const [
      leagueSnapshot,
      draftSnapshot,
      cycleSnapshot,
      controlSnapshot,
      replaySnapshot,
      scheduleSnapshot,
      fixtureTasksSnapshot,
    ] = await Promise.all([
      transaction.get(leagueRef),
      transaction.get(draftRef),
      transaction.get(cycleRef),
      transaction.get(controlRef),
      transaction.get(replayControlRef),
      transaction.get(scheduleRef),
      transaction.get(fixtureTasksQuery),
    ]);
    assert.ok(leagueSnapshot.exists && draftSnapshot.exists);
    assertFf1SixClientFixtureRunOwnership(
      leagueSnapshot.data() ?? {},
      draftSnapshot.data() ?? {},
      fixtureRunId,
    );
    assert.equal(draftSnapshot.get('status'), expectedDraftStatus);
    assert.notEqual(
      controlSnapshot.get('status'),
      'refreshing',
      'A server scoring worker still owns the fixture control lease.',
    );
    assert.equal(
      ['queued', 'processing'].includes(scheduleSnapshot.get('queueStatus')),
      false,
      'A queued scoring worker still owns the fixture schedule.',
    );
    assert.equal(
      scheduleSnapshot.get('activeTaskId') ?? null,
      null,
      'The fixture schedule still points at a queued scoring task.',
    );
    assert.equal(
      fixtureTasksSnapshot.empty,
      true,
      'The one-shot fixture unexpectedly has league-automation task history.',
    );

    if (replaySnapshot.exists) {
      assert.equal(replaySnapshot.get('fixtureType'), FF1_SIX_CLIENT_FIXTURE_TYPE);
      assert.equal(replaySnapshot.get('fixtureRunId'), fixtureRunId);
    }

    if (requireSuccessfulCycleOne) {
      assert.ok(cycleSnapshot.exists, 'The completed Draft did not create Cycle 1.');
      assert.equal(draftSnapshot.get('cycleOneStartStatus'), 'started');
      assert.equal(cycleSnapshot.get('id'), 'cycle-1');
      assert.equal(cycleSnapshot.get('cycleNumber'), 1);
      assert.equal(cycleSnapshot.get('status'), 'active');
      assert.equal(cycleSnapshot.get('phase'), 'regular_season');
      assert.equal(cycleSnapshot.get('totalExpectedWindowCount'), 84);
      assert.equal(cycleSnapshot.get('activeWindowCount'), 84);
      assert.equal(cycleSnapshot.get('completedWindowCount'), 0);
      assert.equal(controlSnapshot.get('status'), 'idle');
      assert.ok(
        ['draft-complete', 'season-start'].includes(
          controlSnapshot.get('lastRefreshReason'),
        ),
      );
      assert.equal(draftSnapshot.get('status'), 'complete');
    }

    if (installHistoricalReplayGuard) {
      transaction.set(replayControlRef, {
        enabled: true,
        status: 'ready',
        targetSeason: 'guarded-staging-fixture',
        sourceSeason: 'guarded-staging-fixture',
        simulatedDate: replayDate,
        seasonStartDate: replayDate,
        daysAdvanced: 0,
        lastReleasedGameCount: 0,
        totalReleasedGameCount: 0,
        message: 'Completed FF1.33 fixture is parked outside recurring live scoring.',
        fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
        fixtureRunId,
        ...(!replaySnapshot.exists
          ? { createdAt: FieldValue.serverTimestamp() }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    transaction.set(scheduleRef, {
      scoringEnabled: false,
      queueStatus: 'paused',
      pausedReason: installHistoricalReplayGuard
        ? 'guarded-six-client-evidence-complete'
        : 'guarded-six-client-evidence-quiescing',
      nextScoringAt: FieldValue.delete(),
      activeTaskId: null,
      activeTaskDueAt: FieldValue.delete(),
      activeTaskLeaseExpiresAt: FieldValue.delete(),
      lastOutcome: 'paused',
      lastTrigger: installHistoricalReplayGuard
        ? 'historical-replay'
        : 'guarded-evidence-park',
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      fixtureRunId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(controlRef, {
      id: 'control',
      automationMode: installHistoricalReplayGuard ? 'historical-replay' : 'server',
      serverAutomationEnabled: false,
      historicalReplayEnabled: installHistoricalReplayGuard,
      historicalReplayDate: installHistoricalReplayGuard
        ? replayDate
        : FieldValue.delete(),
      status: 'idle',
      holderUserId: null,
      holderClientId: '',
      leaseExpiresAt: Timestamp.fromMillis(Date.now()),
      nextRefreshAt: Timestamp.fromMillis(Date.now() + SAFE_RESET_MILLISECONDS),
      lastError: '',
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      fixtureRunId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

function isFf1SixClientRecurringAutomationParked({
  league,
  draft,
  control,
  replay,
  schedule,
  fixtureRunId,
  expectedDraftStatus,
  requireHistoricalReplayGuard,
}) {
  try {
    assert.ok(league.exists && draft.exists && control.exists && schedule.exists);
    assertFf1SixClientFixtureRunOwnership(
      league.data() ?? {},
      draft.data() ?? {},
      fixtureRunId,
    );
    assert.equal(draft.get('status'), expectedDraftStatus);
    if (requireHistoricalReplayGuard) {
      assert.ok(replay.exists);
      assert.equal(replay.get('enabled'), true);
      assert.equal(replay.get('fixtureType'), FF1_SIX_CLIENT_FIXTURE_TYPE);
      assert.equal(replay.get('fixtureRunId'), fixtureRunId);
    }
    assert.equal(control.get('status'), 'idle');
    assert.equal(control.get('serverAutomationEnabled'), false);
    if (requireHistoricalReplayGuard) {
      assert.equal(control.get('historicalReplayEnabled'), true);
    }
    assert.equal(control.get('holderClientId'), '');
    assert.equal(control.get('fixtureRunId'), fixtureRunId);
    assert.ok((timestampMilliseconds(control.get('leaseExpiresAt')) ?? Infinity) <= Date.now());
    assert.ok(
      (timestampMilliseconds(control.get('nextRefreshAt')) ?? 0) >=
        Date.now() + SERVER_AUTOMATION_QUIESCENCE_MILLISECONDS,
    );
    assert.equal(schedule.get('scoringEnabled'), false);
    assert.equal(schedule.get('queueStatus'), 'paused');
    assert.equal(schedule.get('activeTaskId') ?? null, null);
    assert.equal(schedule.get('fixtureRunId'), fixtureRunId);
    return true;
  } catch {
    return false;
  }
}

async function parkFf1SixClientRecurringAutomationUntilQuiescent({
  firestore,
  FieldValue,
  Timestamp,
  fixtureRunId,
  requireSuccessfulCycleOne,
  expectedDraftStatus = 'complete',
  persistHistoricalReplayGuard = true,
}) {
  const {
    leagueRef,
    draftRef,
    controlRef,
    replayControlRef,
    scheduleRef,
  } = ff1SixClientRecurringAutomationReferences(firestore);
  const startedAt = Date.now();
  let continuouslyParkedSince = null;
  let phase = 'server-worker-quiescence';

  while (Date.now() - startedAt < SERVER_AUTOMATION_PARK_TIMEOUT_MILLISECONDS) {
    const [league, draft, control, replay, schedule] = await firestore.getAll(
      leagueRef,
      draftRef,
      controlRef,
      replayControlRef,
      scheduleRef,
    );
    const historicalReplayGuardInstalled =
      isFf1SixClientRecurringAutomationParked({
        league,
        draft,
        control,
        replay,
        schedule,
        fixtureRunId,
        expectedDraftStatus,
        requireHistoricalReplayGuard: true,
      });
    if (phase === 'server-worker-quiescence' && historicalReplayGuardInstalled) {
      phase = 'persistent-guard-quiescence';
      continuouslyParkedSince = null;
    }
    const requireHistoricalReplayGuard = phase === 'persistent-guard-quiescence';
    const parked = isFf1SixClientRecurringAutomationParked({
      league,
      draft,
      control,
      replay,
      schedule,
      fixtureRunId,
      expectedDraftStatus,
      requireHistoricalReplayGuard,
    });

    if (parked) {
      continuouslyParkedSince ??= Date.now();

      const requiredQuietMilliseconds = requireHistoricalReplayGuard
        ? DRAFT_TRIGGER_QUIESCENCE_MILLISECONDS
        : SERVER_AUTOMATION_QUIESCENCE_MILLISECONDS;

      if (Date.now() - continuouslyParkedSince >= requiredQuietMilliseconds) {
        if (!persistHistoricalReplayGuard || requireHistoricalReplayGuard) {
          return true;
        }

        await writeFf1SixClientRecurringAutomationPark({
          firestore,
          FieldValue,
          Timestamp,
          fixtureRunId,
          requireSuccessfulCycleOne,
          expectedDraftStatus,
          installHistoricalReplayGuard: true,
        });
        phase = 'persistent-guard-quiescence';
        continuouslyParkedSince = null;
      }
    } else {
      continuouslyParkedSince = null;
      const serverWorkerActive = control.get('status') === 'refreshing';
      const queuedWorkerActive =
        ['queued', 'processing'].includes(schedule.get('queueStatus')) ||
        Boolean(schedule.get('activeTaskId'));

      if (serverWorkerActive || queuedWorkerActive) {
        await wait(5_000);
        continue;
      }
      await writeFf1SixClientRecurringAutomationPark({
        firestore,
        FieldValue,
        Timestamp,
        fixtureRunId,
        requireSuccessfulCycleOne,
        expectedDraftStatus,
        installHistoricalReplayGuard: requireHistoricalReplayGuard,
      });
    }

    await wait(5_000);
  }

  throw new Error(
    'The completed fixture did not remain parked beyond the maximum server-worker lifetime.',
  );
}

async function parkRetainedFixtureAfterFailure(
  firestore,
  FieldValue,
  Timestamp,
  fixtureRunId,
) {
  assert.match(fixtureRunId, /^[a-f0-9-]{36}$/);
  const leagueRef = firestore.doc(`leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`);
  const draftRef = leagueRef.collection('draft').doc('current');
  const picksSnapshot = await draftRef
    .collection('picks')
    .limit(FF1_SIX_CLIENT_TOTAL_PICKS + 1)
    .get();

  assert.ok(
    picksSnapshot.size <= FF1_SIX_CLIENT_TOTAL_PICKS,
    'The failed rehearsal exceeds the bounded fixture pick count.',
  );

  await firestore.runTransaction(async (transaction) => {
    const [leagueSnapshot, draftSnapshot] = await Promise.all([
      transaction.get(leagueRef),
      transaction.get(draftRef),
    ]);

    if (!leagueSnapshot.exists && !draftSnapshot.exists) {
      const [
        inviteSnapshot,
        memberSnapshot,
        teamSnapshot,
        queueSnapshot,
        lifecycleSnapshot,
      ] = await Promise.all([
        transaction.get(
          firestore.doc(`leagueInvites/${FF1_SIX_CLIENT_FIXTURE_INVITE_CODE}`),
        ),
        transaction.get(leagueRef.collection('members').limit(1)),
        transaction.get(leagueRef.collection('teams').limit(1)),
        transaction.get(draftRef.collection('queues').limit(1)),
        transaction.get(
          firestore
            .collection('leagueLifecycleState')
            .where('fixtureLeagueId', '==', FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID)
            .limit(1),
        ),
      ]);
      assert.equal(inviteSnapshot.exists, false);
      assert.equal(memberSnapshot.empty, true);
      assert.equal(teamSnapshot.empty, true);
      assert.equal(queueSnapshot.empty, true);
      assert.equal(lifecycleSnapshot.empty, true);
      return;
    }

    assert.ok(leagueSnapshot.exists && draftSnapshot.exists);
    const draft = draftSnapshot.data() ?? {};
    assertFf1SixClientFixtureRunOwnership(
      leagueSnapshot.data() ?? {},
      draft,
      fixtureRunId,
    );

    if (draft.status === 'scheduled') {
      transaction.set(draftRef, {
        scheduledStartAt: Timestamp.fromMillis(Date.now() + SAFE_RESET_MILLISECONDS),
        clockStatus: 'stopped',
        pickStartedAt: null,
        currentPickSeconds: draft.pickSeconds ?? DRAFT_PICK_SECONDS,
        pausedRemainingSeconds: null,
        serverAutomationStatus: 'scheduled',
        serverAutomationMessage:
          'Guarded six-client rehearsal retained safely after an evidence failure.',
        serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } else if (draft.status === 'live') {
      transaction.set(draftRef, {
        clockStatus: 'paused',
        pickStartedAt: null,
        pausedRemainingSeconds:
          Number.isFinite(draft.currentPickSeconds) && draft.currentPickSeconds > 0
            ? draft.currentPickSeconds
            : draft.pickSeconds ?? DRAFT_PICK_SECONDS,
        serverAutomationStatus: 'paused',
        serverAutomationMessage:
          'Guarded six-client rehearsal retained paused after an evidence failure.',
        serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      assert.ok(['setup', 'complete'].includes(draft.status));
    }
  });

  const [retainedDraftSnapshot, retainedPicksSnapshot] = await Promise.all([
    draftRef.get(),
    draftRef.collection('picks').limit(FF1_SIX_CLIENT_TOTAL_PICKS + 1).get(),
  ]);

  if (!retainedDraftSnapshot.exists) {
    await assertEmptyFf1SixClientFixtureNamespace(firestore);
    return true;
  }

  assertFf1SixClientRetainedFixtureSafe(
    retainedDraftSnapshot.data() ?? {},
    retainedPicksSnapshot.size,
  );

  if (retainedDraftSnapshot.get('status') === 'complete') {
    // A complete Draft can have an atomically created Cycle 1 before the
    // separate Draft lifecycle marker is persisted. Evidence must still fail
    // in that state, but cleanup must not leave the one-shot fixture eligible
    // for recurring scoring. This guard waits out every visible worker lease
    // and queue owner, then repeatedly disables fixture automation without
    // requiring a successful or even complete Cycle 1 proof.
    await parkFf1SixClientRecurringAutomationUntilQuiescent({
      firestore,
      FieldValue,
      Timestamp,
      fixtureRunId,
      requireSuccessfulCycleOne: false,
    });
  }

  return true;
}

async function getOptionalFixtureUser(auth, lookup, value) {
  try {
    return lookup === 'email'
      ? await auth.getUserByEmail(value)
      : await auth.getUser(value);
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      return null;
    }

    throw error;
  }
}

async function disableFixtureUsers(auth, identities, requirePresent = true) {
  let securedIdentityCount = 0;
  const failures = [];

  for (const identity of identities) {
    try {
      const [userByUid, userByEmail] = await Promise.all([
        getOptionalFixtureUser(auth, 'uid', identity.uid),
        identity.email
          ? getOptionalFixtureUser(auth, 'email', identity.email)
          : Promise.resolve(null),
      ]);

      if (!userByUid && !userByEmail) {
        assert.equal(
          requirePresent,
          false,
          `Synthetic rehearsal account ${identity.uid} disappeared before cleanup.`,
        );
        securedIdentityCount += 1;
        continue;
      }

      assert.ok(userByUid, 'A synthetic rehearsal email points at an unexpected Auth account.');
      if (identity.email) {
        assert.ok(userByEmail, 'A synthetic rehearsal UID has an unexpected Auth email.');
        assert.equal(userByEmail.uid, identity.uid);
        assert.equal(userByUid.email, identity.email);
      }
      assert.equal(userByUid.uid, identity.uid);
      assert.match(userByUid.uid, FIXTURE_MANAGER_UID_PATTERN);
      await auth.updateUser(identity.uid, { disabled: true });
      await auth.revokeRefreshTokens(identity.uid);
      const disabledUser = await auth.getUser(identity.uid);
      assert.equal(disabledUser.disabled, true);
      securedIdentityCount += 1;
    } catch {
      failures.push(identity.alias);
    }
  }

  assert.deepEqual(
    failures,
    [],
    'One or more synthetic rehearsal accounts could not be verified absent or disabled.',
  );
  assert.equal(
    securedIdentityCount,
    identities.length,
    'Every attempted synthetic rehearsal account must be absent or verified disabled.',
  );
  return securedIdentityCount;
}

async function assertEmptyFf1SixClientFixtureNamespace(firestore) {
  const leagueRef = firestore.doc(`leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`);
  const draftRef = leagueRef.collection('draft').doc('current');
  const inviteRef = firestore.doc(`leagueInvites/${FF1_SIX_CLIENT_FIXTURE_INVITE_CODE}`);
  const immediateCollections = await leagueRef.listCollections();
  const descendantDocumentReferences = (
    await Promise.all(immediateCollections.map((collection) => collection.listDocuments()))
  ).flat();
  const [
    leagueSnapshot,
    draftSnapshot,
    picksSnapshot,
    inviteSnapshot,
    membersSnapshot,
    teamsSnapshot,
    queuesSnapshot,
    lifecycleSnapshot,
    automationScheduleSnapshot,
    automationTasksSnapshot,
    projectionRequestsSnapshot,
  ] = await Promise.all([
    leagueRef.get(),
    draftRef.get(),
    draftRef.collection('picks').limit(1).get(),
    inviteRef.get(),
    leagueRef.collection('members').limit(1).get(),
    leagueRef.collection('teams').limit(1).get(),
    draftRef.collection('queues').limit(1).get(),
    firestore
      .collection('leagueLifecycleState')
      .where('fixtureLeagueId', '==', FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID)
      .limit(1)
      .get(),
    firestore.doc(`leagueAutomationSchedules/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`).get(),
    firestore
      .collection('leagueAutomationTasks')
      .where('leagueId', '==', FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID)
      .limit(1)
      .get(),
    firestore
      .collection('projectionGenerationRequests')
      .where('leagueId', '==', FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID)
      .limit(1)
      .get(),
  ]);

  assertExistingFf1SixClientFixtureSafety({
    exists: leagueSnapshot.exists,
    data: leagueSnapshot.data(),
    pickCount: picksSnapshot.size,
    draft: draftSnapshot.exists ? draftSnapshot.data() : undefined,
  });
  assertFf1SixClientSupportingAuthoritySafety({
    leagueExists: leagueSnapshot.exists,
    fixtureRunId: undefined,
    invite: {
      exists: inviteSnapshot.exists,
      data: inviteSnapshot.data(),
    },
    lifecycleStates: lifecycleSnapshot.docs.map((snapshot) => ({
      exists: true,
      data: snapshot.data(),
      uid: snapshot.id,
    })),
  });
  assert.equal(membersSnapshot.empty, true, 'The one-shot fixture namespace has member orphans.');
  assert.equal(teamsSnapshot.empty, true, 'The one-shot fixture namespace has team orphans.');
  assert.equal(queuesSnapshot.empty, true, 'The one-shot fixture namespace has queue orphans.');
  assert.deepEqual(
    descendantDocumentReferences.map((reference) => reference.path).sort(),
    [],
    'The one-shot fixture namespace has descendant documents or orphan subcollections.',
  );
  assert.equal(
    automationScheduleSnapshot.exists,
    false,
    'The one-shot fixture namespace already has a scoring schedule.',
  );
  assert.equal(
    automationTasksSnapshot.empty,
    true,
    'The one-shot fixture namespace already has scoring task history.',
  );
  assert.equal(
    projectionRequestsSnapshot.empty,
    true,
    'The one-shot fixture namespace already has Projection request history.',
  );
  return true;
}

async function createFixtureUsers(auth, identities, password, createdIdentities) {
  assert.equal(Array.isArray(createdIdentities), true);

  for (const identity of identities) {
    createdIdentities.push(identity);
    await auth.createUser({
      uid: identity.uid,
      email: identity.email,
      password,
      emailVerified: true,
      disabled: false,
      displayName: identity.alias,
    });
  }
}

async function seedFixtureDocuments(firestore, identities, fixtureRunId) {
  assert.match(fixtureRunId, /^[a-f0-9-]{36}$/);
  const now = new Date();
  const template = buildD1nFixtureDocuments(identities[0].uid, now, {
    draftStatus: 'scheduled',
    draftStartOffsetMinutes: 30,
  });
  const templateRoster = template.documents.get(
    `leagues/d1n-capacity-league/teams/${identities[0].uid}/roster/current`,
  );
  const templateLeague = template.documents.get('leagues/d1n-capacity-league');
  const templateTeam = template.documents.get(
    `leagues/d1n-capacity-league/teams/${identities[0].uid}`,
  );
  assert.ok(templateLeague && templateTeam && templateRoster);
  const batch = firestore.batch();
  const create = (reference, data) => {
    batch.create(reference, data);
  };
  const leaguePrefix = `leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`;

  create(firestore.doc(leaguePrefix), {
    ...templateLeague,
    id: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
    name: 'FF1 Six-Client Draft Rehearsal',
    commissionerId: identities[0].uid,
    inviteCode: FF1_SIX_CLIENT_FIXTURE_INVITE_CODE,
    maxTeams: FF1_SIX_CLIENT_MANAGER_COUNT,
    teamCount: FF1_SIX_CLIENT_MANAGER_COUNT,
    joinStatus: 'full',
    fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
    fixtureRunId,
    fixtureAuthority: 'guarded-admin-provisioning-only',
    createdAt: now,
    updatedAt: now,
  });
  create(
    firestore.doc(`leagueInvites/${FF1_SIX_CLIENT_FIXTURE_INVITE_CODE}`),
    {
      schemaVersion: 1,
      inviteCode: FF1_SIX_CLIENT_FIXTURE_INVITE_CODE,
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      createdBy: identities[0].uid,
      active: false,
      joinCount: FF1_SIX_CLIENT_MANAGER_COUNT,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      lockedAt: now,
      lockedReason: 'league-full',
      lastJoinedAt: now,
      authority: 'cloud-function',
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      fixtureRunId,
      createdAt: now,
      updatedAt: now,
    },
  );

  create(firestore.doc(`${leaguePrefix}/draft/current`), {
    schemaVersion: 3,
    status: 'setup',
    fixtureRunId,
    format: 'snake',
    totalRounds: FF1_SIX_CLIENT_TOTAL_ROUNDS,
    rosterRequirements: { LW: 3, C: 3, RW: 3, D: 4, G: 1 },
    benchSlots: 3,
    roundOneOrder: identities.map((identity) => identity.uid),
    nextOverallPick: 1,
    draftedAssetKeys: [],
    scheduledStartAt: null,
    pickSeconds: DRAFT_PICK_SECONDS,
    clockStatus: 'stopped',
    pickStartedAt: null,
    currentPickSeconds: DRAFT_PICK_SECONDS,
    pausedRemainingSeconds: null,
    clockUpdatedBy: null,
    clockUpdatedAt: now,
    lastPickId: null,
    createdAt: now,
    updatedAt: now,
  });

  identities.forEach((identity, index) => {
    create(firestore.doc(`${leaguePrefix}/members/${identity.uid}`), {
      schemaVersion: 1,
      uid: identity.uid,
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      username: identity.alias,
      profileIconId: 'emerald-visor',
      role: index === 0 ? 'commissioner' : 'member',
      inviteCodeUsed: null,
      joinedAt: now,
      authority: 'guarded-staging-fixture',
    });
    create(firestore.doc(`${leaguePrefix}/teams/${identity.uid}`), {
      ...templateTeam,
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
      waiverPriority: index + 1,
      draftPosition: index + 1,
      authority: 'league-lifecycle-authority',
      createdAt: now,
      updatedAt: now,
    });
    create(firestore.doc(`${leaguePrefix}/teams/${identity.uid}/roster/current`), {
      ...templateRoster,
      createdAt: now,
      updatedAt: now,
    });
    create(firestore.doc(`${leaguePrefix}/draft/current/queues/${identity.uid}`), {
      ownerId: identity.uid,
      assetKeys: [],
      autoDraftEnabled: false,
      consecutiveClockExpirations: 0,
      autoDraftActivatedByTimeout: false,
      updatedAt: now,
    });
    create(firestore.doc(`leagueLifecycleState/${identity.uid}`), {
      schemaVersion: 1,
      uid: identity.uid,
      activeLeagueCount: 1,
      fixtureLeagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      fixtureType: FF1_SIX_CLIENT_FIXTURE_TYPE,
      fixtureRunId,
      createdAt: now,
      updatedAt: now,
    });
  });

  await batch.commit();
}

async function verifySeededFixtureDocuments(firestore, identities, fixtureRunId) {
  const leagueRef = firestore.doc(`leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`);
  const draftRef = leagueRef.collection('draft').doc('current');
  const inviteRef = firestore.doc(`leagueInvites/${FF1_SIX_CLIENT_FIXTURE_INVITE_CODE}`);
  const rosterRefs = identities.map((identity) =>
    leagueRef.collection('teams').doc(identity.uid).collection('roster').doc('current'));
  const lifecycleRefs = identities.map((identity) =>
    firestore.doc(`leagueLifecycleState/${identity.uid}`));
  const [
    leagueSnapshot,
    draftSnapshot,
    picksSnapshot,
    inviteSnapshot,
    membersSnapshot,
    teamsSnapshot,
    queuesSnapshot,
    rosterSnapshots,
    lifecycleSnapshots,
  ] = await Promise.all([
    leagueRef.get(),
    draftRef.get(),
    draftRef.collection('picks').limit(1).get(),
    inviteRef.get(),
    leagueRef.collection('members').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    leagueRef.collection('teams').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    draftRef.collection('queues').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    firestore.getAll(...rosterRefs),
    firestore.getAll(...lifecycleRefs),
  ]);
  const ownerIds = identities.map((identity) => identity.uid);
  const expectedOwnerIds = [...ownerIds].sort();

  assertExistingFf1SixClientFixtureSafety({
    exists: leagueSnapshot.exists,
    data: leagueSnapshot.data(),
    pickCount: picksSnapshot.size,
    draft: draftSnapshot.data(),
  });
  assertFf1SixClientFixtureRunOwnership(
    leagueSnapshot.data() ?? {},
    draftSnapshot.data() ?? {},
    fixtureRunId,
  );
  assert.deepEqual(
    membersSnapshot.docs.map((snapshot) => snapshot.id).sort(),
    expectedOwnerIds,
  );
  assert.deepEqual(
    teamsSnapshot.docs.map((snapshot) => snapshot.id).sort(),
    expectedOwnerIds,
  );
  assert.deepEqual(
    queuesSnapshot.docs.map((snapshot) => snapshot.id).sort(),
    expectedOwnerIds,
  );
  assert.equal(rosterSnapshots.every((snapshot) => snapshot.exists), true);
  assertFf1SixClientSupportingAuthoritySafety({
    leagueExists: true,
    fixtureRunId,
    invite: {
      exists: inviteSnapshot.exists,
      data: inviteSnapshot.data(),
    },
    lifecycleStates: lifecycleSnapshots.map((snapshot, index) => ({
      exists: snapshot.exists,
      data: snapshot.data(),
      uid: ownerIds[index],
    })),
  });

  membersSnapshot.docs.forEach((snapshot) => {
    assert.equal(snapshot.get('uid'), snapshot.id);
    assert.equal(snapshot.get('leagueId'), FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID);
  });
  teamsSnapshot.docs.forEach((snapshot) => {
    const identityIndex = identities.findIndex((identity) => identity.uid === snapshot.id);
    assert.ok(identityIndex >= 0);
    assertFf1SixClientTeamAuthority(
      snapshot.data() ?? {},
      identities[identityIndex],
      identityIndex,
    );
  });
  queuesSnapshot.docs.forEach((snapshot) => {
    assert.equal(snapshot.get('ownerId'), snapshot.id);
  });
  return true;
}

async function createAuthenticatedClients(identities, password, clients) {
  assert.equal(Array.isArray(clients), true);
  assert.equal(clients.length, 0);

  for (const identity of identities) {
    const app = initializeClientApp(
      FIREBASE_OPTIONS,
      `ff1-six-client-${identity.alias}-${Date.now()}-${randomUUID()}`,
    );
    const auth = getAuth(app);
    const client = {
      ...identity,
      app,
      auth,
      firestore: getClientFirestore(app),
      functions: getFunctions(app, 'us-central1'),
    };
    // Retain every initialized client in the caller-owned array before auth.
    // The outer cleanup can then prove teardown even when sign-in itself fails.
    clients.push(client);
    const credential = await signInWithEmailAndPassword(auth, identity.email, password);

    assert.equal(credential.user.uid, identity.uid);
  }

  return clients;
}

function getCallable(client, name, timeout = DEFAULT_ACTION_TIMEOUT_MILLISECONDS) {
  return httpsCallable(client.functions, name, { timeout });
}

async function closeClients(clients) {
  const failures = [];

  for (const client of clients) {
    try {
      await signOut(client.auth);
    } catch {
      failures.push('sign-out');
    }

    try {
      await deleteClientApp(client.app);
    } catch {
      failures.push('app-delete');
    }
  }

  if (failures.length > 0) {
    throw new Error(`Authenticated client teardown failed: ${failures.join(', ')}.`);
  }

  return true;
}

function assertFf1SixClientProjectionMetadata(
  metadata,
  snapshotId,
  readyDraft,
  availabilityAttestation,
  availabilityRevision,
) {
  assert.equal(metadata.snapshotId, snapshotId);
  assert.equal(metadata.activeSnapshotId, snapshotId);
  assert.equal(metadata.status, 'ready');
  assert.equal(metadata.projectionVersion, 11);
  assert.equal(metadata.scoringRulesVersion, 4);
  assert.equal(metadata.generationReason, 'pre-draft');
  assert.equal(metadata.generationRequestId, readyDraft.serverDraftReadinessProjectionRequestId);
  assert.equal(metadata.targetCycleNumber, 1);
  assert.equal(metadata.teamCount, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(metadata.requiredGamesPerCycle, 6);
  assert.equal(
    metadata.availabilityRevision,
    availabilityRevision,
  );
  assert.match(metadata.availabilityRevision ?? '', SHA256_PATTERN);
  assert.equal(
    metadata.availabilityRosterIdentityHash,
    availabilityAttestation.sourceIdentityHash,
  );
  assert.equal(metadata.teamScheduleInputContractVersion, 1);
  assert.equal(metadata.teamScheduleInputCompleteness, 'complete');
  assert.equal(metadata.authoritySchemaVersion, 2);
  assert.equal(metadata.generatedByAuthority, 'server');
  assert.equal(metadata.catalogValidationStatus, 'validated');
  assert.equal(metadata.snapshotIntegrityStatus, 'verified');
  assert.match(metadata.snapshotContentHash ?? '', SHA256_PATTERN);
  assert.match(metadata.catalogHash ?? '', SHA256_PATTERN);
  assert.ok(
    Number.isSafeInteger(metadata.assetDocumentCount) && metadata.assetDocumentCount > 0,
  );
  assert.ok(metadata.assetDocumentCount <= MAX_PROJECTION_SNAPSHOT_CHUNKS);
  return metadata.assetDocumentCount;
}

export function assertFf1SixClientProjectionRequest(
  request,
  {
    requestId,
    snapshotId,
    snapshotContentHash,
    availabilityRevision,
    scheduledStartMilliseconds,
    observedAtMilliseconds,
    metadata,
  },
) {
  assert.ok(request && typeof request === 'object');
  assert.match(requestId, /^projection-draft-[a-f0-9]{32}$/);
  assert.equal(typeof snapshotId, 'string');
  assert.ok(snapshotId.length > 0);
  assert.match(snapshotContentHash, SHA256_PATTERN);
  assert.match(availabilityRevision, SHA256_PATTERN);
  assert.equal(Number.isSafeInteger(scheduledStartMilliseconds), true);
  assert.equal(Number.isSafeInteger(observedAtMilliseconds), true);
  assert.ok(metadata && typeof metadata === 'object');

  const expectedPayloadHash = createHash('sha256')
    .update(JSON.stringify({
      requestedBy: SERVER_DRAFT_ACTOR,
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      generationReason: 'pre-draft',
      targetCycleNumber: 1,
      availabilityRevision,
    }))
    .digest('hex');

  assert.equal(request.schemaVersion, 1);
  assert.equal(request.requestId, requestId);
  assert.equal(request.status, 'ready');
  assert.equal(request.leagueId, FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID);
  assert.equal(request.requestedBy, SERVER_DRAFT_ACTOR);
  assert.equal(request.generationReason, 'pre-draft');
  assert.equal(request.targetCycleNumber, 1);
  assert.equal(request.teamCount, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(request.requiredGamesPerCycle, 6);
  assert.equal(request.availabilityRevision, availabilityRevision);
  assert.equal(request.payloadHash, expectedPayloadHash);
  assert.equal(request.snapshotId, snapshotId);
  assert.equal(request.snapshotContentHash, snapshotContentHash);
  assert.equal(request.snapshotHashSchemaVersion, metadata.snapshotHashSchemaVersion);
  assert.equal(request.snapshotChunkCount, metadata.assetDocumentCount);
  assert.equal(request.canonicalAssetCount, metadata.assetCount);
  assert.equal(request.canonicalAssetCount, metadata.canonicalAssetCount);
  assert.equal(request.catalogSnapshotId, metadata.catalogSnapshotId);
  assert.equal(request.catalogHash, metadata.catalogHash);
  assert.equal(request.catalogCacheHit, metadata.catalogCacheHit);
  assert.equal(request.lastError, '');

  const createdMilliseconds = timestampMilliseconds(request.createdAt);
  const startedMilliseconds = timestampMilliseconds(request.startedAt);
  const completedMilliseconds = timestampMilliseconds(request.completedAt);
  const updatedMilliseconds = timestampMilliseconds(request.updatedAt);
  const expiresMilliseconds = timestampMilliseconds(request.expiresAt);
  for (const timestamp of [
    createdMilliseconds,
    startedMilliseconds,
    completedMilliseconds,
    updatedMilliseconds,
    expiresMilliseconds,
  ]) {
    assert.ok(timestamp !== null, 'A Projection request timestamp is missing.');
  }
  assert.ok(
    createdMilliseconds >= scheduledStartMilliseconds - DRAFT_START_OFFSET_MILLISECONDS - 10_000,
    'The Projection request predates this one-shot rehearsal schedule.',
  );
  assert.ok(createdMilliseconds <= startedMilliseconds);
  assert.ok(startedMilliseconds <= completedMilliseconds);
  assert.ok(completedMilliseconds <= updatedMilliseconds + 5_000);
  assert.ok(updatedMilliseconds <= observedAtMilliseconds + 5_000);
  assert.ok(expiresMilliseconds > completedMilliseconds);
  assert.ok(Number.isFinite(request.durationMilliseconds));
  assert.ok(request.durationMilliseconds >= 0);
  assert.ok(request.durationMilliseconds <= SERVER_AUTOMATION_MAX_EXECUTION_MILLISECONDS);
  assert.ok(
    completedMilliseconds - startedMilliseconds >= request.durationMilliseconds - 1_000 &&
      completedMilliseconds - startedMilliseconds <= request.durationMilliseconds + 60_000,
    'The Projection request duration diverges from its server timestamps.',
  );

  return true;
}

async function verifyAndActivatePreparedFixtureDraft({
  firestore,
  FieldValue,
  leagueRef,
  draftRef,
  readyDraft,
  scheduledStartMilliseconds,
  fixtureRunId,
  expectedAvailabilitySourceHash,
}) {
  assert.match(fixtureRunId, /^[a-f0-9-]{36}$/);
  assert.match(expectedAvailabilitySourceHash, SHA256_PATTERN);
  const snapshotId = readyDraft.serverDraftReadinessProjectionSnapshotId;
  const requestId = readyDraft.serverDraftReadinessProjectionRequestId;
  assert.equal(typeof snapshotId, 'string');
  assert.ok(snapshotId.length > 0);
  assert.equal(typeof requestId, 'string');
  assert.ok(requestId.length > 0);
  const snapshotRef = leagueRef.collection('projectionSnapshots').doc(snapshotId);
  const requestRef = firestore.doc(`projectionGenerationRequests/${requestId}`);
  const availabilityRef = firestore.doc('appData/playerAvailability');
  const overridesQuery = leagueRef.collection('playerAvailability').limit(1);
  const picksQuery = draftRef.collection('picks').limit(1);

  return firestore.runTransaction(async (transaction) => {
    const [
      leagueSnapshot,
      draftSnapshot,
      availabilitySnapshot,
      overridesSnapshot,
      picksSnapshot,
      metadataSnapshot,
      requestSnapshot,
    ] = await Promise.all([
      transaction.get(leagueRef),
      transaction.get(draftRef),
      transaction.get(availabilityRef),
      transaction.get(overridesQuery),
      transaction.get(picksQuery),
      transaction.get(snapshotRef),
      transaction.get(requestRef),
    ]);

    assert.ok(leagueSnapshot.exists && draftSnapshot.exists);
    assertFf1SixClientFixtureRunOwnership(
      leagueSnapshot.data() ?? {},
      draftSnapshot.data() ?? {},
      fixtureRunId,
    );
    assert.equal(overridesSnapshot.empty, true);
    assert.equal(picksSnapshot.empty, true);
    assert.ok(availabilitySnapshot.exists);
    assert.ok(metadataSnapshot.exists);
    assert.ok(requestSnapshot.exists);

    const draft = draftSnapshot.data() ?? {};
    const availability = availabilitySnapshot.data() ?? {};
    const metadata = metadataSnapshot.data() ?? {};
    const request = requestSnapshot.data() ?? {};
    const availabilityAttestation = assertStrictSchema2AvailabilityBaseline(
      availability,
      scheduledStartMilliseconds,
    );
    assert.equal(hashFf132DocumentData(availability), availabilityAttestation.sourceHash);
    const availabilityRevision = buildFf1SixClientAvailabilityRevision(availability);

    assert.equal(
      availabilityAttestation.sourceHash,
      expectedAvailabilitySourceHash,
      'The shared availability source changed before atomic Draft activation.',
    );
    assert.equal(draft.status, 'scheduled');
    assert.equal(draft.clockStatus, 'stopped');
    assert.equal(draft.nextOverallPick, 1);
    assert.deepEqual(draft.draftedAssetKeys ?? [], []);
    assert.equal(timestampMilliseconds(draft.scheduledStartAt), scheduledStartMilliseconds);
    assert.equal(
      timestampMilliseconds(draft.serverDraftReadinessScheduledStartAt),
      scheduledStartMilliseconds,
    );
    assert.equal(draft.serverDraftReadinessStatus, 'ready');
    assert.equal(draft.serverDraftReadinessAvailabilityRevision, availabilityRevision);
    assert.equal(draft.serverDraftReadinessProjectionRequestId, requestId);
    assert.equal(draft.serverDraftReadinessProjectionSnapshotId, snapshotId);
    assert.equal(
      draft.serverDraftReadinessProjectionSnapshotHash,
      readyDraft.serverDraftReadinessProjectionSnapshotHash,
    );

    assertFf1SixClientProjectionRequest(request, {
      requestId,
      snapshotId,
      snapshotContentHash: draft.serverDraftReadinessProjectionSnapshotHash,
      availabilityRevision,
      scheduledStartMilliseconds,
      observedAtMilliseconds: Date.now(),
      metadata,
    });

    const assetDocumentCount = assertFf1SixClientProjectionMetadata(
      metadata,
      snapshotId,
      draft,
      availabilityAttestation,
      availabilityRevision,
    );
    assert.equal(metadata.generationRequestId, requestId);
    assert.equal(
      metadata.snapshotContentHash,
      draft.serverDraftReadinessProjectionSnapshotHash,
    );
    const chunksSnapshot = await transaction.get(
      snapshotRef.collection('assets').limit(assetDocumentCount + 1),
    );

    assert.equal(chunksSnapshot.size, assetDocumentCount);
    const verified = assertFf132ProjectionSnapshotIntegrity(
      metadata,
      chunksSnapshot.docs.map((chunk) => ({
        id: chunk.id,
        data: chunk.data() ?? {},
      })),
    );
    assert.ok(verified.assets.length >= FF1_SIX_CLIENT_TOTAL_PICKS);

    transaction.set(draftRef, {
      status: 'live',
      clockStatus: 'paused',
      pickStartedAt: null,
      currentPickSeconds: DRAFT_PICK_SECONDS,
      pausedRemainingSeconds: DRAFT_PICK_SECONDS,
      clockUpdatedBy: 'guarded-staging-fixture',
      clockUpdatedAt: FieldValue.serverTimestamp(),
      serverDraftProjectionSnapshotId: metadata.activeSnapshotId,
      serverDraftProjectionSnapshotHash: metadata.snapshotContentHash,
      serverDraftProjectionAuthorityVersion: metadata.authoritySchemaVersion,
      serverDraftProjectionCatalogHash: metadata.catalogHash,
      serverProjectionFallbackUsed: false,
      serverAutomationStatus: 'paused',
      serverAutomationMessage:
        'Guarded six-client rehearsal reused the exact server-verified Projection V11 snapshot.',
      serverAutomationUpdatedAt: FieldValue.serverTimestamp(),
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      metadata,
      assets: verified.assets,
      availabilitySourceHash: availabilityAttestation.sourceHash,
    };
  });
}

async function waitForReadiness(draftRef, timeoutMilliseconds) {
  return waitForValue(
    () => draftRef.get(),
    (snapshot) => snapshot.data()?.serverDraftReadinessStatus === 'ready',
    timeoutMilliseconds,
    'The six-client Projection V11 readiness state',
  );
}

function rosterAssetKeys(roster) {
  return [
    ...(Array.isArray(roster?.activeSlots) ? roster.activeSlots : []),
    ...(Array.isArray(roster?.benchSlots) ? roster.benchSlots : []),
    ...(Array.isArray(roster?.irSlots) ? roster.irSlots : []),
  ]
    .map((slot) => slot?.asset?.assetKey)
    .filter((assetKey) => typeof assetKey === 'string' && assetKey.length > 0);
}

const FF1_SIX_CLIENT_EXPECTED_ACTIVE_SLOTS = Object.freeze([
  ['LW-1', 'LW', 1],
  ['LW-2', 'LW', 2],
  ['LW-3', 'LW', 3],
  ['C-1', 'C', 1],
  ['C-2', 'C', 2],
  ['C-3', 'C', 3],
  ['RW-1', 'RW', 1],
  ['RW-2', 'RW', 2],
  ['RW-3', 'RW', 3],
  ['D-1', 'D', 1],
  ['D-2', 'D', 2],
  ['D-3', 'D', 3],
  ['D-4', 'D', 4],
  ['G-1', 'G', 1],
]);

function draftableAssetFromFf1SixClientRosterAsset(asset) {
  const projectionAsset = { ...asset };
  delete projectionAsset.rosterStatus;
  delete projectionAsset.cycleScore;
  return projectionAsset;
}

export function assertFf1SixClientCompletedRoster(roster, expectedAssets) {
  assert.ok(roster && typeof roster === 'object');
  assert.equal(roster.schemaVersion, 2);
  assert.equal(Array.isArray(expectedAssets), true);
  assert.equal(expectedAssets.length, FF1_SIX_CLIENT_TOTAL_ROUNDS);
  const expectedAssetsByKey = new Map(expectedAssets.map((asset) => [
    asset?.assetKey,
    draftableAssetFromFf1SixClientRosterAsset(asset),
  ]));
  const expectedAssetKeys = [...expectedAssetsByKey.keys()];
  assert.equal(new Set(expectedAssetKeys).size, FF1_SIX_CLIENT_TOTAL_ROUNDS);
  assert.equal(
    expectedAssetKeys.every((assetKey) => typeof assetKey === 'string' && assetKey.length > 0),
    true,
    'An authoritative Draft pick carries an invalid asset key.',
  );

  const activeSlots = Array.isArray(roster.activeSlots) ? roster.activeSlots : [];
  const benchSlots = Array.isArray(roster.benchSlots) ? roster.benchSlots : [];
  const irSlots = Array.isArray(roster.irSlots) ? roster.irSlots : [];

  assert.equal(activeSlots.length, FF1_SIX_CLIENT_EXPECTED_ACTIVE_SLOTS.length);
  assert.equal(benchSlots.length, 3);
  assert.equal(irSlots.length, 3);
  assert.deepEqual(
    activeSlots.map((slot) => [slot.slotId, slot.position, slot.slotNumber]),
    FF1_SIX_CLIENT_EXPECTED_ACTIVE_SLOTS,
    'The completed roster does not preserve the exact 14-slot starter shape.',
  );
  assert.deepEqual(
    benchSlots.map((slot) => [slot.slotId, slot.slotNumber]),
    [['B-1', 1], ['B-2', 2], ['B-3', 3]],
    'The completed roster does not preserve the exact three-slot bench shape.',
  );
  assert.deepEqual(
    irSlots.map((slot) => [slot.slotId, slot.slotNumber]),
    [['IR-1', 1], ['IR-2', 2], ['IR-3', 3]],
    'The completed roster does not preserve the configured IR-slot shape.',
  );
  assert.equal(
    irSlots.every((slot) => slot.asset === null),
    true,
    'A Draft must not place an asset directly into IR.',
  );

  for (const slot of activeSlots) {
    assert.ok(slot.asset, `Starter ${slot.slotId} is empty after Draft completion.`);
    assert.deepEqual(
      draftableAssetFromFf1SixClientRosterAsset(slot.asset),
      expectedAssetsByKey.get(slot.asset.assetKey),
      `Starter ${slot.slotId} does not preserve its authoritative Projection V11 asset.`,
    );
    assert.equal(slot.asset.position, slot.position);
    assert.equal(slot.asset.rosterStatus, 'active');
    assert.equal(slot.pendingMove ?? null, null);
    assert.equal(slot.openFromCycleNumber ?? null, null);
    assert.deepEqual(slot.asset.cycleScore, {
      cycleNumber: 1,
      gamesCounted: 0,
      fantasyPoints: 0,
    });
  }
  for (const slot of benchSlots) {
    assert.ok(slot.asset, `Bench slot ${slot.slotId} is empty after Draft completion.`);
    assert.deepEqual(
      draftableAssetFromFf1SixClientRosterAsset(slot.asset),
      expectedAssetsByKey.get(slot.asset.assetKey),
      `Bench slot ${slot.slotId} does not preserve its authoritative Projection V11 asset.`,
    );
    assert.equal(slot.asset.rosterStatus, 'benched');
    assert.deepEqual(slot.asset.cycleScore, {
      cycleNumber: 1,
      gamesCounted: 0,
      fantasyPoints: 0,
    });
  }

  const actualAssetKeys = rosterAssetKeys(roster);
  assert.equal(actualAssetKeys.length, FF1_SIX_CLIENT_TOTAL_ROUNDS);
  assert.equal(new Set(actualAssetKeys).size, FF1_SIX_CLIENT_TOTAL_ROUNDS);
  assert.deepEqual(
    [...actualAssetKeys].sort(),
    [...expectedAssetKeys].sort(),
    'A completed roster does not exactly match its authoritative Draft picks.',
  );
  return actualAssetKeys;
}

export function assertFf1SixClientTeamAuthority(team, identity, index) {
  assert.ok(team && typeof team === 'object');
  assert.ok(identity && typeof identity === 'object');
  assert.ok(Number.isInteger(index) && index >= 0 && index < FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(team.schemaVersion, 1);
  assert.equal(team.id, identity.uid);
  assert.equal(team.ownerId, identity.uid);
  assert.equal(team.teamName, identity.teamName);
  assert.equal(team.managerName, identity.alias);
  assert.equal(team.wins, 0);
  assert.equal(team.losses, 0);
  assert.equal(team.ties, 0);
  assert.equal(team.pointsFor, 0);
  assert.equal(team.pointsAgainst, 0);
  assert.equal(team.waiverPriority, index + 1);
  assert.equal(team.draftPosition, index + 1);
  assert.equal(team.authority, 'league-lifecycle-authority');
  return true;
}

export function assertFf1SixClientWindowProjectionAuthority(
  window,
  authoritativeProjectionAsset,
) {
  assert.ok(window && typeof window === 'object');
  assert.ok(
    authoritativeProjectionAsset && typeof authoritativeProjectionAsset === 'object',
    'A Cycle 1 window is outside the verified Projection V11 asset set.',
  );
  assert.equal(typeof window.ownerId, 'string');
  assert.ok(window.ownerId.length > 0);
  assert.equal(typeof window.rosterSlotId, 'string');
  assert.ok(window.rosterSlotId.length > 0);
  assert.equal(window.cycleNumber, 1);
  assert.equal(
    window.id,
    `${window.ownerId}__${window.rosterSlotId}__cycle-1`,
    'A Cycle 1 window does not preserve its canonical owner/slot/cycle identity.',
  );
  assert.equal(window.assetKey, authoritativeProjectionAsset.assetKey);
  assert.equal(window.asset?.assetKey, authoritativeProjectionAsset.assetKey);
  assert.equal(window.asset?.assetType, authoritativeProjectionAsset.assetType);
  assert.equal(window.position, authoritativeProjectionAsset.position);
  assert.equal(window.asset?.position, authoritativeProjectionAsset.position);

  if (authoritativeProjectionAsset.assetType === 'skater') {
    assert.deepEqual(
      window.asset?.player,
      authoritativeProjectionAsset.player,
      'A Cycle 1 skater window diverges from the verified Draft asset identity.',
    );
  } else {
    assert.equal(
      authoritativeProjectionAsset.assetType,
      'team-goalie-unit',
      'A verified Projection asset has an unsupported competitive type.',
    );
    assert.equal(
      window.asset?.teamAbbreviation,
      authoritativeProjectionAsset.teamAbbreviation,
      'A Cycle 1 goalie window diverges from the verified Draft asset identity.',
    );
    assert.equal(window.asset?.teamName, authoritativeProjectionAsset.teamName);
  }

  assert.equal(
    authoritativeProjectionAsset.currentTeamCycleNumber,
    1,
    'The verified pre-Draft Projection asset is not bound to NHL team block 1.',
  );
  const targetGames = Array.isArray(authoritativeProjectionAsset.currentTeamCycleGames)
    ? authoritativeProjectionAsset.currentTeamCycleGames
    : [];
  assert.equal(
    targetGames.length,
    6,
    'The verified pre-Draft Projection asset does not carry exactly six target games.',
  );
  const expectedGameIds = targetGames.map((game) => game?.gameId);
  const expectedGameDates = targetGames.map((game) => game?.gameDate);
  assert.equal(new Set(expectedGameIds).size, 6);
  assert.equal(
    expectedGameIds.every((gameId) => Number.isSafeInteger(gameId) && gameId > 0),
    true,
    'The verified Projection target contains an invalid NHL game identity.',
  );
  assert.equal(
    expectedGameDates.every((gameDate) => /^\d{4}-\d{2}-\d{2}$/.test(gameDate ?? '')),
    true,
    'The verified Projection target contains an invalid NHL game date.',
  );
  assert.deepEqual(
    window.scheduledGameIds,
    expectedGameIds,
    'A Cycle 1 window does not match the independently verified Projection V11 game IDs.',
  );
  assert.deepEqual(
    window.scheduledGameDates,
    expectedGameDates,
    'A Cycle 1 window does not match the independently verified Projection V11 game dates.',
  );
  assert.equal(window.frozenProjectionSource, 'shared-snapshot');
  assert.equal(window.frozenProjectionVersion, 11);
  assert.equal(
    window.frozenProjectionSnapshotId,
    authoritativeProjectionAsset.sharedProjectionSnapshotId,
    'A Cycle 1 window does not preserve the verified Projection snapshot identity.',
  );

  return true;
}

function countRosterAssets(roster) {
  return rosterAssetKeys(roster).length;
}

function nextNeededPosition(roster) {
  const activeSlots = Array.isArray(roster?.activeSlots) ? roster.activeSlots : [];
  const openStarter = activeSlots.find((slot) => !slot?.asset?.assetKey);

  return openStarter?.position ?? null;
}

function chooseCandidate(assets, draftedAssetKeys, roster, excludedAssetKeys = []) {
  const drafted = new Set(draftedAssetKeys);
  const excluded = new Set(excludedAssetKeys);
  const neededPosition = nextNeededPosition(roster);
  const candidates = assets
    .filter((asset) =>
      typeof asset?.assetKey === 'string' &&
      !drafted.has(asset.assetKey) &&
      !excluded.has(asset.assetKey) &&
      (neededPosition ? asset.position === neededPosition : asset.position !== 'G'))
    .sort((left, right) => (left.draftRank ?? Number.MAX_SAFE_INTEGER) -
      (right.draftRank ?? Number.MAX_SAFE_INTEGER));

  assert.ok(candidates.length > 0, `No legal ${neededPosition ?? 'bench'} candidate remained.`);
  return candidates[0];
}

function expectedDraftAssetName(asset) {
  return asset.assetType === 'skater'
    ? asset.player?.fullName ?? ''
    : `${asset.teamName ?? ''} Goalie Unit`;
}

function expectedDraftValue(asset) {
  for (const value of [
    asset.draftScore,
    asset.draftValueAboveReplacement,
    asset.balancedDraftValue,
    asset.floorAdjustedDraftValue,
  ]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function expectedProjectedCycle(asset) {
  for (const value of [
    asset.draftProjectedCyclePoints,
    asset.availabilityAdjustedCyclePoints,
    asset.floorAdjustedCyclePoints,
    asset.projectedCyclePoints,
  ]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function compareExpectedDraftValue(first, second) {
  const firstValue = expectedDraftValue(first);
  const secondValue = expectedDraftValue(second);

  if (firstValue !== null && secondValue !== null && firstValue !== secondValue) {
    return secondValue - firstValue;
  }
  if (firstValue !== null && secondValue === null) {
    return -1;
  }
  if (firstValue === null && secondValue !== null) {
    return 1;
  }

  const firstProjection = expectedProjectedCycle(first) ?? -1;
  const secondProjection = expectedProjectedCycle(second) ?? -1;

  if (firstProjection !== secondProjection) {
    return secondProjection - firstProjection;
  }

  return expectedDraftAssetName(first).localeCompare(expectedDraftAssetName(second));
}

export function selectExpectedEmptyQueueStarterCandidate({ assets, draft, roster }) {
  const openStarterPositions = new Set(
    (Array.isArray(roster?.activeSlots) ? roster.activeSlots : [])
      .filter((slot) => !slot?.asset?.assetKey)
      .map((slot) => slot?.position)
      .filter((position) => typeof position === 'string' && position.length > 0),
  );
  assert.ok(openStarterPositions.size > 0, 'The empty-queue proof requires an open starter.');
  const draftedAssetKeys = new Set(
    Array.isArray(draft?.draftedAssetKeys) ? draft.draftedAssetKeys : [],
  );
  const candidates = assets
    .filter((asset) =>
      typeof asset?.assetKey === 'string' &&
      !draftedAssetKeys.has(asset.assetKey) &&
      openStarterPositions.has(asset.position))
    .sort(compareExpectedDraftValue);

  assert.ok(candidates.length > 0, 'No legal empty-queue starter candidate remained.');
  return candidates[0];
}

async function getDraftState(draftRef) {
  const snapshot = await draftRef.get();
  assert.ok(snapshot.exists);
  return snapshot.data() ?? {};
}

function currentDraftOwnerId(draft) {
  const roundOneOrder = Array.isArray(draft.roundOneOrder) ? draft.roundOneOrder : [];
  const overallPick = draft.nextOverallPick;

  return expectedDraftOwnerId(roundOneOrder, overallPick);
}

function expectedDraftOwnerId(roundOneOrder, overallPick) {
  assert.equal(roundOneOrder.length, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.ok(Number.isSafeInteger(overallPick) && overallPick > 0);
  const round = Math.floor((overallPick - 1) / roundOneOrder.length) + 1;
  const pickInRound = (overallPick - 1) % roundOneOrder.length;
  const roundOrder = round % 2 === 1 ? roundOneOrder : [...roundOneOrder].reverse();
  return roundOrder[pickInRound];
}

function managerIndexForOwner(identities, ownerId) {
  const index = identities.findIndex((identity) => identity.uid === ownerId);

  assert.ok(index >= 0, 'The current Draft owner is outside the six-client fixture.');
  return index;
}

async function getRoster(firestore, ownerId) {
  const snapshot = await firestore.doc(
    `leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}/teams/${ownerId}/roster/current`,
  ).get();
  assert.ok(snapshot.exists);
  return snapshot.data() ?? {};
}

async function submitManualPick(client, draft, asset, submissionId = null) {
  const makePick = getCallable(client, 'makeSecureDraftPick');
  return makePick({
    leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
    assetKey: asset.assetKey,
    submissionId: submissionId ?? `ff1_pick_${draft.nextOverallPick}_${randomUUID()}`,
    expectedOverallPick: draft.nextOverallPick,
  });
}

async function saveQueue(client, assetKeys, autoDraftEnabled) {
  await setDoc(
    doc(
      client.firestore,
      'leagues',
      FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      'draft',
      'current',
      'queues',
      client.uid,
    ),
    {
      ownerId: client.uid,
      assetKeys,
      autoDraftEnabled,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

async function assertCrossManagerQueueWriteRejected(actor, targetOwnerId, adminFirestore) {
  const adminQueueRef = adminFirestore.doc(
    `leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}/draft/current/queues/${targetOwnerId}`,
  );
  const beforeSnapshot = await adminQueueRef.get();
  assert.ok(beforeSnapshot.exists);
  const beforeHash = hashFf132DocumentData(beforeSnapshot.data() ?? {});
  const result = await Promise.allSettled([setDoc(
    doc(
      actor.firestore,
      'leagues',
      FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      'draft',
      'current',
      'queues',
      targetOwnerId,
    ),
    {
      ownerId: targetOwnerId,
      assetKeys: ['unauthorized-cross-manager-probe'],
      autoDraftEnabled: true,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )]);

  assert.equal(result[0].status, 'rejected');
  assert.match(result[0].reason?.code ?? '', /permission-denied$/);
  const afterSnapshot = await adminQueueRef.get();
  assert.ok(afterSnapshot.exists);
  assert.equal(
    hashFf132DocumentData(afterSnapshot.data() ?? {}),
    beforeHash,
    'A cross-manager queue write changed the protected queue document.',
  );
  return true;
}

async function waitForPickCount(draftRef, expectedCount, timeoutMilliseconds) {
  return waitForValue(
    async () => ({
      draft: await getDraftState(draftRef),
      picks: await draftRef.collection('picks').get(),
    }),
    ({ picks }) => picks.size >= expectedCount,
    timeoutMilliseconds,
    `Draft pick ${expectedCount}`,
  );
}

function pickData(snapshot, overallPick) {
  return snapshot.docs.find((entry) => entry.id === String(overallPick).padStart(3, '0'))?.data();
}

function ff1SixClientDocumentBoundary(snapshot) {
  return {
    path: snapshot.ref.path,
    exists: snapshot.exists,
    hash: snapshot.exists ? hashFf132DocumentData(snapshot.data() ?? {}) : null,
  };
}

function ff1SixClientQueryBoundary(snapshot) {
  return snapshot.docs
    .map(ff1SixClientDocumentBoundary)
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function assertFf1SixClientRetainedV1FixturePresent(leagueExists) {
  assert.equal(
    leagueExists,
    true,
    'The retained FF1.29 audit fixture is missing; its immutable boundary cannot be proven.',
  );
  return true;
}

async function readAndAssertFf1SixClientRetainedV1Boundary(firestore) {
  const leagueRef = firestore.doc(
    `leagues/${FF1_SIX_CLIENT_RETAINED_V1_LEAGUE_ID}`,
  );
  const draftRef = leagueRef.collection('draft').doc('current');
  const retainedManagerIds = Array.from(
    { length: FF1_SIX_CLIENT_MANAGER_COUNT },
    (_, index) => `ff1-six-client-manager-${index + 1}`,
  );
  const documentRefs = [
    leagueRef,
    draftRef,
    leagueRef.collection('cycles').doc('cycle-1'),
    leagueRef.collection('historicalReplay').doc('control'),
    leagueRef.collection('liveScoring').doc('control'),
    firestore.doc(
      `leagueAutomationSchedules/${FF1_SIX_CLIENT_RETAINED_V1_LEAGUE_ID}`,
    ),
    ...retainedManagerIds.flatMap((ownerId) => [
      leagueRef.collection('teams').doc(ownerId).collection('roster').doc('current'),
      firestore.doc(`users/${ownerId}`),
      firestore.doc(`publicProfiles/${ownerId}`),
    ]),
  ];
  const [
    snapshots,
    picksSnapshot,
    queuesSnapshot,
    membersSnapshot,
    teamsSnapshot,
    cyclesSnapshot,
    replayControlsSnapshot,
    liveScoringControlsSnapshot,
    activitySnapshot,
    auditSnapshot,
    projectionSnapshots,
    taskSnapshot,
    projectionRequestSnapshot,
  ] = await Promise.all([
    firestore.getAll(...documentRefs),
    draftRef
      .collection('picks')
      .limit(FF1_SIX_CLIENT_TOTAL_PICKS + 1)
      .get(),
    draftRef.collection('queues').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    leagueRef.collection('members').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    leagueRef.collection('teams').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    leagueRef.collection('cycles').limit(2).get(),
    leagueRef.collection('historicalReplay').limit(2).get(),
    leagueRef.collection('liveScoring').limit(2).get(),
    leagueRef.collection('activity').limit(201).get(),
    leagueRef.collection('audit').limit(201).get(),
    leagueRef.collection('projectionSnapshots').limit(11).get(),
    firestore
      .collection('leagueAutomationTasks')
      .where('leagueId', '==', FF1_SIX_CLIENT_RETAINED_V1_LEAGUE_ID)
      .limit(1)
      .get(),
    firestore
      .collection('projectionGenerationRequests')
      .where('leagueId', '==', FF1_SIX_CLIENT_RETAINED_V1_LEAGUE_ID)
      .limit(11)
      .get(),
  ]);
  const [league, draft, cycle, replay, control, schedule] = snapshots;
  const rosterAndProfileSnapshots = snapshots.slice(6);
  const projectionAssetSnapshots = await Promise.all(
    projectionSnapshots.docs.map((snapshot) =>
      snapshot.ref.collection('assets').limit(MAX_PROJECTION_SNAPSHOT_CHUNKS + 1).get()),
  );

  assertFf1SixClientRetainedV1FixturePresent(league.exists);
  assert.equal(league.get('id'), FF1_SIX_CLIENT_RETAINED_V1_LEAGUE_ID);
  assert.equal(league.get('fixtureType'), FF1_SIX_CLIENT_RETAINED_V1_FIXTURE_TYPE);
  assert.equal(league.get('name'), 'FF1 Six-Client Draft Rehearsal');
  assert.equal(league.get('maxTeams'), FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(league.get('teamCount'), FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(draft.exists, true);
  assert.equal(draft.get('status'), 'complete');
  assert.equal(draft.get('nextOverallPick'), FF1_SIX_CLIENT_TOTAL_PICKS + 1);
  assert.equal(picksSnapshot.size, FF1_SIX_CLIENT_TOTAL_PICKS);
  assert.equal(membersSnapshot.size, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(teamsSnapshot.size, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(queuesSnapshot.size, FF1_SIX_CLIENT_MANAGER_COUNT);
  for (const snapshot of [membersSnapshot, teamsSnapshot, queuesSnapshot]) {
    assert.deepEqual(
      snapshot.docs.map((entry) => entry.id).sort(),
      [...retainedManagerIds].sort(),
      'The retained FF1.29 manager-owned document boundary changed.',
    );
  }
  assert.deepEqual(
    picksSnapshot.docs.map((snapshot) => snapshot.id).sort(),
    Array.from(
      { length: FF1_SIX_CLIENT_TOTAL_PICKS },
      (_, index) => String(index + 1).padStart(3, '0'),
    ),
    'The retained FF1.29 audit Draft pick boundary changed.',
  );
  assert.equal(cycle.exists, false);
  assert.equal(replay.exists, false);
  assert.equal(control.exists, false);
  assert.equal(schedule.exists, false);
  assert.equal(cyclesSnapshot.empty, true);
  assert.equal(replayControlsSnapshot.empty, true);
  assert.equal(liveScoringControlsSnapshot.empty, true);
  assert.equal(taskSnapshot.empty, true);
  assert.ok(activitySnapshot.size <= 200);
  assert.ok(auditSnapshot.size <= 200);
  assert.ok(projectionSnapshots.size <= 10);
  assert.ok(projectionRequestSnapshot.size <= 10);
  assert.equal(
    rosterAndProfileSnapshots.every((snapshot) => snapshot.exists),
    true,
    'The retained FF1.29 roster or profile boundary is incomplete.',
  );
  assert.equal(
    projectionAssetSnapshots.every(
      (snapshot) => snapshot.size <= MAX_PROJECTION_SNAPSHOT_CHUNKS,
    ),
    true,
  );

  return {
    documents: snapshots.map(ff1SixClientDocumentBoundary),
    picks: ff1SixClientQueryBoundary(picksSnapshot),
    queues: ff1SixClientQueryBoundary(queuesSnapshot),
    members: ff1SixClientQueryBoundary(membersSnapshot),
    teams: ff1SixClientQueryBoundary(teamsSnapshot),
    cycles: ff1SixClientQueryBoundary(cyclesSnapshot),
    replayControls: ff1SixClientQueryBoundary(replayControlsSnapshot),
    liveScoringControls: ff1SixClientQueryBoundary(liveScoringControlsSnapshot),
    activity: ff1SixClientQueryBoundary(activitySnapshot),
    audit: ff1SixClientQueryBoundary(auditSnapshot),
    projectionSnapshots: ff1SixClientQueryBoundary(projectionSnapshots),
    projectionAssets: projectionAssetSnapshots
      .flatMap(ff1SixClientQueryBoundary)
      .sort((left, right) => left.path.localeCompare(right.path)),
    projectionRequests: ff1SixClientQueryBoundary(projectionRequestSnapshot),
    taskCount: taskSnapshot.size,
  };
}

async function readFf1SixClientMemberRemovalBoundaryState(
  firestore,
  leagueRef,
  targetOwnerId,
) {
  const documentRefs = [
    leagueRef,
    leagueRef.collection('members').doc(targetOwnerId),
    leagueRef.collection('teams').doc(targetOwnerId),
    leagueRef.collection('teams').doc(targetOwnerId).collection('roster').doc('current'),
    leagueRef.collection('draft').doc('current').collection('queues').doc(targetOwnerId),
    firestore.doc(`leagueLifecycleState/${targetOwnerId}`),
    firestore.doc(`leagueInvites/${FF1_SIX_CLIENT_FIXTURE_INVITE_CODE}`),
  ];
  const [snapshots, picksSnapshot] = await Promise.all([
    firestore.getAll(...documentRefs),
    leagueRef
      .collection('draft')
      .doc('current')
      .collection('picks')
      .limit(FF1_SIX_CLIENT_TOTAL_PICKS + 1)
      .get(),
  ]);

  return {
    documents: snapshots.map((snapshot) => ({
      path: snapshot.ref.path,
      exists: snapshot.exists,
      hash: snapshot.exists ? hashFf132DocumentData(snapshot.data() ?? {}) : null,
    })),
    pickCount: picksSnapshot.size,
  };
}

async function waitForAndParkFf1SixClientLifecycle({
  firestore,
  FieldValue,
  Timestamp,
  leagueRef,
  draftRef,
  identities,
  fixtureRunId,
  authoritativeAssetsByKey,
  lifecycleReasonStates,
}) {
  assert.ok(authoritativeAssetsByKey instanceof Map);
  assert.equal(Array.isArray(lifecycleReasonStates), true);
  const cycleRef = leagueRef.collection('cycles').doc('cycle-1');
  const controlRef = leagueRef.collection('liveScoring').doc('control');
  const scheduleRef = firestore.doc(
    `leagueAutomationSchedules/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`,
  );
  const replayControlRef = leagueRef.collection('historicalReplay').doc('control');
  const settled = await waitForValue(
    async () => {
      const [draft, cycle, control, schedule] = await firestore.getAll(
        draftRef,
        cycleRef,
        controlRef,
        scheduleRef,
      );
      return { draft, cycle, control, schedule };
    },
    ({ draft, cycle, control, schedule }) =>
      draft.get('cycleOneStartStatus') === 'started' &&
      cycle.exists &&
      control.get('status') !== 'refreshing' &&
      control.get('lastRefreshReason') === 'draft-complete' &&
      control.get('cycleOneCreatedInLastRun') === true &&
      ['success', 'error'].includes(schedule.get('lastOutcome')),
    DEFAULT_LIFECYCLE_TIMEOUT_MILLISECONDS,
    'The post-Draft Cycle 1 lifecycle',
  );
  const control = settled.control.data() ?? {};
  const schedule = settled.schedule.data() ?? {};
  const expectedOwnerIds = identities.map((identity) => identity.uid).sort();

  await waitForValue(
    () => Promise.resolve(lifecycleReasonStates),
    (reasons) => reasons.includes('draft-complete'),
    30_000,
    'The direct post-Draft lifecycle control marker',
  );

  assert.equal(schedule.lastOutcome, 'success', 'Post-Draft league automation failed.');
  assert.equal(schedule.leagueId, FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID);
  assert.equal(schedule.scoringEnabled, true);
  assert.equal(schedule.queueStatus, 'idle');
  assert.equal(schedule.activeTaskId ?? null, null);
  assert.equal(control.status, 'idle');
  assert.equal(control.holderClientId, '');
  assert.ok((timestampMilliseconds(control.leaseExpiresAt) ?? Infinity) <= Date.now());
  assert.equal(control.lastError, '');
  assert.equal(control.lastRefreshReason, 'draft-complete');
  assert.equal(control.serverTrigger, 'draft-complete');
  assert.equal(
    control.cycleOneCreatedInLastRun,
    true,
    'The direct draft-complete lifecycle run did not create Cycle 1.',
  );
  assert.deepEqual(control.activeCycleNumbers, [1]);

  const [
    verifiedCycleSnapshot,
    teamWindowsSnapshot,
    matchupSnapshot,
    rosterSnapshots,
    protectedDraftSnapshot,
    protectedPicksSnapshot,
    protectedTeamsSnapshot,
    protectedPlayoffsSnapshot,
  ] = await Promise.all([
    cycleRef.get(),
    cycleRef.collection('teamWindows').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    cycleRef.collection('matchups').limit(FF1_SIX_CLIENT_MANAGER_COUNT / 2 + 1).get(),
    firestore.getAll(...identities.map((identity) =>
      leagueRef.collection('teams').doc(identity.uid).collection('roster').doc('current'))),
    draftRef.get(),
    draftRef.collection('picks').limit(FF1_SIX_CLIENT_TOTAL_PICKS + 1).get(),
    leagueRef.collection('teams').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    leagueRef.collection('playoffs').doc('current').get(),
  ]);
  assert.ok(verifiedCycleSnapshot.exists);
  const cycle = verifiedCycleSnapshot.data() ?? {};
  const expectedSlotsByOwner = cycle.expectedRosterSlotIdsByOwner ?? {};

  assert.equal(cycle.id, 'cycle-1');
  assert.equal(cycle.cycleNumber, 1);
  assert.equal(cycle.status, 'active');
  assert.equal(cycle.phase, 'regular_season');
  assert.equal(cycle.matchupIds?.length, FF1_SIX_CLIENT_MANAGER_COUNT / 2);
  assert.deepEqual(Object.keys(expectedSlotsByOwner).sort(), expectedOwnerIds);
  for (const ownerId of expectedOwnerIds) {
    assert.equal(expectedSlotsByOwner[ownerId]?.length, 14);
  }
  assert.equal(cycle.totalExpectedWindowCount, 84);
  assert.equal(cycle.activeWindowCount, 84);
  assert.equal(cycle.completedWindowCount, 0);
  assert.equal(protectedDraftSnapshot.get('status'), 'complete');
  assert.equal(protectedPicksSnapshot.size, FF1_SIX_CLIENT_TOTAL_PICKS);
  assert.equal(protectedTeamsSnapshot.size, FF1_SIX_CLIENT_MANAGER_COUNT);
  protectedTeamsSnapshot.docs.forEach((snapshot) => {
    const identityIndex = identities.findIndex((identity) => identity.uid === snapshot.id);
    assert.ok(identityIndex >= 0);
    assertFf1SixClientTeamAuthority(
      snapshot.data() ?? {},
      identities[identityIndex],
      identityIndex,
    );
  });
  assert.equal(protectedPlayoffsSnapshot.exists, false);
  assert.equal(teamWindowsSnapshot.size, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(matchupSnapshot.size, FF1_SIX_CLIENT_MANAGER_COUNT / 2);
  assert.deepEqual(
    teamWindowsSnapshot.docs.map((snapshot) => snapshot.id).sort(),
    expectedOwnerIds,
  );
  assert.deepEqual(
    matchupSnapshot.docs.map((snapshot) => snapshot.id).sort(),
    ['matchup-1', 'matchup-2', 'matchup-3'],
  );

  const globallyOwnedAssetKeys = new Set();
  const globallyOwnedWindowIds = new Set();
  for (const [index, identity] of identities.entries()) {
    const roster = rosterSnapshots[index].data() ?? {};
    const activeSlots = Array.isArray(roster.activeSlots) ? roster.activeSlots : [];
    const activeSlotAssets = new Map(activeSlots.map((slot) => [
      slot?.slotId,
      slot?.asset?.assetKey,
    ]));
    const ownerWindowsSnapshot = teamWindowsSnapshot.docs.find(
      (snapshot) => snapshot.id === identity.uid,
    );
    assert.ok(ownerWindowsSnapshot);
    const teamWindows = ownerWindowsSnapshot.data() ?? {};
    const expectedRosterSlotIds = [...(teamWindows.expectedRosterSlotIds ?? [])].sort();
    const windows = Array.isArray(teamWindows.windows) ? teamWindows.windows : [];

    assert.equal(teamWindows.ownerId, identity.uid);
    assert.equal(teamWindows.cycleNumber, 1);
    assert.equal(teamWindows.totalWindowCount, 14);
    assert.equal(teamWindows.completedWindowCount, 0);
    assert.ok(['scheduled', 'active'].includes(teamWindows.status));
    assert.equal(activeSlots.length, 14);
    assert.equal(activeSlotAssets.size, 14);
    assert.deepEqual(expectedRosterSlotIds, [...activeSlotAssets.keys()].sort());
    assert.deepEqual(
      expectedRosterSlotIds,
      [...(expectedSlotsByOwner[identity.uid] ?? [])].sort(),
    );
    assert.equal(windows.length, 14);
    assert.equal(new Set(windows.map((window) => window.id)).size, 14);
    assert.equal(new Set(windows.map((window) => window.rosterSlotId)).size, 14);

    for (const window of windows) {
      assert.equal(window.ownerId, identity.uid);
      assert.equal(window.cycleNumber, 1);
      assert.equal(
        window.id,
        `${identity.uid}__${window.rosterSlotId}__cycle-1`,
        'A Cycle 1 window does not preserve its canonical owner/slot/cycle identity.',
      );
      assert.equal(window.assetKey, activeSlotAssets.get(window.rosterSlotId));
      assert.equal(window.asset?.assetKey, window.assetKey);
      assert.equal(
        window.position,
        window.asset?.position,
        'A Cycle 1 window position diverges from its authoritative asset position.',
      );
      assertFf1SixClientWindowProjectionAuthority(
        window,
        authoritativeAssetsByKey.get(window.assetKey),
      );
      assert.equal(window.status, 'scheduled');
      assert.equal(window.scheduledGames, 6);
      assert.equal(window.scheduledGameIds?.length, 6);
      assert.equal(new Set(window.scheduledGameIds).size, 6);
      assert.equal(
        window.scheduledGameIds.every(
          (gameId) => Number.isSafeInteger(gameId) && gameId > 0,
        ),
        true,
      );
      assert.equal(window.frozenProjectionVersion, 11);
      assert.equal(window.frozenProjectionTargetGameIds?.length, 6);
      assert.equal(new Set(window.frozenProjectionTargetGameIds).size, 6);
      assert.deepEqual(
        window.frozenProjectionTargetGameIds,
        window.scheduledGameIds,
        'A six-game window does not preserve its exact frozen Projection V11 targets.',
      );
      assert.deepEqual(window.completedGameIds ?? [], []);
      assert.deepEqual(window.liveGameIds ?? [], []);
      assert.deepEqual(window.appearanceGameIds ?? [], []);
      assert.deepEqual(window.gameScores ?? {}, {});
      assert.deepEqual(window.gameInputCompleteness ?? {}, {});
      assert.deepEqual(window.incompleteFinalGameIds ?? [], []);
      assert.equal(window.gamesPlayed, 0);
      assert.equal(window.actualGamesPlayed, 0);
      assert.equal(window.gamesLeft, 6);
      assert.equal(window.fantasyPoints, 0);
      assert.equal(window.startedAt ?? null, null);
      assert.equal(window.completedAt ?? null, null);
      assert.equal(globallyOwnedAssetKeys.has(window.assetKey), false);
      assert.equal(globallyOwnedWindowIds.has(window.id), false);
      globallyOwnedAssetKeys.add(window.assetKey);
      globallyOwnedWindowIds.add(window.id);
    }
  }
  assert.equal(globallyOwnedAssetKeys.size, 84);
  assert.equal(globallyOwnedWindowIds.size, 84);

  const matchupOwnerIds = [];
  for (const snapshot of matchupSnapshot.docs) {
    const matchup = snapshot.data() ?? {};
    assert.equal(matchup.cycleNumber, 1);
    assert.equal(matchup.phase, 'regular_season');
    assert.equal(matchup.status, 'active');
    assert.equal(matchup.teamAScore, 0);
    assert.equal(matchup.teamBScore, 0);
    assert.equal(matchup.winnerOwnerId ?? null, null);
    matchupOwnerIds.push(matchup.teamAOwnerId, matchup.teamBOwnerId);
  }
  assert.deepEqual(matchupOwnerIds.sort(), expectedOwnerIds);

  const competitiveLifecycleBoundary = {
    cycle: ff1SixClientDocumentBoundary(verifiedCycleSnapshot),
    draft: ff1SixClientDocumentBoundary(protectedDraftSnapshot),
    playoffs: ff1SixClientDocumentBoundary(protectedPlayoffsSnapshot),
    teamWindows: ff1SixClientQueryBoundary(teamWindowsSnapshot),
    matchups: ff1SixClientQueryBoundary(matchupSnapshot),
    picks: ff1SixClientQueryBoundary(protectedPicksSnapshot),
    teams: ff1SixClientQueryBoundary(protectedTeamsSnapshot),
    rosters: rosterSnapshots.map(ff1SixClientDocumentBoundary),
  };

  await parkFf1SixClientRecurringAutomationUntilQuiescent({
    firestore,
    FieldValue,
    Timestamp,
    fixtureRunId,
    requireSuccessfulCycleOne: true,
  });

  const [
    finalCycleSnapshot,
    finalTeamWindowsSnapshot,
    finalMatchupSnapshot,
    finalRosterSnapshots,
    finalDraftSnapshot,
    finalPicksSnapshot,
    finalTeamsSnapshot,
    finalPlayoffsSnapshot,
  ] = await Promise.all([
    cycleRef.get(),
    cycleRef.collection('teamWindows').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    cycleRef.collection('matchups').limit(FF1_SIX_CLIENT_MANAGER_COUNT / 2 + 1).get(),
    firestore.getAll(...identities.map((identity) =>
      leagueRef.collection('teams').doc(identity.uid).collection('roster').doc('current'))),
    draftRef.get(),
    draftRef.collection('picks').limit(FF1_SIX_CLIENT_TOTAL_PICKS + 1).get(),
    leagueRef.collection('teams').limit(FF1_SIX_CLIENT_MANAGER_COUNT + 1).get(),
    leagueRef.collection('playoffs').doc('current').get(),
  ]);
  assert.deepEqual(
    {
      cycle: ff1SixClientDocumentBoundary(finalCycleSnapshot),
      draft: ff1SixClientDocumentBoundary(finalDraftSnapshot),
      playoffs: ff1SixClientDocumentBoundary(finalPlayoffsSnapshot),
      teamWindows: ff1SixClientQueryBoundary(finalTeamWindowsSnapshot),
      matchups: ff1SixClientQueryBoundary(finalMatchupSnapshot),
      picks: ff1SixClientQueryBoundary(finalPicksSnapshot),
      teams: ff1SixClientQueryBoundary(finalTeamsSnapshot),
      rosters: finalRosterSnapshots.map(ff1SixClientDocumentBoundary),
    },
    competitiveLifecycleBoundary,
    'Draft, roster, six-game window, matchup, standings, or playoff state changed while the retained fixture was quiescing.',
  );

  return {
    cycleOneActiveWindowCount: cycle.activeWindowCount,
    cycleOneMatchupCount: cycle.matchupIds.length,
    directDraftCompletionLifecycleObserved:
      control.lastRefreshReason === 'draft-complete' &&
      control.cycleOneCreatedInLastRun === true,
    recurringScoringParked: true,
  };
}

async function waitForFf1SixClientActivityPublication(leagueRef) {
  return waitForValue(
    async () => {
      const snapshot = await leagueRef.collection('activity').limit(107).get();
      const sourceKinds = snapshot.docs.map((entry) => entry.get('sourceKind'));
      return {
        total: snapshot.size,
        audit: sourceKinds.filter((kind) => kind === 'audit').length,
        draftControl: sourceKinds.filter((kind) => kind === 'draft-control').length,
        draftPick: sourceKinds.filter((kind) => kind === 'draft-pick').length,
      };
    },
    (activity) =>
      activity.total === 106 &&
      activity.audit === 1 &&
      activity.draftControl === 3 &&
      activity.draftPick === FF1_SIX_CLIENT_TOTAL_PICKS,
    120_000,
    'The exact idempotent Draft activity publications',
  );
}

export function buildPublicFf1SixClientEvidence(evidence) {
  assert.match(evidence.deployedReleaseRevision ?? '', GIT_REVISION_PATTERN);
  assert.match(evidence.toolingRevision ?? '', GIT_REVISION_PATTERN);
  assert.equal(evidence.authenticatedClientCount, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(evidence.independentListenerCount, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(evidence.projectionVersion, 11);
  assert.equal(evidence.scoringRulesVersion, 4);
  for (const field of [
    'strictServerAvailabilityReused',
    'serverSnapshotVerified',
    'projectionHashChainVerified',
    'firestoreRulesVerified',
    'offClockSubmissionRejected',
    'crossManagerQueueWriteRejected',
    'duplicateSubmissionStable',
    'staleSubmissionRejected',
    'unavailableQueueEntrySkipped',
    'pausePreservedPickCount',
    'resumedDeadlineExactOnce',
    'reconnectConverged',
    'snakeBoundaryVerified',
    'pickHandoffTriggerVerified',
    'draftCompletionTriggerVerified',
    'directDraftCompletionLifecycleObserved',
    'sharedLeagueAutomationQueueRemainedEmpty',
    'retainedPriorDraftBoundaryPreserved',
    'cycleOneStarted',
    'recurringScoringParked',
    'postDraftRemovalRejected',
    'exactOnceOutcome',
    'fixtureAccountsDisabled',
    'sharedMaintenanceLockReleased',
  ]) {
    assert.equal(evidence[field], true, `Public evidence field ${field} did not pass.`);
  }
  assert.equal(evidence.queueTimeoutPickCount, 2);
  assert.equal(evidence.emptyQueueAutoPickCount, 1);
  assert.equal(evidence.completedPickCount, FF1_SIX_CLIENT_TOTAL_PICKS);
  assert.equal(evidence.uniqueAssetCount, FF1_SIX_CLIENT_TOTAL_PICKS);
  assert.equal(evidence.completedRosterCount, FF1_SIX_CLIENT_MANAGER_COUNT);
  assert.equal(evidence.cycleOneActiveWindowCount, 84);
  assert.equal(evidence.cycleOneMatchupCount, 3);
  assert.equal(evidence.leagueActivityPublicationCount, 106);
  assert.equal(evidence.leagueAutomationQueueMode, 'shadow');
  assert.equal(evidence.postDraftRemovalBlockReason, 'membership-locked');
  assert.match(evidence.firestoreRulesSourceHash ?? '', SHA256_PATTERN);

  return {
    projectId: D1N_STAGING_PROJECT_ID,
    leagueLabel: 'draft-a',
    deployedReleaseRevision: evidence.deployedReleaseRevision,
    toolingRevision: evidence.toolingRevision,
    authenticatedClientCount: evidence.authenticatedClientCount,
    independentListenerCount: evidence.independentListenerCount,
    projectionVersion: evidence.projectionVersion,
    scoringRulesVersion: evidence.scoringRulesVersion,
    firestoreRulesVerified: evidence.firestoreRulesVerified === true,
    strictServerAvailabilityReused: evidence.strictServerAvailabilityReused === true,
    serverSnapshotVerified: evidence.serverSnapshotVerified === true,
    projectionHashChainVerified: evidence.projectionHashChainVerified === true,
    offClockSubmissionRejected: evidence.offClockSubmissionRejected === true,
    duplicateSubmissionStable: evidence.duplicateSubmissionStable === true,
    staleSubmissionRejected: evidence.staleSubmissionRejected === true,
    crossManagerQueueWriteRejected: evidence.crossManagerQueueWriteRejected === true,
    queueTimeoutPickCount: evidence.queueTimeoutPickCount,
    unavailableQueueEntrySkipped: evidence.unavailableQueueEntrySkipped === true,
    emptyQueueAutoPickCount: evidence.emptyQueueAutoPickCount,
    pausePreservedPickCount: evidence.pausePreservedPickCount === true,
    resumedDeadlineExactOnce: evidence.resumedDeadlineExactOnce === true,
    reconnectConverged: evidence.reconnectConverged === true,
    snakeBoundaryVerified: evidence.snakeBoundaryVerified === true,
    pickHandoffTriggerVerified: evidence.pickHandoffTriggerVerified === true,
    draftCompletionTriggerVerified: evidence.draftCompletionTriggerVerified === true,
    directDraftCompletionLifecycleObserved:
      evidence.directDraftCompletionLifecycleObserved === true,
    sharedLeagueAutomationQueueRemainedEmpty:
      evidence.sharedLeagueAutomationQueueRemainedEmpty === true,
    retainedPriorDraftBoundaryPreserved:
      evidence.retainedPriorDraftBoundaryPreserved === true,
    completedPickCount: evidence.completedPickCount,
    uniqueAssetCount: evidence.uniqueAssetCount,
    completedRosterCount: evidence.completedRosterCount,
    cycleOneStarted: evidence.cycleOneStarted === true,
    cycleOneActiveWindowCount: evidence.cycleOneActiveWindowCount,
    cycleOneMatchupCount: evidence.cycleOneMatchupCount,
    recurringScoringParked: evidence.recurringScoringParked === true,
    leagueActivityPublicationCount: evidence.leagueActivityPublicationCount,
    leagueAutomationQueueMode: evidence.leagueAutomationQueueMode,
    postDraftRemovalRejected: evidence.postDraftRemovalRejected === true,
    postDraftRemovalBlockReason: evidence.postDraftRemovalBlockReason,
    exactOnceOutcome: evidence.exactOnceOutcome === true,
    fixtureAccountsDisabled: evidence.fixtureAccountsDisabled === true,
    sharedMaintenanceLockReleased: evidence.sharedMaintenanceLockReleased === true,
    fixtureRetainedForAudit: true,
  };
}

export async function runFf1SixClientDraftRehearsal(environment = process.env) {
  const { deployedReleaseRevision, readinessTimeoutMilliseconds } =
    assertFf1SixClientStagingSafety(environment);
  const { toolingRevision } = assertFf1SixClientToolingDelta(deployedReleaseRevision);
  await verifyFf1ReadinessStagingManifest(deployedReleaseRevision);
  const requiredFunctions = inspectFf1SixClientRuntimeTopology();
  const draftStartTaskProducer = requiredFunctions.find(
    (entry) => entry.name === 'runScheduledDraftAutomation',
  );
  const draftPickHandoffTrigger = requiredFunctions.find(
    (entry) => entry.name === 'reconcileDraftTurnAfterCommittedPick',
  );
  const draftCompletionLifecycleTrigger = requiredFunctions.find(
    (entry) => entry.name === 'initializeSeasonAfterDraft',
  );
  assert.ok(
    draftStartTaskProducer,
    'The verified scheduled-Draft producer Function is missing.',
  );
  assert.ok(
    draftPickHandoffTrigger && draftCompletionLifecycleTrigger,
    'The verified Draft lifecycle trigger Functions are missing.',
  );
  const draftClockTaskServiceAccountEmail =
    draftStartTaskProducer.serviceAccountEmail;
  assert.equal(
    draftClockTaskServiceAccountEmail,
    FF1_SIX_CLIENT_EXPECTED_STAGING_SERVICE_ACCOUNT,
    'The verified scheduled-Draft producer service identity changed.',
  );
  inspectFf132CloudRunDeployments(requiredFunctions);
  await verifyFf132DeployedFunctionSourceArchives(
    requiredFunctions,
    deployedReleaseRevision,
  );
  const firestoreRulesEvidence = await verifyFf1SixClientFirestoreRules(
    deployedReleaseRevision,
  );
  assert.equal(listFf132QueueTasks(FF132_AVAILABILITY_TASK_QUEUE).length, 0);
  assert.equal(listFf132QueueTasks(FF132_PROJECTION_TASK_QUEUE).length, 0);
  assert.equal(listFf132QueueTasks(FF132_DRAFT_CLOCK_TASK_QUEUE).length, 0);
  assertEmptyFf1SixClientSharedGuardedTaskQueues();

  const {
    applicationDefault,
    deleteApp: deleteAdminApp,
    initializeApp: initializeAdminApp,
  } = requireFunctions('firebase-admin/app');
  const { getAuth: getAdminAuth } = requireFunctions('firebase-admin/auth');
  const { FieldValue, getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore');
  const adminApp = initializeAdminApp({
    credential: applicationDefault(),
    projectId: D1N_STAGING_PROJECT_ID,
  }, `ff1-six-client-admin-${Date.now()}`);
  const lockRunId = randomUUID();
  const identities = Array.from({ length: FF1_SIX_CLIENT_MANAGER_COUNT }, (_, index) =>
    managerIdentity(index, lockRunId));
  const password = createPassword();
  let clients = [];
  let duplicateTab = null;
  let unsubscribers = [];
  let completed = false;
  let firestore = null;
  let lockRef = null;
  let lockOwned = false;
  let fixtureOwned = false;
  let fixtureSeedMayExist = false;
  let fixtureNamespaceInspectionInProgress = false;
  const createdFixtureIdentities = [];
  let safeFailureParked = false;
  let queuesClean = true;
  let scheduledStartMilliseconds = null;
  let leagueAutomationQueueConfigEvidence = null;
  let retainedV1BoundaryEvidence = null;
  let retainedV1BoundaryStable = false;
  let rehearsalWriteBoundaryCrossed = false;
  let historicalReplayRequestsQuiet = false;
  let sharedGuardedTaskQueuesQuiet = true;

  try {
    assert.equal(adminApp.options.projectId, D1N_STAGING_PROJECT_ID);
    const adminAuth = getAdminAuth(adminApp);
    firestore = getFirestore(adminApp);
    const leagueRef = firestore.doc(`leagues/${FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID}`);
    const draftRef = firestore.doc(`${leagueRef.path}/draft/current`);
    lockRef = firestore.doc(FF132_EVIDENCE_LOCK_PATH);
    const lockAcquisition = await acquireFf132EvidenceLock(
      firestore,
      lockRef,
      Timestamp,
      lockRunId,
      readinessTimeoutMilliseconds + SHARED_LOCK_TIMEOUT_RESERVE_MILLISECONDS,
    );
    lockOwned = lockAcquisition.lockOwned;

    if (lockAcquisition.acquisitionError) {
      throw lockAcquisition.acquisitionError;
    }

    assert.equal(lockOwned, true, 'The shared staging evidence lock was not acquired.');
    retainedV1BoundaryEvidence =
      await readAndAssertFf1SixClientRetainedV1Boundary(firestore);
    await readAndAssertFf1SixClientHistoricalReplayRequestsQuiet(firestore);
    historicalReplayRequestsQuiet = true;
    leagueAutomationQueueConfigEvidence =
      await readFf1SixClientLeagueAutomationQueueConfig(firestore);
    await assertBoundedDraftInventory(firestore);
    await readStrictSharedAvailability(
      firestore,
      Date.now() + DRAFT_START_OFFSET_MILLISECONDS + 60_000,
    );

    fixtureNamespaceInspectionInProgress = true;
    await assertEmptyFf1SixClientFixtureNamespace(firestore);
    fixtureNamespaceInspectionInProgress = false;
    rehearsalWriteBoundaryCrossed = true;
    await createFixtureUsers(
      adminAuth,
      identities,
      password,
      createdFixtureIdentities,
    );
    fixtureSeedMayExist = true;
    await seedFixtureDocuments(firestore, identities, lockRunId);
    await verifySeededFixtureDocuments(firestore, identities, lockRunId);
    fixtureOwned = true;
    const manualAvailabilitySnapshot = await leagueRef
      .collection('playerAvailability')
      .limit(1)
      .get();
    assert.equal(
      manualAvailabilitySnapshot.empty,
      true,
      'Fixture overrides would change the prepared availability revision.',
    );
    await createAuthenticatedClients(identities, password, clients);
    await assertCrossManagerQueueWriteRejected(
      clients[1],
      identities[0].uid,
      firestore,
    );

    const listenerStates = clients.map(() => ({ updates: 0, status: null, error: null }));
    const lifecycleReasonStates = [];
    unsubscribers = clients.map((client, index) => onSnapshot(
      doc(client.firestore, 'leagues', FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID, 'draft', 'current'),
      (snapshot) => {
        listenerStates[index].updates += 1;
        listenerStates[index].status = snapshot.data()?.status ?? null;
      },
      (error) => {
        listenerStates[index].error = error;
      },
    ));
    await waitForValue(
      () => Promise.resolve(listenerStates),
      (states) => states.every((state) => state.updates > 0 && !state.error),
      20_000,
      'The six authenticated Draft listeners',
    );
    unsubscribers.push(
      leagueRef.collection('liveScoring').doc('control').onSnapshot(
        (snapshot) => {
          const reason = snapshot.get('lastRefreshReason');
          if (
            ['draft-complete', 'season-start'].includes(reason) &&
            lifecycleReasonStates.at(-1) !== reason
          ) {
            lifecycleReasonStates.push(reason);
          }
        },
        () => lifecycleReasonStates.push('listener-error'),
      ),
    );

    const scheduleDraft = getCallable(clients[0], 'executeDraftCommand');
    const scheduledStartAt = new Date(Date.now() + DRAFT_START_OFFSET_MILLISECONDS);
    scheduledStartMilliseconds = scheduledStartAt.getTime();
    // A timed-out save can still commit and enqueue after its client promise
    // rejects. From this point, cleanup must prove all three task queues quiet.
    queuesClean = false;
    await scheduleDraft({
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      action: 'save-settings',
      submissionId: `ff1_settings_${randomUUID()}`,
      roundOneOrder: identities.map((identity) => identity.uid),
      scheduledStartAt: scheduledStartAt.toISOString(),
      pickSeconds: DRAFT_PICK_SECONDS,
    });

    const readySnapshot = await waitForReadiness(draftRef, readinessTimeoutMilliseconds);
    const readyDraft = readySnapshot.data() ?? {};
    const readyAvailabilityAttestation = await readStrictSharedAvailability(
      firestore,
      scheduledStartMilliseconds,
    );
    const { metadata, assets } = await verifyAndActivatePreparedFixtureDraft({
      firestore,
      FieldValue,
      leagueRef,
      draftRef,
      readyDraft,
      scheduledStartMilliseconds,
      fixtureRunId: lockRunId,
      expectedAvailabilitySourceHash: readyAvailabilityAttestation.sourceHash,
    });
    const pickTriggerEvidenceStartedMilliseconds = Date.now() - 5_000;

    const resumeDraft = getCallable(clients[0], 'executeDraftCommand');
    await resumeDraft({
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      action: 'resume-clock',
    });
    await wait(1_500);
    await resumeDraft({
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      action: 'pause-clock',
    });
    const pausedPickCount = (await draftRef.collection('picks').get()).size;
    await wait((DRAFT_PICK_SECONDS + 2) * 1_000);
    const afterOldDeadlinePickCount = (await draftRef.collection('picks').get()).size;
    assert.equal(pausedPickCount, 0);
    assert.equal(afterOldDeadlinePickCount, pausedPickCount);

    let draft = await getDraftState(draftRef);
    let ownerId = currentDraftOwnerId(draft);
    let ownerIndex = managerIndexForOwner(identities, ownerId);
    let roster = await getRoster(firestore, ownerId);
    const resumedDeadlineRosterCount = countRosterAssets(roster);
    const resumedDeadlineAsset = chooseCandidate(assets, draft.draftedAssetKeys, roster);
    await saveQueue(clients[ownerIndex], [resumedDeadlineAsset.assetKey], false);
    await resumeDraft({
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      action: 'resume-clock',
    });
    const resumedDraft = await getDraftState(draftRef);
    const resumedPickStartedAtMilliseconds = timestampMilliseconds(
      resumedDraft.pickStartedAt,
    );
    assert.ok(resumedPickStartedAtMilliseconds !== null);
    assert.ok(
      Number.isFinite(resumedDraft.currentPickSeconds) &&
        resumedDraft.currentPickSeconds > 0,
    );
    const resumedExpectedDeadlineMilliseconds =
      resumedPickStartedAtMilliseconds + resumedDraft.currentPickSeconds * 1_000;
    assert.ok(
      resumedExpectedDeadlineMilliseconds >= Date.now() + 20_000,
      'The resumed clock did not establish a new authoritative deadline.',
    );

    const resumedDeadlineState = await waitForPickCount(
      draftRef,
      1,
      (DRAFT_PICK_SECONDS + 60) * 1_000,
    );
    const resumedDeadlinePick = pickData(resumedDeadlineState.picks, 1);
    assert.equal(resumedDeadlinePick?.autoPickReason, 'timer-expired');
    assert.equal(resumedDeadlinePick?.selectionType, 'queue');
    assert.equal(resumedDeadlinePick?.asset?.assetKey, resumedDeadlineAsset.assetKey);
    assert.ok(
      (timestampMilliseconds(resumedDeadlinePick?.madeAt) ?? 0) >=
        resumedExpectedDeadlineMilliseconds - 1_000,
      'The queued timeout pick arrived before the newly resumed deadline.',
    );
    assert.equal(resumedDeadlineState.draft.nextOverallPick, 2);
    assert.equal(
      countRosterAssets(await getRoster(firestore, ownerId)),
      resumedDeadlineRosterCount + 1,
      'The resumed deadline must add exactly one roster asset.',
    );
    await wait(3_000);
    assert.equal(
      (await draftRef.collection('picks').get()).size,
      1,
      'The resumed deadline produced more than one authoritative pick.',
    );
    await saveQueue(clients[ownerIndex], [], false);

    draft = await getDraftState(draftRef);
    ownerId = currentDraftOwnerId(draft);
    ownerIndex = managerIndexForOwner(identities, ownerId);
    roster = await getRoster(firestore, ownerId);
    const duplicateAsset = chooseCandidate(assets, draft.draftedAssetKeys, roster);
    const offClockIndex = (ownerIndex + 1) % FF1_SIX_CLIENT_MANAGER_COUNT;
    const offClockBefore = {
      nextOverallPick: draft.nextOverallPick,
      draftedAssetKeys: [...(draft.draftedAssetKeys ?? [])],
      lastPickId: draft.lastPickId ?? null,
      pickCount: (await draftRef.collection('picks').get()).size,
    };
    const offClockResult = await Promise.allSettled([
      submitManualPick(clients[offClockIndex], draft, duplicateAsset),
    ]);
    assert.equal(offClockResult[0].status, 'rejected');
    assert.match(
      offClockResult[0].reason?.code ?? '',
      /permission-denied$/,
    );
    const [offClockAfterDraft, offClockAfterPicks] = await Promise.all([
      getDraftState(draftRef),
      draftRef.collection('picks').get(),
    ]);
    assert.deepEqual(
      {
        nextOverallPick: offClockAfterDraft.nextOverallPick,
        draftedAssetKeys: offClockAfterDraft.draftedAssetKeys ?? [],
        lastPickId: offClockAfterDraft.lastPickId ?? null,
        pickCount: offClockAfterPicks.size,
      },
      offClockBefore,
      'An off-clock manager submission changed competitive Draft state.',
    );
    const duplicateSubmissionId = `ff1_duplicate_${randomUUID()}`;
    const duplicateResults = await Promise.all([
      submitManualPick(clients[ownerIndex], draft, duplicateAsset, duplicateSubmissionId),
      submitManualPick(clients[ownerIndex], draft, duplicateAsset, duplicateSubmissionId),
    ]);
    assert.equal(duplicateResults.length, 2);
    assert.equal(duplicateResults[0].data?.pick?.submissionId, duplicateSubmissionId);
    assert.equal(duplicateResults[1].data?.pick?.submissionId, duplicateSubmissionId);
    assert.equal(
      duplicateResults[0].data?.pick?.asset?.assetKey,
      duplicateAsset.assetKey,
    );
    assert.equal(
      duplicateResults[1].data?.pick?.asset?.assetKey,
      duplicateAsset.assetKey,
    );
    assert.equal((await draftRef.collection('picks').get()).size, 2);

    draft = await getDraftState(draftRef);
    ownerId = currentDraftOwnerId(draft);
    ownerIndex = managerIndexForOwner(identities, ownerId);
    roster = await getRoster(firestore, ownerId);
    const staleAsset = chooseCandidate(assets, draft.draftedAssetKeys, roster);
    const competingAsset = chooseCandidate(
      assets,
      draft.draftedAssetKeys,
      roster,
      [staleAsset.assetKey],
    );
    const duplicateTabApp = initializeClientApp(
      FIREBASE_OPTIONS,
      `ff1-six-client-duplicate-tab-${Date.now()}-${randomUUID()}`,
    );
    duplicateTab = {
      app: duplicateTabApp,
      auth: getAuth(duplicateTabApp),
      firestore: getClientFirestore(duplicateTabApp),
      functions: getFunctions(duplicateTabApp, 'us-central1'),
    };
    await signInWithEmailAndPassword(
      duplicateTab.auth,
      identities[ownerIndex].email,
      password,
    );
    await disableNetwork(clients[5].firestore);
    const staleResults = await Promise.allSettled([
      submitManualPick(clients[ownerIndex], draft, staleAsset),
      submitManualPick(duplicateTab, draft, competingAsset),
    ]);
    assert.equal(staleResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(staleResults.filter((result) => result.status === 'rejected').length, 1);
    const staleRejection = staleResults.find((result) => result.status === 'rejected');
    assert.match(staleRejection?.reason?.code ?? '', /\/(already-exists|aborted)$/);
    const staleFulfillment = staleResults.find((result) => result.status === 'fulfilled');
    assert.ok(
      [staleAsset.assetKey, competingAsset.assetKey]
        .includes(staleFulfillment?.value?.data?.pick?.asset?.assetKey),
      'The duplicate-tab winner must be one of the two exact competing assets.',
    );
    await enableNetwork(clients[5].firestore);
    const reconnectSnapshot = await getDocFromServer(doc(
      clients[5].firestore,
      'leagues',
      FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      'draft',
      'current',
    ));
    assert.ok((reconnectSnapshot.data()?.nextOverallPick ?? 0) >= 4);
    assert.equal((await draftRef.collection('picks').get()).size, 3);

    draft = await getDraftState(draftRef);
    ownerId = currentDraftOwnerId(draft);
    ownerIndex = managerIndexForOwner(identities, ownerId);
    roster = await getRoster(firestore, ownerId);
    const queuedAsset = chooseCandidate(assets, draft.draftedAssetKeys, roster);
    await saveQueue(
      clients[ownerIndex],
      [resumedDeadlineAsset.assetKey, queuedAsset.assetKey],
      false,
    );
    const storedQueue = await getDocFromServer(doc(
      clients[ownerIndex].firestore,
      'leagues',
      FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      'draft',
      'current',
      'queues',
      ownerId,
    ));
    assert.deepEqual(
      storedQueue.data()?.assetKeys,
      [resumedDeadlineAsset.assetKey, queuedAsset.assetKey],
    );
    const timeoutPickState = await waitForPickCount(
      draftRef,
      4,
      (DRAFT_PICK_SECONDS + 60) * 1_000,
    );
    const timeoutPick = pickData(timeoutPickState.picks, 4);
    assert.equal(timeoutPick?.autoPickReason, 'timer-expired');
    assert.equal(timeoutPick?.selectionType, 'queue');
    assert.equal(timeoutPick?.asset?.assetKey, queuedAsset.assetKey);
    const postTimeoutQueue = await getDocFromServer(doc(
      clients[ownerIndex].firestore,
      'leagues',
      FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      'draft',
      'current',
      'queues',
      ownerId,
    ));
    assert.deepEqual(
      postTimeoutQueue.data()?.assetKeys,
      [resumedDeadlineAsset.assetKey],
      'The server must remove only the selected legal queue entry.',
    );

    draft = await getDraftState(draftRef);
    ownerId = currentDraftOwnerId(draft);
    ownerIndex = managerIndexForOwner(identities, ownerId);
    const expectedEmptyQueueAsset = selectExpectedEmptyQueueStarterCandidate({
      assets,
      draft,
      roster: await getRoster(firestore, ownerId),
    });
    await saveQueue(clients[ownerIndex], [], true);
    const autoPickState = await waitForPickCount(draftRef, 5, 60_000);
    const autoPick = pickData(autoPickState.picks, 5);
    assert.equal(autoPick?.autoPickReason, 'manager-auto-mode');
    assert.equal(autoPick?.selectionType, 'automatic');
    assert.equal(
      autoPick?.asset?.assetKey,
      expectedEmptyQueueAsset.assetKey,
      'Empty-queue Auto-Draft did not select the deterministic best legal Projection V11 asset.',
    );
    await saveQueue(clients[ownerIndex], [], false);

    while (true) {
      draft = await getDraftState(draftRef);

      if (draft.status === 'complete') {
        break;
      }

      assert.equal(draft.clockStatus, 'running');
      const overallPick = draft.nextOverallPick;
      const teamCount = draft.roundOneOrder.length;
      const round = Math.floor((overallPick - 1) / teamCount) + 1;
      const pickInRound = ((overallPick - 1) % teamCount) + 1;
      const roundOrder = round % 2 === 1
        ? draft.roundOneOrder
        : [...draft.roundOneOrder].reverse();
      const ownerId = roundOrder[pickInRound - 1];
      const ownerIndex = managerIndexForOwner(identities, ownerId);

      roster = await getRoster(firestore, ownerId);
      const asset = chooseCandidate(assets, draft.draftedAssetKeys, roster);
      await submitManualPick(clients[ownerIndex], draft, asset);
    }

    const [
      finalDraftSnapshot,
      finalPicksSnapshot,
      unfilteredFinalPicksSnapshot,
      finalTeamsSnapshot,
    ] = await Promise.all([
      draftRef.get(),
      draftRef.collection('picks').orderBy('overallPick', 'asc').get(),
      draftRef.collection('picks').limit(FF1_SIX_CLIENT_TOTAL_PICKS + 1).get(),
      leagueRef.collection('teams').get(),
    ]);
    const finalDraft = finalDraftSnapshot.data() ?? {};
    const pickIds = finalPicksSnapshot.docs.map((entry) => entry.id);
    const picks = finalPicksSnapshot.docs.map((entry) => entry.data());
    const uniqueAssets = new Set(picks.map((pick) => pick.asset?.assetKey));
    const firstRound = picks.slice(0, FF1_SIX_CLIENT_MANAGER_COUNT).map((pick) => pick.ownerId);
    const secondRound = picks
      .slice(FF1_SIX_CLIENT_MANAGER_COUNT, FF1_SIX_CLIENT_MANAGER_COUNT * 2)
      .map((pick) => pick.ownerId);

    assert.equal(finalDraft.status, 'complete');
    assert.equal(finalDraft.clockStatus, 'complete');
    assert.equal(finalDraft.nextOverallPick, FF1_SIX_CLIENT_TOTAL_PICKS + 1);
    assert.equal(picks.length, FF1_SIX_CLIENT_TOTAL_PICKS);
    assert.equal(unfilteredFinalPicksSnapshot.size, FF1_SIX_CLIENT_TOTAL_PICKS);
    assert.deepEqual(
      unfilteredFinalPicksSnapshot.docs.map((snapshot) => snapshot.id).sort(),
      Array.from(
        { length: FF1_SIX_CLIENT_TOTAL_PICKS },
        (_, index) => String(index + 1).padStart(3, '0'),
      ),
      'The final Draft contains a missing, malformed, or unexpected pick document.',
    );
    assert.equal(uniqueAssets.size, FF1_SIX_CLIENT_TOTAL_PICKS);
    assert.equal(finalDraft.serverDraftProjectionSnapshotId, metadata.activeSnapshotId);
    assert.equal(finalDraft.serverDraftProjectionSnapshotHash, metadata.snapshotContentHash);
    assert.equal(
      finalDraft.serverDraftProjectionAuthorityVersion,
      metadata.authoritySchemaVersion,
    );
    assert.equal(finalDraft.serverDraftProjectionCatalogHash, metadata.catalogHash);
    assert.equal(finalDraft.serverProjectionFallbackUsed, false);
    assert.deepEqual(
      [...(finalDraft.draftedAssetKeys ?? [])].sort(),
      [...uniqueAssets].sort(),
      'The final Draft asset ledger does not exactly match its pick documents.',
    );
    assert.equal(finalDraft.lastPickId, String(FF1_SIX_CLIENT_TOTAL_PICKS).padStart(3, '0'));
    const authoritativeAssetsByKey = new Map(
      assets.map((asset) => [asset.assetKey, asset]),
    );
    assert.equal(
      authoritativeAssetsByKey.size,
      assets.length,
      'The verified Projection V11 snapshot contains duplicate asset keys.',
    );
    picks.forEach((pick, index) => {
      const overallPick = index + 1;
      assert.equal(pick.overallPick, overallPick);
      assert.equal(
        pick.ownerId,
        expectedDraftOwnerId(finalDraft.roundOneOrder, overallPick),
        `Draft pick ${overallPick} does not follow the authoritative snake order.`,
      );
      assert.equal(typeof pick.asset?.assetKey, 'string');
      assert.ok(pick.asset.assetKey.length > 0);
      assert.ok(
        authoritativeAssetsByKey.has(pick.asset.assetKey),
        `Draft pick ${overallPick} is outside the verified Projection V11 pool.`,
      );
      assert.deepEqual(
        pick.asset,
        authoritativeAssetsByKey.get(pick.asset.assetKey),
        `Draft pick ${overallPick} does not preserve its authoritative Projection V11 asset.`,
      );
      assert.equal(pick.projectionSnapshotId, metadata.activeSnapshotId);
      assert.equal(pick.projectionSnapshotHash, metadata.snapshotContentHash);
      assert.equal(pick.projectionAuthorityVersion, metadata.authoritySchemaVersion);
    });
    assert.deepEqual(firstRound, identities.map((identity) => identity.uid));
    assert.deepEqual(secondRound, identities.map((identity) => identity.uid).reverse());
    assert.equal(finalTeamsSnapshot.size, FF1_SIX_CLIENT_MANAGER_COUNT);

    let completedRosterCount = 0;
    const rosterAssetKeySet = new Set();
    for (const identity of identities) {
      const completedRoster = await getRoster(firestore, identity.uid);
      const expectedRosterAssets = picks
        .filter((pick) => pick.ownerId === identity.uid)
        .map((pick) => pick.asset);
      const actualRosterAssetKeys = assertFf1SixClientCompletedRoster(
        completedRoster,
        expectedRosterAssets,
      );
      actualRosterAssetKeys.forEach((assetKey) => rosterAssetKeySet.add(assetKey));
      completedRosterCount += 1;
    }
    assert.equal(rosterAssetKeySet.size, FF1_SIX_CLIENT_TOTAL_PICKS);
    assert.deepEqual(
      [...rosterAssetKeySet].sort(),
      [...uniqueAssets].sort(),
      'The six completed rosters do not exactly equal the global authoritative pick set.',
    );

    const lifecycleEvidence = await waitForAndParkFf1SixClientLifecycle({
      firestore,
      FieldValue,
      Timestamp,
      leagueRef,
      draftRef,
      identities,
      fixtureRunId: lockRunId,
      authoritativeAssetsByKey,
      lifecycleReasonStates,
    });
    const triggerEvidenceMaximumMilliseconds = Date.now() + 120_000;
    const pickHandoffEvidence =
      await waitForFf1SixClientPickHandoffEvidence({
        deployedFunction: draftPickHandoffTrigger,
        minimumTimestamp: pickTriggerEvidenceStartedMilliseconds,
        maximumTimestamp: triggerEvidenceMaximumMilliseconds,
        expectedPickIds: pickIds,
      });
    assert.equal(pickHandoffEvidence.markerCount, FF1_SIX_CLIENT_TOTAL_PICKS);
    const lifecycleTriggerRequestCount =
      await waitForFf1SixClientTriggerRequestLogs({
        deployedFunction: draftCompletionLifecycleTrigger,
        minimumTimestamp: pickTriggerEvidenceStartedMilliseconds,
        maximumTimestamp: triggerEvidenceMaximumMilliseconds,
        minimumSuccessfulRequests: 1,
      });
    assert.ok(lifecycleTriggerRequestCount >= 1);
    const activityEvidence = await waitForFf1SixClientActivityPublication(leagueRef);

    await signInWithEmailAndPassword(
      clients[0].auth,
      identities[0].email,
      password,
    );
    const removeMember = getCallable(clients[0], 'removeLeagueMemberSecure');
    const preRemovalBoundary = await readFf1SixClientMemberRemovalBoundaryState(
      firestore,
      leagueRef,
      identities[1].uid,
    );
    const removalResult = await Promise.allSettled([removeMember({
      requestId: `ff1_removal_${randomUUID()}`,
      leagueId: FF1_SIX_CLIENT_FIXTURE_LEAGUE_ID,
      targetOwnerId: identities[1].uid,
      confirmationTeamName: identities[1].teamName,
    })]);
    assert.equal(removalResult[0].status, 'rejected');
    assert.match(removalResult[0].reason?.code ?? '', /\/failed-precondition$/);
    assert.equal(
      removalResult[0].reason?.details?.reason,
      'membership-locked',
      'The removal must reach the canonical post-settings membership boundary.',
    );
    assert.deepEqual(
      await readFf1SixClientMemberRemovalBoundaryState(
        firestore,
        leagueRef,
        identities[1].uid,
      ),
      preRemovalBoundary,
      'Rejected post-Draft removal changed membership, team, roster, queue, quota, invite, or picks.',
    );

    await waitForValue(
      () => Promise.resolve(listenerStates),
      (states) => states.every((state) => state.status === 'complete' && !state.error),
      30_000,
      'All six authenticated Draft listeners at completion',
    );
    const finalRequiredFunctions = inspectFf1SixClientRuntimeTopology();
    assert.deepEqual(
      finalRequiredFunctions,
      requiredFunctions,
      'A required staging Function deployment changed during the guarded rehearsal.',
    );
    inspectFf132CloudRunDeployments(finalRequiredFunctions);
    await verifyFf132DeployedFunctionSourceArchives(
      finalRequiredFunctions,
      deployedReleaseRevision,
    );
    assert.deepEqual(
      await verifyFf1SixClientFirestoreRules(deployedReleaseRevision),
      firestoreRulesEvidence,
      'The active staging Firestore Rules changed during the guarded rehearsal.',
    );
    assert.deepEqual(
      await readFf1SixClientLeagueAutomationQueueConfig(firestore),
      leagueAutomationQueueConfigEvidence,
      'The protected staging league-automation queue configuration changed during the rehearsal.',
    );
    await verifyFf1ReadinessStagingManifest(deployedReleaseRevision);
    await cleanFf1SixClientTaskQueuesUntilQuiescent(
      scheduledStartMilliseconds,
      draftClockTaskServiceAccountEmail,
    );
    assertEmptyFf1SixClientSharedGuardedTaskQueues();
    sharedGuardedTaskQueuesQuiet = true;
    await readAndAssertFf1SixClientHistoricalReplayRequestsQuiet(firestore);
    historicalReplayRequestsQuiet = true;
    assertFf1SixClientRetainedV1BoundaryStable(
      await readAndAssertFf1SixClientRetainedV1Boundary(firestore),
      retainedV1BoundaryEvidence,
    );
    retainedV1BoundaryStable = true;
    queuesClean = true;

    const queueTimeoutPickCount = picks.filter(
      (pick) => pick.autoPickReason === 'timer-expired',
    ).length;
    const emptyQueueAutoPickCount = picks.filter(
      (pick) => pick.autoPickReason === 'manager-auto-mode',
    ).length;
    assert.equal(queueTimeoutPickCount, 2);
    assert.equal(emptyQueueAutoPickCount, 1);
    completed = true;
    return buildPublicFf1SixClientEvidence({
      deployedReleaseRevision,
      toolingRevision,
      authenticatedClientCount: clients.length,
      independentListenerCount: listenerStates.length,
      projectionVersion: metadata.projectionVersion,
      scoringRulesVersion: metadata.scoringRulesVersion,
      firestoreRulesVerified: true,
      firestoreRulesSourceHash: firestoreRulesEvidence.sourceHash,
      strictServerAvailabilityReused: true,
      serverSnapshotVerified: metadata.snapshotIntegrityStatus === 'verified',
      projectionHashChainVerified: true,
      offClockSubmissionRejected: true,
      duplicateSubmissionStable: true,
      staleSubmissionRejected: true,
      crossManagerQueueWriteRejected: true,
      queueTimeoutPickCount,
      unavailableQueueEntrySkipped: timeoutPick?.asset?.assetKey === queuedAsset.assetKey,
      emptyQueueAutoPickCount,
      pausePreservedPickCount: afterOldDeadlinePickCount === pausedPickCount,
      resumedDeadlineExactOnce: resumedDeadlinePick?.asset?.assetKey ===
        resumedDeadlineAsset.assetKey,
      reconnectConverged: true,
      snakeBoundaryVerified: true,
      pickHandoffTriggerVerified:
        pickHandoffEvidence.markerCount === FF1_SIX_CLIENT_TOTAL_PICKS,
      draftCompletionTriggerVerified: lifecycleTriggerRequestCount >= 1,
      directDraftCompletionLifecycleObserved:
        lifecycleEvidence.directDraftCompletionLifecycleObserved,
      sharedLeagueAutomationQueueRemainedEmpty: true,
      retainedPriorDraftBoundaryPreserved: true,
      completedPickCount: picks.length,
      uniqueAssetCount: uniqueAssets.size,
      completedRosterCount,
      cycleOneStarted: true,
      cycleOneActiveWindowCount: lifecycleEvidence.cycleOneActiveWindowCount,
      cycleOneMatchupCount: lifecycleEvidence.cycleOneMatchupCount,
      recurringScoringParked: lifecycleEvidence.recurringScoringParked,
      leagueActivityPublicationCount: activityEvidence.total,
      leagueAutomationQueueMode: leagueAutomationQueueConfigEvidence.mode,
      postDraftRemovalRejected: true,
      postDraftRemovalBlockReason: 'membership-locked',
      exactOnceOutcome: true,
      fixtureAccountsDisabled: true,
      sharedMaintenanceLockReleased: true,
    });
  } finally {
    const cleanupFailures = [];

    let listenerCleanupFailed = false;
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe();
      } catch {
        listenerCleanupFailed = true;
      }
    }
    if (listenerCleanupFailed) {
      cleanupFailures.push('listener-cleanup');
    }
    let clientSessionsSafe = false;
    try {
      await closeClients([
        ...clients,
        ...(duplicateTab ? [duplicateTab] : []),
      ]);
      clientSessionsSafe = true;
    } catch {
      cleanupFailures.push('authenticated-client-cleanup');
    }
    let fixtureAccountsSafe = createdFixtureIdentities.length === 0;
    if (createdFixtureIdentities.length > 0) {
      try {
        await disableFixtureUsers(
          getAdminAuth(adminApp),
          createdFixtureIdentities,
          completed,
        );
        fixtureAccountsSafe = true;
      } catch {
        cleanupFailures.push('synthetic-account-disable');
      }
    }

    let failureParkCandidate = false;
    if (!completed && firestore && lockOwned && (fixtureOwned || fixtureSeedMayExist)) {
      // First stop the currently visible state. Do not treat this as final:
      // an ambiguously timed-out callable or Firestore trigger can still commit
      // after this transaction.
      try {
        await parkRetainedFixtureAfterFailure(
          firestore,
          FieldValue,
          Timestamp,
          lockRunId,
        );
      } catch {
        // The mandatory post-quiescence reconciliation below gets the final say.
      }

      await wait(DRAFT_TRIGGER_QUIESCENCE_MILLISECONDS);
      try {
        await parkRetainedFixtureAfterFailure(
          firestore,
          FieldValue,
          Timestamp,
          lockRunId,
        );
        failureParkCandidate = true;
      } catch {
        cleanupFailures.push('fixture-post-callable-safety-park');
      }
    } else if (
      !completed &&
      !fixtureOwned &&
      !fixtureSeedMayExist &&
      !fixtureNamespaceInspectionInProgress
    ) {
      safeFailureParked = true;
    }

    if (!queuesClean && firestore && lockOwned && (completed || failureParkCandidate)) {
      try {
        await cleanFf1SixClientTaskQueuesUntilQuiescent(
          scheduledStartMilliseconds,
          draftClockTaskServiceAccountEmail,
        );
        queuesClean = true;
      } catch {
        cleanupFailures.push('task-queue-cleanup');
      }
    }

    if (!completed && failureParkCandidate && queuesClean) {
      // Queue cleanup waits beyond the longest server worker and refuses to
      // delete an in-flight task. Re-read and re-park afterward so a late task
      // or trigger can never invalidate a stale "safe" result.
      try {
        await parkRetainedFixtureAfterFailure(
          firestore,
          FieldValue,
          Timestamp,
          lockRunId,
        );
        safeFailureParked = true;
      } catch {
        cleanupFailures.push('fixture-post-queue-safety-park');
      }
    }

    if (firestore && lockOwned && queuesClean) {
      try {
        assertFf1SixClientRetainedV1BoundaryStable(
          await readAndAssertFf1SixClientRetainedV1Boundary(firestore),
          retainedV1BoundaryEvidence,
        );
        retainedV1BoundaryStable = true;
      } catch {
        retainedV1BoundaryStable = false;
        cleanupFailures.push('retained-v1-boundary');
      }
    } else if (!rehearsalWriteBoundaryCrossed && retainedV1BoundaryEvidence) {
      // No fixture/account write crossed the evidence boundary. The captured
      // starting boundary remains the only authoritative state seen by this run.
      retainedV1BoundaryStable = true;
    }

    if (firestore && lockOwned && queuesClean) {
      try {
        await readAndAssertFf1SixClientHistoricalReplayRequestsQuiet(firestore);
        historicalReplayRequestsQuiet = true;
      } catch {
        historicalReplayRequestsQuiet = false;
        cleanupFailures.push('historical-replay-request-boundary');
      }
    }

    if (lockOwned && queuesClean) {
      try {
        assertEmptyFf1SixClientSharedGuardedTaskQueues();
        sharedGuardedTaskQueuesQuiet = true;
      } catch {
        sharedGuardedTaskQueuesQuiet = false;
        cleanupFailures.push('shared-guarded-task-queue-boundary');
      }
    }

    if (firestore && lockRef && lockOwned) {
      if (canReleaseFf1SixClientEvidenceLock({
        completed,
        safeFailureParked,
        clientSessionsSafe,
        fixtureAccountsSafe,
        queuesClean,
        retainedV1BoundaryStable,
        historicalReplayRequestsQuiet,
        sharedGuardedTaskQueuesQuiet,
      })) {
        try {
          await releaseSharedEvidenceLock(firestore, lockRef, lockRunId);
          lockOwned = false;
        } catch {
          cleanupFailures.push('shared-lock-release');
        }
      } else {
        try {
          await retainSharedEvidenceLockForCleanup(firestore, lockRef, lockRunId);
        } catch {
          cleanupFailures.push('shared-lock-retention');
        }
      }
    }

    try {
      await deleteAdminApp(adminApp);
    } catch {
      cleanupFailures.push('admin-client-cleanup');
    }

    if (!completed) {
      const retainedSafely =
        safeFailureParked && clientSessionsSafe && fixtureAccountsSafe && queuesClean;
      console.error(
        retainedSafely
          ? 'The six synthetic accounts were disabled and the exact fixture was retained safely for diagnosis.'
          : 'The exact fixture requires cleanup diagnosis before another staging evidence run.',
      );
    }

    if (cleanupFailures.length > 0) {
      throw new Error(`FF1 six-client cleanup failed: ${cleanupFailures.join(', ')}.`);
    }
  }
}

export async function runFf1SixClientDraftRehearsalCli({
  runner = runFf1SixClientDraftRehearsal,
  stdout = (line) => console.log(line),
  stderr = (line) => console.error(line),
} = {}) {
  try {
    const evidence = await runner();
    stdout('FF1 six-client staging Draft rehearsal passed.');
    stdout(JSON.stringify(evidence, null, 2));
    stdout(
      'Six synthetic accounts were disabled; the disposable league was retained for bounded audit.',
    );
    return 0;
  } catch (error) {
    const safeError = error instanceof Ff1SixClientPublicEvidenceError
      ? error
      : new Ff1SixClientPublicEvidenceError(
        'rehearsal',
        'cleanup-required',
        'unclassified',
      );
    stderr(JSON.stringify(safeError.toJSON()));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFf1SixClientDraftRehearsalCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
