import { createHash, randomUUID } from 'node:crypto';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import {
  DocumentData,
  DocumentReference,
  FieldValue,
  getFirestore,
  Timestamp,
  WriteBatch
} from 'firebase-admin/firestore';

import {
  HttpsError,
  onCall,
  onRequest
} from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { TRUSTED_WEB_ORIGINS } from './web-security';
import {
  requireRecentAuthentication as requireRecentAuthenticationShared,
  requireVerifiedEmail as requireVerifiedEmailShared,
  requireVerifiedRecentAuthentication,
} from './shared/security/auth-security.util';
import {
  optionalFirestoreDocumentId,
  requireFirestoreDocumentId,
  requireFirestoreDocumentIds,
  resolveSafeFirestoreDocumentId,
} from './shared/security/firestore-document-id.util';
import {
  FIRESTORE_AUTH_USER_ID_OPTIONS,
} from './shared/security/firestore-document-id-policies';
import {
  getNhlProxyRateLimitPolicy,
  isNhlProxyResolutionFailure,
  resolveNhlProxyRequest,
  type NhlProxyAppCheckStatus,
  type NhlProxyRouteClass,
} from './shared/security/nhl-proxy-security.util';
import { ESPN_INJURY_PLAYER_ALIASES } from './shared/core/player/injury-player-aliases';
import { matchInjuryEntriesToCurrentPlayers } from './shared/core/player/injury-match-quality.util';
import { queueNhlSharedCacheObservation } from './shared/core/nhl/nhl-shared-cache.service';

if (getApps().length === 0) {
  initializeApp();
}

const db = getFirestore();

const ESPN_NHL_INJURIES_URL =
  'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries';

const NHL_API_BASE_URL = 'https://api-web.nhle.com/v1';
const NHL_PROXY_TIMEOUT_MS = 18_000;
const NHL_PROXY_MAX_ATTEMPTS = 2;
const NHL_PROXY_MAX_CACHE_ENTRIES = 40;
const NHL_PROXY_MAX_CACHE_BYTES = 32 * 1024 * 1024;
const NHL_PROXY_GLOBAL_REQUESTS_PER_MINUTE = 1_200;
const NHL_PROXY_RATE_WINDOW_MILLISECONDS = 60_000;
const NHL_PROXY_APP_CHECK_CACHE_MILLISECONDS = 2 * 60 * 1000;
const NHL_PROXY_HEALTH_FLUSH_MILLISECONDS = 60_000;

interface CachedNhlProxyResponse {
  loadedAt: number;
  status: number;
  contentType: string;
  body: Buffer;
}

interface CachedNhlProxyAppCheckResult {
  status: NhlProxyAppCheckStatus;
  appId: string | null;
  expiresAt: number;
}

interface NhlProxyRateWindow {
  startedAt: number;
  count: number;
  lastSeenAt: number;
}

interface NhlProxySecurityCounters {
  requestCount: number;
  verifiedRequestCount: number;
  missingTokenRequestCount: number;
  invalidTokenRequestCount: number;
  rateLimitedRequestCount: number;
  rejectedQueryRequestCount: number;
  oversizedResponseCount: number;
}

const nhlProxyResponseCache = new Map<string, CachedNhlProxyResponse>();
const nhlProxyAppCheckCache = new Map<string, CachedNhlProxyAppCheckResult>();
const nhlProxyRateWindows = new Map<string, NhlProxyRateWindow>();
let nhlProxyLastHealthFlushAt = 0;
let nhlProxyLastRouteClass: NhlProxyRouteClass | null = null;
let nhlProxyLastSecurityEvent = 'startup';
let nhlProxySecurityCounters: NhlProxySecurityCounters = {
  requestCount: 0,
  verifiedRequestCount: 0,
  missingTokenRequestCount: 0,
  invalidTokenRequestCount: 0,
  rateLimitedRequestCount: 0,
  rejectedQueryRequestCount: 0,
  oversizedResponseCount: 0,
};

class NhlProxyResponseTooLargeError extends Error {
  constructor(readonly maximumBytes: number) {
    super('The upstream NHL response exceeded the RinkRat proxy safety limit.');
    this.name = 'NhlProxyResponseTooLargeError';
  }
}

function getNhlProxyHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? '';
  }

  return typeof value === 'string' ? value.trim() : '';
}

function getNhlProxyRequesterIdentity(request: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const directIp = typeof request.ip === 'string' ? request.ip.trim() : '';
  const forwarded = getNhlProxyHeaderValue(request.headers['x-forwarded-for'])
    .split(',')[0]
    ?.trim() ?? '';
  const rawIdentity = directIp || forwarded || 'unknown-requester';

  return createHash('sha256')
    .update(`rinkrat-nhl-proxy:${rawIdentity}`)
    .digest('hex')
    .slice(0, 24);
}

async function inspectNhlProxyAppCheck(request: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<{ status: NhlProxyAppCheckStatus; appId: string | null }> {
  const token = getNhlProxyHeaderValue(request.headers['x-firebase-appcheck']);

  if (!token) {
    return { status: 'missing', appId: null };
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const cached = nhlProxyAppCheckCache.get(tokenHash);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return { status: cached.status, appId: cached.appId };
  }

  try {
    const decoded = await getAppCheck().verifyToken(token);
    const result: CachedNhlProxyAppCheckResult = {
      status: 'valid',
      appId: decoded.appId,
      expiresAt: now + NHL_PROXY_APP_CHECK_CACHE_MILLISECONDS,
    };
    nhlProxyAppCheckCache.set(tokenHash, result);
    return { status: result.status, appId: result.appId };
  } catch {
    const result: CachedNhlProxyAppCheckResult = {
      status: 'invalid',
      appId: null,
      expiresAt: now + 30_000,
    };
    nhlProxyAppCheckCache.set(tokenHash, result);
    return { status: result.status, appId: result.appId };
  }
}

function pruneNhlProxySecurityCaches(now: number): void {
  if (nhlProxyRateWindows.size > 5_000) {
    for (const [key, value] of nhlProxyRateWindows) {
      if (now - value.lastSeenAt > 2 * NHL_PROXY_RATE_WINDOW_MILLISECONDS) {
        nhlProxyRateWindows.delete(key);
      }
    }
  }

  if (nhlProxyAppCheckCache.size > 1_000) {
    for (const [key, value] of nhlProxyAppCheckCache) {
      if (value.expiresAt <= now) {
        nhlProxyAppCheckCache.delete(key);
      }
    }
  }
}

function consumeNhlProxyRateLimit(
  requesterId: string,
  routeClass: NhlProxyRouteClass,
  appCheckStatus: NhlProxyAppCheckStatus,
): { allowed: boolean; retryAfterSeconds: number; limit: number } {
  const now = Date.now();
  const policy = getNhlProxyRateLimitPolicy(routeClass, appCheckStatus);
  const minuteBucket = Math.floor(now / NHL_PROXY_RATE_WINDOW_MILLISECONDS);
  const requesterKey = `${minuteBucket}:${requesterId}:${routeClass}`;
  const globalKey = `${minuteBucket}:global`;

  const consume = (key: string, maximum: number): { allowed: boolean; retryAfterSeconds: number } => {
    const existing = nhlProxyRateWindows.get(key);
    const windowStartedAt = minuteBucket * NHL_PROXY_RATE_WINDOW_MILLISECONDS;
    const next: NhlProxyRateWindow = existing && existing.startedAt === windowStartedAt
      ? { ...existing, count: existing.count + 1, lastSeenAt: now }
      : { startedAt: windowStartedAt, count: 1, lastSeenAt: now };
    nhlProxyRateWindows.set(key, next);

    return {
      allowed: next.count <= maximum,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowStartedAt + NHL_PROXY_RATE_WINDOW_MILLISECONDS - now) / 1_000),
      ),
    };
  };

  const globalResult = consume(globalKey, NHL_PROXY_GLOBAL_REQUESTS_PER_MINUTE);
  const requesterResult = consume(requesterKey, policy.maximumRequestsPerMinute);
  pruneNhlProxySecurityCaches(now);

  return {
    allowed: globalResult.allowed && requesterResult.allowed,
    retryAfterSeconds: Math.max(
      globalResult.retryAfterSeconds,
      requesterResult.retryAfterSeconds,
    ),
    limit: policy.maximumRequestsPerMinute,
  };
}

function recordNhlProxySecurityObservation(
  event: string,
  routeClass: NhlProxyRouteClass | null,
  appCheckStatus: NhlProxyAppCheckStatus | null,
): void {
  nhlProxySecurityCounters.requestCount += event === 'request' ? 1 : 0;
  nhlProxySecurityCounters.verifiedRequestCount +=
    event === 'request' && appCheckStatus === 'valid' ? 1 : 0;
  nhlProxySecurityCounters.missingTokenRequestCount +=
    event === 'request' && appCheckStatus === 'missing' ? 1 : 0;
  nhlProxySecurityCounters.invalidTokenRequestCount +=
    event === 'request' && appCheckStatus === 'invalid' ? 1 : 0;
  nhlProxySecurityCounters.rateLimitedRequestCount += event === 'rate-limited' ? 1 : 0;
  nhlProxySecurityCounters.rejectedQueryRequestCount += event === 'rejected-query' ? 1 : 0;
  nhlProxySecurityCounters.oversizedResponseCount += event === 'oversized-response' ? 1 : 0;
  nhlProxyLastRouteClass = routeClass ?? nhlProxyLastRouteClass;
  nhlProxyLastSecurityEvent = event;

  if (Date.now() - nhlProxyLastHealthFlushAt < NHL_PROXY_HEALTH_FLUSH_MILLISECONDS) {
    return;
  }

  nhlProxyLastHealthFlushAt = Date.now();
  const counters = nhlProxySecurityCounters;
  nhlProxySecurityCounters = {
    requestCount: 0,
    verifiedRequestCount: 0,
    missingTokenRequestCount: 0,
    invalidTokenRequestCount: 0,
    rateLimitedRequestCount: 0,
    rejectedQueryRequestCount: 0,
    oversizedResponseCount: 0,
  };

  void db.doc('appData/nhlProxySecurity').set(
    {
      schemaVersion: 1,
      mode: 'app-check-monitor',
      routeAllowlistEnabled: true,
      queryAllowlistEnabled: true,
      perInstanceRateLimitEnabled: true,
      requestCount: FieldValue.increment(counters.requestCount),
      verifiedRequestCount: FieldValue.increment(counters.verifiedRequestCount),
      missingTokenRequestCount: FieldValue.increment(counters.missingTokenRequestCount),
      invalidTokenRequestCount: FieldValue.increment(counters.invalidTokenRequestCount),
      rateLimitedRequestCount: FieldValue.increment(counters.rateLimitedRequestCount),
      rejectedQueryRequestCount: FieldValue.increment(counters.rejectedQueryRequestCount),
      oversizedResponseCount: FieldValue.increment(counters.oversizedResponseCount),
      lastRouteClass: nhlProxyLastRouteClass,
      lastSecurityEvent: nhlProxyLastSecurityEvent,
      lastObservedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  ).catch((error: unknown) => {
    console.warn('Unable to persist NHL proxy security health.', { error });
  });
}

async function readNhlProxyResponseBody(
  upstreamResponse: Response,
  maximumBytes: number,
): Promise<Buffer> {
  const contentLength = Number(upstreamResponse.headers.get('content-length') ?? '');

  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new NhlProxyResponseTooLargeError(maximumBytes);
  }

  const body = Buffer.from(await upstreamResponse.arrayBuffer());

  if (body.byteLength > maximumBytes) {
    throw new NhlProxyResponseTooLargeError(maximumBytes);
  }

  return body;
}

function getNhlProxyCacheControl(path: string): string {
  if (path === '/v1/score/now') {
    return 'public, max-age=15, s-maxage=20';
  }

  if (path.includes('/gamecenter/')) {
    return 'public, max-age=8, s-maxage=12';
  }

  if (path === '/apis/site/v2/sports/hockey/nhl/injuries') {
    return 'public, max-age=300, s-maxage=900';
  }

  if (path.includes('/club-schedule-season/')) {
    return 'public, max-age=60, s-maxage=300';
  }

  if (path.includes('/roster/')) {
    return 'public, max-age=300, s-maxage=1800';
  }

  return 'public, max-age=120, s-maxage=600';
}

function getNhlProxyFreshCacheMilliseconds(path: string): number {
  if (path === '/v1/score/now') {
    return 15_000;
  }

  if (path.includes('/gamecenter/')) {
    return 8_000;
  }

  if (path === '/apis/site/v2/sports/hockey/nhl/injuries') {
    return 15 * 60 * 1000;
  }

  if (path.includes('/club-schedule-season/')) {
    return 5 * 60 * 1000;
  }

  if (path.includes('/roster/')) {
    return 30 * 60 * 1000;
  }

  return 10 * 60 * 1000;
}

function getNhlProxyStaleCacheMilliseconds(path: string): number {
  if (path === '/v1/score/now') {
    return 2 * 60 * 1000;
  }

  // Never serve stale live boxscores or play-by-play into the scoring engine.
  if (path.includes('/gamecenter/')) {
    return 0;
  }

  if (path === '/apis/site/v2/sports/hockey/nhl/injuries') {
    return 6 * 60 * 60 * 1000;
  }

  if (path.includes('/club-schedule-season/')) {
    return 6 * 60 * 60 * 1000;
  }

  return 24 * 60 * 60 * 1000;
}

function waitForNhlProxyRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchNhlProxyUpstream(target: URL): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= NHL_PROXY_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NHL_PROXY_TIMEOUT_MS);

    try {
      const upstreamResponse = await fetch(target, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'rinkrat-fantasy/1.0'
        },
        signal: controller.signal
      });

      if (
        upstreamResponse.ok ||
        ![408, 425, 429, 500, 502, 503, 504].includes(upstreamResponse.status) ||
        attempt >= NHL_PROXY_MAX_ATTEMPTS
      ) {
        return upstreamResponse;
      }

      lastError = new Error(
        `NHL upstream returned ${upstreamResponse.status} ${upstreamResponse.statusText}.`
      );
    } catch (error: unknown) {
      lastError = error;

      if (attempt >= NHL_PROXY_MAX_ATTEMPTS) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }

    await waitForNhlProxyRetry(500 * attempt);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unknown NHL API proxy error.');
}

function getPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactNhlScoreTeam(value: unknown): Record<string, unknown> {
  const team = getPlainObject(value) ?? {};

  return {
    id: team['id'],
    abbrev: team['abbrev'],
    name: team['name'],
    commonName: team['commonName'],
    logo: team['logo'],
    score: team['score'],
    record: team['record']
  };
}

function compactNhlScoreNowBody(body: Buffer): Buffer {
  try {
    const source = getPlainObject(JSON.parse(body.toString('utf8')));

    if (!source) {
      return body;
    }

    const games = Array.isArray(source['games'])
      ? source['games'].map((value) => {
          const game = getPlainObject(value) ?? {};
          const broadcasts = Array.isArray(game['tvBroadcasts'])
            ? game['tvBroadcasts'].map((broadcastValue) => {
                const broadcast = getPlainObject(broadcastValue) ?? {};
                return {
                  network: broadcast['network'],
                  countryCode: broadcast['countryCode'],
                  market: broadcast['market']
                };
              })
            : [];

          return {
            id: game['id'],
            gameDate: game['gameDate'],
            startTimeUTC: game['startTimeUTC'],
            gameState: game['gameState'],
            gameScheduleState: game['gameScheduleState'],
            period: game['period'],
            periodDescriptor: game['periodDescriptor'],
            clock: game['clock'],
            gameOutcome: game['gameOutcome'],
            awayTeam: compactNhlScoreTeam(game['awayTeam']),
            homeTeam: compactNhlScoreTeam(game['homeTeam']),
            tvBroadcasts: broadcasts
          };
        })
      : [];

    return Buffer.from(JSON.stringify({
      prevDate: source['prevDate'],
      currentDate: source['currentDate'],
      nextDate: source['nextDate'],
      games
    }));
  } catch {
    return body;
  }
}

function trimNhlProxyResponseCache(): void {
  const entriesByAge = [...nhlProxyResponseCache.entries()].sort(
    (first, second) => first[1].loadedAt - second[1].loadedAt
  );

  let totalBytes = entriesByAge.reduce(
    (sum, [, entry]) => sum + entry.body.byteLength,
    0
  );

  while (
    entriesByAge.length > NHL_PROXY_MAX_CACHE_ENTRIES ||
    totalBytes > NHL_PROXY_MAX_CACHE_BYTES
  ) {
    const oldest = entriesByAge.shift();

    if (!oldest) {
      break;
    }

    totalBytes -= oldest[1].body.byteLength;
    nhlProxyResponseCache.delete(oldest[0]);
  }
}

const MAX_NOTE_LENGTH = 500;
const MAX_BATCH_WRITES = 400;
const RUNNING_LEASE_MINUTES = 10;
const ERROR_COOLDOWN_MINUTES = 15;
const FUNCTION_REGION = 'us-central1';

type PlayerAvailabilityStatus =
  | 'active'
  | 'day-to-day'
  | 'out'
  | 'injured-reserve'
  | 'long-term-injured-reserve'
  | 'suspended'
  | 'personal-leave'
  | 'unknown';

interface NhlSkater {
  id: number;
  fullName: string;
  position: 'LW' | 'C' | 'RW' | 'D';
  nhlTeamAbbreviation: string;
}

interface NhlCurrentRosterPlayer {
  id?: number;
  playerId?: number;
  firstName?: {
    default?: string;
  };
  lastName?: {
    default?: string;
  };
  fullName?: {
    default?: string;
  };
  positionCode?: string;
  currentTeamAbbrev?: string;
}

interface NhlCurrentRosterResponse {
  forwards?: NhlCurrentRosterPlayer[];
  defensemen?: NhlCurrentRosterPlayer[];
}

interface EspnInjuryEntry {
  playerName: string;
  position: string;
  teamName: string;
  rawStatus: string;
  normalizedStatus: PlayerAvailabilityStatus;
  injuryDate: string;
  returnDate: string;
  shortComment: string;
  longComment: string;
  injuryType: string;
  fantasyStatus: string;
}

interface MatchedInjury {
  player: NhlSkater;
  injury: EspnInjuryEntry;
}

type PlayerAvailabilityRefreshTrigger =
  | 'daily-visit'
  | 'draft-start'
  | 'commissioner-browser'
  | 'scheduled-server';

interface GlobalInjuryRefreshOptions {
  trigger: PlayerAvailabilityRefreshTrigger;
  force?: boolean;
}

interface DailyRefreshResult {
  status:
    | 'success'
    | 'already-current'
    | 'in-progress'
    | 'cooldown';
  skipped: boolean;
  dailyKey: string;
  message: string;
  completedAt: string;
  fetchedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  syncedRecordCount: number;
  clearedRecordCount: number;
  preservedManualOverrideCount: number;
  skippedGoalieCount: number;
}

type GlobalInjuryRefreshClaim =
  | {
      claimed: false;
      status: Exclude<DailyRefreshResult['status'], 'success'>;
      reason: string;
      data: DocumentData;
    }
  | {
      claimed: true;
      status: 'success';
      reason: 'claimed';
      data: DocumentData;
    };

interface ClaimResult {
  status:
    | 'claimed'
    | 'already-current'
    | 'in-progress'
    | 'cooldown';
  syncData: DocumentData;
  completedAt: string;
}

interface PendingWrite {
  type: 'set' | 'delete';
  reference: DocumentReference;
  data?: DocumentData;
}

const STATUS_STRENGTH: Record<PlayerAvailabilityStatus, number> = {
  active: 0,
  unknown: 1,
  'day-to-day': 2,
  'personal-leave': 3,
  suspended: 4,
  out: 5,
  'injured-reserve': 6,
  'long-term-injured-reserve': 7
};

const NHL_DRAFT_CLUBS = [
  'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ',
  'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH',
  'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SJS', 'SEA',
  'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG'
] as const;

const ESPN_TEAM_ABBREVIATIONS: Record<string, string> = {
  anaheimducks: 'ANA',
  bostonbruins: 'BOS',
  buffalosabres: 'BUF',
  calgaryflames: 'CGY',
  carolinahurricanes: 'CAR',
  chicagoblackhawks: 'CHI',
  coloradoavalanche: 'COL',
  columbusbluejackets: 'CBJ',
  dallasstars: 'DAL',
  detroitredwings: 'DET',
  edmontonoilers: 'EDM',
  floridapanthers: 'FLA',
  losangeleskings: 'LAK',
  minnesotawild: 'MIN',
  montrealcanadiens: 'MTL',
  nashvillepredators: 'NSH',
  newjerseydevils: 'NJD',
  newyorkislanders: 'NYI',
  newyorkrangers: 'NYR',
  ottawasenators: 'OTT',
  philadelphiaflyers: 'PHI',
  pittsburghpenguins: 'PIT',
  sanjosesharks: 'SJS',
  seattlekraken: 'SEA',
  stlouisblues: 'STL',
  tampabaylightning: 'TBL',
  torontomapleleafs: 'TOR',
  utahhockeyclub: 'UTA',
  utahmammoth: 'UTA',
  vancouvercanucks: 'VAN',
  vegasgoldenknights: 'VGK',
  washingtoncapitals: 'WSH',
  winnipegjets: 'WPG'
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function getUtcDailyKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function getTimestampDate(value: unknown): Date | null {
  if (value instanceof Timestamp) {
    return value.toDate();
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }

  return null;
}

function getIsoTimestamp(value: unknown): string {
  return getTimestampDate(value)?.toISOString() ?? '';
}

function isRecentTimestamp(
  value: unknown,
  maximumAgeMinutes: number
): boolean {
  const date = getTimestampDate(value);

  if (!date) {
    return false;
  }

  return Date.now() - date.getTime() <
    maximumAgeMinutes * 60_000;
}

function isTimestampOnDailyKey(
  value: unknown,
  dailyKey: string
): boolean {
  const date = getTimestampDate(value);

  return Boolean(
    date &&
    getUtcDailyKey(date) === dailyKey
  );
}

function getCount(data: DocumentData, field: string): number {
  return typeof data[field] === 'number'
    ? data[field] as number
    : 0;
}

function buildSkippedResult(
  status: Exclude<DailyRefreshResult['status'], 'success'>,
  dailyKey: string,
  message: string,
  syncData: DocumentData,
  completedAt: string
): DailyRefreshResult {
  return {
    status,
    skipped: true,
    dailyKey,
    message,
    completedAt,
    fetchedCount: getCount(syncData, 'fetchedCount'),
    matchedCount: getCount(syncData, 'matchedCount'),
    unmatchedCount: getCount(syncData, 'unmatchedCount'),
    syncedRecordCount: getCount(syncData, 'syncedRecordCount'),
    clearedRecordCount: getCount(syncData, 'clearedRecordCount'),
    preservedManualOverrideCount:
      getCount(syncData, 'preservedManualOverrideCount'),
    skippedGoalieCount: getCount(syncData, 'skippedGoalieCount')
  };
}

function getCurrentRosterSeason(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const seasonStartYear = month >= 7
    ? year
    : year - 1;

  return `${seasonStartYear}${seasonStartYear + 1}`;
}

function getDraftPosition(
  positionCode: string | undefined
): NhlSkater['position'] | null {
  switch (positionCode?.toUpperCase()) {
    case 'L':
    case 'LW':
      return 'LW';

    case 'C':
      return 'C';

    case 'R':
    case 'RW':
      return 'RW';

    case 'D':
      return 'D';

    default:
      return null;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'fantasy-hockey-injury-sync/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Request failed with ${response.status} ${response.statusText}.`
    );
  }

  const value = await response.json();

  queueNhlSharedCacheObservation({
    url,
    payload: value,
    source: 'functions-core',
  });

  return value;
}

async function fetchNhlRoster(
  clubAbbreviation: string
): Promise<NhlCurrentRosterResponse> {
  const season = getCurrentRosterSeason();
  const club = clubAbbreviation.toLowerCase();

  try {
    return await fetchJson(
      `${NHL_API_BASE_URL}/roster/${club}/${season}`
    ) as NhlCurrentRosterResponse;
  } catch (seasonError: unknown) {
    try {
      return await fetchJson(
        `${NHL_API_BASE_URL}/roster/${club}/current`
      ) as NhlCurrentRosterResponse;
    } catch {
      const message = seasonError instanceof Error
        ? seasonError.message
        : 'Unknown NHL roster error.';

      throw new Error(
        `${clubAbbreviation} roster could not be loaded: ${message}`
      );
    }
  }
}

function addRosterSkaters(
  destination: Map<number, NhlSkater>,
  clubAbbreviation: string,
  roster: NhlCurrentRosterResponse
): void {
  const players = [
    ...(roster.forwards ?? []),
    ...(roster.defensemen ?? [])
  ];

  for (const player of players) {
    const playerId = player.id ?? player.playerId;
    const position = getDraftPosition(player.positionCode);

    if (!playerId || !position) {
      continue;
    }

    const fullName =
      [
        player.firstName?.default,
        player.lastName?.default
      ]
        .filter(Boolean)
        .join(' ') ||
      player.fullName?.default ||
      'Unknown Player';

    destination.set(playerId, {
      id: playerId,
      fullName,
      position,
      nhlTeamAbbreviation:
        player.currentTeamAbbrev ?? clubAbbreviation
    });
  }
}

async function loadCurrentNhlSkaters(): Promise<NhlSkater[]> {
  const skaters = new Map<number, NhlSkater>();
  const failures: string[] = [];
  const batchSize = 4;

  for (
    let startIndex = 0;
    startIndex < NHL_DRAFT_CLUBS.length;
    startIndex += batchSize
  ) {
    const clubs = NHL_DRAFT_CLUBS.slice(
      startIndex,
      startIndex + batchSize
    );

    const results = await Promise.allSettled(
      clubs.map(async (club) => ({
        club,
        roster: await fetchNhlRoster(club)
      }))
    );

    results.forEach((result, index) => {
      const club = clubs[index];

      if (result.status === 'fulfilled') {
        addRosterSkaters(
          skaters,
          result.value.club,
          result.value.roster
        );
      } else {
        failures.push(
          `${club}: ${
            result.reason instanceof Error
              ? result.reason.message
              : 'Unknown error'
          }`
        );
      }
    });
  }

  if (failures.length > 4) {
    throw new Error(
      `Too many NHL rosters failed to load. ${failures.slice(0, 4).join(' | ')}`
    );
  }

  if (skaters.size === 0) {
    throw new Error(
      'The NHL roster service returned no draftable skaters.'
    );
  }

  return [...skaters.values()];
}

function getEspnTeamAbbreviation(teamName: string): string {
  return ESPN_TEAM_ABBREVIATIONS[normalizeText(teamName)] ?? '';
}

function normalizeEspnStatus(input: {
  rawStatus: string;
  injuryType: string;
  fantasyStatus: string;
  shortComment: string;
  longComment: string;
}): PlayerAvailabilityStatus {
  const combined = [
    input.rawStatus,
    input.injuryType,
    input.fantasyStatus,
    input.shortComment,
    input.longComment
  ]
    .join(' ')
    .toLowerCase();

  if (/\bltir\b|\bir-lt\b|long[- ]term/.test(combined)) {
    return 'long-term-injured-reserve';
  }

  if (/injured reserve|\bon ir\b|\bir\b/.test(combined)) {
    return 'injured-reserve';
  }

  if (/suspend/.test(combined)) {
    return 'suspended';
  }

  if (/personal|leave/.test(combined)) {
    return 'personal-leave';
  }

  if (
    /day[- ]to[- ]day|questionable|doubtful|probable|game[- ]time decision/.test(
      combined
    )
  ) {
    return 'day-to-day';
  }

  if (/\bout\b|inactive|unavailable/.test(combined)) {
    return 'out';
  }

  return 'unknown';
}

function parseEspnInjuries(payload: unknown): {
  entries: EspnInjuryEntry[];
  teamEntryCount: number;
} {
  const topLevel = asRecord(payload);
  const teamEntries = asArray(topLevel['injuries']);
  const entries: EspnInjuryEntry[] = [];

  for (const rawTeamEntry of teamEntries) {
    const teamEntry = asRecord(rawTeamEntry);
    const teamName = asString(teamEntry['displayName']);

    for (const rawInjury of asArray(teamEntry['injuries'])) {
      const injury = asRecord(rawInjury);
      const athlete = asRecord(injury['athlete']);
      const position = asRecord(athlete['position']);
      const injuryType = asRecord(injury['type']);
      const details = asRecord(injury['details']);
      const playerName = asString(athlete['displayName']);

      if (!playerName) {
        continue;
      }

      const entry: EspnInjuryEntry = {
        playerName,
        position: asString(position['abbreviation']),
        teamName,
        rawStatus: asString(injury['status']),
        injuryDate: asString(injury['date']),
        returnDate: asString(details['returnDate']),
        shortComment: asString(injury['shortComment']),
        longComment: asString(injury['longComment']),
        injuryType:
          asString(injuryType['name']) ||
          asString(injuryType['abbreviation']),
        fantasyStatus: asString(details['fantasyStatus']),
        normalizedStatus: 'unknown'
      };

      entry.normalizedStatus = normalizeEspnStatus(entry);
      entries.push(entry);
    }
  }

  return {
    entries,
    teamEntryCount: teamEntries.length
  };
}

function chooseStrongerInjury(
  first: EspnInjuryEntry,
  second: EspnInjuryEntry
): EspnInjuryEntry {
  const firstStrength = STATUS_STRENGTH[first.normalizedStatus];
  const secondStrength = STATUS_STRENGTH[second.normalizedStatus];

  if (secondStrength !== firstStrength) {
    return secondStrength > firstStrength
      ? second
      : first;
  }

  const firstCommentLength = (
    first.longComment || first.shortComment
  ).length;

  const secondCommentLength = (
    second.longComment || second.shortComment
  ).length;

  return secondCommentLength > firstCommentLength
    ? second
    : first;
}

function isPlayerIrEligible(
  status: PlayerAvailabilityStatus
): boolean {
  return (
    status === 'out' ||
    status === 'injured-reserve' ||
    status === 'long-term-injured-reserve'
  );
}

function buildAvailabilityNote(
  injury: EspnInjuryEntry
): string {
  const comment =
    injury.longComment || injury.shortComment;

  const pieces = [comment];

  if (injury.returnDate) {
    pieces.push(
      `Estimated return: ${injury.returnDate}.`
    );
  }

  return pieces
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, MAX_NOTE_LENGTH);
}

async function commitPendingWrites(
  writes: PendingWrite[]
): Promise<void> {
  for (
    let startIndex = 0;
    startIndex < writes.length;
    startIndex += MAX_BATCH_WRITES
  ) {
    const batch: WriteBatch = db.batch();

    for (
      const write of writes.slice(
        startIndex,
        startIndex + MAX_BATCH_WRITES
      )
    ) {
      if (write.type === 'delete') {
        batch.delete(write.reference);
      } else if (write.data) {
        batch.set(write.reference, write.data);
      }
    }

    await batch.commit();
  }
}

async function verifyLeagueMembership(
  leagueId: string,
  userId: string
): Promise<void> {
  const leagueRef = db.doc(`leagues/${leagueId}`);
  const memberRef =
    db.doc(`leagues/${leagueId}/members/${userId}`);
  const teamRef =
    db.doc(`leagues/${leagueId}/teams/${userId}`);

  const [
    leagueSnapshot,
    memberSnapshot,
    teamSnapshot
  ] = await Promise.all([
    leagueRef.get(),
    memberRef.get(),
    teamRef.get()
  ]);

  if (!leagueSnapshot.exists) {
    throw new HttpsError(
      'not-found',
      'This league no longer exists.'
    );
  }

  const leagueData = leagueSnapshot.data() ?? {};
  const memberData = memberSnapshot.data() ?? {};
  const teamData = teamSnapshot.data() ?? {};

  const isCommissioner =
    leagueData['commissionerId'] === userId;

  const hasMembership =
    memberSnapshot.exists &&
    memberData['uid'] === userId;

  const ownsExistingTeam =
    teamSnapshot.exists &&
    teamData['ownerId'] === userId;

  if (
    !isCommissioner &&
    !hasMembership &&
    !ownsExistingTeam
  ) {
    throw new HttpsError(
      'permission-denied',
      'You are not a member of this league.'
    );
  }
}

async function claimDailyRefresh(
  leagueId: string,
  userId: string,
  dailyKey: string,
  attemptId: string
): Promise<ClaimResult> {
  const lockRef = db.doc(
    `leagues/${leagueId}/playerAvailabilityDaily/${dailyKey}`
  );

  const syncRef = db.doc(
    `leagues/${leagueId}/playerAvailabilitySync/current`
  );

  const globalRef = db.doc('appData/playerAvailability');

  return db.runTransaction(async (transaction) => {
    const [lockSnapshot, syncSnapshot, globalSnapshot] = await Promise.all([
      transaction.get(lockRef),
      transaction.get(syncRef),
      transaction.get(globalRef)
    ]);
    const lockData = lockSnapshot.data() ?? {};
    const syncData = syncSnapshot.data() ?? {};
    const globalData = globalSnapshot.data() ?? {};

    const lastDailySyncKey =
      asString(syncData['lastDailySyncKey']);

    const existingSuccessToday =
      lastDailySyncKey === dailyKey ||
      isTimestampOnDailyKey(
        syncData['lastDailySuccessfulSyncAt'],
        dailyKey
      ) ||
      isTimestampOnDailyKey(
        syncData['lastSuccessfulSyncAt'],
        dailyKey
      );

    const globalSuccessToday =
      globalData['status'] === 'success' &&
      (
        asString(globalData['lastDailySyncKey']) === dailyKey ||
        isTimestampOnDailyKey(globalData['lastDailySuccessfulSyncAt'], dailyKey) ||
        isTimestampOnDailyKey(globalData['lastSuccessfulSyncAt'], dailyKey)
      );

    if (!existingSuccessToday && globalSuccessToday) {
      const completedDate =
        getTimestampDate(globalData['lastDailySuccessfulSyncAt']) ??
        getTimestampDate(globalData['lastSuccessfulSyncAt']) ??
        new Date();
      const completedAt = completedDate.toISOString();
      const message =
        asString(globalData['message']) ||
        'Today’s shared injury report was refreshed automatically by the server.';

      transaction.set(
        lockRef,
        {
          status: 'success',
          dailyKey,
          completedAt: Timestamp.fromDate(completedDate),
          requestedBy: userId,
          source: 'scheduled-server',
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      transaction.set(
        syncRef,
        {
          source: 'ESPN',
          status: 'success',
          trigger: 'scheduled-server',
          dailyKey,
          lastDailySyncKey: dailyKey,
          lastAttemptAt:
            globalData['lastAttemptAt'] ?? Timestamp.fromDate(completedDate),
          lastSuccessfulSyncAt: Timestamp.fromDate(completedDate),
          lastDailySuccessfulSyncAt: Timestamp.fromDate(completedDate),
          updatedBy: 'server:scheduled-injury-refresh',
          fetchedCount:
            typeof globalData['fetchedCount'] === 'number'
              ? globalData['fetchedCount']
              : 0,
          matchedCount:
            typeof globalData['matchedCount'] === 'number'
              ? globalData['matchedCount']
              : 0,
          unmatchedCount:
            typeof globalData['unmatchedCount'] === 'number'
              ? globalData['unmatchedCount']
              : 0,
          syncedRecordCount:
            typeof globalData['syncedRecordCount'] === 'number'
              ? globalData['syncedRecordCount']
              : 0,
          clearedRecordCount:
            typeof globalData['clearedRecordCount'] === 'number'
              ? globalData['clearedRecordCount']
              : 0,
          preservedManualOverrideCount: 0,
          skippedGoalieCount:
            typeof globalData['skippedGoalieCount'] === 'number'
              ? globalData['skippedGoalieCount']
              : 0,
          matchQuality: globalData['matchQuality'] ?? null,
          message,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return {
        status: 'already-current',
        syncData: {
          ...globalData,
          trigger: 'scheduled-server',
          dailyKey,
          lastDailySyncKey: dailyKey,
          message
        },
        completedAt
      };
    }

    if (existingSuccessToday) {
      const completedAt =
        getIsoTimestamp(
          syncData['lastDailySuccessfulSyncAt']
        ) ||
        getIsoTimestamp(syncData['lastSuccessfulSyncAt']);

      transaction.set(
        lockRef,
        {
          status: 'success',
          dailyKey,
          completedAt:
            getTimestampDate(
              syncData['lastDailySuccessfulSyncAt']
            ) ??
            getTimestampDate(
              syncData['lastSuccessfulSyncAt']
            ) ??
            FieldValue.serverTimestamp(),
          requestedBy: userId,
          source: 'existing-success',
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      transaction.set(
        syncRef,
        {
          dailyKey,
          lastDailySyncKey: dailyKey,
          lastDailySuccessfulSyncAt:
            getTimestampDate(
              syncData['lastSuccessfulSyncAt']
            ) ??
            FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      return {
        status: 'already-current',
        syncData,
        completedAt
      };
    }

    if (
      lockData['status'] === 'success'
    ) {
      return {
        status: 'already-current',
        syncData,
        completedAt: getIsoTimestamp(
          lockData['completedAt']
        )
      };
    }

    if (
      (
        lockData['status'] === 'running' &&
        isRecentTimestamp(
          lockData['startedAt'],
          RUNNING_LEASE_MINUTES
        )
      ) ||
      (
        syncData['status'] === 'running' &&
        isRecentTimestamp(
          syncData['lastAttemptAt'],
          RUNNING_LEASE_MINUTES
        )
      )
    ) {
      return {
        status: 'in-progress',
        syncData,
        completedAt: ''
      };
    }

    if (
      lockData['status'] === 'error' &&
      isRecentTimestamp(
        lockData['lastAttemptAt'],
        ERROR_COOLDOWN_MINUTES
      )
    ) {
      return {
        status: 'cooldown',
        syncData,
        completedAt: getIsoTimestamp(
          syncData['lastSuccessfulSyncAt']
        )
      };
    }

    transaction.set(
      lockRef,
      {
        status: 'running',
        dailyKey,
        attemptId,
        requestedBy: userId,
        startedAt: FieldValue.serverTimestamp(),
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    transaction.set(
      syncRef,
      {
        source: 'ESPN',
        status: 'running',
        trigger: 'daily-visit',
        dailyKey,
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedBy: userId,
        fetchedCount: 0,
        matchedCount: 0,
        unmatchedCount: 0,
        syncedRecordCount: 0,
        clearedRecordCount: 0,
        preservedManualOverrideCount: 0,
        skippedGoalieCount: 0,
        message:
          'The first league visit of the day is securely refreshing ESPN injury data.'
      },
      { merge: true }
    );

    return {
      status: 'claimed',
      syncData,
      completedAt: ''
    };
  });
}

export const nhlApiProxy = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '256MiB',
    maxInstances: 10,
    cors: false
  },
  async (request, response) => {
    if (request.method !== 'GET') {
      response
        .status(405)
        .set('Allow', 'GET')
        .set('X-Content-Type-Options', 'nosniff')
        .json({ message: 'Only GET requests are supported.' });
      return;
    }

    const resolution = resolveNhlProxyRequest(request.originalUrl);

    if (isNhlProxyResolutionFailure(resolution)) {
      recordNhlProxySecurityObservation(
        resolution.status === 400 ? 'rejected-query' : 'rejected-route',
        null,
        null,
      );
      response
        .status(resolution.status)
        .set('Cache-Control', 'no-store')
        .set('X-Content-Type-Options', 'nosniff')
        .json({ message: resolution.message });
      return;
    }

    const target = new URL(resolution.targetUrl);
    const appCheck = await inspectNhlProxyAppCheck({
      headers: request.headers as Record<string, string | string[] | undefined>,
    });
    const requesterId = getNhlProxyRequesterIdentity({
      ip: request.ip,
      headers: request.headers as Record<string, string | string[] | undefined>,
    });
    const rateLimit = consumeNhlProxyRateLimit(
      requesterId,
      resolution.routeClass,
      appCheck.status,
    );

    recordNhlProxySecurityObservation('request', resolution.routeClass, appCheck.status);

    if (!rateLimit.allowed) {
      recordNhlProxySecurityObservation(
        'rate-limited',
        resolution.routeClass,
        appCheck.status,
      );
      console.warn('NHL API proxy request was rate limited.', {
        requesterId,
        routeClass: resolution.routeClass,
        appCheckStatus: appCheck.status,
        appCheckAppId: appCheck.appId,
        configuredLimit: rateLimit.limit,
      });
      response
        .status(429)
        .set('Retry-After', String(rateLimit.retryAfterSeconds))
        .set('Cache-Control', 'no-store')
        .set('X-RinkRat-App-Check', appCheck.status)
        .set('X-RinkRat-Rate-Limit', String(rateLimit.limit))
        .set('X-Content-Type-Options', 'nosniff')
        .json({
          message: 'Too many NHL data requests were sent from this connection. Wait a moment and try again.',
        });
      return;
    }

    const cacheKey = target.toString();
    const cached = nhlProxyResponseCache.get(cacheKey);
    const cachedAge = cached ? Date.now() - cached.loadedAt : Number.POSITIVE_INFINITY;
    const applySecurityHeaders = () => response
      .set('X-RinkRat-App-Check', appCheck.status)
      .set('X-RinkRat-Proxy-Route', resolution.routeClass)
      .set('X-Content-Type-Options', 'nosniff');

    if (cached && cachedAge <= getNhlProxyFreshCacheMilliseconds(target.pathname)) {
      applySecurityHeaders()
        .status(cached.status)
        .set('Content-Type', cached.contentType)
        .set('Cache-Control', getNhlProxyCacheControl(target.pathname))
        .set('X-RinkRat-Proxy-Cache', 'fresh')
        .send(cached.body);
      return;
    }

    try {
      const upstreamResponse = await fetchNhlProxyUpstream(target);

      if (
        !upstreamResponse.ok &&
        cached &&
        cachedAge <= getNhlProxyStaleCacheMilliseconds(target.pathname) &&
        [408, 425, 429, 500, 502, 503, 504].includes(upstreamResponse.status)
      ) {
        applySecurityHeaders()
          .status(cached.status)
          .set('Content-Type', cached.contentType)
          .set('Cache-Control', 'private, no-cache')
          .set('Warning', '110 - Response is stale because the NHL service was unavailable')
          .set('X-RinkRat-Proxy-Cache', 'stale')
          .send(cached.body);
        return;
      }

      const upstreamBody = await readNhlProxyResponseBody(
        upstreamResponse,
        resolution.maximumResponseBytes,
      );
      const responseBody =
        upstreamResponse.ok && target.pathname === '/v1/score/now'
          ? compactNhlScoreNowBody(upstreamBody)
          : upstreamBody;
      const contentType =
        upstreamResponse.headers.get('content-type') ??
        'application/json; charset=utf-8';

      if (upstreamResponse.ok) {
        queueNhlSharedCacheObservation({
          url: target.toString(),
          payload: upstreamBody,
          source: 'public-proxy',
        });

        nhlProxyResponseCache.set(cacheKey, {
          loadedAt: Date.now(),
          status: upstreamResponse.status,
          contentType,
          body: responseBody
        });
        trimNhlProxyResponseCache();
      }

      applySecurityHeaders()
        .status(upstreamResponse.status)
        .set('Content-Type', contentType)
        .set('Cache-Control', getNhlProxyCacheControl(target.pathname))
        .set('X-RinkRat-Proxy-Cache', 'miss')
        .send(responseBody);
    } catch (error: unknown) {
      if (error instanceof NhlProxyResponseTooLargeError) {
        recordNhlProxySecurityObservation(
          'oversized-response',
          resolution.routeClass,
          appCheck.status,
        );
        console.warn('NHL API proxy rejected an oversized upstream response.', {
          routeClass: resolution.routeClass,
          maximumBytes: error.maximumBytes,
          appCheckStatus: appCheck.status,
        });
        applySecurityHeaders()
          .status(502)
          .set('Cache-Control', 'no-store')
          .json({
            message: 'The NHL data response was larger than RinkRat can process safely.',
          });
        return;
      }

      if (
        cached &&
        cachedAge <= getNhlProxyStaleCacheMilliseconds(target.pathname)
      ) {
        applySecurityHeaders()
          .status(cached.status)
          .set('Content-Type', cached.contentType)
          .set('Cache-Control', 'private, no-cache')
          .set('Warning', '110 - Response is stale because the NHL service was unavailable')
          .set('X-RinkRat-Proxy-Cache', 'stale')
          .send(cached.body);
        return;
      }

      const message = error instanceof Error
        ? error.message
        : 'Unknown NHL API proxy error.';

      console.error('NHL API proxy request failed.', {
        target: target.toString(),
        routeClass: resolution.routeClass,
        appCheckStatus: appCheck.status,
        message
      });

      applySecurityHeaders()
        .status(502)
        .set('Cache-Control', 'no-store')
        .json({
          message: 'The NHL data service could not be reached. Please try again shortly.'
        });
    }
  }
);


function isInjurySeasonActive(date = new Date()): boolean {
  const month = date.getUTCMonth();
  // September through June is the active NHL season / playoff window.
  return month >= 8 || month <= 5;
}

function normalizeGlobalAvailabilityRecords(
  data: DocumentData | undefined
): Map<number, DocumentData> {
  const records = new Map<number, DocumentData>();
  const source = Array.isArray(data?.['records'])
    ? data?.['records'] as unknown[]
    : [];

  for (const entry of source) {
    const record = asRecord(entry);
    const playerId = record['playerId'];

    if (typeof playerId === 'number' && Number.isFinite(playerId)) {
      records.set(playerId, record);
    }
  }

  return records;
}

function serializeScheduledGlobalAvailabilityRecord(
  match: MatchedInjury,
  syncedAt: string,
  updatedBy: string
): DocumentData {
  return {
    playerId: match.player.id,
    playerName: match.player.fullName,
    status: match.injury.normalizedStatus,
    note: buildAvailabilityNote(match.injury),
    irEligible: isPlayerIrEligible(match.injury.normalizedStatus),
    updatedAt: syncedAt,
    updatedBy,
    source: 'espn',
    leagueId: 'global',
    externalSource: 'ESPN',
    externalStatus:
      match.injury.rawStatus ||
      match.injury.fantasyStatus ||
      match.injury.injuryType ||
      'Unknown',
    externalReturnDate: match.injury.returnDate || '',
    externalInjuryDate: match.injury.injuryDate || '',
    externalTeamName: match.injury.teamName || '',
    syncedAt
  };
}

async function runGlobalInjuryRefresh(
  options: GlobalInjuryRefreshOptions
): Promise<DailyRefreshResult> {
  const reference = db.doc('appData/playerAvailability');
  const now = new Date();
  const nowMilliseconds = now.getTime();
  const dailyKey = getUtcDailyKey(now);
  const activeSeason = isInjurySeasonActive(now);
  const claimId = randomUUID();
  const force = options.force === true;
  const updatedBy = options.trigger === 'scheduled-server'
    ? 'server:scheduled-injury-refresh'
    : `server:${options.trigger}`;
  const claim = await db.runTransaction<GlobalInjuryRefreshClaim>(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.exists ? snapshot.data() ?? {} : {};
    const lastSuccessful = getTimestampDate(data?.['lastSuccessfulSyncAt']);
    const lastAttempt = getTimestampDate(data?.['lastAttemptAt']);
    const leaseExpires = getTimestampDate(data?.['leaseExpiresAt']);
    const lastDailySyncKey = asString(data?.['lastDailySyncKey']);
    const dailySuccess =
      lastDailySyncKey === dailyKey ||
      isTimestampOnDailyKey(data?.['lastDailySuccessfulSyncAt'], dailyKey) ||
      isTimestampOnDailyKey(data?.['lastSuccessfulSyncAt'], dailyKey);
    const scheduledMinimumIntervalMilliseconds = activeSeason
      ? 5 * 60 * 60 * 1000
      : 23 * 60 * 60 * 1000;
    const userForceMinimumIntervalMilliseconds = 5 * 60 * 1000;

    if (
      data?.['status'] === 'running' &&
      leaseExpires &&
      leaseExpires.getTime() > nowMilliseconds
    ) {
      return {
        claimed: false,
        status: 'in-progress' as const,
        reason: 'lease-active',
        data
      };
    }

    if (
      data?.['status'] === 'error' &&
      lastAttempt &&
      nowMilliseconds - lastAttempt.getTime() < 15 * 60 * 1000 &&
      !force
    ) {
      return {
        claimed: false,
        status: 'cooldown' as const,
        reason: 'error-cooldown',
        data
      };
    }

    if (
      options.trigger === 'scheduled-server' &&
      lastSuccessful &&
      nowMilliseconds - lastSuccessful.getTime() < scheduledMinimumIntervalMilliseconds
    ) {
      return {
        claimed: false,
        status: 'already-current' as const,
        reason: activeSeason ? 'recent-season-refresh' : 'recent-offseason-refresh',
        data
      };
    }

    if (
      options.trigger !== 'scheduled-server' &&
      !force &&
      dailySuccess
    ) {
      return {
        claimed: false,
        status: 'already-current' as const,
        reason: 'daily-report-current',
        data
      };
    }

    if (
      options.trigger !== 'scheduled-server' &&
      force &&
      lastSuccessful &&
      nowMilliseconds - lastSuccessful.getTime() < userForceMinimumIntervalMilliseconds
    ) {
      return {
        claimed: false,
        status: 'already-current' as const,
        reason: 'manual-refresh-rate-limit',
        data
      };
    }

    transaction.set(
      reference,
      {
        source: 'ESPN',
        status: 'running',
        trigger: options.trigger,
        dailyKey,
        refreshLeagueId: FieldValue.delete(),
        refreshAttemptId: claimId,
        lastAttemptAt: FieldValue.serverTimestamp(),
        leaseExpiresAt: Timestamp.fromMillis(nowMilliseconds + 10 * 60 * 1000),
        updatedBy,
        message: options.trigger === 'scheduled-server'
          ? 'The server is refreshing the shared NHL injury report.'
          : 'A verified server request is refreshing the shared NHL injury report.'
      },
      { merge: true }
    );

    return {
      claimed: true,
      status: 'success' as const,
      reason: 'claimed',
      data
    };
  });

  if (!claim.claimed) {
    await db.doc('appData/injuryAutomation').set(
      {
        schemaVersion: 1,
        status: claim.status === 'cooldown' ? 'warning' : 'healthy',
        lastRunResult: claim.reason,
        activeSeason,
        lastRunAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    const message = claim.status === 'in-progress'
      ? 'Another verified server refresh is already in progress.'
      : claim.status === 'cooldown'
        ? 'A recent injury refresh failed. The last saved report remains available while the server waits before retrying.'
        : claim.reason === 'manual-refresh-rate-limit'
          ? 'The shared injury report was refreshed less than five minutes ago.'
          : 'Today’s shared injury report is already current.';

    return buildSkippedResult(
      claim.status,
      dailyKey,
      message,
      claim.data,
      getIsoTimestamp(claim.data?.['lastSuccessfulSyncAt'])
    );
  }

  try {
    const [players, espnPayload] = await Promise.all([
      loadCurrentNhlSkaters(),
      fetchJson(ESPN_NHL_INJURIES_URL)
    ]);
    const parsed = parseEspnInjuries(espnPayload);

    if (parsed.entries.length === 0) {
      throw new Error(
        'ESPN returned no NHL injury entries, so the previous shared report was preserved.'
      );
    }

    const syncedAt = new Date().toISOString();
    const matchResult = matchInjuryEntriesToCurrentPlayers(
      parsed.entries,
      players,
      {
        generatedAt: syncedAt,
        resolveTeamAbbreviation: getEspnTeamAbbreviation,
        chooseStrongerEntry: chooseStrongerInjury,
        aliases: ESPN_INJURY_PLAYER_ALIASES,
      },
    );
    const snapshot = await reference.get();
    const previousRecords = normalizeGlobalAvailabilityRecords(snapshot.data());
    const nextRecords = new Map<number, DocumentData>();

    for (const match of matchResult.matches) {
      nextRecords.set(
        match.player.id,
        serializeScheduledGlobalAvailabilityRecord(match, syncedAt, updatedBy)
      );
    }

    const feedLooksCompleteEnoughToClear =
      parsed.teamEntryCount >= 10 || parsed.entries.length >= 20;

    if (!feedLooksCompleteEnoughToClear) {
      for (const [playerId, record] of previousRecords) {
        if (!nextRecords.has(playerId)) {
          nextRecords.set(playerId, record);
        }
      }
    }

    const clearedRecordCount = feedLooksCompleteEnoughToClear
      ? [...previousRecords.keys()].filter((playerId) => !nextRecords.has(playerId)).length
      : 0;
    const unmatchedCount = matchResult.matchQuality.unresolvedSkaterCount;
    const messageParts = [
      `Matched ${matchResult.matches.length} injured skaters from ${parsed.entries.length} ESPN entries.`,
      'Saved one server-authoritative report for every league and account.'
    ];

    if (clearedRecordCount > 0) {
      messageParts.push(
        `Removed ${clearedRecordCount} players no longer listed by ESPN.`
      );
    }

    if (!feedLooksCompleteEnoughToClear) {
      messageParts.push(
        'The ESPN feed looked sparse, so older automatic records were preserved.'
      );
    }

    if (unmatchedCount > 0) {
      messageParts.push(
        `${unmatchedCount} skater identities were categorized for match review.`
      );
    }

    if (matchResult.matchQuality.matchedWithAdvisoryCount > 0) {
      messageParts.push(
        `${matchResult.matchQuality.matchedWithAdvisoryCount} matched identity advisories record a current team or position discrepancy.`
      );
    }

    if (matchResult.matchQuality.aliasResolvedCount > 0) {
      messageParts.push(
        `${matchResult.matchQuality.aliasResolvedCount} identities were resolved through the verified alias registry.`
      );
    }

    if (matchResult.skippedGoalieCount > 0) {
      messageParts.push(
        `${matchResult.skippedGoalieCount} individual goalie entries were intentionally ignored because RinkRat uses team goalie units.`
      );
    }

    const message = messageParts.join(' ').slice(0, 500);
    const completedAt = new Date();

    await Promise.all([
      reference.set(
        {
          source: 'ESPN',
          status: 'success',
          trigger: options.trigger,
          dailyKey,
          lastDailySyncKey: dailyKey,
          refreshLeagueId: FieldValue.delete(),
          refreshAttemptId: claimId,
          lastAttemptAt: FieldValue.serverTimestamp(),
          lastSuccessfulSyncAt: FieldValue.serverTimestamp(),
          lastDailySuccessfulSyncAt: FieldValue.serverTimestamp(),
          leaseExpiresAt: null,
          updatedBy,
          fetchedCount: parsed.entries.length,
          matchedCount: matchResult.matches.length,
          unmatchedCount,
          syncedRecordCount: nextRecords.size,
          clearedRecordCount,
          preservedManualOverrideCount: 0,
          skippedGoalieCount: matchResult.skippedGoalieCount,
          matchQuality: matchResult.matchQuality,
          records: [...nextRecords.values()]
            .sort((first, second) =>
              (first['playerId'] as number) - (second['playerId'] as number)
            ),
          message
        },
        { merge: true }
      ),
      db.doc('appData/injuryAutomation').set(
        {
          schemaVersion: 1,
          status: 'healthy',
          activeSeason,
          fetchedCount: parsed.entries.length,
          matchedCount: matchResult.matches.length,
          unmatchedCount,
          syncedRecordCount: nextRecords.size,
          clearedRecordCount,
          skippedGoalieCount: matchResult.skippedGoalieCount,
          matchQuality: matchResult.matchQuality,
          lastRunResult: 'success',
          lastRunAt: FieldValue.serverTimestamp(),
          lastSuccessfulRunAt: FieldValue.serverTimestamp(),
          message,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      )
    ]);

    return {
      status: 'success',
      skipped: false,
      dailyKey,
      message,
      completedAt: completedAt.toISOString(),
      fetchedCount: parsed.entries.length,
      matchedCount: matchResult.matches.length,
      unmatchedCount,
      syncedRecordCount: nextRecords.size,
      clearedRecordCount,
      preservedManualOverrideCount: 0,
      skippedGoalieCount: matchResult.skippedGoalieCount
    };
  } catch (error: unknown) {
    const message = (
      error instanceof Error
        ? error.message
        : 'Scheduled NHL injury refresh failed.'
    ).slice(0, 500);

    await Promise.all([
      reference.set(
        {
          source: 'ESPN',
          status: 'error',
          trigger: options.trigger,
          dailyKey,
          refreshLeagueId: FieldValue.delete(),
          refreshAttemptId: claimId,
          lastAttemptAt: FieldValue.serverTimestamp(),
          leaseExpiresAt: null,
          updatedBy,
          message
        },
        { merge: true }
      ),
      db.doc('appData/injuryAutomation').set(
        {
          schemaVersion: 1,
          status: 'error',
          activeSeason,
          lastRunResult: 'error',
          lastRunAt: FieldValue.serverTimestamp(),
          lastError: message,
          message,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      )
    ]);

    throw error;
  }
}

export const refreshGlobalPlayerAvailabilityScheduled = onSchedule(
  {
    schedule: 'every 6 hours',
    timeZone: 'America/Los_Angeles',
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    maxInstances: 1,
    retryCount: 1
  },
  async () => {
    await runGlobalInjuryRefresh({
      trigger: 'scheduled-server'
    });
  }
);

export const refreshDailyPlayerAvailability = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    maxInstances: 2,
    concurrency: 4,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public'
  },
  async (request): Promise<DailyRefreshResult> => {
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'You must be logged in to refresh injuries.'
      );
    }

    const data = asRecord(request.data);
    const leagueId = requireFirestoreDocumentId(data['leagueId'], 'league ID', {
      minimumLength: 6,
      maxBytes: 128,
      pattern: /^[A-Za-z0-9_-]+$/,
    });
    const requestedTrigger = asString(data['trigger']);
    const trigger: PlayerAvailabilityRefreshTrigger =
      requestedTrigger === 'draft-start' ||
      requestedTrigger === 'commissioner-browser' ||
      requestedTrigger === 'daily-visit'
        ? requestedTrigger
        : 'daily-visit';
    const force = data['force'] === true;

    const userId = request.auth.uid;

    await verifyLeagueMembership(leagueId, userId);

    if (force || trigger === 'commissioner-browser') {
      requireVerifiedRecentAuthentication(
        request.auth,
        'force a shared injury refresh',
      );
      const leagueSnapshot = await db.doc(`leagues/${leagueId}`).get();
      const commissionerId = asString(leagueSnapshot.data()?.['commissionerId']);

      if (commissionerId !== userId) {
        throw new HttpsError(
          'permission-denied',
          'Only the league commissioner can force a shared injury refresh.'
        );
      }
    }

    return runGlobalInjuryRefresh({
      trigger,
      force
    });
  }
);

interface PublicManagerProfileResult {
  uid: string;
  username: string;
  favoriteTeamAbbreviation: string;
  favoriteTeamVariantId: string;
}

const PUBLIC_PROFILE_TEAM_ABBREVIATIONS = new Set([
  'RR',
  'ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ',
  'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH',
  'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SEA', 'SJS',
  'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG'
]);

function normalizePublicManagerProfile(
  userId: string,
  source: DocumentData
): PublicManagerProfileResult {
  const abbreviation = asString(source['favoriteTeamAbbreviation']).toUpperCase();
  const variantId = asString(source['favoriteTeamVariantId']);

  return {
    uid: userId,
    username: asString(source['username']) || 'Unknown Manager',
    favoriteTeamAbbreviation: PUBLIC_PROFILE_TEAM_ABBREVIATIONS.has(abbreviation)
      ? abbreviation
      : 'RR',
    favoriteTeamVariantId: variantId || 'current-home'
  };
}

export const getPublicManagerProfiles = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 20,
    concurrency: 40,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public'
  },
  async (request): Promise<{ profiles: PublicManagerProfileResult[] }> => {
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'Sign in before loading manager identities.'
      );
    }

    const data = asRecord(request.data);
    const leagueId = requireFirestoreDocumentId(data['leagueId'], 'league ID', {
      minimumLength: 6,
      maxBytes: 128,
      pattern: /^[A-Za-z0-9_-]+$/,
    });
    const userIds = [...new Set(requireFirestoreDocumentIds(
      data['userIds'],
      'manager ID',
      {
        maximumCount: 20,
        maxBytes: 128,
        pattern: /^[A-Za-z0-9_-]+$/,
      },
    ))];

    if (userIds.length === 0 || userIds.length > 20) {
      throw new HttpsError(
        'invalid-argument',
        'Request between one and twenty league manager profiles.'
      );
    }

    await verifyLeagueMembership(leagueId, request.auth.uid);

    const teamSnapshots = await Promise.all(
      userIds.map((userId) => db.doc(`leagues/${leagueId}/teams/${userId}`).get())
    );
    const authorizedUserIds = userIds.filter((userId, index) => {
      const snapshot = teamSnapshots[index];
      return snapshot?.exists && asString(snapshot.data()?.['ownerId']) === userId;
    });

    if (authorizedUserIds.length !== userIds.length) {
      throw new HttpsError(
        'permission-denied',
        'Manager identities may only be loaded for teams in this league.'
      );
    }

    const [publicSnapshots, privateSnapshots] = await Promise.all([
      Promise.all(
        userIds.map((userId) => db.doc(`publicProfiles/${userId}`).get())
      ),
      Promise.all(
        userIds.map((userId) => db.doc(`users/${userId}`).get())
      )
    ]);
    const profiles: PublicManagerProfileResult[] = [];
    const batch = db.batch();
    let backfillCount = 0;

    for (let index = 0; index < userIds.length; index += 1) {
      const userId = userIds[index];
      const publicSnapshot = publicSnapshots[index];
      const privateSnapshot = privateSnapshots[index];
      const privateData = privateSnapshot?.data();
      const publicData = publicSnapshot?.data();
      const source = privateData ?? publicData ?? teamSnapshots[index]?.data() ?? {};
      const profile = normalizePublicManagerProfile(userId, source);
      const existingPublicProfile = publicData
        ? normalizePublicManagerProfile(userId, publicData)
        : null;

      profiles.push(profile);

      if (
        privateSnapshot?.exists &&
        (
          !existingPublicProfile ||
          existingPublicProfile.username !== profile.username ||
          existingPublicProfile.favoriteTeamAbbreviation !== profile.favoriteTeamAbbreviation ||
          existingPublicProfile.favoriteTeamVariantId !== profile.favoriteTeamVariantId
        )
      ) {
        batch.set(db.doc(`publicProfiles/${userId}`), {
          ...profile,
          updatedAt: FieldValue.serverTimestamp()
        });
        backfillCount += 1;
      }
    }

    if (backfillCount > 0) {
      await batch.commit();
    }

    return { profiles };
  }
);

interface DeleteLeagueResult {
  deleted: boolean;
  leagueId: string;
  deletedRelatedDocumentCount: number;
}

async function releaseLeagueLifecycleCounts(userIds: readonly string[]): Promise<void> {
  const uniqueUserIds = [...new Set(userIds.map((userId) => asString(userId)).filter(Boolean))];

  await Promise.all(uniqueUserIds.map(async (userId) => {
    const stateRef = db.doc(`leagueLifecycleState/${userId}`);

    await db.runTransaction(async (transaction) => {
      const stateSnapshot = await transaction.get(stateRef);

      if (!stateSnapshot.exists) {
        return;
      }

      const state = stateSnapshot.data() ?? {};
      const currentCount = typeof state['activeLeagueCount'] === 'number'
        ? Math.max(0, Math.trunc(state['activeLeagueCount']))
        : 0;

      transaction.set(stateRef, {
        activeLeagueCount: Math.max(0, currentCount - 1),
        lastMembershipReleasedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }));
}

export const deleteLeague = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    maxInstances: 3,
    concurrency: 1,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public'
  },
  async (request): Promise<DeleteLeagueResult> => {
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'You must be logged in to delete a league.'
      );
    }

    requireVerifiedRecentAuthentication(
      request.auth,
      'permanently delete this league',
    );

    const data = asRecord(request.data);
    const leagueId = requireFirestoreDocumentId(data['leagueId'], 'league ID', {
      minimumLength: 6,
      maxBytes: 128,
      pattern: /^[A-Za-z0-9_-]+$/,
    });
    const confirmationName = asString(data['confirmationName']);

    if (!confirmationName || confirmationName.length > 80) {
      throw new HttpsError(
        'invalid-argument',
        'Type the full league name before deleting it.'
      );
    }

    const leagueRef = db.doc(`leagues/${leagueId}`);
    const leagueSnapshot = await leagueRef.get();

    if (!leagueSnapshot.exists) {
      throw new HttpsError(
        'not-found',
        'This league no longer exists.'
      );
    }

    const league = leagueSnapshot.data() ?? {};
    const leagueName = asString(league['name']);
    const commissionerId = asString(league['commissionerId']);

    if (commissionerId !== request.auth.uid) {
      throw new HttpsError(
        'permission-denied',
        'Only the league commissioner can permanently delete this league.'
      );
    }

    if (confirmationName !== leagueName) {
      throw new HttpsError(
        'failed-precondition',
        'The confirmation name did not exactly match the league name.'
      );
    }

    const [memberSnapshot, teamSnapshot] = await Promise.all([
      db.collection(`leagues/${leagueId}/members`).get(),
      db.collection(`leagues/${leagueId}/teams`).get(),
    ]);
    const leagueOwnerIds = [...new Set([
      commissionerId,
      ...memberSnapshot.docs.map((document) => document.id),
      ...teamSnapshot.docs.map((document) => document.id),
    ].filter(Boolean))];

    await leagueRef.set(
      {
        deletionStatus: 'deleting',
        deletionRequestedBy: request.auth.uid,
        deletionRequestedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    let deletedRelatedDocumentCount = 0;

    deletedRelatedDocumentCount += await deleteTopLevelDocumentsByField(
      'leagueInvites',
      'leagueId',
      leagueId
    );
    deletedRelatedDocumentCount += await deleteTopLevelDocumentsByField(
      'injuryEmailQueue',
      'leagueId',
      leagueId
    );
    deletedRelatedDocumentCount += await deleteTopLevelDocumentsByField(
      'emailNotificationLog',
      'leagueId',
      leagueId
    );

    await db.recursiveDelete(leagueRef);
    await releaseLeagueLifecycleCounts(leagueOwnerIds);

    console.info('League permanently deleted.', {
      leagueId,
      leagueName,
      commissionerId: request.auth.uid,
      deletedRelatedDocumentCount
    });

    return {
      deleted: true,
      leagueId,
      deletedRelatedDocumentCount
    };
  }
);


interface AccountDeletionLeagueSummary {
  leagueId: string;
  leagueName: string;
}

interface AccountDeletionReadinessResult {
  canDelete: boolean;
  commissionerLeagues: AccountDeletionLeagueSummary[];
  memberLeagueCount: number;
  anonymizedLeagueCount: number;
}

interface DeleteMyAccountResult {
  deleted: boolean;
  anonymizedLeagueCount: number;
  deletedDocumentCount: number;
}

const DELETED_MANAGER_NAME = 'Deleted Manager';
const DELETED_TEAM_NAME = 'Vacant Team';
const DELETED_PROFILE_ICON_ID = 'hockey-bench-gear';

function getLeagueIdFromNestedDocumentPath(path: string): string | null {
  const pathParts = path.split('/');
  const leaguesIndex = pathParts.indexOf('leagues');

  if (leaguesIndex < 0 || pathParts.length <= leaguesIndex + 1) {
    return null;
  }

  return pathParts[leaguesIndex + 1] || null;
}

async function getAccountDeletionReadinessForUser(
  userId: string,
): Promise<AccountDeletionReadinessResult> {
  const [commissionerSnapshot, membershipSnapshot, teamSnapshot] = await Promise.all([
    db.collection('leagues').where('commissionerId', '==', userId).get(),
    db.collectionGroup('members').where('uid', '==', userId).get(),
    db.collectionGroup('teams').where('ownerId', '==', userId).get(),
  ]);

  const commissionerLeagues = commissionerSnapshot.docs
    .map((document) => ({
      leagueId: document.id,
      leagueName: asString(document.data()['name']) || 'Unnamed League',
    }))
    .sort((first, second) => first.leagueName.localeCompare(second.leagueName));
  const commissionerLeagueIds = new Set(
    commissionerLeagues.map((league) => league.leagueId),
  );
  const memberLeagueIds = new Set<string>();

  for (const document of [...membershipSnapshot.docs, ...teamSnapshot.docs]) {
    const leagueId = getLeagueIdFromNestedDocumentPath(document.ref.path);

    if (leagueId) {
      memberLeagueIds.add(leagueId);
    }
  }

  for (const league of commissionerLeagues) {
    memberLeagueIds.add(league.leagueId);
  }

  const anonymizedLeagueCount = [...memberLeagueIds]
    .filter((leagueId) => !commissionerLeagueIds.has(leagueId))
    .length;

  return {
    canDelete: commissionerLeagues.length === 0,
    commissionerLeagues,
    memberLeagueCount: memberLeagueIds.size,
    anonymizedLeagueCount,
  };
}

async function deleteTopLevelDocumentsByField(
  collectionName: string,
  fieldName: string,
  fieldValue: string,
): Promise<number> {
  let deletedCount = 0;

  while (true) {
    const snapshot = await db.collection(collectionName)
      .where(fieldName, '==', fieldValue)
      .limit(MAX_BATCH_WRITES)
      .get();

    if (snapshot.empty) {
      return deletedCount;
    }

    const batch = db.batch();

    for (const document of snapshot.docs) {
      batch.delete(document.ref);
    }

    await batch.commit();
    deletedCount += snapshot.size;
  }
}

async function anonymizeDeletedAccountInLeague(
  leagueId: string,
  userId: string,
): Promise<boolean> {
  const leagueRef = db.doc(`leagues/${leagueId}`);
  const memberRef = db.doc(`leagues/${leagueId}/members/${userId}`);
  const teamRef = db.doc(`leagues/${leagueId}/teams/${userId}`);
  const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
  const queueRef = db.doc(`leagues/${leagueId}/draft/current/queues/${userId}`);
  const [leagueSnapshot, memberSnapshot, teamSnapshot, draftSnapshot] = await Promise.all([
    leagueRef.get(),
    memberRef.get(),
    teamRef.get(),
    draftRef.get(),
  ]);

  if (!leagueSnapshot.exists) {
    return false;
  }

  if (asString((leagueSnapshot.data() ?? {})['commissionerId']) === userId) {
    throw new HttpsError(
      'failed-precondition',
      'Delete or transfer every league you commission before deleting your account.',
      { leagueId },
    );
  }

  const batch = db.batch();
  const accountDeletedAt = FieldValue.serverTimestamp();

  if (memberSnapshot.exists) {
    batch.set(
      memberRef,
      {
        username: DELETED_MANAGER_NAME,
        profileIconId: DELETED_PROFILE_ICON_ID,
        accountDeleted: true,
        accountDeletedAt,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  if (teamSnapshot.exists) {
    batch.set(
      teamRef,
      {
        teamName: DELETED_TEAM_NAME,
        managerName: DELETED_MANAGER_NAME,
        profileIconId: DELETED_PROFILE_ICON_ID,
        accountDeleted: true,
        accountDeletedAt,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  if (draftSnapshot.exists) {
    const draftStatus = asString((draftSnapshot.data() ?? {})['status']);

    if (draftStatus && draftStatus !== 'complete') {
      batch.set(
        queueRef,
        {
          ownerId: userId,
          autoDraftEnabled: true,
          autoDraftActivatedByTimeout: false,
          accountDeleted: true,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  }

  batch.set(
    leagueRef,
    {
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();
  return memberSnapshot.exists || teamSnapshot.exists;
}

export const getAccountDeletionReadiness = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<AccountDeletionReadinessResult> => {
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'Sign in before reviewing account deletion.',
      );
    }

    return getAccountDeletionReadinessForUser(request.auth.uid);
  },
);

export const deleteMyAccount = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 540,
    memory: '1GiB',
    maxInstances: 3,
    concurrency: 1,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<DeleteMyAccountResult> => {
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'Sign in before deleting your account.',
      );
    }

    requireRecentAuthenticationShared(
      request.auth,
      'permanently delete your account',
    );

    const data = asRecord(request.data);
    const confirmationUsername = asString(data['confirmationUsername']);

    if (!confirmationUsername || confirmationUsername.length > 40) {
      throw new HttpsError(
        'invalid-argument',
        'Type your full manager name before deleting your account.',
      );
    }

    const userId = request.auth.uid;
    const userRef = db.doc(`users/${userId}`);
    const profileSnapshot = await userRef.get();

    if (!profileSnapshot.exists) {
      throw new HttpsError(
        'not-found',
        'Your RinkRat manager profile could not be found.',
      );
    }

    const profile = profileSnapshot.data() ?? {};
    const username = asString(profile['username']);

    if (confirmationUsername !== username) {
      throw new HttpsError(
        'failed-precondition',
        'The manager name did not exactly match your saved profile.',
        { reason: 'username-mismatch' },
      );
    }

    const readiness = await getAccountDeletionReadinessForUser(userId);

    if (!readiness.canDelete) {
      throw new HttpsError(
        'failed-precondition',
        'Delete each league you commission before deleting your account.',
        {
          reason: 'commissioner-leagues-exist',
          commissionerLeagues: readiness.commissionerLeagues,
        },
      );
    }

    const [membershipSnapshot, teamSnapshot] = await Promise.all([
      db.collectionGroup('members').where('uid', '==', userId).get(),
      db.collectionGroup('teams').where('ownerId', '==', userId).get(),
    ]);
    const leagueIds = new Set<string>();

    for (const document of [...membershipSnapshot.docs, ...teamSnapshot.docs]) {
      const leagueId = getLeagueIdFromNestedDocumentPath(document.ref.path);

      if (leagueId) {
        leagueIds.add(leagueId);
      }
    }

    let anonymizedLeagueCount = 0;

    for (const leagueId of leagueIds) {
      if (await anonymizeDeletedAccountInLeague(leagueId, userId)) {
        anonymizedLeagueCount += 1;
      }
    }

    let deletedDocumentCount = 0;
    const publicProfileRef = db.doc(`publicProfiles/${userId}`);
    const [userSnapshotBeforeDelete, publicProfileSnapshot] = await Promise.all([
      userRef.get(),
      publicProfileRef.get(),
    ]);

    if (userSnapshotBeforeDelete.exists) {
      await db.recursiveDelete(userRef);
      deletedDocumentCount += 1;
    }

    if (publicProfileSnapshot.exists) {
      await publicProfileRef.delete();
      deletedDocumentCount += 1;
    }

    deletedDocumentCount += await deleteTopLevelDocumentsByField(
      'feedbackReports',
      'userId',
      userId,
    );
    deletedDocumentCount += await deleteTopLevelDocumentsByField(
      'clientErrorReports',
      'userId',
      userId,
    );
    deletedDocumentCount += await deleteTopLevelDocumentsByField(
      'injuryEmailQueue',
      'ownerId',
      userId,
    );
    deletedDocumentCount += await deleteTopLevelDocumentsByField(
      'emailNotificationLog',
      'ownerId',
      userId,
    );
    deletedDocumentCount += await deleteTopLevelDocumentsByField(
      'leagueCreationRequests',
      'ownerId',
      userId,
    );
    deletedDocumentCount += await deleteTopLevelDocumentsByField(
      'leagueJoinRequests',
      'ownerId',
      userId,
    );

    const lifecycleStateRef = db.doc(`leagueLifecycleState/${userId}`);
    const [rateLimitSnapshot, platformAdminSnapshot, lifecycleStateSnapshot] = await Promise.all([
      db.doc(`observabilityRateLimits/${userId}`).get(),
      db.doc(`platformAdmins/${userId}`).get(),
      lifecycleStateRef.get(),
    ]);

    if (rateLimitSnapshot.exists) {
      await rateLimitSnapshot.ref.delete();
      deletedDocumentCount += 1;
    }

    if (platformAdminSnapshot.exists) {
      await platformAdminSnapshot.ref.delete();
      deletedDocumentCount += 1;
    }

    if (lifecycleStateSnapshot.exists) {
      await lifecycleStateRef.delete();
      deletedDocumentCount += 1;
    }

    deletedDocumentCount += await deleteTopLevelDocumentsByField(
      'adminAuditLogs',
      'adminId',
      userId,
    );

    await getAuth().deleteUser(userId);

    console.info('RinkRat account permanently deleted.', {
      userId,
      anonymizedLeagueCount,
      deletedDocumentCount,
    });

    return {
      deleted: true,
      anonymizedLeagueCount,
      deletedDocumentCount,
    };
  },
);



const FEEDBACK_CATEGORIES = new Set([
  'competition-integrity',
  'blocked-action',
  'serious-usability',
  'cosmetic',
  'feature-idea',
  'account-privacy',
  'other',
  // Legacy categories remain readable for reports submitted by older clients.
  'bug',
  'confusing',
  'incorrect-result',
  'feature-request'
]);

const BETA_FEEDBACK_STATUSES = new Set([
  'new',
  'investigating',
  'confirmed',
  'fix-next-release',
  'resolved',
  'not-reproducible',
  'deferred'
]);

const BETA_FEEDBACK_SEVERITIES = new Set([
  'integrity',
  'blocker',
  'serious',
  'cosmetic',
  'idea'
]);

function normalizeFeedbackCategory(category: string): string {
  const aliases: Record<string, string> = {
    bug: 'blocked-action',
    confusing: 'serious-usability',
    'incorrect-result': 'competition-integrity',
    'feature-request': 'feature-idea'
  };

  return aliases[category] ?? category;
}

function defaultFeedbackSeverity(category: string): string {
  switch (normalizeFeedbackCategory(category)) {
    case 'competition-integrity':
      return 'integrity';
    case 'blocked-action':
      return 'blocker';
    case 'serious-usability':
    case 'account-privacy':
      return 'serious';
    case 'cosmetic':
      return 'cosmetic';
    case 'feature-idea':
    case 'other':
    default:
      return 'idea';
  }
}

function normalizeBetaRoute(value: unknown): string {
  const rawRoute = asString(value).split(/[?#]/)[0] || '/';

  return rawRoute
    .replace(/\/leagues\/[^/]+/gi, '/leagues/:leagueId')
    .replace(/\/players\/[^/]+/gi, '/players/:playerId')
    .replace(/\/matchups\/[^/]+/gi, '/matchups/:matchupId')
    .replace(/\/assets\/[^/]+/gi, '/assets/:assetKey')
    .replace(/\/users\/[^/]+/gi, '/users/:userId')
    .slice(0, 300);
}

function feedbackLeagueContextReference(leagueId: string): string {
  return leagueId
    ? createHash('sha256')
        .update(`rinkrat-feedback-league:${leagueId}`)
        .digest('hex')
        .slice(0, 16)
    : '';
}

async function enforceUserSubmissionLimit(
  userId: string,
  bucket: 'feedback' | 'clientError',
  maximumCount: number,
  windowMilliseconds: number
): Promise<void> {
  const safeUserId = requireFirestoreDocumentId(userId, 'manager ID', {
    maxBytes: 128,
  });
  const rateLimitRef = db.doc(`observabilityRateLimits/${safeUserId}`);
  const startedAtField = `${bucket}WindowStartedAt`;
  const countField = `${bucket}WindowCount`;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(rateLimitRef);
    const data = snapshot.data() ?? {};
    const now = Timestamp.now();
    const storedStartedAt = data[startedAtField];
    const storedCount = data[countField];
    const windowStartedAt = storedStartedAt instanceof Timestamp
      ? storedStartedAt
      : null;
    const count = typeof storedCount === 'number' ? storedCount : 0;
    const windowExpired = !windowStartedAt ||
      now.toMillis() - windowStartedAt.toMillis() >= windowMilliseconds;

    if (windowExpired) {
      transaction.set(
        rateLimitRef,
        {
          [startedAtField]: now,
          [countField]: 1,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      return;
    }

    if (count >= maximumCount) {
      throw new HttpsError(
        'resource-exhausted',
        'Too many reports were submitted recently. Wait a few minutes and try again.'
      );
    }

    transaction.set(
      rateLimitRef,
      {
        [countField]: count + 1,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\/leagues\/[A-Za-z0-9_-]+/g, '/leagues/:leagueId')
    .replace(/\/players\/[A-Za-z0-9_-]+/g, '/players/:playerId')
    .replace(/([?&](?:inviteCode|code)=)[^&\s]+/gi, '$1[redacted]');
}

function normalizedHeaderValue(
  value: string | string[] | undefined,
  maximumLength: number
): string {
  const normalized = Array.isArray(value)
    ? value.join(', ')
    : value ?? 'unknown';

  return normalized.slice(0, maximumLength);
}

function normalizedClientContext(headers: {
  [key: string]: string | string[] | undefined;
}): {
  userAgent: string;
  language: string;
} {
  return {
    userAgent: normalizedHeaderValue(headers['user-agent'], 300),
    language: normalizedHeaderValue(headers['accept-language'], 120)
  };
}

function normalizeFeedbackTechnicalContext(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const viewport = asString(source['viewportCategory']).slice(0, 24);
  const recentActionSource = asRecord(source['recentAction']);
  const action = asString(recentActionSource['action']).slice(0, 50);
  const outcome = asString(recentActionSource['outcome']).slice(0, 30);
  const durationValue = recentActionSource['durationMilliseconds'];
  const listenerValue = source['listenerCount'];
  const durationMilliseconds = typeof durationValue === 'number' && Number.isFinite(durationValue)
    ? Math.max(0, Math.min(10 * 60 * 1000, Math.round(durationValue)))
    : 0;
  const listenerCount = typeof listenerValue === 'number' && Number.isFinite(listenerValue)
    ? Math.max(0, Math.min(500, Math.round(listenerValue)))
    : 0;

  return {
    releaseLabel: asString(source['releaseLabel']).slice(0, 80),
    buildId: asString(source['buildId']).slice(0, 160),
    route: normalizeBetaRoute(source['route']),
    viewportCategory: [
      'small-phone',
      'phone',
      'tablet',
      'desktop',
      'unknown'
    ].includes(viewport) ? viewport : 'unknown',
    online: source['online'] !== false,
    connectionType: asString(source['connectionType']).slice(0, 24) || 'unknown',
    saveData: source['saveData'] === true,
    appCheckClientStatus: asString(source['appCheckClientStatus']).slice(0, 30) || 'unknown',
    listenerCount,
    recentAction: action && outcome
      ? {
          action,
          outcome,
          durationMilliseconds,
          finishedAt: asString(recentActionSource['finishedAt']).slice(0, 40)
        }
      : null
  };
}


function diagnosticFingerprint(input: {
  category: string;
  source: string;
  route: string;
  message: string;
}): string {
  const normalizedMessage = input.message
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  return createHash('sha256')
    .update([
      input.category.toLowerCase(),
      input.source.toLowerCase(),
      input.route.toLowerCase(),
      normalizedMessage
    ].join('|'))
    .digest('hex')
    .slice(0, 32);
}

export const reportClientError = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public'
  },
  async (request): Promise<{ accepted: boolean; reportId: string }> => {
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'Sign in before sending an automatic error report.'
      );
    }

    await enforceUserSubmissionLimit(
      request.auth.uid,
      'clientError',
      20,
      60 * 60 * 1000
    );

    const data = asRecord(request.data);
    const message = redactDiagnosticText(
      asString(data['message'])
    ).slice(0, 500);
    const stack = redactDiagnosticText(
      asString(data['stack'])
    ).slice(0, 4_000);
    const route = asString(data['route']).slice(0, 300);
    const source = asString(data['source']).slice(0, 60);
    const category = asString(data['category']).slice(0, 60);
    const appVersion = asString(data['appVersion']).slice(0, 80);

    if (!message || !route || !source || !category) {
      throw new HttpsError(
        'invalid-argument',
        'The error report was missing required technical context.'
      );
    }

    const reportId = randomUUID();
    const context = normalizedClientContext(request.rawRequest.headers);
    const fingerprint = diagnosticFingerprint({
      category,
      source,
      route,
      message
    });

    await db.doc(`clientErrorReports/${reportId}`).set({
      reportId,
      fingerprint,
      userId: request.auth.uid,
      authenticated: true,
      message,
      stack,
      route,
      source,
      category,
      appVersion,
      userAgent: context.userAgent,
      language: context.language,
      status: 'new',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(
        Date.now() + (90 * 24 * 60 * 60 * 1000)
      )
    });

    return {
      accepted: true,
      reportId
    };
  }
);

export const submitFeedback = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public'
  },
  async (request): Promise<{ accepted: boolean; feedbackId: string }> => {
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'Sign in before submitting feedback.'
      );
    }

    const userId = resolveSafeFirestoreDocumentId(
      request.auth.uid,
      FIRESTORE_AUTH_USER_ID_OPTIONS,
    );

    if (!userId) {
      throw new HttpsError('unauthenticated', 'Your manager identity is invalid. Sign in again.');
    }

    await enforceUserSubmissionLimit(
      userId,
      'feedback',
      5,
      10 * 60 * 1000
    );

    const data = asRecord(request.data);
    const submittedCategory = asString(data['category']);
    const category = normalizeFeedbackCategory(submittedCategory);
    const summary = redactDiagnosticText(asString(data['summary'])).slice(0, 120);
    const message = redactDiagnosticText(asString(data['message'])).slice(0, 2_000);
    const expectedResult = redactDiagnosticText(
      asString(data['expectedResult'])
    ).slice(0, 1_000);
    const reproductionSteps = redactDiagnosticText(
      asString(data['reproductionSteps'])
    ).slice(0, 1_500);
    const route = normalizeBetaRoute(data['route']);
    const leagueId = optionalFirestoreDocumentId(data['leagueId'], 'league context', {
      minimumLength: 6,
      maxBytes: 128,
      pattern: /^[A-Za-z0-9_-]+$/,
    }) ?? '';
    const allowFollowUp = data['allowFollowUp'] === true;
    const technicalContext = normalizeFeedbackTechnicalContext(data['technicalContext']);

    if (!FEEDBACK_CATEGORIES.has(submittedCategory) || !FEEDBACK_CATEGORIES.has(category)) {
      throw new HttpsError(
        'invalid-argument',
        'Choose a valid feedback category.'
      );
    }

    if (!summary || summary.length > 120) {
      throw new HttpsError(
        'invalid-argument',
        'Add a short report title of 120 characters or fewer.'
      );
    }

    if (!message || message.length > 2_000) {
      throw new HttpsError(
        'invalid-argument',
        'Feedback must contain between 1 and 2,000 characters.'
      );
    }

    if (leagueId) {
      const [leagueSnapshot, memberSnapshot, teamSnapshot] = await Promise.all([
        db.doc(`leagues/${leagueId}`).get(),
        db.doc(`leagues/${leagueId}/members/${userId}`).get(),
        db.doc(`leagues/${leagueId}/teams/${userId}`).get()
      ]);
      const commissionerId = asString(
        (leagueSnapshot.data() ?? {})['commissionerId']
      );
      const hasLeagueAccess = leagueSnapshot.exists && (
        commissionerId === userId ||
        memberSnapshot.exists ||
        teamSnapshot.exists
      );

      if (!hasLeagueAccess) {
        throw new HttpsError(
          'permission-denied',
          'You cannot attach feedback to a league you do not belong to.'
        );
      }
    }

    const feedbackId = randomUUID();
    const context = normalizedClientContext(request.rawRequest.headers);
    const reportedRelease = asString(technicalContext['releaseLabel']).slice(0, 80);
    const buildId = asString(technicalContext['buildId']).slice(0, 160);
    const clientAppCheckStatus = asString(
      technicalContext['appCheckClientStatus']
    ).slice(0, 30) || 'unknown';

    await db.doc(`feedbackReports/${feedbackId}`).set({
      schemaVersion: 2,
      feedbackId,
      userId: userId,
      category,
      severity: defaultFeedbackSeverity(category),
      summary,
      message,
      expectedResult,
      reproductionSteps,
      route,
      routeFamily: route.split('/').filter(Boolean).slice(0, 2).join('/') || 'home',
      hasLeagueContext: Boolean(leagueId),
      leagueContextReference: feedbackLeagueContextReference(leagueId),
      allowFollowUp,
      userAgent: context.userAgent,
      language: context.language,
      browser: browserFamily(context.userAgent),
      technicalContext: {
        ...technicalContext,
        route,
        serverAppCheckStatus: request.app ? 'valid' : 'missing'
      },
      reportedRelease: reportedRelease || 'Unknown release',
      buildId: buildId || 'unknown-build',
      clientAppCheckStatus,
      serverAppCheckStatus: request.app ? 'valid' : 'missing',
      status: 'new',
      owner: '',
      duplicateOf: '',
      resolutionRelease: '',
      adminNotes: '',
      knownIssueId: '',
      knownIssueStatus: '',
      publicTitle: '',
      publicSummary: '',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(
        Date.now() + (365 * 24 * 60 * 60 * 1000)
      )
    });

    return {
      accepted: true,
      feedbackId
    };
  }
);


const ADMIN_FEEDBACK_STATUSES = new Set([
  ...BETA_FEEDBACK_STATUSES,
  // Legacy values remain accepted by old tabs during a staggered Hosting rollout.
  'reviewing',
  'planned',
  'in-progress',
  'not-planned'
]);

const ADMIN_ERROR_STATUSES = new Set([
  'new',
  'investigating',
  'fixed',
  'ignored'
]);

function timestampMilliseconds(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function timestampIso(value: unknown): string | null {
  const milliseconds = timestampMilliseconds(value);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

async function platformAdminRecord(uid: string): Promise<{
  allowed: boolean;
  role: string;
}> {
  const safeUid = requireFirestoreDocumentId(uid, 'platform administrator ID', {
    maxBytes: 128,
  });
  const snapshot = await db.doc(`platformAdmins/${safeUid}`).get();
  const data = snapshot.data() ?? {};

  return {
    allowed: snapshot.exists && data['enabled'] === true,
    role: asString(data['role']) || 'admin'
  };
}

async function requirePlatformAdmin(
  request: {
    auth?: {
      uid: string;
      token: Record<string, unknown>;
    } | null;
  },
  options: {
    requireRecentAuthentication?: boolean;
    actionLabel?: string;
  } = {},
): Promise<{ uid: string; role: string }> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in before opening the Admin Center.');
  }

  const uid = requireFirestoreDocumentId(
    request.auth.uid,
    'platform administrator ID',
    FIRESTORE_AUTH_USER_ID_OPTIONS,
  );
  let role = 'platform-admin';

  if (request.auth.token['platformAdmin'] !== true) {
    const record = await platformAdminRecord(uid);

    if (!record.allowed) {
      throw new HttpsError(
        'permission-denied',
        'This account does not have RinkRat platform-administrator access.'
      );
    }

    role = record.role;
  }

  if (options.requireRecentAuthentication) {
    const actionLabel = options.actionLabel ?? 'change platform administration data';
    requireVerifiedEmailShared(request.auth, actionLabel);
    requireRecentAuthenticationShared(request.auth, actionLabel);
  }

  return { uid, role };
}

function browserFamily(userAgent: string): string {
  const value = userAgent.toLowerCase();

  if (value.includes('edg/')) return 'Edge';
  if (value.includes('firefox/')) return 'Firefox';
  if (value.includes('chrome/') && !value.includes('edg/')) return 'Chrome';
  if (value.includes('safari/') && !value.includes('chrome/')) return 'Safari';
  return 'Other';
}

function normalizeAdminFeedbackStatus(value: unknown): string {
  const status = asString(value);
  const aliases: Record<string, string> = {
    reviewing: 'investigating',
    planned: 'confirmed',
    'in-progress': 'fix-next-release',
    'not-planned': 'deferred'
  };
  const normalized = aliases[status] ?? status;
  return BETA_FEEDBACK_STATUSES.has(normalized) ? normalized : 'new';
}

function normalizeAdminFeedbackSeverity(value: unknown, category: string): string {
  const severity = asString(value);
  return BETA_FEEDBACK_SEVERITIES.has(severity)
    ? severity
    : defaultFeedbackSeverity(category);
}

async function lookupUserEmails(userIds: string[]): Promise<Map<string, string>> {
  const emailByUserId = new Map<string, string>();
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

  for (let index = 0; index < uniqueUserIds.length; index += 100) {
    const chunk = uniqueUserIds.slice(index, index + 100);
    const result = await getAuth().getUsers(chunk.map((uid) => ({ uid })));

    for (const userRecord of result.users) {
      if (userRecord.email) {
        emailByUserId.set(userRecord.uid, userRecord.email);
      }
    }
  }

  return emailByUserId;
}

export const getPlatformAdminAccess = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 20,
    memory: '256MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public'
  },
  async (request): Promise<{ allowed: boolean; role: string }> => {
    if (!request.auth) {
      return { allowed: false, role: '' };
    }

    if (request.auth.token['platformAdmin'] === true) {
      return { allowed: true, role: 'platform-admin' };
    }

    return platformAdminRecord(request.auth.uid);
  }
);

export const getAdminInbox = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public'
  },
  async (request): Promise<{
    generatedAt: string;
    releaseLabel: string;
    feedback: Array<Record<string, unknown>>;
    errorGroups: Array<Record<string, unknown>>;
    summary: Record<string, number | string>;
  }> => {
    await requirePlatformAdmin(request);

    const [feedbackSnapshot, errorSnapshot, reviewSnapshot] = await Promise.all([
      db.collection('feedbackReports').orderBy('createdAt', 'desc').limit(150).get(),
      db.collection('clientErrorReports').orderBy('createdAt', 'desc').limit(500).get(),
      db.collection('adminErrorReviews').get()
    ]);

    const errorReviews = new Map<string, DocumentData>();
    for (const reviewDoc of reviewSnapshot.docs) {
      errorReviews.set(reviewDoc.id, reviewDoc.data());
    }

    const rawErrors = errorSnapshot.docs.map((document) => {
      const data = document.data();
      const category = asString(data['category']) || 'unknown';
      const source = asString(data['source']) || 'unknown';
      const route = asString(data['route']) || '/';
      const message = asString(data['message']) || 'Unknown client error';
      const fingerprint = asString(data['fingerprint']) || diagnosticFingerprint({
        category,
        source,
        route,
        message
      });

      return {
        reportId: document.id,
        fingerprint,
        userId: asString(data['userId']),
        category,
        source,
        route,
        message,
        stack: asString(data['stack']),
        appVersion: asString(data['appVersion']) || 'unknown',
        userAgent: asString(data['userAgent']),
        createdAtMs: timestampMilliseconds(data['createdAt']),
        createdAt: timestampIso(data['createdAt'])
      };
    });

    const groupedErrors = new Map<string, {
      fingerprint: string;
      category: string;
      source: string;
      route: string;
      message: string;
      sampleStack: string;
      occurrenceCount: number;
      affectedUsers: Set<string>;
      releases: Set<string>;
      browsers: Map<string, number>;
      firstSeenMs: number;
      lastSeenMs: number;
      latestReportId: string;
    }>();

    for (const error of rawErrors) {
      const existing = groupedErrors.get(error.fingerprint);
      const browser = browserFamily(error.userAgent);

      if (!existing) {
        groupedErrors.set(error.fingerprint, {
          fingerprint: error.fingerprint,
          category: error.category,
          source: error.source,
          route: error.route,
          message: error.message,
          sampleStack: error.stack,
          occurrenceCount: 1,
          affectedUsers: new Set(error.userId ? [error.userId] : []),
          releases: new Set([error.appVersion]),
          browsers: new Map([[browser, 1]]),
          firstSeenMs: error.createdAtMs,
          lastSeenMs: error.createdAtMs,
          latestReportId: error.reportId
        });
        continue;
      }

      existing.occurrenceCount += 1;
      if (error.userId) existing.affectedUsers.add(error.userId);
      existing.releases.add(error.appVersion);
      existing.browsers.set(browser, (existing.browsers.get(browser) ?? 0) + 1);
      existing.firstSeenMs = Math.min(existing.firstSeenMs || error.createdAtMs, error.createdAtMs);

      if (error.createdAtMs >= existing.lastSeenMs) {
        existing.lastSeenMs = error.createdAtMs;
        existing.sampleStack = error.stack || existing.sampleStack;
        existing.latestReportId = error.reportId;
      }
    }

    const feedbackDocuments = feedbackSnapshot.docs.map((document) => ({
      id: document.id,
      data: document.data()
    }));
    const emailByUserId = await lookupUserEmails(
      feedbackDocuments
        .filter(({ data }) => data['allowFollowUp'] === true)
        .map(({ data }) => asString(data['userId']))
    );

    const feedback = feedbackDocuments.map(({ id, data }) => {
      const createdAtMs = timestampMilliseconds(data['createdAt']);
      const userId = asString(data['userId']);
      const category = normalizeFeedbackCategory(asString(data['category']) || 'other');
      const route = normalizeBetaRoute(data['route']);
      const technicalContext = asRecord(data['technicalContext']);
      const recentAction = asRecord(technicalContext['recentAction']);
      const relatedErrors = rawErrors.filter((error) =>
        error.userId === userId &&
        normalizeBetaRoute(error.route) === route &&
        Math.abs(error.createdAtMs - createdAtMs) <= 30 * 60 * 1000
      );
      const legacyLeagueId = asString(data['leagueId']);
      const userAgent = asString(data['userAgent']);

      return {
        feedbackId: id,
        category,
        severity: normalizeAdminFeedbackSeverity(data['severity'], category),
        summary: asString(data['summary']).slice(0, 120) ||
          asString(data['message']).slice(0, 120) ||
          'Untitled beta report',
        message: asString(data['message']).slice(0, 2_000),
        expectedResult: asString(data['expectedResult']).slice(0, 1_000),
        reproductionSteps: asString(data['reproductionSteps']).slice(0, 1_500),
        route,
        hasLeagueContext: data['hasLeagueContext'] === true || Boolean(legacyLeagueId),
        leagueContextReference: asString(data['leagueContextReference']).slice(0, 32) ||
          feedbackLeagueContextReference(legacyLeagueId),
        allowFollowUp: data['allowFollowUp'] === true,
        followUpEmail: data['allowFollowUp'] === true
          ? emailByUserId.get(userId) ?? null
          : null,
        status: normalizeAdminFeedbackStatus(data['status']),
        owner: asString(data['owner']).slice(0, 80),
        duplicateOf: asString(data['duplicateOf']).slice(0, 80),
        resolutionRelease: asString(data['resolutionRelease']).slice(0, 80),
        knownIssueId: asString(data['knownIssueId']).slice(0, 80),
        knownIssueStatus: asString(data['knownIssueStatus']).slice(0, 30),
        publicTitle: asString(data['publicTitle']).slice(0, 120),
        publicSummary: asString(data['publicSummary']).slice(0, 600),
        adminNotes: asString(data['adminNotes']).slice(0, 2_000),
        reportedRelease: asString(data['reportedRelease']).slice(0, 80) || 'Unknown release',
        buildId: asString(data['buildId']).slice(0, 160) || 'unknown-build',
        clientAppCheckStatus: asString(data['clientAppCheckStatus']).slice(0, 30) ||
          asString(technicalContext['appCheckClientStatus']).slice(0, 30) ||
          'unknown',
        serverAppCheckStatus: asString(data['serverAppCheckStatus']).slice(0, 30) ||
          asString(technicalContext['serverAppCheckStatus']).slice(0, 30) ||
          'unknown',
        technicalContext: {
          viewportCategory: asString(technicalContext['viewportCategory']).slice(0, 24) || 'unknown',
          online: technicalContext['online'] !== false,
          connectionType: asString(technicalContext['connectionType']).slice(0, 24) || 'unknown',
          saveData: technicalContext['saveData'] === true,
          listenerCount: typeof technicalContext['listenerCount'] === 'number'
            ? Math.max(0, Math.min(500, Math.round(technicalContext['listenerCount'])))
            : 0,
          recentAction: Object.keys(recentAction).length > 0
            ? {
                action: asString(recentAction['action']).slice(0, 50),
                outcome: asString(recentAction['outcome']).slice(0, 30),
                durationMilliseconds: typeof recentAction['durationMilliseconds'] === 'number'
                  ? Math.max(0, Math.min(10 * 60 * 1000, Math.round(recentAction['durationMilliseconds'])))
                  : 0,
                finishedAt: asString(recentAction['finishedAt']).slice(0, 40)
              }
            : null
        },
        browser: asString(data['browser']).slice(0, 40) || browserFamily(userAgent),
        createdAt: timestampIso(data['createdAt']),
        updatedAt: timestampIso(data['updatedAt']),
        relatedErrorCount: relatedErrors.length,
        relatedErrorCategories: [...new Set(relatedErrors.map((error) => error.category))].slice(0, 5)
      };
    });

    const errorGroups = [...groupedErrors.values()]
      .map((group) => {
        const review = errorReviews.get(group.fingerprint) ?? {};
        const topBrowsers = [...group.browsers.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 4)
          .map(([name, count]) => ({ name, count }));

        return {
          fingerprint: group.fingerprint,
          category: group.category,
          source: group.source,
          route: group.route,
          message: group.message,
          sampleStack: group.sampleStack,
          occurrenceCount: group.occurrenceCount,
          affectedUserCount: group.affectedUsers.size,
          releases: [...group.releases].slice(0, 10),
          browsers: topBrowsers,
          firstSeenAt: group.firstSeenMs > 0 ? new Date(group.firstSeenMs).toISOString() : null,
          lastSeenAt: group.lastSeenMs > 0 ? new Date(group.lastSeenMs).toISOString() : null,
          latestReportId: group.latestReportId,
          status: asString(review['status']) || 'new',
          adminNotes: asString(review['adminNotes'])
        };
      })
      .sort((left, right) =>
        String(right.lastSeenAt ?? '').localeCompare(String(left.lastSeenAt ?? ''))
      );

    const newFeedbackCount = feedback.filter((item) => item.status === 'new').length;
    const openFeedbackCount = feedback.filter((item) =>
      item.status !== 'resolved' && item.status !== 'not-reproducible' && item.status !== 'deferred'
    ).length;
    const integrityFeedbackCount = feedback.filter((item) => item.severity === 'integrity').length;
    const blockerFeedbackCount = feedback.filter((item) => item.severity === 'blocker').length;
    const unresolvedErrorCount = errorGroups.filter((item) =>
      item.status !== 'fixed' && item.status !== 'ignored'
    ).length;
    const releases = [
      ...feedback.map((item) => String(item.reportedRelease ?? '')).filter(Boolean),
      ...errorGroups.flatMap((item) => item.releases as string[])
    ];
    const releaseLabel = releases[0] ?? 'No captured release';

    return {
      generatedAt: new Date().toISOString(),
      releaseLabel,
      feedback,
      errorGroups,
      summary: {
        newFeedbackCount,
        openFeedbackCount,
        integrityFeedbackCount,
        blockerFeedbackCount,
        totalFeedbackCount: feedback.length,
        unresolvedErrorCount,
        totalErrorGroupCount: errorGroups.length,
        capturedErrorCount: rawErrors.length
      }
    };
  }
);

export const updateAdminFeedback = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public'
  },
  async (request): Promise<{ updated: boolean }> => {
    const admin = await requirePlatformAdmin(request, {
      requireRecentAuthentication: true,
      actionLabel: 'change a feedback review',
    });
    const data = asRecord(request.data);
    const feedbackId = requireFirestoreDocumentId(
      data['feedbackId'],
      'feedback reference',
      {
        minimumLength: 10,
        maxBytes: 80,
        pattern: /^[A-Za-z0-9-]+$/,
      },
    );
    const status = asString(data['status']);
    const adminNotes = asString(data['adminNotes']).trim().slice(0, 2_000);

    if (!ADMIN_FEEDBACK_STATUSES.has(status)) {
      throw new HttpsError('invalid-argument', 'Choose a valid feedback status.');
    }

    const reference = db.doc(`feedbackReports/${feedbackId}`);
    const snapshot = await reference.get();

    if (!snapshot.exists) {
      throw new HttpsError('not-found', 'That feedback report no longer exists.');
    }

    await reference.set({
      status,
      adminNotes,
      reviewedBy: admin.uid,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('adminAuditLogs').add({
      action: 'feedback-status-updated',
      targetId: feedbackId,
      status,
      adminId: admin.uid,
      createdAt: FieldValue.serverTimestamp()
    });

    return { updated: true };
  }
);

export const updateAdminErrorReview = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public'
  },
  async (request): Promise<{ updated: boolean }> => {
    const admin = await requirePlatformAdmin(request, {
      requireRecentAuthentication: true,
      actionLabel: 'change an error review',
    });
    const data = asRecord(request.data);
    const fingerprint = requireFirestoreDocumentId(
      data['fingerprint'],
      'error-group reference',
      {
        minimumLength: 32,
        maxBytes: 32,
        pattern: /^[a-f0-9]{32}$/,
      },
    );
    const status = asString(data['status']);
    const adminNotes = asString(data['adminNotes']).trim().slice(0, 2_000);

    if (!ADMIN_ERROR_STATUSES.has(status)) {
      throw new HttpsError('invalid-argument', 'Choose a valid error status.');
    }

    await db.doc(`adminErrorReviews/${fingerprint}`).set({
      fingerprint,
      status,
      adminNotes,
      reviewedBy: admin.uid,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('adminAuditLogs').add({
      action: 'error-status-updated',
      targetId: fingerprint,
      status,
      adminId: admin.uid,
      createdAt: FieldValue.serverTimestamp()
    });

    return { updated: true };
  }
);

export {
  advanceHistoricalReplayDay,
  bootstrapLeagueAutomationSchedules,
  cleanupLeagueAutomationTaskHistory,
  clearExpiredOrErroredLiveScoringLease,
  dispatchDueLeagueAutomation,
  getLeagueAutomationQueueControlCenter,
  initializeSeasonAfterDraft,
  openNextCompetitionPeriod,
  processHistoricalReplayAdvance,
  processLeagueAutomationTask,
  queueLeagueAutomationCanaryCheck,
  recoverStaleLeagueAutomationQueue,
  recoverStaleHistoricalReplayQueue,
  releaseLeagueLiveScoringHandoff,
  requestLeagueLiveScoringRefresh,
  runScheduledLeagueAutomation,
  runSeasonStartAutomation,
  updateLeagueAutomationQueueConfig,
} from './league-automation';

export {
  continueServerDraftAutomation,
  processAutoDraftQueueChange,
  processDraftClockDeadline,
  reconcileDraftTurnAfterCommittedPick,
  runScheduledDraftAutomation,
} from './draft-automation';

export {
  executeDraftCommand,
  makeSecureDraftPick,
  repairDraftTurnHandoff,
} from './draft-authority';

export {
  createLeagueSecure,
  joinLeagueSecure,
  migrateLeagueAuthoritySchema,
  updateLeagueCosmeticsSecure,
} from './league-lifecycle-authority';


export {
  manageProjectionSnapshotIntegrity,
  processProjectionGenerationTask,
  recoverStaleProjectionGenerationRequests,
  requestProjectionSnapshotGeneration,
} from './projection-authority';


export {
  cleanupExpiredSecurityData,
  collectCspReport,
} from './security-operations';

export {
  getBetaOperationsSnapshot,
  getPublicBetaKnownIssues,
  recordBetaOperationMetric,
  updateBetaFeedbackTriage,
} from './beta-operations';

export { getSecurityControlReadiness } from './security-authority';

export {
  getAppCheckCallableCanaryControl,
  updateAppCheckCallableCanaryControl,
} from './app-check-canary-authority';

export { saveManagerProfile } from './manager-profile-authority';

export { applyImmediateRosterMove } from './roster-moves';

export {
  ensureFantasyRoster,
  executeSecureRosterAction,
} from './roster-authority';

export {
  processQueuedInjuryEmails,
  requestPasswordResetEmail,
  resendVerificationEmail,
  sendInjuryEmailOnAvailabilityChange,
  sendInjuryEmailsOnGlobalAvailabilityChange,
  sendTestInjuryEmail,
  sendWelcomeEmailOnProfileCreated,
} from './email-notifications';

export {
  publishLeagueAnnouncement,
  publishLeagueAuditActivity,
  publishLeagueAvailabilityOverrideActivity,
  publishLeagueDraftControlActivity,
  publishLeagueDraftPickActivity,
  publishLeagueMatchupResultActivity,
  publishLeagueRoundRecapActivity,
  publishLeagueTransactionActivity,
  publishLeagueWaiverPrivacy,
  setLeagueActivityReaction,
  unpinLeagueAnnouncement,
} from './league-activity';
