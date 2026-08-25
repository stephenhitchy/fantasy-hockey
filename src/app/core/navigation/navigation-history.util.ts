export type NavigationTriggerKind = 'imperative' | 'popstate' | 'hashchange';

export const NAVIGATION_HISTORY_LIMIT = 40;

export function normalizeInternalNavigationUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';

  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('://')) {
    return '';
  }

  return trimmed;
}

export function isInternalNavigationHistoryEligible(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeInternalNavigationUrl(value);

  if (!normalized) {
    return false;
  }

  // League invite codes are short-lived credentials. They should never be
  // copied into persistent navigation history, even session-only storage.
  return !/^\/join(?:\/|$)/i.test(normalized.split(/[?#]/)[0] ?? '');
}

export function recordInternalNavigation(
  history: readonly string[],
  rawUrl: string,
  trigger: NavigationTriggerKind = 'imperative',
): string[] {
  const url = normalizeInternalNavigationUrl(rawUrl);

  if (!url || !isInternalNavigationHistoryEligible(url)) {
    return [...history];
  }

  const normalizedHistory = history
    .map((entry) => normalizeInternalNavigationUrl(entry))
    .filter(
      (entry): entry is string =>
        Boolean(entry) && isInternalNavigationHistoryEligible(entry),
    );

  if (trigger === 'popstate') {
    const existingIndex = normalizedHistory.lastIndexOf(url);

    if (existingIndex >= 0) {
      return normalizedHistory.slice(0, existingIndex + 1);
    }
  }

  if (normalizedHistory.at(-1) === url) {
    return normalizedHistory.slice(-NAVIGATION_HISTORY_LIMIT);
  }

  return [...normalizedHistory, url].slice(-NAVIGATION_HISTORY_LIMIT);
}

export interface PreviousNavigationResolution {
  destination: string;
  remainingHistory: string[];
}

export function resolvePreviousInternalNavigation(
  history: readonly string[],
  currentRawUrl: string,
): PreviousNavigationResolution | null {
  const currentUrl = normalizeInternalNavigationUrl(currentRawUrl);
  const normalizedHistory = history
    .map((entry) => normalizeInternalNavigationUrl(entry))
    .filter(
      (entry): entry is string =>
        Boolean(entry) && isInternalNavigationHistoryEligible(entry),
    );

  if (normalizedHistory.length === 0) {
    return null;
  }

  let currentIndex = normalizedHistory.length - 1;

  if (currentUrl && normalizedHistory[currentIndex] !== currentUrl) {
    const matchingIndex = normalizedHistory.lastIndexOf(currentUrl);
    currentIndex = matchingIndex >= 0 ? matchingIndex : normalizedHistory.length;
  }

  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const destination = normalizedHistory[index] ?? '';

    if (destination && destination !== currentUrl) {
      return {
        destination,
        remainingHistory: normalizedHistory.slice(0, index + 1),
      };
    }
  }

  return null;
}
