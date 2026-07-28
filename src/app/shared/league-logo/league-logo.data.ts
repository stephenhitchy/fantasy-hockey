export const LEAGUE_LOGO_IDS = [
  'crossed-sticks',
  'rink-rat',
  'goalie-mask',
  'crown-puck',
  'arcade-net',
  'lightning-skate',
  'helmet-stars',
  'rink-badge',
] as const;

export type LeagueLogoId = (typeof LEAGUE_LOGO_IDS)[number];

export const LEAGUE_LOGO_PALETTE_IDS = [
  'rink-gold',
  'ice-blue',
  'crimson',
  'emerald',
  'violet',
  'retro-orange',
  'neon-arcade',
  'silver',
] as const;

export type LeagueLogoPaletteId = (typeof LEAGUE_LOGO_PALETTE_IDS)[number];

export interface LeagueLogoOption {
  id: LeagueLogoId;
  name: string;
  description: string;
}

export interface LeagueLogoPaletteOption {
  id: LeagueLogoPaletteId;
  name: string;
  primary: string;
  secondary: string;
  accent: string;
}

export const DEFAULT_LEAGUE_LOGO_ID: LeagueLogoId = 'rink-rat';
export const DEFAULT_LEAGUE_LOGO_PALETTE_ID: LeagueLogoPaletteId = 'rink-gold';

export const LEAGUE_LOGO_OPTIONS: readonly LeagueLogoOption[] = [
  {
    id: 'crossed-sticks',
    name: 'Crossed Sticks',
    description: 'A classic puck-and-sticks shield.',
  },
  {
    id: 'rink-rat',
    name: 'Rink Rat',
    description: 'The helmeted rink-rat mascot.',
  },
  {
    id: 'goalie-mask',
    name: 'Crease Guard',
    description: 'A goalie mask built for the crease.',
  },
  {
    id: 'crown-puck',
    name: 'Puck Royalty',
    description: 'A crown-and-puck championship crest.',
  },
  {
    id: 'arcade-net',
    name: 'Arcade Net',
    description: 'Retro controls fused with a hockey goal.',
  },
  {
    id: 'lightning-skate',
    name: 'Breakaway',
    description: 'A lightning-fast skate and puck.',
  },
  {
    id: 'helmet-stars',
    name: 'All-Star Helmet',
    description: 'A sparkling helmet badge with crossed sticks.',
  },
  {
    id: 'rink-badge',
    name: 'Center Ice',
    description: 'A top-down rink and scoreboard emblem.',
  },
] as const;

export const LEAGUE_LOGO_PALETTE_OPTIONS: readonly LeagueLogoPaletteOption[] = [
  {
    id: 'rink-gold',
    name: 'Rink Gold',
    primary: '#e4b83f',
    secondary: '#7ed8ef',
    accent: '#d94747',
  },
  {
    id: 'ice-blue',
    name: 'Ice Blue',
    primary: '#4db8ff',
    secondary: '#b9efff',
    accent: '#ff5a67',
  },
  {
    id: 'crimson',
    name: 'Crimson',
    primary: '#dc354d',
    secondary: '#ff8d7e',
    accent: '#ffd447',
  },
  {
    id: 'emerald',
    name: 'Emerald',
    primary: '#24b777',
    secondary: '#7cf0c8',
    accent: '#ffc857',
  },
  {
    id: 'violet',
    name: 'Violet',
    primary: '#8d5bea',
    secondary: '#c7a8ff',
    accent: '#ff5c9a',
  },
  {
    id: 'retro-orange',
    name: 'Retro Orange',
    primary: '#ee842f',
    secondary: '#ffd166',
    accent: '#4dd6ca',
  },
  {
    id: 'neon-arcade',
    name: 'Neon Arcade',
    primary: '#ff3cac',
    secondary: '#22e6e6',
    accent: '#f8ff4a',
  },
  {
    id: 'silver',
    name: 'Silver',
    primary: '#aeb9c8',
    secondary: '#dbe6f3',
    accent: '#6fa8dc',
  },
] as const;

export function isLeagueLogoId(value: unknown): value is LeagueLogoId {
  return typeof value === 'string' && LEAGUE_LOGO_IDS.includes(value as LeagueLogoId);
}

export function isLeagueLogoPaletteId(value: unknown): value is LeagueLogoPaletteId {
  return (
    typeof value === 'string' &&
    LEAGUE_LOGO_PALETTE_IDS.includes(value as LeagueLogoPaletteId)
  );
}

export function normalizeLeagueLogoId(value: unknown): LeagueLogoId {
  return isLeagueLogoId(value) ? value : DEFAULT_LEAGUE_LOGO_ID;
}

export function normalizeLeagueLogoPaletteId(value: unknown): LeagueLogoPaletteId {
  return isLeagueLogoPaletteId(value) ? value : DEFAULT_LEAGUE_LOGO_PALETTE_ID;
}

export function getLeagueLogoAssetPath(
  logoId: unknown,
  paletteId: unknown,
): string {
  const normalizedLogoId = normalizeLeagueLogoId(logoId);
  const normalizedPaletteId = normalizeLeagueLogoPaletteId(paletteId);

  return `/assets/league-logos/${normalizedLogoId}/${normalizedPaletteId}.png`;
}
