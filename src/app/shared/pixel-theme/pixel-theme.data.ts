export interface PixelLogoItem {
  abbreviation: string;
  logoUrl: string;
}

export interface PixelTeamTheme extends PixelLogoItem {
  name: string;
  primaryColor: string;
  secondaryColor: string;
  highlightColor: string;
}

export const NHL_PIXEL_TEAMS: PixelTeamTheme[] = [
  {
    abbreviation: 'ANA',
    name: 'Anaheim Ducks',
    primaryColor: '#fc4c02',
    secondaryColor: '#1b1b1b',
    highlightColor: '#f5c242',
    logoUrl: getNhlLogoUrl('ANA'),
  },
  {
    abbreviation: 'BOS',
    name: 'Boston Bruins',
    primaryColor: '#ffb81c',
    secondaryColor: '#111111',
    highlightColor: '#fff1b8',
    logoUrl: getNhlLogoUrl('BOS'),
  },
  {
    abbreviation: 'BUF',
    name: 'Buffalo Sabres',
    primaryColor: '#2f76c7',
    secondaryColor: '#ffb81c',
    highlightColor: '#d9ebff',
    logoUrl: getNhlLogoUrl('BUF'),
  },
  {
    abbreviation: 'CGY',
    name: 'Calgary Flames',
    primaryColor: '#d62732',
    secondaryColor: '#f1b434',
    highlightColor: '#ffe9a6',
    logoUrl: getNhlLogoUrl('CGY'),
  },
  {
    abbreviation: 'CAR',
    name: 'Carolina Hurricanes',
    primaryColor: '#e03a3e',
    secondaryColor: '#20252d',
    highlightColor: '#ffd0d2',
    logoUrl: getNhlLogoUrl('CAR'),
  },
  {
    abbreviation: 'CHI',
    name: 'Chicago Blackhawks',
    primaryColor: '#cf0a2c',
    secondaryColor: '#111111',
    highlightColor: '#ffd0d8',
    logoUrl: getNhlLogoUrl('CHI'),
  },
  {
    abbreviation: 'COL',
    name: 'Colorado Avalanche',
    primaryColor: '#8a244b',
    secondaryColor: '#3c7bb6',
    highlightColor: '#d8eaff',
    logoUrl: getNhlLogoUrl('COL'),
  },
  {
    abbreviation: 'CBJ',
    name: 'Columbus Blue Jackets',
    primaryColor: '#244d85',
    secondaryColor: '#ce2131',
    highlightColor: '#d7e8ff',
    logoUrl: getNhlLogoUrl('CBJ'),
  },
  {
    abbreviation: 'DAL',
    name: 'Dallas Stars',
    primaryColor: '#0f8b5f',
    secondaryColor: '#1b2427',
    highlightColor: '#c5f3df',
    logoUrl: getNhlLogoUrl('DAL'),
  },
  {
    abbreviation: 'DET',
    name: 'Detroit Red Wings',
    primaryColor: '#ce1126',
    secondaryColor: '#f5f5f5',
    highlightColor: '#ffd3d8',
    logoUrl: getNhlLogoUrl('DET'),
  },
  {
    abbreviation: 'EDM',
    name: 'Edmonton Oilers',
    primaryColor: '#ff5b20',
    secondaryColor: '#1d4f91',
    highlightColor: '#ffd5c4',
    logoUrl: getNhlLogoUrl('EDM'),
  },
  {
    abbreviation: 'FLA',
    name: 'Florida Panthers',
    primaryColor: '#c8102e',
    secondaryColor: '#d6b76e',
    highlightColor: '#fff0bd',
    logoUrl: getNhlLogoUrl('FLA'),
  },
  {
    abbreviation: 'LAK',
    name: 'Los Angeles Kings',
    primaryColor: '#a7b1bd',
    secondaryColor: '#151515',
    highlightColor: '#eef5ff',
    logoUrl: getNhlLogoUrl('LAK'),
  },
  {
    abbreviation: 'MIN',
    name: 'Minnesota Wild',
    primaryColor: '#1d5b3a',
    secondaryColor: '#c52d37',
    highlightColor: '#d8f5e7',
    logoUrl: getNhlLogoUrl('MIN'),
  },
  {
    abbreviation: 'MTL',
    name: 'Montreal Canadiens',
    primaryColor: '#d9233f',
    secondaryColor: '#2455a4',
    highlightColor: '#dbe8ff',
    logoUrl: getNhlLogoUrl('MTL'),
  },
  {
    abbreviation: 'NSH',
    name: 'Nashville Predators',
    primaryColor: '#ffcc35',
    secondaryColor: '#18375e',
    highlightColor: '#fff2af',
    logoUrl: getNhlLogoUrl('NSH'),
  },
  {
    abbreviation: 'NJD',
    name: 'New Jersey Devils',
    primaryColor: '#ce1126',
    secondaryColor: '#1b1b1b',
    highlightColor: '#ffd1d7',
    logoUrl: getNhlLogoUrl('NJD'),
  },
  {
    abbreviation: 'NYI',
    name: 'New York Islanders',
    primaryColor: '#f47b20',
    secondaryColor: '#2456a6',
    highlightColor: '#ffd6b8',
    logoUrl: getNhlLogoUrl('NYI'),
  },
  {
    abbreviation: 'NYR',
    name: 'New York Rangers',
    primaryColor: '#2d64bd',
    secondaryColor: '#d9223f',
    highlightColor: '#dceaff',
    logoUrl: getNhlLogoUrl('NYR'),
  },
  {
    abbreviation: 'OTT',
    name: 'Ottawa Senators',
    primaryColor: '#c61d34',
    secondaryColor: '#c9a65a',
    highlightColor: '#ffe9ae',
    logoUrl: getNhlLogoUrl('OTT'),
  },
  {
    abbreviation: 'PHI',
    name: 'Philadelphia Flyers',
    primaryColor: '#f34a19',
    secondaryColor: '#1b1b1b',
    highlightColor: '#ffd2c4',
    logoUrl: getNhlLogoUrl('PHI'),
  },
  {
    abbreviation: 'PIT',
    name: 'Pittsburgh Penguins',
    primaryColor: '#fcb514',
    secondaryColor: '#151515',
    highlightColor: '#fff0a8',
    logoUrl: getNhlLogoUrl('PIT'),
  },
  {
    abbreviation: 'SEA',
    name: 'Seattle Kraken',
    primaryColor: '#55c3d9',
    secondaryColor: '#17364f',
    highlightColor: '#d5f8ff',
    logoUrl: getNhlLogoUrl('SEA'),
  },
  {
    abbreviation: 'SJS',
    name: 'San Jose Sharks',
    primaryColor: '#0f8b8d',
    secondaryColor: '#ee6c2c',
    highlightColor: '#caf5f3',
    logoUrl: getNhlLogoUrl('SJS'),
  },
  {
    abbreviation: 'STL',
    name: 'St. Louis Blues',
    primaryColor: '#2877c7',
    secondaryColor: '#f7c948',
    highlightColor: '#dcecff',
    logoUrl: getNhlLogoUrl('STL'),
  },
  {
    abbreviation: 'TBL',
    name: 'Tampa Bay Lightning',
    primaryColor: '#2b6ec2',
    secondaryColor: '#f5f7fa',
    highlightColor: '#d9ebff',
    logoUrl: getNhlLogoUrl('TBL'),
  },
  {
    abbreviation: 'TOR',
    name: 'Toronto Maple Leafs',
    primaryColor: '#2864ae',
    secondaryColor: '#f5f7fa',
    highlightColor: '#dcecff',
    logoUrl: getNhlLogoUrl('TOR'),
  },
  {
    abbreviation: 'UTA',
    name: 'Utah',
    primaryColor: '#6ed6ee',
    secondaryColor: '#242b35',
    highlightColor: '#d9f9ff',
    logoUrl: getNhlLogoUrl('UTA'),
  },
  {
    abbreviation: 'VAN',
    name: 'Vancouver Canucks',
    primaryColor: '#2a6cb5',
    secondaryColor: '#1d6b45',
    highlightColor: '#dcecff',
    logoUrl: getNhlLogoUrl('VAN'),
  },
  {
    abbreviation: 'VGK',
    name: 'Vegas Golden Knights',
    primaryColor: '#b99b52',
    secondaryColor: '#333f48',
    highlightColor: '#fff0b8',
    logoUrl: getNhlLogoUrl('VGK'),
  },
  {
    abbreviation: 'WSH',
    name: 'Washington Capitals',
    primaryColor: '#d3273d',
    secondaryColor: '#25569e',
    highlightColor: '#ffd7dd',
    logoUrl: getNhlLogoUrl('WSH'),
  },
  {
    abbreviation: 'WPG',
    name: 'Winnipeg Jets',
    primaryColor: '#2d6da9',
    secondaryColor: '#8d2338',
    highlightColor: '#dcecff',
    logoUrl: getNhlLogoUrl('WPG'),
  },
];

const NHL_TEAM_ABBREVIATIONS = NHL_PIXEL_TEAMS.map((team) => team.abbreviation);

export function getNhlLogoUrl(abbreviation: string): string {
  return `https://assets.nhle.com/logos/nhl/svg/${abbreviation}_light.svg`;
}

export function getPixelTeamTheme(abbreviation: string | null | undefined): PixelTeamTheme {
  return (
    NHL_PIXEL_TEAMS.find((team) => team.abbreviation === abbreviation) ??
    NHL_PIXEL_TEAMS.find((team) => team.abbreviation === 'VGK')!
  );
}

export function buildPixelMarquee(offset = 0): PixelLogoItem[] {
  const rotated = NHL_TEAM_ABBREVIATIONS.map(
    (_, index) => NHL_TEAM_ABBREVIATIONS[(index + offset) % NHL_TEAM_ABBREVIATIONS.length],
  );
  const sequence = [...rotated, ...rotated.slice(0, 16)];
  return sequence.map((abbreviation) => ({
    abbreviation,
    logoUrl: getNhlLogoUrl(abbreviation),
  }));
}
