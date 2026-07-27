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
import { getCurrentNhlDraftSkaters, NHL_DRAFT_CLUBS } from '../nhl/nhl-api.service';

export const SHARED_PROJECTION_VERSION = 8;
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
 * Projection V8 snapshot. This only runs when that snapshot is missing, so a
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
      'Emergency conservative rankings were generated by the server because the normal Projection V8 snapshot was unavailable.',
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
