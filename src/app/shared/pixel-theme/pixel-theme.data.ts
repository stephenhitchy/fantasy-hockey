export interface PixelLogoItem {
  abbreviation: string;
  logoUrl: string;
}

interface PixelTeamPalette extends PixelLogoItem {
  name: string;
  primaryColor: string;
  secondaryColor: string;
  tertiaryColor: string;
}

export interface PixelTeamTheme extends PixelTeamPalette {
  /** A visible team color for borders and focus states on the dark app canvas. */
  accentColor: string;
  /** Legacy alias retained for older page components. */
  highlightColor: string;
  primaryTextColor: string;
  secondaryTextColor: string;
  tertiaryTextColor: string;
}

const DARK_APP_SURFACE = '#0d1520';

const NHL_TEAM_PALETTES: PixelTeamPalette[] = [
  team('ANA', 'Anaheim Ducks', '#FC4C02', '#B9975B', '#000000'),
  team('BOS', 'Boston Bruins', '#000000', '#FFB81C', '#FFFFFF'),
  team('BUF', 'Buffalo Sabres', '#002654', '#FFB81C', '#FFFFFF'),
  team('CGY', 'Calgary Flames', '#C8102E', '#F1BE48', '#FFFFFF'),
  team('CAR', 'Carolina Hurricanes', '#CC0000', '#000000', '#A2AAAD'),
  team('CHI', 'Chicago Blackhawks', '#CF0A2C', '#000000', '#FFFFFF'),
  team('COL', 'Colorado Avalanche', '#6F263D', '#236192', '#A2AAAD'),
  team('CBJ', 'Columbus Blue Jackets', '#041E42', '#CE1126', '#A2AAAD'),
  team('DAL', 'Dallas Stars', '#006847', '#111111', '#8F8F8C'),
  team('DET', 'Detroit Red Wings', '#CE1126', '#FFFFFF', '#111111'),
  team('EDM', 'Edmonton Oilers', '#041E42', '#FF4C00', '#FFFFFF'),
  team('FLA', 'Florida Panthers', '#C8102E', '#041E42', '#B9975B'),
  team('LAK', 'Los Angeles Kings', '#111111', '#A2AAAD', '#FFFFFF'),
  team('MIN', 'Minnesota Wild', '#154734', '#A6192E', '#EAAA00'),
  team('MTL', 'Montreal Canadiens', '#AF1E2D', '#192168', '#FFFFFF'),
  team('NSH', 'Nashville Predators', '#FFB81C', '#041E42', '#FFFFFF'),
  team('NJD', 'New Jersey Devils', '#CE1126', '#000000', '#FFFFFF'),
  team('NYI', 'New York Islanders', '#00539B', '#F47D30', '#FFFFFF'),
  team('NYR', 'New York Rangers', '#0038A8', '#CE1126', '#FFFFFF'),
  team('OTT', 'Ottawa Senators', '#000000', '#C8102E', '#C69214'),
  team('PHI', 'Philadelphia Flyers', '#F74902', '#000000', '#FFFFFF'),
  team('PIT', 'Pittsburgh Penguins', '#000000', '#FCB514', '#FFFFFF'),
  team('SEA', 'Seattle Kraken', '#001628', '#99D9D9', '#E9072B'),
  team('SJS', 'San Jose Sharks', '#006D75', '#000000', '#EA7200'),
  team('STL', 'St. Louis Blues', '#00529B', '#FFB81C', '#FFFFFF'),
  team('TBL', 'Tampa Bay Lightning', '#002868', '#FFFFFF', '#111111'),
  team('TOR', 'Toronto Maple Leafs', '#003E7E', '#FFFFFF', '#A2AAAD'),
  team('UTA', 'Utah Mammoth', '#010101', '#69B3E7', '#FFFFFF'),
  team('VAN', 'Vancouver Canucks', '#00205B', '#00843D', '#FFFFFF'),
  team('VGK', 'Vegas Golden Knights', '#B9975B', '#333F42', '#C8102E'),
  team('WSH', 'Washington Capitals', '#C8102E', '#041E42', '#FFFFFF'),
  team('WPG', 'Winnipeg Jets', '#041E42', '#004C97', '#AC162C'),
];

export const NHL_PIXEL_TEAMS: PixelTeamTheme[] = NHL_TEAM_PALETTES.map((palette) => {
  const accentColor = chooseVisibleAccent([
    palette.primaryColor,
    palette.secondaryColor,
    palette.tertiaryColor,
  ]);

  return {
    ...palette,
    accentColor,
    highlightColor: accentColor,
    primaryTextColor: getReadableTextColor(palette.primaryColor),
    secondaryTextColor: getReadableTextColor(palette.secondaryColor),
    tertiaryTextColor: getReadableTextColor(palette.tertiaryColor),
  };
});

const NHL_TEAM_ABBREVIATIONS = NHL_PIXEL_TEAMS.map((teamTheme) => teamTheme.abbreviation);

function team(
  abbreviation: string,
  name: string,
  primaryColor: string,
  secondaryColor: string,
  tertiaryColor: string,
): PixelTeamPalette {
  return {
    abbreviation,
    name,
    primaryColor,
    secondaryColor,
    tertiaryColor,
    logoUrl: getNhlLogoUrl(abbreviation),
  };
}

function normalizeHex(hexColor: string): string {
  const normalized = hexColor.trim().replace('#', '');

  if (/^[0-9a-f]{3}$/i.test(normalized)) {
    return normalized
      .split('')
      .map((character) => `${character}${character}`)
      .join('');
  }

  return /^[0-9a-f]{6}$/i.test(normalized) ? normalized : '000000';
}

function hexToRgb(hexColor: string): [number, number, number] {
  const normalized = normalizeHex(hexColor);

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function relativeLuminance(hexColor: string): number {
  const [red, green, blue] = hexToRgb(hexColor).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function getContrastRatio(firstColor: string, secondColor: string): number {
  const firstLuminance = relativeLuminance(firstColor);
  const secondLuminance = relativeLuminance(secondColor);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

export function getReadableTextColor(backgroundColor: string): string {
  return getContrastRatio(backgroundColor, '#FFFFFF') >=
    getContrastRatio(backgroundColor, '#07111D')
    ? '#FFFFFF'
    : '#07111D';
}

function chooseVisibleAccent(colors: string[]): string {
  const identityColor = colors.find(
    (color) => getContrastRatio(color, DARK_APP_SURFACE) >= 3,
  );

  if (identityColor) {
    return identityColor;
  }

  return [...colors].sort(
    (first, second) =>
      getContrastRatio(second, DARK_APP_SURFACE) -
      getContrastRatio(first, DARK_APP_SURFACE),
  )[0];
}

export function hexToRgba(hexColor: string, alpha: number): string {
  const [red, green, blue] = hexToRgb(hexColor);
  const safeAlpha = Math.max(0, Math.min(1, alpha));

  return `rgba(${red}, ${green}, ${blue}, ${safeAlpha})`;
}

export function getNhlLogoUrl(abbreviation: string): string {
  return `https://assets.nhle.com/logos/nhl/svg/${abbreviation}_light.svg`;
}

export function getPixelTeamTheme(abbreviation: string | null | undefined): PixelTeamTheme {
  return (
    NHL_PIXEL_TEAMS.find((teamTheme) => teamTheme.abbreviation === abbreviation) ??
    NHL_PIXEL_TEAMS.find((teamTheme) => teamTheme.abbreviation === 'VGK')!
  );
}

export function buildPixelMarquee(offset = 0): PixelLogoItem[] {
  const visibleTeamCount = Math.min(16, NHL_TEAM_ABBREVIATIONS.length);
  const sequence = Array.from(
    { length: visibleTeamCount },
    (_, index) => NHL_TEAM_ABBREVIATIONS[(index + offset) % NHL_TEAM_ABBREVIATIONS.length],
  );

  // Duplicate the same sequence so translateX(-50%) loops seamlessly while
  // keeping the number of mobile DOM nodes and logo requests much smaller.
  return [...sequence, ...sequence].map((abbreviation) => ({
    abbreviation,
    logoUrl: getNhlLogoUrl(abbreviation),
  }));
}

/**
 * Builds one seamless marquee containing every NHL team exactly once per pass.
 * The sequence is duplicated so the shared layout can loop continuously.
 */
export function buildFullPixelMarquee(): PixelLogoItem[] {
  return [...NHL_TEAM_ABBREVIATIONS, ...NHL_TEAM_ABBREVIATIONS].map((abbreviation) => ({
    abbreviation,
    logoUrl: getNhlLogoUrl(abbreviation),
  }));
}
