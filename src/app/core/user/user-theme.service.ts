import { UserProfile } from './user.service';
import { getPixelTeamTheme } from '../../shared/pixel-theme/pixel-theme.data';

const THEME_STORAGE_KEY = 'fantasy-hockey-user-theme';
const LAST_LEAGUE_STORAGE_KEY = 'fantasy-hockey-last-league';

export interface StoredUserTheme {
  favoriteTeamAbbreviation: string;
  reducedMotion: boolean;
  defaultLandingPage: 'dashboard' | 'lastLeague';
}

function getDocumentRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

export function applyUserTheme(theme: Partial<StoredUserTheme> | UserProfile | null): void {
  const favoriteTeamAbbreviation = theme?.favoriteTeamAbbreviation || 'VGK';
  const reducedMotion = Boolean(theme?.reducedMotion);
  const defaultLandingPage =
    theme?.defaultLandingPage === 'lastLeague' ? 'lastLeague' : 'dashboard';
  const team = getPixelTeamTheme(favoriteTeamAbbreviation);
  const root = getDocumentRoot();

  if (root) {
    root.style.setProperty('--user-team-primary', team.primaryColor);
    root.style.setProperty('--user-team-secondary', team.secondaryColor);
    root.style.setProperty('--user-team-highlight', team.highlightColor);
    root.style.setProperty(
      '--user-team-outline',
      `color-mix(in srgb, ${team.primaryColor} 72%, #37557b)`,
    );
    root.style.setProperty(
      '--user-team-subtext',
      `color-mix(in srgb, ${team.highlightColor} 68%, #8ea9c7)`,
    );
    root.style.setProperty(
      '--user-team-glow',
      `color-mix(in srgb, ${team.primaryColor} 28%, transparent)`,
    );
    root.dataset['favoriteTeam'] = team.abbreviation;
    root.dataset['reducedMotion'] = reducedMotion ? 'true' : 'false';
  }

  if (typeof localStorage !== 'undefined') {
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
