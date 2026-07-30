import {
  DraftPosition,
  DraftQueue,
  DraftSelectionType,
  DraftableAsset,
  DraftPickPreview,
  FantasyDraft,
} from './shared/core/draft/draft.models';
import {
  FantasyRoster,
  RosterAsset,
  RosterStatus,
} from './shared/core/team/roster.models';

export interface DraftDestination {
  rosterArea: 'active' | 'bench';
  slotIndex: number;
  slotId: string;
}

export type DraftBenchRole = 'F' | 'D' | 'G';

export interface AutomaticDraftSelection {
  asset: DraftableAsset;
  selectionType: Extract<DraftSelectionType, 'queue' | 'automatic'>;
}


export function hasExactDraftOwnerSet(
  draft: FantasyDraft,
  ownerIds: string[],
): boolean {
  const expected = [...new Set(draft.roundOneOrder)].sort();
  const actual = [...new Set(ownerIds)].sort();

  return expected.length === draft.roundOneOrder.length &&
    expected.length === actual.length &&
    expected.every((ownerId, index) => ownerId === actual[index]);
}

export function getDraftTotalPickCount(draft: FantasyDraft): number {
  return draft.totalRounds * draft.roundOneOrder.length;
}

export function getDraftPickAtOverall(
  draft: FantasyDraft,
  overallPick: number,
): DraftPickPreview | null {
  const totalPickCount = getDraftTotalPickCount(draft);

  if (overallPick < 1 || overallPick > totalPickCount || draft.roundOneOrder.length === 0) {
    return null;
  }

  const teamCount = draft.roundOneOrder.length;
  const round = Math.floor((overallPick - 1) / teamCount) + 1;
  const pickInRound = ((overallPick - 1) % teamCount) + 1;
  const order = round % 2 === 1
    ? draft.roundOneOrder
    : [...draft.roundOneOrder].reverse();

  return {
    overallPick,
    round,
    pickInRound,
    ownerId: order[pickInRound - 1],
  };
}

export function getDraftBenchRole(position: DraftPosition): DraftBenchRole {
  if (position === 'D') {
    return 'D';
  }

  if (position === 'G') {
    return 'G';
  }

  return 'F';
}

export function getDraftDestination(
  roster: FantasyRoster,
  position: DraftPosition,
): DraftDestination | null {
  const activeSlotIndex = roster.activeSlots.findIndex(
    (slot) => slot.position === position && slot.asset === null,
  );

  if (activeSlotIndex >= 0) {
    return {
      rosterArea: 'active',
      slotIndex: activeSlotIndex,
      slotId: roster.activeSlots[activeSlotIndex].slotId,
    };
  }

  const benchSlotIndex = roster.benchSlots.findIndex((slot) => slot.asset === null);

  if (benchSlotIndex >= 0) {
    return {
      rosterArea: 'bench',
      slotIndex: benchSlotIndex,
      slotId: roster.benchSlots[benchSlotIndex].slotId,
    };
  }

  return null;
}

function needsAnyStarter(roster: FantasyRoster): boolean {
  return roster.activeSlots.some((slot) => slot.asset === null);
}

function getExistingBenchRoles(roster: FantasyRoster): Set<DraftBenchRole> {
  return new Set(
    roster.benchSlots
      .map((slot) => slot.asset?.position)
      .filter((position): position is DraftPosition => Boolean(position))
      .map(getDraftBenchRole),
  );
}

export function isAutomaticDraftCandidateAllowed(
  roster: FantasyRoster,
  asset: DraftableAsset,
  destination: DraftDestination | null,
): boolean {
  if (!destination) {
    return false;
  }

  if (needsAnyStarter(roster)) {
    return destination.rosterArea === 'active';
  }

  if (destination.rosterArea !== 'bench') {
    return false;
  }

  return !getExistingBenchRoles(roster).has(getDraftBenchRole(asset.position));
}

function getAssetDraftValue(asset: DraftableAsset): number | null {
  const candidates = [
    asset.draftScore,
    asset.draftValueAboveReplacement,
    asset.balancedDraftValue,
    asset.floorAdjustedDraftValue,
  ];

  const value = candidates.find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate),
  );

  return value ?? null;
}

function getAssetProjectedCycle(asset: DraftableAsset): number | null {
  const candidates = [
    asset.draftProjectedCyclePoints,
    asset.availabilityAdjustedCyclePoints,
    asset.floorAdjustedCyclePoints,
    asset.projectedCyclePoints,
  ];

  const value = candidates.find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate),
  );

  return value ?? null;
}

export function getDraftAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : `${asset.teamName} Goalie Unit`;
}

export function compareDraftValue(first: DraftableAsset, second: DraftableAsset): number {
  const firstValue = getAssetDraftValue(first);
  const secondValue = getAssetDraftValue(second);

  if (firstValue !== null && secondValue !== null && firstValue !== secondValue) {
    return secondValue - firstValue;
  }

  if (firstValue !== null && secondValue === null) {
    return -1;
  }

  if (firstValue === null && secondValue !== null) {
    return 1;
  }

  const firstProjection = getAssetProjectedCycle(first) ?? -1;
  const secondProjection = getAssetProjectedCycle(second) ?? -1;

  if (firstProjection !== secondProjection) {
    return secondProjection - firstProjection;
  }

  return getDraftAssetName(first).localeCompare(getDraftAssetName(second));
}

/**
 * Prevent a bench selection from consuming the last assets needed to fill
 * another manager's required starting slot at the same position.
 */
export function canUseAssetForBench(
  asset: DraftableAsset,
  destination: DraftDestination,
  draft: FantasyDraft,
  rostersByOwnerId: Map<string, FantasyRoster>,
  allAssets: DraftableAsset[],
): boolean {
  if (destination.rosterArea !== 'bench') {
    return true;
  }

  const missingStartingAssets = [...rostersByOwnerId.values()].reduce(
    (total, roster) => total + roster.activeSlots.filter(
      (slot) => slot.position === asset.position && slot.asset === null,
    ).length,
    0,
  );

  if (missingStartingAssets <= 0) {
    return true;
  }

  const draftedKeys = new Set(draft.draftedAssetKeys);
  const availableAtPosition = allAssets.filter(
    (candidate) => candidate.position === asset.position && !draftedKeys.has(candidate.assetKey),
  ).length;

  const safeAvailableCount = availableAtPosition > 0
    ? availableAtPosition
    : asset.position === 'G'
      ? Math.max(
          0,
          32 - [...rostersByOwnerId.values()].reduce(
            (total, roster) => total +
              roster.activeSlots.filter((slot) => slot.asset?.position === 'G').length +
              roster.benchSlots.filter((slot) => slot.asset?.position === 'G').length,
            0,
          ),
        )
      : Number.POSITIVE_INFINITY;

  return safeAvailableCount === Number.POSITIVE_INFINITY ||
    Math.max(0, safeAvailableCount - 1) >= missingStartingAssets;
}

export function createDraftRosterAsset(
  asset: DraftableAsset,
  rosterStatus: RosterStatus,
): RosterAsset {
  return {
    ...asset,
    rosterStatus,
    cycleScore: {
      cycleNumber: 1,
      gamesCounted: 0,
      fantasyPoints: 0,
    },
  } as RosterAsset;
}

export function applyDraftAssetToRoster(
  roster: FantasyRoster,
  asset: DraftableAsset,
  destination: DraftDestination,
): FantasyRoster {
  const nextRoster: FantasyRoster = {
    ...roster,
    activeSlots: roster.activeSlots.map((slot) => ({ ...slot })),
    benchSlots: roster.benchSlots.map((slot) => ({ ...slot })),
    irSlots: roster.irSlots.map((slot) => ({ ...slot })),
  };

  const rosterAsset = createDraftRosterAsset(
    asset,
    destination.rosterArea === 'active' ? 'active' : 'benched',
  );

  if (destination.rosterArea === 'active') {
    nextRoster.activeSlots[destination.slotIndex] = {
      ...nextRoster.activeSlots[destination.slotIndex],
      asset: rosterAsset,
      openFromCycleNumber: null,
    };
  } else {
    nextRoster.benchSlots[destination.slotIndex] = {
      ...nextRoster.benchSlots[destination.slotIndex],
      asset: rosterAsset,
    };
  }

  return nextRoster;
}

export function rosterContainsDraftAsset(
  roster: FantasyRoster,
  assetKey: string,
): boolean {
  return [
    ...roster.activeSlots.map((slot) => slot.asset),
    ...roster.benchSlots.map((slot) => slot.asset),
    ...roster.irSlots.map((slot) => slot.asset),
  ].some((asset) => asset?.assetKey === assetKey);
}

export function selectAutomaticDraftCandidate(input: {
  queue: DraftQueue;
  draft: FantasyDraft;
  roster: FantasyRoster;
  rostersByOwnerId: Map<string, FantasyRoster>;
  assets: DraftableAsset[];
}): AutomaticDraftSelection | null {
  const draftedKeys = new Set(input.draft.draftedAssetKeys);
  const assetsByKey = new Map(input.assets.map((asset) => [asset.assetKey, asset] as const));

  const isEligible = (asset: DraftableAsset): boolean => {
    if (draftedKeys.has(asset.assetKey)) {
      return false;
    }

    const destination = getDraftDestination(input.roster, asset.position);

    return isAutomaticDraftCandidateAllowed(input.roster, asset, destination) &&
      Boolean(destination) &&
      canUseAssetForBench(
        asset,
        destination!,
        input.draft,
        input.rostersByOwnerId,
        input.assets,
      );
  };

  for (const assetKey of input.queue.assetKeys) {
    const asset = assetsByKey.get(assetKey);

    if (asset && isEligible(asset)) {
      return { asset, selectionType: 'queue' };
    }
  }

  const asset = input.assets
    .filter(isEligible)
    .sort(compareDraftValue)[0];

  return asset ? { asset, selectionType: 'automatic' } : null;
}
