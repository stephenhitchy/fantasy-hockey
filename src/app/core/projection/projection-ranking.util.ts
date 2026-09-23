import {
  DraftableAsset,
  DraftPosition,
} from '../draft/draft.models';

export const DRAFT_RANKING_MODEL_VERSION = 3;

const GOALIE_UNIT_TALENT_SCALE = 0.88;
const GOALIE_UNIT_STARTER_TALENT_WEIGHT = 0.45;
const GOALIE_UNIT_STARTER_SCARCITY_WEIGHT = 0.4;
const GOALIE_UNIT_STARTER_SLOT_CURVE_WEIGHT = 0.15;
const GOALIE_UNIT_WAIVER_TALENT_WEIGHT = 0.08;
const GOALIE_UNIT_WAIVER_SLOT_CURVE_WEIGHT = 0.12;
const SKATER_EXPECTED_TALENT_WEIGHT = 0.75;
const SKATER_EXPECTED_SCARCITY_WEIGHT = 0.25;
const SKATER_RESERVE_TALENT_WEIGHT = 0.08;

const POSITION_REQUIREMENTS: Record<DraftPosition, number> = {
  LW: 3,
  C: 3,
  RW: 3,
  D: 4,
  G: 1,
};

const POSITIONS: DraftPosition[] = ['LW', 'C', 'RW', 'D', 'G'];
const FORWARD_POSITIONS: DraftPosition[] = ['LW', 'C', 'RW'];

/**
 * Expected draft demand for RinkRat's three flexible bench slots. Team goalie
 * units have no default bench demand because they cannot be injured and the
 * undrafted pool remains the replacement source.
 */
export const DRAFT_BENCH_DEMAND_PER_TEAM = {
  F: 2,
  D: 1,
  G: 0,
} as const;

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

    return 100 - progress * 65;
  }

  const postStarterProgress = clamp(
    (safeRank - starterCount) / Math.max(1, starterCount),
    0,
    1,
  );

  return 12 - postStarterProgress * 10;
}

/**
 * Skater demand is a forecast, not an eligibility boundary. Fade the first
 * team-sized reserve band gradually so one projected position-rank place does
 * not collapse an otherwise comparable skater's overall rank. Deep reserves
 * retain the prior low talent weight, while Team Goalie Units continue to use
 * their separate starter/waiver curve.
 */
function getSkaterDemandShare(
  positionRank: number | null | undefined,
  expectedCount: number,
  teamCount: number,
): number {
  const safeRank =
    typeof positionRank === 'number' && positionRank > 0
      ? positionRank
      : Number.MAX_SAFE_INTEGER;

  if (safeRank <= expectedCount) {
    return 1;
  }

  const reserveDistance = safeRank - expectedCount;
  const transitionSlots = Math.max(2, teamCount);

  return clamp(
    1 - reserveDistance / (transitionSlots + 1),
    0,
    1,
  );
}

function getSkaterScore(
  talentScore: number,
  scarcityScore: number,
  demandShare: number,
): number {
  const talentWeight =
    SKATER_RESERVE_TALENT_WEIGHT +
    (SKATER_EXPECTED_TALENT_WEIGHT - SKATER_RESERVE_TALENT_WEIGHT) *
      demandShare;

  return talentScore * talentWeight +
    scarcityScore * SKATER_EXPECTED_SCARCITY_WEIGHT * demandShare;
}

function getRosterAwareDraftedCounts(
  assets: DraftableAsset[],
  teamCount: number,
  projection: (asset: DraftableAsset) => number,
): Record<DraftPosition, number> {
  const draftedCounts = {
    ...POSITION_REQUIREMENTS,
  } as Record<DraftPosition, number>;

  for (const position of POSITIONS) {
    draftedCounts[position] = Math.max(
      1,
      teamCount * POSITION_REQUIREMENTS[position],
    );
  }

  draftedCounts.D += teamCount * DRAFT_BENCH_DEMAND_PER_TEAM.D;

  const remainingForwards = FORWARD_POSITIONS.flatMap((position) => {
    const starterCount = draftedCounts[position];

    return assets
      .filter((asset) => asset.position === position)
      .sort((first, second) => projection(second) - projection(first))
      .slice(starterCount);
  }).sort((first, second) => projection(second) - projection(first));

  for (const asset of remainingForwards.slice(
    0,
    teamCount * DRAFT_BENCH_DEMAND_PER_TEAM.F,
  )) {
    draftedCounts[asset.position] += 1;
  }

  return draftedCounts;
}

/**
 * Keeps every projected starting goalie unit inside the modeled draft pool
 * without making position demand a hard ordering bucket for skaters. The
 * remaining draft-pool places are the highest-scoring skaters across all
 * positions, so the reserve transition can stay gradual.
 */
function orderAssetsWithGoalieStarterCoverage(
  assets: DraftableAsset[],
  expectedCounts: Record<DraftPosition, number>,
  positionRank: (asset: DraftableAsset) => number | null | undefined,
  score: (asset: DraftableAsset) => number,
  compareProjectionOrder: (
    first: DraftableAsset,
    second: DraftableAsset,
  ) => number,
): DraftableAsset[] {
  const compare = (first: DraftableAsset, second: DraftableAsset) =>
    score(second) - score(first) || compareProjectionOrder(first, second);
  const expectedPoolSize = POSITIONS.reduce(
    (total, position) => total + expectedCounts[position],
    0,
  );
  const startingGoalies = assets.filter(
    (asset) =>
      asset.position === 'G' &&
      (positionRank(asset) ?? Number.MAX_SAFE_INTEGER) <= expectedCounts.G,
  );
  const skaterPool = assets
    .filter((asset) => asset.position !== 'G')
    .sort(compare)
    .slice(0, Math.max(0, expectedPoolSize - startingGoalies.length));
  const expectedPoolKeys = new Set(
    [...startingGoalies, ...skaterPool].map((asset) => asset.assetKey),
  );

  return [
    ...assets.filter((asset) => expectedPoolKeys.has(asset.assetKey)).sort(compare),
    ...assets.filter((asset) => !expectedPoolKeys.has(asset.assetKey)).sort(compare),
  ];
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
  const draftExpectedCounts = getRosterAwareDraftedCounts(
    assets,
    safeTeamCount,
    getDraftProjection,
  );
  const cycleExpectedCounts = getRosterAwareDraftedCounts(
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
        draftExpectedCounts[position],
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
        cycleExpectedCounts[position],
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
        draftRankingVersion: DRAFT_RANKING_MODEL_VERSION,
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
    const isGoalieStarterCandidate =
      asset.position === 'G' &&
      (asset.draftPositionRank ?? Number.MAX_SAFE_INTEGER) <= goalieStarterCount;
    const isCycleGoalieStarterCandidate =
      asset.position === 'G' &&
      (asset.cyclePositionRank ?? Number.MAX_SAFE_INTEGER) <= goalieStarterCount;
    const draftSkaterDemandShare = asset.position === 'G'
      ? 0
      : getSkaterDemandShare(
          asset.draftPositionRank,
          draftExpectedCounts[asset.position],
          safeTeamCount,
        );
    const cycleSkaterDemandShare = asset.position === 'G'
      ? 0
      : getSkaterDemandShare(
          asset.cyclePositionRank,
          cycleExpectedCounts[asset.position],
          safeTeamCount,
        );
    const draftScore =
      asset.position === 'G'
        ? isGoalieStarterCandidate
          ? draftTalentScore * GOALIE_UNIT_STARTER_TALENT_WEIGHT +
            draftScarcityScore * GOALIE_UNIT_STARTER_SCARCITY_WEIGHT +
            draftGoalieSlotCurve * GOALIE_UNIT_STARTER_SLOT_CURVE_WEIGHT
          : draftTalentScore * GOALIE_UNIT_WAIVER_TALENT_WEIGHT +
            draftGoalieSlotCurve * GOALIE_UNIT_WAIVER_SLOT_CURVE_WEIGHT
        : getSkaterScore(
            draftTalentScore,
            draftScarcityScore,
            draftSkaterDemandShare,
          );
    const cycleScore =
      asset.position === 'G'
        ? isCycleGoalieStarterCandidate
          ? cycleTalentScore * GOALIE_UNIT_STARTER_TALENT_WEIGHT +
            cycleScarcityScore * GOALIE_UNIT_STARTER_SCARCITY_WEIGHT +
            cycleGoalieSlotCurve * GOALIE_UNIT_STARTER_SLOT_CURVE_WEIGHT
          : cycleTalentScore * GOALIE_UNIT_WAIVER_TALENT_WEIGHT +
            cycleGoalieSlotCurve * GOALIE_UNIT_WAIVER_SLOT_CURVE_WEIGHT
        : getSkaterScore(
            cycleTalentScore,
            cycleScarcityScore,
            cycleSkaterDemandShare,
          );

    return {
      ...asset,
      draftScore: rounded(draftScore),
      cycleScore: rounded(cycleScore),
      balancedDraftValue: rounded(draftScore),
      floorAdjustedDraftValue: rounded(draftValue),
      positionRank: asset.draftPositionRank ?? null,
    };
  });

  const draftOrdered = orderAssetsWithGoalieStarterCoverage(
    scoredAssets,
    draftExpectedCounts,
    (asset) => asset.draftPositionRank,
    (asset) => getSortNumber(asset.draftScore),
    compareDraftProjectionOrder,
  );
  const draftRankByKey = new Map(
    draftOrdered.map((asset, index) => [asset.assetKey, index + 1]),
  );
  const cycleOrdered = orderAssetsWithGoalieStarterCoverage(
    scoredAssets,
    cycleExpectedCounts,
    (asset) => asset.cyclePositionRank,
    (asset) => getSortNumber(asset.cycleScore),
    compareCycleProjectionOrder,
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
