import type { FantasyDraft } from './draft.models';

export const DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS = 25 * 60 * 1000;

export type DraftSetupSchedulingGateState =
  | 'not-scheduled'
  | 'past'
  | 'safe-lead'
  | 'exact-ready'
  | 'unsafe-near-term';

function getTimestampMilliseconds(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return date instanceof Date && Number.isFinite(date.getTime())
      ? date.getTime()
      : null;
  }

  return null;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function hasStoredExactDraftReadinessForSchedule(
  draft: FantasyDraft | null,
  selectedStartMilliseconds: number,
): boolean {
  const savedStartMilliseconds = getTimestampMilliseconds(draft?.scheduledStartAt);
  const readinessStartMilliseconds = getTimestampMilliseconds(
    draft?.serverDraftReadinessScheduledStartAt,
  );

  return draft?.status === 'scheduled' &&
    draft.serverDraftReadinessStatus === 'ready' &&
    savedStartMilliseconds === selectedStartMilliseconds &&
    readinessStartMilliseconds === selectedStartMilliseconds &&
    isSha256(draft.serverDraftReadinessAvailabilityRevision) &&
    typeof draft.serverDraftReadinessProjectionRequestId === 'string' &&
    Boolean(draft.serverDraftReadinessProjectionRequestId) &&
    typeof draft.serverDraftReadinessProjectionSnapshotId === 'string' &&
    Boolean(draft.serverDraftReadinessProjectionSnapshotId) &&
    isSha256(draft.serverDraftReadinessProjectionSnapshotHash);
}

export function getDraftSetupSchedulingGateState(input: {
  draft: FantasyDraft | null;
  selectedStartMilliseconds: number | null;
  nowMilliseconds: number;
}): DraftSetupSchedulingGateState {
  if (
    input.selectedStartMilliseconds === null ||
    !Number.isFinite(input.selectedStartMilliseconds) ||
    !Number.isFinite(input.nowMilliseconds)
  ) {
    return 'not-scheduled';
  }

  if (input.selectedStartMilliseconds <= input.nowMilliseconds) {
    return 'past';
  }

  if (
    input.selectedStartMilliseconds - input.nowMilliseconds >=
    DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS
  ) {
    return 'safe-lead';
  }

  return hasStoredExactDraftReadinessForSchedule(
    input.draft,
    input.selectedStartMilliseconds,
  )
    ? 'exact-ready'
    : 'unsafe-near-term';
}

export function getEarliestSafeDraftStartMilliseconds(
  nowMilliseconds: number,
): number | null {
  if (!Number.isFinite(nowMilliseconds)) {
    return null;
  }

  const exactMinimum =
    nowMilliseconds + DRAFT_MINIMUM_UNPREPARED_START_LEAD_MILLISECONDS;

  return Math.ceil(exactMinimum / 60_000) * 60_000;
}
