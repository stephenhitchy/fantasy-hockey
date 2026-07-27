import type { UserProfile } from './user.service';
import {
  getPixelTeamTheme,
  hexToRgba,
} from '../../shared/pixel-theme/pixel-theme.data';

const THEME_STORAGE_KEY = 'fantasy-hockey-user-theme';
const LAST_LEAGUE_STORAGE_KEY = 'fantasy-hockey-last-league';

export type BackgroundTheme = 'rink-dark' | 'oled-black' | 'ice-gray' | 'light-ice';

export interface StoredUserTheme {
  favoriteTeamAbbreviation: string;
  reducedMotion: boolean;
  defaultLandingPage: 'dashboard' | 'lastLeague';
  backgroundTheme: BackgroundTheme;
}

export interface ApplyUserThemeOptions {
  persist?: boolean;
}

function getDocumentRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

export function applyUserTheme(
  theme: Partial<StoredUserTheme> | UserProfile | null,
  options: ApplyUserThemeOptions = {},
): void {
  const favoriteTeamAbbreviation = theme?.favoriteTeamAbbreviation || 'VGK';
  const reducedMotion = Boolean(theme?.reducedMotion);
  const defaultLandingPage =
    theme?.defaultLandingPage === 'lastLeague' ? 'lastLeague' : 'dashboard';
  const backgroundTheme =
    theme?.backgroundTheme === 'oled-black' ||
    theme?.backgroundTheme === 'ice-gray' ||
    theme?.backgroundTheme === 'light-ice'
      ? theme.backgroundTheme
      : 'rink-dark';
  const team = getPixelTeamTheme(favoriteTeamAbbreviation);
  const root = getDocumentRoot();

  if (root) {
    root.style.setProperty('--user-team-primary', team.primaryColor);
    root.style.setProperty('--user-team-secondary', team.secondaryColor);
    root.style.setProperty('--user-team-tertiary', team.tertiaryColor);
    root.style.setProperty('--user-team-accent', team.accentColor);
    root.style.setProperty('--user-team-highlight', team.accentColor);
    root.style.setProperty('--user-team-on-primary', team.primaryTextColor);
    root.style.setProperty('--user-team-on-secondary', team.secondaryTextColor);
    root.style.setProperty('--user-team-on-tertiary', team.tertiaryTextColor);
    root.style.setProperty('--user-team-outline', team.accentColor);
    root.style.setProperty('--user-team-outline-soft', hexToRgba(team.accentColor, 0.28));
    root.style.setProperty('--user-team-subtext', '#B7C4D2');
    root.style.setProperty('--user-team-glow', hexToRgba(team.accentColor, 0.22));
    root.style.setProperty('--user-team-wash', hexToRgba(team.accentColor, 0.09));
    root.style.setProperty('--user-team-primary-wash', hexToRgba(team.primaryColor, 0.12));
    root.style.setProperty('--user-team-secondary-wash', hexToRgba(team.secondaryColor, 0.12));
    root.style.setProperty('--user-team-tertiary-wash', hexToRgba(team.tertiaryColor, 0.12));
    root.dataset['favoriteTeam'] = team.abbreviation;
    root.dataset['reducedMotion'] = reducedMotion ? 'true' : 'false';
    root.dataset['backgroundTheme'] = backgroundTheme;
  }

  if (options.persist !== false && typeof localStorage !== 'undefined') {
    const stored: StoredUserTheme = {
      favoriteTeamAbbreviation: team.abbreviation,
      reducedMotion,
      defaultLandingPage,
      backgroundTheme,
    };

    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(stored));
  }
}

export function loadStoredUserTheme(): StoredUserTheme {
  if (typeof localStorage === 'undefined') {
    return {
      favoriteTeamAbbreviation: 'VGK',
      reducedMotion: false,
      defaultLandingPage: 'dashboard',
      backgroundTheme: 'rink-dark',
    };
  }

  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredUserTheme>) : null;

    return {
      favoriteTeamAbbreviation: parsed?.favoriteTeamAbbreviation || 'VGK',
      reducedMotion: Boolean(parsed?.reducedMotion),
      defaultLandingPage: parsed?.defaultLandingPage === 'lastLeague' ? 'lastLeague' : 'dashboard',
      backgroundTheme:
        parsed?.backgroundTheme === 'oled-black' ||
        parsed?.backgroundTheme === 'ice-gray' ||
        parsed?.backgroundTheme === 'light-ice'
          ? parsed.backgroundTheme
          : 'rink-dark',
    };
  } catch {
    return {
      favoriteTeamAbbreviation: 'VGK',
      reducedMotion: false,
      defaultLandingPage: 'dashboard',
      backgroundTheme: 'rink-dark',
    };
  }
}

export function initializeStoredUserTheme(): void {
  applyUserTheme(loadStoredUserTheme());
}

export function rememberLastLeagueId(leagueId: string): void {
  if (typeof localStorage !== 'undefined' && leagueId) {
    localStorage.setItem(LAST_LEAGUE_STORAGE_KEY, leagueId);
  }
}

export function getRememberedLastLeagueId(): string {
  return typeof localStorage === 'undefined'
    ? ''
    : localStorage.getItem(LAST_LEAGUE_STORAGE_KEY) || '';
}
