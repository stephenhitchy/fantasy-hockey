import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  shouldPauseLeagueAutomationForHistoricalReplay,
} from '../../functions/src/shared/core/live-scoring/historical-replay-lease-guard.util.ts';
import { PROTECTED_SOURCE_HASHES } from '../shared/protected-source-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testProjectId = 'demo-rinkrat-ff1-17';
const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const requireFunctions = createRequire(
  new URL('../../functions/package.json', import.meta.url),
);

process.env.GCLOUD_PROJECT = testProjectId;
process.env.GOOGLE_CLOUD_PROJECT = testProjectId;

const {
  beginLeagueAutomationTask,
  claimLeagueAutomationLeaseInTransaction,
  isLeagueAutomationTaskCompletionEligible,
  parkLeagueAutomationScheduleForHistoricalReplayInTransaction,
  preserveReplayPauseOrRecordEnqueueFailure,
  preserveReplayPauseOrMarkTaskRetrying,
  recoverStaleLeagueAutomationTask,
  writeHistoricalReplayControlAndParkSchedule,
  writeLeagueAutomationTaskCompletionInTransaction,
  writeLeagueAutomationScheduleOutcome,
} = requireFunctions(
  path.join(
    root,
    'functions/lib/shared/core/live-scoring/historical-replay-lease-write.service.js',
  ),
);
const { deleteApp, initializeApp } = requireFunctions('firebase-admin/app');
const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore');

let adminApp;
let firestore;

before(() => {
  assert.ok(
    firestoreEmulatorHost,
    'FF1.33 authority tests must run inside the Firestore emulator.',
  );
  adminApp = initializeApp(
    { projectId: testProjectId },
    `ff1-17-${randomUUID()}`,
  );
  firestore = getFirestore(adminApp);
});

after(async () => {
  if (adminApp) {
    await deleteApp(adminApp);
  }
});

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function sha256(relativePath) {
  return createHash('sha256')
    .update(await readFile(path.join(root, relativePath)))
    .digest('hex');
}

function refsFor(leagueId) {
  return {
    controlRef: firestore.doc(`leagues/${leagueId}/liveScoring/control`),
    replayControlRef: firestore.doc(
      `leagues/${leagueId}/historicalReplay/control`,
    ),
    scheduleRef: firestore.doc(`leagueAutomationSchedules/${leagueId}`),
  };
}

function claimInput(transaction, leagueId, trigger, force = true) {
  return {
    transaction,
    ...refsFor(leagueId),
    leagueId,
    scheduleShard: 3,
    scheduleSchemaVersion: 1,
    workerId: `server:test-${leagueId}`,
    serverWorkerPrefix: 'server:',
    trigger,
    force,
    nowMilliseconds: Date.parse('2026-10-06T01:00:00.000Z'),
    leaseMilliseconds: 9 * 60 * 1000,
  };
}

async function claimLease(leagueId, trigger, force = true) {
  return firestore.runTransaction((transaction) =>
    claimLeagueAutomationLeaseInTransaction(
      claimInput(transaction, leagueId, trigger, force),
    ),
  );
}

function taskStartInput(leagueId, taskId, expectedDueAtMilliseconds) {
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  return {
    replayControlRef,
    scheduleRef,
    taskRef: firestore.doc(`leagueAutomationTasks/${taskId}`),
    taskId,
    leagueId,
    scheduleShard: 3,
    scheduleSchemaVersion: 1,
    expectedDueAtMilliseconds,
    expectedCanonicalSourceVersion: '',
    nowMilliseconds: Date.parse('2026-10-06T01:00:00.000Z'),
    processingLeaseMilliseconds: 12 * 60 * 1000,
    taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
  };
}

test('every non-replay trigger fails closed while Historical Replay owns scoring', () => {
  const activeReplay = {
    enabled: true,
    status: 'ready',
    simulatedDate: '2026-09-29',
  };

  for (const trigger of [
    'scheduled',
    'queue-task',
    'draft-complete',
    'season-start',
    'manual',
  ]) {
    assert.equal(
      shouldPauseLeagueAutomationForHistoricalReplay(activeReplay, trigger),
      true,
      trigger,
    );
  }
});

test('every enabled replay state is protected even without a simulated date', () => {
  for (const status of ['inactive', 'queued', 'advancing', 'ready', 'error', 'malformed']) {
    assert.equal(
      shouldPauseLeagueAutomationForHistoricalReplay(
        { enabled: true, status, simulatedDate: null },
        'draft-complete',
      ),
      true,
      status,
    );
  }
});

test('missing, disabled, or malformed replay authority does not block live automation', () => {
  for (const replay of [
    undefined,
    {},
    { enabled: false, status: 'advancing', simulatedDate: '2026-09-29' },
    { enabled: 'true', status: 'advancing', simulatedDate: '2026-09-29' },
  ]) {
    assert.equal(
      shouldPauseLeagueAutomationForHistoricalReplay(replay, 'draft-complete'),
      false,
    );
  }
});

test('the serialized Historical Replay worker remains eligible for its own lease', () => {
  for (const replay of [
    { enabled: true, status: 'queued', simulatedDate: null },
    { enabled: true, status: 'advancing', simulatedDate: '2026-09-29' },
    { enabled: true, status: 'ready', simulatedDate: '2026-09-29' },
  ]) {
    assert.equal(
      shouldPauseLeagueAutomationForHistoricalReplay(replay, 'historical-replay'),
      false,
    );
  }
});

test('enabled replay atomically blocks every forced live trigger and parks its task', async () => {
  for (const trigger of [
    'scheduled',
    'queue-task',
    'draft-complete',
    'season-start',
    'manual',
  ]) {
    const leagueId = `ff133-block-${trigger}`;
    const { controlRef, replayControlRef, scheduleRef } = refsFor(leagueId);
    await Promise.all([
      controlRef.set({
        status: 'idle',
        holderClientId: null,
        nextRefreshAt: Timestamp.fromMillis(0),
      }),
      replayControlRef.set({
        enabled: true,
        status: 'error',
        simulatedDate: null,
      }),
      scheduleRef.set({
        scoringEnabled: true,
        queueStatus: 'processing',
        activeTaskId: 'late-task',
        activeTaskDueAt: Timestamp.fromMillis(1),
        activeTaskCanonicalSourceVersion: 'stale-source',
        activeTaskCanonicalGameIds: [1],
        activeTaskCanonicalGameVersions: [{ gameId: 1 }],
        activeTaskLeaseExpiresAt: Timestamp.fromMillis(2),
        nextScoringAt: Timestamp.fromMillis(3),
      }),
    ]);

    assert.deepEqual(await claimLease(leagueId, trigger, true), {
      claimed: false,
      reason: 'historical-replay',
    });

    const [control, schedule] = await Promise.all([
      controlRef.get(),
      scheduleRef.get(),
    ]);
    assert.equal(control.get('status'), 'idle', trigger);
    assert.equal(control.get('holderClientId'), null, trigger);
    assert.equal(schedule.get('scoringEnabled'), false, trigger);
    assert.equal(schedule.get('queueStatus'), 'paused', trigger);
    assert.equal(schedule.get('pausedReason'), 'historical-replay', trigger);
    assert.equal(schedule.get('activeTaskId'), null, trigger);
    assert.equal(schedule.get('activeTaskDueAt'), undefined, trigger);
    assert.equal(schedule.get('activeTaskCanonicalSourceVersion'), undefined, trigger);
    assert.deepEqual(schedule.get('activeTaskCanonicalGameIds'), [], trigger);
    assert.deepEqual(schedule.get('activeTaskCanonicalGameVersions'), [], trigger);
    assert.equal(schedule.get('activeTaskLeaseExpiresAt'), undefined, trigger);
    assert.equal(schedule.get('nextScoringAt'), undefined, trigger);

    const cyclePath = `leagues/${leagueId}/cycles/cycle-1`;
    const [cycle, matchups, teamWindows, scoringSnapshot] = await Promise.all([
      firestore.doc(cyclePath).get(),
      firestore.collection(`${cyclePath}/matchups`).get(),
      firestore.collection(`${cyclePath}/teamWindows`).get(),
      firestore.doc(`leagues/${leagueId}/liveScoring/cycle-1`).get(),
    ]);
    assert.equal(cycle.exists, false, `${trigger}:cycle-1`);
    assert.equal(matchups.empty, true, `${trigger}:cycle-1/matchups`);
    assert.equal(teamWindows.empty, true, `${trigger}:cycle-1/teamWindows`);
    assert.equal(scoringSnapshot.exists, false, `${trigger}:liveScoring/cycle-1`);
  }
});

test('explicit replay remains eligible while disabled replay preserves live behavior', async () => {
  const explicitLeagueId = 'ff133-explicit-replay';
  const explicitRefs = refsFor(explicitLeagueId);
  await explicitRefs.replayControlRef.set({ enabled: true, status: 'advancing' });

  assert.deepEqual(
    await claimLease(explicitLeagueId, 'historical-replay', true),
    { claimed: true, reason: 'claimed' },
  );
  assert.equal((await explicitRefs.controlRef.get()).get('serverTrigger'), 'historical-replay');

  const disabledLeagueId = 'ff133-disabled-replay';
  const disabledRefs = refsFor(disabledLeagueId);
  await disabledRefs.replayControlRef.set({ enabled: false, status: 'ready' });

  assert.deepEqual(await claimLease(disabledLeagueId, 'draft-complete', true), {
    claimed: true,
    reason: 'claimed',
  });
  assert.equal((await disabledRefs.controlRef.get()).get('serverTrigger'), 'draft-complete');
});

test('explicit replay success, error, and skip outcomes keep recurring scoring parked', async () => {
  for (const outcome of ['success', 'error', 'skipped']) {
    const leagueId = `ff133-replay-outcome-${outcome}`;
    const { replayControlRef, scheduleRef } = refsFor(leagueId);
    await scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'processing',
      pausedReason: '',
      nextScoringAt: Timestamp.fromMillis(123),
      activeTaskId: 'stale-task',
      activeTaskDueAt: Timestamp.fromMillis(124),
      activeTaskLeaseExpiresAt: Timestamp.fromMillis(125),
    });

    await writeLeagueAutomationScheduleOutcome({
      scheduleRef,
      replayControlRef,
      data: {
        scoringEnabled: true,
        queueStatus: outcome === 'success' ? 'idle' : outcome,
        pausedReason: '',
        nextScoringAt: Timestamp.fromMillis(456),
        lastOutcome: outcome,
      },
      trigger: 'historical-replay',
    });

    const schedule = await scheduleRef.get();
    assert.equal(schedule.get('scoringEnabled'), false, outcome);
    assert.equal(schedule.get('queueStatus'), 'paused', outcome);
    assert.equal(schedule.get('pausedReason'), 'historical-replay', outcome);
    assert.equal(schedule.get('nextScoringAt'), undefined, outcome);
    assert.equal(schedule.get('activeTaskId'), null, outcome);
    assert.equal(schedule.get('activeTaskDueAt'), undefined, outcome);
    assert.equal(schedule.get('activeTaskLeaseExpiresAt'), undefined, outcome);
    assert.equal(schedule.get('lastOutcome'), outcome, outcome);
  }
});

test('a late ordinary outcome cannot re-enable scoring after replay activation', async () => {
  for (const outcome of ['success', 'error', 'skipped']) {
    const leagueId = `ff133-late-outcome-${outcome}`;
    const { replayControlRef, scheduleRef } = refsFor(leagueId);
    await Promise.all([
      replayControlRef.set({ enabled: true, status: 'ready' }),
      scheduleRef.set({
        scoringEnabled: true,
        queueStatus: 'processing',
        pausedReason: '',
        activeTaskId: `late-${outcome}`,
        activeTaskDueAt: Timestamp.fromMillis(123),
        activeTaskLeaseExpiresAt: Timestamp.fromMillis(124),
        nextScoringAt: Timestamp.fromMillis(125),
      }),
    ]);

    await writeLeagueAutomationScheduleOutcome({
      scheduleRef,
      replayControlRef,
      data: {
        scoringEnabled: true,
        queueStatus: outcome === 'success' ? 'idle' : outcome,
        pausedReason: '',
        nextScoringAt: Timestamp.fromMillis(456),
        lastOutcome: outcome,
      },
      trigger: 'queue-task',
    });

    const schedule = await scheduleRef.get();
    assert.equal(schedule.get('scoringEnabled'), false, outcome);
    assert.equal(schedule.get('queueStatus'), 'paused', outcome);
    assert.equal(schedule.get('pausedReason'), 'historical-replay', outcome);
    assert.equal(schedule.get('nextScoringAt'), undefined, outcome);
    assert.equal(schedule.get('activeTaskId'), null, outcome);
    assert.equal(schedule.get('activeTaskDueAt'), undefined, outcome);
    assert.equal(schedule.get('activeTaskLeaseExpiresAt'), undefined, outcome);
  }
});

test('replay control reassertion and schedule parking commit as one authority transition', async () => {
  const leagueId = 'ff133-atomic-replay-control-write';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  await scheduleRef.set({
    scoringEnabled: true,
    queueStatus: 'processing',
    activeTaskId: 'ff133-old-task',
    activeTaskLeaseExpiresAt: Timestamp.fromMillis(2),
    nextScoringAt: Timestamp.fromMillis(3),
  });

  await writeHistoricalReplayControlAndParkSchedule({
    controlRef: replayControlRef,
    scheduleRef,
    leagueId,
    scheduleShard: 3,
    scheduleSchemaVersion: 1,
    controlData: {
      enabled: false,
      status: 'advancing',
      activeRequestId: 'ff133-request',
    },
  });

  const [control, schedule] = await Promise.all([
    replayControlRef.get(),
    scheduleRef.get(),
  ]);
  assert.equal(control.get('enabled'), true);
  assert.equal(control.get('status'), 'advancing');
  assert.equal(control.get('activeRequestId'), 'ff133-request');
  assert.equal(schedule.get('scoringEnabled'), false);
  assert.equal(schedule.get('queueStatus'), 'paused');
  assert.equal(schedule.get('pausedReason'), 'historical-replay');
  assert.equal(schedule.get('activeTaskId'), null);
  assert.equal(schedule.get('nextScoringAt'), undefined);
});

test('completed and replay-skipped task redelivery preserves terminal evidence', async () => {
  const expectedDueAtMilliseconds = Date.parse('2026-10-06T00:59:00.000Z');

  const completedLeagueId = 'ff133-completed-redelivery';
  const completedTaskId = 'ff133-completed-task';
  const completedInput = taskStartInput(
    completedLeagueId,
    completedTaskId,
    expectedDueAtMilliseconds,
  );
  await Promise.all([
    completedInput.replayControlRef.set({ enabled: false }),
    completedInput.scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'idle',
      activeTaskId: null,
    }),
    completedInput.taskRef.set({
      status: 'completed',
      durationMilliseconds: 321,
    }),
  ]);

  assert.deepEqual(await beginLeagueAutomationTask(completedInput), {
    started: false,
    reason: 'terminal-task',
  });
  const completedTask = await completedInput.taskRef.get();
  assert.equal(completedTask.get('status'), 'completed');
  assert.equal(completedTask.get('durationMilliseconds'), 321);
  assert.equal(completedTask.get('skipReason'), undefined);
  assert.equal((await completedInput.scheduleRef.get()).get('queueStatus'), 'idle');

  const replayLeagueId = 'ff133-replay-skipped-redelivery';
  const replayTaskId = 'ff133-replay-skipped-task';
  const replayInput = taskStartInput(
    replayLeagueId,
    replayTaskId,
    expectedDueAtMilliseconds,
  );
  const originalCompletedAt = Timestamp.fromMillis(
    Date.parse('2026-10-06T00:58:00.000Z'),
  );
  await Promise.all([
    replayInput.replayControlRef.set({ enabled: true, status: 'ready' }),
    replayInput.scheduleRef.set({
      scoringEnabled: false,
      queueStatus: 'paused',
      pausedReason: 'historical-replay',
      activeTaskId: null,
    }),
    replayInput.taskRef.set({
      status: 'skipped',
      skipReason: 'historical-replay',
      completedAt: originalCompletedAt,
    }),
  ]);

  assert.deepEqual(await beginLeagueAutomationTask(replayInput), {
    started: false,
    reason: 'historical-replay',
  });
  const replayTask = await replayInput.taskRef.get();
  assert.equal(replayTask.get('status'), 'skipped');
  assert.equal(replayTask.get('skipReason'), 'historical-replay');
  assert.equal(
    replayTask.get('completedAt').toMillis(),
    originalCompletedAt.toMillis(),
  );
});

test('only the exact processing task state is eligible for worker completion', () => {
  assert.equal(
    isLeagueAutomationTaskCompletionEligible({ status: 'processing' }),
    true,
  );

  for (const status of [
    undefined,
    'queued',
    'retrying',
    'completed',
    'skipped',
    'stale-recovered',
    'enqueue-error',
  ]) {
    assert.equal(
      isLeagueAutomationTaskCompletionEligible(
        status === undefined ? undefined : { status },
      ),
      false,
      String(status),
    );
  }
});

test('replay duplicate delivery preserves an in-flight task for truthful completion', async () => {
  const leagueId = 'ff133-in-flight-replay-duplicate';
  const taskId = 'ff133-in-flight-task';
  const expectedDueAtMilliseconds = Date.parse('2026-10-06T00:59:00.000Z');
  const input = taskStartInput(leagueId, taskId, expectedDueAtMilliseconds);
  await Promise.all([
    input.replayControlRef.set({ enabled: true, status: 'ready' }),
    input.scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'processing',
      activeTaskId: taskId,
      activeTaskDueAt: Timestamp.fromMillis(expectedDueAtMilliseconds),
      activeTaskLeaseExpiresAt: Timestamp.fromMillis(
        Date.parse('2026-10-06T01:12:00.000Z'),
      ),
      nextScoringAt: Timestamp.fromMillis(expectedDueAtMilliseconds),
    }),
    input.taskRef.set({ status: 'processing', attemptCount: 1 }),
  ]);

  assert.deepEqual(await beginLeagueAutomationTask(input), {
    started: false,
    reason: 'historical-replay',
  });
  assert.equal((await input.taskRef.get()).get('status'), 'processing');
  assert.equal((await input.scheduleRef.get()).get('queueStatus'), 'paused');

  assert.equal(
    await firestore.runTransaction(async (transaction) => {
      const taskSnapshot = await transaction.get(input.taskRef);
      return writeLeagueAutomationTaskCompletionInTransaction({
        transaction,
        taskRef: input.taskRef,
        currentTaskData: taskSnapshot.data(),
        completionData: {
          status: 'completed',
          durationMilliseconds: 321,
        },
      });
    }),
    true,
  );
  const completedTask = await input.taskRef.get();
  assert.equal(completedTask.get('status'), 'completed');
  assert.equal(completedTask.get('durationMilliseconds'), 321);
  assert.equal((await input.scheduleRef.get()).get('queueStatus'), 'paused');
});

test('late completion cannot overwrite stale-recovered terminal evidence', async () => {
  const taskRef = firestore.doc(
    'leagueAutomationTasks/ff133-stale-recovered-completion-race',
  );
  const recoveredAt = Timestamp.fromMillis(
    Date.parse('2026-10-06T00:59:00.000Z'),
  );
  await taskRef.set({
    status: 'stale-recovered',
    completedAt: recoveredAt,
    lastErrorCode: 'stale-task-recovered',
  });

  assert.equal(
    await firestore.runTransaction(async (transaction) => {
      const taskSnapshot = await transaction.get(taskRef);
      return writeLeagueAutomationTaskCompletionInTransaction({
        transaction,
        taskRef,
        currentTaskData: taskSnapshot.data(),
        completionData: {
          status: 'completed',
          completedAt: Timestamp.fromMillis(recoveredAt.toMillis() + 1_000),
        },
      });
    }),
    false,
  );

  const task = await taskRef.get();
  assert.equal(task.get('status'), 'stale-recovered');
  assert.equal(task.get('completedAt').toMillis(), recoveredAt.toMillis());
  assert.equal(task.get('lastErrorCode'), 'stale-task-recovered');
});

test('replay activation serializes before queued task processing begins', async () => {
  const leagueId = 'ff133-task-start-replay-race';
  const taskId = 'ff133-racing-task';
  const expectedDueAtMilliseconds = Date.parse('2026-10-06T00:59:00.000Z');
  const input = taskStartInput(leagueId, taskId, expectedDueAtMilliseconds);
  await Promise.all([
    input.replayControlRef.set({ enabled: false, status: 'inactive' }),
    input.scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'queued',
      activeTaskId: taskId,
      activeTaskDueAt: Timestamp.fromMillis(expectedDueAtMilliseconds),
    }),
    input.taskRef.set({ status: 'queued', attemptCount: 0 }),
  ]);

  let releaseReplayActivation;
  let reportReplayRead;
  const replayRead = new Promise((resolve) => {
    reportReplayRead = resolve;
  });
  const replayActivationRelease = new Promise((resolve) => {
    releaseReplayActivation = resolve;
  });
  const replayActivation = firestore.runTransaction(async (transaction) => {
    await transaction.get(input.replayControlRef);
    reportReplayRead();
    await replayActivationRelease;
    transaction.set(
      input.replayControlRef,
      { enabled: true, status: 'ready' },
      { merge: true },
    );
  });

  await replayRead;
  const start = beginLeagueAutomationTask(input);
  releaseReplayActivation();
  await replayActivation;

  assert.deepEqual(await start, {
    started: false,
    reason: 'historical-replay',
  });
  const [schedule, task] = await Promise.all([
    input.scheduleRef.get(),
    input.taskRef.get(),
  ]);
  assert.equal(schedule.get('scoringEnabled'), false);
  assert.equal(schedule.get('queueStatus'), 'paused');
  assert.equal(schedule.get('activeTaskId'), null);
  assert.equal(task.get('status'), 'skipped');
  assert.equal(task.get('skipReason'), 'historical-replay');
  assert.equal(task.get('attemptCount'), 0);
});

test('an ordinary queued task begins once and duplicate processing delivery is inert', async () => {
  const leagueId = 'ff133-ordinary-task-start';
  const taskId = 'ff133-ordinary-start-task';
  const expectedDueAtMilliseconds = Date.parse('2026-10-06T00:59:00.000Z');
  const input = taskStartInput(leagueId, taskId, expectedDueAtMilliseconds);
  await Promise.all([
    input.replayControlRef.set({ enabled: false }),
    input.scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'queued',
      activeTaskId: taskId,
      activeTaskDueAt: Timestamp.fromMillis(expectedDueAtMilliseconds),
    }),
    input.taskRef.set({ status: 'queued', attemptCount: 0 }),
  ]);

  assert.deepEqual(await beginLeagueAutomationTask(input), {
    started: true,
    reason: 'processing',
  });
  assert.deepEqual(await beginLeagueAutomationTask(input), {
    started: false,
    reason: 'already-processing',
  });

  const [schedule, task] = await Promise.all([
    input.scheduleRef.get(),
    input.taskRef.get(),
  ]);
  assert.equal(schedule.get('queueStatus'), 'processing');
  assert.equal(schedule.get('activeTaskId'), taskId);
  assert.equal(task.get('status'), 'processing');
  assert.equal(task.get('attemptCount'), 1);
});

test('a concurrent replay activation that takes authority first makes the lease fail closed', async () => {
  const leagueId = 'ff133-concurrent-activation';
  const { controlRef, replayControlRef, scheduleRef } = refsFor(leagueId);
  await Promise.all([
    controlRef.set({ status: 'idle', nextRefreshAt: Timestamp.fromMillis(0) }),
    replayControlRef.set({ enabled: false, status: 'inactive' }),
  ]);

  let releaseReplayActivation;
  let reportReplayRead;
  const replayRead = new Promise((resolve) => {
    reportReplayRead = resolve;
  });
  const replayActivationRelease = new Promise((resolve) => {
    releaseReplayActivation = resolve;
  });

  const replayActivation = firestore.runTransaction(async (transaction) => {
    await transaction.get(replayControlRef);
    reportReplayRead();
    await replayActivationRelease;
    transaction.set(
      replayControlRef,
      { enabled: true, status: 'ready' },
      { merge: true },
    );
    parkLeagueAutomationScheduleForHistoricalReplayInTransaction({
      transaction,
      scheduleRef,
      leagueId,
      scheduleShard: 3,
      scheduleSchemaVersion: 1,
    });
  });

  await replayRead;
  const claim = claimLease(leagueId, 'draft-complete', true);
  releaseReplayActivation();
  await replayActivation;

  assert.deepEqual(await claim, {
    claimed: false,
    reason: 'historical-replay',
  });
  assert.equal((await controlRef.get()).get('status'), 'idle');
  assert.equal((await scheduleRef.get()).get('pausedReason'), 'historical-replay');
});

test('duplicate retry handling preserves replay pause after downstream failure', async () => {
  const leagueId = 'ff133-downstream-failure';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  const taskRef = firestore.doc('leagueAutomationTasks/ff133-task');
  await Promise.all([
    replayControlRef.set({ enabled: true, status: 'ready' }),
    scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'processing',
      pausedReason: '',
      activeTaskId: 'ff133-task',
      nextScoringAt: Timestamp.fromMillis(1),
    }),
    taskRef.set({ status: 'processing' }),
  ]);
  const input = {
    scheduleRef,
    replayControlRef,
    taskRef,
    taskId: 'ff133-task',
    errorMessage: 'injected-post-completion-metric-failure',
    errorCode: 'injected-metric-failure',
    nowMilliseconds: Date.parse('2026-10-06T01:00:00.000Z'),
    processingLeaseMilliseconds: 12 * 60 * 1000,
    taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
  };

  assert.equal(await preserveReplayPauseOrMarkTaskRetrying(input), 'preserved');
  assert.equal(await preserveReplayPauseOrMarkTaskRetrying(input), 'preserved');

  const [schedule, task] = await Promise.all([scheduleRef.get(), taskRef.get()]);
  assert.equal(schedule.get('queueStatus'), 'paused');
  assert.equal(schedule.get('scoringEnabled'), false);
  assert.equal(schedule.get('activeTaskId'), null);
  assert.equal(task.get('status'), 'skipped');
  assert.equal(task.get('skipReason'), 'historical-replay');
  assert.equal(task.get('lastError'), '');
});

test('ordinary queue failures retain the existing bounded retry behavior', async () => {
  const leagueId = 'ff133-ordinary-retry';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  const taskRef = firestore.doc('leagueAutomationTasks/ff133-ordinary-task');
  await Promise.all([
    replayControlRef.set({ enabled: false, status: 'inactive' }),
    scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'processing',
      activeTaskId: 'ff133-ordinary-task',
    }),
    taskRef.set({ status: 'processing' }),
  ]);

  assert.equal(
    await preserveReplayPauseOrMarkTaskRetrying({
      scheduleRef,
      replayControlRef,
      taskRef,
      taskId: 'ff133-ordinary-task',
      errorMessage: 'bounded retry',
      errorCode: 'unavailable',
      nowMilliseconds: Date.parse('2026-10-06T01:00:00.000Z'),
      processingLeaseMilliseconds: 12 * 60 * 1000,
      taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
    }),
    'retrying',
  );

  const [schedule, task] = await Promise.all([scheduleRef.get(), taskRef.get()]);
  assert.equal(schedule.get('queueStatus'), 'processing');
  assert.equal(schedule.get('activeTaskId'), 'ff133-ordinary-task');
  assert.equal(schedule.get('lastQueueErrorCode'), 'unavailable');
  assert.equal(task.get('status'), 'retrying');
  assert.equal(task.get('lastErrorCode'), 'unavailable');
});

test('a stale task failure cannot reclaim a schedule owned by a newer task', async () => {
  const leagueId = 'ff133-stale-task-ownership';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  const staleTaskRef = firestore.doc('leagueAutomationTasks/ff133-stale-task');
  const newerLeaseExpiresAt = Timestamp.fromMillis(
    Date.parse('2026-10-06T01:30:00.000Z'),
  );
  await Promise.all([
    replayControlRef.set({ enabled: false, status: 'inactive' }),
    scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'processing',
      activeTaskId: 'ff133-newer-task',
      activeTaskLeaseExpiresAt: newerLeaseExpiresAt,
      lastQueueErrorCode: 'newer-task-still-owns-schedule',
    }),
    staleTaskRef.set({
      status: 'stale-recovered',
      completedAt: Timestamp.fromMillis(
        Date.parse('2026-10-06T00:59:00.000Z'),
      ),
    }),
  ]);

  assert.equal(
    await preserveReplayPauseOrMarkTaskRetrying({
      scheduleRef,
      replayControlRef,
      taskRef: staleTaskRef,
      taskId: 'ff133-stale-task',
      errorMessage: 'late stale worker failure',
      errorCode: 'unavailable',
      nowMilliseconds: Date.parse('2026-10-06T01:00:00.000Z'),
      processingLeaseMilliseconds: 12 * 60 * 1000,
      taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
    }),
    'preserved',
  );

  const [schedule, staleTask] = await Promise.all([
    scheduleRef.get(),
    staleTaskRef.get(),
  ]);
  assert.equal(schedule.get('activeTaskId'), 'ff133-newer-task');
  assert.equal(schedule.get('queueStatus'), 'processing');
  assert.equal(
    schedule.get('activeTaskLeaseExpiresAt').toMillis(),
    newerLeaseExpiresAt.toMillis(),
  );
  assert.equal(
    schedule.get('lastQueueErrorCode'),
    'newer-task-still-owns-schedule',
  );
  assert.equal(staleTask.get('status'), 'stale-recovered');
  assert.equal(staleTask.get('lastErrorCode'), undefined);
});

test('a still-processing late task cannot overwrite a newer active task', async () => {
  const leagueId = 'ff133-late-processing-task';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  const lateTaskRef = firestore.doc('leagueAutomationTasks/ff133-late-processing-task');
  const newerLeaseExpiresAt = Timestamp.fromMillis(
    Date.parse('2026-10-06T01:30:00.000Z'),
  );
  await Promise.all([
    replayControlRef.set({ enabled: false, status: 'inactive' }),
    scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'processing',
      activeTaskId: 'ff133-authoritative-task',
      activeTaskLeaseExpiresAt: newerLeaseExpiresAt,
    }),
    lateTaskRef.set({ status: 'processing', attemptCount: 1 }),
  ]);

  assert.equal(
    await preserveReplayPauseOrMarkTaskRetrying({
      scheduleRef,
      replayControlRef,
      taskRef: lateTaskRef,
      taskId: 'ff133-late-processing-task',
      errorMessage: 'late worker failure',
      errorCode: 'deadline-exceeded',
      nowMilliseconds: Date.parse('2026-10-06T01:00:00.000Z'),
      processingLeaseMilliseconds: 12 * 60 * 1000,
      taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
    }),
    'preserved',
  );

  const [schedule, lateTask] = await Promise.all([
    scheduleRef.get(),
    lateTaskRef.get(),
  ]);
  assert.equal(schedule.get('activeTaskId'), 'ff133-authoritative-task');
  assert.equal(
    schedule.get('activeTaskLeaseExpiresAt').toMillis(),
    newerLeaseExpiresAt.toMillis(),
  );
  assert.equal(lateTask.get('status'), 'processing');
  assert.equal(lateTask.get('lastErrorCode'), undefined);
});

test('an enqueue failure after replay activation parks the schedule and settles only its task', async () => {
  const leagueId = 'ff133-enqueue-failure-replay-race';
  const taskId = 'ff133-enqueue-race-task';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  const taskRef = firestore.doc(`leagueAutomationTasks/${taskId}`);
  await Promise.all([
    replayControlRef.set({ enabled: true, status: 'ready' }),
    scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'queued',
      activeTaskId: taskId,
      activeTaskDueAt: Timestamp.fromMillis(1),
      activeTaskLeaseExpiresAt: Timestamp.fromMillis(2),
      nextScoringAt: Timestamp.fromMillis(3),
    }),
    taskRef.set({ status: 'queued', attemptCount: 0 }),
  ]);
  const input = {
    scheduleRef,
    replayControlRef,
    taskRef,
    taskId,
    errorMessage: 'injected enqueue failure',
    errorCode: 'unavailable',
    nowMilliseconds: Date.parse('2026-10-06T01:00:00.000Z'),
    retryAtMilliseconds: Date.parse('2026-10-06T01:01:00.000Z'),
    taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
  };

  assert.equal(
    await preserveReplayPauseOrRecordEnqueueFailure(input),
    'historical-replay',
  );
  const firstTask = await taskRef.get();
  const firstCompletedAt = firstTask.get('completedAt').toMillis();
  assert.equal(
    await preserveReplayPauseOrRecordEnqueueFailure(input),
    'historical-replay',
  );

  const [schedule, task] = await Promise.all([scheduleRef.get(), taskRef.get()]);
  assert.equal(schedule.get('scoringEnabled'), false);
  assert.equal(schedule.get('queueStatus'), 'paused');
  assert.equal(schedule.get('pausedReason'), 'historical-replay');
  assert.equal(schedule.get('activeTaskId'), null);
  assert.equal(schedule.get('nextScoringAt'), undefined);
  assert.equal(task.get('status'), 'skipped');
  assert.equal(task.get('skipReason'), 'historical-replay');
  assert.equal(task.get('completedAt').toMillis(), firstCompletedAt);
  assert.equal(task.get('lastErrorCode'), '');
});

test('ordinary enqueue failure retains bounded retry scheduling and terminal idempotency', async () => {
  const leagueId = 'ff133-ordinary-enqueue-failure';
  const taskId = 'ff133-ordinary-enqueue-task';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  const taskRef = firestore.doc(`leagueAutomationTasks/${taskId}`);
  const retryAtMilliseconds = Date.parse('2026-10-06T01:01:00.000Z');
  await Promise.all([
    replayControlRef.set({ enabled: false, status: 'inactive' }),
    scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'queued',
      activeTaskId: taskId,
      nextScoringAt: Timestamp.fromMillis(1),
    }),
    taskRef.set({ status: 'queued', attemptCount: 0 }),
  ]);
  const input = {
    scheduleRef,
    replayControlRef,
    taskRef,
    taskId,
    errorMessage: 'injected enqueue failure',
    errorCode: 'unavailable',
    nowMilliseconds: Date.parse('2026-10-06T01:00:00.000Z'),
    retryAtMilliseconds,
    taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
  };

  assert.equal(
    await preserveReplayPauseOrRecordEnqueueFailure(input),
    'enqueue-error',
  );
  const firstTask = await taskRef.get();
  const firstExpiry = firstTask.get('expiresAt').toMillis();
  assert.equal(
    await preserveReplayPauseOrRecordEnqueueFailure(input),
    'preserved',
  );

  const [schedule, task] = await Promise.all([scheduleRef.get(), taskRef.get()]);
  assert.equal(schedule.get('queueStatus'), 'error');
  assert.equal(schedule.get('activeTaskId'), null);
  assert.equal(schedule.get('nextScoringAt').toMillis(), retryAtMilliseconds);
  assert.equal(schedule.get('lastQueueErrorCode'), 'unavailable');
  assert.equal(task.get('status'), 'enqueue-error');
  assert.equal(task.get('expiresAt').toMillis(), firstExpiry);
});

test('stale recovery cannot recreate a deadline after replay activation', async () => {
  const leagueId = 'ff133-stale-recovery-replay-race';
  const taskId = 'ff133-stale-replay-task';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  const taskRef = firestore.doc(`leagueAutomationTasks/${taskId}`);
  const nowMilliseconds = Date.parse('2026-10-06T01:00:00.000Z');
  await Promise.all([
    replayControlRef.set({ enabled: true, status: 'error' }),
    scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'processing',
      activeTaskId: taskId,
      activeTaskLeaseExpiresAt: Timestamp.fromMillis(nowMilliseconds - 1),
      nextScoringAt: Timestamp.fromMillis(nowMilliseconds - 2),
    }),
    taskRef.set({ status: 'processing', attemptCount: 1 }),
  ]);

  assert.deepEqual(
    await recoverStaleLeagueAutomationTask({
      scheduleRef,
      replayControlRef,
      taskCollectionPath: 'leagueAutomationTasks',
      nowMilliseconds,
      taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
    }),
    {
      recovered: true,
      reason: 'historical-replay',
      taskId,
    },
  );

  const [schedule, task] = await Promise.all([scheduleRef.get(), taskRef.get()]);
  assert.equal(schedule.get('scoringEnabled'), false);
  assert.equal(schedule.get('queueStatus'), 'paused');
  assert.equal(schedule.get('activeTaskId'), null);
  assert.equal(schedule.get('nextScoringAt'), undefined);
  assert.equal(task.get('status'), 'skipped');
  assert.equal(task.get('skipReason'), 'historical-replay');
});

test('replay recovery parks a malformed stale owner without constructing an unsafe task path', async () => {
  const leagueId = 'ff133-malformed-stale-owner';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  const nowMilliseconds = Date.parse('2026-10-06T01:00:00.000Z');
  await Promise.all([
    replayControlRef.set({ enabled: true, status: 'ready' }),
    scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'queued',
      activeTaskId: '../unsafe-task-path',
      activeTaskLeaseExpiresAt: Timestamp.fromMillis(nowMilliseconds - 1),
      nextScoringAt: Timestamp.fromMillis(nowMilliseconds - 2),
    }),
  ]);

  assert.deepEqual(
    await recoverStaleLeagueAutomationTask({
      scheduleRef,
      replayControlRef,
      taskCollectionPath: 'leagueAutomationTasks',
      nowMilliseconds,
      taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
    }),
    {
      recovered: true,
      reason: 'historical-replay',
      taskId: '',
    },
  );
  const schedule = await scheduleRef.get();
  assert.equal(schedule.get('queueStatus'), 'paused');
  assert.equal(schedule.get('activeTaskId'), null);
  assert.equal(schedule.get('nextScoringAt'), undefined);
});

test('ordinary stale recovery preserves terminal evidence while releasing the schedule', async () => {
  const leagueId = 'ff133-ordinary-stale-recovery';
  const taskId = 'ff133-completed-stale-task';
  const { replayControlRef, scheduleRef } = refsFor(leagueId);
  const taskRef = firestore.doc(`leagueAutomationTasks/${taskId}`);
  const nowMilliseconds = Date.parse('2026-10-06T01:00:00.000Z');
  const completedAt = Timestamp.fromMillis(nowMilliseconds - 10_000);
  await Promise.all([
    replayControlRef.set({ enabled: false, status: 'inactive' }),
    scheduleRef.set({
      scoringEnabled: true,
      queueStatus: 'processing',
      activeTaskId: taskId,
      activeTaskLeaseExpiresAt: Timestamp.fromMillis(nowMilliseconds - 1),
    }),
    taskRef.set({
      status: 'completed',
      completedAt,
      durationMilliseconds: 321,
    }),
  ]);

  assert.deepEqual(
    await recoverStaleLeagueAutomationTask({
      scheduleRef,
      replayControlRef,
      taskCollectionPath: 'leagueAutomationTasks',
      nowMilliseconds,
      taskHistoryRetentionMilliseconds: 7 * 24 * 60 * 60 * 1000,
    }),
    {
      recovered: true,
      reason: 'stale-task-recovered',
      taskId,
    },
  );

  const [schedule, task] = await Promise.all([scheduleRef.get(), taskRef.get()]);
  assert.equal(schedule.get('queueStatus'), 'error');
  assert.equal(schedule.get('activeTaskId'), null);
  assert.equal(schedule.get('nextScoringAt').toMillis(), nowMilliseconds);
  assert.equal(schedule.get('lastQueueErrorCode'), 'stale-task-recovered');
  assert.equal(task.get('status'), 'completed');
  assert.equal(task.get('completedAt').toMillis(), completedAt.toMillis());
  assert.equal(task.get('durationMilliseconds'), 321);
  assert.equal(task.get('lastErrorCode'), undefined);
});

test('the replay decision and scoring lease are one Firestore transaction', async () => {
  const [automation, writeService] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read(
      'functions/src/shared/core/live-scoring/historical-replay-lease-write.service.ts',
    ),
  ]);
  const claimStart = automation.indexOf('async function claimLeagueAutomationLease(');
  const claimEnd = automation.indexOf('async function getPreviousScoringSnapshot(', claimStart);
  const claim = automation.slice(claimStart, claimEnd);
  const liveRunStart = automation.indexOf('async function runLeagueAutomation(');
  const liveRunEnd = automation.indexOf('async function delay(', liveRunStart);
  const liveRun = automation.slice(liveRunStart, liveRunEnd);
  const successStart = automation.indexOf('async function recordLeagueAutomationSuccess(');
  const failureStart = automation.indexOf('async function recordLeagueAutomationFailure(');
  const skipStart = automation.indexOf('async function recordLeagueAutomationSkip(');
  const claimLeaseStart = automation.indexOf('async function claimLeagueAutomationLease(', skipStart);
  const recorders = [
    automation.slice(successStart, failureStart),
    automation.slice(failureStart, skipStart),
    automation.slice(skipStart, claimLeaseStart),
  ];
  const outcomeStart = writeService.indexOf(
    'export async function writeLeagueAutomationScheduleOutcome(',
  );
  const leaseTransactionStart = writeService.indexOf(
    'export async function claimLeagueAutomationLeaseInTransaction(',
  );
  const taskStart = writeService.indexOf(
    'export async function beginLeagueAutomationTask(',
  );
  const outcomeWriter = writeService.slice(outcomeStart, leaseTransactionStart);
  const leaseTransaction = writeService.slice(leaseTransactionStart, taskStart);

  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  assert.ok(outcomeStart >= 0 && leaseTransactionStart > outcomeStart);
  assert.ok(taskStart > leaseTransactionStart);
  assert.match(claim, /db\.runTransaction\(\(transaction\) =>[\s\S]+claimLeagueAutomationLeaseInTransaction/);
  assert.match(
    outcomeWriter,
    /input\.trigger === 'historical-replay'[\s\S]+transaction\.get\(input\.replayControlRef\)/,
  );
  assert.match(
    outcomeWriter,
    /historicalReplayOwnsScoring[\s\S]+historicalReplaySchedulePauseFields\(\)/,
  );
  assert.match(
    leaseTransaction,
    /Promise\.all\(\[[\s\S]+input\.transaction\.get\(input\.controlRef\)[\s\S]+input\.transaction\.get\(input\.replayControlRef\)/,
  );
  assert.match(
    leaseTransaction,
    /shouldPauseLeagueAutomationForHistoricalReplay\([\s\S]+parkLeagueAutomationScheduleForHistoricalReplayInTransaction\(input\)[\s\S]+reason: 'historical-replay'/,
  );
  assert.match(automation, /beginLeagueAutomationTask\(\{/);
  for (const recorder of recorders) {
    assert.match(recorder, /writeLeagueAutomationScheduleOutcome\(\{/);
    assert.match(
      recorder,
      /replayControlRef: getHistoricalReplayControlRef\(leagueId\)/,
    );
    assert.match(recorder, /\n\s+trigger,?\n/);
  }
  assert.match(writeService, /export async function beginLeagueAutomationTask\(/);
  assert.match(writeService, /transaction\.get\(input\.scheduleRef\)[\s\S]+transaction\.get\(input\.replayControlRef\)[\s\S]+transaction\.get\(input\.taskRef\)/);
  assert.match(writeService, /isTerminalLeagueAutomationTaskStatus\(taskStatus\)/);
  assert.ok(
    leaseTransaction.indexOf("reason: 'historical-replay'") <
      leaseTransaction.indexOf('const anotherServerWorkerOwnsLease'),
  );
  assert.ok(
    leaseTransaction.indexOf("reason: 'historical-replay'") <
      leaseTransaction.indexOf('if (!input.force && nextRefreshAt > input.nowMilliseconds)'),
  );
  assert.ok(
    leaseTransaction.indexOf("reason: 'historical-replay'") <
      leaseTransaction.indexOf('input.transaction.set(\n    input.controlRef,'),
  );
  assert.doesNotMatch(
    liveRun.slice(0, liveRun.indexOf('const workerId =')),
    /getHistoricalReplayControl\(leagueId\)/,
  );
  assert.ok(
    liveRun.indexOf('claimLeagueAutomationLease(') <
      liveRun.indexOf('getHistoricalReplayControl(leagueId)'),
  );
  assert.match(liveRun, /if \(lease\.reason !== 'historical-replay'\)[\s\S]+recordLeagueAutomationSkip/);
  assert.ok(
    liveRun.indexOf('if (!lease.claimed)') <
      liveRun.indexOf('ensureCycleOneStarted('),
  );
});

test('every downstream schedule writer serializes behind raw replay authority', async () => {
  const [automation, writeService] = await Promise.all([
    read('functions/src/league-automation.ts'),
    read(
      'functions/src/shared/core/live-scoring/historical-replay-lease-write.service.ts',
    ),
  ]);
  const slice = (startMarker, endMarker) => {
    const start = automation.indexOf(startMarker);
    const end = automation.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `missing start marker: ${startMarker}`);
    assert.ok(end > start, `missing end marker after: ${startMarker}`);
    return automation.slice(start, end);
  };
  const serviceSlice = (startMarker, endMarker) => {
    const start = writeService.indexOf(startMarker);
    const end = endMarker
      ? writeService.indexOf(endMarker, start + startMarker.length)
      : writeService.length;
    assert.ok(start >= 0, `missing service start marker: ${startMarker}`);
    assert.ok(end > start, `missing service end marker after: ${startMarker}`);
    return writeService.slice(start, end);
  };

  const canonicalRequest = slice(
    'export async function requestLeagueAutomationForCanonicalChange(',
    'function normalizeCanonicalParityGameIds(',
  );
  assert.match(canonicalRequest, /transaction\.get\(replayControlRef\)/);
  assert.match(
    canonicalRequest,
    /replayEnabled \? historicalReplaySchedulePauseFields\(\) : \{\}/,
  );

  const queueClaim = slice(
    'async function claimLeagueAutomationTask(',
    'async function releaseFailedLeagueAutomationEnqueue(',
  );
  assert.match(queueClaim, /transaction\.get\(replayControlRef\)/);
  assert.match(
    queueClaim,
    /parkLeagueAutomationScheduleForHistoricalReplayInTransaction\(\{/,
  );

  const queueCompletion = slice(
    'async function markLeagueAutomationTaskCompleted(',
    'async function markLeagueAutomationTaskRetrying(',
  );
  assert.match(queueCompletion, /transaction\.get\(replayControlRef\)/);
  assert.match(queueCompletion, /replaySnapshot\.data\(\)\?\.\['enabled'\] === true/);
  assert.match(queueCompletion, /scheduleCompletionData\['nextScoringAt'\] = FieldValue\.delete\(\)/);

  const bootstrap = slice(
    'async function bootstrapMissingLeagueAutomationSchedules()',
    'function getLeagueAutomationWatchdogActionReason(',
  );
  assert.match(bootstrap, /db\.runTransaction\(async \(transaction\) =>/);
  assert.match(bootstrap, /transaction\.getAll\(\.\.\.replayRefs\)/);
  assert.match(
    bootstrap,
    /parkLeagueAutomationScheduleForHistoricalReplayInTransaction\(\{/,
  );

  const canary = slice(
    'export const queueLeagueAutomationCanaryCheck = onCall(',
    'export const bootstrapLeagueAutomationSchedules = onSchedule(',
  );
  assert.match(canary, /transaction\.get\(replayControlRef\)/);
  assert.match(canary, /replaySnapshot\.data\(\)\?\.\['enabled'\] === true/);

  const replayCallable = slice(
    'export const advanceHistoricalReplayDay = onCall(',
    'export const processHistoricalReplayAdvance = onTaskDispatched',
  );
  assert.match(replayCallable, /enabled: true/);
  assert.match(
    replayCallable,
    /parkLeagueAutomationScheduleForHistoricalReplayInTransaction\(\{/,
  );

  const replayAdvance = slice(
    'async function performHistoricalReplayAdvance(',
    'export const advanceHistoricalReplayDay = onCall(',
  );
  assert.equal(
    [
      ...replayAdvance.matchAll(
        /writeHistoricalReplayControlAndParkSchedule\(\{/g,
      ),
    ].length,
    2,
    'advancing and failure replay states must atomically retain the schedule pause',
  );
  assert.doesNotMatch(replayAdvance, /controlRef\.set\(\s*\{\s*enabled: true/);

  const replayWorker = slice(
    'export const processHistoricalReplayAdvance = onTaskDispatched',
    'export const recoverStaleHistoricalReplayQueue = onSchedule(',
  );
  assert.match(replayWorker, /transaction\.get\(controlRef\)/);
  assert.match(
    replayWorker,
    /parkLeagueAutomationScheduleForHistoricalReplayInTransaction\(\{/,
  );

  const staleRecovery = slice(
    'export const recoverStaleLeagueAutomationQueue = onSchedule(',
    'export const cleanupLeagueAutomationTaskHistory = onSchedule(',
  );
  assert.match(staleRecovery, /recoverStaleLeagueAutomationTask\(\{/);
  assert.match(
    staleRecovery,
    /replayControlRef: getHistoricalReplayControlRef\(document\.id\)/,
  );

  const retryWriter = serviceSlice(
    'export async function preserveReplayPauseOrMarkTaskRetrying(',
    'export async function preserveReplayPauseOrRecordEnqueueFailure(',
  );
  assert.match(retryWriter, /transaction\.get\(input\.replayControlRef\)/);
  assert.match(retryWriter, /activeTaskId !== input\.taskId/);
  assert.match(retryWriter, /historicalReplaySchedulePauseFields\(\)/);

  const replayControlWriter = serviceSlice(
    'export async function writeHistoricalReplayControlAndParkSchedule(',
    'function isTerminalLeagueAutomationTaskStatus(',
  );
  assert.match(replayControlWriter, /controlRef\.firestore\.runTransaction/);
  assert.match(replayControlWriter, /enabled: true/);
  assert.match(
    replayControlWriter,
    /parkLeagueAutomationScheduleForHistoricalReplayInTransaction\(\{/,
  );

  const enqueueFailureWriter = serviceSlice(
    'export async function preserveReplayPauseOrRecordEnqueueFailure(',
    'export async function recoverStaleLeagueAutomationTask(',
  );
  assert.match(
    enqueueFailureWriter,
    /transaction\.get\(input\.replayControlRef\)/,
  );
  assert.match(
    enqueueFailureWriter,
    /isTerminalLeagueAutomationTaskStatus\(taskStatus\)/,
  );
  assert.match(
    enqueueFailureWriter,
    /historicalReplaySchedulePauseFields\(\)/,
  );

  const staleRecoveryWriter = serviceSlice(
    'export async function recoverStaleLeagueAutomationTask(',
    null,
  );
  assert.match(
    staleRecoveryWriter,
    /transaction\.get\(input\.replayControlRef\)/,
  );
  assert.match(
    staleRecoveryWriter,
    /isTerminalLeagueAutomationTaskStatus\(taskStatus\)/,
  );
  assert.match(
    staleRecoveryWriter,
    /historicalReplaySchedulePauseFields\(\)/,
  );
});

test('a replay-blocked queue delivery cannot re-enable or unpause scoring', async () => {
  const automation = await read('functions/src/league-automation.ts');
  const completionStart = automation.indexOf('async function markLeagueAutomationTaskCompleted(');
  const completionEnd = automation.indexOf('async function markLeagueAutomationTaskRetrying(', completionStart);
  const completion = automation.slice(completionStart, completionEnd);

  assert.match(completion, /historicalReplayPaused[\s\S]+queueStatus:[\s\S]+\? 'paused'/);
  assert.match(completion, /transaction\.get\(taskRef\)/);
  assert.match(
    completion,
    /if \(!isLeagueAutomationTaskCompletionEligible\(taskSnapshot\.data\(\)\)\) \{[\s\S]+return;/,
  );
  assert.match(
    completion,
    /writeLeagueAutomationTaskCompletionInTransaction\(\{/,
  );
  assert.match(completion, /\} else if \(canonicalNeedsFollowUp\) \{/);
  assert.match(completion, /scheduleCompletionData\['scoringEnabled'\] = false/);
  assert.match(completion, /scheduleCompletionData\['pausedReason'\] = 'historical-replay'/);
  assert.match(completion, /scheduleCompletionData\['nextScoringAt'\] = FieldValue\.delete\(\)/);
  assert.match(automation, /preserveReplayPauseOrMarkTaskRetrying\(\{/);
  assert.match(automation, /Unable to record a completed queue-task metric\./);
  assert.match(automation, /\)\.catch\(\(error: unknown\) => \{/);
});

test('Draft pick handoff emits privacy-safe success and failure correlation markers', async () => {
  const automation = await read('functions/src/draft-automation.ts');
  const triggerStart = automation.indexOf(
    'export const reconcileDraftTurnAfterCommittedPick = onDocumentWritten(',
  );
  const triggerEnd = automation.indexOf(
    'export const continueServerDraftAutomation = onDocumentWritten(',
    triggerStart,
  );
  const trigger = automation.slice(triggerStart, triggerEnd);
  const markerStart = trigger.indexOf(
    "logger.info('Committed Draft pick handoff reconciled.'",
  );
  const marker = trigger.slice(markerStart, trigger.indexOf('    });', markerStart));

  assert.match(trigger, /Committed Draft pick handoff reconciled\./);
  assert.match(trigger, /logger\.info\(/);
  assert.match(trigger, /eventId: event\.id/);
  assert.match(trigger, /draftPickCorrelationHash,?/);
  assert.match(trigger, /buildDraftPickHandoffCorrelationHash\(leagueId, pickId\)/);
  assert.doesNotMatch(marker, /\n\s+leagueId,/);
  assert.doesNotMatch(marker, /\n\s+pickId,/);
  assert.match(trigger, /draftStatus: result\.status/);
  assert.match(trigger, /nextDeadlineScheduled: taskScheduled/);
  assert.ok(
    trigger.indexOf('repairDraftTurnFromCommittedPicks(') <
      trigger.indexOf("logger.info('Committed Draft pick handoff reconciled.'"),
  );
  assert.ok(
    trigger.indexOf('buildDraftPickHandoffCorrelationHash(leagueId, pickId)') <
      trigger.indexOf('repairDraftTurnFromCommittedPicks('),
  );
  assert.match(
    trigger,
    /try \{[\s\S]+repairDraftTurnFromCommittedPicks\([\s\S]+ensureCurrentDraftClockTask\(leagueId\)[\s\S]+\} catch \{[\s\S]+logger\.error\('Committed Draft pick handoff reconciliation failed\.'[\s\S]+draftPickCorrelationHash[\s\S]+failureStage/,
  );
  assert.doesNotMatch(
    trigger,
    /throw new Error\([\s\S]{0,160}\$\{pickId\}/,
  );
  assert.match(
    trigger,
    /throw new Error\('Committed Draft pick handoff reconciliation failed\.'\)/,
  );
});

test('the runtime slice leaves competitive formulas and Firebase policy unchanged', async () => {
  assert.equal(
    await sha256('src/app/core/scoring/scoring-rules.ts'),
    PROTECTED_SOURCE_HASHES.scoringRules,
  );
  assert.equal(
    await sha256('src/app/core/scoring/scoring-engine.ts'),
    PROTECTED_SOURCE_HASHES.scoringEngine,
  );
  assert.equal(
    await sha256('src/app/core/projection/projection-v11.util.ts'),
    PROTECTED_SOURCE_HASHES.projectionV11,
  );
  assert.equal(await sha256('firestore.rules'), PROTECTED_SOURCE_HASHES.firestoreRules);
  assert.equal(
    await sha256('firestore.indexes.json'),
    PROTECTED_SOURCE_HASHES.firestoreIndexes,
  );
});

test('FF1.33 documents acceptance, observability, targeted deployment, and rollback', async () => {
  const [documentation, handoff, runbook, packageSource] = await Promise.all([
    read('docs/RINKRAT_FF1_33_HISTORICAL_REPLAY_LEASE_GUARD.md'),
    read('docs/RINKRAT_CODEX_HANDOFF.md'),
    read('docs/RINKRAT_FF1_DRAFT_GATE_RUNBOOK.md'),
    read('package.json'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(documentation, /## Acceptance criteria and edge cases/);
  assert.match(documentation, /## Staging evidence and observability/);
  assert.match(documentation, /## Targeted deployment boundary and rollback/);
  const deploymentOrder = [
    'functions:processLeagueAutomationTask',
    'functions:processHistoricalReplayAdvance',
    'functions:initializeSeasonAfterDraft',
    'functions:reconcileDraftTurnAfterCommittedPick',
    'functions:advanceHistoricalReplayDay',
  ];
  let precedingIndex = -1;
  for (const selector of deploymentOrder) {
    const selectorIndex = documentation.lastIndexOf(selector);
    assert.ok(selectorIndex > precedingIndex, `${selector} must retain staged order`);
    precedingIndex = selectorIndex;
  }
  precedingIndex = -1;
  for (const selector of deploymentOrder.map((entry) => entry.replace('functions:', ''))) {
    const selectorIndex = runbook.indexOf(`\n${selector}\n`);
    assert.ok(selectorIndex > precedingIndex, `${selector} must retain runbook deployment order`);
    precedingIndex = selectorIndex;
  }
  assert.match(documentation, /no replay request is[\s\S]+queued\/processing/);
  assert.match(documentation, /Every one of those 19\s+Functions/);
  assert.match(documentation, /other eight[\s\S]+must remain absent/);
  for (const selector of [
    'functions:runSeasonStartAutomation',
    'functions:runScheduledLeagueAutomation',
    'functions:requestLeagueLiveScoringRefresh',
    'functions:dispatchDueLeagueAutomation',
    'functions:bootstrapLeagueAutomationSchedules',
    'functions:recoverStaleLeagueAutomationQueue',
    'functions:queueLeagueAutomationCanaryCheck',
    'functions:pollCanonicalNhlImpactFeed',
  ]) {
    assert.match(documentation, new RegExp(selector));
  }
  assert.match(documentation, /no live-scoring lease is active/);
  assert.match(
    documentation,
    /no raw `historicalReplay\/control\.enabled === true` value exists/,
  );
  assert.match(
    documentation,
    /If any raw enabled replay control remains,[\s\S]+do \*\*not\*\* restore an unguarded consumer revision/,
  );
  assert.match(documentation, /zero active[\s\S]+alone are not sufficient/i);
  assert.match(documentation, /existing[\s\S]+D1L staging fixture[\s\S]+enabled/);
  assert.match(documentation, /reverse consumer order/);
  assert.match(documentation, /Production Scoring V4/);
  assert.match(documentation, /Projection V11/);
  assert.match(handoff, /FF1\.33's first runtime prerequisite/);
  assert.match(runbook, /FF1\.33 atomic Historical Replay lease guard/);
  assert.equal(
    packageJson.scripts['verify:batchff1-17:core'],
    'npm run verify:batchff1-16:core && npm run test:batchff1-17 && npm run validate:release-manifest',
  );
  assert.match(
    packageJson.scripts['test:batchff1-17'],
    /firebase emulators:exec --project demo-rinkrat-ff1-17 --only firestore/,
  );
});
