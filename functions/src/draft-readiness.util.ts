import { createHash } from 'node:crypto';

export const DRAFT_READINESS_WINDOW_MILLISECONDS = 20 * 60 * 1000;
export const DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS = 25 * 60 * 1000;
export const DRAFT_AVAILABILITY_PREPARATION_WINDOW_MILLISECONDS =
  DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS;
export const DRAFT_AVAILABILITY_REFRESH_BUCKET_MILLISECONDS = 5 * 60 * 1000;
export const DRAFT_AVAILABILITY_MAX_AGE_MILLISECONDS = 24 * 60 * 60 * 1000;
export const DRAFT_AVAILABILITY_STANDARD_ERROR_COOLDOWN_MILLISECONDS =
  15 * 60 * 1000;
export const DRAFT_AVAILABILITY_TASK_ERROR_COOLDOWN_MILLISECONDS = 25 * 1000;
export const DRAFT_AVAILABILITY_MAX_ERROR_BACKOFF_MILLISECONDS =
  15 * 60 * 1000;
export const DRAFT_AVAILABILITY_OVERDUE_RECOVERY_MILLISECONDS =
  60 * 60 * 1000;
export const DRAFT_START_TASK_WARMUP_LEAD_MILLISECONDS = 10_000;
export const DRAFT_START_TASK_ENQUEUE_DELAY_MILLISECONDS = 250;

export type DraftServerReadinessStatus =
  | 'waiting-injury'
  | 'preparing-projection'
  | 'ready'
  | 'error';

export type DraftReadinessWindowState =
  | 'outside-window'
  | 'prepare'
  | 'start-due'
  | 'unavailable';

export type DraftAvailabilityPreparationState =
  | 'outside-window'
  | 'prepare'
  | 'recovery-expired'
  | 'unavailable';

export type ScheduledDraftStartTaskState =
  | 'open'
  | 'early'
  | 'stale';

export type DraftNearTermScheduleGateState =
  | 'not-scheduled'
  | 'safe-lead'
  | 'exact-ready'
  | 'requires-exact-readiness';

export interface DraftAvailabilityEvidenceInput {
  revision: string | null;
  lastSuccessfulAt: string | null;
  lastDailySyncKey: string | null;
  status: string | null;
  draftReadinessSourceComplete: boolean | null;
  draftReadinessSourceAttemptId: string | null;
  refreshAttemptId: string | null;
  nowMilliseconds: number;
  requiredThroughMilliseconds?: number;
}

export interface DraftAvailabilityRefreshTaskPayload {
  expectedDailyKey: string;
  requestedAtBucketMilliseconds: number;
}

export function getDraftAvailabilityDailyKey(
  nowMilliseconds: number,
): string | null {
  if (!Number.isFinite(nowMilliseconds)) {
    return null;
  }

  const date = new Date(nowMilliseconds);

  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
}

export function isDraftAvailabilityRefreshInErrorCooldown(input: {
  lastAttemptMilliseconds: number | null;
  nowMilliseconds: number;
  strictDraftTask: boolean;
}): boolean {
  if (
    input.lastAttemptMilliseconds === null ||
    !Number.isFinite(input.lastAttemptMilliseconds) ||
    !Number.isFinite(input.nowMilliseconds)
  ) {
    return false;
  }

  const ageMilliseconds =
    input.nowMilliseconds - input.lastAttemptMilliseconds;
  const cooldownMilliseconds = input.strictDraftTask
    ? DRAFT_AVAILABILITY_TASK_ERROR_COOLDOWN_MILLISECONDS
    : DRAFT_AVAILABILITY_STANDARD_ERROR_COOLDOWN_MILLISECONDS;

  return ageMilliseconds >= 0 && ageMilliseconds < cooldownMilliseconds;
}

export function getDraftAvailabilityErrorBackoffMilliseconds(
  consecutiveFailureCount: number,
): number {
  if (
    !Number.isSafeInteger(consecutiveFailureCount) ||
    consecutiveFailureCount <= 0
  ) {
    return DRAFT_AVAILABILITY_MAX_ERROR_BACKOFF_MILLISECONDS;
  }

  return Math.min(
    DRAFT_AVAILABILITY_MAX_ERROR_BACKOFF_MILLISECONDS,
    DRAFT_AVAILABILITY_TASK_ERROR_COOLDOWN_MILLISECONDS *
      2 ** Math.min(consecutiveFailureCount - 1, 20),
  );
}

export function isDraftAvailabilityTaskRetryAfterActive(input: {
  strictDraftTask: boolean;
  previousFailureWasStrictDraftTask: boolean;
  sameTaskBucketRetry: boolean;
  retryAfterMilliseconds: number | null;
  nowMilliseconds: number;
}): boolean {
  return input.strictDraftTask &&
    input.previousFailureWasStrictDraftTask &&
    !input.sameTaskBucketRetry &&
    input.retryAfterMilliseconds !== null &&
    Number.isFinite(input.retryAfterMilliseconds) &&
    Number.isFinite(input.nowMilliseconds) &&
    input.retryAfterMilliseconds > input.nowMilliseconds;
}

export function getDraftNearTermScheduleGateState(input: {
  scheduledStartMilliseconds: number | null;
  nowMilliseconds: number;
  exactReadinessVerified: boolean;
}): DraftNearTermScheduleGateState {
  if (
    input.scheduledStartMilliseconds === null ||
    !Number.isFinite(input.scheduledStartMilliseconds) ||
    !Number.isFinite(input.nowMilliseconds)
  ) {
    return 'not-scheduled';
  }

  const leadMilliseconds =
    input.scheduledStartMilliseconds - input.nowMilliseconds;

  if (leadMilliseconds >= DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS) {
    return 'safe-lead';
  }

  return input.exactReadinessVerified
    ? 'exact-ready'
    : 'requires-exact-readiness';
}

export function getEarliestSafeUnpreparedDraftStartMilliseconds(
  nowMilliseconds: number,
): number | null {
  return Number.isFinite(nowMilliseconds)
    ? nowMilliseconds + DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS
    : null;
}

export function getDraftReadinessWindowState(input: {
  draftStatus: string | null;
  scheduledStartMilliseconds: number | null;
  nowMilliseconds: number;
}): DraftReadinessWindowState {
  if (
    input.draftStatus !== 'scheduled' ||
    input.scheduledStartMilliseconds === null ||
    !Number.isFinite(input.scheduledStartMilliseconds) ||
    !Number.isFinite(input.nowMilliseconds)
  ) {
    return 'unavailable';
  }

  const millisecondsRemaining =
    input.scheduledStartMilliseconds - input.nowMilliseconds;

  if (millisecondsRemaining <= 0) {
    return 'start-due';
  }

  return millisecondsRemaining <= DRAFT_READINESS_WINDOW_MILLISECONDS
    ? 'prepare'
    : 'outside-window';
}

export function getDraftAvailabilityPreparationState(input: {
  draftStatus: string | null;
  scheduledStartMilliseconds: number | null;
  nowMilliseconds: number;
}): DraftAvailabilityPreparationState {
  if (
    input.draftStatus !== 'scheduled' ||
    input.scheduledStartMilliseconds === null ||
    !Number.isFinite(input.scheduledStartMilliseconds) ||
    !Number.isFinite(input.nowMilliseconds)
  ) {
    return 'unavailable';
  }

  const millisecondsRemaining =
    input.scheduledStartMilliseconds - input.nowMilliseconds;

  if (
    millisecondsRemaining <
      -DRAFT_AVAILABILITY_OVERDUE_RECOVERY_MILLISECONDS
  ) {
    return 'recovery-expired';
  }

  return millisecondsRemaining <= DRAFT_AVAILABILITY_PREPARATION_WINDOW_MILLISECONDS
    ? 'prepare'
    : 'outside-window';
}

export function buildDraftAvailabilityRefreshTaskId(input: {
  dailyKey: string;
  nowMilliseconds: number;
}): string {
  const bucketStartMilliseconds = Math.floor(
    input.nowMilliseconds / DRAFT_AVAILABILITY_REFRESH_BUCKET_MILLISECONDS,
  ) * DRAFT_AVAILABILITY_REFRESH_BUCKET_MILLISECONDS;

  return createHash('sha256')
    .update(`draft-availability:${input.dailyKey}:${bucketStartMilliseconds}`)
    .digest('hex')
    .slice(0, 40);
}

export function isDraftAvailabilityEvidenceUsable(
  input: DraftAvailabilityEvidenceInput,
): boolean {
  if (
    !input.revision ||
    !input.lastSuccessfulAt ||
    input.status !== 'success' ||
    input.draftReadinessSourceComplete !== true ||
    !input.draftReadinessSourceAttemptId ||
    input.draftReadinessSourceAttemptId !== input.refreshAttemptId
  ) {
    return false;
  }

  const lastSuccessfulMilliseconds = Date.parse(input.lastSuccessfulAt);

  if (
    !Number.isFinite(lastSuccessfulMilliseconds) ||
    !Number.isFinite(input.nowMilliseconds) ||
    (
      input.requiredThroughMilliseconds !== undefined &&
      !Number.isFinite(input.requiredThroughMilliseconds)
    )
  ) {
    return false;
  }

  const requiredThroughMilliseconds = Math.max(
    input.nowMilliseconds,
    input.requiredThroughMilliseconds ?? input.nowMilliseconds,
  );
  const currentAgeMilliseconds =
    input.nowMilliseconds - lastSuccessfulMilliseconds;
  const requiredThroughAgeMilliseconds =
    requiredThroughMilliseconds - lastSuccessfulMilliseconds;
  const evidenceDailySyncKey = new Date(lastSuccessfulMilliseconds)
    .toISOString()
    .slice(0, 10);

  return currentAgeMilliseconds >= 0 &&
    requiredThroughAgeMilliseconds <= DRAFT_AVAILABILITY_MAX_AGE_MILLISECONDS &&
    input.lastDailySyncKey === evidenceDailySyncKey;
}

export function buildDraftReadinessRequestKey(input: {
  leagueId: string;
  scheduledStartMilliseconds: number;
  availabilityRevision: string;
}): string {
  return `draft-readiness-${createHash('sha256')
    .update([
      input.leagueId,
      String(input.scheduledStartMilliseconds),
      input.availabilityRevision,
    ].join(':'))
    .digest('hex')
    .slice(0, 40)}`;
}

export function draftReadinessMatchesSchedule(input: {
  readinessScheduledStartMilliseconds: number | null;
  scheduledStartMilliseconds: number | null;
}): boolean {
  return input.readinessScheduledStartMilliseconds !== null &&
    input.scheduledStartMilliseconds !== null &&
    Number.isFinite(input.readinessScheduledStartMilliseconds) &&
    input.readinessScheduledStartMilliseconds === input.scheduledStartMilliseconds;
}

export function buildScheduledDraftStartTaskId(input: {
  leagueId: string;
  scheduledStartMilliseconds: number;
}): string {
  return createHash('sha256')
    .update(
      `scheduled-draft-start:${input.leagueId}:${input.scheduledStartMilliseconds}`,
    )
    .digest('hex')
    .slice(0, 40);
}

export function getScheduledDraftStartTaskDispatchMilliseconds(input: {
  scheduledStartMilliseconds: number;
  nowMilliseconds: number;
}): number | null {
  if (
    !Number.isFinite(input.scheduledStartMilliseconds) ||
    !Number.isFinite(input.nowMilliseconds)
  ) {
    return null;
  }

  return Math.max(
    input.nowMilliseconds + DRAFT_START_TASK_ENQUEUE_DELAY_MILLISECONDS,
    input.scheduledStartMilliseconds - DRAFT_START_TASK_WARMUP_LEAD_MILLISECONDS,
  );
}

export function getScheduledDraftStartTaskState(input: {
  draftStatus: string | null;
  expectedScheduledStartMilliseconds: number;
  actualScheduledStartMilliseconds: number | null;
  nowMilliseconds: number;
}): ScheduledDraftStartTaskState {
  if (
    input.draftStatus !== 'scheduled' ||
    !Number.isFinite(input.expectedScheduledStartMilliseconds) ||
    input.actualScheduledStartMilliseconds === null ||
    !Number.isFinite(input.actualScheduledStartMilliseconds) ||
    input.actualScheduledStartMilliseconds !== input.expectedScheduledStartMilliseconds
  ) {
    return 'stale';
  }

  return input.nowMilliseconds + 100 < input.expectedScheduledStartMilliseconds
    ? 'early'
    : 'open';
}
