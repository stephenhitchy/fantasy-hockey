import type { FantasyAssetCycleWindow, FantasyTeamCycleWindows } from '../../../core/cycle/cycle.models';
import type { DraftableAsset, DraftPick, DraftProjection, DraftPosition } from '../../../core/draft/draft.models';
import type {
  ActiveRosterSlot,
  FantasyRoster,
  PendingRosterSlotMove,
  RosterAsset,
} from '../../../core/team/roster.models';

export interface BuildEffectiveCycleLineupInput {
  cycleNumber: number;
  snapshotPicks: DraftPick[];
  liveDraftPicks: DraftPick[];
  rostersByOwner: Readonly<Record<string, FantasyRoster | null | undefined>>;
  projectionAssets: DraftableAsset[];
  teamWindowsByOwner: Readonly<Record<string, FantasyTeamCycleWindows | undefined>>;
  rosterOwnerIdsExpected: ReadonlySet<string>;
  rosterOwnerIdsLoaded: ReadonlySet<string>;
}

const POSITION_ORDER: Record<DraftPosition, number> = {
  LW: 0,
  C: 10,
  RW: 20,
  D: 30,
  G: 40,
};

function toFinitePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function getRosterAssetKey(asset: RosterAsset | null | undefined): string {
  if (!asset) {
    return '';
  }

  if (asset.assetKey) {
    return asset.assetKey;
  }

  if (asset.assetType === 'skater') {
    const player = asset.player as {
      id?: number | string;
      playerId?: number | string;
      nhlPlayerId?: number | string;
    };
    const playerId = player.id ?? player.playerId ?? player.nhlPlayerId;

    return playerId ? `skater-${playerId}` : '';
  }

  return asset.teamAbbreviation ? `goalie-unit-${asset.teamAbbreviation}` : '';
}

function toDraftableAsset(asset: RosterAsset): DraftableAsset {
  const {
    cycleScore: _cycleScore,
    rosterStatus: _rosterStatus,
    ...storedFields
  } = asset;
  const assetKey = getRosterAssetKey(asset);

  if (asset.assetType === 'skater') {
    return {
      ...storedFields,
      assetType: 'skater',
      assetKey,
      position: asset.position,
      player: asset.player,
    } as DraftableAsset;
  }

  return {
    ...storedFields,
    assetType: 'team-goalie-unit',
    assetKey,
    position: 'G',
    teamName: asset.teamName,
    teamAbbreviation: asset.teamAbbreviation,
    teamLogoUrl: asset.teamLogoUrl,
  } as DraftableAsset;
}

function getRawProjection(projection: DraftProjection | null | undefined): number | null {
  if (!projection) {
    return null;
  }

  const candidates = [
    projection.projectedCyclePoints,
    projection.availabilityAdjustedCyclePoints,
    projection.floorAdjustedCyclePoints,
    projection.draftProjectedCyclePoints,
  ];

  return candidates.find(
    (candidate): candidate is number =>
      typeof candidate === 'number' && Number.isFinite(candidate),
  ) ?? null;
}

function getProjectionGeneratedTime(
  projection: DraftProjection | null | undefined,
): number {
  const generatedAt = projection?.projectionGeneratedAt;

  if (typeof generatedAt !== 'string') {
    return 0;
  }

  const generatedTime = Date.parse(generatedAt);

  return Number.isFinite(generatedTime) ? generatedTime : 0;
}

function getProjectionTargetPriority(
  projection: DraftProjection | null | undefined,
  cycleNumber: number,
): number {
  if (getRawProjection(projection) === null) {
    return 0;
  }

  const targetCycleNumber = toFinitePositiveInteger(
    projection?.targetProjectionCycleNumber,
  );

  if (targetCycleNumber === cycleNumber) {
    return 3;
  }

  if (targetCycleNumber === null) {
    return 2;
  }

  return 1;
}

function mergePreviewProjection(
  rosterAsset: RosterAsset,
  poolAsset: DraftableAsset | null,
  liveDraftAsset: DraftableAsset | null,
  cycleNumber: number,
): DraftableAsset {
  const identityAsset = toDraftableAsset(rosterAsset);
  const candidates: Array<{
    asset: DraftableAsset;
    priority: number;
    generatedTime: number;
    sourceOrder: number;
  }> = [
    ...(poolAsset
      ? [
          {
            asset: poolAsset,
            priority: getProjectionTargetPriority(poolAsset, cycleNumber),
            generatedTime: getProjectionGeneratedTime(poolAsset),
            sourceOrder: 3,
          },
        ]
      : []),
    {
      asset: identityAsset,
      priority: getProjectionTargetPriority(identityAsset, cycleNumber),
      generatedTime: getProjectionGeneratedTime(identityAsset),
      sourceOrder: 2,
    },
    ...(liveDraftAsset
      ? [
          {
            asset: liveDraftAsset,
            priority: getProjectionTargetPriority(liveDraftAsset, cycleNumber),
            generatedTime: getProjectionGeneratedTime(liveDraftAsset),
            sourceOrder: 1,
          },
        ]
      : []),
  ];

  const projectionSource = candidates
    .sort(
      (first, second) =>
        second.priority - first.priority ||
        second.generatedTime - first.generatedTime ||
        second.sourceOrder - first.sourceOrder,
    )[0]?.asset ?? identityAsset;

  const previewProjection: DraftableAsset = {
    ...identityAsset,
    ...projectionSource,
    assetType: identityAsset.assetType,
    assetKey: identityAsset.assetKey,
    position: identityAsset.position,

    // A future-slot preview is intentionally not an immutable window snapshot.
    // Clear any frozen value carried by an older roster record so the card uses
    // the best current estimate until this exact slot begins its six-game count.
    frozenCycleProjectionPoints: null,
    frozenProjectionCycleNumber: null,
    frozenProjectionSource: null,
    frozenProjectionVersion: null,
    frozenProjectionSnapshotId: null,
    frozenProjectionGeneratedAt: null,
    frozenProjectionFrozenAt: null,
  } as DraftableAsset;

  if (identityAsset.assetType === 'skater' && previewProjection.assetType === 'skater') {
    return {
      ...previewProjection,
      assetType: 'skater',
      assetKey: identityAsset.assetKey,
      position: identityAsset.position,
      player: identityAsset.player,
    };
  }

  if (
    identityAsset.assetType === 'team-goalie-unit' &&
    previewProjection.assetType === 'team-goalie-unit'
  ) {
    return {
      ...previewProjection,
      assetType: 'team-goalie-unit',
      assetKey: identityAsset.assetKey,
      position: 'G',
      teamName: identityAsset.teamName,
      teamAbbreviation: identityAsset.teamAbbreviation,
      teamLogoUrl: identityAsset.teamLogoUrl,
    };
  }

  return identityAsset;
}

function getPendingMoveTargetCycle(
  pendingMove: PendingRosterSlotMove | null | undefined,
): number | null {
  const requestedCycleNumber = toFinitePositiveInteger(
    pendingMove?.requestedEffectiveCycleNumber,
  );
  const incomingEligibleCycleNumber = toFinitePositiveInteger(
    pendingMove?.incomingAsset.eligibleFromCycleNumber,
  );
  const candidates = [requestedCycleNumber, incomingEligibleCycleNumber].filter(
    (value): value is number => value !== null,
  );

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function isRosterAssetEligibleForCycle(
  asset: RosterAsset | null | undefined,
  cycleNumber: number,
): boolean {
  if (!asset) {
    return false;
  }

  const eligibleCycleNumber = toFinitePositiveInteger(asset.eligibleFromCycleNumber);

  return eligibleCycleNumber === null || cycleNumber >= eligibleCycleNumber;
}

export function isPendingMovePlannedForCycle(
  pendingMove: PendingRosterSlotMove | null | undefined,
  cycleNumber: number,
): boolean {
  if (!pendingMove) {
    return false;
  }

  const targetCycleNumber = getPendingMoveTargetCycle(pendingMove);

  return targetCycleNumber !== null && cycleNumber >= targetCycleNumber;
}

function getPlannedRosterAsset(
  slot: ActiveRosterSlot,
  cycleNumber: number,
): RosterAsset | null {
  if (isPendingMovePlannedForCycle(slot.pendingMove, cycleNumber)) {
    return slot.pendingMove?.incomingAsset ?? slot.asset;
  }

  return isRosterAssetEligibleForCycle(slot.asset, cycleNumber) ? slot.asset : null;
}

export function getCycleLineupPickIdentity(pick: DraftPick): string {
  return [
    pick.ownerId,
    pick.rosterSlotId ?? `${pick.asset.position}:${pick.overallPick}`,
  ].join('::');
}

function getRosterSlotIdentity(ownerId: string, rosterSlotId: string): string {
  return `${ownerId}::${rosterSlotId}`;
}

function getWindowForSlot(
  teamWindowsByOwner: Readonly<Record<string, FantasyTeamCycleWindows | undefined>>,
  ownerId: string,
  rosterSlotId: string,
): FantasyAssetCycleWindow | null {
  return (
    teamWindowsByOwner[ownerId]?.windows.find(
      (window) => window.rosterSlotId === rosterSlotId,
    ) ?? null
  );
}

export function isCycleWindowIdentityLocked(
  window: FantasyAssetCycleWindow | null | undefined,
): boolean {
  if (!window) {
    return false;
  }

  return (
    window.status === 'active' ||
    window.status === 'complete' ||
    window.gamesPlayed > 0 ||
    window.actualGamesPlayed > 0 ||
    window.fantasyPoints !== 0 ||
    window.completedGameIds.length > 0 ||
    window.liveGameIds.length > 0 ||
    window.appearanceGameIds.length > 0 ||
    Object.keys(window.gameScores).length > 0 ||
    Object.values(window.gameStates).some((state) => state !== 'scheduled') ||
    window.startedAt != null ||
    window.completedAt != null
  );
}

function getSyntheticOverallPick(
  ownerIndex: number,
  slot: ActiveRosterSlot,
): number {
  return (
    900_000 +
    ownerIndex * 100 +
    POSITION_ORDER[slot.position] +
    Math.max(1, slot.slotNumber)
  );
}

function createPlannedRosterPick(input: {
  ownerId: string;
  ownerIndex: number;
  slot: ActiveRosterSlot;
  asset: RosterAsset;
  cycleNumber: number;
  liveDraftPicks: DraftPick[];
  projectionByAssetKey: ReadonlyMap<string, DraftableAsset>;
}): DraftPick {
  const assetKey = getRosterAssetKey(input.asset);
  const matchingLivePick =
    input.liveDraftPicks.find(
      (pick) => pick.ownerId === input.ownerId && pick.asset.assetKey === assetKey,
    ) ?? null;
  const syntheticOverallPick = getSyntheticOverallPick(input.ownerIndex, input.slot);

  return {
    overallPick: matchingLivePick?.overallPick ?? syntheticOverallPick,
    round: matchingLivePick?.round ?? 0,
    pickInRound: matchingLivePick?.pickInRound ?? input.slot.slotNumber,
    ownerId: input.ownerId,
    rosterArea: 'active',
    rosterSlotId: input.slot.slotId,
    snapshotCycleNumber: input.cycleNumber,
    snapshotOrder: matchingLivePick?.overallPick ?? syntheticOverallPick,
    asset: mergePreviewProjection(
      input.asset,
      input.projectionByAssetKey.get(assetKey) ?? null,
      matchingLivePick?.asset ?? null,
      input.cycleNumber,
    ),
  };
}

/**
 * Builds the manager-facing lineup for one overlapping fantasy matchup.
 *
 * Started/completed window snapshots remain immutable. A slot whose future
 * window has not started instead previews the current roster truth, including
 * an eligible queued incoming player. Original draft picks are used only when
 * the displayed owner's current roster is unavailable.
 */
export function buildEffectiveCycleLineupPicks(
  input: BuildEffectiveCycleLineupInput,
): DraftPick[] {
  const activeSnapshotPicks = input.snapshotPicks.filter(
    (pick) => pick.rosterArea !== 'bench',
  );
  const activeLivePicks = input.liveDraftPicks.filter(
    (pick) => pick.rosterArea !== 'bench',
  );
  const projectionByAssetKey = new Map(
    input.projectionAssets.map((asset) => [asset.assetKey, asset] as const),
  );
  const ownerIds = [...new Set([
    ...Object.keys(input.rostersByOwner),
    ...activeSnapshotPicks.map((pick) => pick.ownerId),
    ...activeLivePicks.map((pick) => pick.ownerId),
  ])].sort();
  const ownerIndexById = new Map(
    ownerIds.map((ownerId, index) => [ownerId, index] as const),
  );
  const plannedPickBySlotIdentity = new Map<string, DraftPick>();
  const knownRosterSlotIdentities = new Set<string>();
  const ownersWithLoadedRoster = new Set<string>();

  for (const [ownerId, roster] of Object.entries(input.rostersByOwner)) {
    if (!input.rosterOwnerIdsLoaded.has(ownerId) || !roster) {
      continue;
    }

    ownersWithLoadedRoster.add(ownerId);
    const ownerIndex = ownerIndexById.get(ownerId) ?? 0;

    for (const slot of roster.activeSlots) {
      const identity = getRosterSlotIdentity(ownerId, slot.slotId);
      knownRosterSlotIdentities.add(identity);
      const plannedAsset = getPlannedRosterAsset(slot, input.cycleNumber);

      if (!plannedAsset) {
        continue;
      }

      plannedPickBySlotIdentity.set(
        identity,
        createPlannedRosterPick({
          ownerId,
          ownerIndex,
          slot,
          asset: plannedAsset,
          cycleNumber: input.cycleNumber,
          liveDraftPicks: activeLivePicks,
          projectionByAssetKey,
        }),
      );
    }
  }

  const effectiveByIdentity = new Map<string, DraftPick>();

  for (const snapshotPick of activeSnapshotPicks) {
    const identity = getCycleLineupPickIdentity(snapshotPick);
    const plannedPick = plannedPickBySlotIdentity.get(identity) ?? null;
    const rosterSlotId = snapshotPick.rosterSlotId ?? '';
    const snapshotWindow = rosterSlotId
      ? getWindowForSlot(
          input.teamWindowsByOwner,
          snapshotPick.ownerId,
          rosterSlotId,
        )
      : null;

    if (isCycleWindowIdentityLocked(snapshotWindow)) {
      effectiveByIdentity.set(identity, snapshotPick);
      continue;
    }

    if (
      input.rosterOwnerIdsExpected.has(snapshotPick.ownerId) &&
      !input.rosterOwnerIdsLoaded.has(snapshotPick.ownerId)
    ) {
      // An untouched future snapshot may still contain the original drafted
      // player. Wait for the current roster instead of flashing that stale
      // identity while the roster listener is starting.
      continue;
    }

    if (plannedPick) {
      effectiveByIdentity.set(identity, plannedPick);
      continue;
    }

    if (
      ownersWithLoadedRoster.has(snapshotPick.ownerId) &&
      knownRosterSlotIdentities.has(identity)
    ) {
      // The authoritative current roster says this untouched future slot is
      // empty. Do not resurrect the old cycle snapshot merely for display.
      continue;
    }

    effectiveByIdentity.set(identity, snapshotPick);
  }

  for (const [identity, plannedPick] of plannedPickBySlotIdentity) {
    if (!effectiveByIdentity.has(identity)) {
      effectiveByIdentity.set(identity, plannedPick);
    }
  }

  for (const livePick of activeLivePicks) {
    if (ownersWithLoadedRoster.has(livePick.ownerId)) {
      continue;
    }

    if (
      input.rosterOwnerIdsExpected.has(livePick.ownerId) &&
      !input.rosterOwnerIdsLoaded.has(livePick.ownerId)
    ) {
      // Prefer a short loading gap over briefly showing the original drafted
      // player in a slot whose current/future roster identity is still loading.
      continue;
    }

    const identity = getCycleLineupPickIdentity(livePick);

    if (!effectiveByIdentity.has(identity)) {
      effectiveByIdentity.set(identity, {
        ...livePick,
        rosterArea: livePick.rosterArea ?? 'active',
      });
    }
  }

  return [...effectiveByIdentity.values()];
}
