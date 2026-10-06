export type DashboardMatchupViewMode = 'carousel' | 'all';

export interface DashboardMatchupViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DASHBOARD_MATCHUP_VIEW_STORAGE_KEY = 'rinkrat:dashboard-matchup-view:v1';
export const DEFAULT_DASHBOARD_MATCHUP_VIEW: DashboardMatchupViewMode = 'carousel';

export function normalizeDashboardMatchupViewMode(value: unknown): DashboardMatchupViewMode {
  return value === 'all' ? 'all' : DEFAULT_DASHBOARD_MATCHUP_VIEW;
}

export function loadDashboardMatchupViewMode(
  storage: DashboardMatchupViewStorage | null | undefined = getDashboardMatchupViewStorage(),
): DashboardMatchupViewMode {
  if (!storage) {
    return DEFAULT_DASHBOARD_MATCHUP_VIEW;
  }

  try {
    return normalizeDashboardMatchupViewMode(
      storage.getItem(DASHBOARD_MATCHUP_VIEW_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_DASHBOARD_MATCHUP_VIEW;
  }
}

export function saveDashboardMatchupViewMode(
  mode: DashboardMatchupViewMode,
  storage: DashboardMatchupViewStorage | null | undefined = getDashboardMatchupViewStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(DASHBOARD_MATCHUP_VIEW_STORAGE_KEY, mode);
  } catch {
    // Browser storage availability should never block the dashboard.
  }
}

function getDashboardMatchupViewStorage(): DashboardMatchupViewStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function clampDashboardLeagueRailIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) {
    return 0;
  }

  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

export function getDashboardLeagueRailIndex(
  scrollLeft: number,
  cardOffsets: readonly number[],
): number {
  if (cardOffsets.length === 0 || !Number.isFinite(scrollLeft)) {
    return 0;
  }

  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;

  cardOffsets.forEach((offset, index) => {
    const distance = Math.abs(scrollLeft - offset);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });

  return closestIndex;
}
