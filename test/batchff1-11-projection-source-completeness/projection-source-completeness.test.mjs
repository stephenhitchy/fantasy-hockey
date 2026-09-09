import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  IncompleteTeamScheduleInputError,
  assertCompleteTeamScheduleInput,
  hasCompleteTeamScheduleInputAttestation,
  requiresCompleteTeamScheduleInputForGeneration,
} from '../../functions/src/shared/core/projection/team-schedule-input-completeness.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('complete Draft schedule source input passes only with every expected team', () => {
  assert.doesNotThrow(() => assertCompleteTeamScheduleInput({
    season: '20262027',
    expectedTeamCount: 32,
    loadedTeamCount: 32,
    failedTeamCount: 0,
    requireCompleteInput: true,
  }));

  assert.throws(
    () => assertCompleteTeamScheduleInput({
      season: '20262027',
      expectedTeamCount: 32,
      loadedTeamCount: 31,
      failedTeamCount: 1,
      requireCompleteInput: true,
    }),
    (error) => {
      assert.ok(error instanceof IncompleteTeamScheduleInputError);
      assert.match(error.message, /31 of 32 team schedules available/);
      assert.match(error.message, /previous shared Projection V11 snapshot was preserved/);
      assert.match(error.message, /Retry after the NHL data service recovers/);
      return true;
    },
  );

  assert.throws(() => assertCompleteTeamScheduleInput({
    season: '20262027',
    expectedTeamCount: 32,
    loadedTeamCount: 31,
    failedTeamCount: 0,
    requireCompleteInput: true,
  }), IncompleteTeamScheduleInputError);
});

test('non-Draft projection paths retain their existing tolerant schedule fallback', () => {
  assert.doesNotThrow(() => assertCompleteTeamScheduleInput({
    season: '20262027',
    expectedTeamCount: 32,
    loadedTeamCount: 24,
    failedTeamCount: 8,
    requireCompleteInput: false,
  }));

  assert.equal(requiresCompleteTeamScheduleInputForGeneration('pre-draft'), true);
  assert.equal(
    requiresCompleteTeamScheduleInputForGeneration('draft-start-fallback'),
    true,
  );

  for (const reason of [
    'manual',
    'draft-setup',
    'cycle-refresh',
    'window-boundary',
    'server-emergency',
  ]) {
    assert.equal(requiresCompleteTeamScheduleInputForGeneration(reason), false);
  }
});

test('only a current complete attestation can satisfy Draft-opening readiness', () => {
  assert.equal(hasCompleteTeamScheduleInputAttestation({}), false);
  assert.equal(hasCompleteTeamScheduleInputAttestation({
    teamScheduleInputContractVersion: 1,
    teamScheduleInputCompleteness: 'not-required',
  }), false);
  assert.equal(hasCompleteTeamScheduleInputAttestation({
    teamScheduleInputContractVersion: 0,
    teamScheduleInputCompleteness: 'complete',
  }), false);
  assert.equal(hasCompleteTeamScheduleInputAttestation({
    teamScheduleInputContractVersion: 1,
    teamScheduleInputCompleteness: 'complete',
  }), true);
});

test('the NHL loader counts rejected team schedules and checks completeness before returning', async () => {
  const source = await read(
    'functions/src/shared/core/draft/draft-player-pool.service.ts',
  );
  const loaderStart = source.indexOf('async function loadTeamProjectionSchedules(');
  const loaderEnd = source.indexOf('function getTargetCycleGames(', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);

  assert.match(loader, /Promise\.allSettled/);
  assert.match(loader, /failedTeamCount \+= 1/);
  assert.match(loader, /assertCompleteTeamScheduleInput\(\{/);
  assert.match(loader, /expectedTeamCount: NHL_DRAFT_CLUBS\.length/);
  assert.ok(loader.indexOf('assertCompleteTeamScheduleInput') < loader.lastIndexOf('return schedules'));
});

test('only Draft-opening snapshot reasons require strict schedule completeness', async () => {
  const source = await read(
    'functions/src/shared/core/projection/projection-snapshot.service.ts',
  );
  const generationStart = source.indexOf('async function generateSnapshotInternal(');
  const generationEnd = source.indexOf('export async function generateSharedProjectionSnapshot(', generationStart);
  const generation = source.slice(generationStart, generationEnd);

  assert.match(
    generation,
    /const requireCompleteTeamScheduleInput =\s*requiresCompleteTeamScheduleInputForGeneration\(generationReason\)/,
  );
  assert.match(generation, /loadDraftPlayerPool\(\{[\s\S]*requireCompleteTeamScheduleInput,/);
  assert.ok(
    generation.indexOf('loadDraftPlayerPool') <
      generation.indexOf("status: 'ready'"),
    'the strict source check must run before ready metadata is published',
  );
  const failurePath = generation.slice(generation.indexOf('catch (error: unknown)'));
  assert.doesNotMatch(
    failurePath,
    /projectionSnapshots',\s*'current'/,
    'a failed strict generation must not replace the preceding current pointer',
  );
  assert.doesNotMatch(
    failurePath,
    /`target-cycle-\$\{targetCycleNumber\}`/,
    'a failed strict generation must not replace the preceding cycle pointer',
  );
  assert.match(generation, /catch \(error: unknown\)/);
  assert.match(generation, /status: 'error'/);
  assert.match(generation, /teamScheduleInputContractVersion/);
  assert.match(
    generation,
    /teamScheduleInputCompleteness:\s*requireCompleteTeamScheduleInput \? 'complete' : 'not-required'/,
  );
});

test('task failure remains visible and retryable without changing queue limits', async () => {
  const [authority, automation] = await Promise.all([
    read('functions/src/projection-authority.ts'),
    read('functions/src/draft-automation.ts'),
  ]);

  assert.match(authority, /const PROJECTION_TASK_MAX_CONCURRENT_DISPATCHES = 2/);
  assert.match(authority, /status: 'error'[\s\S]*lastError: message/);
  assert.match(automation, /serverDraftReadinessStatus: 'error'/);
  assert.match(automation, /serverDraftReadinessRetryAfterAt: nextRetryAt/);
  assert.match(
    automation,
    /Projection V11 preparation failed\. The clock remains locked and the server will retry automatically/,
  );
  assert.match(
    automation,
    /hasCompleteTeamScheduleInputAttestation\(snapshot\.metadata\)/,
  );
});

test('FF1.27 documentation defines staging proof, targeted release, and rollback', async () => {
  const [documentation, packageSource, roadmap, docsRoadmap] = await Promise.all([
    read('docs/RINKRAT_FF1_11_PROJECTION_SOURCE_COMPLETENESS.md'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
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
    'Projection V11',
    'Scoring V4',
    'six-game',
    'Game 7',
    '429',
    'timeout',
  ]) {
    assert.match(documentation, new RegExp(value, 'i'));
  }

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /FF1\.27 strict pre-Draft schedule-source completeness/);
  assert.match(
    packageJson.scripts['verify:batchff1-11:core'],
    /verify:batchff1-10:core/,
  );

  const deploymentSection = documentation.slice(
    documentation.indexOf('## Deployment resources'),
    documentation.indexOf('## Observability'),
  );
  const deploymentOrder = [
    'functions:executeDraftCommand',
    'functions:processDraftClockDeadline',
    'functions:runScheduledDraftAutomation',
    'functions:continueServerDraftAutomation',
    'functions:processProjectionGenerationTask',
    'hosting:app',
  ];
  let previousIndex = -1;
  for (const selector of deploymentOrder) {
    const selectorIndex = deploymentSection.indexOf(selector);
    assert.ok(selectorIndex > previousIndex, `${selector} must appear in safe deployment order`);
    previousIndex = selectorIndex;
  }
  assert.doesNotMatch(deploymentSection, /functions:processAutoDraftQueueChange/);
  assert.doesNotMatch(deploymentSection, /functions:reconcileDraftTurnAfterCommittedPick/);
});
