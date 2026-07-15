import { FantasyTeam } from '../team/team.service';

export interface FantasyStandingSnapshot {
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

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : 0;
}

export function getFantasyStandingSnapshot(
  team: FantasyTeam
): FantasyStandingSnapshot {
  const wins = safeNumber(team.wins);
  const losses = safeNumber(team.losses);
  const ties = safeNumber(team.ties);
  const gamesPlayed = wins + losses + ties;
  const pointsFor = Number(safeNumber(team.pointsFor).toFixed(1));
  const pointsAgainst = Number(
    safeNumber(team.pointsAgainst).toFixed(1)
  );
  const pointDifferential = Number(
    (pointsFor - pointsAgainst).toFixed(1)
  );
  const winPercentage = gamesPlayed > 0
    ? Number(((wins + ties * 0.5) / gamesPlayed).toFixed(6))
    : 0;

  return {
    ownerId: team.ownerId,
    teamName: team.teamName,
    wins,
    losses,
    ties,
    gamesPlayed,
    winPercentage,
    pointsFor,
    pointsAgainst,
    pointDifferential
  };
}

export function compareFantasyStandings(
  first: FantasyStandingSnapshot,
  second: FantasyStandingSnapshot
): number {
  if (second.winPercentage !== first.winPercentage) {
    return second.winPercentage - first.winPercentage;
  }

  // Points For is the familiar public-league seeding tiebreaker used by
  // major fantasy platforms and rewards the stronger full-season offense.
  if (second.pointsFor !== first.pointsFor) {
    return second.pointsFor - first.pointsFor;
  }

  if (second.pointDifferential !== first.pointDifferential) {
    return second.pointDifferential - first.pointDifferential;
  }

  if (second.wins !== first.wins) {
    return second.wins - first.wins;
  }

  const teamNameComparison = first.teamName.localeCompare(second.teamName);

  if (teamNameComparison !== 0) {
    return teamNameComparison;
  }

  return first.ownerId.localeCompare(second.ownerId);
}

export function buildFantasyStandings(
  teams: FantasyTeam[]
): FantasyStandingSnapshot[] {
  return teams
    .map(getFantasyStandingSnapshot)
    .sort(compareFantasyStandings);
}
