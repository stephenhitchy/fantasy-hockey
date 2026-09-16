import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildScheduledDraftQueueWarmupTaskId,
  DRAFT_QUEUE_WARMUP_LEAD_MILLISECONDS,
  DRAFT_START_TASK_ENQUEUE_DELAY_MILLISECONDS,
  DRAFT_START_TASK_WARMUP_LEAD_MILLISECONDS,
  getScheduledDraftQueueWarmupTaskDispatchMilliseconds,
  getScheduledDraftStartTaskDispatchMilliseconds,
} from '../../functions/src/draft-readiness.util.ts';
import {
  assertFf1ExactStartStagingSafety,
  buildPublicFf1ExactStartEvidence,
  FF1_EXACT_START_STAGING_ACKNOWLEDGEMENT,
} from '../../scripts/capacity/run-ff1-draft-exact-start-staging-evidence.mjs';
import { D1N_STAGING_PROJECT_ID } from '../../scripts/capacity/prepare-d1n-staging-hosting.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('write-free queue warmups precede an exact-zero authoritative start task', () => {
  const start = Date.parse('2026-10-06T02:00:00.000Z');
  const now = start - 15 * 60 * 1000;

  assert.deepEqual(
    DRAFT_QUEUE_WARMUP_LEAD_MILLISECONDS,
    Array.from({ length: 18 }, (_, index) => 180_000 - index * 10_000),
  );
  assert.equal(DRAFT_START_TASK_WARMUP_LEAD_MILLISECONDS, 10_000);
  assert.equal(DRAFT_START_TASK_ENQUEUE_DELAY_MILLISECONDS, 250);
  assert.equal(
    getScheduledDraftStartTaskDispatchMilliseconds({
      scheduledStartMilliseconds: start,
      nowMilliseconds: now,
    }),
    start,
  );
  assert.equal(
    getScheduledDraftQueueWarmupTaskDispatchMilliseconds({
      scheduledStartMilliseconds: start,
      nowMilliseconds: now,
      warmupLeadMilliseconds: 60_000,
    }),
    start - 60_000,
  );
  assert.equal(
    getScheduledDraftQueueWarmupTaskDispatchMilliseconds({
      scheduledStartMilliseconds: start,
      nowMilliseconds: now,
      warmupLeadMilliseconds: 10_000,
    }),
    start - 10_000,
  );
  const warmupId = buildScheduledDraftQueueWarmupTaskId({
    leagueId: 'league-1',
    scheduledStartMilliseconds: start,
    warmupLeadMilliseconds: 60_000,
  });
  assert.match(warmupId, /^[a-f0-9]{40}$/);
  assert.notEqual(warmupId, buildScheduledDraftQueueWarmupTaskId({
    leagueId: 'league-1',
    scheduledStartMilliseconds: start,
    warmupLeadMilliseconds: 10_000,
  }));
});

test('late scheduling skips elapsed warmups and malformed timing fails closed', () => {
  const start = Date.parse('2026-10-06T02:00:00.000Z');

  assert.equal(
    getScheduledDraftStartTaskDispatchMilliseconds({
      scheduledStartMilliseconds: start,
      nowMilliseconds: start - 4_000,
    }),
    start,
  );
  assert.equal(
    getScheduledDraftStartTaskDispatchMilliseconds({
      scheduledStartMilliseconds: start,
      nowMilliseconds: start + 2_000,
    }),
    start + 2_250,
  );
  assert.equal(
    getScheduledDraftStartTaskDispatchMilliseconds({
      scheduledStartMilliseconds: Number.NaN,
      nowMilliseconds: start,
    }),
    null,
  );
  assert.equal(
    getScheduledDraftQueueWarmupTaskDispatchMilliseconds({
      scheduledStartMilliseconds: start,
      nowMilliseconds: start - 4_000,
      warmupLeadMilliseconds: 10_000,
    }),
    null,
  );
  assert.equal(
    getScheduledDraftQueueWarmupTaskDispatchMilliseconds({
      scheduledStartMilliseconds: start,
      nowMilliseconds: start - 45_000,
      warmupLeadMilliseconds: 30_000,
    }),
    start - 30_000,
  );
  assert.equal(
    getScheduledDraftQueueWarmupTaskDispatchMilliseconds({
      scheduledStartMilliseconds: start,
      nowMilliseconds: start - 45_000,
      warmupLeadMilliseconds: 25_000,
    }),
    null,
  );
});

test('warm task waits for zero, rereads authority, and never opens early', async () => {
  const source = await read('functions/src/draft-automation.ts');
  const handlerIndex = source.indexOf('async function processScheduledDraftStartTask(');
  const handlerEnd = source.indexOf('export const processDraftClockDeadline', handlerIndex);
  const handler = source.slice(handlerIndex, handlerEnd);
  const waitIndex = handler.indexOf('await sleep(Math.max(millisecondsUntilStart, 1))');
  const rereadIndex = handler.indexOf('draftSnapshot = await draftRef.get()', waitIndex);
  const stateIndex = handler.indexOf('taskState = getScheduledDraftStartTaskState(', rereadIndex);
  const openIndex = handler.indexOf('await openScheduledDraftIfReady(leagueId)', stateIndex);

  assert.ok(handlerIndex > 0);
  assert.ok(handlerEnd > handlerIndex);
  assert.ok(waitIndex > 0);
  assert.ok(rereadIndex > waitIndex);
  assert.ok(stateIndex > rereadIndex);
  assert.ok(openIndex > stateIndex);
  assert.match(handler, /outside its bounded warmup window/);
  assert.match(handler, /taskState === 'stale'/);
  assert.match(handler, /timer returned early/);
});

test('queue warmups preserve start identity, retry, rate, and worker limits', async () => {
  const source = await read('functions/src/draft-automation.ts');
  const scheduleIndex = source.indexOf('async function scheduleScheduledDraftStartTask(');
  const scheduleEnd = source.indexOf('function isTaskAlreadyExistsError', scheduleIndex);
  const schedule = source.slice(scheduleIndex, scheduleEnd);
  const functionIndex = source.indexOf('export const processDraftClockDeadline');
  const functionBody = source.slice(functionIndex, source.indexOf('\n);', functionIndex) + 3);

  assert.match(schedule, /buildScheduledDraftStartTaskId/);
  assert.match(schedule, /buildScheduledDraftQueueWarmupTaskId/);
  assert.match(schedule, /getScheduledDraftStartTaskDispatchMilliseconds/);
  assert.match(schedule, /getScheduledDraftQueueWarmupTaskDispatchMilliseconds/);
  assert.match(schedule, /taskDispatchAt/);
  assert.match(schedule, /warmupLeadMilliseconds/);
  assert.match(schedule, /warmupDispatchMilliseconds === null[\s\S]*continue/);
  assert.match(source, /taskType === 'queue-warmup'/);
  assert.match(source, /Draft queue warmup task completed/);
  const warmupHandlerIndex = source.indexOf('function processDraftQueueWarmupTask(');
  const warmupHandlerEnd = source.indexOf(
    'async function processScheduledDraftStartTask(',
    warmupHandlerIndex,
  );
  const warmupHandler = source.slice(warmupHandlerIndex, warmupHandlerEnd);
  assert.ok(warmupHandlerIndex > 0);
  assert.ok(warmupHandlerEnd > warmupHandlerIndex);
  assert.doesNotMatch(warmupHandler, /\bdb\.|runTransaction|\.set\(|\.update\(|sleep\(|openScheduledDraft/);
  assert.match(functionBody, /timeoutSeconds: 120/);
  assert.match(functionBody, /maxAttempts: 5/);
  assert.match(functionBody, /maxConcurrentDispatches: 10/);
  assert.doesNotMatch(functionBody, /minInstances/);
});

test('exact-start staging runner refuses the wrong project, acknowledgement, and timing', () => {
  const validEnvironment = {
    FF1_EXACT_START_STAGING_PROJECT_ID: D1N_STAGING_PROJECT_ID,
    FF1_EXACT_START_STAGING_ACK: FF1_EXACT_START_STAGING_ACKNOWLEDGEMENT,
  };

  assert.deepEqual(assertFf1ExactStartStagingSafety(validEnvironment), {
    startOffsetMilliseconds: 25 * 60 * 1000,
    timeoutMilliseconds: 35 * 60 * 1000,
  });
  assert.throws(
    () =>
      assertFf1ExactStartStagingSafety({
        ...validEnvironment,
        FF1_EXACT_START_STAGING_PROJECT_ID: 'nhl-fantasy-app-ab673',
      }),
    /must equal rinkrat-staging-d1nc-2026/,
  );
  assert.throws(
    () =>
      assertFf1ExactStartStagingSafety({
        ...validEnvironment,
        FF1_EXACT_START_STAGING_ACK: 'wrong',
      }),
    /does not authorize/,
  );
  assert.throws(
    () =>
      assertFf1ExactStartStagingSafety({
        ...validEnvironment,
        FF1_EXACT_START_OFFSET_MILLISECONDS: '60000',
      }),
    /must be an integer/,
  );
});

test('exact-start staging evidence remains aggregate and bounded', () => {
  assert.deepEqual(
    buildPublicFf1ExactStartEvidence({
      releaseManifestMatched: true,
      readyBeforeStart: true,
      readinessLeadMilliseconds: 1_000_000,
      authoritativeStartLatencyMilliseconds: 3_200,
      firstClockLatencyMilliseconds: 3_200,
      clockStatus: 'running',
      nextOverallPick: 1,
      pickCount: 0,
      withinFiveSecondGate: true,
      accountId: 'private-account',
      rosterId: 'private-roster',
    }),
    {
      projectId: D1N_STAGING_PROJECT_ID,
      leagueLabel: 'd1n-capacity-fixture',
      releaseManifestMatched: true,
      readyBeforeStart: true,
      readinessLeadMilliseconds: 1_000_000,
      authoritativeStartLatencyMilliseconds: 3_200,
      firstClockLatencyMilliseconds: 3_200,
      clockStatus: 'running',
      nextOverallPick: 1,
      pickCount: 0,
      withinFiveSecondGate: true,
      safeResetDays: 7,
    },
  );
});

test('FF1.25 documents the failed staging gate and narrow rollback boundary', async () => {
  const [documentation, packageSource, roadmap, docsRoadmap] = await Promise.all([
    read('docs/RINKRAT_FF1_9_DRAFT_START_WARMUP.md'),
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
    'Production Scoring V4',
    'Projection V11',
    'six-game',
    'Game 7',
    'exact-once',
  ]) {
    assert.match(documentation, new RegExp(value, 'i'));
  }

  assert.equal(roadmap, docsRoadmap);
  assert.match(roadmap, /FF1\.25 bounded Draft-start warmup/);
  assert.match(packageJson.scripts['verify:batchff1-9:core'], /verify:batchff1-8:core/);

  const deploymentSection = documentation.slice(
    documentation.indexOf('## Deployment resources'),
    documentation.indexOf('## Rollback'),
  );
  assert.ok(
    deploymentSection.indexOf('functions:processDraftClockDeadline') <
      deploymentSection.indexOf('functions:runScheduledDraftAutomation'),
  );
  assert.ok(
    deploymentSection.indexOf('functions:processDraftClockDeadline') <
      deploymentSection.indexOf('functions:continueServerDraftAutomation'),
  );
  assert.match(deploymentSection, /\.d1n-staging\.firebase\.json/);
  assert.doesNotMatch(deploymentSection, /hosting:app/);
});
