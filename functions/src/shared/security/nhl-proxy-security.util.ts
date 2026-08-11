export type NhlProxyRouteClass =
  | 'scoreboard'
  | 'gamecenter'
  | 'schedule'
  | 'roster'
  | 'player-log'
  | 'stats'
  | 'injuries';

export type NhlProxyAppCheckStatus = 'valid' | 'missing' | 'invalid';

export interface NhlProxyResolvedRequest {
  targetUrl: string;
  targetPathname: string;
  publicPathname: string;
  routeClass: NhlProxyRouteClass;
  maximumResponseBytes: number;
}

export interface NhlProxyResolutionFailure {
  status: 400 | 404;
  message: string;
}

export interface NhlProxyRateLimitPolicy {
  maximumRequestsPerMinute: number;
  routeClass: NhlProxyRouteClass;
  appCheckStatus: NhlProxyAppCheckStatus;
}

const WEB_API_ORIGIN = 'https://api-web.nhle.com';
const STATS_API_ORIGIN = 'https://api.nhle.com';
const ESPN_API_ORIGIN = 'https://site.api.espn.com';

const STATS_ALLOWED_PARAMETERS = [
  'isAggregate',
  'isGame',
  'start',
  'limit',
  'sort',
  'dir',
  'cayenneExp',
] as const;

const REQUIRED_STATS_PARAMETERS = new Set<string>(STATS_ALLOWED_PARAMETERS);
const SEASON_FILTER_PATTERN = /^seasonId=\d{8} and gameTypeId=2$/;
const INTEGER_PATTERN = /^-?\d+$/;

function failure(status: 400 | 404, message: string): NhlProxyResolutionFailure {
  return { status, message };
}

function hasAnySearchParameter(requestUrl: URL): boolean {
  return requestUrl.searchParams.keys().next().done === false;
}

function resolveStatsRequest(
  requestUrl: URL,
  route: 'skater-summary' | 'skater-realtime' | 'goalie-summary',
): NhlProxyResolvedRequest | NhlProxyResolutionFailure {
  const counts = new Map<string, number>();

  for (const [key] of requestUrl.searchParams) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const [key, count] of counts) {
    if (!REQUIRED_STATS_PARAMETERS.has(key)) {
      return failure(400, `The NHL statistics parameter “${key}” is not supported.`);
    }

    if (count !== 1) {
      return failure(400, `The NHL statistics parameter “${key}” must appear exactly once.`);
    }
  }

  for (const key of REQUIRED_STATS_PARAMETERS) {
    if (!counts.has(key)) {
      return failure(400, `The NHL statistics parameter “${key}” is required.`);
    }
  }

  const isAggregate = requestUrl.searchParams.get('isAggregate') ?? '';
  const isGame = requestUrl.searchParams.get('isGame') ?? '';
  const start = requestUrl.searchParams.get('start') ?? '';
  const limit = requestUrl.searchParams.get('limit') ?? '';
  const sort = requestUrl.searchParams.get('sort') ?? '';
  const direction = requestUrl.searchParams.get('dir') ?? '';
  const filter = requestUrl.searchParams.get('cayenneExp') ?? '';

  if (isAggregate !== 'false') {
    return failure(400, 'RinkRat only supports non-aggregate NHL statistics requests.');
  }

  if (isGame !== 'true' && isGame !== 'false') {
    return failure(400, 'The NHL statistics game-detail flag is invalid.');
  }

  if (!INTEGER_PATTERN.test(start)) {
    return failure(400, 'The NHL statistics start offset is invalid.');
  }

  const numericStart = Number(start);
  if (!Number.isSafeInteger(numericStart) || numericStart < 0 || numericStart > 100_000) {
    return failure(400, 'The NHL statistics start offset is outside the supported range.');
  }

  if (!INTEGER_PATTERN.test(limit)) {
    return failure(400, 'The NHL statistics result limit is invalid.');
  }

  const numericLimit = Number(limit);
  if (
    !Number.isSafeInteger(numericLimit) ||
    (numericLimit !== -1 && (numericLimit < 1 || numericLimit > 5_000))
  ) {
    return failure(400, 'The NHL statistics result limit is outside the supported range.');
  }

  if (direction !== 'asc' && direction !== 'desc') {
    return failure(400, 'The NHL statistics sort direction is invalid.');
  }

  if (!SEASON_FILTER_PATTERN.test(filter)) {
    return failure(400, 'The NHL statistics season filter is invalid.');
  }

  const allowedSorts = route === 'skater-summary'
    ? new Set(['points', 'gameId'])
    : route === 'skater-realtime'
      ? new Set(['hits', 'gameId'])
      : new Set(['wins', 'gameId']);

  if (!allowedSorts.has(sort)) {
    return failure(400, 'The requested NHL statistics sort is not supported for this report.');
  }

  const canonicalQuery = new URLSearchParams();
  for (const key of STATS_ALLOWED_PARAMETERS) {
    canonicalQuery.set(key, requestUrl.searchParams.get(key) ?? '');
  }

  return {
    targetUrl: `${STATS_API_ORIGIN}${requestUrl.pathname}?${canonicalQuery.toString()}`,
    targetPathname: requestUrl.pathname,
    publicPathname: requestUrl.pathname,
    routeClass: 'stats',
    maximumResponseBytes: 24 * 1024 * 1024,
  };
}

export function resolveNhlProxyRequest(
  originalUrl: string,
): NhlProxyResolvedRequest | NhlProxyResolutionFailure {
  let requestUrl: URL;

  try {
    requestUrl = new URL(originalUrl, 'https://rinkrat-fantasy-proxy.local');
  } catch {
    return failure(400, 'The NHL API request URL is invalid.');
  }

  const path = requestUrl.pathname;

  if (path === '/espn/injuries') {
    if (hasAnySearchParameter(requestUrl)) {
      return failure(400, 'The injury-feed route does not accept query parameters.');
    }

    const targetPathname = '/apis/site/v2/sports/hockey/nhl/injuries';
    return {
      targetUrl: `${ESPN_API_ORIGIN}${targetPathname}`,
      targetPathname,
      publicPathname: path,
      routeClass: 'injuries',
      maximumResponseBytes: 8 * 1024 * 1024,
    };
  }

  const playerLogMatch = path.match(/^\/v1\/player\/(\d+)\/game-log\/(\d{8})\/2$/);
  if (playerLogMatch) {
    if (hasAnySearchParameter(requestUrl)) {
      return failure(400, 'The player game-log route does not accept query parameters.');
    }

    return {
      targetUrl: `${WEB_API_ORIGIN}${path}`,
      targetPathname: path,
      publicPathname: path,
      routeClass: 'player-log',
      maximumResponseBytes: 6 * 1024 * 1024,
    };
  }

  if (/^\/v1\/club-schedule-season\/[a-z]{3}\/\d{8}$/.test(path)) {
    if (hasAnySearchParameter(requestUrl)) {
      return failure(400, 'The team schedule route does not accept query parameters.');
    }

    return {
      targetUrl: `${WEB_API_ORIGIN}${path}`,
      targetPathname: path,
      publicPathname: path,
      routeClass: 'schedule',
      maximumResponseBytes: 8 * 1024 * 1024,
    };
  }

  if (/^\/v1\/gamecenter\/\d+\/(boxscore|play-by-play)$/.test(path)) {
    if (hasAnySearchParameter(requestUrl)) {
      return failure(400, 'The gamecenter route does not accept query parameters.');
    }

    return {
      targetUrl: `${WEB_API_ORIGIN}${path}`,
      targetPathname: path,
      publicPathname: path,
      routeClass: 'gamecenter',
      maximumResponseBytes: path.endsWith('/play-by-play')
        ? 16 * 1024 * 1024
        : 8 * 1024 * 1024,
    };
  }

  if (path === '/v1/score/now') {
    if (hasAnySearchParameter(requestUrl)) {
      return failure(400, 'The live scoreboard route does not accept query parameters.');
    }

    return {
      targetUrl: `${WEB_API_ORIGIN}${path}`,
      targetPathname: path,
      publicPathname: path,
      routeClass: 'scoreboard',
      maximumResponseBytes: 6 * 1024 * 1024,
    };
  }

  if (/^\/v1\/roster\/[a-z]{3}\/(current|\d{8})$/.test(path)) {
    if (hasAnySearchParameter(requestUrl)) {
      return failure(400, 'The NHL roster route does not accept query parameters.');
    }

    return {
      targetUrl: `${WEB_API_ORIGIN}${path}`,
      targetPathname: path,
      publicPathname: path,
      routeClass: 'roster',
      maximumResponseBytes: 8 * 1024 * 1024,
    };
  }

  if (path === '/stats/rest/en/skater/summary') {
    return resolveStatsRequest(requestUrl, 'skater-summary');
  }

  if (path === '/stats/rest/en/skater/realtime') {
    return resolveStatsRequest(requestUrl, 'skater-realtime');
  }

  if (path === '/stats/rest/en/goalie/summary') {
    return resolveStatsRequest(requestUrl, 'goalie-summary');
  }

  return failure(404, 'This NHL API route is not available through the app proxy.');
}

export function isNhlProxyResolutionFailure(
  result: NhlProxyResolvedRequest | NhlProxyResolutionFailure,
): result is NhlProxyResolutionFailure {
  return 'status' in result;
}

export function getNhlProxyRateLimitPolicy(
  routeClass: NhlProxyRouteClass,
  appCheckStatus: NhlProxyAppCheckStatus,
): NhlProxyRateLimitPolicy {
  const verifiedLimits: Record<NhlProxyRouteClass, number> = {
    scoreboard: 240,
    gamecenter: 240,
    schedule: 120,
    roster: 120,
    'player-log': 120,
    stats: 30,
    injuries: 20,
  };
  const unverifiedLimits: Record<NhlProxyRouteClass, number> = {
    scoreboard: 60,
    gamecenter: 60,
    schedule: 30,
    roster: 30,
    'player-log': 30,
    stats: 8,
    injuries: 5,
  };

  return {
    maximumRequestsPerMinute:
      appCheckStatus === 'valid'
        ? verifiedLimits[routeClass]
        : unverifiedLimits[routeClass],
    routeClass,
    appCheckStatus,
  };
}
