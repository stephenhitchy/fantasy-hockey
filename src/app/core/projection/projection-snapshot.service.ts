import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { db } from '../firebase';
import { functions } from '../firebase-functions';
import { DraftableAsset } from '../draft/draft.models';

export const SHARED_PROJECTION_VERSION = 11;
export const PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION = 2;
export const PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION = 1;
export const PRE_DRAFT_PROJECTION_WARMUP_MINUTES = 20;
export const PRE_DRAFT_PROJECTION_FRESH_MINUTES = 45;
export const WINDOW_PROJECTION_FRESH_MINUTES = 6 * 60;

const SNAPSHOT_POINTER_ID = 'current';
const TARGET_CYCLE_POINTER_PREFIX = 'target-cycle-';
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
  authoritySchemaVersion?: number;
  generatedByAuthority?: 'server';
  catalogSnapshotId?: string;
  catalogHash?: string;
  catalogSeason?: string;
  canonicalAssetCount?: number;
  catalogValidationStatus?: 'validated';
  catalogCacheHit?: boolean;
  generationRequestId?: string;
  snapshotHashSchemaVersion?: number;
  snapshotHashAlgorithm?: 'sha256';
  snapshotContentHash?: string;
  snapshotChunkHashes?: string[];
  snapshotIntegrityStatus?: 'verified';
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
    authoritySchemaVersion:
      typeof data.authoritySchemaVersion === 'number'
        ? data.authoritySchemaVersion
        : undefined,
    generatedByAuthority:
      data.generatedByAuthority === 'server' ? 'server' : undefined,
    catalogSnapshotId:
      typeof data.catalogSnapshotId === 'string'
        ? data.catalogSnapshotId
        : undefined,
    catalogHash:
      typeof data.catalogHash === 'string' ? data.catalogHash : undefined,
    catalogSeason:
      typeof data.catalogSeason === 'string' ? data.catalogSeason : undefined,
    canonicalAssetCount:
      typeof data.canonicalAssetCount === 'number'
        ? data.canonicalAssetCount
        : undefined,
    catalogValidationStatus:
      data.catalogValidationStatus === 'validated' ? 'validated' : undefined,
    catalogCacheHit:
      typeof data.catalogCacheHit === 'boolean' ? data.catalogCacheHit : undefined,
    generationRequestId:
      typeof data.generationRequestId === 'string'
        ? data.generationRequestId
        : undefined,
    snapshotHashSchemaVersion:
      typeof data.snapshotHashSchemaVersion === 'number'
        ? data.snapshotHashSchemaVersion
        : undefined,
    snapshotHashAlgorithm:
      data.snapshotHashAlgorithm === 'sha256' ? 'sha256' : undefined,
    snapshotContentHash:
      typeof data.snapshotContentHash === 'string'
        ? data.snapshotContentHash
        : undefined,
    snapshotChunkHashes:
      Array.isArray(data.snapshotChunkHashes)
        ? data.snapshotChunkHashes.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
    snapshotIntegrityStatus:
      data.snapshotIntegrityStatus === 'verified' ? 'verified' : undefined,
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
    metadata.requiredGamesPerCycle !== Math.max(1, Math.floor(input.requiredGamesPerCycle)) ||
    metadata.generatedByAuthority !== 'server' ||
    metadata.authoritySchemaVersion !== PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION ||
    metadata.catalogValidationStatus !== 'validated' ||
    metadata.snapshotHashSchemaVersion !== PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION ||
    metadata.snapshotHashAlgorithm !== 'sha256' ||
    metadata.snapshotIntegrityStatus !== 'verified' ||
    !/^[a-f0-9]{64}$/.test(metadata.snapshotContentHash ?? '')
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

export function loadSharedProjectionSnapshotFresh(
  leagueId: string,
): Promise<SharedProjectionSnapshot | null> {
  const normalizedLeagueId = leagueId.trim();
  invalidateSharedProjectionReadCache(normalizedLeagueId);
  return loadProjectionSnapshotAtPointer(normalizedLeagueId, SNAPSHOT_POINTER_ID);
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

export function listenToSharedProjectionSnapshot(
  leagueId: string,
  callback: (snapshot: SharedProjectionSnapshot | null) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  const normalizedLeagueId = leagueId.trim();

  if (!normalizedLeagueId) {
    queueMicrotask(() => callback(null));
    return () => undefined;
  }

  let requestGeneration = 0;
  let lastSnapshotId = '';

  return onSnapshot(
    getProjectionSnapshotRef(normalizedLeagueId, SNAPSHOT_POINTER_ID),
    (pointerSnapshot) => {
      const metadata = pointerSnapshot.exists()
        ? normalizeMetadata(
            pointerSnapshot.data() as Partial<SharedProjectionSnapshotMetadata>,
          )
        : null;

      if (!metadata) {
        lastSnapshotId = '';
        callback(null);
        return;
      }

      if (metadata.activeSnapshotId === lastSnapshotId) {
        return;
      }

      lastSnapshotId = metadata.activeSnapshotId;
      const generation = ++requestGeneration;
      invalidateSharedProjectionReadCache(normalizedLeagueId);

      void loadSharedProjectionSnapshotById(
        normalizedLeagueId,
        metadata.activeSnapshotId,
      )
        .then((snapshot) => {
          if (generation === requestGeneration) {
            callback(snapshot);
          }
        })
        .catch((error: unknown) => {
          if (generation !== requestGeneration) {
            return;
          }

          const normalizedError = error instanceof Error
            ? error
            : new Error('Unable to load the latest Projection V11 snapshot.');
          onError?.(normalizedError);
        });
    },
    (error) => {
      onError?.(
        error instanceof Error
          ? error
          : new Error('Unable to follow Projection V11 updates.'),
      );
    },
  );
}

interface ProjectionGenerationCallableRequest {
  requestId: string;
  leagueId: string;
  generationReason: SharedProjectionGenerationReason;
  targetCycleNumber?: number;
}

export interface ProjectionGenerationQueueResult {
  requestId: string;
  status: 'queued' | 'ready';
  snapshotId: string | null;
  targetCycleNumber: number;
  message: string;
  reusedFreshSnapshot: boolean;
}

export type ProjectionIntegrityCommandAction = 'verify-current' | 'restore-previous';

export interface ProjectionIntegrityCommandResult {
  requestId: string;
  action: ProjectionIntegrityCommandAction;
  snapshotId: string;
  snapshotContentHash: string;
  targetCycleNumber: number;
  alreadySealed: boolean;
  restoredPointer: boolean;
  message: string;
}

interface ProjectionIntegrityCommandRequest {
  requestId: string;
  leagueId: string;
  action: ProjectionIntegrityCommandAction;
  reason: string;
}

interface ProjectionGenerationRequestState {
  leagueId?: unknown;
  status?: unknown;
  snapshotId?: unknown;
  message?: unknown;
  lastError?: unknown;
}

const requestProjectionSnapshotGenerationCallable = httpsCallable<
  ProjectionGenerationCallableRequest,
  ProjectionGenerationQueueResult
>(functions, 'requestProjectionSnapshotGeneration', {
  timeout: 30_000,
});

const manageProjectionSnapshotIntegrityCallable = httpsCallable<
  ProjectionIntegrityCommandRequest,
  ProjectionIntegrityCommandResult
>(functions, 'manageProjectionSnapshotIntegrity', {
  timeout: 135_000,
});

export function createSharedProjectionGenerationRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `projection-${crypto.randomUUID()}`;
  }

  return `projection-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

function waitForProjectionGeneration(
  leagueId: string,
  requestId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: Unsubscribe = () => {};
    const requestRef = doc(db, 'projectionGenerationRequests', requestId);
    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      unsubscribe();
      reject(
        new Error(
          'Projection generation is still running on the server. You can leave this page and try again shortly; the completed snapshot will be reused.',
        ),
      );
    }, 9 * 60 * 1000);

    unsubscribe = onSnapshot(
      requestRef,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (settled || !snapshot.exists() || snapshot.metadata.fromCache) {
          return;
        }

        const data = snapshot.data() as ProjectionGenerationRequestState;

        if (data.leagueId !== leagueId) {
          settled = true;
          window.clearTimeout(timeout);
          unsubscribe();
          reject(new Error('Projection request identity did not match this league.'));
          return;
        }

        if (data.status === 'ready' && typeof data.snapshotId === 'string' && data.snapshotId) {
          settled = true;
          window.clearTimeout(timeout);
          unsubscribe();
          resolve(data.snapshotId);
          return;
        }

        if (data.status === 'error') {
          settled = true;
          window.clearTimeout(timeout);
          unsubscribe();
          const message =
            typeof data.lastError === 'string' && data.lastError
              ? data.lastError
              : typeof data.message === 'string' && data.message
                ? data.message
                : 'Unable to generate the server projection snapshot.';
          reject(new Error(message));
        }
      },
      (error) => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeout);
        unsubscribe();
        reject(error);
      },
    );
  });
}

async function loadServerGeneratedSnapshot(
  leagueId: string,
  snapshotId: string,
): Promise<SharedProjectionSnapshot> {
  invalidateSharedProjectionReadCache(leagueId);
  const snapshot = await loadSharedProjectionSnapshotById(leagueId, snapshotId);

  if (!snapshot || snapshot.assets.length === 0) {
    throw new Error('The server finished projection generation, but the snapshot was incomplete.');
  }

  if (
    snapshot.metadata.generatedByAuthority !== 'server' ||
    snapshot.metadata.authoritySchemaVersion !== PROJECTION_SNAPSHOT_AUTHORITY_SCHEMA_VERSION ||
    snapshot.metadata.catalogValidationStatus !== 'validated' ||
    !snapshot.metadata.catalogSnapshotId ||
    !snapshot.metadata.catalogHash ||
    snapshot.metadata.snapshotHashSchemaVersion !== PROJECTION_SNAPSHOT_HASH_SCHEMA_VERSION ||
    snapshot.metadata.snapshotHashAlgorithm !== 'sha256' ||
    snapshot.metadata.snapshotIntegrityStatus !== 'verified' ||
    !/^[a-f0-9]{64}$/.test(snapshot.metadata.snapshotContentHash ?? '')
  ) {
    throw new Error(
      'The projection snapshot was not sealed by the current server catalog and content-hash authority.',
    );
  }

  return snapshot;
}

export async function manageProjectionSnapshotIntegrity(input: {
  leagueId: string;
  action: ProjectionIntegrityCommandAction;
  reason?: string;
}): Promise<{
  result: ProjectionIntegrityCommandResult;
  snapshot: SharedProjectionSnapshot;
}> {
  const leagueId = input.leagueId.trim();

  if (!leagueId) {
    throw new Error('A league is required to manage projection integrity.');
  }

  const response = await manageProjectionSnapshotIntegrityCallable({
    requestId: createSharedProjectionGenerationRequestId().replace(/^projection-/, 'projection-integrity-'),
    leagueId,
    action: input.action,
    reason: (input.reason ?? '').trim().slice(0, 300),
  });
  const result = response.data;

  invalidateSharedProjectionReadCache(leagueId);
  const snapshot = await loadSharedProjectionSnapshotById(leagueId, result.snapshotId);

  if (
    !snapshot ||
    snapshot.metadata.snapshotContentHash !== result.snapshotContentHash ||
    snapshot.metadata.snapshotIntegrityStatus !== 'verified'
  ) {
    throw new Error(
      'The server completed the projection integrity action, but the verified snapshot could not be reloaded.',
    );
  }

  return { result, snapshot };
}

export async function queueSharedProjectionSnapshotGeneration(
  input: GenerateSharedProjectionSnapshotInput & { requestId?: string },
): Promise<ProjectionGenerationQueueResult> {
  const leagueId = input.leagueId.trim();

  if (!leagueId) {
    throw new Error('A league is required to refresh projections.');
  }

  invalidateSharedProjectionReadCache(leagueId);
  const requestId = input.requestId?.trim() || createSharedProjectionGenerationRequestId();
  const response = await requestProjectionSnapshotGenerationCallable({
    requestId,
    leagueId,
    generationReason: input.generationReason ?? 'manual',
    targetCycleNumber:
      typeof input.targetCycleNumber === 'number'
        ? Math.max(1, Math.floor(input.targetCycleNumber))
        : undefined,
  });

  return response.data;
}

async function generateSnapshotInternal(
  input: GenerateSharedProjectionSnapshotInput,
): Promise<SharedProjectionSnapshot> {
  const leagueId = input.leagueId.trim();
  const result = await queueSharedProjectionSnapshotGeneration(input);
  const snapshotId =
    result.status === 'ready' && result.snapshotId
      ? result.snapshotId
      : await waitForProjectionGeneration(leagueId, result.requestId);

  return loadServerGeneratedSnapshot(leagueId, snapshotId);
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
