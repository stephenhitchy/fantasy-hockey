import type { DraftStatus, FantasyDraft } from '../../../core/draft/draft.models';

export interface DraftSettingsExpectation {
  submissionId: string;
  roundOneOrder: string[];
  scheduledStartAtMilliseconds: number | null;
  pickSeconds: number;
  status: DraftStatus;
}

function toMilliseconds(value: unknown): number | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }

  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const toDate = (value as { toDate?: unknown }).toDate;

    if (typeof toDate === 'function') {
      const converted = (toDate as (this: object) => Date).call(value);
      return Number.isNaN(converted.getTime()) ? null : converted.getTime();
    }
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const converted = new Date(value);
    return Number.isNaN(converted.getTime()) ? null : converted.getTime();
  }

  return null;
}

function sameOrder(first: readonly string[], second: readonly string[]): boolean {
  return (
    first.length === second.length &&
    first.every((ownerId, index) => ownerId === second[index])
  );
}

export function draftSettingsMatchExpectation(
  draft: FantasyDraft | null | undefined,
  expectation: DraftSettingsExpectation,
): boolean {
  if (!draft) {
    return false;
  }

  const observedStart = toMilliseconds(draft.scheduledStartAt);
  const expectedStart = expectation.scheduledStartAtMilliseconds;
  const startMatches =
    observedStart === expectedStart ||
    (observedStart !== null &&
      expectedStart !== null &&
      Math.abs(observedStart - expectedStart) < 1_000);

  return (
    draft.lastSettingsSubmissionId === expectation.submissionId &&
    draft.status === expectation.status &&
    sameOrder(draft.roundOneOrder ?? [], expectation.roundOneOrder) &&
    startMatches &&
    Math.round(draft.pickSeconds) === Math.round(expectation.pickSeconds)
  );
}
