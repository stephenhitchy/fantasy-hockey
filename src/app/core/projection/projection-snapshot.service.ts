import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  writeBatch
} from 'firebase/firestore';

import {
  auth,
  db
} from '../firebase';

import {
  DraftableAsset,
  DraftPosition
} from '../draft/draft.models';

import {
  loadDraftPlayerPool
} from '../draft/draft-player-pool.service';

import {
  getLatestCycle
} from '../cycle/cycle.service';

import {
  getPlayerAvailabilityRecordsForLeague
} from '../player/player-availability.service';

export const SHARED_PROJECTION_VERSION = 4;
export const PRE_DRAFT_PROJECTION_WARMUP_MINUTES = 20;
export const PRE_DRAFT_PROJECTION_FRESH_MINUTES = 45;

const SNAPSHOT_POINTER_ID = 'current';
const SNAPSHOT_ASSET_BATCH_SIZE = 400;
const GOALIE_UNIT_TALENT_SCALE = 0.88;
const GOALIE_UNIT_TALENT_WEIGHT = 0.63;
const GOALIE_UNIT_SCARCITY_WEIGHT = 0.12;
const GOALIE_UNIT_SLOT_CURVE_WEIGHT = 0.25;

const POSITION_REQUIREMENTS: Record<DraftPosition, number> = {
  LW: 3,
  C: 3,
  RW: 3,
  D: 4,
  G: 1
};

const POSITIONS: DraftPosition[] = [
  'LW',
  'C',
  'RW',
  'D',
  'G'
];

const generationByLeague = new Map<
  string,
  Promise<SharedProjectionSnapshot>
>();

export type SharedProjectionSnapshotStatus =
  | 'building'
  | 'ready'
  | 'error';

export type SharedProjectionGenerationReason =
  | 'manual'
  | 'draft-setup'
  | 'pre-draft'
  | 'draft-start-fallback'
  | 'cycle-refresh';

export interface SharedProjectionSnapshotMetadata {
  snapshotId: string;
  activeSnapshotId: string;
  status: SharedProjectionSnapshotStatus;
  projectionVersion: number;
  generatedAt: string;
  generatedBy: string;
  assetCount: number;
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
}

export interface DraftSnapshotFreshnessInput {
  teamCount: number;
  requiredGamesPerCycle: number;
  now?: Date;
}

function getProjectionSnapshotRef(
  leagueId: string,
  snapshotId: string
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'projectionSnapshots',
    snapshotId
  );
}

function getProjectionSnapshotAssetsRef(
  leagueId: string,
  snapshotId: string
) {
  return collection(
    db,
    'leagues',
    leagueId,
    'projectionSnapshots',
    snapshotId,
    'assets'
  );
}

function getProjectionSnapshotAssetRef(
  leagueId: string,
  snapshotId: string,
  assetKey: string
) {
  return doc(
    getProjectionSnapshotAssetsRef(leagueId, snapshotId),
    assetKey
  );
}

function getAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : asset.teamName;
}

function getSortNumber(
  value: number | null | undefined
): number {
  return typeof value === 'number' ? value : -1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

function getDraftProjection(asset: DraftableAsset | undefined): number {
  if (!asset) {
    return 0;
  }

  return (
    asset.draftFloorAdjustedCyclePoints ??
    asset.draftProjectedCyclePoints ??
    (
      typeof asset.projectedSeasonPoints === 'number'
        ? asset.projectedSeasonPoints / 82 * 6
        : asset.projectedCyclePoints
    ) ??
    0
  );
}

function getCycleProjection(asset: DraftableAsset | undefined): number {
  if (!asset) {
    return 0;
  }

  return (
    asset.floorAdjustedCyclePoints ??
    asset.projectedCyclePoints ??
    0
  );
}

function compareAssetName(
  first: DraftableAsset,
  second: DraftableAsset
): number {
  return (
    getAssetName(first).localeCompare(getAssetName(second)) ||
    first.assetKey.localeCompare(second.assetKey)
  );
}

function compareDraftProjectionOrder(
  first: DraftableAsset,
  second: DraftableAsset
): number {
  return (
    getDraftProjection(second) -
      getDraftProjection(first) ||
    getSortNumber(second.draftReliabilityRating) -
      getSortNumber(first.draftReliabilityRating) ||
    compareAssetName(first, second)
  );
}

function compareCycleProjectionOrder(
  first: DraftableAsset,
  second: DraftableAsset
): number {
  return (
    getCycleProjection(second) -
      getCycleProjection(first) ||
    getSortNumber(second.reliabilityRating) -
      getSortNumber(first.reliabilityRating) ||
    compareAssetName(first, second)
  );
}

function getTalentScore(
  asset: DraftableAsset,
  projection: number,
  topSkaterProjection: number,
  topGoalieProjection: number
): number {
  if (asset.position === 'G') {
    return clamp(
      projection / Math.max(1, topGoalieProjection) *
        100 *
        GOALIE_UNIT_TALENT_SCALE,
      0,
      100
    );
  }

  return clamp(
    projection / Math.max(1, topSkaterProjection) * 100,
    0,
    100
  );
}

function getGoalieSlotCurveScore(
  positionRank: number | null | undefined,
  starterCount: number
): number {
  const safeRank =
    typeof positionRank === 'number' && positionRank > 0
      ? positionRank
      : starterCount * 2;

  if (safeRank <= starterCount) {
    const progress =
      starterCount <= 1
        ? 0
        : (safeRank - 1) / (starterCount - 1);

    /*
     * Spread the draftable goalie tier across the board instead of
     * allowing many similarly projected units to form one large block.
     * The best unit remains premium, while the replacement starter
     * settles near the middle of the overall board.
     */
    return 88 - progress * 28;
  }

  const postStarterProgress = clamp(
    (safeRank - starterCount) /
      Math.max(1, starterCount),
    0,
    1
  );

  return 55 - postStarterProgress * 20;
}

function rankSharedProjectionAssets(
  assets: DraftableAsset[],
  teamCount: number
): DraftableAsset[] {
  const working = new Map<string, DraftableAsset>();

  for (const position of POSITIONS) {
    const positionAssets = assets
      .filter((asset) => asset.position === position)
      .sort(compareDraftProjectionOrder);

    const starterCount = Math.max(
      1,
      teamCount * POSITION_REQUIREMENTS[position]
    );

    const replacementIndex = Math.max(
      0,
      Math.min(positionAssets.length - 1, starterCount - 1)
    );

    const draftReplacement =
      getDraftProjection(positionAssets[replacementIndex]);

    const cyclePositionAssets = [...positionAssets]
      .sort(compareCycleProjectionOrder);

    const cycleReplacement =
      getCycleProjection(
        cyclePositionAssets[replacementIndex]
      );

    const draftPositionRankByKey = new Map(
      positionAssets.map((asset, index) => [
        asset.assetKey,
        index + 1
      ])
    );

    const cyclePositionRankByKey = new Map(
      cyclePositionAssets.map((asset, index) => [
        asset.assetKey,
        index + 1
      ])
    );

    for (const asset of positionAssets) {
      const draftProjection = getDraftProjection(asset);
      const cycleProjection = getCycleProjection(asset);

      working.set(asset.assetKey, {
        ...asset,
        draftValueAboveReplacement:
          rounded(draftProjection - draftReplacement),
        cycleValueAboveReplacement:
          rounded(cycleProjection - cycleReplacement),
        draftPositionRank:
          draftPositionRankByKey.get(asset.assetKey) ?? null,
        cyclePositionRank:
          cyclePositionRankByKey.get(asset.assetKey) ?? null
      });
    }
  }

  const rankedAssets = assets.map(
    (asset) => working.get(asset.assetKey) ?? asset
  );

  const topSkaterDraft = Math.max(
    1,
    ...rankedAssets
      .filter((asset) => asset.position !== 'G')
      .map(getDraftProjection)
  );

  const topGoalieDraft = Math.max(
    1,
    ...rankedAssets
      .filter((asset) => asset.position === 'G')
      .map(getDraftProjection)
  );

  const topSkaterCycle = Math.max(
    1,
    ...rankedAssets
      .filter((asset) => asset.position !== 'G')
      .map(getCycleProjection)
  );

  const topGoalieCycle = Math.max(
    1,
    ...rankedAssets
      .filter((asset) => asset.position === 'G')
      .map(getCycleProjection)
  );

  const maxDraftRelativeValue = Math.max(
    0.01,
    ...rankedAssets.map((asset) => {
      const projection = getDraftProjection(asset);
      const value = asset.draftValueAboveReplacement ?? 0;
      const replacement = Math.max(1, projection - value);

      return clamp(value / replacement, 0, 1.5);
    })
  );

  const maxCycleRelativeValue = Math.max(
    0.01,
    ...rankedAssets.map((asset) => {
      const projection = getCycleProjection(asset);
      const value = asset.cycleValueAboveReplacement ?? 0;
      const replacement = Math.max(1, projection - value);

      return clamp(value / replacement, 0, 1.5);
    })
  );

  const goalieStarterCount = Math.max(
    1,
    teamCount * POSITION_REQUIREMENTS.G
  );

  const scoredAssets = rankedAssets.map((asset) => {
    const draftProjection = getDraftProjection(asset);
    const cycleProjection = getCycleProjection(asset);

    const draftValue =
      asset.draftValueAboveReplacement ?? 0;

    const cycleValue =
      asset.cycleValueAboveReplacement ?? 0;

    const draftReplacement = Math.max(
      1,
      draftProjection - draftValue
    );

    const cycleReplacement = Math.max(
      1,
      cycleProjection - cycleValue
    );

    const draftTalentScore = getTalentScore(
      asset,
      draftProjection,
      topSkaterDraft,
      topGoalieDraft
    );

    const cycleTalentScore = getTalentScore(
      asset,
      cycleProjection,
      topSkaterCycle,
      topGoalieCycle
    );

    const draftScarcityScore = clamp(
      (
        clamp(
          draftValue / draftReplacement,
          0,
          1.5
        ) /
        maxDraftRelativeValue
      ) * 100,
      0,
      100
    );

    const cycleScarcityScore = clamp(
      (
        clamp(
          cycleValue / cycleReplacement,
          0,
          1.5
        ) /
        maxCycleRelativeValue
      ) * 100,
      0,
      100
    );

    const draftGoalieSlotCurve =
      asset.position === 'G'
        ? getGoalieSlotCurveScore(
            asset.draftPositionRank,
            goalieStarterCount
          )
        : 0;

    const cycleGoalieSlotCurve =
      asset.position === 'G'
        ? getGoalieSlotCurveScore(
            asset.cyclePositionRank,
            goalieStarterCount
          )
        : 0;

    const draftScore =
      asset.position === 'G'
        ? draftTalentScore *
            GOALIE_UNIT_TALENT_WEIGHT +
          draftScarcityScore *
            GOALIE_UNIT_SCARCITY_WEIGHT +
          draftGoalieSlotCurve *
            GOALIE_UNIT_SLOT_CURVE_WEIGHT
        : draftTalentScore * 0.75 +
          draftScarcityScore * 0.25;

    const cycleScore =
      asset.position === 'G'
        ? cycleTalentScore *
            GOALIE_UNIT_TALENT_WEIGHT +
          cycleScarcityScore *
            GOALIE_UNIT_SCARCITY_WEIGHT +
          cycleGoalieSlotCurve *
            GOALIE_UNIT_SLOT_CURVE_WEIGHT
        : cycleTalentScore * 0.75 +
          cycleScarcityScore * 0.25;

    return {
      ...asset,
      draftScore: rounded(draftScore),
      cycleScore: rounded(cycleScore),

      // Backward-compatible fields used by older Draft Room code.
      balancedDraftValue: rounded(draftScore),
      floorAdjustedDraftValue:
        rounded(draftValue),
      positionRank:
        asset.draftPositionRank ?? null
    };
  });

  const draftOrdered = [...scoredAssets].sort(
    (first, second) =>
      getSortNumber(second.draftScore) -
        getSortNumber(first.draftScore) ||
      compareDraftProjectionOrder(first, second)
  );

  const draftRankByKey = new Map(
    draftOrdered.map((asset, index) => [
      asset.assetKey,
      index + 1
    ])
  );

  const cycleOrdered = [...scoredAssets].sort(
    (first, second) =>
      getSortNumber(second.cycleScore) -
        getSortNumber(first.cycleScore) ||
      compareCycleProjectionOrder(first, second)
  );

  const cycleRankByKey = new Map(
    cycleOrdered.map((asset, index) => [
      asset.assetKey,
      index + 1
    ])
  );

  return scoredAssets
    .map((asset) => {
      const draftRank =
        draftRankByKey.get(asset.assetKey) ?? null;

      const cycleRank =
        cycleRankByKey.get(asset.assetKey) ?? null;

      return {
        ...asset,
        draftRank,
        cycleRank,

        // Backward-compatible aliases.
        balancedRank: draftRank,
        positionRank:
          asset.draftPositionRank ?? null
      };
    })
    .sort(
      (first: DraftableAsset, second: DraftableAsset) =>
        getSortNumber(first.draftRank) -
          getSortNumber(second.draftRank) ||
        compareAssetName(first, second)
    );
}

function sanitizeForFirestore<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeMetadata(
  data: Partial<SharedProjectionSnapshotMetadata>
): SharedProjectionSnapshotMetadata | null {
  if (
    data.status !== 'ready' ||
    typeof data.activeSnapshotId !== 'string' ||
    !data.activeSnapshotId ||
    data.projectionVersion !== SHARED_PROJECTION_VERSION
  ) {
    return null;
  }

  const generatedAt =
    typeof data.generatedAt === 'string'
      ? data.generatedAt
      : '';

  const fallbackReadyUntil = generatedAt
    ? new Date(
        new Date(generatedAt).getTime() +
          PRE_DRAFT_PROJECTION_FRESH_MINUTES *
            60 *
            1000
      ).toISOString()
    : '';

  return {
    snapshotId:
      typeof data.snapshotId === 'string'
        ? data.snapshotId
        : data.activeSnapshotId,
    activeSnapshotId: data.activeSnapshotId,
    status: 'ready',
    projectionVersion: SHARED_PROJECTION_VERSION,
    generatedAt,
    generatedBy:
      typeof data.generatedBy === 'string'
        ? data.generatedBy
        : '',
    assetCount:
      typeof data.assetCount === 'number'
        ? data.assetCount
        : 0,
    teamCount:
      typeof data.teamCount === 'number'
        ? data.teamCount
        : 0,
    targetCycleNumber:
      typeof data.targetCycleNumber === 'number'
        ? data.targetCycleNumber
        : 1,
    requiredGamesPerCycle:
      typeof data.requiredGamesPerCycle === 'number'
        ? data.requiredGamesPerCycle
        : 6,
    generationReason:
      data.generationReason ??
      'manual',
    draftReadyUntil:
      typeof data.draftReadyUntil === 'string'
        ? data.draftReadyUntil
        : fallbackReadyUntil,
    message:
      typeof data.message === 'string'
        ? data.message
        : 'Shared projections are ready.'
  };
}

export async function loadSharedProjectionSnapshotMetadata(
  leagueId: string
): Promise<SharedProjectionSnapshotMetadata | null> {
  const pointerSnapshot = await getDoc(
    getProjectionSnapshotRef(
      leagueId,
      SNAPSHOT_POINTER_ID
    )
  );

  if (!pointerSnapshot.exists()) {
    return null;
  }

  return normalizeMetadata(
    pointerSnapshot.data() as Partial<SharedProjectionSnapshotMetadata>
  );
}

export function isSharedProjectionSnapshotFreshForDraft(
  metadata: SharedProjectionSnapshotMetadata | null,
  input: DraftSnapshotFreshnessInput
): boolean {
  if (
    !metadata ||
    metadata.status !== 'ready' ||
    metadata.projectionVersion !== SHARED_PROJECTION_VERSION ||
    metadata.assetCount <= 0 ||
    metadata.teamCount !== Math.max(2, Math.floor(input.teamCount)) ||
    metadata.requiredGamesPerCycle !==
      Math.max(1, Math.floor(input.requiredGamesPerCycle))
  ) {
    return false;
  }

  const generatedAt = new Date(metadata.generatedAt);
  const readyUntil = new Date(metadata.draftReadyUntil);
  const now = input.now ?? new Date();

  if (
    Number.isNaN(generatedAt.getTime()) ||
    Number.isNaN(readyUntil.getTime())
  ) {
    return false;
  }

  return (
    generatedAt.getTime() <= now.getTime() &&
    readyUntil.getTime() >= now.getTime()
  );
}

export async function loadSharedProjectionSnapshot(
  leagueId: string
): Promise<SharedProjectionSnapshot | null> {
  const metadata =
    await loadSharedProjectionSnapshotMetadata(leagueId);

  if (!metadata) {
    return null;
  }

  const assetSnapshot = await getDocs(
    getProjectionSnapshotAssetsRef(
      leagueId,
      metadata.activeSnapshotId
    )
  );

  const assets = assetSnapshot.docs
    .map((assetDocument: { data: () => unknown }) =>
      assetDocument.data() as DraftableAsset
    )
    .sort(
      (first: DraftableAsset, second: DraftableAsset) =>
        getSortNumber(first.draftRank) -
          getSortNumber(second.draftRank) ||
        getSortNumber(first.balancedRank) -
          getSortNumber(second.balancedRank) ||
        compareDraftProjectionOrder(first, second)
    );

  if (
    metadata.assetCount > 0 &&
    assets.length !== metadata.assetCount
  ) {
    throw new Error(
      `The shared projection snapshot is incomplete (${assets.length} of ${metadata.assetCount} assets loaded).`
    );
  }

  return {
    metadata,
    assets
  };
}

async function generateSnapshotInternal(
  input: GenerateSharedProjectionSnapshotInput
): Promise<SharedProjectionSnapshot> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error(
      'You must be logged in to refresh shared projections.'
    );
  }

  const leagueId = input.leagueId.trim();

  if (!leagueId) {
    throw new Error('A league is required to refresh projections.');
  }

  const teamCount = Math.max(2, Math.floor(input.teamCount));
  const requiredGamesPerCycle = Math.max(
    1,
    Math.floor(input.requiredGamesPerCycle)
  );

  const latestCycle = await getLatestCycle(leagueId);
  const targetCycleNumber = latestCycle
    ? latestCycle.cycleNumber + 1
    : 1;

  const snapshotId = [
    Date.now(),
    user.uid.slice(0, 12)
  ].join('-');

  const generatedAt = new Date().toISOString();
  const draftReadyUntil = new Date(
    Date.now() +
      PRE_DRAFT_PROJECTION_FRESH_MINUTES *
        60 *
        1000
  ).toISOString();

  const generationReason =
    input.generationReason ?? 'manual';

  const snapshotRef = getProjectionSnapshotRef(
    leagueId,
    snapshotId
  );

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
    message: 'Building shared projections.'
  };

  await setDoc(snapshotRef, buildingMetadata);

  try {
    const availabilityByPlayerId =
      await getPlayerAvailabilityRecordsForLeague(leagueId);

    const localAssets = await loadDraftPlayerPool({
      forceRefresh: true,
      targetCycleNumber,
      requiredGamesPerCycle,
      availabilityByPlayerId
    });

    const rankedAssets = rankSharedProjectionAssets(
      localAssets,
      teamCount
    ).map((asset) => ({
      ...asset,
      sharedProjectionSnapshotId: snapshotId,
      projectionGeneratedAt: generatedAt
    }));

    for (
      let index = 0;
      index < rankedAssets.length;
      index += SNAPSHOT_ASSET_BATCH_SIZE
    ) {
      const batch = writeBatch(db);
      const assetBatch = rankedAssets.slice(
        index,
        index + SNAPSHOT_ASSET_BATCH_SIZE
      );

      for (const asset of assetBatch) {
        batch.set(
          getProjectionSnapshotAssetRef(
            leagueId,
            snapshotId,
            asset.assetKey
          ),
          sanitizeForFirestore(asset)
        );
      }

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
      teamCount,
      targetCycleNumber,
      requiredGamesPerCycle,
      generationReason,
      draftReadyUntil,
      message:
        `Shared draft rankings and Cycle ${targetCycleNumber} projections are ready.`
    };

    const finalBatch = writeBatch(db);

    finalBatch.set(snapshotRef, {
      ...metadata,
      generatedAtServer: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    finalBatch.set(
      getProjectionSnapshotRef(
        leagueId,
        SNAPSHOT_POINTER_ID
      ),
      {
        ...metadata,
        generatedAtServer: serverTimestamp(),
        updatedAt: serverTimestamp()
      }
    );

    await finalBatch.commit();

    return {
      metadata,
      assets: rankedAssets
    };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Unable to generate shared projections.';

    try {
      await setDoc(
        snapshotRef,
        {
          ...buildingMetadata,
          status: 'error',
          message,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    } catch {
      // Preserve the original projection error.
    }

    throw error;
  }
}

export async function generateSharedProjectionSnapshot(
  input: GenerateSharedProjectionSnapshotInput
): Promise<SharedProjectionSnapshot> {
  const leagueId = input.leagueId.trim();
  const existing = generationByLeague.get(leagueId);

  if (existing) {
    return existing;
  }

  const generation = generateSnapshotInternal(input)
    .finally(() => {
      generationByLeague.delete(leagueId);
    });

  generationByLeague.set(leagueId, generation);

  return generation;
}
