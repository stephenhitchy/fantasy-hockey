import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildD1ncAcknowledgement,
  D1NC_PRODUCTION_PROJECT_ID,
  D1NC_MIN_ROUTE_SAMPLES,
  D1NC_REQUIRED_FUNCTIONS,
  D1NC_REQUIRED_ROUTES,
  D1NC_STAGING_PROJECT_ID,
  evaluateRampEvidence,
  previousRampStage,
  validateBillingExportEvidence,
  validatePhysicalDeviceEvidence,
  validateRampRequest,
  validateStagingFunctions,
  validateStagingManifest,
} from '../../scripts/capacity/d1n-c-load-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');
const revision = 'a'.repeat(40);

function routeEvidence(overrides = {}) {
  return {
    sampleCount: D1NC_MIN_ROUTE_SAMPLES,
    coldSampleCount: 5,
    warmSampleCount: 10,
    reconnectSampleCount: 5,
    listenerErrorCount: 0,
    unknownDocumentCount: 0,
    awaitingFirstSnapshotCount: 0,
    cleanupFinalListenerCount: 0,
    pendingWriteSnapshotCount: 0,
    horizontalOverflow: false,
    ...overrides,
  };
}

function deviceProfile() {
  return {
    physical: true,
    reconnectSnapshotCount: 1,
    draftFocusPass: true,
    zoom200Pass: true,
    routes: Object.fromEntries(D1NC_REQUIRED_ROUTES.map((route) => [route, routeEvidence()])),
  };
}

function physicalEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: D1NC_STAGING_PROJECT_ID,
    sourceRevision: revision,
    profiles: {
      iphoneSafari: deviceProfile(),
      androidChrome: deviceProfile(),
      multiTab: {
        tabCount: 4,
        listenerErrorCount: 0,
        awaitingFirstSnapshotCount: 0,
        cleanupFinalListenerCount: 0,
        pendingWriteSnapshotCount: 0,
      },
    },
    ...overrides,
  };
}

function passingRamp(stage = 100) {
  return {
    schemaVersion: 1,
    projectId: D1NC_STAGING_PROJECT_ID,
    sourceRevision: revision,
    stage,
    operations: {
      requested: stage,
      completed: stage,
      terminalErrors: 0,
      duplicateCompetitiveResults: 0,
      retries: 0,
      recoveredContention: 0,
      scoring: { requested: stage / 2, completed: stage / 2 },
      draft: { requested: stage / 2, completed: stage / 2 },
    },
    latency: {
      scoringTaskMilliseconds: { p50: 1_000, p95: 10_000, p99: 15_000, max: 18_000 },
      draftDeadlineDriftMilliseconds: { p50: 100, p95: 500, p99: 1_000, max: 1_500 },
    },
    queue: {
      peakDepth: 20,
      finalDepth: 0,
      oldestAgeMilliseconds: { p50: 1_000, p95: 5_000, p99: 10_000, max: 12_000 },
      drainMilliseconds: 20_000,
    },
    functions: { maximumScoringConcurrency: 4, maximumDraftConcurrency: 10, coldStarts: 2 },
    firestore: { reads: 2_000, writes: 1_000, terminalAbortedOperations: 0 },
    cost: {
      incrementalUsd: 1,
      currency: 'USD',
      measurementSource: 'cloud-billing-export',
      settled: true,
      windowStart: '2026-09-03T18:00:00Z',
      windowEnd: '2026-09-03T18:10:00Z',
      settledAt: '2026-09-03T22:00:00Z',
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

test('source-only preflight passes without network or mutation', () => {
  const output = execFileSync(process.execPath, [
    'scripts/capacity/d1n-c-load-preflight.mjs',
    '--source-only',
  ], { cwd: root, encoding: 'utf8' });
  assert.match(output, /static source: PASS/);
  assert.match(output, /performed no network, Firebase, Git mutation, or staging data operation/);
});

test('the target gate refuses Production, wrong acknowledgements, and unapproved stages', () => {
  assert.equal(validateRampRequest({
    projectId: D1NC_STAGING_PROJECT_ID,
    stage: 100,
    acknowledgement: buildD1ncAcknowledgement(100),
  }).ready, true);
  assert.equal(validateRampRequest({
    projectId: D1NC_PRODUCTION_PROJECT_ID,
    stage: 100,
    acknowledgement: buildD1ncAcknowledgement(100),
  }).ready, false);
  assert.equal(validateRampRequest({
    projectId: D1NC_STAGING_PROJECT_ID,
    stage: 101,
    acknowledgement: buildD1ncAcknowledgement(101),
  }).ready, false);
  assert.equal(validateRampRequest({
    projectId: D1NC_STAGING_PROJECT_ID,
    stage: 100,
    acknowledgement: 'yes',
  }).ready, false);
});

test('ramp progression is strictly sequential', () => {
  assert.equal(previousRampStage(100), null);
  assert.equal(previousRampStage(500), 100);
  assert.equal(previousRampStage(2_000), 500);
  assert.equal(previousRampStage(5_000), 2_000);
});

test('staging manifest binds RC65, Scoring V4, Projection V11, and exact source', () => {
  const manifest = {
    schemaVersion: 1,
    releaseLabel: 'Release Candidate 65',
    sourceRevision: revision,
    scoringRulesVersion: 4,
    projectionVersion: 11,
  };
  assert.equal(validateStagingManifest(manifest, revision).ready, true);
  assert.equal(validateStagingManifest({ ...manifest, sourceRevision: 'b'.repeat(40) }, revision).ready, false);
  assert.equal(validateStagingManifest({ ...manifest, scoringRulesVersion: 5 }, revision).ready, false);
});

test('only both ACTIVE Node 22 staging workers satisfy readiness', () => {
  const active = D1NC_REQUIRED_FUNCTIONS.map((name) => ({
    name: `projects/p/locations/us-central1/functions/${name}`,
    state: 'ACTIVE',
    buildConfig: { runtime: 'nodejs22' },
  }));
  assert.equal(validateStagingFunctions(active).ready, true);
  assert.equal(validateStagingFunctions(active.slice(1)).ready, false);
  assert.equal(validateStagingFunctions(active.map((entry, index) =>
    index === 0 ? { ...entry, state: 'FAILED' } : entry)).ready, false);
  assert.equal(validateStagingFunctions(active.map((entry, index) =>
    index === 0 ? { ...entry, buildConfig: { runtime: 'nodejs20' } } : entry)).ready, false);
});

test('physical evidence requires both real phones, reconnect, route cleanup, and no pending writes', () => {
  assert.equal(validatePhysicalDeviceEvidence(physicalEvidence(), revision).ready, true);
  const pending = physicalEvidence();
  pending.profiles.androidChrome.routes.availablePlayers.pendingWriteSnapshotCount = 1;
  assert.equal(validatePhysicalDeviceEvidence(pending, revision).ready, false);
  const emulated = physicalEvidence();
  emulated.profiles.iphoneSafari.physical = false;
  assert.equal(validatePhysicalDeviceEvidence(emulated, revision).ready, false);
  const wrongRevision = physicalEvidence({ sourceRevision: 'b'.repeat(40) });
  assert.equal(validatePhysicalDeviceEvidence(wrongRevision, revision).ready, false);
  const incompleteProfiles = physicalEvidence();
  incompleteProfiles.profiles.iphoneSafari.routes.draft = routeEvidence({
    sampleCount: 20,
    coldSampleCount: 10,
    warmSampleCount: 10,
    reconnectSampleCount: 0,
  });
  assert.equal(validatePhysicalDeviceEvidence(incompleteProfiles, revision).ready, false);
  const weakenedTotal = physicalEvidence();
  weakenedTotal.profiles.androidChrome.routes.matchup = routeEvidence({
    sampleCount: 5,
    coldSampleCount: 1,
    warmSampleCount: 3,
    reconnectSampleCount: 1,
  });
  assert.equal(validatePhysicalDeviceEvidence(weakenedTotal, revision).ready, false);
});

test('billing export evidence must be settled, staging-filtered, revision-bound, and budgeted', () => {
  const evidence = {
    schemaVersion: 1,
    projectId: D1NC_STAGING_PROJECT_ID,
    sourceRevision: revision,
    measurementSource: 'cloud-billing-export',
    exportEnabled: true,
    firstExportObserved: true,
    stagingProjectFilterVerified: true,
    budgetAlertActive: true,
    currency: 'USD',
    observedAt: '2026-09-03T18:00:00Z',
  };
  assert.equal(validateBillingExportEvidence(evidence, revision).ready, true);
  assert.equal(validateBillingExportEvidence({ ...evidence, firstExportObserved: false }, revision).ready, false);
  assert.equal(validateBillingExportEvidence({ ...evidence, sourceRevision: 'b'.repeat(40) }, revision).ready, false);
  assert.equal(validateBillingExportEvidence({ ...evidence, stagingProjectFilterVerified: false }, revision).ready, false);
});

test('a complete bounded ramp passes every fixed integrity, latency, queue, usage, and cost gate', () => {
  assert.equal(evaluateRampEvidence(passingRamp(100)).ready, true);
  assert.equal(evaluateRampEvidence(passingRamp(500)).ready, true);
});

test('missing cost, duplicate results, slow tails, backlog, or excess concurrency fail closed', () => {
  const evidence = passingRamp(100);
  evidence.operations.duplicateCompetitiveResults = 1;
  evidence.latency.scoringTaskMilliseconds.p95 = 20_001;
  evidence.latency.draftDeadlineDriftMilliseconds.p99 = 5_001;
  evidence.queue.oldestAgeMilliseconds.p95 = 60_001;
  evidence.queue.finalDepth = 1;
  evidence.functions.maximumDraftConcurrency = 11;
  delete evidence.cost.incrementalUsd;
  const result = evaluateRampEvidence(evidence);
  assert.equal(result.ready, false);
  assert.match(result.issues.join('\n'), /duplicate competitive results/);
  assert.match(result.issues.join('\n'), /scoring p95/);
  assert.match(result.issues.join('\n'), /Draft deadline drift p99/);
  assert.match(result.issues.join('\n'), /queue age p95/);
  assert.match(result.issues.join('\n'), /backlog/);
  assert.match(result.issues.join('\n'), /concurrency/);
  assert.match(result.issues.join('\n'), /cost/);
});

test('empty or internally inconsistent telemetry cannot masquerade as a completed workload', () => {
  const evidence = passingRamp(100);
  evidence.latency.scoringTaskMilliseconds = { p50: 10, p95: 9, p99: 11, max: 12 };
  evidence.queue.peakDepth = 0;
  evidence.functions.maximumScoringConcurrency = 0;
  evidence.firestore.reads = 0;
  evidence.firestore.writes = 0;
  const result = evaluateRampEvidence(evidence);
  assert.equal(result.ready, false);
  assert.match(result.issues.join('\n'), /percentiles are not monotonic/);
  assert.match(result.issues.join('\n'), /work was enqueued/);
  assert.match(result.issues.join('\n'), /worker execution/);
  assert.match(result.issues.join('\n'), /workload activity/);
});

test('D1N-C-A contains no deployment, queue mutation, fixture write, or traffic generator', () => {
  const source = read('scripts/capacity/d1n-c-load-preflight.mjs');
  assert.doesNotMatch(source, /firebase\s+deploy|functions:delete|taskQueue\s*\(|getFirestore\s*\(|BulkWriter|queueMode\s*[:=]\s*['"](?:canary|primary)/);
  assert.match(source, /'functions', 'list', '--v2'/);
  assert.match(source, /'billing', 'projects', 'describe'/);
  assert.match(source, /'firestore', 'databases', 'describe'/);
  assert.match(source, /fetchManifest\(D1NC_STAGING_URL, git\.commit\)/);
  assert.doesNotMatch(source, /optionString\(options, 'url'/);
});

test('runbook defines acceptance, observability, exact staging resources, and rollback', () => {
  const runbook = read('docs/RINKRAT_SCALE_D1N_C_LOAD_PREFLIGHT.md');
  for (const phrase of [
    'No Production Firebase project may be a load target.',
    '100, 500, 2,000, and 5,000 operations',
    'physical Android Chrome',
    'processLeagueAutomationTask',
    'processDraftClockDeadline',
    'Cloud Billing export',
    'Rollback',
  ]) assert.match(runbook, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(runbook, /requires no Firebase deployment/);
});
