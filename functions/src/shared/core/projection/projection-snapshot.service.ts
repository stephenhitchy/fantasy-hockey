import {
  collection,
  doc,
  getDoc,
  getDocs,
} from '../firebase-admin-compat';
import { db } from '../firebase';
import { DraftableAsset } from '../draft/draft.models';

export const SHARED_PROJECTION_VERSION = 8;
export const WINDOW_PROJECTION_FRESH_MINUTES = 6 * 60;

export type SharedProjectionSnapshotStatus = 'building' | 'ready' | 'error';

export type SharedProjectionGenerationReason =
  | 'manual'
  | 'draft-setup'
  | 'pre-draft'
  | 'draft-start-fallback'
  | 'cycle-refresh'
  | 'window-boundary';

export interface SharedProjectionSnapshotMetadata {
  snapshotId: string;
  activeSnapshotId: string;
  status: SharedProjectionSnapshotStatus;
  projectionVersion: number;
  generatedAt: string;
  generatedBy: string;
  assetCount: number;
  assetDocumentCount?: number;
  assetStorageVersion?: number;
  teamCount: number;
  targetCycleNumber: number;
  requiredGamesPerCycle: number;
  generationReason: SharedProjectionGenerationReason;
  draftReadyUntil: string;
  message: string;
}

export interface SharedProjectionSnapshot {
  metadata: SharedProjectionSnapshotMetadata;
  assets: DraftableAsset[];
}

export interface GenerateSharedProjectionSnapshotInput {
  leagueId: string;
  teamCount: number;
  requiredGamesPerCycle: number;
  generationReason?: SharedProjectionGenerationReason;
  targetCycleNumber?: number;
}

export interface WindowSnapshotFreshnessInput {
  teamCount: number;
  requiredGamesPerCycle: number;
  targetCycleNumber: number;
  now?: Date;
}

function getPointerRef(leagueId: string, pointerId: string) {
  return doc(db, 'leagues', leagueId, 'projectionSnapshots', pointerId);
}

function getAssetsRef(leagueId: string, snapshotId: string) {
  return collection(db, 'leagues', leagueId, 'projectionSnapshots', snapshotId, 'assets');
}

function normalizeMetadata(value: Partial<SharedProjectionSnapshotMetadata>): SharedProjectionSnapshotMetadata | null {
  if (
    typeof value.activeSnapshotId !== 'string' ||
    !value.activeSnapshotId ||
    value.status !== 'ready' ||
    value.projectionVersion !== SHARED_PROJECTION_VERSION
  ) {
    return null;
  }

  return {
    snapshotId:
      typeof value.snapshotId === 'string'
        ? value.snapshotId
        : value.activeSnapshotId,
    activeSnapshotId: value.activeSnapshotId,
    status: 'ready',
    projectionVersion: SHARED_PROJECTION_VERSION,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    generatedBy: typeof value.generatedBy === 'string' ? value.generatedBy : 'server',
    assetCount: typeof value.assetCount === 'number' ? value.assetCount : 0,
    assetDocumentCount:
      typeof value.assetDocumentCount === 'number' ? value.assetDocumentCount : undefined,
    assetStorageVersion:
      typeof value.assetStorageVersion === 'number' ? value.assetStorageVersion : undefined,
    teamCount: typeof value.teamCount === 'number' ? value.teamCount : 0,
    targetCycleNumber:
      typeof value.targetCycleNumber === 'number' ? value.targetCycleNumber : 1,
    requiredGamesPerCycle:
      typeof value.requiredGamesPerCycle === 'number' ? value.requiredGamesPerCycle : 6,
    generationReason: value.generationReason ?? 'window-boundary',
    draftReadyUntil: typeof value.draftReadyUntil === 'string' ? value.draftReadyUntil : '',
    message: typeof value.message === 'string' ? value.message : '',
  };
}

async function loadSnapshotFromPointer(
  leagueId: string,
  pointerId: string,
): Promise<SharedProjectionSnapshot | null> {
  const pointerSnapshot = await getDoc(getPointerRef(leagueId, pointerId));

  if (!pointerSnapshot.exists()) {
    return null;
  }

  const pointer = pointerSnapshot.data() as Partial<SharedProjectionSnapshotMetadata>;
  const metadata = normalizeMetadata(pointer);

  if (!metadata) {
    return null;
  }

  const assetSnapshot = await getDocs(
    getAssetsRef(leagueId, metadata.activeSnapshotId),
  );
  const assets = assetSnapshot.docs.flatMap((document) => {
    const data = document.data() as {
      assets?: unknown;
      assetKey?: unknown;
    };

    if (Array.isArray(data.assets)) {
      return data.assets as DraftableAsset[];
    }

    return typeof data.assetKey === 'string'
      ? [data as DraftableAsset]
      : [];
  });

  if (metadata.assetCount > 0 && assets.length !== metadata.assetCount) {
    throw new Error(
      `The shared projection snapshot is incomplete (${assets.length} of ${metadata.assetCount} assets loaded).`,
    );
  }

  return {
    metadata,
    assets,
  };
}

export function isSharedProjectionSnapshotFreshForWindow(
  metadata: SharedProjectionSnapshotMetadata | null,
  input: WindowSnapshotFreshnessInput,
): boolean {
  if (
    !metadata ||
    metadata.status !== 'ready' ||
    metadata.teamCount !== input.teamCount ||
    metadata.requiredGamesPerCycle !== input.requiredGamesPerCycle ||
    metadata.targetCycleNumber !== input.targetCycleNumber
  ) {
    return false;
  }

  const generatedAt = Date.parse(metadata.generatedAt);
  const now = input.now?.getTime() ?? Date.now();

  return Number.isFinite(generatedAt) &&
    now - generatedAt <= WINDOW_PROJECTION_FRESH_MINUTES * 60_000;
}

export function loadSharedProjectionSnapshot(
  leagueId: string,
): Promise<SharedProjectionSnapshot | null> {
  return loadSnapshotFromPointer(leagueId, 'current');
}

export function loadSharedProjectionSnapshotForCycle(
  leagueId: string,
  cycleNumber: number,
): Promise<SharedProjectionSnapshot | null> {
  return loadSnapshotFromPointer(leagueId, `target-cycle-${Math.max(1, Math.floor(cycleNumber))}`);
}

export async function generateSharedProjectionSnapshot(
  _input: GenerateSharedProjectionSnapshotInput,
): Promise<SharedProjectionSnapshot> {
  throw new Error(
    'The server scoring worker could not refresh projections. It will preserve the best saved or roster-based projection while continuing cycle automation.',
  );
}
