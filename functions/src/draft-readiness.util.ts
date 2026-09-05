import { createHash } from 'node:crypto';

export const DRAFT_READINESS_WINDOW_MILLISECONDS = 20 * 60 * 1000;
export const DRAFT_AVAILABILITY_MAX_AGE_MILLISECONDS = 24 * 60 * 60 * 1000;
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

export type ScheduledDraftStartTaskState =
  | 'open'
  | 'early'
  | 'stale';

export interface DraftAvailabilityEvidenceInput {
  revision: string | null;
  lastSuccessfulAt: string | null;
  lastDailySyncKey: string | null;
  status: string | null;
  nowMilliseconds: number;
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

export function isDraftAvailabilityEvidenceUsable(
  input: DraftAvailabilityEvidenceInput,
): boolean {
  if (
    !input.revision ||
    !input.lastSuccessfulAt ||
    input.status !== 'success'
  ) {
    return false;
  }

  const lastSuccessfulMilliseconds = Date.parse(input.lastSuccessfulAt);

  if (
    !Number.isFinite(lastSuccessfulMilliseconds) ||
    !Number.isFinite(input.nowMilliseconds)
  ) {
    return false;
  }

  const ageMilliseconds = input.nowMilliseconds - lastSuccessfulMilliseconds;
  const expectedDailySyncKey = new Date(input.nowMilliseconds)
    .toISOString()
    .slice(0, 10);

  return ageMilliseconds >= 0 &&
    ageMilliseconds <= DRAFT_AVAILABILITY_MAX_AGE_MILLISECONDS &&
    input.lastDailySyncKey === expectedDailySyncKey;
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
