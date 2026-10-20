import { doc, getDoc } from 'firebase/firestore';

import { DraftableAsset, DraftProjection } from '../draft/draft.models';
import { db } from '../firebase';
import {
  SCORING_RULES_V3_VERSION,
  normalizeScoringRulesVersion,
} from '../scoring/scoring-rules';
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

async function loadLeagueScoringRulesVersion(leagueId: string): Promise<number> {
  const snapshot = await getDoc(doc(db, 'leagues', leagueId));
  const storedVersion = snapshot.exists()
    ? snapshot.data()['scoringRulesVersion']
    : null;
  const normalized = normalizeScoringRulesVersion(storedVersion);

  if (normalized !== null) return normalized;
  if (storedVersion === undefined || storedVersion === null) {
    return SCORING_RULES_V3_VERSION;
  }

  throw new Error('This league uses an unsupported scoring-rules version.');
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
  const targetSnapshot = await loadSharedProjectionSnapshotForCycle(
    input.leagueId,
    targetCycleNumber,
  );
  let scoringRulesVersion: number;

  try {
    scoringRulesVersion = await loadLeagueScoringRulesVersion(input.leagueId);
  } catch (error: unknown) {
    return {
      metadata: null,
      assetsByKey: new Map(),
      source: 'none',
      refreshed: false,
      usedFallback: true,
      errorMessage: getErrorMessage(error),
    };
  }
  const freshnessInput = {
    teamCount: input.teamCount,
    requiredGamesPerCycle: input.requiredGamesPerCycle,
    scoringRulesVersion,
    targetCycleNumber,
    now: input.now,
  };

  if (
    !input.forceRefresh &&
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
    if (
      targetSnapshot?.metadata.status === 'ready' &&
      targetSnapshot.metadata.scoringRulesVersion === scoringRulesVersion
    ) {
      return {
        metadata: targetSnapshot.metadata,
        assetsByKey: toAssetMap(targetSnapshot),
        source: 'stale-target-fallback',
        refreshed: false,
        usedFallback: true,
        errorMessage: getErrorMessage(error),
      };
    }

    const loadedCurrentSnapshot = await loadSharedProjectionSnapshot(
      input.leagueId,
    ).catch(() => null);
    const currentSnapshot = loadedCurrentSnapshot?.metadata.scoringRulesVersion ===
      scoringRulesVersion
      ? loadedCurrentSnapshot
      : null;

    return {
      metadata: currentSnapshot?.metadata ?? null,
      assetsByKey: toAssetMap(currentSnapshot),
      source: currentSnapshot ? 'current-snapshot-fallback' : 'none',
      refreshed: false,
      usedFallback: true,
      errorMessage: getErrorMessage(error),
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
