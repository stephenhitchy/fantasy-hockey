import { createHash } from 'node:crypto';

export const SEASON_WINDOW_ANCHOR_SCHEMA_VERSION = 1 as const;
export const SEASON_WINDOW_ANCHOR_HASH_ALGORITHM = 'sha256' as const;

export interface SeasonWindowAnchorGame {
  id: number;
  gameDate: string;
  startTimeUTC?: string;
  gameType: number;
  gameState?: string;
}

export interface SeasonWindowAnchorTeamSchedule {
  teamAbbreviation: string;
  games: readonly SeasonWindowAnchorGame[];
}

export interface DetermineSeasonWindowAnchorInput {
  season: string;
  requiredGames: number;
  activeTeamAbbreviations: readonly string[];
  teamSchedules: readonly SeasonWindowAnchorTeamSchedule[];
}

export interface SeasonWindowAnchorTeamEvidence {
  teamAbbreviation: string;
  regularSeasonGameCount: number;
  /** Ordered regular-season IDs used to freeze every later source block. */
  regularSeasonGameIds: number[];
  finalPrefixGameCount: number;
  targetGameIds: number[];
}

export interface SeasonWindowAnchor {
  schemaVersion: typeof SEASON_WINDOW_ANCHOR_SCHEMA_VERSION;
  season: string;
  requiredGames: number;
  activeTeamCount: number;
  minimumFinalPrefixGameCount: number;
  sourceBlockNumber: number;
  sourceGameNumberStart: number;
  sourceGameNumberEnd: number;
  teams: SeasonWindowAnchorTeamEvidence[];
  evidenceHashAlgorithm: typeof SEASON_WINDOW_ANCHOR_HASH_ALGORITHM;
  evidenceHash: string;
}

export type SeasonWindowAnchorResult = SeasonWindowAnchor;

interface NormalizedSeasonWindowGame {
  id: number;
  gameDate: string;
  startTimeUTC: string;
  startTimeMilliseconds: number;
  gameState: string;
}

interface NormalizedTeamSchedule {
  teamAbbreviation: string;
  games: NormalizedSeasonWindowGame[];
  finalPrefixGameCount: number;
}

export class SeasonWindowAnchorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonWindowAnchorInputError';
  }
}

function fail(message: string): never {
  throw new SeasonWindowAnchorInputError(message);
}

function normalizeTeamAbbreviation(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    return fail(`${label} must be a string.`);
  }

  const normalized = value.trim().toUpperCase();

  if (!/^[A-Z0-9]{2,4}$/.test(normalized)) {
    return fail(`${label} is malformed.`);
  }

  return normalized;
}

function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function normalizeRegularSeasonGame(
  game: SeasonWindowAnchorGame,
  teamAbbreviation: string,
  scheduleIndex: number,
): NormalizedSeasonWindowGame {
  const label = `${teamAbbreviation} schedule game at index ${scheduleIndex}`;

  if (!Number.isSafeInteger(game.id) || game.id <= 0) {
    return fail(`${label} has a malformed game ID.`);
  }

  if (typeof game.gameDate !== 'string' || !isValidDateKey(game.gameDate)) {
    return fail(`${label} has a malformed gameDate.`);
  }

  if (
    typeof game.startTimeUTC !== 'string' ||
    !game.startTimeUTC.endsWith('Z')
  ) {
    return fail(`${label} has a missing or malformed startTimeUTC.`);
  }

  const startTimeMilliseconds = Date.parse(game.startTimeUTC);

  if (!Number.isFinite(startTimeMilliseconds)) {
    return fail(`${label} has a missing or malformed startTimeUTC.`);
  }

  if (typeof game.gameState !== 'string' || game.gameState.trim().length === 0) {
    return fail(`${label} has a missing or malformed gameState.`);
  }

  return {
    id: game.id,
    gameDate: game.gameDate,
    startTimeUTC: game.startTimeUTC,
    startTimeMilliseconds,
    gameState: game.gameState.trim().toUpperCase(),
  };
}

function compareGames(
  left: NormalizedSeasonWindowGame,
  right: NormalizedSeasonWindowGame,
): number {
  return left.startTimeMilliseconds - right.startTimeMilliseconds ||
    left.gameDate.localeCompare(right.gameDate) ||
    left.id - right.id;
}

function countFinalPrefix(games: readonly NormalizedSeasonWindowGame[]): number {
  let count = 0;

  for (const game of games) {
    if (game.gameState !== 'FINAL' && game.gameState !== 'OFF') {
      break;
    }

    count += 1;
  }

  return count;
}

function normalizeSchedule(
  schedule: SeasonWindowAnchorTeamSchedule,
  teamAbbreviation: string,
): NormalizedTeamSchedule {
  if (!Array.isArray(schedule.games)) {
    return fail(`${teamAbbreviation} is missing its NHL team schedule.`);
  }

  const games: NormalizedSeasonWindowGame[] = [];
  const seenGameIds = new Set<number>();

  schedule.games.forEach((game, scheduleIndex) => {
    if (!game || typeof game !== 'object') {
      fail(`${teamAbbreviation} schedule game at index ${scheduleIndex} is malformed.`);
    }

    if (!Number.isInteger(game.gameType)) {
      fail(`${teamAbbreviation} schedule game at index ${scheduleIndex} has a malformed gameType.`);
    }

    if (game.gameType !== 2) {
      return;
    }

    const normalized = normalizeRegularSeasonGame(
      game,
      teamAbbreviation,
      scheduleIndex,
    );

    if (seenGameIds.has(normalized.id)) {
      fail(
        `${teamAbbreviation} regular-season schedule contains duplicate NHL game ${normalized.id}.`,
      );
    }

    seenGameIds.add(normalized.id);
    games.push(normalized);
  });

  if (games.length === 0) {
    return fail(`${teamAbbreviation} has no regular-season NHL games.`);
  }

  games.sort(compareGames);

  return {
    teamAbbreviation,
    games,
    finalPrefixGameCount: countFinalPrefix(games),
  };
}

/**
 * Freezes the first six-game source block that at least one active NHL club
 * has not finished. The prefix rule deliberately ignores a later final game
 * after the first live or future game so provisional results cannot advance
 * the league-wide anchor.
 */
export function determineSeasonWindowAnchor(
  input: DetermineSeasonWindowAnchorInput,
): SeasonWindowAnchorResult {
  if (typeof input.season !== 'string' || !/^\d{8}$/.test(input.season)) {
    return fail('Season window anchoring requires an eight-digit NHL season.');
  }

  if (!Number.isSafeInteger(input.requiredGames) || input.requiredGames <= 0) {
    return fail('Season window anchoring requires a positive integer game count.');
  }

  if (
    !Array.isArray(input.activeTeamAbbreviations) ||
    input.activeTeamAbbreviations.length === 0
  ) {
    return fail('Season window anchoring requires at least one active NHL club.');
  }

  if (!Array.isArray(input.teamSchedules)) {
    return fail('Season window anchoring requires NHL team schedules.');
  }

  const activeTeams = input.activeTeamAbbreviations
    .map((team, index) => normalizeTeamAbbreviation(
      team,
      `Active NHL club at index ${index}`,
    ))
    .sort((left, right) => left.localeCompare(right));
  const activeTeamSet = new Set(activeTeams);

  if (activeTeamSet.size !== activeTeams.length) {
    return fail('Active NHL club input contains a duplicate team abbreviation.');
  }

  const schedulesByTeam = new Map<string, SeasonWindowAnchorTeamSchedule>();

  input.teamSchedules.forEach((schedule, index) => {
    if (!schedule || typeof schedule !== 'object') {
      fail(`NHL team schedule at index ${index} is malformed.`);
    }

    const teamAbbreviation = normalizeTeamAbbreviation(
      schedule.teamAbbreviation,
      `NHL team schedule at index ${index}`,
    );

    if (!activeTeamSet.has(teamAbbreviation)) {
      fail(`Received an NHL team schedule for inactive club ${teamAbbreviation}.`);
    }

    if (schedulesByTeam.has(teamAbbreviation)) {
      fail(`Received duplicate NHL team schedules for ${teamAbbreviation}.`);
    }

    schedulesByTeam.set(teamAbbreviation, schedule);
  });

  const missingTeams = activeTeams.filter((team) => !schedulesByTeam.has(team));

  if (missingTeams.length > 0) {
    return fail(
      `Missing NHL team schedules for active clubs: ${missingTeams.join(', ')}.`,
    );
  }

  const normalizedSchedules = activeTeams.map((teamAbbreviation) =>
    normalizeSchedule(schedulesByTeam.get(teamAbbreviation)!, teamAbbreviation));
  const minimumFinalPrefixGameCount = Math.min(
    ...normalizedSchedules.map((schedule) => schedule.finalPrefixGameCount),
  );
  const sourceBlockNumber =
    Math.floor(minimumFinalPrefixGameCount / input.requiredGames) + 1;
  const sourceGameNumberStart =
    (sourceBlockNumber - 1) * input.requiredGames + 1;
  const sourceGameNumberEnd = sourceBlockNumber * input.requiredGames;
  const targetStartIndex = sourceGameNumberStart - 1;
  const teams: SeasonWindowAnchorTeamEvidence[] = normalizedSchedules.map(
    (schedule) => {
      const targetGameIds = schedule.games
        .slice(targetStartIndex, targetStartIndex + input.requiredGames)
        .map((game) => game.id);

      if (targetGameIds.length !== input.requiredGames) {
        return fail(
          `${schedule.teamAbbreviation} schedule has only ${targetGameIds.length} of ` +
            `${input.requiredGames} games required for source block ${sourceBlockNumber}.`,
        );
      }

      return {
        teamAbbreviation: schedule.teamAbbreviation,
        regularSeasonGameCount: schedule.games.length,
        regularSeasonGameIds: schedule.games.map((game) => game.id),
        finalPrefixGameCount: schedule.finalPrefixGameCount,
        targetGameIds,
      };
    },
  );
  const hashPayload = {
    schemaVersion: SEASON_WINDOW_ANCHOR_SCHEMA_VERSION,
    season: input.season,
    requiredGames: input.requiredGames,
    activeTeamCount: activeTeams.length,
    minimumFinalPrefixGameCount,
    sourceBlockNumber,
    teams: normalizedSchedules.map((schedule) => ({
      teamAbbreviation: schedule.teamAbbreviation,
      regularSeasonGameCount: schedule.games.length,
      finalPrefixGameCount: schedule.finalPrefixGameCount,
      games: schedule.games.map((game) => ({
        gameId: game.id,
        gameState: game.gameState,
      })),
    })),
  };
  const evidenceHash = createHash(SEASON_WINDOW_ANCHOR_HASH_ALGORITHM)
    .update(JSON.stringify(hashPayload))
    .digest('hex');

  return {
    schemaVersion: SEASON_WINDOW_ANCHOR_SCHEMA_VERSION,
    season: input.season,
    requiredGames: input.requiredGames,
    activeTeamCount: activeTeams.length,
    minimumFinalPrefixGameCount,
    sourceBlockNumber,
    sourceGameNumberStart,
    sourceGameNumberEnd,
    teams,
    evidenceHashAlgorithm: SEASON_WINDOW_ANCHOR_HASH_ALGORITHM,
    evidenceHash,
  };
}
