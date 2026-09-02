import type { NhlTeamSeasonGame } from '../nhl/nhl-api.service';

export interface HistoricalReplaySkaterGameRow {
  gameId: number;
  gameDate: string;
  teamAbbreviation: string | null;
}

export interface HistoricalReplayAlignedPlayerData<T extends HistoricalReplaySkaterGameRow> {
  games: T[];
  schedule: NhlTeamSeasonGame[];
  appearedGameIds: Set<number>;
}

export interface HistoricalReplayAlignedTeamData<T extends { gameId: number; gameDate: string }> {
  games: T[];
  schedule: NhlTeamSeasonGame[];
}

export interface HistoricalReplaySkaterTimelineEntry {
  game: NhlTeamSeasonGame;
  sourceTeamAbbreviation: string;
}

export interface HistoricalReplayAssetMap {
  schemaVersion: 2;
  assetKey: string;
  assetType: 'skater' | 'team-goalie-unit';
  playerId: number | null;
  currentTeamAbbreviation: string;
  sourceSeason: string;
  sourceGameIds: number[];
  sourceGameDates: string[];
  sourceTeamAbbreviations: string[];
}

function normalizeTeamAbbreviation(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,4}$/.test(normalized) ? normalized : null;
}

export function normalizeHistoricalReplayAssetMap(
  value: Record<string, unknown> | undefined,
): HistoricalReplayAssetMap | null {
  const assetType = value?.['assetType'];
  const playerId = value?.['playerId'];
  const currentTeamAbbreviation = normalizeTeamAbbreviation(
    value?.['currentTeamAbbreviation'],
  );

  if (
    !value ||
    value['schemaVersion'] !== 2 ||
    typeof value['assetKey'] !== 'string' ||
    value['assetKey'].trim().length === 0 ||
    (assetType !== 'skater' && assetType !== 'team-goalie-unit') ||
    (assetType === 'skater' && (!Number.isInteger(playerId) || Number(playerId) <= 0)) ||
    (assetType === 'team-goalie-unit' && playerId !== null) ||
    !currentTeamAbbreviation ||
    typeof value['sourceSeason'] !== 'string' ||
    !/^\d{8}$/.test(value['sourceSeason']) ||
    !Array.isArray(value['sourceGameIds']) ||
    !Array.isArray(value['sourceGameDates']) ||
    !Array.isArray(value['sourceTeamAbbreviations'])
  ) {
    return null;
  }

  const sourceGameIds = value['sourceGameIds'];
  const sourceGameDates = value['sourceGameDates'];
  const sourceTeamAbbreviations = value['sourceTeamAbbreviations'];
  const normalizedSourceTeams = sourceTeamAbbreviations.map(normalizeTeamAbbreviation);

  if (
    sourceGameIds.length === 0 ||
    sourceGameIds.length > 82 ||
    sourceGameIds.length !== sourceGameDates.length ||
    sourceGameIds.length !== sourceTeamAbbreviations.length ||
    !sourceGameIds.every(
      (entry: unknown) => Number.isInteger(entry) && Number(entry) > 0,
    ) ||
    !sourceGameDates.every(
      (entry: unknown) => typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry),
    ) ||
    normalizedSourceTeams.some((entry) => !entry) ||
    new Set(sourceGameIds).size !== sourceGameIds.length
  ) {
    return null;
  }

  return {
    schemaVersion: 2,
    assetKey: value['assetKey'].trim(),
    assetType,
    playerId: playerId as number | null,
    currentTeamAbbreviation,
    sourceSeason: value['sourceSeason'],
    sourceGameIds: [...sourceGameIds] as number[],
    sourceGameDates: [...sourceGameDates] as string[],
    sourceTeamAbbreviations: normalizedSourceTeams as string[],
  };
}

function regularSeasonSchedule(
  schedule: readonly NhlTeamSeasonGame[],
): NhlTeamSeasonGame[] {
  return schedule
    .filter((game) => typeof game.gameType !== 'number' || game.gameType === 2)
    .slice()
    .sort((left, right) =>
      left.gameDate.localeCompare(right.gameDate) || left.id - right.id,
    );
}

function createReplayScheduleGame(
  targetGame: NhlTeamSeasonGame,
  sourceGameId: number | null,
  simulatedDate: string,
): NhlTeamSeasonGame {
  const released = Boolean(targetGame.gameDate && targetGame.gameDate <= simulatedDate);

  return {
    ...targetGame,
    id: sourceGameId && sourceGameId > 0 ? sourceGameId : targetGame.id,
    gameState: released ? 'FINAL' : 'FUT',
    homeTeam: {
      abbrev: targetGame.homeTeam.abbrev,
    },
    awayTeam: {
      abbrev: targetGame.awayTeam.abbrev,
    },
  };
}

/**
 * Reconstructs the source-season team-game timeline a skater belonged to,
 * including trade segments. Source game statistics exist only for appearances;
 * the team schedules fill the missed games needed by the six-game markers.
 */
export function buildHistoricalReplaySkaterTimelineEntries<
  T extends HistoricalReplaySkaterGameRow,
>(
  games: readonly T[],
  fallbackTeamAbbreviation: string,
  sourceSchedules: ReadonlyMap<string, readonly NhlTeamSeasonGame[]>,
): HistoricalReplaySkaterTimelineEntry[] {
  const sortedAppearances = games
    .filter((game) => game.gameId > 0 && Boolean(game.gameDate))
    .slice()
    .sort((left, right) =>
      left.gameDate.localeCompare(right.gameDate) || left.gameId - right.gameId,
    );
  const fallbackTeam = normalizeTeamAbbreviation(fallbackTeamAbbreviation) ?? '';
  const teamBySourceGameId = new Map<number, string>();

  sourceSchedules.forEach((schedule, teamValue) => {
    const team = normalizeTeamAbbreviation(teamValue);

    if (!team) {
      return;
    }

    for (const game of schedule) {
      if (game.id > 0 && !teamBySourceGameId.has(game.id)) {
        teamBySourceGameId.set(game.id, team);
      }
    }
  });

  const segments: Array<{ team: string; startDate: string | null }> = [];

  for (const game of sortedAppearances) {
    const team = normalizeTeamAbbreviation(game.teamAbbreviation) ??
      teamBySourceGameId.get(game.gameId) ??
      fallbackTeam;

    if (!team || segments.at(-1)?.team === team) {
      continue;
    }

    segments.push({
      team,
      startDate: segments.length === 0 ? null : game.gameDate,
    });
  }

  if (segments.length === 0 && fallbackTeam) {
    segments.push({ team: fallbackTeam, startDate: null });
  }

  const timeline: HistoricalReplaySkaterTimelineEntry[] = [];
  const seenGameIds = new Set<number>();

  segments.forEach((segment, index) => {
    const nextStartDate = segments[index + 1]?.startDate ?? null;
    const schedule = regularSeasonSchedule(sourceSchedules.get(segment.team) ?? []);

    for (const game of schedule) {
      const afterSegmentStart = !segment.startDate || game.gameDate >= segment.startDate;
      const beforeNextSegment = !nextStartDate || game.gameDate < nextStartDate;

      if (afterSegmentStart && beforeNextSegment && !seenGameIds.has(game.id)) {
        seenGameIds.add(game.id);
        timeline.push({
          game,
          sourceTeamAbbreviation: segment.team,
        });
      }
    }
  });

  // Preserve any source appearance that a schedule endpoint did not contain.
  for (const game of sortedAppearances) {
    if (seenGameIds.has(game.gameId)) {
      continue;
    }

    const team = normalizeTeamAbbreviation(game.teamAbbreviation) ??
      teamBySourceGameId.get(game.gameId) ??
      fallbackTeam;

    if (!team) {
      continue;
    }

    seenGameIds.add(game.gameId);
    timeline.push({
      game: {
        id: game.gameId,
        gameDate: game.gameDate,
        gameType: 2,
        gameState: 'FINAL',
        homeTeam: { abbrev: team },
        awayTeam: { abbrev: '' },
      },
      sourceTeamAbbreviation: team,
    });
  }

  return timeline
    .sort((left, right) =>
      left.game.gameDate.localeCompare(right.game.gameDate) ||
      left.game.id - right.game.id,
    )
    .slice(0, 82);
}

export function buildHistoricalReplaySkaterTimeline<
  T extends HistoricalReplaySkaterGameRow,
>(
  games: readonly T[],
  fallbackTeamAbbreviation: string,
  sourceSchedules: ReadonlyMap<string, readonly NhlTeamSeasonGame[]>,
): NhlTeamSeasonGame[] {
  return buildHistoricalReplaySkaterTimelineEntries(
    games,
    fallbackTeamAbbreviation,
    sourceSchedules,
  ).map((entry) => entry.game);
}

export function alignHistoricalReplaySkaterData<T extends HistoricalReplaySkaterGameRow>(
  input: {
    games: readonly T[];
    fallbackTeamAbbreviation: string;
    targetSchedule: readonly NhlTeamSeasonGame[];
    sourceSchedules: ReadonlyMap<string, readonly NhlTeamSeasonGame[]>;
    simulatedDate: string;
  },
): HistoricalReplayAlignedPlayerData<T> {
  const targetSchedule = regularSeasonSchedule(input.targetSchedule);
  const sourceTimeline = buildHistoricalReplaySkaterTimeline(
    input.games,
    input.fallbackTeamAbbreviation,
    input.sourceSchedules,
  );
  const gameById = new Map(
    input.games
      .filter((game) => game.gameId > 0)
      .map((game) => [game.gameId, game] as const),
  );
  const releasedGames: T[] = [];
  const appearedGameIds = new Set<number>();
  const schedule = targetSchedule.map((targetGame, index) => {
    const sourceGameId = sourceTimeline[index]?.id ?? null;
    const replayGame = createReplayScheduleGame(
      targetGame,
      sourceGameId,
      input.simulatedDate,
    );

    if (targetGame.gameDate <= input.simulatedDate && sourceGameId) {
      const appearance = gameById.get(sourceGameId);

      if (appearance) {
        releasedGames.push(appearance);
        appearedGameIds.add(replayGame.id);
      }
    }

    return replayGame;
  });

  releasedGames.sort((left, right) =>
    right.gameDate.localeCompare(left.gameDate) || right.gameId - left.gameId,
  );

  return {
    games: releasedGames,
    schedule,
    appearedGameIds,
  };
}

export function alignHistoricalReplayTeamData<T extends { gameId: number; gameDate: string }>(
  input: {
    games: readonly T[];
    targetSchedule: readonly NhlTeamSeasonGame[];
    sourceSchedule: readonly NhlTeamSeasonGame[];
    simulatedDate: string;
  },
): HistoricalReplayAlignedTeamData<T> {
  const targetSchedule = regularSeasonSchedule(input.targetSchedule);
  const sourceSchedule = regularSeasonSchedule(input.sourceSchedule);
  const gameById = new Map(
    input.games
      .filter((game) => game.gameId > 0)
      .map((game) => [game.gameId, game] as const),
  );
  const releasedGames: T[] = [];
  const schedule = targetSchedule.map((targetGame, index) => {
    const sourceGameId = sourceSchedule[index]?.id ?? null;
    const replayGame = createReplayScheduleGame(
      targetGame,
      sourceGameId,
      input.simulatedDate,
    );

    if (targetGame.gameDate <= input.simulatedDate && sourceGameId) {
      const game = gameById.get(sourceGameId);

      if (game) {
        releasedGames.push(game);
      }
    }

    return replayGame;
  });

  releasedGames.sort((left, right) =>
    right.gameDate.localeCompare(left.gameDate) || right.gameId - left.gameId,
  );

  return { games: releasedGames, schedule };
}
