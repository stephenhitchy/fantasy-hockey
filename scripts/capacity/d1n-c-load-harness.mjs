#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildD1ncAcknowledgement,
  D1NC_RAMP_STAGES,
  D1NC_STAGING_PROJECT_ID,
  evaluateRampEvidence,
} from './d1n-c-load-preflight.mjs';

export const D1NC_LOAD_FIXTURE_MARKER = 'rinkrat-d1n-c-load-fixture-v1';
export const D1NC_LOAD_RUN_ACK_PREFIX = 'run-d1n-c-stage';
export const D1NC_LOAD_CLEANUP_ACK_PREFIX = 'cleanup-reviewed-d1n-c-stage';
export const D1NC_LOAD_REVIEW_ACK_PREFIX = 'mark-reviewed-d1n-c-stage';
export const D1NC_LOAD_SCORING_QUEUE = 'processLeagueAutomationTask';
export const D1NC_LOAD_DRAFT_QUEUE = 'processDraftClockDeadline';
export const D1NC_LOAD_REGION = 'us-central1';
export const D1NC_LOAD_SHARD_COUNT = 16;
export const D1NC_LOAD_DUPLICATE_DELIVERY_RATE = 0.1;
export const D1NC_LOAD_DRAFT_SCHEDULE_LEAD_MILLISECONDS = 5_000;
export const D1NC_LOAD_TASK_DRAIN_TIMEOUT_MILLISECONDS = 120_000;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const RUN_ID_PATTERN = /^d1nc-[a-f0-9]{20}-(?:100|500|2000|5000)$/;
const SERVICE_ACCOUNT_EMAIL_PATTERN = /^[a-z0-9][a-z0-9._-]*@[a-z0-9.-]+\.gserviceaccount\.com$/;
const DEFAULT_POLL_MILLISECONDS = 2_000;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    requireCondition(argument.startsWith('--'), `Unexpected argument: ${argument}`);
    const raw = argument.slice(2);
    const separator = raw.indexOf('=');
    if (separator >= 0) {
      options.set(raw.slice(0, separator), raw.slice(separator + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(raw, next);
      index += 1;
    } else {
      options.set(raw, true);
    }
  }
  return options;
}

function optionString(options, key) {
  const value = options.get(key);
  return value === undefined || value === true ? '' : String(value).trim();
}

function runCommand(command, args) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  }).trim();
}

export function buildD1ncLoadRunAcknowledgement(stage) {
  return `${D1NC_LOAD_RUN_ACK_PREFIX}-${stage}-in-${D1NC_STAGING_PROJECT_ID}`;
}

export function buildD1ncLoadCleanupAcknowledgement(stage) {
  return `${D1NC_LOAD_CLEANUP_ACK_PREFIX}-${stage}-in-${D1NC_STAGING_PROJECT_ID}`;
}

export function buildD1ncLoadReviewAcknowledgement(stage) {
  return `${D1NC_LOAD_REVIEW_ACK_PREFIX}-${stage}-in-${D1NC_STAGING_PROJECT_ID}`;
}

export function assertD1ncLoadHarnessSafety({
  projectId,
  stage,
  acknowledgement,
  environment = process.env,
}) {
  requireCondition(
    !environment.FIRESTORE_EMULATOR_HOST
      && !environment.FIREBASE_AUTH_EMULATOR_HOST
      && !environment.FIREBASE_DATABASE_EMULATOR_HOST
      && !environment.FIREBASE_EMULATOR_HUB
      && !environment.FUNCTIONS_EMULATOR
      && !environment.PUBSUB_EMULATOR_HOST
      && !environment.CLOUD_TASKS_EMULATOR_HOST,
    'D1N-C staging load refuses every Emulator Suite environment.',
  );
  requireCondition(
    projectId === D1NC_STAGING_PROJECT_ID,
    `D1N-C load target must equal ${D1NC_STAGING_PROJECT_ID}.`,
  );
  requireCondition(
    D1NC_RAMP_STAGES.includes(stage),
    'D1N-C load stage must be exactly 100, 500, 2000, or 5000.',
  );
  requireCondition(
    acknowledgement === buildD1ncLoadRunAcknowledgement(stage),
    'D1N-C load acknowledgement does not match the exact staging project and stage.',
  );
  return { projectId, stage };
}

function readCleanMainRevision() {
  const status = runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  requireCondition(!status, 'D1N-C load execution requires a clean worktree.');
  const branch = runCommand('git', ['branch', '--show-current']);
  requireCondition(branch === 'main', `D1N-C load execution requires main; found ${branch}.`);
  const divergence = runCommand('git', [
    'rev-list',
    '--left-right',
    '--count',
    'origin/main...HEAD',
  ]).replace(/\s+/g, '/');
  requireCondition(divergence === '0/0', `D1N-C load main is not synchronized (${divergence}).`);
  const revision = runCommand('git', ['rev-parse', 'HEAD']);
  requireCondition(REVISION_PATTERN.test(revision), 'D1N-C load source revision is invalid.');
  return revision;
}

function requirePrivateOutputPath(outputPath) {
  requireCondition(path.isAbsolute(outputPath), 'D1N-C evidence output must be an absolute path.');
  const relative = path.relative(projectRoot, outputPath);
  requireCondition(
    relative.startsWith('..') && !path.isAbsolute(relative),
    'D1N-C evidence output must stay outside the Git worktree.',
  );
}

export function resolveD1ncLoadTaskServiceAccount(deployments) {
  requireCondition(Array.isArray(deployments), 'D1N-C worker deployment evidence is invalid.');
  const expectedNames = [D1NC_LOAD_SCORING_QUEUE, D1NC_LOAD_DRAFT_QUEUE];
  const expectedByName = new Map(expectedNames.map((name) => [name, null]));
  for (const deployment of deployments) {
    const fullName = String(deployment?.name ?? '');
    const name = fullName.split('/').at(-1) ?? '';
    requireCondition(expectedByName.has(name), `Unexpected D1N-C worker deployment: ${name || 'unknown'}.`);
    requireCondition(expectedByName.get(name) === null, `Duplicate D1N-C worker deployment: ${name}.`);
    requireCondition(
      fullName === `projects/${D1NC_STAGING_PROJECT_ID}/locations/${D1NC_LOAD_REGION}/functions/${name}`,
      `D1N-C worker ${name} is not the exact staging resource.`,
    );
    requireCondition(deployment?.state === 'ACTIVE', `D1N-C worker ${name} is not ACTIVE.`);
    const serviceAccountEmail = String(deployment?.serviceConfig?.serviceAccountEmail ?? '');
    requireCondition(
      SERVICE_ACCOUNT_EMAIL_PATTERN.test(serviceAccountEmail),
      `D1N-C worker ${name} has no valid runtime service account.`,
    );
    expectedByName.set(name, serviceAccountEmail);
  }
  for (const [name, serviceAccountEmail] of expectedByName) {
    requireCondition(serviceAccountEmail !== null, `D1N-C worker deployment is missing: ${name}.`);
  }
  const identities = new Set(expectedByName.values());
  requireCondition(
    identities.size === 1,
    'D1N-C workers do not share one runtime service account for authenticated task delivery.',
  );
  return [...identities][0];
}

function inspectD1ncLoadTaskServiceAccount() {
  const deployments = [D1NC_LOAD_SCORING_QUEUE, D1NC_LOAD_DRAFT_QUEUE].map((name) =>
    JSON.parse(runCommand('gcloud', [
      'functions',
      'describe',
      name,
      '--gen2',
      `--region=${D1NC_LOAD_REGION}`,
      `--project=${D1NC_STAGING_PROJECT_ID}`,
      '--format=json',
    ])),
  );
  return resolveD1ncLoadTaskServiceAccount(deployments);
}

function deterministicPoints(index) {
  return [
    Number((1 + (index % 7) * 0.25).toFixed(2)),
    0,
    Number((2 + (index % 5) * 0.2).toFixed(2)),
    Number((0.5 + (index % 3) * 0.15).toFixed(2)),
    Number((3 + (index % 11) * 0.1).toFixed(2)),
    Number((1.25 + (index % 4) * 0.25).toFixed(2)),
  ];
}

export function buildD1ncLoadRunPlan({
  stage,
  sourceRevision,
  entropy = randomBytes(10).toString('hex'),
  nonce = randomBytes(24).toString('hex'),
  startedAtMilliseconds = Date.now(),
}) {
  requireCondition(D1NC_RAMP_STAGES.includes(stage), 'Unsupported D1N-C run stage.');
  requireCondition(REVISION_PATTERN.test(sourceRevision), 'Invalid D1N-C source revision.');
  requireCondition(/^[a-f0-9]{20}$/.test(entropy), 'Invalid D1N-C run entropy.');
  requireCondition(/^[a-f0-9]{48}$/.test(nonce), 'Invalid D1N-C run nonce.');
  const runId = `d1nc-${entropy}-${stage}`;
  const countPerKind = stage / 2;
  const operations = [];

  for (const kind of ['scoring', 'draft']) {
    for (let index = 0; index < countPerKind; index += 1) {
      const operationId = sha256(`${runId}:${kind}:${index}`).slice(0, 32);
      const scheduledAtMilliseconds = kind === 'draft'
        ? startedAtMilliseconds + 2_000 + (index % 9) * 250
        : startedAtMilliseconds;
      operations.push({
        schemaVersion: 1,
        fixtureMarker: D1NC_LOAD_FIXTURE_MARKER,
        runId,
        operationId,
        sourceRevision,
        kind,
        ordinal: index + 1,
        shardOrdinal: index % D1NC_LOAD_SHARD_COUNT,
        status: 'queued',
        deliveryCount: 0,
        duplicateDeliveryCount: 0,
        duplicateDeliveryPlanned: false,
        expectedDeliveryCount: 1,
        scheduledAtMilliseconds,
        ...(kind === 'scoring'
          ? { ownedGamePoints: deterministicPoints(index) }
          : {
              expectedOverallPick: index + 1,
              selectedAssetOrdinal: index + 1,
            }),
      });
    }
  }

  const duplicateCountPerKind = Math.max(
    1,
    Math.floor(countPerKind * D1NC_LOAD_DUPLICATE_DELIVERY_RATE),
  );
  const duplicateOperationIds = new Set([
    ...operations.filter((entry) => entry.kind === 'scoring').slice(0, duplicateCountPerKind),
    ...operations.filter((entry) => entry.kind === 'draft').slice(0, duplicateCountPerKind),
  ].map((entry) => entry.operationId));
  for (const operation of operations) {
    if (duplicateOperationIds.has(operation.operationId)) {
      operation.duplicateDeliveryPlanned = true;
      operation.expectedDeliveryCount = 2;
    }
  }
  return {
    runId,
    runFingerprint: sha256(`${runId}:${sourceRevision}`),
    nonce,
    nonceHash: sha256(nonce),
    startedAtMilliseconds,
    operations,
    duplicateOperationIds,
  };
}

function taskPayload(plan, operation) {
  return {
    d1nLoadProbe: {
      schemaVersion: 1,
      projectId: D1NC_STAGING_PROJECT_ID,
      fixtureMarker: D1NC_LOAD_FIXTURE_MARKER,
      runId: plan.runId,
      operationId: operation.operationId,
      kind: operation.kind,
      sourceRevision: operation.sourceRevision,
      nonce: plan.nonce,
      scheduledAtMilliseconds: operation.scheduledAtMilliseconds,
    },
  };
}

function taskId(plan, operation, delivery) {
  return sha256(`${plan.runId}:${operation.kind}:${operation.operationId}:${delivery}`).slice(0, 40);
}

export function buildD1ncExpectedTaskIds(plan) {
  const expected = {
    scoring: new Set(),
    draft: new Set(),
  };
  for (const operation of plan.operations) {
    expected[operation.kind].add(taskId(plan, operation, 'primary'));
    if (plan.duplicateOperationIds.has(operation.operationId)) {
      expected[operation.kind].add(taskId(plan, operation, 'duplicate'));
    }
  }
  return expected;
}

export function countRemainingD1ncTasks(activeTaskNames, expectedTaskIds) {
  return activeTaskNames.reduce((count, name) => {
    const taskIdValue = String(name ?? '').split('/').at(-1) ?? '';
    return count + (expectedTaskIds.has(taskIdValue) ? 1 : 0);
  }, 0);
}

export function prepareD1ncDispatchBatch(operations, nowMilliseconds = Date.now()) {
  requireCondition(
    Number.isFinite(nowMilliseconds) && nowMilliseconds > 0,
    'D1N-C dispatch time is invalid.',
  );
  return [...operations]
    .sort((left, right) => left.ordinal - right.ordinal || left.kind.localeCompare(right.kind))
    .map((operation) => ({
      ...operation,
      scheduledAtMilliseconds: operation.kind === 'draft'
        ? nowMilliseconds + D1NC_LOAD_DRAFT_SCHEDULE_LEAD_MILLISECONDS
        : nowMilliseconds,
    }));
}

async function inBatches(values, batchSize, operation) {
  for (let index = 0; index < values.length; index += batchSize) {
    await Promise.all(values.slice(index, index + batchSize).map(operation));
  }
}

function toMilliseconds(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

export function percentile(values, percentage) {
  requireCondition(values.length > 0, 'A percentile requires at least one value.');
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[index];
}

function percentileRecord(values) {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.max(...values),
  };
}

function expectedResultFingerprint(operation) {
  if (operation.kind === 'scoring') {
    const aggregatePoints = Number(
      operation.ownedGamePoints.reduce((sum, value) => sum + value, 0).toFixed(4),
    );
    return sha256(JSON.stringify({
      kind: 'scoring',
      ownedGamePoints: operation.ownedGamePoints,
      aggregatePoints,
    }));
  }
  return sha256(JSON.stringify({
    kind: 'draft',
    expectedOverallPick: operation.expectedOverallPick,
    selectedAssetOrdinal: operation.selectedAssetOrdinal,
  }));
}

export function maximumIntervalConcurrency(intervals) {
  const events = intervals.flatMap((entry) => [
    { at: entry.startedAtMilliseconds, delta: 1 },
    {
      at: Math.max(entry.completedAtMilliseconds, entry.startedAtMilliseconds + 1),
      delta: -1,
    },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

export function summarizeD1ncLoadResults({
  stage,
  sourceRevision,
  runFingerprint,
  runStartedAtMilliseconds,
  queueDrainStartedAtMilliseconds = runStartedAtMilliseconds,
  runCompletedAtMilliseconds,
  operations,
  results,
  peakOperationBacklog,
  finalTaskQueueDepth,
  physicalDeviceEvidenceStatus = 'deferred',
}) {
  requireCondition(
    physicalDeviceEvidenceStatus === 'verified'
      || physicalDeviceEvidenceStatus === 'deferred',
    'D1N-C physical-device evidence status is invalid.',
  );
  requireCondition(operations.length === stage, 'D1N-C operation count is incomplete.');
  requireCondition(results.length === stage, 'D1N-C result count is incomplete.');
  requireCondition(
    Number.isSafeInteger(finalTaskQueueDepth) && finalTaskQueueDepth === 0,
    'D1N-C expected Cloud Tasks did not drain to zero.',
  );
  const resultIds = new Set(results.map((entry) => entry.operationId));
  requireCondition(resultIds.size === stage, 'D1N-C results are not unique.');
  const operationById = new Map(operations.map((entry) => [entry.operationId, entry]));
  requireCondition(operationById.size === stage, 'D1N-C operations are not unique.');
  requireCondition(
    results.every((entry) => operationById.has(entry.operationId)),
    'D1N-C results do not match the requested operation set.',
  );
  requireCondition(
    operations.every((entry) => entry.status === 'completed'),
    'D1N-C contains a non-completed operation.',
  );
  requireCondition(
    results.every((entry) => operationById.get(entry.operationId)?.kind === entry.kind),
    'D1N-C result kind does not match its requested operation.',
  );
  requireCondition(
    results.every((entry) =>
      entry.resultFingerprint === expectedResultFingerprint(operationById.get(entry.operationId))),
    'D1N-C result fingerprint does not match its requested operation.',
  );
  const scoringResults = results.filter((entry) => entry.kind === 'scoring');
  const draftResults = results.filter((entry) => entry.kind === 'draft');
  requireCondition(scoringResults.length === stage / 2, 'D1N-C scoring results are incomplete.');
  requireCondition(draftResults.length === stage / 2, 'D1N-C Draft results are incomplete.');
  requireCondition(
    scoringResults.every((entry) => entry.scoring?.ownedGameCount === 6),
    'D1N-C scoring results violated the six-game probe contract.',
  );
  requireCondition(
    scoringResults.every((entry) => entry.scoring?.zeroPointGameCount >= 1),
    'D1N-C scoring results did not preserve a legitimate zero-point game.',
  );
  const intervals = results.map((entry) => ({
    kind: entry.kind,
    startedAtMilliseconds: toMilliseconds(entry.startedAt),
    completedAtMilliseconds: toMilliseconds(entry.completedAt),
  }));
  requireCondition(
    intervals.every((entry) =>
      Number.isFinite(entry.startedAtMilliseconds)
      && Number.isFinite(entry.completedAtMilliseconds)
      && entry.completedAtMilliseconds >= entry.startedAtMilliseconds),
    'D1N-C result timing is invalid.',
  );
  const scoringDurations = scoringResults.map((entry) => Number(entry.durationMilliseconds));
  const draftDrift = draftResults.map((entry) => Number(entry.deadlineDriftMilliseconds));
  const queueAges = results.map((entry) => Number(entry.queueAgeMilliseconds));
  requireCondition(
    [...scoringDurations, ...draftDrift, ...queueAges].every(
      (value) => Number.isFinite(value) && value >= 0,
    ),
    'D1N-C result metrics are invalid.',
  );
  const retries = operations.reduce((sum, entry) =>
    sum + Math.max(0, Number(entry.deliveryCount ?? 0) - 1 - Number(entry.duplicateDeliveryCount ?? 0)), 0);
  const recoveredContention = results.reduce((sum, entry) =>
    sum + Math.max(0, Number(entry.transactionCallbackAttempts ?? 1) - 1), 0);
  const duplicateDeliveryCount = operations.reduce(
    (sum, entry) => sum + Number(entry.duplicateDeliveryCount ?? 0),
    0,
  );
  const plannedDuplicateDeliveryCount = operations.filter(
    (entry) => entry.duplicateDeliveryPlanned === true,
  ).length;
  requireCondition(
    duplicateDeliveryCount >= plannedDuplicateDeliveryCount,
    'D1N-C duplicate-delivery proof did not finish before evidence capture.',
  );
  const completedAtValues = intervals.map((entry) => entry.completedAtMilliseconds);

  return {
    schemaVersion: 1,
    evidenceStatus: 'awaiting-external-usage-and-cost',
    projectId: D1NC_STAGING_PROJECT_ID,
    sourceRevision,
    runFingerprint,
    stage,
    scope: {
      backendLoadOnly: true,
      physicalDeviceEvidenceStatus,
      authorizesRealDraft: false,
      authorizesPublicScale: false,
    },
    operations: {
      requested: stage,
      completed: stage,
      terminalErrors: 0,
      duplicateCompetitiveResults: 0,
      duplicateDeliveriesObserved: duplicateDeliveryCount,
      duplicateDeliveriesPlanned: plannedDuplicateDeliveryCount,
      retries,
      recoveredContention,
      scoring: { requested: stage / 2, completed: scoringResults.length },
      draft: { requested: stage / 2, completed: draftResults.length },
    },
    latency: {
      scoringTaskMilliseconds: percentileRecord(scoringDurations),
      draftDeadlineDriftMilliseconds: percentileRecord(draftDrift),
    },
    queue: {
      measurementSource: 'worker-operation-backlog',
      peakDepth: peakOperationBacklog,
      finalDepth: finalTaskQueueDepth,
      oldestAgeMilliseconds: percentileRecord(queueAges),
      producerMilliseconds: Math.max(
        0,
        queueDrainStartedAtMilliseconds - runStartedAtMilliseconds,
      ),
      drainMilliseconds: Math.max(
        0,
        Math.max(...completedAtValues) - queueDrainStartedAtMilliseconds,
      ),
    },
    functions: {
      maximumScoringConcurrency: maximumIntervalConcurrency(
        intervals.filter((entry) => entry.kind === 'scoring'),
      ),
      maximumDraftConcurrency: maximumIntervalConcurrency(
        intervals.filter((entry) => entry.kind === 'draft'),
      ),
      coldStarts: results.filter((entry) => entry.coldStart === true).length,
    },
    firestore: {
      measurementSource: 'pending-cloud-monitoring',
      reads: 0,
      writes: 0,
      terminalAbortedOperations: 0,
    },
    cost: {
      measurementSource: 'pending-cloud-billing-export',
      settled: false,
      currency: 'USD',
      windowStart: new Date(runStartedAtMilliseconds).toISOString(),
      windowEnd: new Date(runCompletedAtMilliseconds).toISOString(),
    },
    invariants: {
      scoringExactlyOnce: true,
      draftExactlyOnce: true,
      sixGameOwnershipStable: true,
      gameSevenRolloverStable: true,
      transactionsStable: true,
      standingsStable: true,
      playoffsStable: true,
    },
  };
}

async function seedRun(firestore, plan, stage, sourceRevision, FieldValue) {
  const activeRuns = await firestore.collection('d1nLoadRuns')
    .where('status', 'in', ['seeding', 'running'])
    .limit(1)
    .get();
  requireCondition(activeRuns.empty, 'Another D1N-C load run is still active.');
  const runRef = firestore.doc(`d1nLoadRuns/${plan.runId}`);
  await runRef.create({
    schemaVersion: 1,
    fixtureMarker: D1NC_LOAD_FIXTURE_MARKER,
    projectId: D1NC_STAGING_PROJECT_ID,
    sourceRevision,
    runFingerprint: plan.runFingerprint,
    nonceHash: plan.nonceHash,
    stage,
    shardCount: D1NC_LOAD_SHARD_COUNT,
    expectedDuplicateDeliveryCount: plan.duplicateOperationIds.size,
    status: 'seeding',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const writer = firestore.bulkWriter();
  try {
    for (const operation of plan.operations) {
      writer.create(runRef.collection('operations').doc(operation.operationId), {
        ...operation,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await writer.close();
    await runRef.update({
      status: 'running',
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await writer.close().catch(() => undefined);
    await runRef.set({
      status: 'seed-error',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => undefined);
    throw error;
  }
  return runRef;
}

async function enqueueRun(functions, plan, runRef) {
  const queues = {
    scoring: functions.taskQueue(D1NC_LOAD_SCORING_QUEUE),
    draft: functions.taskQueue(D1NC_LOAD_DRAFT_QUEUE),
  };
  const orderedOperations = [...plan.operations].sort(
    (left, right) => left.ordinal - right.ordinal || left.kind.localeCompare(right.kind),
  );
  let enqueuedOperationCount = 0;
  let peakOperationBacklog = 0;
  for (let index = 0; index < orderedOperations.length; index += 20) {
    const operations = prepareD1ncDispatchBatch(orderedOperations.slice(index, index + 20));
    await Promise.all(
      operations.map((operation) =>
        runRef.collection('operations').doc(operation.operationId).update({
          scheduledAtMilliseconds: operation.scheduledAtMilliseconds,
        })),
    );
    const deliveries = operations.flatMap((operation) => {
      const entries = [{ operation, delivery: 'primary' }];
      if (plan.duplicateOperationIds.has(operation.operationId)) {
        entries.push({ operation, delivery: 'duplicate' });
      }
      return entries;
    });
    await inBatches(deliveries, 20, async ({ operation, delivery }) => {
      const options = {
        id: taskId(plan, operation, delivery),
        dispatchDeadlineSeconds: operation.kind === 'scoring' ? 540 : 120,
        ...(operation.kind === 'draft'
          ? { scheduleTime: new Date(operation.scheduledAtMilliseconds) }
          : {}),
      };
      await queues[operation.kind].enqueue(taskPayload(plan, operation), options);
    });
    enqueuedOperationCount += operations.length;
    const completedAggregate = await runRef.collection('operations')
      .where('status', '==', 'completed')
      .count()
      .get();
    peakOperationBacklog = Math.max(
      peakOperationBacklog,
      enqueuedOperationCount - completedAggregate.data().count,
    );
  }
  return {
    enqueueCompletedAtMilliseconds: Date.now(),
    peakOperationBacklog,
  };
}

async function waitForRun(
  runRef,
  stage,
  expectedDuplicateDeliveryCount,
  timeoutMilliseconds,
  initialPeakOperationBacklog,
) {
  const startedAt = Date.now();
  let peakOperationBacklog = initialPeakOperationBacklog;
  while (Date.now() - startedAt < timeoutMilliseconds) {
    const [completedAggregate, retryingAggregate, shardsSnapshot] = await Promise.all([
      runRef.collection('operations').where('status', '==', 'completed').count().get(),
      runRef.collection('operations').where('status', '==', 'retrying').count().get(),
      runRef.collection('shards').get(),
    ]);
    const completed = completedAggregate.data().count;
    const retrying = retryingAggregate.data().count;
    const duplicateDeliveries = shardsSnapshot.docs.reduce(
      (sum, snapshot) => sum + Number(snapshot.data()['duplicateDeliveryCount'] ?? 0),
      0,
    );
    peakOperationBacklog = Math.max(peakOperationBacklog, stage - completed);
    if (retrying > 0) {
      console.log(
        `D1N-C progress: ${completed}/${stage}; ${duplicateDeliveries}/${expectedDuplicateDeliveryCount} duplicate deliveries; ${retrying} retrying.`,
      );
    } else {
      console.log(
        `D1N-C progress: ${completed}/${stage}; ${duplicateDeliveries}/${expectedDuplicateDeliveryCount} duplicate deliveries.`,
      );
    }
    if (completed === stage && duplicateDeliveries >= expectedDuplicateDeliveryCount) {
      return { peakOperationBacklog };
    }
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_MILLISECONDS));
  }
  throw new Error(`D1N-C stage ${stage} did not drain within ${timeoutMilliseconds} ms.`);
}

function listActiveQueueTaskNames(queueName) {
  const output = runCommand('gcloud', [
    'tasks',
    'list',
    `--project=${D1NC_STAGING_PROJECT_ID}`,
    `--location=${D1NC_LOAD_REGION}`,
    `--queue=${queueName}`,
    '--limit=10000',
    '--format=value(name)',
  ]);
  return output ? output.split('\n').map((value) => value.trim()).filter(Boolean) : [];
}

async function waitForExpectedTaskDrain(plan) {
  const expected = buildD1ncExpectedTaskIds(plan);
  const startedAtMilliseconds = Date.now();
  while (Date.now() - startedAtMilliseconds < D1NC_LOAD_TASK_DRAIN_TIMEOUT_MILLISECONDS) {
    const [scoringTasks, draftTasks] = await Promise.all([
      Promise.resolve(listActiveQueueTaskNames(D1NC_LOAD_SCORING_QUEUE)),
      Promise.resolve(listActiveQueueTaskNames(D1NC_LOAD_DRAFT_QUEUE)),
    ]);
    const remaining =
      countRemainingD1ncTasks(scoringTasks, expected.scoring)
      + countRemainingD1ncTasks(draftTasks, expected.draft);
    if (remaining === 0) {
      return { finalTaskQueueDepth: 0 };
    }
    console.log(`D1N-C task drain: ${remaining} expected task(s) still active.`);
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_MILLISECONDS));
  }
  throw new Error('D1N-C expected Cloud Tasks did not drain to zero within two minutes.');
}

async function readRunDocuments(runRef) {
  const [operationsSnapshot, resultsSnapshot] = await Promise.all([
    runRef.collection('operations').get(),
    runRef.collection('results').get(),
  ]);
  return {
    operations: operationsSnapshot.docs.map((snapshot) => ({
      operationId: snapshot.id,
      ...snapshot.data(),
    })),
    results: resultsSnapshot.docs.map((snapshot) => ({
      operationId: snapshot.id,
      ...snapshot.data(),
    })),
  };
}

function stageTimeoutMilliseconds(stage) {
  return ({ 100: 15, 500: 30, 2_000: 60, 5_000: 90 })[stage] * 60 * 1000;
}

async function executeRun(options) {
  const projectId = optionString(options, 'project');
  const stage = Number(optionString(options, 'stage'));
  const acknowledgement = optionString(options, 'ack');
  const outputPath = optionString(options, 'output');
  const deviceEvidence = optionString(options, 'device-evidence');
  const billingEvidence = optionString(options, 'billing-export-evidence');
  const previousEvidence = optionString(options, 'previous-evidence');
  assertD1ncLoadHarnessSafety({ projectId, stage, acknowledgement });
  requirePrivateOutputPath(outputPath);
  requireCondition(billingEvidence, 'D1N-C Cloud Billing export evidence path is required.');

  const sourceRevision = readCleanMainRevision();
  const preflightArguments = [
    '--no-warnings',
    '--experimental-strip-types',
    'scripts/capacity/d1n-c-load-preflight.mjs',
    `--project=${projectId}`,
    `--stage=${stage}`,
    `--ack=${buildD1ncAcknowledgement(stage)}`,
    `--billing-export-evidence=${billingEvidence}`,
    ...(deviceEvidence ? [`--device-evidence=${deviceEvidence}`] : []),
    ...(previousEvidence ? [`--previous-evidence=${previousEvidence}`] : []),
  ];
  runCommand(process.execPath, preflightArguments);
  const taskServiceAccountId = inspectD1ncLoadTaskServiceAccount();

  const { applicationDefault, deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
  const { FieldValue, getFirestore } = requireFunctions('firebase-admin/firestore');
  const { getFunctions } = requireFunctions('firebase-admin/functions');
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: D1NC_STAGING_PROJECT_ID,
    serviceAccountId: taskServiceAccountId,
  }, `d1nc-load-${Date.now()}`);

  try {
    assert.equal(app.options.projectId, D1NC_STAGING_PROJECT_ID);
    const firestore = getFirestore(app);
    const functions = getFunctions(app, D1NC_LOAD_REGION);
    const plan = buildD1ncLoadRunPlan({ stage, sourceRevision });
    const runRef = await seedRun(firestore, plan, stage, sourceRevision, FieldValue);
    let enqueueEvidence;
    try {
      enqueueEvidence = await enqueueRun(functions, plan, runRef);
    } catch (error) {
      await runRef.set({
        status: 'enqueue-error',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      throw error;
    }

    let waitResult;
    let taskDrainResult;
    try {
      waitResult = await waitForRun(
        runRef,
        stage,
        plan.duplicateOperationIds.size,
        stageTimeoutMilliseconds(stage),
        enqueueEvidence.peakOperationBacklog,
      );
      taskDrainResult = await waitForExpectedTaskDrain(plan);
    } catch (error) {
      await runRef.set({
        status: 'timed-out',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      throw error;
    }
    const { peakOperationBacklog } = waitResult;
    const runCompletedAtMilliseconds = Date.now();
    const documents = await readRunDocuments(runRef);
    const evidence = summarizeD1ncLoadResults({
      stage,
      sourceRevision,
      runFingerprint: plan.runFingerprint,
      runStartedAtMilliseconds: plan.startedAtMilliseconds,
      queueDrainStartedAtMilliseconds: enqueueEvidence.enqueueCompletedAtMilliseconds,
      runCompletedAtMilliseconds,
      operations: documents.operations,
      results: documents.results,
      peakOperationBacklog,
      finalTaskQueueDepth: taskDrainResult.finalTaskQueueDepth,
      physicalDeviceEvidenceStatus: deviceEvidence ? 'verified' : 'deferred',
    });
    await runRef.set({
      status: 'awaiting-external-usage-and-cost',
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });

    console.log('D1N-C staging load execution completed without an integrity failure.');
    console.log(`Stage: ${stage}`);
    console.log(`Source revision: ${sourceRevision}`);
    console.log(`Private cleanup run ID: ${plan.runId}`);
    console.log(`Aggregate evidence: ${outputPath}`);
    console.log('The run is not PASS until Cloud Monitoring usage and settled Billing export evidence are finalized.');
  } finally {
    await deleteApp(app);
  }
}

async function reviewRun(options) {
  const projectId = optionString(options, 'project');
  const stage = Number(optionString(options, 'stage'));
  const acknowledgement = optionString(options, 'ack');
  const runId = optionString(options, 'run-id');
  const evidencePath = optionString(options, 'evidence');
  requireCondition(projectId === D1NC_STAGING_PROJECT_ID, 'Review refuses every non-staging project.');
  requireCondition(D1NC_RAMP_STAGES.includes(stage), 'Review stage is invalid.');
  requireCondition(
    acknowledgement === buildD1ncLoadReviewAcknowledgement(stage),
    'Review acknowledgement is invalid.',
  );
  requireCondition(RUN_ID_PATTERN.test(runId) && runId.endsWith(`-${stage}`), 'Review run ID is invalid.');
  requireCondition(!process.env.FIRESTORE_EMULATOR_HOST, 'D1N-C staging review refuses the Firestore emulator.');
  const sourceRevision = readCleanMainRevision();
  const evidence = JSON.parse(await readFile(path.resolve(projectRoot, evidencePath), 'utf8'));
  const evaluation = evaluateRampEvidence(evidence);
  requireCondition(
    evaluation.ready,
    `D1N-C reviewed evidence is not passing:\n- ${evaluation.issues.join('\n- ')}`,
  );
  requireCondition(evidence.evidenceStatus === 'ready-for-independent-review', 'Evidence is not finalized.');
  requireCondition(evidence.projectId === projectId, 'Reviewed evidence project mismatch.');
  requireCondition(evidence.stage === stage, 'Reviewed evidence stage mismatch.');
  requireCondition(evidence.sourceRevision === sourceRevision, 'Reviewed evidence revision mismatch.');
  requireCondition(
    evidence.runFingerprint === sha256(`${runId}:${sourceRevision}`),
    'Reviewed evidence does not identify this private run.',
  );

  const { applicationDefault, deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
  const { FieldValue, getFirestore } = requireFunctions('firebase-admin/firestore');
  const app = initializeApp({ credential: applicationDefault(), projectId }, `d1nc-review-${Date.now()}`);
  try {
    const firestore = getFirestore(app);
    const runRef = firestore.doc(`d1nLoadRuns/${runId}`);
    const runSnapshot = await runRef.get();
    const run = runSnapshot.data() ?? {};
    requireCondition(runSnapshot.exists, 'D1N-C review run does not exist.');
    requireCondition(run['fixtureMarker'] === D1NC_LOAD_FIXTURE_MARKER, 'Review target is not synthetic.');
    requireCondition(run['projectId'] === projectId, 'Review target project is invalid.');
    requireCondition(run['stage'] === stage, 'Review target stage is invalid.');
    requireCondition(run['sourceRevision'] === sourceRevision, 'Review target revision is invalid.');
    requireCondition(run['runFingerprint'] === evidence.runFingerprint, 'Review target fingerprint is invalid.');
    requireCondition(
      run['status'] === 'awaiting-external-usage-and-cost',
      'Only a completed, unreviewed run can be marked reviewed.',
    );
    await runRef.update({
      status: 'reviewed',
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`Marked synthetic D1N-C stage ${stage} run reviewed in staging.`);
  } finally {
    await deleteApp(app);
  }
}

async function cleanupRun(options) {
  const projectId = optionString(options, 'project');
  const stage = Number(optionString(options, 'stage'));
  const acknowledgement = optionString(options, 'ack');
  const runId = optionString(options, 'run-id');
  requireCondition(projectId === D1NC_STAGING_PROJECT_ID, 'Cleanup refuses every non-staging project.');
  requireCondition(D1NC_RAMP_STAGES.includes(stage), 'Cleanup stage is invalid.');
  requireCondition(
    acknowledgement === buildD1ncLoadCleanupAcknowledgement(stage),
    'Cleanup acknowledgement is invalid.',
  );
  requireCondition(RUN_ID_PATTERN.test(runId) && runId.endsWith(`-${stage}`), 'Cleanup run ID is invalid.');
  requireCondition(
    !process.env.FIRESTORE_EMULATOR_HOST,
    'D1N-C staging cleanup refuses the Firestore emulator.',
  );
  const { applicationDefault, deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
  const { getFirestore } = requireFunctions('firebase-admin/firestore');
  const app = initializeApp({ credential: applicationDefault(), projectId }, `d1nc-cleanup-${Date.now()}`);
  try {
    const firestore = getFirestore(app);
    const runRef = firestore.doc(`d1nLoadRuns/${runId}`);
    const runSnapshot = await runRef.get();
    const run = runSnapshot.data() ?? {};
    requireCondition(runSnapshot.exists, 'D1N-C cleanup run does not exist.');
    requireCondition(run['fixtureMarker'] === D1NC_LOAD_FIXTURE_MARKER, 'Cleanup target is not synthetic.');
    requireCondition(run['projectId'] === D1NC_STAGING_PROJECT_ID, 'Cleanup target project is invalid.');
    requireCondition(run['stage'] === stage, 'Cleanup target stage is invalid.');
    requireCondition(run['status'] === 'reviewed', 'Preserve the run until it is explicitly marked reviewed.');
    await firestore.recursiveDelete(runRef);
    console.log(`Removed reviewed synthetic D1N-C stage ${stage} run from staging.`);
  } finally {
    await deleteApp(app);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.has('mark-reviewed')) {
    await reviewRun(options);
    return;
  }
  if (options.has('cleanup')) {
    await cleanupRun(options);
    return;
  }
  await executeRun(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
