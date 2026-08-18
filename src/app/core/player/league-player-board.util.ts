type DraftableAsset = import('../draft/draft.models').DraftableAsset;
type FantasyTeam = import('../team/team.service').FantasyTeam;
type FantasyRoster = import('../team/roster.models').FantasyRoster;
type RosterAsset = import('../team/roster.models').RosterAsset;

export type LeaguePlayerBoardStatus = 'free-agent' | 'waivers' | 'rostered' | 'reserved';
export type LeaguePlayerBoardRosterArea = 'active' | 'bench' | 'ir';
export type LeaguePlayerBoardPositionFilter = 'all' | 'LW' | 'C' | 'RW' | 'D' | 'G';
export type LeaguePlayerBoardStatusFilter =
  | 'all'
  | 'free-agent'
  | 'available'
  | 'rostered'
  | 'waivers'
  | 'reserved'
  | 'watched';
export type LeaguePlayerBoardSortMode =
  | 'season-points'
  | 'next-six'
  | 'overall-rank'
  | 'position-rank'
  | 'rest-of-season'
  | 'reliability'
  | 'name';

export interface LeaguePlayerOwnership {
  assetKey: string;
  ownerId: string;
  teamName: string;
  managerName: string;
  area: LeaguePlayerBoardRosterArea;
  rosterSlotId: string | null;
  slotLabel: string;
}

export interface LeaguePlayerBoardRow {
  assetKey: string;
  asset: DraftableAsset;
  name: string;
  nhlTeamAbbreviation: string;
  position: 'LW' | 'C' | 'RW' | 'D' | 'G';
  logoUrl: string | null;
  headshotUrl: string | null;
  status: LeaguePlayerBoardStatus;
  ownership: LeaguePlayerOwnership | null;
  watched: boolean;
  seasonFantasyPoints: number | null;
  seasonFantasyPointsPerGame: number | null;
  seasonGamesPlayed: number | null;
  overallRank: number | null;
  positionRank: number | null;
  nextSixProjection: number | null;
  nextSixOverallRank: number | null;
  nextSixPositionRank: number | null;
  nextSixOverallRankCount: number;
  nextSixPositionRankCount: number;
  restOfSeasonProjection: number | null;
  projectedFinalSeasonPoints: number | null;
  projectionFloor: number | null;
  projectionCeiling: number | null;
  reliabilityRating: number | null;
  projectionConfidence: number | null;
  recentFiveGameFantasyPointsPerGame: number | null;
  recentTenGameFantasyPointsPerGame: number | null;
  recentTwentyGameFantasyPointsPerGame: number | null;
  seasonAverageTimeOnIceMinutes: number | null;
  recentAverageTimeOnIceMinutes: number | null;
  expectedGamesAvailable: number | null;
  expectedGamesMissed: number | null;
  scheduleDifficultyLabel: string | null;
  availabilityLabel: string | null;
  draftRank: number | null;
  cycleRank: number | null;
  cyclePositionRank: number | null;
  overallRankCount: number;
  positionRankCount: number;
}


export interface BuildLeaguePlayerBoardRowsInput {
  assets: readonly DraftableAsset[];
  ownershipByAssetKey?: ReadonlyMap<string, LeaguePlayerOwnership>;
  waiverAssetKeys?: ReadonlySet<string>;
  watchedAssetKeys?: ReadonlySet<string>;
  reservedAssetKeys?: ReadonlySet<string>;
}


export interface FilterLeaguePlayerBoardRowsInput {
  searchTerm?: string;
  position?: LeaguePlayerBoardPositionFilter;
  status?: LeaguePlayerBoardStatusFilter;
  sortMode?: LeaguePlayerBoardSortMode;
}

const AREA_PRIORITY: Readonly<Record<LeaguePlayerBoardRosterArea, number>> = {
  active: 3,
  bench: 2,
  ir: 1,
};

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getRosterAssetKey(asset: RosterAsset | null | undefined): string | null {
  if (!asset) {
    return null;
  }

  if (typeof asset.assetKey === 'string' && asset.assetKey.trim()) {
    return asset.assetKey.trim();
  }

  return asset.assetType === 'skater'
    ? `skater-${asset.player.id}`
    : `goalie-unit-${asset.teamAbbreviation}`;
}

function setOwnership(
  target: Map<string, LeaguePlayerOwnership>,
  ownership: LeaguePlayerOwnership,
): void {
  const existing = target.get(ownership.assetKey);

  if (!existing || AREA_PRIORITY[ownership.area] > AREA_PRIORITY[existing.area]) {
    target.set(ownership.assetKey, ownership);
  }
}

export function buildLeaguePlayerOwnership(
  teams: readonly FantasyTeam[],
  rostersByOwnerId: ReadonlyMap<string, FantasyRoster | null>,
): Map<string, LeaguePlayerOwnership> {
  const ownershipByAssetKey = new Map<string, LeaguePlayerOwnership>();

  for (const team of teams) {
    const roster = rostersByOwnerId.get(team.ownerId);
    if (!roster) {
      continue;
    }

    const managerName = team.managerName?.trim() || team.teamName;

    for (const slot of roster.activeSlots) {
      const assetKey = getRosterAssetKey(slot.asset);
      if (assetKey) {
        setOwnership(ownershipByAssetKey, {
          assetKey,
          ownerId: team.ownerId,
          teamName: team.teamName,
          managerName,
          area: 'active',
          rosterSlotId: slot.slotId,
          slotLabel: `${slot.position}${slot.slotNumber}`,
        });
      }
    }

    for (const slot of roster.benchSlots) {
      const assetKey = getRosterAssetKey(slot.asset);
      if (!assetKey) {
        continue;
      }

      setOwnership(ownershipByAssetKey, {
        assetKey,
        ownerId: team.ownerId,
        teamName: team.teamName,
        managerName,
        area: 'bench',
        rosterSlotId: slot.slotId,
        slotLabel: `Bench ${slot.slotNumber}`,
      });
    }

    for (const slot of roster.irSlots) {
      const assetKey = getRosterAssetKey(slot.asset);
      if (!assetKey) {
        continue;
      }

      setOwnership(ownershipByAssetKey, {
        assetKey,
        ownerId: team.ownerId,
        teamName: team.teamName,
        managerName,
        area: 'ir',
        rosterSlotId: slot.slotId,
        slotLabel: `IR ${slot.slotNumber}`,
      });
    }
  }

  return ownershipByAssetKey;
}


/**
 * Pending incoming assets are competition-sensitive. The public player board
 * only needs to know that they are unavailable; it never exposes which team
 * queued the move or which slot will receive it.
 */
export function buildLeaguePlayerReservedAssetKeys(
  rostersByOwnerId: ReadonlyMap<string, FantasyRoster | null>,
): Set<string> {
  const reserved = new Set<string>();

  for (const roster of rostersByOwnerId.values()) {
    if (!roster) {
      continue;
    }

    for (const slot of roster.activeSlots) {
      const assetKey = getRosterAssetKey(slot.pendingMove?.incomingAsset);
      if (assetKey) {
        reserved.add(assetKey);
      }
    }
  }

  return reserved;
}

function getAssetName(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.fullName
    : `${asset.teamName} Goalie Unit`;
}

function getAssetTeamAbbreviation(asset: DraftableAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
}

function getAssetLogoUrl(asset: DraftableAsset): string | null {
  const value = asset.assetType === 'skater'
    ? asset.player.teamLogoUrl
    : asset.teamLogoUrl;
  return typeof value === 'string' && value.trim() ? value : null;
}

function getAssetHeadshotUrl(asset: DraftableAsset): string | null {
  if (asset.assetType !== 'skater') {
    return null;
  }

  return typeof asset.player.headshotUrl === 'string' && asset.player.headshotUrl.trim()
    ? asset.player.headshotUrl
    : null;
}

function getSeasonFantasyPoints(asset: DraftableAsset): number | null {
  return finiteNumberOrNull(asset.currentSeasonFantasyPoints);
}

function getNextSixProjection(asset: DraftableAsset): number | null {
  return finiteNumberOrNull(asset.availabilityAdjustedCyclePoints) ??
    finiteNumberOrNull(asset.projectedCyclePoints) ??
    finiteNumberOrNull(asset.draftProjectedCyclePoints);
}

function getRestOfSeasonProjection(asset: DraftableAsset): number | null {
  return finiteNumberOrNull(asset.projectedRestOfSeasonPoints);
}

function compareRankCandidates(first: DraftableAsset, second: DraftableAsset): number {
  const firstPoints = getSeasonFantasyPoints(first);
  const secondPoints = getSeasonFantasyPoints(second);

  if (firstPoints === null && secondPoints !== null) {
    return 1;
  }
  if (secondPoints === null && firstPoints !== null) {
    return -1;
  }
  if (firstPoints !== null && secondPoints !== null && firstPoints !== secondPoints) {
    return secondPoints - firstPoints;
  }

  const firstPpg = finiteNumberOrNull(first.seasonFantasyPointsPerGame) ?? -Infinity;
  const secondPpg = finiteNumberOrNull(second.seasonFantasyPointsPerGame) ?? -Infinity;

  return secondPpg - firstPpg ||
    getAssetName(first).localeCompare(getAssetName(second)) ||
    first.assetKey.localeCompare(second.assetKey);
}

function buildMetricRankMap(
  assets: readonly DraftableAsset[],
  metric: (asset: DraftableAsset) => number | null,
): Map<string, number> {
  const ranked = [...assets]
    .filter((asset) => metric(asset) !== null)
    .sort((first, second) => {
      const firstValue = metric(first) ?? -Infinity;
      const secondValue = metric(second) ?? -Infinity;
      return secondValue - firstValue ||
        compareRankCandidates(first, second) ||
        first.assetKey.localeCompare(second.assetKey);
    });

  const result = new Map<string, number>();
  let previousValue: number | null = null;
  let previousRank = 0;

  ranked.forEach((asset, index) => {
    const value = metric(asset);
    const rank = index > 0 && value === previousValue ? previousRank : index + 1;
    result.set(asset.assetKey, rank);
    previousValue = value;
    previousRank = rank;
  });

  return result;
}

function buildMetricPositionRankMap(
  assets: readonly DraftableAsset[],
  metric: (asset: DraftableAsset) => number | null,
): Map<string, number> {
  const byPosition = new Map<string, DraftableAsset[]>();

  for (const asset of assets) {
    if (metric(asset) === null) {
      continue;
    }

    const positionAssets = byPosition.get(asset.position) ?? [];
    positionAssets.push(asset);
    byPosition.set(asset.position, positionAssets);
  }

  const result = new Map<string, number>();
  for (const positionAssets of byPosition.values()) {
    positionAssets.sort((first, second) => {
      const firstValue = metric(first) ?? -Infinity;
      const secondValue = metric(second) ?? -Infinity;
      return secondValue - firstValue ||
        compareRankCandidates(first, second) ||
        first.assetKey.localeCompare(second.assetKey);
    });

    let previousValue: number | null = null;
    let previousRank = 0;
    positionAssets.forEach((asset, index) => {
      const value = metric(asset);
      const rank = index > 0 && value === previousValue ? previousRank : index + 1;
      result.set(asset.assetKey, rank);
      previousValue = value;
      previousRank = rank;
    });
  }

  return result;
}

function buildRankMap(assets: readonly DraftableAsset[]): Map<string, number> {
  const ranked = [...assets]
    .filter((asset) => getSeasonFantasyPoints(asset) !== null)
    .sort(compareRankCandidates);
  const result = new Map<string, number>();
  let previousPoints: number | null = null;
  let previousPpg: number | null = null;
  let previousRank = 0;

  ranked.forEach((asset, index) => {
    const points = getSeasonFantasyPoints(asset);
    const ppg = finiteNumberOrNull(asset.seasonFantasyPointsPerGame);
    const rank = index > 0 && points === previousPoints && ppg === previousPpg
      ? previousRank
      : index + 1;

    result.set(asset.assetKey, rank);
    previousPoints = points;
    previousPpg = ppg;
    previousRank = rank;
  });

  return result;
}

function buildPositionRankMap(assets: readonly DraftableAsset[]): Map<string, number> {
  const byPosition = new Map<string, DraftableAsset[]>();

  for (const asset of assets) {
    if (getSeasonFantasyPoints(asset) === null) {
      continue;
    }

    const positionAssets = byPosition.get(asset.position) ?? [];
    positionAssets.push(asset);
    byPosition.set(asset.position, positionAssets);
  }

  const result = new Map<string, number>();

  for (const positionAssets of byPosition.values()) {
    positionAssets.sort(compareRankCandidates);
    let previousPoints: number | null = null;
    let previousPpg: number | null = null;
    let previousRank = 0;

    positionAssets.forEach((asset, index) => {
      const points = getSeasonFantasyPoints(asset);
      const ppg = finiteNumberOrNull(asset.seasonFantasyPointsPerGame);
      const rank = index > 0 && points === previousPoints && ppg === previousPpg
        ? previousRank
        : index + 1;

      result.set(asset.assetKey, rank);
      previousPoints = points;
      previousPpg = ppg;
      previousRank = rank;
    });
  }

  return result;
}

export function buildLeaguePlayerBoardRows(
  input: BuildLeaguePlayerBoardRowsInput,
): LeaguePlayerBoardRow[] {
  const ownershipByAssetKey = input.ownershipByAssetKey ?? new Map();
  const waiverAssetKeys = input.waiverAssetKeys ?? new Set();
  const watchedAssetKeys = input.watchedAssetKeys ?? new Set();
  const reservedAssetKeys = input.reservedAssetKeys ?? new Set();
  const overallRanks = buildRankMap(input.assets);
  const positionRanks = buildPositionRankMap(input.assets);
  const nextSixOverallRanks = buildMetricRankMap(input.assets, getNextSixProjection);
  const nextSixPositionRanks = buildMetricPositionRankMap(input.assets, getNextSixProjection);
  const rankedAssetCount = input.assets.filter(
    (asset) => getSeasonFantasyPoints(asset) !== null,
  ).length;
  const rankedPositionCounts = new Map<string, number>();
  const nextSixRankedAssetCount = input.assets.filter(
    (asset) => getNextSixProjection(asset) !== null,
  ).length;
  const nextSixRankedPositionCounts = new Map<string, number>();

  for (const asset of input.assets) {
    if (getSeasonFantasyPoints(asset) !== null) {
      rankedPositionCounts.set(
        asset.position,
        (rankedPositionCounts.get(asset.position) ?? 0) + 1,
      );
    }

    if (getNextSixProjection(asset) !== null) {
      nextSixRankedPositionCounts.set(
        asset.position,
        (nextSixRankedPositionCounts.get(asset.position) ?? 0) + 1,
      );
    }
  }

  return input.assets.map((asset) => {
    const ownership = ownershipByAssetKey.get(asset.assetKey) ?? null;
    const status: LeaguePlayerBoardStatus = ownership
      ? 'rostered'
      : reservedAssetKeys.has(asset.assetKey)
        ? 'reserved'
        : waiverAssetKeys.has(asset.assetKey)
          ? 'waivers'
          : 'free-agent';

    return {
      assetKey: asset.assetKey,
      asset,
      name: getAssetName(asset),
      nhlTeamAbbreviation: getAssetTeamAbbreviation(asset),
      position: asset.position,
      logoUrl: getAssetLogoUrl(asset),
      headshotUrl: getAssetHeadshotUrl(asset),
      status,
      ownership,
      watched: watchedAssetKeys.has(asset.assetKey),
      seasonFantasyPoints: getSeasonFantasyPoints(asset),
      seasonFantasyPointsPerGame: finiteNumberOrNull(asset.seasonFantasyPointsPerGame),
      seasonGamesPlayed: finiteNumberOrNull(asset.projectionGamesPlayed),
      overallRank: overallRanks.get(asset.assetKey) ?? null,
      positionRank: positionRanks.get(asset.assetKey) ?? null,
      nextSixProjection: getNextSixProjection(asset),
      nextSixOverallRank: nextSixOverallRanks.get(asset.assetKey) ?? null,
      nextSixPositionRank: nextSixPositionRanks.get(asset.assetKey) ?? null,
      nextSixOverallRankCount: nextSixRankedAssetCount,
      nextSixPositionRankCount: nextSixRankedPositionCounts.get(asset.position) ?? 0,
      restOfSeasonProjection: getRestOfSeasonProjection(asset),
      projectedFinalSeasonPoints: finiteNumberOrNull(asset.projectedFinalSeasonPoints),
      projectionFloor: finiteNumberOrNull(asset.projectionFloorPoints),
      projectionCeiling: finiteNumberOrNull(asset.projectionCeilingPoints),
      reliabilityRating:
        finiteNumberOrNull(asset.draftReliabilityRating) ??
        finiteNumberOrNull(asset.reliabilityRating),
      projectionConfidence: finiteNumberOrNull(asset.projectionModelConfidence),
      recentFiveGameFantasyPointsPerGame: finiteNumberOrNull(asset.recentFiveGameFantasyPointsPerGame),
      recentTenGameFantasyPointsPerGame: finiteNumberOrNull(asset.recentTenGameFantasyPointsPerGame),
      recentTwentyGameFantasyPointsPerGame: finiteNumberOrNull(asset.recentTwentyGameFantasyPointsPerGame),
      seasonAverageTimeOnIceMinutes: finiteNumberOrNull(asset.seasonAverageTimeOnIceMinutes),
      recentAverageTimeOnIceMinutes: finiteNumberOrNull(asset.recentAverageTimeOnIceMinutes),
      expectedGamesAvailable: finiteNumberOrNull(asset.expectedGamesAvailable),
      expectedGamesMissed: finiteNumberOrNull(asset.expectedGamesMissed),
      scheduleDifficultyLabel:
        typeof asset.scheduleDifficultyLabel === 'string' && asset.scheduleDifficultyLabel.trim()
          ? asset.scheduleDifficultyLabel.trim()
          : null,
      availabilityLabel:
        typeof asset.availabilityLabel === 'string' && asset.availabilityLabel.trim()
          ? asset.availabilityLabel.trim()
          : null,
      draftRank:
        finiteNumberOrNull(asset.draftRank) ?? finiteNumberOrNull(asset.balancedRank),
      cycleRank: finiteNumberOrNull(asset.cycleRank),
      cyclePositionRank: finiteNumberOrNull(asset.cyclePositionRank),
      overallRankCount: rankedAssetCount,
      positionRankCount: rankedPositionCounts.get(asset.position) ?? 0,
    };
  });
}

function statusMatches(
  row: LeaguePlayerBoardRow,
  status: LeaguePlayerBoardStatusFilter,
): boolean {
  switch (status) {
    case 'free-agent':
      return row.status === 'free-agent';
    case 'available':
      return row.status === 'free-agent' || row.status === 'waivers';
    case 'rostered':
      return row.status === 'rostered';
    case 'waivers':
      return row.status === 'waivers';
    case 'reserved':
      return row.status === 'reserved';
    case 'watched':
      return row.watched;
    default:
      return true;
  }
}

function compareNullableDescending(
  first: number | null,
  second: number | null,
): number {
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

function compareNullableAscending(
  first: number | null,
  second: number | null,
): number {
  if (first === null && second === null) {
    return 0;
  }
  if (first === null) {
    return 1;
  }
  if (second === null) {
    return -1;
  }
  return first - second;
}

export function filterLeaguePlayerBoardRows(
  rows: readonly LeaguePlayerBoardRow[],
  input: FilterLeaguePlayerBoardRowsInput,
): LeaguePlayerBoardRow[] {
  const searchTerm = input.searchTerm?.trim().toLocaleLowerCase() ?? '';
  const position = input.position ?? 'all';
  const status = input.status ?? 'all';
  const sortMode = input.sortMode ?? 'season-points';

  const filtered = rows.filter((row) => {
    if (position !== 'all' && row.position !== position) {
      return false;
    }

    if (!statusMatches(row, status)) {
      return false;
    }

    if (!searchTerm) {
      return true;
    }

    return [
      row.name,
      row.nhlTeamAbbreviation,
      row.position,
      row.ownership?.teamName ?? '',
      row.ownership?.managerName ?? '',
    ].some((value) => value.toLocaleLowerCase().includes(searchTerm));
  });

  return filtered.sort((first, second) => {
    let result = 0;

    switch (sortMode) {
      case 'next-six':
        result = compareNullableDescending(first.nextSixProjection, second.nextSixProjection);
        break;
      case 'overall-rank':
        result = compareNullableAscending(first.overallRank, second.overallRank);
        break;
      case 'position-rank':
        result = compareNullableAscending(first.positionRank, second.positionRank);
        break;
      case 'rest-of-season':
        result = compareNullableDescending(
          first.restOfSeasonProjection,
          second.restOfSeasonProjection,
        );
        break;
      case 'reliability':
        result = compareNullableDescending(first.reliabilityRating, second.reliabilityRating);
        break;
      case 'name':
        result = first.name.localeCompare(second.name);
        break;
      default:
        result = compareNullableDescending(
          first.seasonFantasyPoints,
          second.seasonFantasyPoints,
        );
        break;
    }

    return result || first.name.localeCompare(second.name) || first.assetKey.localeCompare(second.assetKey);
  });
}
