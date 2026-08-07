import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  writeBatch,
} from '../firebase-admin-compat';
import { db } from '../firebase';
import { DraftableAsset, DraftPosition, SharedProjectionAvailabilityStatus } from '../draft/draft.models';
import { loadDraftPlayerPool } from '../draft/draft-player-pool.service';
import { getCurrentNhlDraftSkaters, NHL_DRAFT_CLUBS } from '../nhl/nhl-api.service';
import {
  PlayerAvailabilityDatabaseRecord,
  PlayerAvailabilityStatus,
} from '../player/player-availability.models';
import {
  assertSharedProjectionPoolHealthy,
  rankSharedProjectionAssets,
} from './projection-ranking.util';
import {
  ensureCanonicalProjectionAssetCatalog,
  validateProjectionAssetsAgainstCatalog,
} from './projection-asset-catalog.service';

export const SHARED_PROJECTION_VERSION = 11;
export const WINDOW_PROJECTION_FRESH_MINUTES = 6 * 60;

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
  requestedBy?: string;
  generationRequestId?: string;
}

export interface WindowSnapshotFreshnessInput {
  teamCount: number;
  requiredGamesPerCycle: number;
  targetCycleNumber: number;
  now?: Date;
  expectedProjectionAsOfDate?: string;
  expectedProjectionContext?: 'live' | 'historical-replay';
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
    projectionAsOfDate:
      typeof value.projectionAsOfDate === 'string'
        ? value.projectionAsOfDate
        : undefined,
    projectionContext:
      value.projectionContext === 'historical-replay'
        ? 'historical-replay'
        : value.projectionContext === 'live'
          ? 'live'
          : undefined,
    projectionSeason:
      typeof value.projectionSeason === 'string'
        ? value.projectionSeason
        : undefined,
    authoritySchemaVersion:
      typeof value.authoritySchemaVersion === 'number'
        ? value.authoritySchemaVersion
        : undefined,
    generatedByAuthority:
      value.generatedByAuthority === 'server' ? 'server' : undefined,
    catalogSnapshotId:
      typeof value.catalogSnapshotId === 'string'
        ? value.catalogSnapshotId
        : undefined,
    catalogHash:
      typeof value.catalogHash === 'string' ? value.catalogHash : undefined,
    catalogSeason:
      typeof value.catalogSeason === 'string' ? value.catalogSeason : undefined,
    canonicalAssetCount:
      typeof value.canonicalAssetCount === 'number'
        ? value.canonicalAssetCount
        : undefined,
    catalogValidationStatus:
      value.catalogValidationStatus === 'validated' ? 'validated' : undefined,
    catalogCacheHit:
      typeof value.catalogCacheHit === 'boolean' ? value.catalogCacheHit : undefined,
    generationRequestId:
      typeof value.generationRequestId === 'string'
        ? value.generationRequestId
        : undefined,
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
    metadata.targetCycleNumber !== input.targetCycleNumber ||
    (input.expectedProjectionAsOfDate !== undefined &&
      metadata.projectionAsOfDate !== input.expectedProjectionAsOfDate) ||
    (input.expectedProjectionContext !== undefined &&
      metadata.projectionContext !== input.expectedProjectionContext)
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

const SNAPSHOT_ASSET_WRITE_BATCH_SIZE = 400;
const SNAPSHOT_ASSET_CHUNK_SIZE = 25;
const generationByLeagueAndCycle = new Map<string, Promise<SharedProjectionSnapshot>>();

interface HistoricalReplayProjectionContext {
  enabled: true;
  targetSeason: string;
  sourceSeason: string;
  simulatedDate: string;
}

interface ProjectionGenerationContext {
  projectionDate: Date;
  projectionAsOfDate: string;
  projectionContext: 'live' | 'historical-replay';
  projectionSeason: string;
  currentSeasonOverride?: string;
  previousSeasonOverride?: string;
  secondPreviousSeasonOverride?: string;
  ignoreAvailability: boolean;
  availabilityByPlayerId: ReadonlyMap<number, PlayerAvailabilityDatabaseRecord>;
}

const VALID_AVAILABILITY_STATUSES = new Set<PlayerAvailabilityStatus>([
  'active',
  'day-to-day',
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
  'suspended',
  'personal-leave',
  'unknown',
]);

function sanitizeForFirestore<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toIsoDate(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }

  return '';
}

function previousSeason(season: string): string {
  const startYear = Number(season.slice(0, 4));

  if (!/^\d{8}$/.test(season) || !Number.isFinite(startYear)) {
    return season;
  }

  return `${startYear - 1}${startYear}`;
}

function seasonForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() + 1 >= 7 ? year : year - 1;
  return `${startYear}${startYear + 1}`;
}

function isIrEligible(status: PlayerAvailabilityStatus): boolean {
  return (
    status === 'out' ||
    status === 'injured-reserve' ||
    status === 'long-term-injured-reserve'
  );
}

function normalizeAvailabilityRecord(
  value: unknown,
  leagueId: string,
  defaultSource: 'espn' | 'commissioner',
): PlayerAvailabilityDatabaseRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const data = value as Record<string, unknown>;
  const playerId = data['playerId'];
  const playerName = data['playerName'];
  const statusValue = data['status'];

  if (
    typeof playerId !== 'number' ||
    !Number.isFinite(playerId) ||
    typeof playerName !== 'string' ||
    typeof statusValue !== 'string' ||
    !VALID_AVAILABILITY_STATUSES.has(statusValue as PlayerAvailabilityStatus)
  ) {
    return null;
  }

  const status = statusValue as PlayerAvailabilityStatus;
  const source = data['source'] === 'commissioner'
    ? 'commissioner'
    : defaultSource;

  return {
    playerId,
    playerName,
    status,
    note: typeof data['note'] === 'string' ? data['note'] : '',
    irEligible: isIrEligible(status),
    updatedAt: toIsoDate(data['updatedAt']),
    updatedBy: typeof data['updatedBy'] === 'string' ? data['updatedBy'] : '',
    source,
    leagueId: source === 'commissioner' ? leagueId : 'global',
    externalSource: data['externalSource'] === 'ESPN' ? 'ESPN' : undefined,
    externalStatus:
      typeof data['externalStatus'] === 'string'
        ? data['externalStatus']
        : undefined,
    externalReturnDate:
      typeof data['externalReturnDate'] === 'string'
        ? data['externalReturnDate']
        : undefined,
    externalInjuryDate:
      typeof data['externalInjuryDate'] === 'string'
        ? data['externalInjuryDate']
        : undefined,
    externalTeamName:
      typeof data['externalTeamName'] === 'string'
        ? data['externalTeamName']
        : undefined,
    syncedAt: toIsoDate(data['syncedAt']) || undefined,
  };
}

async function loadAvailabilityRecords(
  leagueId: string,
): Promise<ReadonlyMap<number, PlayerAvailabilityDatabaseRecord>> {
  const records = new Map<number, PlayerAvailabilityDatabaseRecord>();
  const [globalSnapshot, manualSnapshot] = await Promise.all([
    getDoc(doc(db, 'appData', 'playerAvailability')).catch(() => null),
    getDocs(collection(db, 'leagues', leagueId, 'playerAvailability')).catch(() => null),
  ]);
  const globalData = globalSnapshot?.data() as Record<string, unknown> | undefined;
  const globalRecords = Array.isArray(globalData?.['records'])
    ? globalData?.['records'] as unknown[]
    : [];

  for (const value of globalRecords) {
    const record = normalizeAvailabilityRecord(value, leagueId, 'espn');

    if (record) {
      records.set(record.playerId, record);
    }
  }

  for (const document of manualSnapshot?.docs ?? []) {
    const record = normalizeAvailabilityRecord(
      document.data(),
      leagueId,
      'commissioner',
    );

    if (record?.source === 'commissioner') {
      records.set(record.playerId, record);
    }
  }

  return records;
}

async function loadHistoricalReplayProjectionContext(
  leagueId: string,
): Promise<HistoricalReplayProjectionContext | null> {
  const snapshot = await getDoc(
    doc(db, 'leagues', leagueId, 'historicalReplay', 'control'),
  ).catch(() => null);

  if (!snapshot?.exists()) {
    return null;
  }

  const data = snapshot.data() as Record<string, unknown>;
  const targetSeason = data['targetSeason'];
  const sourceSeason = data['sourceSeason'];
  const simulatedDate = data['simulatedDate'];

  if (
    data['enabled'] !== true ||
    typeof targetSeason !== 'string' ||
    !/^\d{8}$/.test(targetSeason) ||
    typeof sourceSeason !== 'string' ||
    !/^\d{8}$/.test(sourceSeason) ||
    typeof simulatedDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(simulatedDate)
  ) {
    return null;
  }

  return {
    enabled: true,
    targetSeason,
    sourceSeason,
    simulatedDate,
  };
}

export interface ExpectedProjectionSnapshotContext {
  projectionAsOfDate: string;
  projectionContext: 'live' | 'historical-replay';
}

/**
 * Returns the date/context that a window-boundary snapshot must represent.
 * Historical replay advances many simulated days within a few real minutes,
 * so elapsed wall-clock freshness alone is not enough: a Matchup 2 slot that
 * opens on a later replay date must not reuse an earlier-date projection just
 * because that snapshot was generated less than six hours ago.
 */
export async function getExpectedProjectionSnapshotContext(
  leagueId: string,
  now: Date = new Date(),
): Promise<ExpectedProjectionSnapshotContext> {
  const replay = await loadHistoricalReplayProjectionContext(leagueId);

  if (replay) {
    return {
      projectionAsOfDate: replay.simulatedDate,
      projectionContext: 'historical-replay',
    };
  }

  return {
    projectionAsOfDate: now.toISOString().slice(0, 10),
    projectionContext: 'live',
  };
}

async function getProjectionGenerationContext(
  leagueId: string,
): Promise<ProjectionGenerationContext> {
  const replay = await loadHistoricalReplayProjectionContext(leagueId);

  if (replay) {
    const projectionDate = new Date(`${replay.simulatedDate}T12:00:00Z`);

    /*
     * Replay projections deliberately use the replay target as the empty/current
     * season and the source season as the latest completed season. This prevents
     * future source-season games from leaking into a simulated date while still
     * letting Projection V11 recognize supported completed-season breakouts.
     * Live 2026 injury records are ignored during a historical replay.
     */
    return {
      projectionDate,
      projectionAsOfDate: replay.simulatedDate,
      projectionContext: 'historical-replay',
      projectionSeason: replay.targetSeason,
      currentSeasonOverride: replay.targetSeason,
      previousSeasonOverride: replay.sourceSeason,
      secondPreviousSeasonOverride: previousSeason(replay.sourceSeason),
      ignoreAvailability: true,
      availabilityByPlayerId: new Map(),
    };
  }

  const projectionDate = new Date();

  return {
    projectionDate,
    projectionAsOfDate: projectionDate.toISOString().slice(0, 10),
    projectionContext: 'live',
    projectionSeason: seasonForDate(projectionDate),
    ignoreAvailability: false,
    availabilityByPlayerId: await loadAvailabilityRecords(leagueId),
  };
}

async function generateSnapshotInternal(
  input: GenerateSharedProjectionSnapshotInput,
): Promise<SharedProjectionSnapshot> {
  const leagueId = input.leagueId.trim();

  if (!leagueId) {
    throw new Error('A league is required to refresh shared projections.');
  }

  const teamCount = Math.max(2, Math.floor(input.teamCount));
  const requiredGamesPerCycle = Math.max(
    1,
    Math.floor(input.requiredGamesPerCycle),
  );
  const targetCycleNumber = Math.max(
    1,
    Math.floor(input.targetCycleNumber ?? 1),
  );
  const generationReason = input.generationReason ?? 'window-boundary';
  const generatedAt = new Date().toISOString();
  const snapshotId = `server-v${SHARED_PROJECTION_VERSION}-${Date.now()}-${targetCycleNumber}`;
  const draftReadyUntil = new Date(
    Date.now() + WINDOW_PROJECTION_FRESH_MINUTES * 60_000,
  ).toISOString();
  const snapshotRef = doc(
    db,
    'leagues',
    leagueId,
    'projectionSnapshots',
    snapshotId,
  );
  const context = await getProjectionGenerationContext(leagueId);
  const buildingMetadata = {
    snapshotId,
    activeSnapshotId: snapshotId,
    status: 'building' as const,
    projectionVersion: SHARED_PROJECTION_VERSION,
    generatedAt,
    generatedAtServer: serverTimestamp(),
    generatedBy: input.requestedBy
      ? `server:projection-authority:${input.requestedBy}`
      : 'server:window-projection',
    authoritySchemaVersion: 1,
    generatedByAuthority: 'server' as const,
    generationRequestId: input.generationRequestId ?? '',
    assetCount: 0,
    teamCount,
    targetCycleNumber,
    requiredGamesPerCycle,
    generationReason,
    draftReadyUntil,
    message: 'Building server-authoritative shared projections.',
    projectionAsOfDate: context.projectionAsOfDate,
    projectionContext: context.projectionContext,
    projectionSeason: context.projectionSeason,
  };

  const buildingBatch = writeBatch(db);
  buildingBatch.set(snapshotRef, buildingMetadata);
  await buildingBatch.commit();

  try {
    const localAssets = await loadDraftPlayerPool({
      forceRefresh: true,
      targetCycleNumber,
      requiredGamesPerCycle,
      availabilityByPlayerId: context.availabilityByPlayerId,
      currentSeasonOverride: context.currentSeasonOverride,
      previousSeasonOverride: context.previousSeasonOverride,
      secondPreviousSeasonOverride: context.secondPreviousSeasonOverride,
      projectionAsOfDate: context.projectionDate,
      ignoreAvailability: context.ignoreAvailability,
    });

    assertSharedProjectionPoolHealthy(localAssets);

    const rankedAssets = rankSharedProjectionAssets(
      localAssets,
      teamCount,
    ).map((asset) => ({
      ...asset,
      sharedProjectionSnapshotId: snapshotId,
      projectionGeneratedAt: generatedAt,
    }));
    const catalog = await ensureCanonicalProjectionAssetCatalog();
    const catalogValidation = validateProjectionAssetsAgainstCatalog(
      rankedAssets,
      catalog,
    );
    const assetChunks: DraftableAsset[][] = [];

    for (
      let index = 0;
      index < rankedAssets.length;
      index += SNAPSHOT_ASSET_CHUNK_SIZE
    ) {
      assetChunks.push(
        rankedAssets.slice(index, index + SNAPSHOT_ASSET_CHUNK_SIZE),
      );
    }

    for (
      let index = 0;
      index < assetChunks.length;
      index += SNAPSHOT_ASSET_WRITE_BATCH_SIZE
    ) {
      const batch = writeBatch(db);
      const chunkBatch = assetChunks.slice(
        index,
        index + SNAPSHOT_ASSET_WRITE_BATCH_SIZE,
      );

      chunkBatch.forEach((chunkAssets, offset) => {
        const chunkIndex = index + offset;
        const chunkId = `chunk-${String(chunkIndex + 1).padStart(4, '0')}`;

        batch.set(
          doc(
            db,
            'leagues',
            leagueId,
            'projectionSnapshots',
            snapshotId,
            'assets',
            chunkId,
          ),
          sanitizeForFirestore({
            schemaVersion: 2,
            chunkIndex,
            assetCount: chunkAssets.length,
            sharedProjectionSnapshotId: snapshotId,
            assets: chunkAssets,
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
      generatedBy: input.requestedBy
        ? `server:projection-authority:${input.requestedBy}`
        : 'server:window-projection',
      assetCount: rankedAssets.length,
      assetDocumentCount: assetChunks.length,
      assetStorageVersion: 2,
      teamCount,
      targetCycleNumber,
      requiredGamesPerCycle,
      generationReason,
      draftReadyUntil,
      message:
        context.projectionContext === 'historical-replay'
          ? `Replay-safe Matchup ${targetCycleNumber} projections are ready as of ${context.projectionAsOfDate}.`
          : `Fresh Matchup ${targetCycleNumber} projections are ready.`,
      projectionAsOfDate: context.projectionAsOfDate,
      projectionContext: context.projectionContext,
      projectionSeason: context.projectionSeason,
      authoritySchemaVersion: 1,
      generatedByAuthority: 'server',
      catalogSnapshotId: catalogValidation.catalogId,
      catalogHash: catalogValidation.catalogHash,
      catalogSeason: catalogValidation.catalogSeason,
      canonicalAssetCount: catalogValidation.validatedAssetCount,
      catalogValidationStatus: 'validated',
      catalogCacheHit: catalogValidation.catalogCacheHit,
      ...(input.generationRequestId
        ? { generationRequestId: input.generationRequestId }
        : {}),
    };
    const pointerPayload = {
      ...metadata,
      generatedAtServer: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const finalBatch = writeBatch(db);

    finalBatch.set(snapshotRef, pointerPayload);
    finalBatch.set(
      doc(
        db,
        'leagues',
        leagueId,
        'projectionSnapshots',
        `target-cycle-${targetCycleNumber}`,
      ),
      pointerPayload,
    );

    if (generationReason !== 'window-boundary') {
      finalBatch.set(
        doc(db, 'leagues', leagueId, 'projectionSnapshots', 'current'),
        pointerPayload,
      );
    }

    await finalBatch.commit();

    return {
      metadata,
      assets: rankedAssets,
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Unable to generate server-authoritative projections.';
    const errorBatch = writeBatch(db);

    errorBatch.set(
      snapshotRef,
      {
        ...buildingMetadata,
        status: 'error',
        message,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    await errorBatch.commit().catch(() => undefined);
    throw error;
  }
}

export async function generateSharedProjectionSnapshot(
  input: GenerateSharedProjectionSnapshotInput,
): Promise<SharedProjectionSnapshot> {
  const leagueId = input.leagueId.trim();
  const targetCycleNumber = Math.max(
    1,
    Math.floor(input.targetCycleNumber ?? 1),
  );
  const key = `${leagueId}::${targetCycleNumber}`;
  const existing = generationByLeagueAndCycle.get(key);

  if (existing) {
    return existing;
  }

  const generation = generateSnapshotInternal(input).finally(() => {
    generationByLeagueAndCycle.delete(key);
  });

  generationByLeagueAndCycle.set(key, generation);
  return generation;
}


interface EmergencyAvailabilityRecord {
  playerId: number;
  status: SharedProjectionAvailabilityStatus;
  note: string;
  returnDate: string;
  syncedAt: string;
}

const EMERGENCY_POSITION_BASE_CYCLE_POINTS: Record<DraftPosition, number> = {
  LW: 51,
  C: 53,
  RW: 51,
  D: 43,
  G: 64,
};

const EMERGENCY_POSITION_FLOOR_CYCLE_POINTS: Record<DraftPosition, number> = {
  LW: 33,
  C: 34,
  RW: 33,
  D: 27,
  G: 43,
};

function emergencyStableScore(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 0xffffffff;
}

function emergencyAvailabilityMultiplier(
  status: SharedProjectionAvailabilityStatus,
): number {
  switch (status) {
    case 'day-to-day':
      return 5 / 6;
    case 'suspended':
      return 4 / 6;
    case 'personal-leave':
      return 3 / 6;
    case 'out':
    case 'injured-reserve':
    case 'long-term-injured-reserve':
      return 0.15;
    default:
      return 1;
  }
}

function emergencyAvailabilityLabel(
  status: SharedProjectionAvailabilityStatus,
): string {
  switch (status) {
    case 'day-to-day':
      return 'Day-to-Day';
    case 'out':
      return 'Out';
    case 'injured-reserve':
      return 'IR';
    case 'long-term-injured-reserve':
      return 'LTIR';
    case 'suspended':
      return 'Suspended';
    case 'personal-leave':
      return 'Personal Leave';
    case 'unknown':
      return 'Unknown';
    default:
      return 'Active';
  }
}

function loadEmergencyAvailabilityRecords(
  value: unknown,
): Map<number, EmergencyAvailabilityRecord> {
  const records = new Map<number, EmergencyAvailabilityRecord>();
  const source = value && typeof value === 'object' && Array.isArray(
    (value as { records?: unknown }).records,
  )
    ? (value as { records: unknown[] }).records
    : [];

  for (const entry of source) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const playerId = record['playerId'];
    const status = record['status'];

    if (
      typeof playerId !== 'number' ||
      !Number.isFinite(playerId) ||
      typeof status !== 'string'
    ) {
      continue;
    }

    const normalizedStatus: SharedProjectionAvailabilityStatus = [
      'active',
      'day-to-day',
      'out',
      'injured-reserve',
      'long-term-injured-reserve',
      'suspended',
      'personal-leave',
      'unknown',
    ].includes(status)
      ? status as SharedProjectionAvailabilityStatus
      : 'unknown';

    records.set(playerId, {
      playerId,
      status: normalizedStatus,
      note: typeof record['note'] === 'string' ? record['note'] : '',
      returnDate:
        typeof record['externalReturnDate'] === 'string'
          ? record['externalReturnDate']
          : '',
      syncedAt:
        typeof record['syncedAt'] === 'string'
          ? record['syncedAt']
          : typeof record['updatedAt'] === 'string'
            ? record['updatedAt']
            : '',
    });
  }

  return records;
}

function buildEmergencyProjectionValues(
  position: DraftPosition,
  identity: string,
  availabilityStatus: SharedProjectionAvailabilityStatus = 'active',
): {
  healthyCyclePoints: number;
  adjustedCyclePoints: number;
  seasonPoints: number;
  draftScore: number;
  reliability: number;
  expectedGamesAvailable: number;
} {
  const base = EMERGENCY_POSITION_BASE_CYCLE_POINTS[position];
  const floor = EMERGENCY_POSITION_FLOOR_CYCLE_POINTS[position];
  const stableVariation = emergencyStableScore(identity);
  const healthyCyclePoints = Number(
    (floor + (base - floor) * stableVariation).toFixed(1),
  );
  const availabilityMultiplier = emergencyAvailabilityMultiplier(availabilityStatus);
  const adjustedCyclePoints = Number(
    (healthyCyclePoints * availabilityMultiplier).toFixed(1),
  );
  const seasonPoints = Number(((healthyCyclePoints / 6) * 82).toFixed(1));
  const reliability = availabilityStatus === 'active' ? 48 : 34;
  const expectedGamesAvailable = Number((6 * availabilityMultiplier).toFixed(1));
  const scarcityBonus = position === 'G' ? 8 : position === 'D' ? 3 : 0;
  const draftScore = Number((adjustedCyclePoints + scarcityBonus).toFixed(1));

  return {
    healthyCyclePoints,
    adjustedCyclePoints,
    seasonPoints,
    draftScore,
    reliability,
    expectedGamesAvailable,
  };
}

function applyEmergencyRanks(assets: DraftableAsset[]): DraftableAsset[] {
  const overall = [...assets].sort((first, second) =>
    (second.draftScore ?? 0) - (first.draftScore ?? 0) ||
    first.assetKey.localeCompare(second.assetKey),
  );
  const overallRank = new Map(
    overall.map((asset, index) => [asset.assetKey, index + 1]),
  );
  const positionRanks = new Map<string, number>();

  for (const position of ['LW', 'C', 'RW', 'D', 'G'] as DraftPosition[]) {
    const positionAssets = assets
      .filter((asset) => asset.position === position)
      .sort((first, second) =>
        (second.draftScore ?? 0) - (first.draftScore ?? 0) ||
        first.assetKey.localeCompare(second.assetKey),
      );

    positionAssets.forEach((asset, index) => {
      positionRanks.set(asset.assetKey, index + 1);
    });
  }

  return assets
    .map((asset) => ({
      ...asset,
      draftRank: overallRank.get(asset.assetKey) ?? null,
      balancedRank: overallRank.get(asset.assetKey) ?? null,
      cycleRank: overallRank.get(asset.assetKey) ?? null,
      draftPositionRank: positionRanks.get(asset.assetKey) ?? null,
      positionRank: positionRanks.get(asset.assetKey) ?? null,
      cyclePositionRank: positionRanks.get(asset.assetKey) ?? null,
    }))
    .sort((first, second) =>
      (first.draftRank ?? Number.MAX_SAFE_INTEGER) -
        (second.draftRank ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * Last-resort scheduled-draft safety net. Normal draft setup writes the full
 * current shared projection snapshot. This only runs when that snapshot is missing, so a
 * scheduled draft cannot stall merely because every browser is closed.
 */
export async function createEmergencyDraftProjectionSnapshot(
  input: GenerateSharedProjectionSnapshotInput,
): Promise<SharedProjectionSnapshot> {
  const leagueId = input.leagueId.trim();

  if (!leagueId) {
    throw new Error('A league is required to create emergency draft rankings.');
  }

  const teamCount = Math.max(2, Math.floor(input.teamCount));
  const requiredGamesPerCycle = Math.max(1, Math.floor(input.requiredGamesPerCycle));
  const targetCycleNumber = Math.max(1, Math.floor(input.targetCycleNumber ?? 1));
  const generatedAt = new Date().toISOString();
  const snapshotId = `server-emergency-${Date.now()}`;
  const draftReadyUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const [skaters, globalAvailabilitySnapshot] = await Promise.all([
    getCurrentNhlDraftSkaters(),
    getDoc(doc(db, 'appData', 'playerAvailability')).catch(() => null),
  ]);
  const availabilityRecords = loadEmergencyAvailabilityRecords(
    globalAvailabilitySnapshot?.data(),
  );
  const assets: DraftableAsset[] = [];

  for (const skater of skaters) {
    const availability = availabilityRecords.get(skater.id);
    const status = availability?.status ?? 'active';
    const values = buildEmergencyProjectionValues(
      skater.position,
      `${skater.id}:${skater.fullName}:${skater.nhlTeamAbbreviation}`,
      status,
    );

    assets.push({
      assetType: 'skater',
      assetKey: `skater-${skater.id}`,
      position: skater.position,
      player: {
        id: skater.id,
        fullName: skater.fullName,
        position: skater.position,
        nhlTeamAbbreviation: skater.nhlTeamAbbreviation,
        teamLogoUrl: skater.teamLogoUrl,
        headshotUrl: skater.headshotUrl,
      },
      projectedSeasonPoints: values.seasonPoints,
      draftProjectedSeasonPoints: values.seasonPoints,
      projectedCyclePoints: values.adjustedCyclePoints,
      draftProjectedCyclePoints: values.adjustedCyclePoints,
      healthyProjectedCyclePoints: values.healthyCyclePoints,
      availabilityAdjustedCyclePoints: values.adjustedCyclePoints,
      floorAdjustedCyclePoints: values.adjustedCyclePoints,
      draftFloorAdjustedCyclePoints: values.adjustedCyclePoints,
      draftScore: values.draftScore,
      cycleScore: values.draftScore,
      balancedDraftValue: values.draftScore,
      reliabilityRating: values.reliability,
      draftReliabilityRating: values.reliability,
      projectionDataSource: 'conservative-baseline',
      projectionGamesPlayed: 0,
      targetProjectionCycleNumber: targetCycleNumber,
      scheduledGamesInProjectionCycle: requiredGamesPerCycle,
      expectedGamesAvailable: Math.min(
        requiredGamesPerCycle,
        Number((values.expectedGamesAvailable / 6 * requiredGamesPerCycle).toFixed(1)),
      ),
      expectedGamesMissed: Math.max(
        0,
        Number((requiredGamesPerCycle - values.expectedGamesAvailable / 6 * requiredGamesPerCycle).toFixed(1)),
      ),
      availabilityStatus: status,
      availabilityLabel: emergencyAvailabilityLabel(status),
      availabilityReturnDate: availability?.returnDate ?? '',
      availabilityNote: availability?.note ?? '',
      availabilityAsOf: availability?.syncedAt || generatedAt,
      projectionGeneratedAt: generatedAt,
      sharedProjectionSnapshotId: snapshotId,
    });
  }

  for (const club of NHL_DRAFT_CLUBS) {
    const values = buildEmergencyProjectionValues(
      'G',
      `goalie:${club.abbreviation}:${club.name}`,
    );

    assets.push({
      assetType: 'team-goalie-unit',
      assetKey: `goalie-unit-${club.abbreviation}`,
      position: 'G',
      teamName: club.name,
      teamAbbreviation: club.abbreviation,
      teamLogoUrl: `https://assets.nhle.com/logos/nhl/svg/${club.abbreviation}_light.svg`,
      projectedSeasonPoints: values.seasonPoints,
      draftProjectedSeasonPoints: values.seasonPoints,
      projectedCyclePoints: values.adjustedCyclePoints,
      draftProjectedCyclePoints: values.adjustedCyclePoints,
      healthyProjectedCyclePoints: values.healthyCyclePoints,
      availabilityAdjustedCyclePoints: values.adjustedCyclePoints,
      floorAdjustedCyclePoints: values.adjustedCyclePoints,
      draftFloorAdjustedCyclePoints: values.adjustedCyclePoints,
      draftScore: values.draftScore,
      cycleScore: values.draftScore,
      balancedDraftValue: values.draftScore,
      reliabilityRating: values.reliability,
      draftReliabilityRating: values.reliability,
      projectionDataSource: 'conservative-baseline',
      projectionGamesPlayed: 0,
      targetProjectionCycleNumber: targetCycleNumber,
      scheduledGamesInProjectionCycle: requiredGamesPerCycle,
      expectedGamesAvailable: requiredGamesPerCycle,
      expectedGamesMissed: 0,
      availabilityStatus: 'active',
      availabilityLabel: 'Active',
      availabilityAsOf: generatedAt,
      projectionGeneratedAt: generatedAt,
      sharedProjectionSnapshotId: snapshotId,
    });
  }

  const rankedAssets = applyEmergencyRanks(assets);
  const catalog = await ensureCanonicalProjectionAssetCatalog();
  const catalogValidation = validateProjectionAssetsAgainstCatalog(
    rankedAssets,
    catalog,
  );
  const assetChunks: DraftableAsset[][] = [];

  for (let index = 0; index < rankedAssets.length; index += 25) {
    assetChunks.push(rankedAssets.slice(index, index + 25));
  }

  for (let index = 0; index < assetChunks.length; index += 400) {
    const batch = writeBatch(db);
    const chunkBatch = assetChunks.slice(index, index + 400);

    chunkBatch.forEach((chunkAssets, offset) => {
      const chunkIndex = index + offset;
      const chunkId = `chunk-${String(chunkIndex + 1).padStart(4, '0')}`;

      batch.set(
        doc(db, 'leagues', leagueId, 'projectionSnapshots', snapshotId, 'assets', chunkId),
        JSON.parse(JSON.stringify({
          schemaVersion: 2,
          chunkIndex,
          assetCount: chunkAssets.length,
          sharedProjectionSnapshotId: snapshotId,
          assets: chunkAssets,
        })),
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
    generatedBy: 'server:draft-automation',
    assetCount: rankedAssets.length,
    assetDocumentCount: assetChunks.length,
    assetStorageVersion: 2,
    teamCount,
    targetCycleNumber,
    requiredGamesPerCycle,
    generationReason: 'server-emergency',
    draftReadyUntil,
    message:
      'Emergency conservative rankings were generated by the server because the normal current shared projection snapshot was unavailable.',
    authoritySchemaVersion: 1,
    generatedByAuthority: 'server',
    catalogSnapshotId: catalogValidation.catalogId,
    catalogHash: catalogValidation.catalogHash,
    catalogSeason: catalogValidation.catalogSeason,
    canonicalAssetCount: catalogValidation.validatedAssetCount,
    catalogValidationStatus: 'validated',
    catalogCacheHit: catalogValidation.catalogCacheHit,
    ...(input.generationRequestId
      ? { generationRequestId: input.generationRequestId }
      : {}),
  };
  const finalBatch = writeBatch(db);
  const pointerPayload = {
    ...metadata,
    generatedAtServer: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  finalBatch.set(
    doc(db, 'leagues', leagueId, 'projectionSnapshots', snapshotId),
    pointerPayload,
  );
  finalBatch.set(
    doc(db, 'leagues', leagueId, 'projectionSnapshots', `target-cycle-${targetCycleNumber}`),
    pointerPayload,
  );
  finalBatch.set(
    doc(db, 'leagues', leagueId, 'projectionSnapshots', 'current'),
    pointerPayload,
  );
  await finalBatch.commit();

  return {
    metadata,
    assets: rankedAssets,
  };
}
