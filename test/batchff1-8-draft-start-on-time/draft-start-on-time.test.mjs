import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildScheduledDraftStartTaskId,
  getScheduledDraftStartTaskState,
} from '../../functions/src/draft-readiness.util.ts';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('scheduled Draft-start task identity is deterministic and changes on reschedule', () => {
  const input = {
    leagueId: 'league-1',
    scheduledStartMilliseconds: Date.parse('2026-10-06T02:00:00.000Z'),
  };
  const first = buildScheduledDraftStartTaskId(input);

  assert.match(first, /^[a-f0-9]{40}$/);
  assert.equal(first, buildScheduledDraftStartTaskId(input));
  assert.notEqual(first, buildScheduledDraftStartTaskId({
    ...input,
    scheduledStartMilliseconds: input.scheduledStartMilliseconds + 60_000,
  }));
  assert.notEqual(first, buildScheduledDraftStartTaskId({
    ...input,
    leagueId: 'league-2',
  }));
});

test('scheduled Draft-start delivery opens only the exact current schedule at zero', () => {
  const start = Date.parse('2026-10-06T02:00:00.000Z');
  const base = {
    draftStatus: 'scheduled',
    expectedScheduledStartMilliseconds: start,
    actualScheduledStartMilliseconds: start,
  };

  assert.equal(getScheduledDraftStartTaskState({
    ...base,
    nowMilliseconds: start - 101,
  }), 'early');
  assert.equal(getScheduledDraftStartTaskState({
    ...base,
    nowMilliseconds: start - 100,
  }), 'open');
  assert.equal(getScheduledDraftStartTaskState({
    ...base,
    nowMilliseconds: start,
  }), 'open');
  assert.equal(getScheduledDraftStartTaskState({
    ...base,
    actualScheduledStartMilliseconds: start + 1,
    nowMilliseconds: start,
  }), 'stale');
  assert.equal(getScheduledDraftStartTaskState({
    ...base,
    draftStatus: 'live',
    nowMilliseconds: start,
  }), 'stale');
});

test('server schedules one exact start task before readiness work and retains the minute fallback', async () => {
  const source = await read('functions/src/draft-automation.ts');
  const scheduledBranch = source.indexOf("if (draft.status === 'scheduled')");
  const taskIndex = source.indexOf('await scheduleScheduledDraftStartTask(', scheduledBranch);
  const readinessIndex = source.indexOf('await prepareScheduledDraftReadiness(leagueId, draft)', taskIndex);

  assert.ok(scheduledBranch > 0);
  assert.ok(taskIndex > scheduledBranch);
  assert.ok(readinessIndex > taskIndex);
  assert.match(source, /taskType: 'scheduled-start'/);
  assert.match(source, /buildScheduledDraftStartTaskId/);
  assert.match(source, /getScheduledDraftStartTaskDispatchMilliseconds/);
  assert.match(source, /isTaskAlreadyExistsError\(error\)[\s\S]*?return 'scheduled'/);
  assert.match(source, /schedule: '\* \* \* \* \*'/);
  assert.match(source, /maxInstances: 1/);
});

test('exact task opens verified readiness directly and then schedules pick one', async () => {
  const source = await read('functions/src/draft-automation.ts');
  const handlerIndex = source.indexOf('async function processScheduledDraftStartTask(');
  const directOpenIndex = source.indexOf('await openScheduledDraftIfReady(leagueId)', handlerIndex);
  const fallbackIndex = source.indexOf('await processLeagueDraftAutomation(leagueId)', directOpenIndex);
  const deadlineIndex = source.indexOf('await ensureCurrentDraftClockTask(leagueId)', directOpenIndex);

  assert.ok(handlerIndex > 0);
  assert.ok(directOpenIndex > handlerIndex);
  assert.ok(deadlineIndex > directOpenIndex);
  assert.ok(fallbackIndex > directOpenIndex);
  assert.match(source, /getScheduledDraftStartTaskState/);
  assert.match(source, /Ignored stale scheduled Draft-start task/);
  assert.match(source, /reached zero before server readiness completed[\s\S]*?Retrying/);
  assert.match(source, /retryConfig: \{[\s\S]*?maxAttempts: 5/);
  assert.match(source, /rateLimits: \{[\s\S]*?maxConcurrentDispatches: 10/);
});

test('schedule changes wake server preparation without recursive readiness triggers', async () => {
  const source = await read('functions/src/draft-automation.ts');
  const triggerIndex = source.indexOf('export const continueServerDraftAutomation');
  const trigger = source.slice(triggerIndex);

  assert.match(trigger, /scheduledStartChanged/);
  assert.match(
    trigger,
    /getScheduledStartMilliseconds\(before\) !== getScheduledStartMilliseconds\(after\)/,
  );
  assert.match(trigger, /if \(!scheduledStartChanged && !liveProgress\)/);
  assert.match(trigger, /if \(scheduledStartChanged\) \{\s*return;/);
});

test('browsers no longer perform long Draft preparation before requesting server activation', async () => {
  const [draftRoom, leagueDetail] = await Promise.all([
    read('src/app/features/draft/draft-room/draft-room.ts'),
    read('src/app/features/leagues/league-detail/league-detail.ts'),
  ]);

  for (const source of [draftRoom, leagueDetail]) {
    assert.doesNotMatch(source, /prepareDraftData\(/);
    assert.doesNotMatch(source, /draft-start-fallback/);
    assert.doesNotMatch(source, /generateSharedProjectionSnapshot/);
    assert.doesNotMatch(source, /maybeWarmPreDraftProjections/);
    assert.match(
      source,
      /serverDraftReadinessStatus !== 'ready'[\s\S]*?activateScheduledDraftIfReady/,
    );
  }
});

test('FF1.24 documentation defines acceptance, observability, deployment, and rollback', async () => {
  const [documentation, packageSource, roadmap, docsRoadmap] = await Promise.all([
    read('docs/RINKRAT_FF1_8_DRAFT_START_ON_TIME.md'),
    read('package.json'),
    read('RINKRAT_COMPETITIVE_ROADMAP.txt'),
    read('docs/RINKRAT_COMPETITIVE_ROADMAP.txt'),
  ]);
  const packageJson = JSON.parse(packageSource);

  for (const value of [
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
  assert.match(roadmap, /FF1\.24 exact scheduled Draft start/);
  assert.match(packageJson.scripts['verify:batchff1-8:core'], /verify:batchff1-7:core/);
});
