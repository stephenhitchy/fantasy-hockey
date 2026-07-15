import { randomUUID } from 'node:crypto';

import { initializeApp } from 'firebase-admin/app';
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
  onCall
} from 'firebase-functions/v2/https';

initializeApp();

const db = getFirestore();

const ESPN_NHL_INJURIES_URL =
  'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries';

const NHL_API_BASE_URL = 'https://api-web.nhle.com/v1';
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

  return response.json();
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

function matchInjuriesToPlayers(
  injuries: EspnInjuryEntry[],
  players: NhlSkater[]
): {
  matches: MatchedInjury[];
  unmatchedNames: string[];
  skippedGoalieCount: number;
} {
  const playersByName = new Map<string, NhlSkater[]>();

  for (const player of players) {
    const key = normalizeText(player.fullName);
    const candidates = playersByName.get(key) ?? [];
    candidates.push(player);
    playersByName.set(key, candidates);
  }

  const matchedByPlayerId = new Map<number, MatchedInjury>();
  const unmatchedNames = new Set<string>();
  let skippedGoalieCount = 0;

  for (const injury of injuries) {
    if (injury.position.toUpperCase() === 'G') {
      skippedGoalieCount += 1;
      continue;
    }

    let candidates = playersByName.get(
      normalizeText(injury.playerName)
    ) ?? [];

    if (candidates.length > 1 && injury.position) {
      const matchingPosition = candidates.filter(
        (candidate) =>
          candidate.position === injury.position.toUpperCase()
      );

      if (matchingPosition.length > 0) {
        candidates = matchingPosition;
      }
    }

    if (candidates.length > 1 && injury.teamName) {
      const teamAbbreviation =
        getEspnTeamAbbreviation(injury.teamName);

      const matchingTeam = candidates.filter(
        (candidate) =>
          candidate.nhlTeamAbbreviation === teamAbbreviation
      );

      if (matchingTeam.length > 0) {
        candidates = matchingTeam;
      }
    }

    if (candidates.length !== 1) {
      unmatchedNames.add(injury.playerName);
      continue;
    }

    const player = candidates[0];
    const existing = matchedByPlayerId.get(player.id);

    matchedByPlayerId.set(player.id, {
      player,
      injury: existing
        ? chooseStrongerInjury(existing.injury, injury)
        : injury
    });
  }

  return {
    matches: [...matchedByPlayerId.values()],
    unmatchedNames: [...unmatchedNames].sort(
      (first, second) => first.localeCompare(second)
    ),
    skippedGoalieCount
  };
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

  return db.runTransaction(async (transaction) => {
    const lockSnapshot = await transaction.get(lockRef);
    const syncSnapshot = await transaction.get(syncRef);
    const lockData = lockSnapshot.data() ?? {};
    const syncData = syncSnapshot.data() ?? {};

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

export const refreshDailyPlayerAvailability = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 180,
    memory: '512MiB',
    maxInstances: 4,
    concurrency: 10,
    cors: true,
    invoker: 'public'
  },
  async (request): Promise<DailyRefreshResult> => {
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'You must be logged in to refresh injuries.'
      );
    }

    const leagueId = asString(
      asRecord(request.data)['leagueId']
    );

    if (
      !leagueId ||
      leagueId.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(leagueId)
    ) {
      throw new HttpsError(
        'invalid-argument',
        'A valid league ID is required.'
      );
    }

    const userId = request.auth.uid;
    const dailyKey = getUtcDailyKey();
    const attemptId = randomUUID();

    await verifyLeagueMembership(leagueId, userId);

    const claim = await claimDailyRefresh(
      leagueId,
      userId,
      dailyKey,
      attemptId
    );

    if (claim.status === 'already-current') {
      return buildSkippedResult(
        'already-current',
        dailyKey,
        'Today’s shared injury report is already ready.',
        claim.syncData,
        claim.completedAt
      );
    }

    if (claim.status === 'in-progress') {
      return buildSkippedResult(
        'in-progress',
        dailyKey,
        'Another league member already started today’s injury refresh.',
        claim.syncData,
        ''
      );
    }

    if (claim.status === 'cooldown') {
      return buildSkippedResult(
        'cooldown',
        dailyKey,
        'A recent refresh attempt failed. The last saved report is being used before another retry is allowed.',
        claim.syncData,
        claim.completedAt
      );
    }

    const lockRef = db.doc(
      `leagues/${leagueId}/playerAvailabilityDaily/${dailyKey}`
    );

    const syncRef = db.doc(
      `leagues/${leagueId}/playerAvailabilitySync/current`
    );

    try {
      const [players, espnPayload] = await Promise.all([
        loadCurrentNhlSkaters(),
        fetchJson(ESPN_NHL_INJURIES_URL)
      ]);

      const parsed = parseEspnInjuries(espnPayload);

      if (parsed.entries.length === 0) {
        throw new Error(
          'ESPN returned no NHL injury entries, so the existing report was left unchanged.'
        );
      }

      const matchResult = matchInjuriesToPlayers(
        parsed.entries,
        players
      );

      const availabilityCollection = db.collection(
        `leagues/${leagueId}/playerAvailability`
      );

      const existingSnapshot =
        await availabilityCollection.get();

      const existingByPlayerId =
        new Map<number, {
          source: string;
          reference: DocumentReference;
        }>();

      for (const document of existingSnapshot.docs) {
        const data = document.data();
        const playerId = data['playerId'];

        if (typeof playerId !== 'number') {
          continue;
        }

        existingByPlayerId.set(playerId, {
          source:
            data['source'] === 'espn'
              ? 'espn'
              : 'commissioner',
          reference: document.ref
        });
      }

      const matchedPlayerIds = new Set<number>();
      const pendingWrites: PendingWrite[] = [];
      let syncedRecordCount = 0;
      let preservedManualOverrideCount = 0;

      for (const match of matchResult.matches) {
        matchedPlayerIds.add(match.player.id);

        const existing =
          existingByPlayerId.get(match.player.id);

        if (existing?.source === 'commissioner') {
          preservedManualOverrideCount += 1;
          continue;
        }

        pendingWrites.push({
          type: 'set',
          reference: availabilityCollection.doc(
            String(match.player.id)
          ),
          data: {
            playerId: match.player.id,
            playerName: match.player.fullName,
            status: match.injury.normalizedStatus,
            note: buildAvailabilityNote(match.injury),
            irEligible: isPlayerIrEligible(
              match.injury.normalizedStatus
            ),
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: userId,
            source: 'espn',
            leagueId,
            externalSource: 'ESPN',
            externalStatus:
              match.injury.rawStatus ||
              match.injury.fantasyStatus ||
              match.injury.injuryType ||
              'Unknown',
            externalReturnDate:
              match.injury.returnDate,
            externalInjuryDate:
              match.injury.injuryDate,
            externalTeamName:
              match.injury.teamName,
            syncedAt: FieldValue.serverTimestamp()
          }
        });

        syncedRecordCount += 1;
      }

      const feedLooksCompleteEnoughToClear =
        parsed.teamEntryCount >= 10 ||
        parsed.entries.length >= 20;

      let clearedRecordCount = 0;

      if (feedLooksCompleteEnoughToClear) {
        for (
          const [playerId, existing] of
          existingByPlayerId
        ) {
          if (
            existing.source === 'espn' &&
            !matchedPlayerIds.has(playerId)
          ) {
            pendingWrites.push({
              type: 'delete',
              reference: existing.reference
            });

            clearedRecordCount += 1;
          }
        }
      }

      await commitPendingWrites(pendingWrites);

      const completedAt = new Date();
      const unmatchedCount =
        matchResult.unmatchedNames.length;

      const messageParts = [
        `Updated today’s report with ${matchResult.matches.length} matched injured skaters.`,
        `Saved ${syncedRecordCount} automatic records.`,
        `Preserved ${preservedManualOverrideCount} commissioner overrides.`
      ];

      if (clearedRecordCount > 0) {
        messageParts.push(
          `Cleared ${clearedRecordCount} players no longer listed by ESPN.`
        );
      }

      if (!feedLooksCompleteEnoughToClear) {
        messageParts.push(
          'The ESPN feed was sparse, so older automatic records were preserved.'
        );
      }

      if (unmatchedCount > 0) {
        messageParts.push(
          `${unmatchedCount} injury names could not be matched to current NHL rosters.`
        );
      }

      const message = messageParts
        .join(' ')
        .slice(0, 500);

      await Promise.all([
        lockRef.set(
          {
            status: 'success',
            dailyKey,
            attemptId,
            requestedBy: userId,
            completedAt,
            fetchedCount: parsed.entries.length,
            matchedCount:
              matchResult.matches.length,
            unmatchedCount,
            syncedRecordCount,
            clearedRecordCount,
            preservedManualOverrideCount,
            skippedGoalieCount:
              matchResult.skippedGoalieCount,
            message,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        ),
        syncRef.set(
          {
            source: 'ESPN',
            status: 'success',
            trigger: 'daily-visit',
            dailyKey,
            lastDailySyncKey: dailyKey,
            lastAttemptAt:
              FieldValue.serverTimestamp(),
            lastSuccessfulSyncAt:
              FieldValue.serverTimestamp(),
            lastDailySuccessfulSyncAt:
              FieldValue.serverTimestamp(),
            updatedBy: userId,
            fetchedCount: parsed.entries.length,
            matchedCount:
              matchResult.matches.length,
            unmatchedCount,
            syncedRecordCount,
            clearedRecordCount,
            preservedManualOverrideCount,
            skippedGoalieCount:
              matchResult.skippedGoalieCount,
            message
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
        syncedRecordCount,
        clearedRecordCount,
        preservedManualOverrideCount,
        skippedGoalieCount:
          matchResult.skippedGoalieCount
      };
    } catch (error: unknown) {
      const message = (
        error instanceof Error
          ? error.message
          : 'Unable to refresh NHL injury data.'
      ).slice(0, 500);

      await Promise.all([
        lockRef.set(
          {
            status: 'error',
            dailyKey,
            attemptId,
            requestedBy: userId,
            lastAttemptAt:
              FieldValue.serverTimestamp(),
            message,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        ),
        syncRef.set(
          {
            source: 'ESPN',
            status: 'error',
            trigger: 'daily-visit',
            dailyKey,
            lastAttemptAt:
              FieldValue.serverTimestamp(),
            updatedBy: userId,
            message
          },
          { merge: true }
        )
      ]);

      throw new HttpsError(
        'unavailable',
        message
      );
    }
  }
);
