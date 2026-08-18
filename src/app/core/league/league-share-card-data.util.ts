export const LEAGUE_SHARE_SITE_URL = 'https://rinkratfantasy.com';

export function normalizeLeagueShareText(
  value: unknown,
  maximumLength: number,
  fallback: string,
): string {
  const normalized = typeof value === 'string'
    ? value
      .normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    : '';

  if (!normalized) {
    return fallback;
  }

  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, Math.max(1, maximumLength - 1)).trimEnd()}…`;
}

export function formatLeagueShareNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return value
    .toFixed(Math.max(0, Math.min(2, digits)))
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1');
}

export function slugifyLeagueShareValue(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return slug || fallback;
}

export interface LeagueDraftSharePick {
  name: string;
  position: 'LW' | 'C' | 'RW' | 'D' | 'G';
  round: number;
  overallPick: number;
}

export interface LeagueDraftShareCardData {
  leagueName: string;
  teamName: string;
  draftSlot: number;
  totalTeams: number;
  totalPicks: number;
  picks: readonly LeagueDraftSharePick[];
}

const DRAFT_PICK_DISPLAY_LIMIT = 6;
const DEFAULT_LEAGUE_NAME = 'RinkRat League';
const DEFAULT_TEAM_NAME = 'RinkRat Team';
const VALID_POSITIONS = new Set<LeagueDraftSharePick['position']>([
  'LW',
  'C',
  'RW',
  'D',
  'G',
]);

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function normalizeLeagueDraftShareCardData(
  source: LeagueDraftShareCardData,
): LeagueDraftShareCardData {
  const totalTeams = boundedInteger(source.totalTeams, 2, 32, 2);
  const draftSlot = boundedInteger(source.draftSlot, 1, totalTeams, 1);
  const totalPicks = boundedInteger(source.totalPicks, 1, 64, 1);
  const seenOverallPicks = new Set<number>();
  const picks = source.picks
    .map((pick) => ({
      name: normalizeLeagueShareText(pick.name, 52, 'Draft pick'),
      position: VALID_POSITIONS.has(pick.position) ? pick.position : 'C',
      round: boundedInteger(pick.round, 1, 64, 1),
      overallPick: boundedInteger(pick.overallPick, 1, 1_024, 1),
    }))
    .filter((pick) => {
      if (seenOverallPicks.has(pick.overallPick)) {
        return false;
      }
      seenOverallPicks.add(pick.overallPick);
      return true;
    })
    .sort((first, second) => first.overallPick - second.overallPick)
    .slice(0, DRAFT_PICK_DISPLAY_LIMIT);

  return {
    leagueName: normalizeLeagueShareText(source.leagueName, 72, DEFAULT_LEAGUE_NAME),
    teamName: normalizeLeagueShareText(source.teamName, 56, DEFAULT_TEAM_NAME),
    draftSlot,
    totalTeams,
    totalPicks,
    picks,
  };
}

export function buildLeagueDraftShareText(
  source: LeagueDraftShareCardData,
): string {
  const data = normalizeLeagueDraftShareCardData(source);
  const featured = data.picks.length > 0
    ? `Core picks: ${data.picks.map((pick) => `${pick.name} (${pick.position})`).join(', ')}`
    : 'The roster is ready for the season.';

  const possessiveTeamName = /s$/i.test(data.teamName)
    ? `${data.teamName}'`
    : `${data.teamName}'s`;

  return `${possessiveTeamName} RinkRat draft is complete.\nDraft slot #${data.draftSlot} of ${data.totalTeams} · ${data.totalPicks} picks\n${featured}\n${data.leagueName}\n${LEAGUE_SHARE_SITE_URL}`;
}

export function buildLeagueDraftShareFilename(
  source: LeagueDraftShareCardData,
): string {
  const data = normalizeLeagueDraftShareCardData(source);
  return `${slugifyLeagueShareValue(data.teamName, 'rinkrat-team')}-draft-rinkrat.png`;
}

export interface LeagueStandingsShareRow {
  rank: number;
  teamName: string;
  record: string;
  pointsFor: number;
  pointDifferential: number;
  playoffQualifier: boolean;
  currentManager: boolean;
}

export interface LeagueStandingsShareCardData {
  leagueName: string;
  periodLabel: string;
  totalTeams: number;
  playoffTeamCount: number;
  rows: readonly LeagueStandingsShareRow[];
}

const STANDINGS_ROW_DISPLAY_LIMIT = 8;

function normalizeRecord(value: string): string {
  const normalized = normalizeLeagueShareText(value, 18, '0-0-0');
  return /^\d{1,3}-\d{1,3}-\d{1,3}$/.test(normalized) ? normalized : '0-0-0';
}

export function normalizeLeagueStandingsShareCardData(
  source: LeagueStandingsShareCardData,
): LeagueStandingsShareCardData {
  const totalTeams = boundedInteger(source.totalTeams, 2, 32, 2);
  const playoffTeamCount = boundedInteger(
    source.playoffTeamCount,
    1,
    totalTeams,
    Math.min(totalTeams, 4),
  );
  const seenRanks = new Set<number>();
  const rows = source.rows
    .map((row) => ({
      rank: boundedInteger(row.rank, 1, totalTeams, 1),
      teamName: normalizeLeagueShareText(row.teamName, 48, DEFAULT_TEAM_NAME),
      record: normalizeRecord(row.record),
      pointsFor: Number.isFinite(row.pointsFor) ? row.pointsFor : 0,
      pointDifferential: Number.isFinite(row.pointDifferential)
        ? row.pointDifferential
        : 0,
      playoffQualifier: Boolean(row.playoffQualifier),
      currentManager: Boolean(row.currentManager),
    }))
    .filter((row) => {
      if (seenRanks.has(row.rank)) {
        return false;
      }
      seenRanks.add(row.rank);
      return true;
    })
    .sort((first, second) => first.rank - second.rank)
    .slice(0, STANDINGS_ROW_DISPLAY_LIMIT);

  return {
    leagueName: normalizeLeagueShareText(source.leagueName, 72, DEFAULT_LEAGUE_NAME),
    periodLabel: normalizeLeagueShareText(source.periodLabel, 44, 'Current standings'),
    totalTeams,
    playoffTeamCount,
    rows,
  };
}

export function buildLeagueStandingsShareText(
  source: LeagueStandingsShareCardData,
): string {
  const data = normalizeLeagueStandingsShareCardData(source);
  const leaders = data.rows
    .slice(0, 5)
    .map((row) => `${row.rank}. ${row.teamName} (${row.record})`)
    .join(', ');

  return `${data.leagueName} standings — ${data.periodLabel}.\n${leaders || 'Standings are ready.'}\n${LEAGUE_SHARE_SITE_URL}`;
}

export function buildLeagueStandingsShareFilename(
  source: LeagueStandingsShareCardData,
): string {
  const data = normalizeLeagueStandingsShareCardData(source);
  return `${slugifyLeagueShareValue(data.leagueName, 'rinkrat-league')}-standings-rinkrat.png`;
}
