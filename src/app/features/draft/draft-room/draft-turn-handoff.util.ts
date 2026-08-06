import type { DraftPick, FantasyDraft } from '../../../core/draft/draft.models';

export type DraftTurnHandoffStatus =
  | 'healthy'
  | 'picks-ahead'
  | 'draft-ahead'
  | 'clock-missing'
  | 'owner-missing'
  | 'complete'
  | 'inactive';

export interface DraftTurnHandoffAssessment {
  status: DraftTurnHandoffStatus;
  expectedNextOverallPick: number;
  lastContiguousOverallPick: number;
  currentOwnerId: string | null;
  requiresServerRepair: boolean;
  message: string;
}

function hasTimestampValue(value: unknown): boolean {
  if (!value) {
    return false;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime());
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime());
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return Number.isFinite(new Date(value).getTime());
  }

  return false;
}

export function getLastContiguousDraftPick(
  picks: Pick<DraftPick, 'overallPick'>[],
  totalPickCount: number,
): number {
  const completed = new Set(
    picks
      .map((pick) => pick.overallPick)
      .filter((overallPick) => Number.isInteger(overallPick) && overallPick > 0),
  );
  let lastContiguousOverallPick = 0;

  for (let overallPick = 1; overallPick <= totalPickCount; overallPick += 1) {
    if (!completed.has(overallPick)) {
      break;
    }

    lastContiguousOverallPick = overallPick;
  }

  return lastContiguousOverallPick;
}

export function getDraftOwnerAtOverall(
  draft: Pick<FantasyDraft, 'roundOneOrder' | 'totalRounds'>,
  overallPick: number,
): string | null {
  const teamCount = draft.roundOneOrder.length;
  const totalPickCount = Math.max(0, draft.totalRounds) * teamCount;

  if (teamCount === 0 || overallPick < 1 || overallPick > totalPickCount) {
    return null;
  }

  const round = Math.floor((overallPick - 1) / teamCount) + 1;
  const pickInRound = ((overallPick - 1) % teamCount) + 1;
  const order = round % 2 === 1
    ? draft.roundOneOrder
    : [...draft.roundOneOrder].reverse();

  return order[pickInRound - 1] ?? null;
}

export function assessDraftTurnHandoff(
  draft: FantasyDraft | null,
  picks: Pick<DraftPick, 'overallPick'>[],
  knownOwnerIds: string[] = [],
): DraftTurnHandoffAssessment {
  if (!draft || draft.status === 'setup' || draft.status === 'scheduled') {
    return {
      status: 'inactive',
      expectedNextOverallPick: draft?.nextOverallPick ?? 1,
      lastContiguousOverallPick: 0,
      currentOwnerId: null,
      requiresServerRepair: false,
      message: 'The live draft has not started.',
    };
  }

  const totalPickCount = draft.totalRounds * draft.roundOneOrder.length;
  const lastContiguousOverallPick = getLastContiguousDraftPick(picks, totalPickCount);
  const expectedNextOverallPick = Math.min(
    totalPickCount + 1,
    lastContiguousOverallPick + 1,
  );

  if (draft.status === 'complete' || expectedNextOverallPick > totalPickCount) {
    return {
      status: 'complete',
      expectedNextOverallPick,
      lastContiguousOverallPick,
      currentOwnerId: null,
      requiresServerRepair: draft.status !== 'complete',
      message: 'Every draft pick is complete.',
    };
  }

  if (expectedNextOverallPick > draft.nextOverallPick) {
    return {
      status: 'picks-ahead',
      expectedNextOverallPick,
      lastContiguousOverallPick,
      currentOwnerId: getDraftOwnerAtOverall(draft, expectedNextOverallPick),
      requiresServerRepair: true,
      message: `Pick #${lastContiguousOverallPick} is saved, but the live turn is still opening pick #${expectedNextOverallPick}.`,
    };
  }

  if (expectedNextOverallPick < draft.nextOverallPick) {
    return {
      status: 'draft-ahead',
      expectedNextOverallPick,
      lastContiguousOverallPick,
      currentOwnerId: getDraftOwnerAtOverall(draft, draft.nextOverallPick),
      requiresServerRepair: false,
      message: 'The draft turn advanced before the ordered pick list finished refreshing.',
    };
  }

  const currentOwnerId = getDraftOwnerAtOverall(draft, draft.nextOverallPick);

  if (knownOwnerIds.length > 0 && currentOwnerId && !knownOwnerIds.includes(currentOwnerId)) {
    return {
      status: 'owner-missing',
      expectedNextOverallPick,
      lastContiguousOverallPick,
      currentOwnerId,
      requiresServerRepair: true,
      message: 'The next draft owner is not present in the loaded league team list.',
    };
  }

  const clockNeedsRepair =
    (draft.clockStatus === 'running' && !hasTimestampValue(draft.pickStartedAt)) ||
    (draft.nextOverallPick > 1 && draft.clockStatus === 'stopped');

  if (clockNeedsRepair) {
    return {
      status: 'clock-missing',
      expectedNextOverallPick,
      lastContiguousOverallPick,
      currentOwnerId,
      requiresServerRepair: true,
      message: `Pick #${draft.nextOverallPick} is assigned, but its live clock has not opened correctly.`,
    };
  }

  return {
    status: 'healthy',
    expectedNextOverallPick,
    lastContiguousOverallPick,
    currentOwnerId,
    requiresServerRepair: false,
    message: 'The live draft turn is synchronized.',
  };
}
