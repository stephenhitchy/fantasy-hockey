import type { DraftableAsset } from '../../core/draft/draft.models';

export type RosterDisplayPhase = 'preseason' | 'in-season';

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const normalized = finiteNumber(value);

    if (normalized !== null) {
      return normalized;
    }
  }

  return null;
}

export function getRosterDisplayPhase(
  assets: readonly DraftableAsset[],
): RosterDisplayPhase {
  const seasonHasStarted = assets.some((asset) => {
    const teamGames = finiteNumber(asset.seasonTeamGamesPlayed);
    const appearances = finiteNumber(asset.projectionGamesPlayed);
    const seasonPoints = finiteNumber(asset.currentSeasonFantasyPoints);

    return (
      (teamGames !== null && teamGames > 0) ||
      (appearances !== null && appearances > 0) ||
      (seasonPoints !== null && seasonPoints !== 0)
    );
  });

  return seasonHasStarted ? 'in-season' : 'preseason';
}

export function getRosterDisplayMetric(
  asset: DraftableAsset,
  phase: RosterDisplayPhase,
): number | null {
  if (phase === 'in-season') {
    return finiteNumber(asset.currentSeasonFantasyPoints);
  }

  return firstFiniteNumber(
    asset.draftProjectedSeasonPoints,
    asset.projectedSeasonPoints,
    asset.projectedFinalSeasonPoints,
  );
}

export function getRosterDisplayMetricLabel(phase: RosterDisplayPhase): string {
  return phase === 'in-season' ? 'Season points' : 'Season projection';
}

function compareDescending(first: number | null, second: number | null): number {
  if (first === null && second === null) {
    return 0;
  }

  if (first === null) {
    return 1;
  }

  if (second === null) {
    return -1;
  }

  return second - first;
}

export function compareRosterDisplayAssets(
  first: DraftableAsset,
  second: DraftableAsset,
  phase: RosterDisplayPhase,
): number {
  const primaryComparison = compareDescending(
    getRosterDisplayMetric(first, phase),
    getRosterDisplayMetric(second, phase),
  );

  if (primaryComparison !== 0) {
    return primaryComparison;
  }

  if (phase === 'in-season') {
    const rateComparison = compareDescending(
      finiteNumber(first.seasonFantasyPointsPerGame),
      finiteNumber(second.seasonFantasyPointsPerGame),
    );

    if (rateComparison !== 0) {
      return rateComparison;
    }
  }

  const projectionComparison = compareDescending(
    firstFiniteNumber(first.projectedFinalSeasonPoints, first.projectedSeasonPoints),
    firstFiniteNumber(second.projectedFinalSeasonPoints, second.projectedSeasonPoints),
  );

  if (projectionComparison !== 0) {
    return projectionComparison;
  }

  return first.assetKey.localeCompare(second.assetKey);
}

export function orderRosterEntriesForDisplay<T>(
  entries: readonly T[],
  resolveAsset: (entry: T) => DraftableAsset | null,
  phase: RosterDisplayPhase,
): T[] {
  return entries
    .map((entry, sourceIndex) => ({ entry, sourceIndex, asset: resolveAsset(entry) }))
    .sort((first, second) => {
      if (!first.asset && !second.asset) {
        return first.sourceIndex - second.sourceIndex;
      }

      if (!first.asset) {
        return 1;
      }

      if (!second.asset) {
        return -1;
      }

      return (
        compareRosterDisplayAssets(first.asset, second.asset, phase) ||
        first.sourceIndex - second.sourceIndex
      );
    })
    .map(({ entry }) => entry);
}
