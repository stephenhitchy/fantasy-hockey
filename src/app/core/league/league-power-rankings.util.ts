export interface LeaguePowerRankingTeamInput {
  ownerId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
}

export interface LeaguePowerRankingMatchupInput {
  cycleNumber: number;
  phase: 'regular_season' | 'playoffs';
  status: string;
  teamAOwnerId: string;
  teamBOwnerId: string | null;
  teamAScore: number;
  teamBScore: number;
  winnerOwnerId: string | null;
}

export type LeaguePowerRankingFactorKey =
  | 'record'
  | 'scoring'
  | 'differential'
  | 'recent-form';

export interface LeaguePowerRankingFactor {
  key: LeaguePowerRankingFactorKey;
  label: string;
  weight: number;
  metricLabel: string;
  normalizedScore: number;
  contribution: number;
}

export interface LeaguePowerRankingRow {
  rank: number;
  ownerId: string;
  teamName: string;
  officialRank: number;
  movement: number;
  powerScore: number;
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  pointsPerGame: number;
  pointDifferentialPerGame: number;
  recentWins: number;
  recentLosses: number;
  recentTies: number;
  recentGamesPlayed: number;
  recentPointDifferentialPerGame: number;
  factors: LeaguePowerRankingFactor[];
}

export interface LeaguePowerRankingsResult {
  rows: LeaguePowerRankingRow[];
  asOfCycleNumber: number | null;
  completedMatchupCount: number;
}

interface StandingSnapshot {
  ownerId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  winPercentage: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifferential: number;
}

interface RecentFormSnapshot {
  wins: number;
  losses: number;
  ties: number;
  gamesPlayed: number;
  pointDifferentialPerGame: number;
  winPercentage: number;
}

interface RankingDraft {
  standing: StandingSnapshot;
  officialRank: number;
  pointsPerGame: number;
  pointDifferentialPerGame: number;
  recent: RecentFormSnapshot;
  recordScore: number;
  scoringScore: number;
  differentialScore: number;
  recentScore: number;
  powerScore: number;
}

const RECENT_MATCHUP_LIMIT = 3;
const RECORD_WEIGHT = 0.35;
const SCORING_WEIGHT = 0.25;
const DIFFERENTIAL_WEIGHT = 0.20;
const RECENT_FORM_WEIGHT = 0.20;

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundWhole(value: number): number {
  return Math.round(value);
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeAcrossLeague(value: number, values: readonly number[]): number {
  if (values.length === 0) {
    return 0.5;
  }

  const minimum = Math.min(...values);
  const maximum = Math.max(...values);

  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum === minimum) {
    return 0.5;
  }

  return clampUnit((value - minimum) / (maximum - minimum));
}

function buildOfficialStandings(
  teams: readonly LeaguePowerRankingTeamInput[],
): StandingSnapshot[] {
  return teams
    .map((team) => {
      const wins = finiteNumber(team.wins);
      const losses = finiteNumber(team.losses);
      const ties = finiteNumber(team.ties);
      const gamesPlayed = wins + losses + ties;
      const pointsFor = roundOne(finiteNumber(team.pointsFor));
      const pointsAgainst = roundOne(finiteNumber(team.pointsAgainst));
      const pointDifferential = roundOne(pointsFor - pointsAgainst);

      return {
        ownerId: team.ownerId.trim(),
        teamName: team.teamName.trim() || 'Unnamed Team',
        wins,
        losses,
        ties,
        gamesPlayed,
        winPercentage: gamesPlayed > 0
          ? (wins + ties * 0.5) / gamesPlayed
          : 0,
        pointsFor,
        pointsAgainst,
        pointDifferential,
      } satisfies StandingSnapshot;
    })
    .filter((team) => team.ownerId)
    .filter((team, index, all) =>
      all.findIndex((candidate) => candidate.ownerId === team.ownerId) === index,
    )
    .sort((first, second) =>
      second.winPercentage - first.winPercentage ||
      second.pointsFor - first.pointsFor ||
      second.pointDifferential - first.pointDifferential ||
      second.wins - first.wins ||
      first.teamName.localeCompare(second.teamName) ||
      first.ownerId.localeCompare(second.ownerId),
    );
}

function ownerScore(
  matchup: LeaguePowerRankingMatchupInput,
  ownerId: string,
): { pointsFor: number; pointsAgainst: number } | null {
  if (matchup.teamAOwnerId === ownerId) {
    return {
      pointsFor: finiteNumber(matchup.teamAScore),
      pointsAgainst: finiteNumber(matchup.teamBScore),
    };
  }

  if (matchup.teamBOwnerId === ownerId) {
    return {
      pointsFor: finiteNumber(matchup.teamBScore),
      pointsAgainst: finiteNumber(matchup.teamAScore),
    };
  }

  return null;
}

function buildRecentForm(
  ownerId: string,
  matchups: readonly LeaguePowerRankingMatchupInput[],
): RecentFormSnapshot {
  const recent = matchups
    .filter(
      (matchup) =>
        matchup.status === 'complete' &&
        matchup.phase === 'regular_season' &&
        Boolean(matchup.teamBOwnerId) &&
        (matchup.teamAOwnerId === ownerId || matchup.teamBOwnerId === ownerId),
    )
    .sort((first, second) =>
      second.cycleNumber - first.cycleNumber ||
      first.teamAOwnerId.localeCompare(second.teamAOwnerId),
    )
    .slice(0, RECENT_MATCHUP_LIMIT);

  let wins = 0;
  let losses = 0;
  let ties = 0;
  let pointDifferential = 0;

  for (const matchup of recent) {
    const score = ownerScore(matchup, ownerId);
    if (!score) {
      continue;
    }

    pointDifferential += score.pointsFor - score.pointsAgainst;

    if (score.pointsFor > score.pointsAgainst) {
      wins += 1;
    } else if (score.pointsFor < score.pointsAgainst) {
      losses += 1;
    } else {
      ties += 1;
    }
  }

  const gamesPlayed = wins + losses + ties;
  return {
    wins,
    losses,
    ties,
    gamesPlayed,
    pointDifferentialPerGame: gamesPlayed > 0
      ? roundOne(pointDifferential / gamesPlayed)
      : 0,
    winPercentage: gamesPlayed > 0
      ? clampUnit((wins + ties * 0.5) / gamesPlayed)
      : 0.5,
  };
}

function metricLabel(value: number, suffix = ''): string {
  return `${roundOne(value).toFixed(1)}${suffix}`;
}

function buildFactors(draft: RankingDraft): LeaguePowerRankingFactor[] {
  return [
    {
      key: 'record',
      label: 'Official record',
      weight: RECORD_WEIGHT,
      metricLabel: draft.standing.gamesPlayed > 0
        ? `${draft.standing.wins}-${draft.standing.losses}-${draft.standing.ties}`
        : 'No results',
      normalizedScore: roundWhole(draft.recordScore * 100),
      contribution: roundOne(draft.recordScore * RECORD_WEIGHT * 100),
    },
    {
      key: 'scoring',
      label: 'Points per matchup',
      weight: SCORING_WEIGHT,
      metricLabel: metricLabel(draft.pointsPerGame),
      normalizedScore: roundWhole(draft.scoringScore * 100),
      contribution: roundOne(draft.scoringScore * SCORING_WEIGHT * 100),
    },
    {
      key: 'differential',
      label: 'Point differential',
      weight: DIFFERENTIAL_WEIGHT,
      metricLabel: metricLabel(draft.pointDifferentialPerGame, ' / matchup'),
      normalizedScore: roundWhole(draft.differentialScore * 100),
      contribution: roundOne(draft.differentialScore * DIFFERENTIAL_WEIGHT * 100),
    },
    {
      key: 'recent-form',
      label: 'Last 3 form',
      weight: RECENT_FORM_WEIGHT,
      metricLabel: draft.recent.gamesPlayed > 0
        ? `${draft.recent.wins}-${draft.recent.losses}-${draft.recent.ties}`
        : 'No recent result',
      normalizedScore: roundWhole(draft.recentScore * 100),
      contribution: roundOne(draft.recentScore * RECENT_FORM_WEIGHT * 100),
    },
  ];
}

export function buildLeaguePowerRankings(options: {
  teams: readonly LeaguePowerRankingTeamInput[];
  matchups: readonly LeaguePowerRankingMatchupInput[];
}): LeaguePowerRankingsResult {
  const officialStandings = buildOfficialStandings(options.teams);
  const knownOwnerIds = new Set(officialStandings.map((standing) => standing.ownerId));
  const completedMatchups = options.matchups.filter((matchup) => {
    const teamAOwnerId = matchup.teamAOwnerId.trim();
    const teamBOwnerId = matchup.teamBOwnerId?.trim() ?? '';

    return matchup.status === 'complete' &&
      matchup.phase === 'regular_season' &&
      Number.isInteger(matchup.cycleNumber) &&
      matchup.cycleNumber > 0 &&
      teamAOwnerId !== teamBOwnerId &&
      knownOwnerIds.has(teamAOwnerId) &&
      knownOwnerIds.has(teamBOwnerId) &&
      Number.isFinite(matchup.teamAScore) &&
      Number.isFinite(matchup.teamBScore);
  });
  const asOfCycleNumber = completedMatchups.length > 0
    ? Math.max(...completedMatchups.map((matchup) => matchup.cycleNumber))
    : null;
  const officialRankByOwner = new Map(
    officialStandings.map((standing, index) => [standing.ownerId, index + 1] as const),
  );

  const preliminary = officialStandings.map((standing) => {
    const gamesPlayed = Math.max(0, standing.gamesPlayed);
    return {
      standing,
      officialRank: officialRankByOwner.get(standing.ownerId) ?? officialStandings.length,
      pointsPerGame: gamesPlayed > 0 ? standing.pointsFor / gamesPlayed : 0,
      pointDifferentialPerGame: gamesPlayed > 0
        ? standing.pointDifferential / gamesPlayed
        : 0,
      recent: buildRecentForm(standing.ownerId, completedMatchups),
    };
  });

  const pointsPerGameValues = preliminary.map((draft) => draft.pointsPerGame);
  const differentialValues = preliminary.map((draft) => draft.pointDifferentialPerGame);
  const recentDifferentialValues = preliminary.map(
    (draft) => draft.recent.pointDifferentialPerGame,
  );

  const drafts: RankingDraft[] = preliminary.map((draft) => {
    const recordScore = draft.standing.gamesPlayed > 0
      ? clampUnit(draft.standing.winPercentage)
      : 0.5;
    const scoringScore = normalizeAcrossLeague(draft.pointsPerGame, pointsPerGameValues);
    const differentialScore = normalizeAcrossLeague(
      draft.pointDifferentialPerGame,
      differentialValues,
    );
    const recentDifferentialScore = normalizeAcrossLeague(
      draft.recent.pointDifferentialPerGame,
      recentDifferentialValues,
    );
    const recentScore = draft.recent.gamesPlayed > 0
      ? clampUnit((draft.recent.winPercentage * 0.6) + (recentDifferentialScore * 0.4))
      : 0.5;
    const powerScore = roundOne(100 * (
      recordScore * RECORD_WEIGHT +
      scoringScore * SCORING_WEIGHT +
      differentialScore * DIFFERENTIAL_WEIGHT +
      recentScore * RECENT_FORM_WEIGHT
    ));

    return {
      ...draft,
      recordScore,
      scoringScore,
      differentialScore,
      recentScore,
      powerScore,
    };
  });

  const sorted = [...drafts].sort((first, second) =>
    second.powerScore - first.powerScore ||
    second.recentScore - first.recentScore ||
    second.pointsPerGame - first.pointsPerGame ||
    first.officialRank - second.officialRank ||
    first.standing.teamName.localeCompare(second.standing.teamName) ||
    first.standing.ownerId.localeCompare(second.standing.ownerId),
  );

  return {
    asOfCycleNumber,
    completedMatchupCount: completedMatchups.length,
    rows: sorted.map((draft, index) => {
      const rank = index + 1;
      return {
        rank,
        ownerId: draft.standing.ownerId,
        teamName: draft.standing.teamName,
        officialRank: draft.officialRank,
        movement: draft.officialRank - rank,
        powerScore: draft.powerScore,
        wins: draft.standing.wins,
        losses: draft.standing.losses,
        ties: draft.standing.ties,
        gamesPlayed: draft.standing.gamesPlayed,
        pointsPerGame: roundOne(draft.pointsPerGame),
        pointDifferentialPerGame: roundOne(draft.pointDifferentialPerGame),
        recentWins: draft.recent.wins,
        recentLosses: draft.recent.losses,
        recentTies: draft.recent.ties,
        recentGamesPlayed: draft.recent.gamesPlayed,
        recentPointDifferentialPerGame: draft.recent.pointDifferentialPerGame,
        factors: buildFactors(draft),
      } satisfies LeaguePowerRankingRow;
    }),
  };
}
