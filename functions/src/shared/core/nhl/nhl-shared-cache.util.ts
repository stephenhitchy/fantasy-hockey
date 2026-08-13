import { createHash } from 'node:crypto';

export const NHL_SHARED_CACHE_MAX_PAYLOAD_BYTES = 700 * 1024;

const ALLOWED_NHL_SHARED_CACHE_ORIGINS = new Set([
  'https://api-web.nhle.com',
  'https://api.nhle.com',
  'https://site.api.espn.com',
]);

export type NhlSharedCacheRouteClass =
  | 'schedule'
  | 'game-boxscore'
  | 'game-play-by-play'
  | 'player-log'
  | 'stats'
  | 'roster'
  | 'scoreboard'
  | 'injuries';

export interface NormalizedNhlSharedCacheRequest {
  cacheKey: string;
  canonicalUrl: string;
  canonicalPath: string;
  canonicalQueryHash: string | null;
  routeClass: NhlSharedCacheRouteClass;
  retentionMilliseconds: number;
  freshnessMilliseconds: number;
}

export interface SerializedNhlSharedCachePayload {
  json: string;
  bytes: number;
  contentHash: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function classifyNhlSharedCacheRoute(
  url: URL,
): NhlSharedCacheRouteClass | null {
  const path = url.pathname;

  if (
    url.origin === 'https://site.api.espn.com' &&
    path === '/apis/site/v2/sports/hockey/nhl/injuries'
  ) {
    return 'injuries';
  }

  if (/^\/v1\/club-schedule-season\/[a-z]{3}\/\d{8}$/.test(path)) {
    return 'schedule';
  }

  if (/^\/v1\/gamecenter\/\d+\/boxscore$/.test(path)) {
    return 'game-boxscore';
  }

  if (/^\/v1\/gamecenter\/\d+\/play-by-play$/.test(path)) {
    return 'game-play-by-play';
  }

  if (/^\/v1\/player\/\d+\/game-log\/\d{8}\/2$/.test(path)) {
    return 'player-log';
  }

  if (/^\/v1\/roster\/[a-z]{3}\/(current|\d{8})$/.test(path)) {
    return 'roster';
  }

  if (path === '/v1/score/now') {
    return 'scoreboard';
  }

  if (
    url.origin === 'https://api.nhle.com' &&
    /^\/stats\/rest\/en\/(skater|goalie)\//.test(path)
  ) {
    return 'stats';
  }

  return null;
}

export function getNhlSharedCacheRoutePolicy(
  routeClass: NhlSharedCacheRouteClass,
): { retentionMilliseconds: number; freshnessMilliseconds: number } {
  const day = 24 * 60 * 60 * 1000;

  switch (routeClass) {
    case 'game-boxscore':
    case 'game-play-by-play':
      return {
        retentionMilliseconds: 30 * day,
        freshnessMilliseconds: 2 * 60 * 1000,
      };

    case 'schedule':
      return {
        retentionMilliseconds: 14 * day,
        freshnessMilliseconds: 10 * 60 * 1000,
      };

    case 'player-log':
    case 'roster':
      return {
        retentionMilliseconds: 7 * day,
        freshnessMilliseconds: 15 * 60 * 1000,
      };

    case 'stats':
      return {
        retentionMilliseconds: 2 * day,
        freshnessMilliseconds: 5 * 60 * 1000,
      };

    case 'injuries':
      return {
        retentionMilliseconds: 2 * day,
        freshnessMilliseconds: 15 * 60 * 1000,
      };

    case 'scoreboard':
      return {
        retentionMilliseconds: day,
        freshnessMilliseconds: 20 * 1000,
      };
  }
}

export function normalizeNhlSharedCacheUrl(
  rawUrl: string,
): NormalizedNhlSharedCacheRequest | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!ALLOWED_NHL_SHARED_CACHE_ORIGINS.has(url.origin.toLowerCase())) {
    return null;
  }

  url.hash = '';
  url.searchParams.sort();

  const routeClass = classifyNhlSharedCacheRoute(url);

  if (!routeClass) {
    return null;
  }

  const canonicalUrl = url.toString();
  const query = url.searchParams.toString();
  const policy = getNhlSharedCacheRoutePolicy(routeClass);

  return {
    cacheKey: sha256(canonicalUrl),
    canonicalUrl,
    canonicalPath: url.pathname.slice(0, 500),
    canonicalQueryHash: query ? sha256(query) : null,
    routeClass,
    retentionMilliseconds: policy.retentionMilliseconds,
    freshnessMilliseconds: policy.freshnessMilliseconds,
  };
}

export function serializeNhlSharedCachePayload(
  payload: unknown,
): SerializedNhlSharedCachePayload | null {
  let json: string;

  try {
    if (Buffer.isBuffer(payload)) {
      json = payload.toString('utf8');
      JSON.parse(json);
    } else if (typeof payload === 'string') {
      json = payload;
      JSON.parse(json);
    } else {
      const serialized = JSON.stringify(payload);

      if (typeof serialized !== 'string') {
        return null;
      }

      json = serialized;
    }
  } catch {
    return null;
  }

  const bytes = Buffer.byteLength(json, 'utf8');

  return {
    json,
    bytes,
    contentHash: sha256(Buffer.from(json, 'utf8')),
  };
}

export function getNhlSharedCacheDescriptor(rawUrl: string): {
  cacheKey: string;
  routeClass: NhlSharedCacheRouteClass;
  canonicalPath: string;
  canonicalQueryHash: string | null;
} | null {
  const normalized = normalizeNhlSharedCacheUrl(rawUrl);

  return normalized
    ? {
        cacheKey: normalized.cacheKey,
        routeClass: normalized.routeClass,
        canonicalPath: normalized.canonicalPath,
        canonicalQueryHash: normalized.canonicalQueryHash,
      }
    : null;
}
