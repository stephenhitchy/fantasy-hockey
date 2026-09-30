import { DraftableAsset, DraftProjection } from '../draft/draft.models';
import { createFrozenCycleProjection } from './cycle-projection.util';
import {
  generateSharedProjectionSnapshot,
  isSharedProjectionSnapshotFreshForWindow,
  loadSharedProjectionSnapshot,
  loadSharedProjectionSnapshotForCycle,
  SHARED_PROJECTION_VERSION,
  SharedProjectionSnapshot,
  SharedProjectionSnapshotMetadata,
} from './projection-snapshot.service';

export type WindowProjectionBundleSource =
  | 'fresh-target'
  | 'refreshed-target'
  | 'stale-target-fallback'
  | 'current-snapshot-fallback'
  | 'none';

export interface EnsureWindowProjectionBundleInput {
  leagueId: string;
  teamCount: number;
  requiredGamesPerCycle: number;
  /** NHL schedule block projected while targetCycleNumber stays fantasy-local. */
  targetSourceBlockNumber?: number;
  /** Exact all-club provider IDs frozen for targetSourceBlockNumber. */
  targetGameIdsByTeam?: Readonly<Record<string, readonly number[]>>;
  /** Hash binding the target IDs to the immutable draft season anchor. */
  seasonWindowAnchorEvidenceHash?: string;
  targetCycleNumber: number;
  forceRefresh?: boolean;
  now?: Date;
}

export interface WindowProjectionBundle {
  metadata: SharedProjectionSnapshotMetadata | null;
  assetsByKey: Map<string, DraftableAsset>;
  source: WindowProjectionBundleSource;
  refreshed: boolean;
  usedFallback: boolean;
  errorMessage: string;
}

export interface FrozenWindowProjectionFields {
  frozenCycleProjectionPoints: number | null;
  frozenProjectionCycleNumber: number;
  frozenProjectionSource: 'shared-snapshot' | 'roster' | 'draft-pick' | 'legacy';
  frozenProjectionVersion: number | null;
  frozenProjectionSnapshotId: string | null;
  frozenProjectionGeneratedAt: string | null;
  frozenProjectionFrozenAt: string;
}

function toAssetMap(snapshot: SharedProjectionSnapshot | null): Map<string, DraftableAsset> {
  return new Map((snapshot?.assets ?? []).map((asset) => [asset.assetKey, asset] as const));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unable to generate the next-window projection snapshot.';
}

export function doesWindowProjectionSnapshotMatchSource(
  snapshot: SharedProjectionSnapshot | null,
  targetSourceBlockNumber: number,
  seasonWindowAnchorEvidenceHash?: string,
): boolean {
  return Boolean(
    snapshot &&
    (snapshot.metadata.targetSourceBlockNumber ??
      snapshot.metadata.targetCycleNumber) === Math.max(1, Math.floor(targetSourceBlockNumber)) &&
    (!seasonWindowAnchorEvidenceHash ||
      snapshot.metadata.seasonWindowAnchorEvidenceHash === seasonWindowAnchorEvidenceHash),
  );
}

/**
 * Returns one projection pool for one exact fantasy window number. The first
 * slot to enter a target window refreshes the pool when needed; later slots
 * reuse it until it becomes stale. A failed NHL projection refresh never
 * blocks roster-window advancement because the best saved snapshot is used.
 */
export async function ensureWindowProjectionBundle(
  input: EnsureWindowProjectionBundleInput,
): Promise<WindowProjectionBundle> {
  const targetCycleNumber = Math.max(1, Math.floor(input.targetCycleNumber));
  const targetSourceBlockNumber = Math.max(
    1,
    Math.floor(input.targetSourceBlockNumber ?? targetCycleNumber),
  );
  const freshnessInput = {
    teamCount: input.teamCount,
    requiredGamesPerCycle: input.requiredGamesPerCycle,
    targetCycleNumber,
    now: input.now,
  };
  const targetSnapshot = await loadSharedProjectionSnapshotForCycle(
    input.leagueId,
    targetCycleNumber,
  );
  const targetSnapshotMatchesSource = doesWindowProjectionSnapshotMatchSource(
    targetSnapshot,
    targetSourceBlockNumber,
    input.seasonWindowAnchorEvidenceHash,
  );

  if (
    !input.forceRefresh &&
    targetSnapshotMatchesSource &&
    isSharedProjectionSnapshotFreshForWindow(targetSnapshot?.metadata ?? null, freshnessInput)
  ) {
    return {
      metadata: targetSnapshot?.metadata ?? null,
      assetsByKey: toAssetMap(targetSnapshot),
      source: 'fresh-target',
      refreshed: false,
      usedFallback: false,
      errorMessage: '',
    };
  }

  try {
    const refreshed = await generateSharedProjectionSnapshot({
      leagueId: input.leagueId,
      teamCount: input.teamCount,
      requiredGamesPerCycle: input.requiredGamesPerCycle,
      generationReason: 'window-boundary',
      targetCycleNumber,
      targetSourceBlockNumber,
      seasonWindowAnchorEvidenceHash: input.seasonWindowAnchorEvidenceHash,
    });

    return {
      metadata: refreshed.metadata,
      assetsByKey: toAssetMap(refreshed),
      source: 'refreshed-target',
      refreshed: true,
      usedFallback: false,
      errorMessage: '',
    };
  } catch (error: unknown) {
    if (targetSnapshotMatchesSource && targetSnapshot?.metadata.status === 'ready') {
      return {
        metadata: targetSnapshot.metadata,
        assetsByKey: toAssetMap(targetSnapshot),
        source: 'stale-target-fallback',
        refreshed: false,
        usedFallback: true,
        errorMessage: getErrorMessage(error),
      };
    }

    const currentSnapshot = await loadSharedProjectionSnapshot(input.leagueId).catch(() => null);
    const currentSnapshotMatchesSource = doesWindowProjectionSnapshotMatchSource(
      currentSnapshot,
      targetSourceBlockNumber,
      input.seasonWindowAnchorEvidenceHash,
    );

    return {
      metadata: currentSnapshotMatchesSource ? currentSnapshot?.metadata ?? null : null,
      assetsByKey: toAssetMap(currentSnapshotMatchesSource ? currentSnapshot : null),
      source: currentSnapshotMatchesSource ? 'current-snapshot-fallback' : 'none',
      refreshed: false,
      usedFallback: true,
      errorMessage: currentSnapshotMatchesSource
        ? getErrorMessage(error)
        : `${getErrorMessage(error)} No saved shared projection pool matched NHL source block ${targetSourceBlockNumber}.`,
    };
  }
}

export function hasUsableWindowProjection(
  asset: DraftableAsset | null | undefined,
  targetCycleNumber: number,
): boolean {
  if (!asset) {
    return false;
  }

  const projection = asset as DraftProjection;
  const value =
    projection.projectedCyclePoints ??
    projection.availabilityAdjustedCyclePoints ??
    projection.floorAdjustedCyclePoints;
  const target = projection.targetProjectionCycleNumber;

  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (target === null ||
      target === undefined ||
      target === Math.max(1, Math.floor(targetCycleNumber)))
  );
}

/**
 * Creates the immutable projection metadata stored on one roster-slot pick.
 * Calling this again for a later window produces a new freeze; mutating the
 * shared snapshot afterward cannot change an already-saved pick.
 */
export function createFrozenWindowProjectionFields(
  asset: DraftableAsset,
  targetCycleNumber: number,
  source: FrozenWindowProjectionFields['frozenProjectionSource'],
  frozenAtIso = new Date().toISOString(),
): FrozenWindowProjectionFields {
  return {
    frozenCycleProjectionPoints: createFrozenCycleProjection(asset),
    frozenProjectionCycleNumber: Math.max(1, Math.floor(targetCycleNumber)),
    frozenProjectionSource: source,
    frozenProjectionVersion: source === 'shared-snapshot' ? SHARED_PROJECTION_VERSION : null,
    frozenProjectionSnapshotId:
      typeof asset.sharedProjectionSnapshotId === 'string'
        ? asset.sharedProjectionSnapshotId
        : null,
    frozenProjectionGeneratedAt:
      typeof asset.projectionGeneratedAt === 'string' ? asset.projectionGeneratedAt : null,
    frozenProjectionFrozenAt: frozenAtIso,
  };
}
