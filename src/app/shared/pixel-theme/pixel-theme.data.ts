export interface PixelLogoItem {
  abbreviation: string;
  logoUrl: string;
}

const NHL_TEAM_ABBREVIATIONS = [
  'ANA','BOS','BUF','CGY','CAR','CHI','COL','CBJ','DAL','DET','EDM','FLA','LAK','MIN','MTL','NSH',
  'NJD','NYI','NYR','OTT','PHI','PIT','SEA','SJS','STL','TBL','TOR','UTA','VAN','VGK','WSH','WPG',
];

export function getNhlLogoUrl(abbreviation: string): string {
  return `https://assets.nhle.com/logos/nhl/svg/${abbreviation}_light.svg`;
}

export function buildPixelMarquee(offset = 0): PixelLogoItem[] {
  const rotated = NHL_TEAM_ABBREVIATIONS.map((_, index) => NHL_TEAM_ABBREVIATIONS[(index + offset) % NHL_TEAM_ABBREVIATIONS.length]);
  const sequence = [...rotated, ...rotated.slice(0, 16)];
  return sequence.map((abbreviation) => ({
    abbreviation,
    logoUrl: getNhlLogoUrl(abbreviation),
  }));
}
