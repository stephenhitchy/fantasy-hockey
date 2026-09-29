import type {
  NhlGameBoxscoreResponse,
  NhlGamePlayByPlayResponse,
  NhlGameRosterSpot,
  NhlGameTeamSummary,
  NhlGoalieBoxscoreLine,
  NhlPlayByPlayEvent,
  NhlScorePeriodDescriptor,
  NhlSkaterBoxscoreLine,
  NhlTeamBoxscore,
} from '../../../core/nhl/nhl-api.service';

export interface NhlGameScoringEvent {
  id: string;
  periodLabel: string;
  timeInPeriod: string;
  teamAbbreviation: string;
  scorerId: number | null;
  scorerName: string;
  assists: Array<{ id: number; name: string }>;
  scoreLabel: string;
  tags: string[];
  isShootout: boolean;
}

export interface NhlGamePeriodScore {
  key: string;
  label: string;
  away: number;
  home: number;
}

export interface NhlGameTeamComparisonRow {
  label: string;
  away: string;
  home: string;
}

export interface NhlGameTopPerformer {
  playerId: number;
  name: string;
  teamAbbreviation: string;
  position: string;
  headshotUrl: string;
  headline: string;
  basis: string;
}

export function parseNhlGameId(value: string | null): number | null {
  if (!value || !/^\d{10}$/.test(value)) {
    return null;
  }

  const gameId = Number(value);
  return Number.isSafeInteger(gameId) && gameId > 0 ? gameId : null;
}

export function isNhlGameLiveState(gameState: string | undefined): boolean {
  const normalized = (gameState ?? '').trim().toUpperCase();
  return normalized === 'LIVE' || normalized === 'CRIT';
}

export function isNhlGameFinalState(gameState: string | undefined): boolean {
  const normalized = (gameState ?? '').trim().toUpperCase();
  return normalized === 'FINAL' || normalized === 'OFF';
}

export function getNhlPeriodLabel(
  descriptor: NhlScorePeriodDescriptor | undefined,
): string {
  const periodType = (descriptor?.periodType ?? '').trim().toUpperCase();
  const number = descriptor?.number ?? 0;

  if (periodType === 'SO') {
    return 'SO';
  }

  if (periodType === 'OT') {
    return number > 4 ? `${number - 3}OT` : 'OT';
  }

  if (number > 0) {
    return ordinal(number);
  }

  return 'Period';
}

export function formatNhlGameDetailStatus(
  boxscore: NhlGameBoxscoreResponse,
  now: Date = new Date(),
): string {
  const scheduleState = (boxscore.gameScheduleState ?? '').trim().toUpperCase();
  const gameState = (boxscore.gameState ?? '').trim().toUpperCase();

  if (['PPD', 'POSTPONED'].includes(scheduleState) || gameState === 'PPD') {
    return 'Postponed';
  }

  if (['CNCL', 'CANCELLED', 'CANCELED'].includes(scheduleState) || gameState === 'CNCL') {
    return 'Canceled';
  }

  if (isNhlGameFinalState(gameState)) {
    const lastPeriodType = (boxscore.gameOutcome?.lastPeriodType ?? '').trim().toUpperCase();
    return lastPeriodType && lastPeriodType !== 'REG'
      ? `Final/${lastPeriodType}`
      : 'Final';
  }

  if (isNhlGameLiveState(gameState)) {
    const period = getNhlPeriodLabel(boxscore.periodDescriptor);

    if (boxscore.clock?.inIntermission) {
      return `${period} intermission`;
    }

    const timeRemaining = boxscore.clock?.timeRemaining?.trim();
    return timeRemaining ? `${period} · ${timeRemaining}` : period;
  }

  if (boxscore.startTimeUTC) {
    const start = new Date(boxscore.startTimeUTC);

    if (!Number.isNaN(start.getTime())) {
      const dateLabel = new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
      }).format(start);
      const timeLabel = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(start);
      const today = new Intl.DateTimeFormat('en-CA').format(now);
      const startDate = new Intl.DateTimeFormat('en-CA').format(start);
      return today === startDate ? timeLabel : `${dateLabel} · ${timeLabel}`;
    }
  }

  return 'Scheduled';
}

export function formatNhlGameDetailDate(boxscore: NhlGameBoxscoreResponse): string {
  const source = boxscore.startTimeUTC || boxscore.gameDate;

  if (!source) {
    return 'Date unavailable';
  }

  const date = boxscore.startTimeUTC
    ? new Date(boxscore.startTimeUTC)
    : new Date(`${source}T12:00:00`);

  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable';
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(boxscore.startTimeUTC
      ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
      : {}),
  }).format(date);
}

export function buildNhlGameScoringEvents(
  playByPlay: NhlGamePlayByPlayResponse | null,
  boxscore: NhlGameBoxscoreResponse | null,
): NhlGameScoringEvent[] {
  if (!playByPlay) {
    return [];
  }

  const roster = createRosterMap(playByPlay.rosterSpots);
  const teams = createTeamIdMap(
    boxscore?.awayTeam ?? playByPlay.awayTeam,
    boxscore?.homeTeam ?? playByPlay.homeTeam,
  );

  return (playByPlay.plays ?? [])
    .filter((play) => play.typeDescKey === 'goal')
    .slice()
    .sort((first, second) => (first.sortOrder ?? 0) - (second.sortOrder ?? 0))
    .map((play, index) => {
      const scorerId = play.details?.scoringPlayerId ?? null;
      const periodType = (play.periodDescriptor?.periodType ?? '').toUpperCase();
      const isShootout = periodType === 'SO';
      const assists = [play.details?.assist1PlayerId, play.details?.assist2PlayerId]
        .filter((playerId): playerId is number => typeof playerId === 'number')
        .map((playerId) => ({
          id: playerId,
          name: getRosterPlayerName(roster.get(playerId), `Player ${playerId}`),
        }));

      return {
        id: String(play.eventId ?? `${play.sortOrder ?? index}-${index}`),
        periodLabel: getNhlPeriodLabel(play.periodDescriptor),
        timeInPeriod: isShootout ? 'Attempt' : play.timeInPeriod?.trim() || 'Time unavailable',
        teamAbbreviation: teams.get(play.details?.eventOwnerTeamId ?? -1) ?? 'NHL',
        scorerId,
        scorerName: scorerId === null
          ? 'Scorer unavailable'
          : getRosterPlayerName(roster.get(scorerId), `Player ${scorerId}`),
        assists,
        scoreLabel: isShootout
          ? 'Shootout'
          : formatScoreAfterGoal(play),
        tags: getScoringEventTags(play, boxscore),
        isShootout,
      };
    });
}

export function buildNhlGamePeriodScores(
  playByPlay: NhlGamePlayByPlayResponse | null,
  boxscore: NhlGameBoxscoreResponse | null,
): NhlGamePeriodScore[] {
  if (!playByPlay || !boxscore?.awayTeam || !boxscore.homeTeam) {
    return [];
  }

  const awayTeamId = boxscore.awayTeam.id;
  const homeTeamId = boxscore.homeTeam.id;
  const goals = (playByPlay.plays ?? []).filter((play) => play.typeDescKey === 'goal');
  const descriptors = new Map<string, NhlScorePeriodDescriptor>();

  for (const play of playByPlay.plays ?? []) {
    const descriptor = play.periodDescriptor;
    const type = (descriptor?.periodType ?? '').toUpperCase();

    if (!descriptor?.number || type === 'SO') {
      continue;
    }

    descriptors.set(`${descriptor.number}:${type}`, descriptor);
  }

  const rows = [...descriptors.values()]
    .sort((first, second) => (first.number ?? 0) - (second.number ?? 0))
    .map((descriptor) => {
      const matchingGoals = goals.filter((goal) =>
        goal.periodDescriptor?.number === descriptor.number &&
        (goal.periodDescriptor?.periodType ?? '').toUpperCase() !== 'SO',
      );

      return {
        key: `${descriptor.number}:${descriptor.periodType ?? 'REG'}`,
        label: getNhlPeriodLabel(descriptor),
        away: matchingGoals.filter((goal) => goal.details?.eventOwnerTeamId === awayTeamId).length,
        home: matchingGoals.filter((goal) => goal.details?.eventOwnerTeamId === homeTeamId).length,
      };
    });

  const hasShootout = (boxscore.gameOutcome?.lastPeriodType ?? '').toUpperCase() === 'SO' ||
    (playByPlay.plays ?? []).some((play) =>
      (play.periodDescriptor?.periodType ?? '').toUpperCase() === 'SO',
    );

  if (hasShootout && typeof boxscore.awayTeam.score === 'number' && typeof boxscore.homeTeam.score === 'number') {
    rows.push({
      key: 'shootout',
      label: 'SO',
      away: boxscore.awayTeam.score > boxscore.homeTeam.score ? 1 : 0,
      home: boxscore.homeTeam.score > boxscore.awayTeam.score ? 1 : 0,
    });
  }

  return rows;
}

export function buildNhlGameTeamComparison(
  boxscore: NhlGameBoxscoreResponse | null,
  playByPlay: NhlGamePlayByPlayResponse | null = null,
): NhlGameTeamComparisonRow[] {
  if (!boxscore?.awayTeam || !boxscore.homeTeam) {
    return [];
  }

  const awayStats = boxscore.playerByGameStats?.awayTeam;
  const homeStats = boxscore.playerByGameStats?.homeTeam;
  const awayPenaltyMinutes = sumPenaltyMinutes(
    playByPlay,
    boxscore.awayTeam.id,
    sumPlayerField(awayStats, 'pim'),
  );
  const homePenaltyMinutes = sumPenaltyMinutes(
    playByPlay,
    boxscore.homeTeam.id,
    sumPlayerField(homeStats, 'pim'),
  );

  return [
    comparisonRow('Shots on goal', boxscore.awayTeam.sog, boxscore.homeTeam.sog),
    comparisonRow('Power-play goals', sumSkaterField(awayStats, 'powerPlayGoals'), sumSkaterField(homeStats, 'powerPlayGoals')),
    comparisonRow('Penalty minutes', awayPenaltyMinutes, homePenaltyMinutes),
    comparisonRow('Hits', sumSkaterField(awayStats, 'hits'), sumSkaterField(homeStats, 'hits')),
    comparisonRow('Blocked shots', sumSkaterField(awayStats, 'blockedShots'), sumSkaterField(homeStats, 'blockedShots')),
  ].filter((row) => row.away !== '—' || row.home !== '—');
}

export function buildNhlGameTopPerformers(
  boxscore: NhlGameBoxscoreResponse | null,
  playByPlay: NhlGamePlayByPlayResponse | null,
): NhlGameTopPerformer[] {
  if (!boxscore) {
    return [];
  }

  const roster = createRosterMap(playByPlay?.rosterSpots);
  const skaters = collectPlayers(boxscore, 'skater') as Array<{
    player: NhlSkaterBoxscoreLine;
    team: NhlGameTeamSummary;
  }>;
  const goalies = (collectPlayers(boxscore, 'goalie') as Array<{
    player: NhlGoalieBoxscoreLine;
    team: NhlGameTeamSummary;
  }>).filter(({ player }) => player.toi !== '00:00' || player.shotsAgainst > 0);

  skaters.sort((first, second) =>
    second.player.points - first.player.points ||
    second.player.goals - first.player.goals ||
    second.player.assists - first.player.assists ||
    second.player.sog - first.player.sog ||
    timeOnIceSeconds(second.player.toi) - timeOnIceSeconds(first.player.toi) ||
    first.player.playerId - second.player.playerId,
  );
  goalies.sort((first, second) =>
    (second.player.savePctg ?? -1) - (first.player.savePctg ?? -1) ||
    second.player.saves - first.player.saves ||
    first.player.goalsAgainst - second.player.goalsAgainst ||
    first.player.playerId - second.player.playerId,
  );

  const leaders = skaters.slice(0, goalies.length > 0 ? 2 : 3).map(({ player, team }) => ({
    playerId: player.playerId,
    name: getRosterPlayerName(roster.get(player.playerId), player.name.default),
    teamAbbreviation: team.abbrev,
    position: player.position,
    headshotUrl: roster.get(player.playerId)?.headshot ?? '',
    headline: `${player.goals} G · ${player.assists} A · ${player.points} P`,
    basis: `${player.sog} shots · ${player.toi} TOI`,
  }));

  if (goalies[0]) {
    const { player, team } = goalies[0];
    leaders.push({
      playerId: player.playerId,
      name: getRosterPlayerName(roster.get(player.playerId), player.name.default),
      teamAbbreviation: team.abbrev,
      position: 'G',
      headshotUrl: roster.get(player.playerId)?.headshot ?? '',
      headline: `${player.saves}/${player.shotsAgainst} saves`,
      basis: `${formatNhlSavePercentage(player.savePctg)} SV% · ${player.goalsAgainst} GA`,
    });
  }

  return leaders.slice(0, 3);
}

export function getNhlGamePlayerName(
  playerId: number,
  fallbackName: string,
  playByPlay: NhlGamePlayByPlayResponse | null,
): string {
  return getRosterPlayerName(
    (playByPlay?.rosterSpots ?? []).find((spot) => spot.playerId === playerId),
    fallbackName,
  );
}

export function getNhlGamePlayerHeadshot(
  playerId: number,
  playByPlay: NhlGamePlayByPlayResponse | null,
): string {
  return (playByPlay?.rosterSpots ?? []).find((spot) => spot.playerId === playerId)?.headshot ?? '';
}

export function formatNhlSavePercentage(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }

  return value.toFixed(3).replace(/^0/, '');
}

export function getNhlGameTeamName(team: NhlGameTeamSummary | undefined): string {
  if (!team) {
    return 'Team unavailable';
  }

  const place = team.placeName?.default?.trim();
  const common = team.commonName?.default?.trim();
  return [place, common].filter(Boolean).join(' ') || team.abbrev;
}

function createRosterMap(rosterSpots: NhlGameRosterSpot[] | undefined): Map<number, NhlGameRosterSpot> {
  return new Map((rosterSpots ?? []).map((spot) => [spot.playerId, spot]));
}

function createTeamIdMap(
  awayTeam: NhlGameTeamSummary | undefined,
  homeTeam: NhlGameTeamSummary | undefined,
): Map<number, string> {
  const teams = new Map<number, string>();

  if (typeof awayTeam?.id === 'number') {
    teams.set(awayTeam.id, awayTeam.abbrev);
  }

  if (typeof homeTeam?.id === 'number') {
    teams.set(homeTeam.id, homeTeam.abbrev);
  }

  return teams;
}

function getRosterPlayerName(player: NhlGameRosterSpot | undefined, fallback: string): string {
  if (!player) {
    return fallback;
  }

  return [player.firstName?.default, player.lastName?.default]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
    .join(' ') || fallback;
}

function getScoringEventTags(
  play: NhlPlayByPlayEvent,
  boxscore: NhlGameBoxscoreResponse | null,
): string[] {
  const periodType = (play.periodDescriptor?.periodType ?? '').toUpperCase();

  if (periodType === 'SO') {
    return ['Shootout goal'];
  }

  const code = play.situationCode ?? '';
  const tags: string[] = [];

  if (/^\d{4}$/.test(code)) {
    const awayGoalie = Number(code[0]);
    const awaySkaters = Number(code[1]);
    const homeSkaters = Number(code[2]);
    const homeGoalie = Number(code[3]);
    const isAwayScorer = play.details?.eventOwnerTeamId === boxscore?.awayTeam?.id;
    const opponentGoalie = isAwayScorer ? homeGoalie : awayGoalie;
    const scoringSkaters = isAwayScorer ? awaySkaters : homeSkaters;
    const opponentSkaters = isAwayScorer ? homeSkaters : awaySkaters;

    if (opponentGoalie === 0) {
      tags.push('Empty net');
    } else if (scoringSkaters > opponentSkaters) {
      tags.push('Power play');
    } else if (scoringSkaters < opponentSkaters) {
      tags.push('Shorthanded');
    }
  }

  const periodNumber = play.periodDescriptor?.number ?? 0;
  if (periodType === 'OT' && periodNumber >= 4) {
    tags.push('Overtime');
  }

  return tags;
}

function formatScoreAfterGoal(play: NhlPlayByPlayEvent): string {
  const away = play.details?.awayScore;
  const home = play.details?.homeScore;
  return typeof away === 'number' && typeof home === 'number'
    ? `${away}–${home}`
    : 'Score unavailable';
}

function comparisonRow(
  label: string,
  away: number | null | undefined,
  home: number | null | undefined,
): NhlGameTeamComparisonRow {
  return {
    label,
    away: typeof away === 'number' ? String(away) : '—',
    home: typeof home === 'number' ? String(home) : '—',
  };
}

function getSkaters(team: NhlTeamBoxscore | undefined): NhlSkaterBoxscoreLine[] {
  return [...(team?.forwards ?? []), ...(team?.defense ?? [])];
}

function sumSkaterField(
  team: NhlTeamBoxscore | undefined,
  field: 'powerPlayGoals' | 'hits' | 'blockedShots',
): number | null {
  if (!team) {
    return null;
  }

  return getSkaters(team).reduce((total, player) => total + player[field], 0);
}

function sumPlayerField(
  team: NhlTeamBoxscore | undefined,
  field: 'pim',
): number | null {
  if (!team) {
    return null;
  }

  return [
    ...getSkaters(team),
    ...(team.goalies ?? []),
  ].reduce((total, player) => total + (player[field] ?? 0), 0);
}

function sumPenaltyMinutes(
  playByPlay: NhlGamePlayByPlayResponse | null,
  teamId: number | undefined,
  fallback: number | null,
): number | null {
  if (!playByPlay?.plays || typeof teamId !== 'number') {
    return fallback;
  }

  return playByPlay.plays
    .filter((play) =>
      play.typeDescKey === 'penalty' &&
      play.details?.eventOwnerTeamId === teamId,
    )
    .reduce((total, play) => total + (play.details?.duration ?? 0), 0);
}

function collectPlayers(
  boxscore: NhlGameBoxscoreResponse,
  kind: 'skater' | 'goalie',
): Array<{
  player: NhlSkaterBoxscoreLine | NhlGoalieBoxscoreLine;
  team: NhlGameTeamSummary;
}> {
  const result: Array<{
    player: NhlSkaterBoxscoreLine | NhlGoalieBoxscoreLine;
    team: NhlGameTeamSummary;
  }> = [];

  for (const side of ['awayTeam', 'homeTeam'] as const) {
    const team = boxscore[side];
    const teamStats = boxscore.playerByGameStats?.[side];

    if (!team || !teamStats) {
      continue;
    }

    const players = kind === 'skater'
      ? getSkaters(teamStats)
      : teamStats.goalies ?? [];

    for (const player of players) {
      result.push({ player, team });
    }
  }

  return result;
}

function timeOnIceSeconds(value: string): number {
  const [minutes, seconds] = value.split(':').map(Number);
  return Number.isFinite(minutes) && Number.isFinite(seconds)
    ? minutes * 60 + seconds
    : 0;
}

function ordinal(value: number): string {
  const remainder = value % 100;

  if (remainder >= 11 && remainder <= 13) {
    return `${value}th`;
  }

  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}
