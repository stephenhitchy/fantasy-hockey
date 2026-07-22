import type { UserProfile } from './user.service';
import {
  getPixelTeamTheme,
  hexToRgba,
} from '../../shared/pixel-theme/pixel-theme.data';

const THEME_STORAGE_KEY = 'fantasy-hockey-user-theme';
const LAST_LEAGUE_STORAGE_KEY = 'fantasy-hockey-last-league';

export interface StoredUserTheme {
  favoriteTeamAbbreviation: string;
  reducedMotion: boolean;
  defaultLandingPage: 'dashboard' | 'lastLeague';
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
  }

  if (options.persist !== false && typeof localStorage !== 'undefined') {
    const stored: StoredUserTheme = {
      favoriteTeamAbbreviation: team.abbreviation,
      reducedMotion,
      defaultLandingPage,
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
    };
  }

  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredUserTheme>) : null;

    return {
      favoriteTeamAbbreviation: parsed?.favoriteTeamAbbreviation || 'VGK',
      reducedMotion: Boolean(parsed?.reducedMotion),
      defaultLandingPage: parsed?.defaultLandingPage === 'lastLeague' ? 'lastLeague' : 'dashboard',
    };
  } catch {
    return {
      favoriteTeamAbbreviation: 'VGK',
      reducedMotion: false,
      defaultLandingPage: 'dashboard',
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
