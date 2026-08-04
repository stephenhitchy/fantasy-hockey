import { DraftPosition } from '../draft/draft.models';
import { NhlTeamSeasonGame } from '../nhl/nhl-api.service';

export interface TeamStrengthProfile {
  teamAbbreviation: string;
  gamesPlayed: number;
  goalsForPerGame: number;
  goalsAgainstPerGame: number;
  winPercentage: number;
  offensiveIndex: number;
  defensiveEaseIndex: number;
  strengthIndex: number;
  dataConfidence: number;
}

export interface ProjectionScheduleContext {
  multiplier: number;
  adjustmentLabel: 'Very Favorable' | 'Favorable' | 'Neutral' | 'Difficult' | 'Very Difficult';
  difficultyRating: number;
  dataConfidence: number;
  homeGames: number;
  roadGames: number;
  backToBackGames: number;
  restAdvantageGames: number;
  opponentAbbreviations: string[];
}

interface RawTeamSeasonProfile {
  gamesPlayed: number;
  goalsForPerGame: number;
  goalsAgainstPerGame: number;
  winPercentage: number;
}

const NEUTRAL_TEAM_PROFILE: TeamStrengthProfile = {
  teamAbbreviation: '',
  gamesPlayed: 0,
  goalsForPerGame: 0,
  goalsAgainstPerGame: 0,
  winPercentage: 0.5,
  offensiveIndex: 1,
  defensiveEaseIndex: 1,
  strengthIndex: 1,
  dataConfidence: 0.25,
};

export const NEUTRAL_PROJECTION_SCHEDULE_CONTEXT: ProjectionScheduleContext = {
  multiplier: 1,
  adjustmentLabel: 'Neutral',
  difficultyRating: 50,
  dataConfidence: 0,
  homeGames: 0,
  roadGames: 0,
  backToBackGames: 0,
  restAdvantageGames: 0,
  opponentAbbreviations: [],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function average(values: number[]): number | null {
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function isFinalGame(game: NhlTeamSeasonGame): boolean {
  const state = game.gameState?.toUpperCase();
  const hasScores =
    typeof game.homeTeam.score === 'number' &&
    typeof game.awayTeam.score === 'number';

  return state === 'OFF' || state === 'FINAL' || hasScores;
}

function getTeamGameScore(
  game: NhlTeamSeasonGame,
  teamAbbreviation: string,
): { goalsFor: number; goalsAgainst: number; won: boolean } | null {
  if (!isFinalGame(game)) {
    return null;
  }

  const team = teamAbbreviation.toUpperCase();
  const isHome = game.homeTeam.abbrev.toUpperCase() === team;
  const isAway = game.awayTeam.abbrev.toUpperCase() === team;

  if (!isHome && !isAway) {
    return null;
  }

  const goalsFor = isHome ? game.homeTeam.score : game.awayTeam.score;
  const goalsAgainst = isHome ? game.awayTeam.score : game.homeTeam.score;

  if (typeof goalsFor !== 'number' || typeof goalsAgainst !== 'number') {
    return null;
  }

  return {
    goalsFor,
    goalsAgainst,
    won: goalsFor > goalsAgainst,
  };
}

function buildRawTeamProfile(
  teamAbbreviation: string,
  schedule: NhlTeamSeasonGame[],
): RawTeamSeasonProfile | null {
  const results = schedule
    .map((game) => getTeamGameScore(game, teamAbbreviation))
    .filter(
      (result): result is { goalsFor: number; goalsAgainst: number; won: boolean } =>
        result !== null,
    );

  if (results.length === 0) {
    return null;
  }

  return {
    gamesPlayed: results.length,
    goalsForPerGame:
      results.reduce((total, result) => total + result.goalsFor, 0) / results.length,
    goalsAgainstPerGame:
      results.reduce((total, result) => total + result.goalsAgainst, 0) / results.length,
    winPercentage:
      results.filter((result) => result.won).length / results.length,
  };
}

function getLeagueAverages(
  profiles: Map<string, RawTeamSeasonProfile>,
): { goalsForPerGame: number; goalsAgainstPerGame: number; winPercentage: number } {
  const values = [...profiles.values()];

  return {
    goalsForPerGame: average(values.map((profile) => profile.goalsForPerGame)) ?? 3,
    goalsAgainstPerGame: average(values.map((profile) => profile.goalsAgainstPerGame)) ?? 3,
    winPercentage: average(values.map((profile) => profile.winPercentage)) ?? 0.5,
  };
}

function blendIndex(
  currentValue: number | null,
  previousValue: number | null,
  currentWeight: number,
): number {
  if (currentValue === null) {
    return previousValue ?? 1;
  }

  if (previousValue === null) {
    return currentValue;
  }

  return currentValue * currentWeight + previousValue * (1 - currentWeight);
}

export function buildTeamStrengthProfiles(
  currentSchedules: ReadonlyMap<string, NhlTeamSeasonGame[]>,
  previousSchedules: ReadonlyMap<string, NhlTeamSeasonGame[]>,
): Map<string, TeamStrengthProfile> {
  const teamAbbreviations = new Set([
    ...currentSchedules.keys(),
    ...previousSchedules.keys(),
  ]);
  const currentRaw = new Map<string, RawTeamSeasonProfile>();
  const previousRaw = new Map<string, RawTeamSeasonProfile>();

  for (const teamAbbreviation of teamAbbreviations) {
    const team = teamAbbreviation.toUpperCase();
    const current = buildRawTeamProfile(team, currentSchedules.get(team) ?? []);
    const previous = buildRawTeamProfile(team, previousSchedules.get(team) ?? []);

    if (current) {
      currentRaw.set(team, current);
    }

    if (previous) {
      previousRaw.set(team, previous);
    }
  }

  const currentLeague = getLeagueAverages(currentRaw);
  const previousLeague = getLeagueAverages(previousRaw);
  const result = new Map<string, TeamStrengthProfile>();

  for (const teamAbbreviation of teamAbbreviations) {
    const team = teamAbbreviation.toUpperCase();
    const current = currentRaw.get(team) ?? null;
    const previous = previousRaw.get(team) ?? null;
    const currentWeight = current
      ? clamp(current.gamesPlayed / 30, 0.08, 0.82)
      : 0;

    const currentOffense = current
      ? current.goalsForPerGame / Math.max(0.1, currentLeague.goalsForPerGame)
      : null;
    const previousOffense = previous
      ? previous.goalsForPerGame / Math.max(0.1, previousLeague.goalsForPerGame)
      : null;
    const currentDefenseEase = current
      ? current.goalsAgainstPerGame / Math.max(0.1, currentLeague.goalsAgainstPerGame)
      : null;
    const previousDefenseEase = previous
      ? previous.goalsAgainstPerGame / Math.max(0.1, previousLeague.goalsAgainstPerGame)
      : null;
    const currentWinIndex = current
      ? current.winPercentage / Math.max(0.1, currentLeague.winPercentage)
      : null;
    const previousWinIndex = previous
      ? previous.winPercentage / Math.max(0.1, previousLeague.winPercentage)
      : null;

    const offensiveIndex = clamp(
      blendIndex(currentOffense, previousOffense, currentWeight),
      0.78,
      1.22,
    );
    const defensiveEaseIndex = clamp(
      blendIndex(currentDefenseEase, previousDefenseEase, currentWeight),
      0.78,
      1.22,
    );
    const winIndex = clamp(
      blendIndex(currentWinIndex, previousWinIndex, currentWeight),
      0.8,
      1.2,
    );
    const strengthIndex = clamp(
      offensiveIndex * 0.45 + (1 / defensiveEaseIndex) * 0.35 + winIndex * 0.2,
      0.8,
      1.2,
    );
    const gamesPlayed = current?.gamesPlayed ?? 0;
    const previousGamesPlayed = previous?.gamesPlayed ?? 0;
    const dataConfidence = clamp(
      (gamesPlayed + Math.min(previousGamesPlayed, 82) * 0.28) / 30,
      previous ? 0.35 : 0.2,
      1,
    );

    result.set(team, {
      teamAbbreviation: team,
      gamesPlayed,
      goalsForPerGame:
        (current?.goalsForPerGame ?? previous?.goalsForPerGame ?? currentLeague.goalsForPerGame),
      goalsAgainstPerGame:
        (current?.goalsAgainstPerGame ??
          previous?.goalsAgainstPerGame ??
          currentLeague.goalsAgainstPerGame),
      winPercentage:
        (current?.winPercentage ?? previous?.winPercentage ?? currentLeague.winPercentage),
      offensiveIndex,
      defensiveEaseIndex,
      strengthIndex,
      dataConfidence,
    });
  }

  return result;
}

function getGameDate(game: NhlTeamSeasonGame): Date | null {
  const value = game.startTimeUTC ?? `${game.gameDate}T12:00:00Z`;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getRestDaysBeforeGame(
  schedule: NhlTeamSeasonGame[],
  game: NhlTeamSeasonGame,
): number | null {
  const gameDate = getGameDate(game);

  if (!gameDate) {
    return null;
  }

  const previousGame = schedule
    .filter((candidate) => candidate.id !== game.id)
    .map((candidate) => ({ candidate, date: getGameDate(candidate) }))
    .filter(
      (entry): entry is { candidate: NhlTeamSeasonGame; date: Date } =>
        entry.date !== null && entry.date.getTime() < gameDate.getTime(),
    )
    .sort((first, second) => second.date.getTime() - first.date.getTime())[0];

  if (!previousGame) {
    return null;
  }

  return (gameDate.getTime() - previousGame.date.getTime()) / 86_400_000;
}

function getOpponentAbbreviation(
  game: NhlTeamSeasonGame,
  teamAbbreviation: string,
): string {
  const team = teamAbbreviation.toUpperCase();
  return game.homeTeam.abbrev.toUpperCase() === team
    ? game.awayTeam.abbrev.toUpperCase()
    : game.homeTeam.abbrev.toUpperCase();
}

function getAdjustmentLabel(
  difficultyRating: number,
): ProjectionScheduleContext['adjustmentLabel'] {
  if (difficultyRating <= 34) {
    return 'Very Favorable';
  }

  if (difficultyRating <= 44) {
    return 'Favorable';
  }

  if (difficultyRating >= 66) {
    return 'Very Difficult';
  }

  if (difficultyRating >= 56) {
    return 'Difficult';
  }

  return 'Neutral';
}

export function calculateProjectionScheduleContext(input: {
  teamAbbreviation: string;
  position: DraftPosition;
  targetGames: NhlTeamSeasonGame[];
  teamSchedules: ReadonlyMap<string, NhlTeamSeasonGame[]>;
  teamStrengthProfiles: ReadonlyMap<string, TeamStrengthProfile>;
  requiredGamesPerCycle: number;
}): ProjectionScheduleContext {
  const team = input.teamAbbreviation.toUpperCase();

  if (input.targetGames.length === 0) {
    return NEUTRAL_PROJECTION_SCHEDULE_CONTEXT;
  }

  let homeGames = 0;
  let roadGames = 0;
  let backToBackGames = 0;
  let restAdvantageGames = 0;
  let confidenceTotal = 0;
  const gameMultipliers: number[] = [];
  const opponents: string[] = [];
  const teamSchedule = input.teamSchedules.get(team) ?? [];

  for (const game of input.targetGames) {
    const opponent = getOpponentAbbreviation(game, team);
    const opponentProfile =
      input.teamStrengthProfiles.get(opponent) ?? {
        ...NEUTRAL_TEAM_PROFILE,
        teamAbbreviation: opponent,
      };
    const isHome = game.homeTeam.abbrev.toUpperCase() === team;
    const ownRestDays = getRestDaysBeforeGame(teamSchedule, game);
    const opponentSchedule = input.teamSchedules.get(opponent) ?? [];
    const opponentRestDays = getRestDaysBeforeGame(opponentSchedule, game);
    const ownBackToBack = ownRestDays !== null && ownRestDays <= 1.35;
    const opponentBackToBack =
      opponentRestDays !== null && opponentRestDays <= 1.35;
    const hasRestAdvantage =
      ownRestDays !== null &&
      ownRestDays >= 2.75 &&
      (opponentRestDays === null || opponentRestDays < 2.25);

    if (isHome) {
      homeGames += 1;
    } else {
      roadGames += 1;
    }

    if (ownBackToBack) {
      backToBackGames += 1;
    }

    if (hasRestAdvantage) {
      restAdvantageGames += 1;
    }

    opponents.push(opponent);
    confidenceTotal += opponentProfile.dataConfidence;

    let multiplier = 1;

    if (input.position === 'G') {
      // Better offenses create some extra save volume, but lower win odds and
      // weaker continuous save-quality expectations remain the stronger effect.
      multiplier += (opponentProfile.offensiveIndex - 1) * -0.055;
      multiplier += (opponentProfile.strengthIndex - 1) * -0.035;
      multiplier += isHome ? 0.012 : -0.012;
      multiplier += ownBackToBack ? -0.032 : 0;
      multiplier += opponentBackToBack ? 0.012 : 0;
      multiplier += hasRestAdvantage ? 0.008 : 0;
      multiplier = clamp(multiplier, 0.9, 1.08);
    } else {
      const defenseSensitivity = input.position === 'D' ? 0.085 : 0.11;
      multiplier +=
        (opponentProfile.defensiveEaseIndex - 1) * defenseSensitivity;
      multiplier += (opponentProfile.strengthIndex - 1) * -0.022;
      multiplier += isHome ? 0.01 : -0.01;
      multiplier += ownBackToBack ? -0.025 : 0;
      multiplier += opponentBackToBack ? 0.011 : 0;
      multiplier += hasRestAdvantage ? 0.007 : 0;
      multiplier = clamp(multiplier, 0.93, 1.07);
    }

    gameMultipliers.push(multiplier);
  }

  const rawMultiplier = average(gameMultipliers) ?? 1;
  const scheduleCompleteness = clamp(
    input.targetGames.length / Math.max(1, input.requiredGamesPerCycle),
    0,
    1,
  );
  const opponentDataConfidence =
    confidenceTotal / Math.max(1, input.targetGames.length);
  const dataConfidence = clamp(
    scheduleCompleteness * opponentDataConfidence,
    0,
    1,
  );
  const maxDownside = input.position === 'G' ? 0.08 : 0.06;
  const maxUpside = input.position === 'G' ? 0.07 : 0.06;
  const multiplier = clamp(
    1 + (rawMultiplier - 1) * dataConfidence,
    1 - maxDownside,
    1 + maxUpside,
  );
  const difficultyRating = clamp(
    50 - (multiplier - 1) * 500,
    10,
    90,
  );

  return {
    multiplier: Number(multiplier.toFixed(4)),
    adjustmentLabel: getAdjustmentLabel(difficultyRating),
    difficultyRating: Number(difficultyRating.toFixed(1)),
    dataConfidence: Number((dataConfidence * 100).toFixed(1)),
    homeGames,
    roadGames,
    backToBackGames,
    restAdvantageGames,
    opponentAbbreviations: opponents,
  };
}
