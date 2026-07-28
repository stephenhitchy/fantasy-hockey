import type { UserProfile } from './user.service';
import {
  DEFAULT_TEAM_IDENTITY_VARIANT_ID,
  getPixelTeamTheme,
  hexToRgba,
  TeamIdentityUnlockRequirement,
} from '../../shared/pixel-theme/pixel-theme.data';

const THEME_STORAGE_KEY = 'fantasy-hockey-user-theme';
const LAST_LEAGUE_STORAGE_KEY = 'fantasy-hockey-last-league';

export type BackgroundTheme = 'rink-dark' | 'oled-black' | 'ice-gray' | 'light-ice';

export interface StoredUserTheme {
  favoriteTeamAbbreviation: string;
  favoriteTeamVariantId: string;
  teamIdentityUnlocks: TeamIdentityUnlockRequirement[];
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
  const requestedVariantId =
    theme?.favoriteTeamVariantId || DEFAULT_TEAM_IDENTITY_VARIANT_ID;
  const reducedMotion = Boolean(theme?.reducedMotion);
  const defaultLandingPage =
    theme?.defaultLandingPage === 'lastLeague' ? 'lastLeague' : 'dashboard';
  const backgroundTheme =
    theme?.backgroundTheme === 'oled-black' ||
    theme?.backgroundTheme === 'ice-gray' ||
    theme?.backgroundTheme === 'light-ice'
      ? theme.backgroundTheme
      : 'rink-dark';
  const identityUnlocks = Array.isArray(theme?.teamIdentityUnlocks)
    ? theme.teamIdentityUnlocks.filter(
        (value): value is TeamIdentityUnlockRequirement =>
          value === 'first-line-change' ||
          value === 'commissioner-mode' ||
          value === 'league-explorer' ||
          value === 'crowded-schedule',
      )
    : [];
  const requestedTeam = getPixelTeamTheme(favoriteTeamAbbreviation, requestedVariantId);
  const team =
    requestedTeam.unlockRequirement === 'default' ||
    identityUnlocks.includes(requestedTeam.unlockRequirement)
      ? requestedTeam
      : getPixelTeamTheme(favoriteTeamAbbreviation, DEFAULT_TEAM_IDENTITY_VARIANT_ID);
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
    root.dataset['favoriteTeamVariant'] = team.variantId;
    delete root.dataset['profileIcon'];
    root.dataset['reducedMotion'] = reducedMotion ? 'true' : 'false';
    root.dataset['backgroundTheme'] = backgroundTheme;
  }

  if (options.persist !== false && typeof localStorage !== 'undefined') {
    const stored: StoredUserTheme = {
      favoriteTeamAbbreviation: team.abbreviation,
      favoriteTeamVariantId: team.variantId,
      teamIdentityUnlocks: identityUnlocks,
      reducedMotion,
      defaultLandingPage,
      backgroundTheme,
    };

    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(stored));
  }
}

export function loadStoredUserTheme(): StoredUserTheme {
  const fallback: StoredUserTheme = {
    favoriteTeamAbbreviation: 'VGK',
    favoriteTeamVariantId: DEFAULT_TEAM_IDENTITY_VARIANT_ID,
    teamIdentityUnlocks: [],
    reducedMotion: false,
    defaultLandingPage: 'dashboard',
    backgroundTheme: 'rink-dark',
  };

  if (typeof localStorage === 'undefined') {
    return fallback;
  }

  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredUserTheme>) : null;
    const normalizedTeam = getPixelTeamTheme(
      parsed?.favoriteTeamAbbreviation || 'VGK',
      parsed?.favoriteTeamVariantId || DEFAULT_TEAM_IDENTITY_VARIANT_ID,
    );

    const teamIdentityUnlocks = Array.isArray(parsed?.teamIdentityUnlocks)
      ? parsed.teamIdentityUnlocks.filter(
          (value): value is TeamIdentityUnlockRequirement =>
            value === 'first-line-change' ||
            value === 'commissioner-mode' ||
            value === 'league-explorer' ||
            value === 'crowded-schedule',
        )
      : [];
    const unlockedTeam =
      normalizedTeam.unlockRequirement === 'default' ||
      teamIdentityUnlocks.includes(normalizedTeam.unlockRequirement)
        ? normalizedTeam
        : getPixelTeamTheme(
            normalizedTeam.abbreviation,
            DEFAULT_TEAM_IDENTITY_VARIANT_ID,
          );

    return {
      favoriteTeamAbbreviation: unlockedTeam.abbreviation,
      favoriteTeamVariantId: unlockedTeam.variantId,
      teamIdentityUnlocks,
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
    return fallback;
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
