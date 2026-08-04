import {
  DraftableAsset,
  DraftPosition,
} from '../draft/draft.models';

const GOALIE_UNIT_TALENT_SCALE = 0.88;
const GOALIE_UNIT_TALENT_WEIGHT = 0.63;
const GOALIE_UNIT_SCARCITY_WEIGHT = 0.12;
const GOALIE_UNIT_SLOT_CURVE_WEIGHT = 0.25;

const POSITION_REQUIREMENTS: Record<DraftPosition, number> = {
  LW: 3,
  C: 3,
  RW: 3,
  D: 4,
  G: 1,
};

const POSITIONS: DraftPosition[] = ['LW', 'C', 'RW', 'D', 'G'];
const FLEXIBLE_BENCH_SLOTS_PER_TEAM = 3;

function getAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : asset.teamName;
}

/**
 * Rejects a projection refresh when a throttled or malformed NHL response
 * collapses most skaters to the same conservative fallback. Keeping the last
 * healthy snapshot is safer than publishing a misleading draft board.
 */
export function assertSharedProjectionPoolHealthy(
  assets: DraftableAsset[],
): void {
  const skaters = assets.filter((asset) => asset.assetType === 'skater');

  if (skaters.length < 100) {
    return;
  }

  const dataBackedSkaters = skaters.filter(
    (asset) =>
      asset.projectionDataSource !== 'conservative-baseline' &&
      typeof asset.draftProjectedSeasonPoints === 'number' &&
      asset.draftProjectedSeasonPoints > 0,
  );

  const distinctSeasonOutlooks = new Set(
    skaters
      .map((asset) => asset.draftProjectedSeasonPoints)
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      )
      .map((value) => value.toFixed(1)),
  );

  const minimumDataBackedCount = Math.max(
    75,
    Math.floor(skaters.length * 0.2),
  );

  if (
    dataBackedSkaters.length < minimumDataBackedCount ||
    distinctSeasonOutlooks.size < 20
  ) {
    throw new Error(
      `Projection generation was stopped because the NHL statistics response produced a collapsed draft board (${dataBackedSkaters.length} of ${skaters.length} skaters had data-backed projections and only ${distinctSeasonOutlooks.size} distinct season outlooks were produced). The previous shared projection was preserved.`,
    );
  }
}

function getSortNumber(value: number | null | undefined): number {
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
    (typeof asset.projectedSeasonPoints === 'number'
      ? (asset.projectedSeasonPoints / 82) * 6
      : asset.projectedCyclePoints) ??
    0
  );
}

function getCycleProjection(asset: DraftableAsset | undefined): number {
  if (!asset) {
    return 0;
  }

  return asset.floorAdjustedCyclePoints ?? asset.projectedCyclePoints ?? 0;
}

function compareAssetName(
  first: DraftableAsset,
  second: DraftableAsset,
): number {
  return (
    getAssetName(first).localeCompare(getAssetName(second)) ||
    first.assetKey.localeCompare(second.assetKey)
  );
}

function compareDraftProjectionOrder(
  first: DraftableAsset,
  second: DraftableAsset,
): number {
  return (
    getDraftProjection(second) - getDraftProjection(first) ||
    getSortNumber(second.draftReliabilityRating) -
      getSortNumber(first.draftReliabilityRating) ||
    compareAssetName(first, second)
  );
}

function compareCycleProjectionOrder(
  first: DraftableAsset,
  second: DraftableAsset,
): number {
  return (
    getCycleProjection(second) - getCycleProjection(first) ||
    getSortNumber(second.reliabilityRating) -
      getSortNumber(first.reliabilityRating) ||
    compareAssetName(first, second)
  );
}

function getTalentScore(
  asset: DraftableAsset,
  projection: number,
  topSkaterProjection: number,
  topGoalieProjection: number,
): number {
  if (asset.position === 'G') {
    return clamp(
      (projection / Math.max(1, topGoalieProjection)) *
        100 *
        GOALIE_UNIT_TALENT_SCALE,
      0,
      100,
    );
  }

  return clamp(
    (projection / Math.max(1, topSkaterProjection)) * 100,
    0,
    100,
  );
}

function getGoalieSlotCurveScore(
  positionRank: number | null | undefined,
  starterCount: number,
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

    return 88 - progress * 28;
  }

  const postStarterProgress = clamp(
    (safeRank - starterCount) / Math.max(1, starterCount),
    0,
    1,
  );

  return 55 - postStarterProgress * 20;
}

function getFlexibleBenchReplacementCounts(
  assets: DraftableAsset[],
  teamCount: number,
  projection: (asset: DraftableAsset) => number,
): Record<DraftPosition, number> {
  const replacementCounts = {
    ...POSITION_REQUIREMENTS,
  } as Record<DraftPosition, number>;

  for (const position of POSITIONS) {
    replacementCounts[position] = Math.max(
      1,
      teamCount * POSITION_REQUIREMENTS[position],
    );
  }

  const remainingCandidates = POSITIONS.flatMap((position) => {
    const starterCount = replacementCounts[position];

    return assets
      .filter((asset) => asset.position === position)
      .sort((first, second) => projection(second) - projection(first))
      .slice(starterCount);
  }).sort((first, second) => projection(second) - projection(first));

  for (const asset of remainingCandidates.slice(
    0,
    teamCount * FLEXIBLE_BENCH_SLOTS_PER_TEAM,
  )) {
    replacementCounts[asset.position] += 1;
  }

  return replacementCounts;
}

/**
 * Applies the shared position-replacement, scarcity and goalie-slot curves used
 * by both browser-created and server-created projection snapshots.
 */
export function rankSharedProjectionAssets(
  assets: DraftableAsset[],
  teamCount: number,
): DraftableAsset[] {
  const safeTeamCount = Math.max(2, Math.floor(teamCount));
  const working = new Map<string, DraftableAsset>();
  const draftReplacementCounts = getFlexibleBenchReplacementCounts(
    assets,
    safeTeamCount,
    getDraftProjection,
  );
  const cycleReplacementCounts = getFlexibleBenchReplacementCounts(
    assets,
    safeTeamCount,
    getCycleProjection,
  );

  for (const position of POSITIONS) {
    const positionAssets = assets
      .filter((asset) => asset.position === position)
      .sort(compareDraftProjectionOrder);

    if (positionAssets.length === 0) {
      continue;
    }

    const draftReplacementIndex = Math.max(
      0,
      Math.min(
        positionAssets.length - 1,
        draftReplacementCounts[position] - 1,
      ),
    );
    const draftReplacement = getDraftProjection(
      positionAssets[draftReplacementIndex],
    );

    const cyclePositionAssets = [...positionAssets].sort(
      compareCycleProjectionOrder,
    );
    const cycleReplacementIndex = Math.max(
      0,
      Math.min(
        cyclePositionAssets.length - 1,
        cycleReplacementCounts[position] - 1,
      ),
    );
    const cycleReplacement = getCycleProjection(
      cyclePositionAssets[cycleReplacementIndex],
    );

    const draftPositionRankByKey = new Map(
      positionAssets.map((asset, index) => [asset.assetKey, index + 1]),
    );
    const cyclePositionRankByKey = new Map(
      cyclePositionAssets.map((asset, index) => [asset.assetKey, index + 1]),
    );

    for (const asset of positionAssets) {
      const draftProjection = getDraftProjection(asset);
      const cycleProjection = getCycleProjection(asset);

      working.set(asset.assetKey, {
        ...asset,
        draftValueAboveReplacement: rounded(
          draftProjection - draftReplacement,
        ),
        cycleValueAboveReplacement: rounded(
          cycleProjection - cycleReplacement,
        ),
        draftPositionRank:
          draftPositionRankByKey.get(asset.assetKey) ?? null,
        cyclePositionRank:
          cyclePositionRankByKey.get(asset.assetKey) ?? null,
      });
    }
  }

  const rankedAssets = assets.map(
    (asset) => working.get(asset.assetKey) ?? asset,
  );

  const topSkaterDraft = Math.max(
    1,
    ...rankedAssets
      .filter((asset) => asset.position !== 'G')
      .map(getDraftProjection),
  );
  const topGoalieDraft = Math.max(
    1,
    ...rankedAssets
      .filter((asset) => asset.position === 'G')
      .map(getDraftProjection),
  );
  const topSkaterCycle = Math.max(
    1,
    ...rankedAssets
      .filter((asset) => asset.position !== 'G')
      .map(getCycleProjection),
  );
  const topGoalieCycle = Math.max(
    1,
    ...rankedAssets
      .filter((asset) => asset.position === 'G')
      .map(getCycleProjection),
  );

  const maxDraftRelativeValue = Math.max(
    0.01,
    ...rankedAssets.map((asset) => {
      const projection = getDraftProjection(asset);
      const value = asset.draftValueAboveReplacement ?? 0;
      const replacement = Math.max(1, projection - value);

      return clamp(value / replacement, 0, 1.5);
    }),
  );
  const maxCycleRelativeValue = Math.max(
    0.01,
    ...rankedAssets.map((asset) => {
      const projection = getCycleProjection(asset);
      const value = asset.cycleValueAboveReplacement ?? 0;
      const replacement = Math.max(1, projection - value);

      return clamp(value / replacement, 0, 1.5);
    }),
  );

  const goalieStarterCount = Math.max(
    1,
    safeTeamCount * POSITION_REQUIREMENTS.G,
  );

  const scoredAssets = rankedAssets.map((asset) => {
    const draftProjection = getDraftProjection(asset);
    const cycleProjection = getCycleProjection(asset);
    const draftValue = asset.draftValueAboveReplacement ?? 0;
    const cycleValue = asset.cycleValueAboveReplacement ?? 0;
    const draftReplacement = Math.max(1, draftProjection - draftValue);
    const cycleReplacement = Math.max(1, cycleProjection - cycleValue);
    const draftTalentScore = getTalentScore(
      asset,
      draftProjection,
      topSkaterDraft,
      topGoalieDraft,
    );
    const cycleTalentScore = getTalentScore(
      asset,
      cycleProjection,
      topSkaterCycle,
      topGoalieCycle,
    );
    const draftScarcityScore = clamp(
      (clamp(draftValue / draftReplacement, 0, 1.5) /
        maxDraftRelativeValue) *
        100,
      0,
      100,
    );
    const cycleScarcityScore = clamp(
      (clamp(cycleValue / cycleReplacement, 0, 1.5) /
        maxCycleRelativeValue) *
        100,
      0,
      100,
    );
    const draftGoalieSlotCurve =
      asset.position === 'G'
        ? getGoalieSlotCurveScore(
            asset.draftPositionRank,
            goalieStarterCount,
          )
        : 0;
    const cycleGoalieSlotCurve =
      asset.position === 'G'
        ? getGoalieSlotCurveScore(
            asset.cyclePositionRank,
            goalieStarterCount,
          )
        : 0;
    const draftScore =
      asset.position === 'G'
        ? draftTalentScore * GOALIE_UNIT_TALENT_WEIGHT +
          draftScarcityScore * GOALIE_UNIT_SCARCITY_WEIGHT +
          draftGoalieSlotCurve * GOALIE_UNIT_SLOT_CURVE_WEIGHT
        : draftTalentScore * 0.75 + draftScarcityScore * 0.25;
    const cycleScore =
      asset.position === 'G'
        ? cycleTalentScore * GOALIE_UNIT_TALENT_WEIGHT +
          cycleScarcityScore * GOALIE_UNIT_SCARCITY_WEIGHT +
          cycleGoalieSlotCurve * GOALIE_UNIT_SLOT_CURVE_WEIGHT
        : cycleTalentScore * 0.75 + cycleScarcityScore * 0.25;

    return {
      ...asset,
      draftScore: rounded(draftScore),
      cycleScore: rounded(cycleScore),
      balancedDraftValue: rounded(draftScore),
      floorAdjustedDraftValue: rounded(draftValue),
      positionRank: asset.draftPositionRank ?? null,
    };
  });

  const draftOrdered = [...scoredAssets].sort(
    (first, second) =>
      getSortNumber(second.draftScore) - getSortNumber(first.draftScore) ||
      compareDraftProjectionOrder(first, second),
  );
  const draftRankByKey = new Map(
    draftOrdered.map((asset, index) => [asset.assetKey, index + 1]),
  );
  const cycleOrdered = [...scoredAssets].sort(
    (first, second) =>
      getSortNumber(second.cycleScore) - getSortNumber(first.cycleScore) ||
      compareCycleProjectionOrder(first, second),
  );
  const cycleRankByKey = new Map(
    cycleOrdered.map((asset, index) => [asset.assetKey, index + 1]),
  );

  return scoredAssets
    .map((asset) => {
      const draftRank = draftRankByKey.get(asset.assetKey) ?? null;
      const cycleRank = cycleRankByKey.get(asset.assetKey) ?? null;

      return {
        ...asset,
        draftRank,
        cycleRank,
        balancedRank: draftRank,
        positionRank: asset.draftPositionRank ?? null,
      };
    })
    .sort(
      (first, second) =>
        getSortNumber(first.draftRank) - getSortNumber(second.draftRank) ||
        compareAssetName(first, second),
    );
}
