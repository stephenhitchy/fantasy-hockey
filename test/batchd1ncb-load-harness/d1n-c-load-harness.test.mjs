import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  assertD1ncLoadHarnessSafety,
  buildD1ncDraftQueueWarmupPlan,
  buildD1ncExpectedTaskIds,
  buildD1ncLoadRunAcknowledgement,
  buildD1ncLoadRunPlan,
  countRemainingD1ncTasks,
  D1NC_LOAD_DRAFT_QUEUE_WARMUPS_PER_OPERATION_STAGE,
  D1NC_LOAD_DRAFT_RESERVATION_LEAD_MILLISECONDS,
  maximumIntervalConcurrency,
  percentile,
  prepareD1ncDispatchBatch,
  resolveD1ncLoadTaskServiceAccount,
  summarizeD1ncLoadResults,
} from '../../scripts/capacity/d1n-c-load-harness.mjs';
import {
  D1NC_DRAFT_QUEUE_WARMUPS_PER_OPERATION_STAGE,
  D1NC_STAGING_PROJECT_ID,
  evaluateRampEvidence,
} from '../../scripts/capacity/d1n-c-load-preflight.mjs';
import { finalizeD1ncLoadEvidence } from '../../scripts/capacity/finalize-d1n-c-load-evidence.mjs';

const require = createRequire(import.meta.url);
const {
  assertD1nLoadProbeRuntimeProject,
  buildD1nLoadProbeResult,
  D1NC_LOAD_FIXTURE_MARKER,
  d1nLoadProbeReservationDelayMilliseconds,
  parseD1nLoadProbeTaskPayload,
  resolveD1nLoadRuntimeProjectId,
} = require('../../functions/lib/d1n-load-probe.util.js');

const revision = 'a'.repeat(40);
const entropy = 'b'.repeat(20);
const nonce = 'c'.repeat(48);
const startedAtMilliseconds = Date.parse('2026-09-04T18:00:00Z');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function validPayload(kind = 'scoring') {
  return {
    schemaVersion: 1,
    projectId: D1NC_STAGING_PROJECT_ID,
    fixtureMarker: D1NC_LOAD_FIXTURE_MARKER,
    runId: `d1nc-${entropy}-100`,
    operationId: 'd'.repeat(32),
    kind,
    sourceRevision: revision,
    nonce,
    scheduledAtMilliseconds: startedAtMilliseconds,
  };
}

function completedDocuments(plan) {
  const operations = plan.operations.map((operation) => ({
    ...operation,
    status: 'completed',
    deliveryCount: operation.expectedDeliveryCount,
    duplicateDeliveryCount: operation.duplicateDeliveryPlanned ? 1 : 0,
    recoveredContentionCount: 0,
  }));
  const results = operations.map((operation, index) => {
    const localIndex = operation.ordinal - 1;
    const startedAt = operation.kind === 'scoring'
      ? startedAtMilliseconds + 5_000 + Math.floor(localIndex / 4) * 10
      : operation.scheduledAtMilliseconds + 100;
    const completedAt = startedAt + 5;
    const aggregatePoints = operation.kind === 'scoring'
      ? Number(operation.ownedGamePoints.reduce((sum, value) => sum + value, 0).toFixed(4))
      : null;
    const resultFingerprint = operation.kind === 'scoring'
      ? sha256(JSON.stringify({
          kind: 'scoring',
          ownedGamePoints: operation.ownedGamePoints,
          aggregatePoints,
        }))
      : sha256(JSON.stringify({
          kind: 'draft',
          expectedOverallPick: operation.expectedOverallPick,
          selectedAssetOrdinal: operation.selectedAssetOrdinal,
        }));
    return {
      operationId: operation.operationId,
      kind: operation.kind,
      resultFingerprint,
      queueAgeMilliseconds: Math.max(0, startedAt - operation.scheduledAtMilliseconds),
      durationMilliseconds: completedAt - startedAt,
      deadlineDriftMilliseconds:
        operation.kind === 'draft'
          ? Math.max(0, startedAt - operation.scheduledAtMilliseconds)
          : null,
      transactionCallbackAttempts: 1,
      coldStart: index === 0,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      ...(operation.kind === 'scoring'
        ? { scoring: { ownedGameCount: 6, zeroPointGameCount: 1, aggregatePoints: 7 } }
        : { draft: { expectedOverallPick: operation.ordinal, selectedAssetOrdinal: operation.ordinal } }),
    };
  });
  return { operations, results };
}

test('the load harness refuses Production, emulators, unsupported stages, and weak acknowledgements', () => {
  assert.deepEqual(assertD1ncLoadHarnessSafety({
    projectId: D1NC_STAGING_PROJECT_ID,
    stage: 100,
    acknowledgement: buildD1ncLoadRunAcknowledgement(100),
    environment: {},
  }), { projectId: D1NC_STAGING_PROJECT_ID, stage: 100 });
  for (const input of [
    { projectId: 'nhl-fantasy-app-ab673', stage: 100, acknowledgement: buildD1ncLoadRunAcknowledgement(100), environment: {} },
    { projectId: D1NC_STAGING_PROJECT_ID, stage: 101, acknowledgement: buildD1ncLoadRunAcknowledgement(101), environment: {} },
    { projectId: D1NC_STAGING_PROJECT_ID, stage: 100, acknowledgement: 'yes', environment: {} },
    { projectId: D1NC_STAGING_PROJECT_ID, stage: 100, acknowledgement: buildD1ncLoadRunAcknowledgement(100), environment: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' } },
  ]) assert.throws(() => assertD1ncLoadHarnessSafety(input));
});

test('the deterministic plan is balanced, sharded, hashed, and includes bounded duplicate delivery', () => {
  const plan = buildD1ncLoadRunPlan({
    stage: 100,
    sourceRevision: revision,
    entropy,
    nonce,
    startedAtMilliseconds,
  });
  const repeat = buildD1ncLoadRunPlan({
    stage: 100,
    sourceRevision: revision,
    entropy,
    nonce,
    startedAtMilliseconds,
  });
  assert.equal(plan.operations.length, 100);
  assert.equal(plan.operations.filter((entry) => entry.kind === 'scoring').length, 50);
  assert.equal(plan.operations.filter((entry) => entry.kind === 'draft').length, 50);
  assert.equal(plan.duplicateOperationIds.size, 10);
  assert.equal(plan.operations.filter((entry) => entry.duplicateDeliveryPlanned).length, 10);
  assert.ok(plan.operations.every((entry) => /^[a-f0-9]{32}$/.test(entry.operationId)));
  assert.ok(plan.operations.every((entry) => entry.shardOrdinal >= 0 && entry.shardOrdinal < 16));
  assert.ok(plan.operations.filter((entry) => entry.kind === 'scoring')
    .every((entry) => entry.ownedGamePoints.length === 6 && entry.ownedGamePoints.includes(0)));
  assert.deepEqual(plan.operations, repeat.operations);
  assert.equal(plan.runFingerprint, repeat.runFingerprint);
});

test('task delivery uses the one exact service account shared by both staging workers', () => {
  const serviceAccountEmail = '123456789-compute@developer.gserviceaccount.com';
  const deployment = (name, overrides = {}) => ({
    name: `projects/${D1NC_STAGING_PROJECT_ID}/locations/us-central1/functions/${name}`,
    state: 'ACTIVE',
    serviceConfig: { serviceAccountEmail },
    ...overrides,
  });
  const deployments = [
    deployment('processLeagueAutomationTask'),
    deployment('processDraftClockDeadline'),
  ];
  assert.equal(resolveD1ncLoadTaskServiceAccount(deployments), serviceAccountEmail);
  assert.throws(
    () => resolveD1ncLoadTaskServiceAccount(deployments.slice(0, 1)),
    /deployment is missing/,
  );
  assert.throws(
    () => resolveD1ncLoadTaskServiceAccount([
      deployments[0],
      deployment('processDraftClockDeadline', {
        serviceConfig: { serviceAccountEmail: 'different@project.iam.gserviceaccount.com' },
      }),
    ]),
    /do not share one runtime service account/,
  );
  assert.throws(
    () => resolveD1ncLoadTaskServiceAccount([
      deployments[0],
      deployment('processDraftClockDeadline', { state: 'FAILED' }),
    ]),
    /not ACTIVE/,
  );
  assert.throws(
    () => resolveD1ncLoadTaskServiceAccount([
      deployments[0],
      deployment('processDraftClockDeadline', {
        name: 'projects/nhl-fantasy-app-ab673/locations/us-central1/functions/processDraftClockDeadline',
      }),
    ]),
    /not the exact staging resource/,
  );
});

test('raw ramp evidence records deferred device coverage without claiming broader readiness', () => {
  const plan = buildD1ncLoadRunPlan({
    stage: 100,
    sourceRevision: revision,
    entropy,
    nonce,
    startedAtMilliseconds,
  });
  const documents = completedDocuments(plan);
  const common = {
    stage: 100,
    sourceRevision: revision,
    runFingerprint: plan.runFingerprint,
    runStartedAtMilliseconds: startedAtMilliseconds,
    queueDrainStartedAtMilliseconds: startedAtMilliseconds + 1_000,
    queueDrainEligibleAtMilliseconds: startedAtMilliseconds + 185_000,
    runCompletedAtMilliseconds: startedAtMilliseconds + 185_125,
    operations: documents.operations,
    results: documents.results,
    peakOperationBacklog: 100,
    finalTaskQueueDepth: 0,
    draftQueueWarmupTaskCount: 900,
  };
  const evidence = summarizeD1ncLoadResults(common);
  assert.deepEqual(evidence.scope, {
    backendLoadOnly: true,
    physicalDeviceEvidenceStatus: 'deferred',
    authorizesRealDraft: false,
    authorizesPublicScale: false,
  });
  assert.equal(evidence.queue.draftQueueWarmupTaskCount, 900);
  assert.equal(evidence.queue.producerMilliseconds, 1_000);
  assert.equal(evidence.queue.drainMilliseconds, 125);
  const operationsWithDuplicateContention = structuredClone(documents.operations);
  const contendedDuplicate = operationsWithDuplicateContention.find(
    (entry) => entry.duplicateDeliveryPlanned,
  );
  contendedDuplicate.recoveredContentionCount = 2;
  const contendedEvidence = summarizeD1ncLoadResults({
    ...common,
    operations: operationsWithDuplicateContention,
  });
  assert.equal(contendedEvidence.operations.recoveredContention, 2);
  assert.ok(
    evaluateRampEvidence(contendedEvidence).issues.includes(
      'recovered contention rate exceeds 1%',
    ),
  );
  assert.throws(
    () => summarizeD1ncLoadResults({
      ...common,
      physicalDeviceEvidenceStatus: 'invented',
    }),
    /physical-device evidence status/,
  );
});

test('dispatch batches interleave worker kinds and assign deadlines from enqueue time', () => {
  const plan = buildD1ncLoadRunPlan({
    stage: 100,
    sourceRevision: revision,
    entropy,
    nonce,
    startedAtMilliseconds,
  });
  const prepared = prepareD1ncDispatchBatch(plan.operations, startedAtMilliseconds + 30_000);
  assert.deepEqual(prepared.slice(0, 4).map((entry) => entry.kind), [
    'draft',
    'scoring',
    'draft',
    'scoring',
  ]);
  assert.ok(prepared.filter((entry) => entry.kind === 'scoring')
    .every((entry) => entry.scheduledAtMilliseconds === startedAtMilliseconds + 30_000));
  assert.ok(prepared.filter((entry) => entry.kind === 'draft')
    .every((entry) => entry.scheduledAtMilliseconds === startedAtMilliseconds + 35_000));

  const warmupPlan = buildD1ncDraftQueueWarmupPlan(
    plan,
    startedAtMilliseconds,
  );
  assert.equal(warmupPlan.tasks.length, 900);
  assert.equal(
    D1NC_LOAD_DRAFT_QUEUE_WARMUPS_PER_OPERATION_STAGE,
    D1NC_DRAFT_QUEUE_WARMUPS_PER_OPERATION_STAGE,
  );
  assert.equal(
    warmupPlan.expectedScheduledStartAtMilliseconds,
    startedAtMilliseconds + 185_000,
  );
  assert.equal(
    warmupPlan.tasks.filter((entry) => entry.warmupLeadMilliseconds === 180_000).length,
    50,
  );
  assert.equal(
    warmupPlan.tasks.filter((entry) => entry.warmupLeadMilliseconds === 60_000).length,
    50,
  );
  assert.equal(
    warmupPlan.tasks.filter((entry) => entry.warmupLeadMilliseconds === 10_000).length,
    50,
  );
  assert.equal(D1NC_LOAD_DRAFT_RESERVATION_LEAD_MILLISECONDS, 5_000);
  assert.ok(
    warmupPlan.tasks.every((entry) => /^[a-f0-9]{32}$/.test(entry.leagueId)),
  );
  const exactPrepared = prepareD1ncDispatchBatch(
    plan.operations,
    startedAtMilliseconds + 1_000,
    warmupPlan.expectedScheduledStartAtMilliseconds,
  );
  assert.ok(exactPrepared.filter((entry) => entry.kind === 'draft')
    .every((entry) =>
      entry.scheduledAtMilliseconds === warmupPlan.expectedScheduledStartAtMilliseconds));
});

test('expected Cloud Task identities are bounded and drain checks ignore unrelated work', () => {
  const plan = buildD1ncLoadRunPlan({
    stage: 100,
    sourceRevision: revision,
    entropy,
    nonce,
    startedAtMilliseconds,
  });
  const expected = buildD1ncExpectedTaskIds(plan);
  assert.equal(expected.scoring.size, 55);
  assert.equal(expected.draft.size, 955);
  const scoringId = [...expected.scoring][0];
  const draftId = [...expected.draft][0];
  assert.equal(countRemainingD1ncTasks([
    `projects/example/locations/us-central1/queues/example/tasks/${scoringId}`,
    'projects/example/locations/us-central1/queues/example/tasks/unrelated',
  ], expected.scoring), 1);
  assert.equal(countRemainingD1ncTasks([
    `projects/example/locations/us-central1/queues/example/tasks/${draftId}`,
  ], expected.draft), 1);
});

test('probe payloads and runtime project identity fail closed', () => {
  assert.deepEqual(parseD1nLoadProbeTaskPayload(validPayload(), 'scoring'), validPayload());
  assert.equal(resolveD1nLoadRuntimeProjectId({ GCLOUD_PROJECT: D1NC_STAGING_PROJECT_ID }), D1NC_STAGING_PROJECT_ID);
  assert.equal(resolveD1nLoadRuntimeProjectId({ FIREBASE_CONFIG: JSON.stringify({ projectId: D1NC_STAGING_PROJECT_ID }) }), D1NC_STAGING_PROJECT_ID);
  assert.equal(resolveD1nLoadRuntimeProjectId({ FIREBASE_CONFIG: '{' }), 'unknown-project');
  assert.doesNotThrow(() => assertD1nLoadProbeRuntimeProject(D1NC_STAGING_PROJECT_ID));
  assert.throws(() => assertD1nLoadProbeRuntimeProject('nhl-fantasy-app-ab673'), /disabled outside/);
  assert.throws(() => parseD1nLoadProbeTaskPayload({ ...validPayload(), projectId: 'nhl-fantasy-app-ab673' }, 'scoring'));
  assert.throws(() => parseD1nLoadProbeTaskPayload({ ...validPayload(), kind: 'draft' }, 'scoring'));
  assert.throws(() => parseD1nLoadProbeTaskPayload({ ...validPayload(), nonce: 'weak' }, 'scoring'));
});

test('Draft probes reserve bounded worker capacity but execute only at the deadline', () => {
  assert.equal(
    d1nLoadProbeReservationDelayMilliseconds('draft', startedAtMilliseconds, startedAtMilliseconds - 5_000),
    5_000,
  );
  assert.equal(
    d1nLoadProbeReservationDelayMilliseconds('draft', startedAtMilliseconds, startedAtMilliseconds + 25),
    0,
  );
  assert.equal(
    d1nLoadProbeReservationDelayMilliseconds('scoring', startedAtMilliseconds, startedAtMilliseconds - 60_000),
    0,
  );
  assert.throws(
    () => d1nLoadProbeReservationDelayMilliseconds(
      'draft',
      startedAtMilliseconds,
      startedAtMilliseconds - 6_001,
    ),
    /bounded reservation window/,
  );
});

test('the scoring probe preserves exactly six games and distinguishes a legitimate zero', () => {
  const result = buildD1nLoadProbeResult('scoring', { ownedGamePoints: [1, 0, 2, 3, 4, 5] });
  assert.deepEqual(result.scoring, {
    ownedGameCount: 6,
    zeroPointGameCount: 1,
    aggregatePoints: 15,
  });
  assert.throws(() => buildD1nLoadProbeResult('scoring', { ownedGamePoints: [1, 2, 3, 4, 5] }), /exactly six/);
  assert.throws(() => buildD1nLoadProbeResult('scoring', { ownedGamePoints: [1, 2, 3, 4, 5, Number.NaN] }), /invalid/);
});

test('the Draft probe derives one deterministic result from bounded synthetic ordinals', () => {
  const result = buildD1nLoadProbeResult('draft', {
    expectedOverallPick: 12,
    selectedAssetOrdinal: 44,
  });
  assert.deepEqual(result.draft, { expectedOverallPick: 12, selectedAssetOrdinal: 44 });
  assert.match(result.resultFingerprint, /^[a-f0-9]{64}$/);
  assert.throws(() => buildD1nLoadProbeResult('draft', {
    expectedOverallPick: 0,
    selectedAssetOrdinal: 44,
  }), /positive/);
});

test('percentile and interval concurrency calculations remain conservative and deterministic', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(maximumIntervalConcurrency([
    { startedAtMilliseconds: 10, completedAtMilliseconds: 10 },
    { startedAtMilliseconds: 10, completedAtMilliseconds: 12 },
    { startedAtMilliseconds: 12, completedAtMilliseconds: 14 },
  ]), 2);
});

test('raw run evidence cannot pass until matching Monitoring and settled Billing evidence are finalized', () => {
  const plan = buildD1ncLoadRunPlan({
    stage: 100,
    sourceRevision: revision,
    entropy,
    nonce,
    startedAtMilliseconds,
  });
  const documents = completedDocuments(plan);
  const aggregate = summarizeD1ncLoadResults({
    stage: 100,
    sourceRevision: revision,
    runFingerprint: plan.runFingerprint,
    runStartedAtMilliseconds: startedAtMilliseconds,
    queueDrainStartedAtMilliseconds: startedAtMilliseconds + 1_000,
    queueDrainEligibleAtMilliseconds: startedAtMilliseconds + 185_000,
    runCompletedAtMilliseconds: startedAtMilliseconds + 185_125,
    operations: documents.operations,
    results: documents.results,
    peakOperationBacklog: 100,
    finalTaskQueueDepth: 0,
    draftQueueWarmupTaskCount: 900,
  });
  assert.equal(evaluateRampEvidence(aggregate).ready, false);
  assert.equal(aggregate.queue.producerMilliseconds, 1_000);
  const common = {
    schemaVersion: 1,
    projectId: D1NC_STAGING_PROJECT_ID,
    sourceRevision: revision,
    runFingerprint: plan.runFingerprint,
    windowStart: '2026-09-04T17:59:00Z',
    windowEnd: '2026-09-04T18:04:00Z',
  };
  const finalized = finalizeD1ncLoadEvidence(
    aggregate,
    {
      ...common,
      measurementSource: 'cloud-monitoring',
      observedAt: '2026-09-04T18:05:00Z',
      reads: 500,
      writes: 400,
      terminalAbortedOperations: 0,
    },
    {
      ...common,
      measurementSource: 'cloud-billing-export',
      settledAt: '2026-09-04T20:00:00Z',
      incrementalUsd: 0.25,
      currency: 'USD',
      settled: true,
    },
  );
  assert.equal(finalized.evidenceStatus, 'ready-for-independent-review');
  assert.equal(evaluateRampEvidence(finalized).ready, true);
  assert.throws(() => finalizeD1ncLoadEvidence(
    aggregate,
    { ...common, measurementSource: 'estimate', observedAt: '2026-09-04T18:05:00Z', reads: 1, writes: 1, terminalAbortedOperations: 0 },
    { ...common, measurementSource: 'cloud-billing-export', settledAt: '2026-09-04T20:00:00Z', incrementalUsd: 0.1, currency: 'USD', settled: true },
  ), /Cloud Monitoring/);
  assert.throws(() => finalizeD1ncLoadEvidence(
    aggregate,
    { ...common, measurementSource: 'cloud-monitoring', observedAt: '2026-09-04T18:00:00Z', reads: 1, writes: 1, terminalAbortedOperations: 0 },
    { ...common, measurementSource: 'cloud-billing-export', settledAt: '2026-09-04T20:00:00Z', incrementalUsd: 0.1, currency: 'USD', settled: true },
  ), /observed before/);
});

test('summary rejects missing operations, mismatched kinds, incomplete duplicate proof, and missing zero games', () => {
  const plan = buildD1ncLoadRunPlan({ stage: 100, sourceRevision: revision, entropy, nonce, startedAtMilliseconds });
  const documents = completedDocuments(plan);
  const input = {
    stage: 100,
    sourceRevision: revision,
    runFingerprint: plan.runFingerprint,
    runStartedAtMilliseconds: startedAtMilliseconds,
    queueDrainStartedAtMilliseconds: startedAtMilliseconds + 1_000,
    queueDrainEligibleAtMilliseconds: startedAtMilliseconds + 185_000,
    runCompletedAtMilliseconds: startedAtMilliseconds + 185_125,
    peakOperationBacklog: 100,
    finalTaskQueueDepth: 0,
    draftQueueWarmupTaskCount: 900,
  };
  assert.throws(() => summarizeD1ncLoadResults({ ...input, operations: documents.operations.slice(1), results: documents.results }), /operation count/);
  assert.throws(() => summarizeD1ncLoadResults({ ...input, finalTaskQueueDepth: 1, operations: documents.operations, results: documents.results }), /did not drain/);
  const wrongKind = structuredClone(documents.results);
  wrongKind[0].kind = 'draft';
  assert.throws(() => summarizeD1ncLoadResults({ ...input, operations: documents.operations, results: wrongKind }), /kind/);
  const wrongFingerprint = structuredClone(documents.results);
  wrongFingerprint[0].resultFingerprint = 'f'.repeat(64);
  assert.throws(() => summarizeD1ncLoadResults({ ...input, operations: documents.operations, results: wrongFingerprint }), /fingerprint/);
  const missingDuplicate = structuredClone(documents.operations);
  missingDuplicate.find((entry) => entry.duplicateDeliveryPlanned).duplicateDeliveryCount = 0;
  assert.throws(() => summarizeD1ncLoadResults({ ...input, operations: missingDuplicate, results: documents.results }), /duplicate-delivery proof/);
  const missingZero = structuredClone(documents.results);
  missingZero.find((entry) => entry.kind === 'scoring').scoring.zeroPointGameCount = 0;
  assert.throws(() => summarizeD1ncLoadResults({ ...input, operations: documents.operations, results: missingZero }), /zero-point/);
  assert.throws(() => summarizeD1ncLoadResults({
    ...input,
    queueDrainEligibleAtMilliseconds: input.runCompletedAtMilliseconds + 1,
    operations: documents.operations,
    results: documents.results,
  }), /timing window/);
});
