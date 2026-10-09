#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { open, mkdir, chmod, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_PROJECT_ID = 'nhl-fantasy-app-ab673';
export const APPLY_ACKNOWLEDGEMENT =
  'DELETE_VERIFIED_ORPHAN_SCHEDULES_IN_nhl-fantasy-app-ab673';
export const QUIET_PERIOD_MILLISECONDS = 15 * 60 * 1_000;

const ACTIVE_QUEUE_STATUSES = new Set(['queued', 'processing', 'retrying']);
const ACTIVE_REPLAY_STATUSES = new Set(['queued', 'processing']);
const ACTIVE_REPLAY_CONTROL_STATUSES = new Set(['queued', 'advancing']);
const MAX_ATOMIC_SCHEDULE_COUNT = 50;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function optionValue(options, name) {
  const value = options.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export function parseArguments(argv) {
  const known = new Set([
    'project',
    'apply',
    'ack',
    'expected-queue-revision',
    'preflight-artifact',
    'artifact-dir',
    'help',
  ]);
  const options = new Map();

  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      throw new Error('Only named --option arguments are accepted.');
    }

    const equalsIndex = argument.indexOf('=');
    const name = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    const value = equalsIndex === -1 ? true : argument.slice(equalsIndex + 1);

    if (!known.has(name)) {
      throw new Error(`Unknown option --${name}.`);
    }
    if (options.has(name)) {
      throw new Error(`Option --${name} may be supplied only once.`);
    }
    if ((name === 'apply' || name === 'help') && value !== true) {
      throw new Error(`Option --${name} does not accept a value.`);
    }

    options.set(name, value);
  }

  const expectedRevisionText = optionValue(options, 'expected-queue-revision');
  const expectedQueueRevision = expectedRevisionText
    ? Number.parseInt(expectedRevisionText, 10)
    : null;

  if (
    expectedRevisionText &&
    (!/^\d+$/.test(expectedRevisionText) || !Number.isSafeInteger(expectedQueueRevision))
  ) {
    throw new Error('--expected-queue-revision must be a non-negative integer.');
  }

  return {
    projectId: optionValue(options, 'project'),
    apply: options.has('apply'),
    acknowledgement: optionValue(options, 'ack'),
    expectedQueueRevision,
    preflightArtifactPath: optionValue(options, 'preflight-artifact'),
    artifactDirectory: optionValue(options, 'artifact-dir') || path.join(
      projectRoot,
      '.security-reports',
      'orphan-schedule-cleanup',
    ),
    help: options.has('help'),
  };
}

export function assertCommandSafety(options) {
  if (options.projectId !== PRODUCTION_PROJECT_ID) {
    throw new Error(
      `This narrowly scoped tool requires --project=${PRODUCTION_PROJECT_ID}.`,
    );
  }

  if (!options.apply) {
    return;
  }

  if (options.acknowledgement !== APPLY_ACKNOWLEDGEMENT) {
    throw new Error(
      `Apply requires --ack=${APPLY_ACKNOWLEDGEMENT}.`,
    );
  }
  if (!Number.isSafeInteger(options.expectedQueueRevision)) {
    throw new Error('Apply requires --expected-queue-revision=<current revision>.');
  }
  if (!options.preflightArtifactPath) {
    throw new Error('Apply requires --preflight-artifact=<prior dry-run artifact>.');
  }
}

function timestampParts(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const seconds = Number(value.seconds ?? value._seconds);
  const nanoseconds = Number(value.nanoseconds ?? value._nanoseconds);
  if (
    Number.isSafeInteger(seconds) &&
    Number.isSafeInteger(nanoseconds) &&
    nanoseconds >= 0 &&
    nanoseconds < 1_000_000_000
  ) {
    return { seconds, nanoseconds };
  }

  return null;
}

export function serializeFirestoreValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : { __firestoreType: 'non-finite-number', value: String(value) };
  }
  if (typeof value === 'bigint') {
    return { __firestoreType: 'bigint', value: value.toString() };
  }
  if (typeof value === 'undefined') {
    return { __firestoreType: 'undefined' };
  }
  if (value instanceof Date) {
    return { __firestoreType: 'date', iso: value.toISOString() };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return {
      __firestoreType: 'bytes',
      base64: Buffer.from(value).toString('base64'),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => serializeFirestoreValue(entry));
  }

  const timestamp = timestampParts(value);
  if (timestamp) {
    return {
      __firestoreType: 'timestamp',
      seconds: timestamp.seconds,
      nanoseconds: timestamp.nanoseconds,
    };
  }
  if (
    typeof value?.latitude === 'number' &&
    typeof value?.longitude === 'number'
  ) {
    return {
      __firestoreType: 'geo-point',
      latitude: value.latitude,
      longitude: value.longitude,
    };
  }
  if (
    typeof value?.path === 'string' &&
    value?.firestore &&
    typeof value?.id === 'string'
  ) {
    return { __firestoreType: 'document-reference', path: value.path };
  }
  if (typeof value?.toBase64 === 'function') {
    return { __firestoreType: 'bytes', base64: value.toBase64() };
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, serializeFirestoreValue(value[key])]),
    );
  }

  throw new Error(`Unsupported Firestore value type: ${typeof value}.`);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function timeText(value) {
  const serialized = serializeFirestoreValue(value);
  return serialized?.__firestoreType === 'timestamp'
    ? `${serialized.seconds}.${String(serialized.nanoseconds).padStart(9, '0')}`
    : null;
}

export function documentRecord(snapshot, expectedPath = snapshot?.ref?.path ?? '') {
  const exists = snapshot?.exists === true;
  const data = exists ? (snapshot.data?.() ?? snapshot.data ?? {}) : null;
  const serializedData = exists ? serializeFirestoreValue(data) : null;
  const updateTime = exists ? timeText(snapshot.updateTime) : null;
  const createTime = exists ? timeText(snapshot.createTime) : null;
  const record = {
    id: snapshot?.id ?? expectedPath.split('/').at(-1) ?? '',
    path: snapshot?.ref?.path ?? expectedPath,
    exists,
    data,
    serializedData,
    createTime,
    updateTime,
    updateTimeValue: snapshot?.updateTime ?? null,
    checksum: sha256(serializedData),
  };
  record.proofChecksum = sha256({
    path: record.path,
    exists: record.exists,
    updateTime: record.updateTime,
    checksum: record.checksum,
  });
  return record;
}

export function fixtureDocumentRecord(pathValue, data = null, options = {}) {
  const exists = options.exists ?? data !== null;
  const serializedData = exists ? serializeFirestoreValue(data ?? {}) : null;
  const updateTime = exists ? (options.updateTime ?? 'fixture-update-1') : null;
  const record = {
    id: pathValue.split('/').at(-1) ?? '',
    path: pathValue,
    exists,
    data: exists ? (data ?? {}) : null,
    serializedData,
    createTime: exists ? (options.createTime ?? 'fixture-create-1') : null,
    updateTime,
    updateTimeValue: options.updateTimeValue ?? updateTime,
    checksum: sha256(serializedData),
  };
  record.proofChecksum = sha256({
    path: record.path,
    exists: record.exists,
    updateTime: record.updateTime,
    checksum: record.checksum,
  });
  return record;
}

function field(record, name) {
  return record?.exists ? record.data?.[name] : undefined;
}

function toMilliseconds(value) {
  if (value && typeof value.toMillis === 'function') {
    const milliseconds = value.toMillis();
    return Number.isFinite(milliseconds) ? milliseconds : 0;
  }
  const parts = timestampParts(value);
  if (parts) {
    return (parts.seconds * 1_000) + Math.floor(parts.nanoseconds / 1_000_000);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const milliseconds = new Date(value).getTime();
    return Number.isFinite(milliseconds) ? milliseconds : 0;
  }
  return 0;
}

function sortedRecords(records) {
  return [...records].sort((left, right) => left.path.localeCompare(right.path));
}

function incrementReason(reasons, code) {
  reasons.set(code, (reasons.get(code) ?? 0) + 1);
}

function activeTaskRecordsForLeague(state, leagueId, schedule, replayControl) {
  const activeTaskId = typeof field(schedule, 'activeTaskId') === 'string'
    ? field(schedule, 'activeTaskId')
    : '';
  const activeReplayRequestId = typeof field(replayControl, 'activeRequestId') === 'string'
    ? field(replayControl, 'activeRequestId')
    : '';
  const queueTasks = state.queueTasks.filter((record) =>
    field(record, 'leagueId') === leagueId || record.id === activeTaskId
  );
  const replayTasks = state.replayTasks.filter((record) =>
    field(record, 'leagueId') === leagueId || record.id === activeReplayRequestId
  );
  return { queueTasks, replayTasks };
}

export function buildCleanupPlan(state, options) {
  const nowMilliseconds = options.nowMilliseconds;
  const reasons = new Map();
  const queueMode = state.queueConfig.exists
    ? String(field(state.queueConfig, 'mode') ?? 'shadow')
    : 'shadow';
  const queueRevisionValue = state.queueConfig.exists
    ? Number(field(state.queueConfig, 'revision') ?? 0)
    : 0;
  const queueRevision = Number.isFinite(queueRevisionValue)
    ? Math.max(0, Math.trunc(queueRevisionValue))
    : 0;

  if (options.projectId !== PRODUCTION_PROJECT_ID) {
    incrementReason(reasons, 'wrong-project');
  }
  if (queueMode !== 'shadow') {
    incrementReason(reasons, 'queue-mode-not-shadow');
  }
  if (
    Number.isSafeInteger(options.expectedQueueRevision) &&
    queueRevision !== options.expectedQueueRevision
  ) {
    incrementReason(reasons, 'queue-revision-mismatch');
  }
  if (state.schedules.length > MAX_ATOMIC_SCHEDULE_COUNT) {
    incrementReason(reasons, 'atomic-schedule-limit-exceeded');
  }

  const candidates = [];
  const validSchedules = [];

  for (const schedule of sortedRecords(state.schedules)) {
    const leagueId = schedule.id;
    const evidence = state.evidenceByLeagueId.get(leagueId);

    if (!DOCUMENT_ID_PATTERN.test(leagueId)) {
      incrementReason(reasons, 'invalid-schedule-id');
      continue;
    }
    if (!evidence) {
      incrementReason(reasons, 'missing-exact-evidence');
      continue;
    }
    if (field(schedule, 'leagueId') !== leagueId) {
      incrementReason(reasons, 'schedule-league-id-mismatch');
    }

    const queueStatus = String(field(schedule, 'queueStatus') ?? '');
    const queueLeaseExpiresAt = toMilliseconds(field(schedule, 'activeTaskLeaseExpiresAt'));
    const liveControlStatus = String(field(evidence.liveControl, 'status') ?? '');
    const liveLeaseExpiresAt = toMilliseconds(field(evidence.liveControl, 'leaseExpiresAt'));
    const replayControlStatus = String(field(evidence.replayControl, 'status') ?? '');
    const { queueTasks, replayTasks } = activeTaskRecordsForLeague(
      state,
      leagueId,
      schedule,
      evidence.replayControl,
    );

    if (ACTIVE_QUEUE_STATUSES.has(queueStatus)) {
      incrementReason(reasons, 'active-schedule-status');
    }
    if (queueLeaseExpiresAt > nowMilliseconds) {
      incrementReason(reasons, 'unexpired-schedule-lease');
    }
    if (liveControlStatus === 'refreshing') {
      incrementReason(reasons, 'active-live-control');
    }
    if (liveLeaseExpiresAt > nowMilliseconds) {
      incrementReason(reasons, 'unexpired-live-control-lease');
    }
    if (ACTIVE_REPLAY_CONTROL_STATUSES.has(replayControlStatus)) {
      incrementReason(reasons, 'active-replay-control');
    }
    if (queueTasks.some((record) => ACTIVE_QUEUE_STATUSES.has(String(field(record, 'status') ?? '')))) {
      incrementReason(reasons, 'active-queue-task');
    }
    if (queueTasks.some((record) => toMilliseconds(field(record, 'leaseExpiresAt')) > nowMilliseconds)) {
      incrementReason(reasons, 'unexpired-queue-task-lease');
    }
    if (replayTasks.some((record) => ACTIVE_REPLAY_STATUSES.has(String(field(record, 'status') ?? '')))) {
      incrementReason(reasons, 'active-replay-task');
    }
    if (replayTasks.some((record) => toMilliseconds(field(record, 'leaseExpiresAt')) > nowMilliseconds)) {
      incrementReason(reasons, 'unexpired-replay-task-lease');
    }

    if (evidence.leagueRoot.exists) {
      validSchedules.push(schedule);
      continue;
    }

    if (evidence.draft.exists) {
      incrementReason(reasons, 'orphan-draft-still-exists');
    }
    if (evidence.cycleOne.exists) {
      incrementReason(reasons, 'orphan-cycle-still-exists');
    }

    candidates.push({
      leagueId,
      schedule,
      evidence,
      queueTasks,
      replayTasks,
    });
  }

  for (const task of state.queueTasks) {
    if (ACTIVE_QUEUE_STATUSES.has(String(field(task, 'status') ?? ''))) {
      incrementReason(reasons, 'active-queue-task-global');
    }
    if (toMilliseconds(field(task, 'leaseExpiresAt')) > nowMilliseconds) {
      incrementReason(reasons, 'unexpired-queue-task-lease-global');
    }
  }
  for (const task of state.replayTasks) {
    if (ACTIVE_REPLAY_STATUSES.has(String(field(task, 'status') ?? ''))) {
      incrementReason(reasons, 'active-replay-task-global');
    }
    if (toMilliseconds(field(task, 'leaseExpiresAt')) > nowMilliseconds) {
      incrementReason(reasons, 'unexpired-replay-task-lease-global');
    }
  }

  const stateFingerprint = sha256({
    queueConfig: state.queueConfig.proofChecksum,
    schedules: sortedRecords(state.schedules).map((record) => record.proofChecksum),
    evidence: [...state.evidenceByLeagueId.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([leagueId, evidence]) => ({
        leagueId,
        leagueRoot: evidence.leagueRoot.proofChecksum,
        draft: evidence.draft.proofChecksum,
        cycleOne: evidence.cycleOne.proofChecksum,
        liveControl: evidence.liveControl.proofChecksum,
        replayControl: evidence.replayControl.proofChecksum,
      })),
    queueTasks: sortedRecords(state.queueTasks).map((record) => record.proofChecksum),
    replayTasks: sortedRecords(state.replayTasks).map((record) => record.proofChecksum),
  });

  return {
    projectId: options.projectId,
    queueMode,
    queueRevision,
    queueConfigProof: state.queueConfig.proofChecksum,
    inspectedScheduleCount: state.schedules.length,
    candidateCount: candidates.length,
    validScheduleCount: validSchedules.length,
    candidates,
    validScheduleProofs: Object.fromEntries(
      validSchedules.map((record) => [record.id, record.proofChecksum]),
    ),
    scheduleProofs: Object.fromEntries(
      state.schedules.map((record) => [record.id, record.proofChecksum]),
    ),
    blockingReasons: Object.fromEntries([...reasons.entries()].sort()),
    safe: reasons.size === 0,
    stateFingerprint,
  };
}

export function assertPlanSafe(plan) {
  if (!plan.safe) {
    const summary = Object.entries(plan.blockingReasons)
      .map(([code, count]) => `${code}:${count}`)
      .join(', ');
    throw new Error(`Cleanup safety checks failed (${summary}).`);
  }
}

export function buildRollbackArtifact(plan, createdAtIso) {
  return {
    schemaVersion: 1,
    operation: 'orphan-league-automation-schedule-cleanup',
    projectId: plan.projectId,
    createdAt: createdAtIso,
    queueMode: plan.queueMode,
    queueRevision: plan.queueRevision,
    queueConfigProof: plan.queueConfigProof,
    inspectedScheduleCount: plan.inspectedScheduleCount,
    validScheduleCount: plan.validScheduleCount,
    candidateCount: plan.candidateCount,
    stateFingerprint: plan.stateFingerprint,
    validScheduleProofs: plan.validScheduleProofs,
    candidates: plan.candidates.map((candidate) => ({
      documentPath: candidate.schedule.path,
      createTime: candidate.schedule.createTime,
      updateTime: candidate.schedule.updateTime,
      dataChecksum: candidate.schedule.checksum,
      proofChecksum: candidate.schedule.proofChecksum,
      data: candidate.schedule.serializedData,
      evidence: {
        leagueRoot: candidate.evidence.leagueRoot.proofChecksum,
        draft: candidate.evidence.draft.proofChecksum,
        cycleOne: candidate.evidence.cycleOne.proofChecksum,
        liveControl: candidate.evidence.liveControl.proofChecksum,
        replayControl: candidate.evidence.replayControl.proofChecksum,
        queueTaskProofs: candidate.queueTasks.map((record) => record.proofChecksum),
        replayTaskProofs: candidate.replayTasks.map((record) => record.proofChecksum),
      },
    })),
  };
}

export async function writeRollbackArtifact(artifactDirectory, artifact) {
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await chmod(artifactDirectory, 0o700);
  const timestamp = artifact.createdAt.replace(/[:.]/g, '-');
  const fileName = `${timestamp}-${artifact.stateFingerprint.slice(0, 12)}.json`;
  const outputPath = path.join(artifactDirectory, fileName);
  const handle = await open(outputPath, 'wx', 0o600);

  try {
    await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  return outputPath;
}

export async function readPrivatePreflightArtifact(artifactPath) {
  const metadata = await lstat(artifactPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('The preflight artifact must be a regular file, not a link.');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('The preflight artifact must not grant group or other permissions.');
  }

  let artifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
  } catch {
    throw new Error('The preflight artifact is not valid JSON.');
  }
  return artifact;
}

function sortedProofs(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value].sort()
    : null;
}

export function assertQuietPeriodArtifact(artifact, plan, options, nowMilliseconds) {
  if (
    !artifact ||
    artifact.schemaVersion !== 1 ||
    artifact.operation !== 'orphan-league-automation-schedule-cleanup'
  ) {
    throw new Error('The preflight artifact schema or operation is not recognized.');
  }
  if (artifact.projectId !== PRODUCTION_PROJECT_ID || artifact.projectId !== options.projectId) {
    throw new Error('The preflight artifact project does not match the guarded Production project.');
  }
  if (artifact.queueMode !== 'shadow' || artifact.queueRevision !== options.expectedQueueRevision) {
    throw new Error('The preflight artifact does not prove the expected Shadow queue revision.');
  }

  const createdAtMilliseconds = Date.parse(artifact.createdAt);
  if (
    !Number.isFinite(createdAtMilliseconds) ||
    createdAtMilliseconds > nowMilliseconds ||
    nowMilliseconds - createdAtMilliseconds < QUIET_PERIOD_MILLISECONDS
  ) {
    throw new Error('The preflight artifact has not completed the required 15-minute quiet period.');
  }
  if (
    !Array.isArray(artifact.candidates) ||
    artifact.candidateCount !== artifact.candidates.length
  ) {
    throw new Error('The preflight artifact candidate manifest is malformed.');
  }

  const priorCandidates = new Map();
  for (const candidate of artifact.candidates) {
    const documentPath = candidate?.documentPath;
    const leagueId = typeof documentPath === 'string' &&
      documentPath.startsWith('leagueAutomationSchedules/')
      ? documentPath.slice('leagueAutomationSchedules/'.length)
      : '';
    const queueTaskProofs = sortedProofs(candidate?.evidence?.queueTaskProofs);
    const replayTaskProofs = sortedProofs(candidate?.evidence?.replayTaskProofs);
    if (
      !DOCUMENT_ID_PATTERN.test(leagueId) ||
      documentPath !== `leagueAutomationSchedules/${leagueId}` ||
      priorCandidates.has(leagueId) ||
      typeof candidate.updateTime !== 'string' ||
      typeof candidate.dataChecksum !== 'string' ||
      candidate.dataChecksum !== sha256(candidate.data) ||
      candidate.proofChecksum !== sha256({
        path: documentPath,
        exists: true,
        updateTime: candidate.updateTime,
        checksum: candidate.dataChecksum,
      }) ||
      typeof candidate?.evidence?.leagueRoot !== 'string' ||
      typeof candidate?.evidence?.draft !== 'string' ||
      typeof candidate?.evidence?.cycleOne !== 'string' ||
      typeof candidate?.evidence?.liveControl !== 'string' ||
      typeof candidate?.evidence?.replayControl !== 'string' ||
      queueTaskProofs === null ||
      replayTaskProofs === null
    ) {
      throw new Error('The preflight artifact candidate proof is malformed or tampered.');
    }
    priorCandidates.set(leagueId, {
      ...candidate,
      queueTaskProofs,
      replayTaskProofs,
    });
  }

  // A repeated apply after a verified successful delete is deliberately a no-op.
  if (plan.candidateCount === 0) {
    return;
  }
  if (priorCandidates.size !== plan.candidateCount) {
    throw new Error('The candidate set changed during the required quiet period.');
  }
  for (const candidate of plan.candidates) {
    const prior = priorCandidates.get(candidate.leagueId);
    const currentQueueTaskProofs = candidate.queueTasks
      .map((record) => record.proofChecksum)
      .sort();
    const currentReplayTaskProofs = candidate.replayTasks
      .map((record) => record.proofChecksum)
      .sort();
    if (
      !prior ||
      prior.proofChecksum !== candidate.schedule.proofChecksum ||
      prior.updateTime !== candidate.schedule.updateTime ||
      prior.dataChecksum !== candidate.schedule.checksum ||
      prior.evidence.leagueRoot !== candidate.evidence.leagueRoot.proofChecksum ||
      prior.evidence.draft !== candidate.evidence.draft.proofChecksum ||
      prior.evidence.cycleOne !== candidate.evidence.cycleOne.proofChecksum ||
      prior.evidence.liveControl !== candidate.evidence.liveControl.proofChecksum ||
      prior.evidence.replayControl !== candidate.evidence.replayControl.proofChecksum ||
      canonicalJson(prior.queueTaskProofs) !== canonicalJson(currentQueueTaskProofs) ||
      canonicalJson(prior.replayTaskProofs) !== canonicalJson(currentReplayTaskProofs)
    ) {
      throw new Error('Candidate evidence changed during the required quiet period.');
    }
  }
}

function comparePreflightPlans(first, second) {
  if (first.stateFingerprint !== second.stateFingerprint) {
    throw new Error('Firestore evidence changed between preflight reads; no documents were deleted.');
  }
  if (first.queueRevision !== second.queueRevision || first.queueMode !== second.queueMode) {
    throw new Error('Queue configuration changed between preflight reads; no documents were deleted.');
  }
}

export function verifyPostDelete(plan, postState, exactCandidateRecords, options) {
  const postPlan = buildCleanupPlan(postState, options);

  if (postPlan.queueMode !== plan.queueMode || postPlan.queueRevision !== plan.queueRevision) {
    throw new Error('Queue mode or revision changed during cleanup. Use the rollback artifact before proceeding.');
  }
  if (postPlan.queueConfigProof !== plan.queueConfigProof) {
    throw new Error('Queue configuration bytes changed during cleanup. Use the rollback artifact before proceeding.');
  }
  if (exactCandidateRecords.some((record) => record.exists)) {
    throw new Error('At least one candidate schedule still exists after cleanup.');
  }

  const expectedValidIds = Object.keys(plan.validScheduleProofs).sort();
  let observedValidScheduleChangedAfterCommit = 0;
  for (const leagueId of expectedValidIds) {
    if (!postPlan.scheduleProofs[leagueId]) {
      throw new Error('A schedule that was valid before cleanup is missing after cleanup.');
    }
    if (postPlan.scheduleProofs[leagueId] !== plan.validScheduleProofs[leagueId]) {
      observedValidScheduleChangedAfterCommit += 1;
    }
  }

  return {
    removedCount: plan.candidateCount,
    remainingValidCount: expectedValidIds.length,
    observedValidScheduleChangedAfterCommit,
  };
}

export async function runCleanup({ options, repository, now = () => new Date() }) {
  assertCommandSafety(options);
  const operationTime = now();
  const preflightArtifact = options.apply
    ? await readPrivatePreflightArtifact(options.preflightArtifactPath)
    : null;
  const planOptions = {
    projectId: options.projectId,
    expectedQueueRevision: options.expectedQueueRevision,
    nowMilliseconds: operationTime.getTime(),
  };
  const firstState = await repository.readAuditState();
  const firstPlan = buildCleanupPlan(firstState, planOptions);
  assertPlanSafe(firstPlan);
  if (preflightArtifact) {
    assertQuietPeriodArtifact(
      preflightArtifact,
      firstPlan,
      options,
      operationTime.getTime(),
    );
  }

  let plan = firstPlan;
  if (options.apply) {
    const secondState = await repository.readAuditState();
    const secondPlan = buildCleanupPlan(secondState, planOptions);
    assertPlanSafe(secondPlan);
    comparePreflightPlans(firstPlan, secondPlan);
    assertQuietPeriodArtifact(
      preflightArtifact,
      secondPlan,
      options,
      operationTime.getTime(),
    );
    plan = secondPlan;
  }

  const artifact = buildRollbackArtifact(plan, operationTime.toISOString());
  const artifactPath = await writeRollbackArtifact(options.artifactDirectory, artifact);

  if (!options.apply || plan.candidateCount === 0) {
    return {
      applied: false,
      dryRun: !options.apply,
      repeatedNoOp: options.apply && plan.candidateCount === 0,
      plan,
      artifactPath,
    };
  }

  await repository.deleteCandidatesAtomically(plan, planOptions);
  const postState = await repository.readAuditState();
  const exactCandidateRecords = await repository.readExactSchedules(
    plan.candidates.map((candidate) => candidate.leagueId),
  );
  const verification = verifyPostDelete(
    plan,
    postState,
    exactCandidateRecords,
    planOptions,
  );

  return {
    applied: true,
    dryRun: false,
    repeatedNoOp: false,
    plan,
    artifactPath,
    verification,
  };
}

function refsForSchedule(db, leagueId) {
  return {
    leagueRoot: db.doc(`leagues/${leagueId}`),
    draft: db.doc(`leagues/${leagueId}/draft/current`),
    cycleOne: db.doc(`leagues/${leagueId}/cycles/cycle-1`),
    liveControl: db.doc(`leagues/${leagueId}/liveScoring/control`),
    replayControl: db.doc(`leagues/${leagueId}/historicalReplay/control`),
  };
}

async function loadAuditState(reader, db) {
  const queueConfigRef = db.doc('appData/leagueAutomationQueueConfig');
  const schedulesQuery = db.collection('leagueAutomationSchedules');
  const activeQueueTasksQuery = db.collection('leagueAutomationTasks')
    .where('status', 'in', [...ACTIVE_QUEUE_STATUSES]);
  const activeReplayTasksQuery = db.collection('historicalReplayRequests')
    .where('status', 'in', [...ACTIVE_REPLAY_STATUSES]);
  const [queueConfigSnapshot, schedulesSnapshot, activeQueueSnapshot, activeReplaySnapshot] =
    await Promise.all([
      reader.get(queueConfigRef),
      reader.get(schedulesQuery),
      reader.get(activeQueueTasksQuery),
      reader.get(activeReplayTasksQuery),
    ]);
  const schedules = schedulesSnapshot.docs.map((snapshot) => documentRecord(snapshot));
  const evidenceRefs = schedules.flatMap((schedule) => {
    const refs = refsForSchedule(db, schedule.id);
    return [refs.leagueRoot, refs.draft, refs.cycleOne, refs.liveControl, refs.replayControl];
  });
  const evidenceSnapshots = evidenceRefs.length > 0
    ? await reader.getAll(...evidenceRefs)
    : [];
  const evidenceByLeagueId = new Map();

  schedules.forEach((schedule, index) => {
    const offset = index * 5;
    const refs = refsForSchedule(db, schedule.id);
    evidenceByLeagueId.set(schedule.id, {
      leagueRoot: documentRecord(evidenceSnapshots[offset], refs.leagueRoot.path),
      draft: documentRecord(evidenceSnapshots[offset + 1], refs.draft.path),
      cycleOne: documentRecord(evidenceSnapshots[offset + 2], refs.cycleOne.path),
      liveControl: documentRecord(evidenceSnapshots[offset + 3], refs.liveControl.path),
      replayControl: documentRecord(evidenceSnapshots[offset + 4], refs.replayControl.path),
    });
  });

  const exactTaskRefs = [];
  for (const schedule of schedules) {
    const activeTaskId = field(schedule, 'activeTaskId');
    const activeRequestId = field(evidenceByLeagueId.get(schedule.id)?.replayControl, 'activeRequestId');
    if (typeof activeTaskId === 'string' && DOCUMENT_ID_PATTERN.test(activeTaskId)) {
      exactTaskRefs.push(db.doc(`leagueAutomationTasks/${activeTaskId}`));
    }
    if (typeof activeRequestId === 'string' && DOCUMENT_ID_PATTERN.test(activeRequestId)) {
      exactTaskRefs.push(db.doc(`historicalReplayRequests/${activeRequestId}`));
    }
  }
  const uniqueExactRefs = [...new Map(exactTaskRefs.map((ref) => [ref.path, ref])).values()];
  const exactTaskSnapshots = uniqueExactRefs.length > 0
    ? await reader.getAll(...uniqueExactRefs)
    : [];
  const queueTasksByPath = new Map(
    activeQueueSnapshot.docs.map((snapshot) => {
      const record = documentRecord(snapshot);
      return [record.path, record];
    }),
  );
  const replayTasksByPath = new Map(
    activeReplaySnapshot.docs.map((snapshot) => {
      const record = documentRecord(snapshot);
      return [record.path, record];
    }),
  );

  exactTaskSnapshots.forEach((snapshot) => {
    const record = documentRecord(snapshot);
    if (!record.exists) return;
    if (record.path.startsWith('leagueAutomationTasks/')) {
      queueTasksByPath.set(record.path, record);
    } else if (record.path.startsWith('historicalReplayRequests/')) {
      replayTasksByPath.set(record.path, record);
    }
  });

  return {
    queueConfig: documentRecord(queueConfigSnapshot, queueConfigRef.path),
    schedules,
    evidenceByLeagueId,
    queueTasks: [...queueTasksByPath.values()],
    replayTasks: [...replayTasksByPath.values()],
  };
}

export function createDirectFirestoreReader(db) {
  return {
    get(referenceOrQuery) {
      return referenceOrQuery.get();
    },
    getAll(...documentReferences) {
      return db.getAll(...documentReferences);
    },
  };
}

export async function createFirestoreRepository(projectId) {
  const functionsRequire = createRequire(path.join(projectRoot, 'functions/package.json'));
  const { applicationDefault, deleteApp, getApps, initializeApp } =
    functionsRequire('firebase-admin/app');
  const { getFirestore } = functionsRequire('firebase-admin/firestore');
  const appName = `rinkrat-orphan-schedule-cleanup-${process.pid}-${Date.now()}`;
  const app = initializeApp(
    { credential: applicationDefault(), projectId },
    appName,
  );
  const db = getFirestore(app);
  const directReader = createDirectFirestoreReader(db);

  return {
    async readAuditState() {
      return loadAuditState(directReader, db);
    },
    async readExactSchedules(leagueIds) {
      if (leagueIds.length === 0) return [];
      const refs = leagueIds.map((leagueId) =>
        db.doc(`leagueAutomationSchedules/${leagueId}`)
      );
      const snapshots = await db.getAll(...refs);
      return snapshots.map((snapshot, index) => documentRecord(snapshot, refs[index].path));
    },
    async deleteCandidatesAtomically(expectedPlan, planOptions) {
      await db.runTransaction(async (transaction) => {
        const state = await loadAuditState(transaction, db);
        const transactionPlan = buildCleanupPlan(state, planOptions);
        assertPlanSafe(transactionPlan);
        comparePreflightPlans(expectedPlan, transactionPlan);

        for (const candidate of transactionPlan.candidates) {
          transaction.delete(
            db.doc(candidate.schedule.path),
            { lastUpdateTime: candidate.schedule.updateTimeValue },
          );
        }
      });
    },
    async close() {
      if (getApps().some((candidate) => candidate.name === appName)) {
        await deleteApp(app);
      }
    },
  };
}

function printHelp() {
  console.log(`Usage:
  node scripts/operations/cleanup-orphan-league-automation-schedules.mjs \\
    --project=${PRODUCTION_PROJECT_ID}

Dry-run is the default. Apply additionally requires:
  --apply
  --expected-queue-revision=<current revision>
  --preflight-artifact=<private dry-run artifact at least 15 minutes old>
  --ack=${APPLY_ACKNOWLEDGEMENT}

The tool writes a private local rollback artifact before any Firestore delete.`);
}

function printResult(result) {
  console.log('RinkRat orphan schedule cleanup');
  console.log(`Mode: ${result.dryRun ? 'dry-run' : result.repeatedNoOp ? 'apply-no-op' : 'apply'}`);
  console.log(`Schedules inspected: ${result.plan.inspectedScheduleCount}`);
  console.log(`Protected valid schedules: ${result.plan.validScheduleCount}`);
  console.log(`Verified missing-root candidates: ${result.plan.candidateCount}`);
  console.log(`Rollback artifact: ${result.artifactPath}`);
  if (result.applied) {
    console.log(`Schedules removed and verified absent: ${result.verification.removedCount}`);
    console.log(
      'Valid schedules that advanced after the guarded transaction: '
      + result.verification.observedValidScheduleChangedAfterCommit,
    );
  } else if (result.repeatedNoOp) {
    console.log('No candidate schedules remain; no Firestore writes were issued.');
  } else {
    console.log('Dry-run complete; no Firestore writes were issued.');
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  assertCommandSafety(options);
  const repository = await createFirestoreRepository(options.projectId);

  try {
    const result = await runCleanup({ options, repository });
    printResult(result);
  } finally {
    await repository.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `Orphan schedule cleanup stopped safely: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
