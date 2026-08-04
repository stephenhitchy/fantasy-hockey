import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';

import { auth, db } from '../firebase';

import { DraftableAsset } from '../draft/draft.models';

import { loadDraftPlayerPool } from '../draft/draft-player-pool.service';

import { getPlayerAvailabilityRecordsForLeague } from '../player/player-availability.service';

import {
  assertSharedProjectionPoolHealthy,
  rankSharedProjectionAssets,
} from './projection-ranking.util';

export const SHARED_PROJECTION_VERSION = 11;
export const PRE_DRAFT_PROJECTION_WARMUP_MINUTES = 20;
export const PRE_DRAFT_PROJECTION_FRESH_MINUTES = 45;
export const WINDOW_PROJECTION_FRESH_MINUTES = 6 * 60;

const SNAPSHOT_POINTER_ID = 'current';
const TARGET_CYCLE_POINTER_PREFIX = 'target-cycle-';
const SNAPSHOT_ASSET_WRITE_BATCH_SIZE = 400;
const SNAPSHOT_ASSET_CHUNK_SIZE = 25;
const generationByLeague = new Map<string, Promise<SharedProjectionSnapshot>>();

const SNAPSHOT_READ_CACHE_MILLISECONDS = 15_000;

const metadataReadCache = new Map<
  string,
  { loadedAt: number; value: SharedProjectionSnapshotMetadata | null }
>();

const snapshotReadCache = new Map<
  string,
  { loadedAt: number; value: SharedProjectionSnapshot | null }
>();

const metadataReadInFlight = new Map<string, Promise<SharedProjectionSnapshotMetadata | null>>();

const snapshotReadInFlight = new Map<string, Promise<SharedProjectionSnapshot | null>>();

export type SharedProjectionSnapshotStatus = 'building' | 'ready' | 'error';

export type SharedProjectionGenerationReason =
  | 'manual'
  | 'draft-setup'
  | 'pre-draft'
  | 'draft-start-fallback'
  | 'cycle-refresh'
  | 'window-boundary'
  | 'server-emergency';

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
  projectionAsOfDate?: string;
  projectionContext?: 'live' | 'historical-replay';
  projectionSeason?: string;
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

  /**
   * Optional exact fantasy window number. Independent roster slots may enter
   * different cycle numbers on different dates, so window-boundary projection
   * generation must not infer the target from the league's latest cycle.
   */
  targetCycleNumber?: number;
}

export interface DraftSnapshotFreshnessInput {
  teamCount: number;
  requiredGamesPerCycle: number;
  now?: Date;
}

function getProjectionSnapshotRef(leagueId: string, snapshotId: string) {
  return doc(db, 'leagues', leagueId, 'projectionSnapshots', snapshotId);
}

function getProjectionSnapshotAssetsRef(leagueId: string, snapshotId: string) {
  return collection(db, 'leagues', leagueId, 'projectionSnapshots', snapshotId, 'assets');
}

function getProjectionSnapshotAssetRef(leagueId: string, snapshotId: string, assetKey: string) {
  return doc(getProjectionSnapshotAssetsRef(leagueId, snapshotId), assetKey);
}

function getSnapshotSortNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : Number.MAX_SAFE_INTEGER;
}

function compareSnapshotAssetOrder(
  first: DraftableAsset,
  second: DraftableAsset,
): number {
  const firstName = first.assetType === 'skater'
    ? first.player.fullName
    : first.teamName;
  const secondName = second.assetType === 'skater'
    ? second.player.fullName
    : second.teamName;

  return (
    getSnapshotSortNumber(first.draftRank) - getSnapshotSortNumber(second.draftRank) ||
    getSnapshotSortNumber(first.balancedRank) - getSnapshotSortNumber(second.balancedRank) ||
    firstName.localeCompare(secondName) ||
    first.assetKey.localeCompare(second.assetKey)
  );
}

function sanitizeForFirestore<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeMetadata(
  data: Partial<SharedProjectionSnapshotMetadata>,
): SharedProjectionSnapshotMetadata | null {
  if (
    data.status !== 'ready' ||
    typeof data.activeSnapshotId !== 'string' ||
    !data.activeSnapshotId ||
    data.projectionVersion !== SHARED_PROJECTION_VERSION
  ) {
    return null;
  }

  const generatedAt = typeof data.generatedAt === 'string' ? data.generatedAt : '';

  const fallbackReadyUntil = generatedAt
    ? new Date(
        new Date(generatedAt).getTime() + PRE_DRAFT_PROJECTION_FRESH_MINUTES * 60 * 1000,
      ).toISOString()
    : '';

  return {
    snapshotId: typeof data.snapshotId === 'string' ? data.snapshotId : data.activeSnapshotId,
    activeSnapshotId: data.activeSnapshotId,
    status: 'ready',
    projectionVersion: SHARED_PROJECTION_VERSION,
    generatedAt,
    generatedBy: typeof data.generatedBy === 'string' ? data.generatedBy : '',
    assetCount: typeof data.assetCount === 'number' ? data.assetCount : 0,
    assetDocumentCount:
      typeof data.assetDocumentCount === 'number' ? data.assetDocumentCount : undefined,
    assetStorageVersion:
      typeof data.assetStorageVersion === 'number' ? data.assetStorageVersion : undefined,
    teamCount: typeof data.teamCount === 'number' ? data.teamCount : 0,
    targetCycleNumber: typeof data.targetCycleNumber === 'number' ? data.targetCycleNumber : 1,
    requiredGamesPerCycle:
      typeof data.requiredGamesPerCycle === 'number' ? data.requiredGamesPerCycle : 6,
    generationReason: data.generationReason ?? 'manual',
    draftReadyUntil:
      typeof data.draftReadyUntil === 'string' ? data.draftReadyUntil : fallbackReadyUntil,
    message: typeof data.message === 'string' ? data.message : 'Shared projections are ready.',
    projectionAsOfDate:
      typeof data.projectionAsOfDate === 'string'
        ? data.projectionAsOfDate
        : undefined,
    projectionContext:
      data.projectionContext === 'historical-replay'
        ? 'historical-replay'
        : data.projectionContext === 'live'
          ? 'live'
          : undefined,
    projectionSeason:
      typeof data.projectionSeason === 'string'
        ? data.projectionSeason
        : undefined,
  };
}

function isRecentRead(loadedAt: number): boolean {
  return Date.now() - loadedAt < SNAPSHOT_READ_CACHE_MILLISECONDS;
}

function getProjectionReadCacheKey(leagueId: string, pointerId: string): string {
  return `${leagueId}::${pointerId}`;
}

export function getTargetCycleProjectionPointerId(cycleNumber: number): string {
  return `${TARGET_CYCLE_POINTER_PREFIX}${Math.max(1, Math.floor(cycleNumber))}`;
}

function invalidateSharedProjectionReadCache(leagueId: string): void {
  const prefix = `${leagueId}::`;

  for (const key of metadataReadCache.keys()) {
    if (key.startsWith(prefix)) {
      metadataReadCache.delete(key);
    }
  }

  for (const key of snapshotReadCache.keys()) {
    if (key.startsWith(prefix)) {
      snapshotReadCache.delete(key);
    }
  }
}

function loadProjectionSnapshotMetadataAtPointer(
  leagueId: string,
  pointerId: string,
): Promise<SharedProjectionSnapshotMetadata | null> {
  const cacheKey = getProjectionReadCacheKey(leagueId, pointerId);
  const cached = metadataReadCache.get(cacheKey);

  if (cached && isRecentRead(cached.loadedAt)) {
    return Promise.resolve(cached.value);
  }

  const existingRequest = metadataReadInFlight.get(cacheKey);

  if (existingRequest) {
    return existingRequest;
  }

  const request = getDoc(getProjectionSnapshotRef(leagueId, pointerId))
    .then((pointerSnapshot) => {
      const value = pointerSnapshot.exists()
        ? normalizeMetadata(pointerSnapshot.data() as Partial<SharedProjectionSnapshotMetadata>)
        : null;

      metadataReadCache.set(cacheKey, {
        loadedAt: Date.now(),
        value,
      });

      return value;
    })
    .finally(() => {
      metadataReadInFlight.delete(cacheKey);
    });

  metadataReadInFlight.set(cacheKey, request);
  return request;
}

function loadProjectionSnapshotAtPointer(
  leagueId: string,
  pointerId: string,
): Promise<SharedProjectionSnapshot | null> {
  const cacheKey = getProjectionReadCacheKey(leagueId, pointerId);
  const cached = snapshotReadCache.get(cacheKey);

  if (cached && isRecentRead(cached.loadedAt)) {
    return Promise.resolve(cached.value);
  }

  const existingRequest = snapshotReadInFlight.get(cacheKey);

  if (existingRequest) {
    return existingRequest;
  }

  const request = loadProjectionSnapshotMetadataAtPointer(leagueId, pointerId)
    .then(async (metadata) => {
      if (!metadata || metadata.status !== 'ready') {
        return null;
      }

      const assetSnapshot = await getDocs(
        getProjectionSnapshotAssetsRef(leagueId, metadata.activeSnapshotId),
      );

      const assets = assetSnapshot.docs
        .flatMap((assetDocument: { data: () => unknown }) => {
          const data = assetDocument.data() as {
            assets?: unknown;
            assetKey?: unknown;
          };

          if (Array.isArray(data.assets)) {
            return data.assets as DraftableAsset[];
          }

          return typeof data.assetKey === 'string' ? [data as DraftableAsset] : [];
        })
        .sort(compareSnapshotAssetOrder);

      if (metadata.assetCount > 0 && assets.length !== metadata.assetCount) {
        throw new Error(
          `The shared projection snapshot is incomplete (${assets.length} of ${metadata.assetCount} assets loaded).`,
        );
      }

      return {
        metadata,
        assets,
      } satisfies SharedProjectionSnapshot;
    })
    .then((value) => {
      snapshotReadCache.set(cacheKey, {
        loadedAt: Date.now(),
        value,
      });

      return value;
    })
    .finally(() => {
      snapshotReadInFlight.delete(cacheKey);
    });

  snapshotReadInFlight.set(cacheKey, request);
  return request;
}

export function loadSharedProjectionSnapshotMetadata(
  leagueId: string,
): Promise<SharedProjectionSnapshotMetadata | null> {
  return loadProjectionSnapshotMetadataAtPointer(leagueId, SNAPSHOT_POINTER_ID);
}

export function loadSharedProjectionSnapshotMetadataForCycle(
  leagueId: string,
  cycleNumber: number,
): Promise<SharedProjectionSnapshotMetadata | null> {
  return loadProjectionSnapshotMetadataAtPointer(
    leagueId,
    getTargetCycleProjectionPointerId(cycleNumber),
  );
}

export function isSharedProjectionSnapshotFreshForDraft(
  metadata: SharedProjectionSnapshotMetadata | null,
  input: DraftSnapshotFreshnessInput,
): boolean {
  if (
    !metadata ||
    metadata.status !== 'ready' ||
    metadata.projectionVersion !== SHARED_PROJECTION_VERSION ||
    metadata.assetCount <= 0 ||
    metadata.teamCount !== Math.max(2, Math.floor(input.teamCount)) ||
    metadata.requiredGamesPerCycle !== Math.max(1, Math.floor(input.requiredGamesPerCycle))
  ) {
    return false;
  }

  const generatedAt = new Date(metadata.generatedAt);
  const readyUntil = new Date(metadata.draftReadyUntil);
  const now = input.now ?? new Date();

  if (Number.isNaN(generatedAt.getTime()) || Number.isNaN(readyUntil.getTime())) {
    return false;
  }

  return generatedAt.getTime() <= now.getTime() && readyUntil.getTime() >= now.getTime();
}

export interface WindowProjectionFreshnessInput extends DraftSnapshotFreshnessInput {
  targetCycleNumber: number;
  freshMinutes?: number;
}

export function isSharedProjectionSnapshotFreshForWindow(
  metadata: SharedProjectionSnapshotMetadata | null,
  input: WindowProjectionFreshnessInput,
): boolean {
  if (
    !metadata ||
    metadata.status !== 'ready' ||
    metadata.projectionVersion !== SHARED_PROJECTION_VERSION ||
    metadata.assetCount <= 0 ||
    metadata.teamCount !== Math.max(2, Math.floor(input.teamCount)) ||
    metadata.requiredGamesPerCycle !== Math.max(1, Math.floor(input.requiredGamesPerCycle)) ||
    metadata.targetCycleNumber !== Math.max(1, Math.floor(input.targetCycleNumber))
  ) {
    return false;
  }

  const generatedAt = Date.parse(metadata.generatedAt);
  const now = (input.now ?? new Date()).getTime();
  const freshMinutes = Math.max(
    1,
    Math.floor(input.freshMinutes ?? WINDOW_PROJECTION_FRESH_MINUTES),
  );

  return (
    Number.isFinite(generatedAt) &&
    generatedAt <= now &&
    generatedAt + freshMinutes * 60 * 1000 >= now
  );
}

export function loadSharedProjectionSnapshot(
  leagueId: string,
): Promise<SharedProjectionSnapshot | null> {
  return loadProjectionSnapshotAtPointer(leagueId, SNAPSHOT_POINTER_ID);
}

export function loadSharedProjectionSnapshotById(
  leagueId: string,
  snapshotId: string,
): Promise<SharedProjectionSnapshot | null> {
  return loadProjectionSnapshotAtPointer(leagueId, snapshotId);
}

export function loadSharedProjectionSnapshotForCycle(
  leagueId: string,
  cycleNumber: number,
): Promise<SharedProjectionSnapshot | null> {
  return loadProjectionSnapshotAtPointer(leagueId, getTargetCycleProjectionPointerId(cycleNumber));
}

async function getLatestCycleNumberForProjection(leagueId: string): Promise<number | null> {
  const snapshot = await getDocs(
    query(collection(db, 'leagues', leagueId, 'cycles'), orderBy('cycleNumber', 'desc'), limit(1)),
  );
  const cycleNumber = snapshot.docs[0]?.data()?.['cycleNumber'];

  return typeof cycleNumber === 'number' && Number.isFinite(cycleNumber)
    ? Math.max(1, Math.floor(cycleNumber))
    : null;
}

async function generateSnapshotInternal(
  input: GenerateSharedProjectionSnapshotInput,
): Promise<SharedProjectionSnapshot> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to refresh shared projections.');
  }

  const leagueId = input.leagueId.trim();

  if (!leagueId) {
    throw new Error('A league is required to refresh projections.');
  }

  const teamCount = Math.max(2, Math.floor(input.teamCount));
  const requiredGamesPerCycle = Math.max(1, Math.floor(input.requiredGamesPerCycle));

  // Any new generation makes previously cached metadata/assets stale.
  invalidateSharedProjectionReadCache(leagueId);

  const requestedTargetCycleNumber =
    typeof input.targetCycleNumber === 'number'
      ? Math.max(1, Math.floor(input.targetCycleNumber))
      : null;
  const latestCycleNumber =
    requestedTargetCycleNumber === null ? await getLatestCycleNumberForProjection(leagueId) : null;
  const targetCycleNumber =
    requestedTargetCycleNumber ?? (latestCycleNumber ? latestCycleNumber + 1 : 1);

  const snapshotId = [Date.now(), user.uid.slice(0, 12)].join('-');

  const generatedAt = new Date().toISOString();
  const draftReadyUntil = new Date(
    Date.now() + PRE_DRAFT_PROJECTION_FRESH_MINUTES * 60 * 1000,
  ).toISOString();

  const generationReason = input.generationReason ?? 'manual';

  const snapshotRef = getProjectionSnapshotRef(leagueId, snapshotId);

  const buildingMetadata = {
    snapshotId,
    activeSnapshotId: snapshotId,
    status: 'building' as const,
    projectionVersion: SHARED_PROJECTION_VERSION,
    generatedAt,
    generatedAtServer: serverTimestamp(),
    generatedBy: user.uid,
    assetCount: 0,
    teamCount,
    targetCycleNumber,
    requiredGamesPerCycle,
    generationReason,
    draftReadyUntil,
    message: 'Building shared projections.',
    projectionAsOfDate: generatedAt.slice(0, 10),
    projectionContext: 'live' as const,
  };

  await setDoc(snapshotRef, buildingMetadata);

  try {
    const availabilityByPlayerId = await getPlayerAvailabilityRecordsForLeague(leagueId);

    const localAssets = await loadDraftPlayerPool({
      forceRefresh: true,
      targetCycleNumber,
      requiredGamesPerCycle,
      availabilityByPlayerId,
    });

    assertSharedProjectionPoolHealthy(localAssets);

    const rankedAssets = rankSharedProjectionAssets(localAssets, teamCount).map((asset) => ({
      ...asset,
      sharedProjectionSnapshotId: snapshotId,
      projectionGeneratedAt: generatedAt,
    }));

    const assetChunks: DraftableAsset[][] = [];

    for (let index = 0; index < rankedAssets.length; index += SNAPSHOT_ASSET_CHUNK_SIZE) {
      assetChunks.push(rankedAssets.slice(index, index + SNAPSHOT_ASSET_CHUNK_SIZE));
    }

    for (let index = 0; index < assetChunks.length; index += SNAPSHOT_ASSET_WRITE_BATCH_SIZE) {
      const batch = writeBatch(db);
      const chunkBatch = assetChunks.slice(index, index + SNAPSHOT_ASSET_WRITE_BATCH_SIZE);

      chunkBatch.forEach((assets, offset) => {
        const chunkIndex = index + offset;
        const chunkId = `chunk-${String(chunkIndex + 1).padStart(4, '0')}`;

        batch.set(
          getProjectionSnapshotAssetRef(leagueId, snapshotId, chunkId),
          sanitizeForFirestore({
            schemaVersion: 2,
            chunkIndex,
            assetCount: assets.length,
            sharedProjectionSnapshotId: snapshotId,
            assets,
          }),
        );
      });

      await batch.commit();
    }

    const metadata: SharedProjectionSnapshotMetadata = {
      snapshotId,
      activeSnapshotId: snapshotId,
      status: 'ready',
      projectionVersion: SHARED_PROJECTION_VERSION,
      generatedAt,
      generatedBy: user.uid,
      assetCount: rankedAssets.length,
      assetDocumentCount: assetChunks.length,
      assetStorageVersion: 2,
      teamCount,
      targetCycleNumber,
      requiredGamesPerCycle,
      generationReason,
      draftReadyUntil,
      message: `Shared draft rankings and Matchup ${targetCycleNumber} projections are ready.`,
      projectionAsOfDate: generatedAt.slice(0, 10),
      projectionContext: 'live',
    };

    const finalBatch = writeBatch(db);

    finalBatch.set(snapshotRef, {
      ...metadata,
      generatedAtServer: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const pointerPayload = {
      ...metadata,
      generatedAtServer: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    finalBatch.set(
      getProjectionSnapshotRef(leagueId, getTargetCycleProjectionPointerId(targetCycleNumber)),
      pointerPayload,
    );

    // Window-boundary snapshots are intentionally target-specific. A slower
    // slot can still enter Cycle N after a faster slot has reached Cycle N+1;
    // it must not move the league-wide draft/free-agent pointer backwards.
    if (generationReason !== 'window-boundary') {
      finalBatch.set(getProjectionSnapshotRef(leagueId, SNAPSHOT_POINTER_ID), pointerPayload);
    }

    await finalBatch.commit();

    const completedSnapshot: SharedProjectionSnapshot = {
      metadata,
      assets: rankedAssets,
    };

    const loadedAt = Date.now();

    const targetCacheKey = getProjectionReadCacheKey(
      leagueId,
      getTargetCycleProjectionPointerId(targetCycleNumber),
    );

    metadataReadCache.set(targetCacheKey, {
      loadedAt,
      value: metadata,
    });

    snapshotReadCache.set(targetCacheKey, {
      loadedAt,
      value: completedSnapshot,
    });

    if (generationReason !== 'window-boundary') {
      const currentCacheKey = getProjectionReadCacheKey(leagueId, SNAPSHOT_POINTER_ID);

      metadataReadCache.set(currentCacheKey, {
        loadedAt,
        value: metadata,
      });

      snapshotReadCache.set(currentCacheKey, {
        loadedAt,
        value: completedSnapshot,
      });
    }

    return completedSnapshot;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Unable to generate shared projections.';

    try {
      await setDoc(
        snapshotRef,
        {
          ...buildingMetadata,
          status: 'error',
          message,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch {
      // Preserve the original projection error.
    }

    throw error;
  }
}

export async function generateSharedProjectionSnapshot(
  input: GenerateSharedProjectionSnapshotInput,
): Promise<SharedProjectionSnapshot> {
  const leagueId = input.leagueId.trim();
  const targetKey =
    typeof input.targetCycleNumber === 'number'
      ? String(Math.max(1, Math.floor(input.targetCycleNumber)))
      : 'auto';
  const generationKey = `${leagueId}::${targetKey}`;
  const existing = generationByLeague.get(generationKey);

  if (existing) {
    return existing;
  }

  const generation = generateSnapshotInternal(input).finally(() => {
    generationByLeague.delete(generationKey);
  });

  generationByLeague.set(generationKey, generation);

  return generation;
}
