import { DraftPosition } from '../../../core/draft/draft.models';

export type DraftPoolPositionFilter = 'ALL' | DraftPosition;

export interface DraftGoaliePickLike {
  ownerId: string;
  asset: {
    position: DraftPosition;
  };
}

export function hasManagerDraftedGoalieUnit(
  picks: readonly DraftGoaliePickLike[],
  ownerId: string,
): boolean {
  return picks.some(
    (pick) => pick.ownerId === ownerId && pick.asset.position === 'G',
  );
}

export function shouldShowDraftPoolAsset(input: {
  assetPosition: DraftPosition;
  positionFilter: DraftPoolPositionFilter;
  managerHasGoalieUnit: boolean;
  showExtraGoalieUnits: boolean;
}): boolean {
  if (input.assetPosition !== 'G' || !input.managerHasGoalieUnit) {
    return true;
  }

  return input.showExtraGoalieUnits || input.positionFilter === 'G';
}
