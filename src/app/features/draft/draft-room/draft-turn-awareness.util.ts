import type { FantasyDraft } from '../../../core/draft/draft.models';

export type DraftTurnAwarenessStatus = Pick<FantasyDraft, 'status'>['status'];

export interface DraftTurnAlertTransition {
  hasPreviousObservation: boolean;
  previousDistance: number | null;
  previousStatus: DraftTurnAwarenessStatus | null;
  currentDistance: number | null;
  currentStatus: DraftTurnAwarenessStatus | null;
}

export interface DraftTurnPlayerReturnState {
  enteredManagerTurn: boolean;
  pickSubmissionPhase: 'idle' | 'submitting' | 'confirming';
}

export function getPicksUntilManagerTurn(
  draft: FantasyDraft | null,
  managerId: string,
): number | null {
  if (
    !draft ||
    (draft.status !== 'scheduled' && draft.status !== 'live') ||
    !managerId ||
    !draft.roundOneOrder.includes(managerId) ||
    !Number.isInteger(draft.nextOverallPick) ||
    draft.nextOverallPick < 1 ||
    !Number.isInteger(draft.totalRounds) ||
    draft.totalRounds < 1
  ) {
    return null;
  }

  const teamCount = draft.roundOneOrder.length;
  const totalPickCount = teamCount * draft.totalRounds;

  if (teamCount === 0 || draft.nextOverallPick > totalPickCount) {
    return null;
  }

  for (
    let overallPick = draft.nextOverallPick;
    overallPick <= totalPickCount;
    overallPick += 1
  ) {
    const zeroBasedPick = overallPick - 1;
    const zeroBasedRound = Math.floor(zeroBasedPick / teamCount);
    const pickIndex = zeroBasedPick % teamCount;
    const ownerIndex = zeroBasedRound % 2 === 0
      ? pickIndex
      : teamCount - pickIndex - 1;

    if (draft.roundOneOrder[ownerIndex] === managerId) {
      return overallPick - draft.nextOverallPick;
    }
  }

  return null;
}

export function getDraftTurnDistanceLabel(
  distance: number | null,
  status: DraftTurnAwarenessStatus | null,
): string | null {
  if (distance === null || distance < 0) {
    return null;
  }

  if (status === 'scheduled') {
    if (distance === 0) {
      return 'You have the first pick';
    }

    return distance === 1
      ? '1 pick before your first turn'
      : `${distance} picks before your first turn`;
  }

  if (status !== 'live') {
    return null;
  }

  if (distance === 0) {
    return 'You are on the clock';
  }

  return distance === 1
    ? '1 pick until your turn'
    : `${distance} picks until your turn`;
}

export function getCompactDraftTurnDistanceLabel(distance: number | null): string {
  if (distance === null) {
    return '';
  }

  if (distance === 0) {
    return '· Your turn';
  }

  return distance === 1 ? '· 1 pick away' : `· ${distance} picks away`;
}

export function shouldPlayDraftTurnAlert(input: DraftTurnAlertTransition): boolean {
  return (
    input.hasPreviousObservation &&
    input.currentStatus === 'live' &&
    input.currentDistance === 0 &&
    (input.previousStatus !== 'live' || input.previousDistance !== 0)
  );
}

export function shouldAutoOpenAvailablePlayersForTurn(
  input: DraftTurnPlayerReturnState,
): boolean {
  return input.enteredManagerTurn && input.pickSubmissionPhase === 'idle';
}

export function normalizeDraftTurnSoundVolume(
  value: unknown,
  fallback = 60,
): number {
  const normalizedFallback = Number.isFinite(fallback)
    ? Math.min(100, Math.max(0, Math.round(fallback)))
    : 60;

  if (value === null || value === undefined || value === '') {
    return normalizedFallback;
  }

  const numericValue = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return normalizedFallback;
  }

  return Math.min(100, Math.max(0, Math.round(numericValue)));
}
