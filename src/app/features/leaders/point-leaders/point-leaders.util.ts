import type {
  FantasyAssetCycleWindow,
  FantasyCycle,
  FantasyTeamCycleWindows,
} from '../../../core/cycle/cycle.models';
import type { DraftableAsset } from '../../../core/draft/draft.models';
import type { LeaguePlayerOwnership } from '../../../core/player/league-player-board.util';
import type {
  SharedProjectionSnapshot,
  SharedProjectionSnapshotMetadata,
} from '../../../core/projection/projection-snapshot.service';

export type PointLeaderScope = 'current' | 'season' | 'projected';
export type PointLeaderPositionFilter = 'ALL' | 'LW' | 'C' | 'RW' | 'D' | 'G';

export interface PointLeaderOwnerContribution {
  ownerId: string;
  totalPoints: number | null;
  gamesPlayed: number | null;
  appearances: number | null;
  windowCount: number;
}

export interface PointLeaderRow {
  rank: number | null;
  assetKey: string;
  asset: DraftableAsset;
  position: 'LW' | 'C' | 'RW' | 'D' | 'G';
  value: number | null;
  gamesPlayed: number | null;
  appearances: number | null;
  pointsPerGame: number | null;
  ownerContributions: PointLeaderOwnerContribution[];
  currentOwnership: LeaguePlayerOwnership | null;
  projectionFloor: number | null;
  projectionCeiling: number | null;
  expectedGamesAvailable: number | null;
  availabilityLabel: string | null;
}

interface MutableScoringLeaderRow {
  assetKey: string;
  asset: DraftableAsset;
  value: number;
  hasValue: boolean;
  gamesPlayed: number;
  hasGamesPlayed: boolean;
  appearances: number;
  hasAppearances: boolean;
  ownerContributions: Map<string, PointLeaderOwnerContribution>;
}

export interface ProjectionLeaderVerificationInput {
  expectedProjectionVersion: number;
  expectedDraftRankingVersion: number;
  expectedScoringRulesVersion: number;
  expectedAuthoritySchemaVersion: number;
  hashSchemaSupported: boolean;
}

export interface LeaderCycleTransition {
  cycles: FantasyCycle[];
  nextCycleNumber: number | null;
  shouldSwapListener: boolean;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Applies the same complete server seal required by Draft authority before a
 * Projection V11 snapshot may be described as verified on League Leaders.
 */
export function isVerifiedProjectionLeaderSnapshot(
  metadata: SharedProjectionSnapshotMetadata,
  loadedAssetCount: number,
  input: ProjectionLeaderVerificationInput,
): boolean {
  return loadedAssetCount > 0 &&
    metadata.status === 'ready' &&
    metadata.projectionVersion === input.expectedProjectionVersion &&
    metadata.draftRankingVersion === input.expectedDraftRankingVersion &&
    metadata.scoringRulesVersion === input.expectedScoringRulesVersion &&
    metadata.generationReason !== 'server-emergency' &&
    metadata.generatedByAuthority === 'server' &&
    metadata.authoritySchemaVersion === input.expectedAuthoritySchemaVersion &&
    metadata.catalogValidationStatus === 'validated' &&
    typeof metadata.catalogSnapshotId === 'string' &&
    metadata.catalogSnapshotId.trim().length > 0 &&
    isSha256(metadata.catalogHash) &&
    isPositiveInteger(metadata.assetCount) &&
    metadata.assetCount === loadedAssetCount &&
    metadata.canonicalAssetCount === metadata.assetCount &&
    isPositiveInteger(metadata.assetDocumentCount) &&
    input.hashSchemaSupported &&
    metadata.snapshotHashAlgorithm === 'sha256' &&
    metadata.snapshotIntegrityStatus === 'verified' &&
    isSha256(metadata.snapshotContentHash) &&
    Array.isArray(metadata.snapshotChunkHashes) &&
    metadata.snapshotChunkHashes.length === metadata.assetDocumentCount &&
    metadata.snapshotChunkHashes.every(isSha256);
}

/** Invalid or emergency snapshots produce no leaderboard pool. */
export function getVerifiedProjectionLeaderAssets(
  snapshot: SharedProjectionSnapshot | null,
  input: ProjectionLeaderVerificationInput,
): DraftableAsset[] | null {
  if (
    !snapshot ||
    !isVerifiedProjectionLeaderSnapshot(snapshot.metadata, snapshot.assets.length, input)
  ) {
    return null;
  }

  return snapshot.assets;
}

export function selectInitialLeaderCycleNumber(
  cycles: readonly FantasyCycle[],
): number | null {
  return [...cycles]
    .filter((cycle) => cycle.status === 'active')
    .sort((first, second) => first.cycleNumber - second.cycleNumber)[0]?.cycleNumber ?? null;
}

/**
 * Completes only the selected lifecycle entry. Replayed completion callbacks
 * for an old listener therefore cannot swap the current listener twice.
 */
export function resolveLeaderCycleCompletion(
  cycles: readonly FantasyCycle[],
  selectedCycleNumber: number | null,
  completedCycleNumber: number,
): LeaderCycleTransition {
  if (selectedCycleNumber === null || selectedCycleNumber !== completedCycleNumber) {
    return {
      cycles: [...cycles],
      nextCycleNumber: selectedCycleNumber,
      shouldSwapListener: false,
    };
  }

  const nextCycles = cycles.map((cycle) =>
    cycle.cycleNumber === completedCycleNumber
      ? { ...cycle, status: 'complete' as const }
      : cycle,
  );
  const nextCycleNumber = [...nextCycles]
    .filter(
      (cycle) =>
        cycle.status === 'active' && cycle.cycleNumber > completedCycleNumber,
    )
    .sort((first, second) => first.cycleNumber - second.cycleNumber)[0]?.cycleNumber ?? null;

  return {
    cycles: nextCycles,
    nextCycleNumber,
    shouldSwapListener: true,
  };
}

export function areLeaderCycleTeamWindowsComplete(
  teamWindows: readonly FantasyTeamCycleWindows[],
  expectedOwnerIds: readonly string[],
): boolean {
  const owners = [...new Set(expectedOwnerIds.map((ownerId) => ownerId.trim()).filter(Boolean))];

  if (owners.length === 0) {
    return false;
  }

  const windowsByOwner = new Map(teamWindows.map((entry) => [entry.ownerId, entry]));
  return owners.every((ownerId) => windowsByOwner.get(ownerId)?.status === 'complete');
}

function getLeaderWindowIdentity(window: FantasyAssetCycleWindow): string {
  return [
    window.cycleNumber,
    window.ownerId,
    window.rosterSlotId,
    window.id || window.assetKey,
  ].join('::');
}

/** Later collections win so the live current-cycle snapshot replaces stale reads. */
export function mergeLeaderWindows(
  ...collections: readonly (readonly FantasyAssetCycleWindow[])[]
): FantasyAssetCycleWindow[] {
  const merged = new Map<string, FantasyAssetCycleWindow>();

  for (const windows of collections) {
    for (const window of windows) {
      merged.set(getLeaderWindowIdentity(window), window);
    }
  }

  return [...merged.values()];
}

function getAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : `${asset.teamName} Goalie Unit`;
}

function getNextSixProjection(asset: DraftableAsset): number | null {
  return finiteNumberOrNull(asset.availabilityAdjustedCyclePoints) ??
    finiteNumberOrNull(asset.projectedCyclePoints) ??
    finiteNumberOrNull(asset.draftProjectedCyclePoints);
}

function addNullableNumbers(first: number | null, second: number | null): number | null {
  if (first === null) {
    return second;
  }

  if (second === null) {
    return first;
  }

  return first + second;
}

/**
 * Builds scoring rows directly from immutable slot windows. Owner attribution
 * stays attached to the window that earned the points, even if the asset later
 * moves to another fantasy team.
 */
export function buildScoringLeaderRows(
  windows: readonly FantasyAssetCycleWindow[],
  options: { completedOnly: boolean },
): PointLeaderRow[] {
  const aggregate = new Map<string, MutableScoringLeaderRow>();

  for (const window of windows) {
    if (options.completedOnly && window.status !== 'complete') {
      continue;
    }

    const asset = window.asset;
    const assetKey = asset?.assetKey?.trim();

    if (!asset || !assetKey) {
      continue;
    }

    const points = finiteNumberOrNull(window.fantasyPoints);
    const gamesPlayed = finiteNumberOrNull(window.gamesPlayed);
    const appearances = finiteNumberOrNull(window.actualGamesPlayed);
    let row = aggregate.get(assetKey);

    if (!row) {
      row = {
        assetKey,
        asset,
        value: 0,
        hasValue: false,
        gamesPlayed: 0,
        hasGamesPlayed: false,
        appearances: 0,
        hasAppearances: false,
        ownerContributions: new Map(),
      };
      aggregate.set(assetKey, row);
    }

    row.asset = asset;

    if (points !== null) {
      row.value += points;
      row.hasValue = true;
    }

    if (gamesPlayed !== null) {
      row.gamesPlayed += Math.max(0, gamesPlayed);
      row.hasGamesPlayed = true;
    }

    if (appearances !== null) {
      row.appearances += Math.max(0, appearances);
      row.hasAppearances = true;
    }

    const ownerId = window.ownerId.trim();

    if (!ownerId) {
      continue;
    }

    const previousContribution = row.ownerContributions.get(ownerId);
    row.ownerContributions.set(ownerId, {
      ownerId,
      totalPoints: addNullableNumbers(previousContribution?.totalPoints ?? null, points),
      gamesPlayed: addNullableNumbers(
        previousContribution?.gamesPlayed ?? null,
        gamesPlayed === null ? null : Math.max(0, gamesPlayed),
      ),
      appearances: addNullableNumbers(
        previousContribution?.appearances ?? null,
        appearances === null ? null : Math.max(0, appearances),
      ),
      windowCount: (previousContribution?.windowCount ?? 0) + 1,
    });
  }

  return [...aggregate.values()]
    .filter((row) =>
      (row.hasGamesPlayed && row.gamesPlayed > 0) ||
      (row.hasAppearances && row.appearances > 0) ||
      (row.hasValue && Math.abs(row.value) > 0.0001),
    )
    .map((row) => {
      const value = row.hasValue ? row.value : null;
      const gamesPlayed = row.hasGamesPlayed ? row.gamesPlayed : null;

      return {
        rank: null,
        assetKey: row.assetKey,
        asset: row.asset,
        position: row.asset.position,
        value,
        gamesPlayed,
        appearances: row.hasAppearances ? row.appearances : null,
        pointsPerGame:
          value !== null && gamesPlayed !== null && gamesPlayed > 0
            ? value / gamesPlayed
            : null,
        ownerContributions: [...row.ownerContributions.values()].sort((first, second) =>
          (second.totalPoints ?? Number.NEGATIVE_INFINITY) -
            (first.totalPoints ?? Number.NEGATIVE_INFINITY) ||
          first.ownerId.localeCompare(second.ownerId),
        ),
        currentOwnership: null,
        projectionFloor: null,
        projectionCeiling: null,
        expectedGamesAvailable: null,
        availabilityLabel: null,
      };
    });
}

/** Projection rows use the current roster only for context; it never changes
 * the Projection V11 ordering or the historical team that earned points. */
export function buildProjectedLeaderRows(
  assets: readonly DraftableAsset[],
  ownershipByAssetKey: ReadonlyMap<string, LeaguePlayerOwnership>,
): PointLeaderRow[] {
  return assets.map((asset) => ({
    rank: null,
    assetKey: asset.assetKey,
    asset,
    position: asset.position,
    value: getNextSixProjection(asset),
    gamesPlayed: null,
    appearances: null,
    pointsPerGame: null,
    ownerContributions: [],
    currentOwnership: ownershipByAssetKey.get(asset.assetKey) ?? null,
    projectionFloor: finiteNumberOrNull(asset.projectionFloorPoints),
    projectionCeiling: finiteNumberOrNull(asset.projectionCeilingPoints),
    expectedGamesAvailable: finiteNumberOrNull(asset.expectedGamesAvailable),
    availabilityLabel:
      typeof asset.availabilityLabel === 'string' && asset.availabilityLabel.trim()
        ? asset.availabilityLabel.trim()
        : null,
  }));
}

/** Filters first so an exact-position view has its own truthful rank numbers. */
export function filterAndRankLeaderRows(
  rows: readonly PointLeaderRow[],
  position: PointLeaderPositionFilter,
): PointLeaderRow[] {
  const filtered = position === 'ALL'
    ? [...rows]
    : rows.filter((row) => row.position === position);

  filtered.sort((first, second) => {
    if (first.value === null && second.value !== null) {
      return 1;
    }

    if (second.value === null && first.value !== null) {
      return -1;
    }

    if (first.value !== null && second.value !== null && first.value !== second.value) {
      return second.value - first.value;
    }

    return getAssetName(first.asset).localeCompare(getAssetName(second.asset)) ||
      first.assetKey.localeCompare(second.assetKey);
  });

  let previousValue: number | null = null;
  let previousRank = 0;

  return filtered.map((row, index) => {
    if (row.value === null) {
      return { ...row, rank: null };
    }

    const rank = index > 0 && row.value === previousValue ? previousRank : index + 1;
    previousValue = row.value;
    previousRank = rank;
    return { ...row, rank };
  });
}
