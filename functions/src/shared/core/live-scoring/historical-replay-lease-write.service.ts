import {
  type DocumentData,
  type DocumentReference,
  FieldValue,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';

import {
  shouldPauseLeagueAutomationForHistoricalReplay,
  type HistoricalReplayLeaseTrigger,
} from './historical-replay-lease-guard.util';

export interface LeagueAutomationLeaseClaimResult {
  claimed: boolean;
  reason: string;
  nextRefreshAtMilliseconds?: number;
}

export interface LeagueAutomationLeaseTransactionInput {
  transaction: Transaction;
  controlRef: DocumentReference<DocumentData>;
  replayControlRef: DocumentReference<DocumentData>;
  scheduleRef: DocumentReference<DocumentData>;
  leagueId: string;
  scheduleShard: number;
  scheduleSchemaVersion: number;
  workerId: string;
  serverWorkerPrefix: string;
  trigger: HistoricalReplayLeaseTrigger;
  force: boolean;
  nowMilliseconds: number;
  leaseMilliseconds: number;
}

export interface LeagueAutomationTaskRetryInput {
  scheduleRef: DocumentReference<DocumentData>;
  replayControlRef: DocumentReference<DocumentData>;
  taskRef: DocumentReference<DocumentData>;
  taskId: string;
  errorMessage: string;
  errorCode: string;
  nowMilliseconds: number;
  processingLeaseMilliseconds: number;
  taskHistoryRetentionMilliseconds: number;
}

export interface LeagueAutomationTaskStartInput {
  scheduleRef: DocumentReference<DocumentData>;
  replayControlRef: DocumentReference<DocumentData>;
  taskRef: DocumentReference<DocumentData>;
  taskId: string;
  leagueId: string;
  scheduleShard: number;
  scheduleSchemaVersion: number;
  expectedDueAtMilliseconds: number;
  expectedCanonicalSourceVersion: string;
  nowMilliseconds: number;
  processingLeaseMilliseconds: number;
  taskHistoryRetentionMilliseconds: number;
}

export interface LeagueAutomationScheduleOutcomeInput {
  scheduleRef: DocumentReference<DocumentData>;
  replayControlRef: DocumentReference<DocumentData>;
  data: Record<string, unknown>;
  trigger: HistoricalReplayLeaseTrigger;
}

export interface LeagueAutomationEnqueueFailureInput {
  scheduleRef: DocumentReference<DocumentData>;
  replayControlRef: DocumentReference<DocumentData>;
  taskRef: DocumentReference<DocumentData>;
  taskId: string;
  errorMessage: string;
  errorCode: string;
  nowMilliseconds: number;
  retryAtMilliseconds: number;
  taskHistoryRetentionMilliseconds: number;
}

export interface LeagueAutomationStaleRecoveryInput {
  scheduleRef: DocumentReference<DocumentData>;
  replayControlRef: DocumentReference<DocumentData>;
  taskCollectionPath: string;
  nowMilliseconds: number;
  taskHistoryRetentionMilliseconds: number;
}

export interface LeagueAutomationStaleRecoveryResult {
  recovered: boolean;
  reason: 'not-stale' | 'historical-replay' | 'stale-task-recovered';
  taskId: string;
}

export interface HistoricalReplayScheduleParkInput {
  transaction: Transaction;
  scheduleRef: DocumentReference<DocumentData>;
  leagueId: string;
  scheduleShard: number;
  scheduleSchemaVersion: number;
}

export interface HistoricalReplayControlScheduleWriteInput {
  controlRef: DocumentReference<DocumentData>;
  scheduleRef: DocumentReference<DocumentData>;
  leagueId: string;
  scheduleShard: number;
  scheduleSchemaVersion: number;
  controlData: Record<string, unknown>;
}

export interface LeagueAutomationTaskCompletionWriteInput {
  transaction: Transaction;
  taskRef: DocumentReference<DocumentData>;
  currentTaskData: Record<string, unknown> | undefined;
  completionData: Record<string, unknown>;
}

export interface LeagueAutomationTaskStartResult {
  started: boolean;
  reason:
    | 'processing'
    | 'historical-replay'
    | 'terminal-task'
    | 'already-processing'
    | 'task-not-runnable'
    | 'schedule-missing'
    | 'scoring-disabled'
    | 'stale-task';
}

function toTimestampMilliseconds(value: unknown): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toMillis' in value &&
    typeof value.toMillis === 'function'
  ) {
    const milliseconds = value.toMillis();
    return Number.isFinite(milliseconds) ? milliseconds : 0;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const milliseconds = new Date(value).getTime();
    return Number.isFinite(milliseconds) ? milliseconds : 0;
  }

  return 0;
}

export function historicalReplaySchedulePauseFields(): Record<string, unknown> {
  return {
    scoringEnabled: false,
    queueStatus: 'paused',
    pausedReason: 'historical-replay',
    nextScoringAt: FieldValue.delete(),
    activeTaskId: null,
    activeTaskDueAt: FieldValue.delete(),
    activeTaskCanonicalSourceVersion: FieldValue.delete(),
    activeTaskCanonicalRequestedAt: FieldValue.delete(),
    activeTaskCanonicalGameIds: [],
    activeTaskCanonicalGameVersions: [],
    activeTaskLeaseExpiresAt: FieldValue.delete(),
  };
}

export function parkLeagueAutomationScheduleForHistoricalReplayInTransaction(
  input: HistoricalReplayScheduleParkInput,
): void {
  input.transaction.set(
    input.scheduleRef,
    {
      schemaVersion: input.scheduleSchemaVersion,
      leagueId: input.leagueId,
      shard: input.scheduleShard,
      ...historicalReplaySchedulePauseFields(),
      lastOutcome: 'paused',
      lastTrigger: 'historical-replay',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Reasserts raw replay authority and the recurring-scoring pause as one
 * atomic state transition. `enabled` is deliberately forced to true so no
 * caller can publish replay-owned control state without the matching pause.
 */
export async function writeHistoricalReplayControlAndParkSchedule(
  input: HistoricalReplayControlScheduleWriteInput,
): Promise<void> {
  await input.controlRef.firestore.runTransaction(async (transaction) => {
    transaction.set(
      input.controlRef,
      {
        ...input.controlData,
        enabled: true,
      },
      { merge: true },
    );
    parkLeagueAutomationScheduleForHistoricalReplayInTransaction({
      transaction,
      scheduleRef: input.scheduleRef,
      leagueId: input.leagueId,
      scheduleShard: input.scheduleShard,
      scheduleSchemaVersion: input.scheduleSchemaVersion,
    });
  });
}

function isTerminalLeagueAutomationTaskStatus(status: string): boolean {
  return status === 'completed' ||
    status === 'skipped' ||
    status === 'stale-recovered' ||
    status === 'enqueue-error';
}

export function isLeagueAutomationTaskCompletionEligible(
  value: Record<string, unknown> | undefined,
): boolean {
  return value?.['status'] === 'processing';
}

export function writeLeagueAutomationTaskCompletionInTransaction(
  input: LeagueAutomationTaskCompletionWriteInput,
): boolean {
  if (!isLeagueAutomationTaskCompletionEligible(input.currentTaskData)) {
    return false;
  }

  input.transaction.set(
    input.taskRef,
    input.completionData,
    { merge: true },
  );
  return true;
}

function markTaskSkippedInTransaction(
  transaction: Transaction,
  input: LeagueAutomationTaskStartInput,
  skipReason: string,
): void {
  transaction.set(
    input.taskRef,
    {
      status: 'skipped',
      skipReason,
      completedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(
        input.nowMilliseconds + input.taskHistoryRetentionMilliseconds,
      ),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Writes an ordinary schedule outcome while ensuring an explicit Historical
 * Replay run can never re-enable recurring live scoring on success, failure,
 * or a skipped lease attempt.
 */
export async function writeLeagueAutomationScheduleOutcome(
  input: LeagueAutomationScheduleOutcomeInput,
): Promise<void> {
  await input.scheduleRef.firestore.runTransaction(async (transaction) => {
    const replaySnapshot = input.trigger === 'historical-replay'
      ? null
      : await transaction.get(input.replayControlRef);
    const historicalReplayOwnsScoring =
      input.trigger === 'historical-replay' ||
      replaySnapshot?.data()?.['enabled'] === true;

    transaction.set(
      input.scheduleRef,
      {
        ...input.data,
        ...(historicalReplayOwnsScoring
          ? historicalReplaySchedulePauseFields()
          : {}),
      },
      { merge: true },
    );
  });
}

/**
 * Executes the Historical Replay authority decision and live-scoring lease
 * decision in one Firestore transaction. Callers must return this result from
 * the same runTransaction callback so Firestore can retry both reads together.
 */
export async function claimLeagueAutomationLeaseInTransaction(
  input: LeagueAutomationLeaseTransactionInput,
): Promise<LeagueAutomationLeaseClaimResult> {
  const [controlSnapshot, replaySnapshot] = await Promise.all([
    input.transaction.get(input.controlRef),
    input.trigger === 'historical-replay'
      ? Promise.resolve(null)
      : input.transaction.get(input.replayControlRef),
  ]);
  const control = controlSnapshot.data() ?? {};

  if (
    shouldPauseLeagueAutomationForHistoricalReplay(
      replaySnapshot?.data(),
      input.trigger,
    )
  ) {
    parkLeagueAutomationScheduleForHistoricalReplayInTransaction(input);

    return {
      claimed: false,
      reason: 'historical-replay',
    };
  }

  const holderClientId =
    typeof control['holderClientId'] === 'string'
      ? control['holderClientId']
      : '';
  const leaseExpiresAt = toTimestampMilliseconds(control['leaseExpiresAt']);
  const nextRefreshAt = toTimestampMilliseconds(control['nextRefreshAt']);
  const currentStatus =
    typeof control['status'] === 'string'
      ? control['status']
      : '';
  const anotherServerWorkerOwnsLease =
    currentStatus === 'refreshing' &&
    holderClientId.startsWith(input.serverWorkerPrefix) &&
    holderClientId !== input.workerId &&
    leaseExpiresAt > input.nowMilliseconds;

  if (anotherServerWorkerOwnsLease) {
    return {
      claimed: false,
      reason: 'another-server-worker',
    };
  }

  if (!input.force && nextRefreshAt > input.nowMilliseconds) {
    return {
      claimed: false,
      reason: 'not-due',
      nextRefreshAtMilliseconds: nextRefreshAt,
    };
  }

  input.transaction.set(
    input.controlRef,
    {
      id: 'control',
      schemaVersion: 2,
      automationMode: 'server',
      serverAutomationEnabled: true,
      status: 'refreshing',
      holderUserId: null,
      holderClientId: input.workerId,
      leaseExpiresAt: Timestamp.fromMillis(
        input.nowMilliseconds + input.leaseMilliseconds,
      ),
      lastRefreshStartedAt: FieldValue.serverTimestamp(),
      lastRefreshReason: input.trigger,
      serverTrigger: input.trigger,
      lastError: '',
      updatedAt: FieldValue.serverTimestamp(),
      ...(!controlSnapshot.exists
        ? {
            nextRefreshAt: Timestamp.fromMillis(input.nowMilliseconds),
            lastRefreshCompletedAt: null,
          }
        : {}),
    },
    { merge: true },
  );

  return {
    claimed: true,
    reason: 'claimed',
  };
}

/**
 * Starts a queued scoring task only after its task identity, schedule identity,
 * and Historical Replay authority have been read in one transaction. Duplicate
 * terminal deliveries remain immutable, and replay activation serializes ahead
 * of any processing-state write.
 */
export async function beginLeagueAutomationTask(
  input: LeagueAutomationTaskStartInput,
): Promise<LeagueAutomationTaskStartResult> {
  return input.scheduleRef.firestore.runTransaction(async (transaction) => {
    const [scheduleSnapshot, replaySnapshot, taskSnapshot] = await Promise.all([
      transaction.get(input.scheduleRef),
      transaction.get(input.replayControlRef),
      transaction.get(input.taskRef),
    ]);
    const schedule = scheduleSnapshot.data() ?? {};
    const task = taskSnapshot.data() ?? {};
    const taskStatus = typeof task['status'] === 'string' ? task['status'] : '';

    if (replaySnapshot.data()?.['enabled'] === true) {
      parkLeagueAutomationScheduleForHistoricalReplayInTransaction({
        transaction,
        scheduleRef: input.scheduleRef,
        leagueId: input.leagueId,
        scheduleShard: input.scheduleShard,
        scheduleSchemaVersion: input.scheduleSchemaVersion,
      });

      if (
        taskStatus !== 'processing' &&
        !isTerminalLeagueAutomationTaskStatus(taskStatus)
      ) {
        markTaskSkippedInTransaction(transaction, input, 'historical-replay');
      }

      return { started: false, reason: 'historical-replay' };
    }

    if (isTerminalLeagueAutomationTaskStatus(taskStatus)) {
      return { started: false, reason: 'terminal-task' };
    }

    if (taskStatus === 'processing') {
      return { started: false, reason: 'already-processing' };
    }

    if (taskStatus !== 'queued' && taskStatus !== 'retrying') {
      return { started: false, reason: 'task-not-runnable' };
    }

    if (!scheduleSnapshot.exists) {
      markTaskSkippedInTransaction(transaction, input, 'schedule-missing');
      return { started: false, reason: 'schedule-missing' };
    }

    const activeTaskId =
      typeof schedule['activeTaskId'] === 'string'
        ? schedule['activeTaskId']
        : '';
    const activeTaskCanonicalSourceVersion =
      typeof schedule['activeTaskCanonicalSourceVersion'] === 'string'
        ? schedule['activeTaskCanonicalSourceVersion']
        : '';
    const scoringDisabled = schedule['scoringEnabled'] === false;
    const staleTask = activeTaskId !== input.taskId ||
      toTimestampMilliseconds(schedule['activeTaskDueAt']) !==
        Math.trunc(input.expectedDueAtMilliseconds) ||
      (Boolean(input.expectedCanonicalSourceVersion) &&
        activeTaskCanonicalSourceVersion !==
          input.expectedCanonicalSourceVersion);

    if (scoringDisabled || staleTask) {
      const reason = scoringDisabled ? 'scoring-disabled' : 'stale-task';
      markTaskSkippedInTransaction(transaction, input, reason);
      return { started: false, reason };
    }

    transaction.set(
      input.scheduleRef,
      {
        queueStatus: 'processing',
        activeTaskLeaseExpiresAt: Timestamp.fromMillis(
          input.nowMilliseconds + input.processingLeaseMilliseconds,
        ),
        lastQueueStartedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      input.taskRef,
      {
        status: 'processing',
        attemptCount: FieldValue.increment(1),
        startedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { started: true, reason: 'processing' };
  });
}

/**
 * A late error must never resurrect a queue task that already completed or a
 * schedule parked by Historical Replay. This includes uncertain responses
 * after a successful completion transaction.
 */
export async function preserveReplayPauseOrMarkTaskRetrying(
  input: LeagueAutomationTaskRetryInput,
): Promise<'preserved' | 'retrying'> {
  return input.scheduleRef.firestore.runTransaction(async (transaction) => {
    const [scheduleSnapshot, replaySnapshot, taskSnapshot] = await Promise.all([
      transaction.get(input.scheduleRef),
      transaction.get(input.replayControlRef),
      transaction.get(input.taskRef),
    ]);
    const schedule = scheduleSnapshot.data() ?? {};
    const task = taskSnapshot.data() ?? {};
    const taskStatus = typeof task['status'] === 'string' ? task['status'] : '';
    const retryEligibleTask =
      taskStatus === 'processing' || taskStatus === 'retrying';
    const replayPaused =
      replaySnapshot.data()?.['enabled'] === true ||
      (
        schedule['scoringEnabled'] === false &&
        schedule['queueStatus'] === 'paused' &&
        schedule['pausedReason'] === 'historical-replay'
      );

    if (!retryEligibleTask) {
      return 'preserved';
    }

    if (replayPaused) {
      transaction.set(
        input.scheduleRef,
        {
          ...historicalReplaySchedulePauseFields(),
          lastOutcome: 'paused',
          lastTrigger: 'historical-replay',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        input.taskRef,
        {
          status: 'skipped',
          skipReason: 'historical-replay',
          lastError: '',
          lastErrorCode: '',
          completedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(
            input.nowMilliseconds + input.taskHistoryRetentionMilliseconds,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return 'preserved';
    }

    const activeTaskId =
      typeof schedule['activeTaskId'] === 'string'
        ? schedule['activeTaskId']
        : '';

    // A late failure from an expired task cannot reclaim the schedule after a
    // newer task has become authoritative. The stale-recovery worker owns the
    // next retry whenever this identity no longer matches.
    if (activeTaskId !== input.taskId) {
      return 'preserved';
    }

    const leaseExpiresAt =
      input.nowMilliseconds + input.processingLeaseMilliseconds;

    transaction.set(
      input.scheduleRef,
      {
        queueStatus: 'processing',
        activeTaskId: input.taskId,
        activeTaskLeaseExpiresAt: Timestamp.fromMillis(leaseExpiresAt),
        lastQueueError: input.errorMessage.slice(0, 500),
        lastQueueErrorCode: input.errorCode,
        lastQueueErrorAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      input.taskRef,
      {
        status: 'retrying',
        lastError: input.errorMessage.slice(0, 500),
        lastErrorCode: input.errorCode,
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return 'retrying';
  });
}

/**
 * Releases an enqueue claim without overwriting a replay pause, a terminal
 * task, or a newer task owner. The task and schedule always settle in the same
 * transaction.
 */
export async function preserveReplayPauseOrRecordEnqueueFailure(
  input: LeagueAutomationEnqueueFailureInput,
): Promise<'preserved' | 'historical-replay' | 'enqueue-error'> {
  return input.scheduleRef.firestore.runTransaction(async (transaction) => {
    const [scheduleSnapshot, replaySnapshot, taskSnapshot] = await Promise.all([
      transaction.get(input.scheduleRef),
      transaction.get(input.replayControlRef),
      transaction.get(input.taskRef),
    ]);
    const schedule = scheduleSnapshot.data() ?? {};
    const task = taskSnapshot.data() ?? {};
    const taskStatus = typeof task['status'] === 'string' ? task['status'] : '';
    const activeTaskId =
      typeof schedule['activeTaskId'] === 'string'
        ? schedule['activeTaskId']
        : '';

    if (replaySnapshot.data()?.['enabled'] === true) {
      transaction.set(
        input.scheduleRef,
        {
          ...historicalReplaySchedulePauseFields(),
          lastOutcome: 'paused',
          lastTrigger: 'historical-replay',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      if (!isTerminalLeagueAutomationTaskStatus(taskStatus)) {
        transaction.set(
          input.taskRef,
          {
            status: 'skipped',
            skipReason: 'historical-replay',
            lastError: '',
            lastErrorCode: '',
            completedAt: FieldValue.serverTimestamp(),
            expiresAt: Timestamp.fromMillis(
              input.nowMilliseconds + input.taskHistoryRetentionMilliseconds,
            ),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      return 'historical-replay';
    }

    if (
      isTerminalLeagueAutomationTaskStatus(taskStatus) ||
      activeTaskId !== input.taskId ||
      taskStatus !== 'queued'
    ) {
      return 'preserved';
    }

    transaction.set(
      input.scheduleRef,
      {
        queueStatus: 'error',
        activeTaskId: null,
        activeTaskDueAt: FieldValue.delete(),
        activeTaskCanonicalSourceVersion: FieldValue.delete(),
        activeTaskCanonicalRequestedAt: FieldValue.delete(),
        activeTaskCanonicalGameIds: [],
        activeTaskCanonicalGameVersions: [],
        activeTaskLeaseExpiresAt: FieldValue.delete(),
        nextScoringAt: Timestamp.fromMillis(input.retryAtMilliseconds),
        lastQueueError: input.errorMessage.slice(0, 500),
        lastQueueErrorCode: input.errorCode,
        lastQueueErrorAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      input.taskRef,
      {
        status: 'enqueue-error',
        lastError: input.errorMessage.slice(0, 500),
        lastErrorCode: input.errorCode,
        expiresAt: Timestamp.fromMillis(
          input.nowMilliseconds + input.taskHistoryRetentionMilliseconds,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return 'enqueue-error';
  });
}

/**
 * Recovers one stale queued/processing schedule and its exact task atomically.
 * Replay authority wins over retry scheduling, while pre-existing terminal
 * task evidence remains immutable.
 */
export async function recoverStaleLeagueAutomationTask(
  input: LeagueAutomationStaleRecoveryInput,
): Promise<LeagueAutomationStaleRecoveryResult> {
  return input.scheduleRef.firestore.runTransaction(async (transaction) => {
    const [scheduleSnapshot, replaySnapshot] = await Promise.all([
      transaction.get(input.scheduleRef),
      transaction.get(input.replayControlRef),
    ]);
    const schedule = scheduleSnapshot.data() ?? {};
    const queueStatus =
      typeof schedule['queueStatus'] === 'string'
        ? schedule['queueStatus']
        : '';
    const leaseExpiresAt = toTimestampMilliseconds(
      schedule['activeTaskLeaseExpiresAt'],
    );
    const activeTaskId =
      typeof schedule['activeTaskId'] === 'string'
        ? schedule['activeTaskId']
        : '';

    if (
      (queueStatus !== 'queued' && queueStatus !== 'processing') ||
      leaseExpiresAt <= 0 ||
      leaseExpiresAt > input.nowMilliseconds
    ) {
      return { recovered: false, reason: 'not-stale', taskId: '' };
    }

    const validActiveTaskId = /^[A-Za-z0-9_-]{1,128}$/.test(activeTaskId);

    if (replaySnapshot.data()?.['enabled'] === true && !validActiveTaskId) {
      transaction.set(
        input.scheduleRef,
        {
          ...historicalReplaySchedulePauseFields(),
          lastOutcome: 'paused',
          lastTrigger: 'historical-replay',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return {
        recovered: true,
        reason: 'historical-replay',
        taskId: '',
      };
    }

    if (!validActiveTaskId) {
      return { recovered: false, reason: 'not-stale', taskId: '' };
    }

    const taskRef = input.scheduleRef.firestore.doc(
      `${input.taskCollectionPath}/${activeTaskId}`,
    );
    const taskSnapshot = await transaction.get(taskRef);
    const task = taskSnapshot.data() ?? {};
    const taskStatus = typeof task['status'] === 'string' ? task['status'] : '';

    if (replaySnapshot.data()?.['enabled'] === true) {
      transaction.set(
        input.scheduleRef,
        {
          ...historicalReplaySchedulePauseFields(),
          lastOutcome: 'paused',
          lastTrigger: 'historical-replay',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      if (!isTerminalLeagueAutomationTaskStatus(taskStatus)) {
        transaction.set(
          taskRef,
          {
            status: 'skipped',
            skipReason: 'historical-replay',
            completedAt: FieldValue.serverTimestamp(),
            expiresAt: Timestamp.fromMillis(
              input.nowMilliseconds + input.taskHistoryRetentionMilliseconds,
            ),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      return {
        recovered: true,
        reason: 'historical-replay',
        taskId: activeTaskId,
      };
    }

    transaction.set(
      input.scheduleRef,
      {
        queueStatus: 'error',
        activeTaskId: null,
        activeTaskDueAt: FieldValue.delete(),
        activeTaskCanonicalSourceVersion: FieldValue.delete(),
        activeTaskCanonicalRequestedAt: FieldValue.delete(),
        activeTaskCanonicalGameIds: [],
        activeTaskCanonicalGameVersions: [],
        activeTaskLeaseExpiresAt: FieldValue.delete(),
        nextScoringAt: Timestamp.fromMillis(input.nowMilliseconds),
        lastQueueError: 'A queued scoring worker stopped reporting progress. The league was released for a safe retry.',
        lastQueueErrorCode: 'stale-task-recovered',
        lastQueueErrorAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (!isTerminalLeagueAutomationTaskStatus(taskStatus)) {
      transaction.set(
        taskRef,
        {
          status: 'stale-recovered',
          lastErrorCode: 'stale-task-recovered',
          completedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(
            input.nowMilliseconds + input.taskHistoryRetentionMilliseconds,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    return {
      recovered: true,
      reason: 'stale-task-recovered',
      taskId: activeTaskId,
    };
  });
}
