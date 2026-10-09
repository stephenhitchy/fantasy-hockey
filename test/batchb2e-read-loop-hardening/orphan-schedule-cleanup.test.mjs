import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APPLY_ACKNOWLEDGEMENT,
  PRODUCTION_PROJECT_ID,
  QUIET_PERIOD_MILLISECONDS,
  assertCommandSafety,
  buildCleanupPlan,
  createDirectFirestoreReader,
  fixtureDocumentRecord,
  parseArguments,
  runCleanup,
  sha256,
  verifyPostDelete,
} from '../../scripts/operations/cleanup-orphan-league-automation-schedules.mjs';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const REVISION = 7;
const ORPHAN_ID = 'orphan-001';
const VALID_ID = 'league-001';

function missing(documentPath) {
  return fixtureDocumentRecord(documentPath, null, { exists: false });
}

function evidence(leagueId, {
  rootExists = false,
  draftExists = false,
  cycleExists = false,
  liveData = null,
  replayData = null,
} = {}) {
  return {
    leagueRoot: rootExists
      ? fixtureDocumentRecord(`leagues/${leagueId}`, { name: 'protected league' })
      : missing(`leagues/${leagueId}`),
    draft: draftExists
      ? fixtureDocumentRecord(`leagues/${leagueId}/draft/current`, { status: 'completed' })
      : missing(`leagues/${leagueId}/draft/current`),
    cycleOne: cycleExists
      ? fixtureDocumentRecord(`leagues/${leagueId}/cycles/cycle-1`, { status: 'active' })
      : missing(`leagues/${leagueId}/cycles/cycle-1`),
    liveControl: liveData
      ? fixtureDocumentRecord(`leagues/${leagueId}/liveScoring/control`, liveData)
      : missing(`leagues/${leagueId}/liveScoring/control`),
    replayControl: replayData
      ? fixtureDocumentRecord(`leagues/${leagueId}/historicalReplay/control`, replayData)
      : missing(`leagues/${leagueId}/historicalReplay/control`),
  };
}

function schedule(leagueId, data = {}, updateTime = `update-${leagueId}`) {
  return fixtureDocumentRecord(
    `leagueAutomationSchedules/${leagueId}`,
    { leagueId, queueStatus: 'idle', enabled: true, ...data },
    { updateTime, updateTimeValue: { opaque: updateTime } },
  );
}

function state({
  queueMode = 'shadow',
  queueRevision = REVISION,
  orphanSchedule = schedule(ORPHAN_ID),
  orphanEvidence = evidence(ORPHAN_ID),
  includeOrphan = true,
  includeValid = true,
  validSchedule = schedule(VALID_ID),
  validEvidence = evidence(VALID_ID, { rootExists: true }),
  queueTasks = [],
  replayTasks = [],
} = {}) {
  const schedules = [];
  const evidenceByLeagueId = new Map();
  if (includeOrphan) {
    schedules.push(orphanSchedule);
    evidenceByLeagueId.set(ORPHAN_ID, orphanEvidence);
  }
  if (includeValid) {
    schedules.push(validSchedule);
    evidenceByLeagueId.set(VALID_ID, validEvidence);
  }
  return {
    queueConfig: fixtureDocumentRecord(
      'appData/leagueAutomationQueueConfig',
      { mode: queueMode, revision: queueRevision },
    ),
    schedules,
    evidenceByLeagueId,
    queueTasks,
    replayTasks,
  };
}

function planOptions(expectedQueueRevision = REVISION) {
  return {
    projectId: PRODUCTION_PROJECT_ID,
    expectedQueueRevision,
    nowMilliseconds: NOW,
  };
}

function commandOptions(artifactDirectory, apply = false, preflightArtifactPath = '') {
  return {
    projectId: PRODUCTION_PROJECT_ID,
    apply,
    acknowledgement: apply ? APPLY_ACKNOWLEDGEMENT : '',
    expectedQueueRevision: apply ? REVISION : null,
    preflightArtifactPath,
    artifactDirectory,
    help: false,
  };
}

async function createQuietPreflightArtifact(artifactDirectory, fixtureState = state()) {
  const repository = {
    async readAuditState() { return fixtureState; },
  };
  const result = await runCleanup({
    options: commandOptions(artifactDirectory),
    repository,
    now: () => new Date(NOW - QUIET_PERIOD_MILLISECONDS - 1),
  });
  return result.artifactPath;
}

test('CLI is dry-run by default and apply requires the exact project, acknowledgement, revision, and prior artifact', () => {
  const parsed = parseArguments([`--project=${PRODUCTION_PROJECT_ID}`]);
  assert.equal(parsed.apply, false);
  assertCommandSafety(parsed);

  assert.throws(
    () => assertCommandSafety({ ...parsed, projectId: 'wrong-project' }),
    /requires --project/,
  );
  assert.throws(
    () => assertCommandSafety({ ...parsed, apply: true }),
    /Apply requires --ack/,
  );
  assert.throws(
    () => assertCommandSafety({
      ...parsed,
      apply: true,
      acknowledgement: APPLY_ACKNOWLEDGEMENT,
    }),
    /expected-queue-revision/,
  );
  assert.throws(
    () => assertCommandSafety({
      ...parsed,
      apply: true,
      acknowledgement: APPLY_ACKNOWLEDGEMENT,
      expectedQueueRevision: REVISION,
    }),
    /preflight-artifact/,
  );
});

test('the direct Firestore adapter reads references and queries through their own get method', async () => {
  const calls = [];
  const db = {
    async getAll(...references) {
      calls.push(['getAll', ...references]);
      return references;
    },
  };
  const reader = createDirectFirestoreReader(db);
  const reference = {
    async get() {
      calls.push(['get', 'reference']);
      return 'snapshot';
    },
  };

  assert.equal(await reader.get(reference), 'snapshot');
  assert.deepEqual(await reader.getAll('one', 'two'), ['one', 'two']);
  assert.deepEqual(calls, [
    ['get', 'reference'],
    ['getAll', 'one', 'two'],
  ]);
});

test('only a schedule with a missing exact league root is a deletion candidate', () => {
  const plan = buildCleanupPlan(state(), planOptions());

  assert.equal(plan.safe, true);
  assert.equal(plan.candidateCount, 1);
  assert.equal(plan.validScheduleCount, 1);
  assert.equal(plan.candidates[0].leagueId, ORPHAN_ID);
  assert.deepEqual(Object.keys(plan.validScheduleProofs), [VALID_ID]);
});

test('guard matrix fails closed for queue drift, live work, leases, tasks, and descendant evidence', () => {
  const cases = [
    ['queue-mode-not-shadow', state({ queueMode: 'canary' }), planOptions()],
    ['queue-revision-mismatch', state(), planOptions(REVISION + 1)],
    ['active-schedule-status', state({ orphanSchedule: schedule(ORPHAN_ID, { queueStatus: 'queued' }) }), planOptions()],
    ['unexpired-schedule-lease', state({ orphanSchedule: schedule(ORPHAN_ID, { activeTaskLeaseExpiresAt: NOW + 1 }) }), planOptions()],
    ['active-live-control', state({ orphanEvidence: evidence(ORPHAN_ID, { liveData: { status: 'refreshing' } }) }), planOptions()],
    ['unexpired-live-control-lease', state({ orphanEvidence: evidence(ORPHAN_ID, { liveData: { status: 'idle', leaseExpiresAt: NOW + 1 } }) }), planOptions()],
    ['active-replay-control', state({ orphanEvidence: evidence(ORPHAN_ID, { replayData: { status: 'advancing' } }) }), planOptions()],
    ['active-queue-task', state({ queueTasks: [fixtureDocumentRecord('leagueAutomationTasks/task-001', { leagueId: ORPHAN_ID, status: 'processing' })] }), planOptions()],
    ['unexpired-queue-task-lease', state({ queueTasks: [fixtureDocumentRecord('leagueAutomationTasks/task-001', { leagueId: ORPHAN_ID, status: 'error', leaseExpiresAt: NOW + 1 })] }), planOptions()],
    ['active-replay-task', state({ replayTasks: [fixtureDocumentRecord('historicalReplayRequests/replay-001', { leagueId: ORPHAN_ID, status: 'queued' })] }), planOptions()],
    ['unexpired-replay-task-lease', state({ replayTasks: [fixtureDocumentRecord('historicalReplayRequests/replay-001', { leagueId: ORPHAN_ID, status: 'completed', leaseExpiresAt: NOW + 1 })] }), planOptions()],
    ['orphan-draft-still-exists', state({ orphanEvidence: evidence(ORPHAN_ID, { draftExists: true }) }), planOptions()],
    ['orphan-cycle-still-exists', state({ orphanEvidence: evidence(ORPHAN_ID, { cycleExists: true }) }), planOptions()],
    ['schedule-league-id-mismatch', state({ orphanSchedule: schedule(ORPHAN_ID, { leagueId: 'different-id' }) }), planOptions()],
  ];

  for (const [expectedReason, fixtureState, options] of cases) {
    const plan = buildCleanupPlan(fixtureState, options);
    assert.equal(plan.safe, false, expectedReason);
    assert.ok(plan.blockingReasons[expectedReason] > 0, expectedReason);
  }
});

test('dry-run writes a private exact rollback artifact and never calls delete', async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'rinkrat-orphan-dry-'));
  let deleteCalls = 0;
  const repository = {
    async readAuditState() { return state(); },
    async deleteCandidatesAtomically() { deleteCalls += 1; },
    async readExactSchedules() { throw new Error('post-write read must not run'); },
  };

  const result = await runCleanup({
    options: commandOptions(artifactDirectory),
    repository,
    now: () => new Date(NOW),
  });
  const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8'));
  const fileStat = await stat(result.artifactPath);

  assert.equal(result.dryRun, true);
  assert.equal(deleteCalls, 0);
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.equal(artifact.candidateCount, 1);
  assert.deepEqual(artifact.candidates[0].data, state().schedules[0].serializedData);
  assert.equal(artifact.candidates[0].updateTime, state().schedules[0].updateTime);
  assert.equal(artifact.candidates[0].dataChecksum, sha256(artifact.candidates[0].data));
});

test('apply deletes only candidates while allowing a valid schedule to advance after commit', async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'rinkrat-orphan-apply-'));
  const preflightArtifactPath = await createQuietPreflightArtifact(artifactDirectory);
  let currentState = state();
  let deleteCalls = 0;
  const repository = {
    async readAuditState() { return currentState; },
    async deleteCandidatesAtomically(plan) {
      deleteCalls += 1;
      assert.equal((await readdir(artifactDirectory)).length, 2, 'apply artifact must predate writes');
      assert.deepEqual(plan.candidates.map((candidate) => candidate.leagueId), [ORPHAN_ID]);
      currentState = state({
        includeOrphan: false,
        validSchedule: schedule(VALID_ID, { lastOutcome: 'updated normally' }, 'update-valid-new'),
      });
    },
    async readExactSchedules(ids) {
      return ids.map((id) => missing(`leagueAutomationSchedules/${id}`));
    },
  };

  const result = await runCleanup({
    options: commandOptions(artifactDirectory, true, preflightArtifactPath),
    repository,
    now: () => new Date(NOW),
  });

  assert.equal(result.applied, true);
  assert.equal(deleteCalls, 1);
  assert.deepEqual(result.verification, {
    removedCount: 1,
    remainingValidCount: 1,
    observedValidScheduleChangedAfterCommit: 1,
  });
});

test('post verification fails if a schedule that was valid before cleanup disappears', () => {
  const before = state();
  const plan = buildCleanupPlan(before, planOptions());
  const after = state({ includeOrphan: false, includeValid: false });
  const exactCandidates = [missing(`leagueAutomationSchedules/${ORPHAN_ID}`)];

  assert.throws(
    () => verifyPostDelete(plan, after, exactCandidates, planOptions()),
    /valid before cleanup is missing/,
  );
});

test('apply aborts before artifact or writes when the second preflight changes', async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'rinkrat-orphan-drift-'));
  const preflightArtifactPath = await createQuietPreflightArtifact(artifactDirectory);
  const changed = state({
    orphanSchedule: schedule(ORPHAN_ID, { enabled: false }, 'update-orphan-changed'),
  });
  let reads = 0;
  let deleteCalls = 0;
  const repository = {
    async readAuditState() { reads += 1; return reads === 1 ? state() : changed; },
    async deleteCandidatesAtomically() { deleteCalls += 1; },
  };

  await assert.rejects(
    runCleanup({
      options: commandOptions(artifactDirectory, true, preflightArtifactPath),
      repository,
      now: () => new Date(NOW),
    }),
    /changed between preflight reads/,
  );
  assert.equal(deleteCalls, 0);
  assert.equal((await readdir(artifactDirectory)).length, 1);
});

test('a repeated apply with no candidates is an idempotent no-op', async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'rinkrat-orphan-repeat-'));
  const preflightArtifactPath = await createQuietPreflightArtifact(artifactDirectory);
  const noOrphans = state({ includeOrphan: false });
  let deleteCalls = 0;
  const repository = {
    async readAuditState() { return noOrphans; },
    async deleteCandidatesAtomically() { deleteCalls += 1; },
  };

  const result = await runCleanup({
    options: commandOptions(artifactDirectory, true, preflightArtifactPath),
    repository,
    now: () => new Date(NOW),
  });

  assert.equal(result.repeatedNoOp, true);
  assert.equal(deleteCalls, 0);
});

test('apply rejects a recently created preflight artifact before any write', async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'rinkrat-orphan-recent-'));
  const dryRun = await runCleanup({
    options: commandOptions(artifactDirectory),
    repository: { async readAuditState() { return state(); } },
    now: () => new Date(NOW),
  });
  let deleteCalls = 0;

  await assert.rejects(
    runCleanup({
      options: commandOptions(artifactDirectory, true, dryRun.artifactPath),
      repository: {
        async readAuditState() { return state(); },
        async deleteCandidatesAtomically() { deleteCalls += 1; },
      },
      now: () => new Date(NOW),
    }),
    /15-minute quiet period/,
  );
  assert.equal(deleteCalls, 0);
});

test('apply rejects a tampered preflight artifact before any write', async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), 'rinkrat-orphan-tamper-'));
  const preflightArtifactPath = await createQuietPreflightArtifact(artifactDirectory);
  const artifact = JSON.parse(await readFile(preflightArtifactPath, 'utf8'));
  artifact.candidates[0].data.enabled = false;
  await writeFile(preflightArtifactPath, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
  let deleteCalls = 0;

  await assert.rejects(
    runCleanup({
      options: commandOptions(artifactDirectory, true, preflightArtifactPath),
      repository: {
        async readAuditState() { return state(); },
        async deleteCandidatesAtomically() { deleteCalls += 1; },
      },
      now: () => new Date(NOW),
    }),
    /malformed or tampered/,
  );
  assert.equal(deleteCalls, 0);
});

test('implementation uses one transaction and last-update-time delete preconditions', async () => {
  const source = await readFile(
    new URL('../../scripts/operations/cleanup-orphan-league-automation-schedules.mjs', import.meta.url),
    'utf8',
  );

  assert.match(source, /db\.runTransaction\(/);
  assert.match(source, /lastUpdateTime: candidate\.schedule\.updateTimeValue/);
  assert.doesNotMatch(source, /console\.log\([^\n]*leagueId/);
});

test('B2E keeps the scoring and Cycle 1 liveness schedules unchanged and documents the guarded boundary', async () => {
  const [automation, packageSource, runbook, handoff] = await Promise.all([
    readFile(new URL('../../functions/src/league-automation.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    readFile(
      new URL('../../docs/RINKRAT_OPERATIONS_B2E_READ_LOOP_HARDENING.md', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../../docs/RINKRAT_CODEX_HANDOFF.md', import.meta.url), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(
    automation,
    /export const dispatchDueLeagueAutomation = onSchedule\([\s\S]*?schedule: '\* \* \* \* \*'/,
  );
  assert.match(
    automation,
    /export const runSeasonStartAutomation = onSchedule\([\s\S]*?schedule: '\* \* \* \* \*'/,
  );
  assert.match(
    automation,
    /export const initializeSeasonAfterDraft = onDocumentWritten\([\s\S]*?retry: false/,
  );
  assert.equal(
    packageJson.scripts['operations:orphan-schedule-cleanup'],
    'node scripts/operations/cleanup-orphan-league-automation-schedules.mjs --project=nhl-fantasy-app-ab673',
  );
  assert.match(packageJson.scripts['verify:batchb2e:core'], /verify:batchb2d:core/);
  assert.match(packageJson.scripts['verify:batchb2e:core'], /test:batchb2e:run/);
  assert.match(runbook, /15-minute quiet period/);
  assert.match(runbook, /runSeasonStartAutomation` remains every minute/);
  assert.match(runbook, /Only the projection recovery Function requires deployment/);
  assert.match(handoff, /B2E is the read-loop hardening candidate/);
});
