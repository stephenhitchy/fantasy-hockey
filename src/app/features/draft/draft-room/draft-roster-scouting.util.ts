import { DraftPosition } from '../../../core/draft/draft.models';

export interface DraftRosterPickLike {
  ownerId: string;
  overallPick: number;
  asset: {
    position: DraftPosition;
  };
}

export function resolveDraftRosterOwnerId(input: {
  requestedOwnerId: string;
  currentOwnerId: string;
  availableOwnerIds: readonly string[];
}): string {
  if (input.availableOwnerIds.includes(input.requestedOwnerId)) {
    return input.requestedOwnerId;
  }

  if (input.availableOwnerIds.includes(input.currentOwnerId)) {
    return input.currentOwnerId;
  }

  return input.availableOwnerIds[0] ?? '';
}

export function getDraftRosterPicksByPosition<TPick extends DraftRosterPickLike>(
  picks: readonly TPick[],
  ownerId: string,
  position: DraftPosition,
): TPick[] {
  return picks
    .filter((pick) => pick.ownerId === ownerId && pick.asset.position === position)
    .sort((first, second) => first.overallPick - second.overallPick);
}
