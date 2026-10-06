export interface MobileLeagueRouteContext {
  leagueId: string;
  cycleNumber: number | null;
}

function decodeRouteSegment(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return '';
  }
}

export function getMobileLeagueRouteContext(rawUrl: string): MobileLeagueRouteContext | null {
  const path = rawUrl.split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter(Boolean);

  if (segments[0] !== 'leagues') {
    return null;
  }

  const leagueId = decodeRouteSegment(segments[1] ?? '');

  if (!leagueId || leagueId === 'create' || leagueId === 'join') {
    return null;
  }

  const rawCycleNumber = segments[2] === 'cycles' ? segments[3] ?? '' : '';
  const parsedCycleNumber = /^\d+$/.test(rawCycleNumber)
    ? Number(rawCycleNumber)
    : null;

  return {
    leagueId,
    cycleNumber:
      parsedCycleNumber !== null && Number.isSafeInteger(parsedCycleNumber) && parsedCycleNumber > 0
        ? parsedCycleNumber
        : null,
  };
}

export function isMobileMatchupRoute(rawUrl: string, leagueId: string): boolean {
  const context = getMobileLeagueRouteContext(rawUrl);
  return context?.leagueId === leagueId && context.cycleNumber !== null;
}

export function isMobileTeamRoute(rawUrl: string, leagueId: string): boolean {
  const path = rawUrl.split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const routeLeagueId = decodeRouteSegment(segments[1] ?? '');

  return segments[0] === 'leagues' &&
    routeLeagueId === leagueId &&
    segments[2] === 'team' &&
    segments.length === 3;
}
