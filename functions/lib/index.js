"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshDailyPlayerAvailability = exports.nhlApiProxy = void 0;
const node_crypto_1 = require("node:crypto");
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
(0, app_1.initializeApp)();
const db = (0, firestore_1.getFirestore)();
const ESPN_NHL_INJURIES_URL = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries';
const NHL_API_BASE_URL = 'https://api-web.nhle.com/v1';
const NHL_WEB_API_ORIGIN = 'https://api-web.nhle.com';
const NHL_STATS_API_ORIGIN = 'https://api.nhle.com';
const NHL_PROXY_TIMEOUT_MS = 20_000;
const NHL_PROXY_PATH_PATTERNS = [
    /^\/v1\/player\/\d+\/game-log\/\d{8}\/2$/,
    /^\/v1\/club-schedule-season\/[a-z]{3}\/\d{8}$/,
    /^\/v1\/gamecenter\/\d+\/(boxscore|play-by-play)$/,
    /^\/v1\/roster\/[a-z]{3}\/(current|\d{8})$/,
    /^\/stats\/rest\/en\/skater\/(summary|realtime)$/,
    /^\/stats\/rest\/en\/goalie\/summary$/
];
function getNhlProxyTarget(originalUrl) {
    const requestUrl = new URL(originalUrl, 'https://cycle-puck-proxy.local');
    const path = requestUrl.pathname;
    if (!NHL_PROXY_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
        return null;
    }
    const origin = path.startsWith('/v1/')
        ? NHL_WEB_API_ORIGIN
        : NHL_STATS_API_ORIGIN;
    return new URL(`${path}${requestUrl.search}`, origin);
}
function getNhlProxyCacheControl(path) {
    if (path.includes('/gamecenter/')) {
        return 'public, max-age=8, s-maxage=12';
    }
    if (path.includes('/club-schedule-season/')) {
        return 'public, max-age=60, s-maxage=300';
    }
    if (path.includes('/roster/')) {
        return 'public, max-age=300, s-maxage=1800';
    }
    return 'public, max-age=120, s-maxage=600';
}
const MAX_NOTE_LENGTH = 500;
const MAX_BATCH_WRITES = 400;
const RUNNING_LEASE_MINUTES = 10;
const ERROR_COOLDOWN_MINUTES = 15;
const FUNCTION_REGION = 'us-central1';
const STATUS_STRENGTH = {
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
];
const ESPN_TEAM_ABBREVIATIONS = {
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
function asRecord(value) {
    return value && typeof value === 'object'
        ? value
        : {};
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function normalizeText(value) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}
function getUtcDailyKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}
function getTimestampDate(value) {
    if (value instanceof firestore_1.Timestamp) {
        return value.toDate();
    }
    if (value instanceof Date) {
        return value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (value &&
        typeof value === 'object' &&
        'toDate' in value &&
        typeof value.toDate === 'function') {
        return value.toDate();
    }
    return null;
}
function getIsoTimestamp(value) {
    return getTimestampDate(value)?.toISOString() ?? '';
}
function isRecentTimestamp(value, maximumAgeMinutes) {
    const date = getTimestampDate(value);
    if (!date) {
        return false;
    }
    return Date.now() - date.getTime() <
        maximumAgeMinutes * 60_000;
}
function isTimestampOnDailyKey(value, dailyKey) {
    const date = getTimestampDate(value);
    return Boolean(date &&
        getUtcDailyKey(date) === dailyKey);
}
function getCount(data, field) {
    return typeof data[field] === 'number'
        ? data[field]
        : 0;
}
function buildSkippedResult(status, dailyKey, message, syncData, completedAt) {
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
        preservedManualOverrideCount: getCount(syncData, 'preservedManualOverrideCount'),
        skippedGoalieCount: getCount(syncData, 'skippedGoalieCount')
    };
}
function getCurrentRosterSeason() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const seasonStartYear = month >= 7
        ? year
        : year - 1;
    return `${seasonStartYear}${seasonStartYear + 1}`;
}
function getDraftPosition(positionCode) {
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
async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'User-Agent': 'fantasy-hockey-injury-sync/1.0'
        }
    });
    if (!response.ok) {
        throw new Error(`Request failed with ${response.status} ${response.statusText}.`);
    }
    return response.json();
}
async function fetchNhlRoster(clubAbbreviation) {
    const season = getCurrentRosterSeason();
    const club = clubAbbreviation.toLowerCase();
    try {
        return await fetchJson(`${NHL_API_BASE_URL}/roster/${club}/${season}`);
    }
    catch (seasonError) {
        try {
            return await fetchJson(`${NHL_API_BASE_URL}/roster/${club}/current`);
        }
        catch {
            const message = seasonError instanceof Error
                ? seasonError.message
                : 'Unknown NHL roster error.';
            throw new Error(`${clubAbbreviation} roster could not be loaded: ${message}`);
        }
    }
}
function addRosterSkaters(destination, clubAbbreviation, roster) {
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
        const fullName = [
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
            nhlTeamAbbreviation: player.currentTeamAbbrev ?? clubAbbreviation
        });
    }
}
async function loadCurrentNhlSkaters() {
    const skaters = new Map();
    const failures = [];
    const batchSize = 4;
    for (let startIndex = 0; startIndex < NHL_DRAFT_CLUBS.length; startIndex += batchSize) {
        const clubs = NHL_DRAFT_CLUBS.slice(startIndex, startIndex + batchSize);
        const results = await Promise.allSettled(clubs.map(async (club) => ({
            club,
            roster: await fetchNhlRoster(club)
        })));
        results.forEach((result, index) => {
            const club = clubs[index];
            if (result.status === 'fulfilled') {
                addRosterSkaters(skaters, result.value.club, result.value.roster);
            }
            else {
                failures.push(`${club}: ${result.reason instanceof Error
                    ? result.reason.message
                    : 'Unknown error'}`);
            }
        });
    }
    if (failures.length > 4) {
        throw new Error(`Too many NHL rosters failed to load. ${failures.slice(0, 4).join(' | ')}`);
    }
    if (skaters.size === 0) {
        throw new Error('The NHL roster service returned no draftable skaters.');
    }
    return [...skaters.values()];
}
function getEspnTeamAbbreviation(teamName) {
    return ESPN_TEAM_ABBREVIATIONS[normalizeText(teamName)] ?? '';
}
function normalizeEspnStatus(input) {
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
    if (/day[- ]to[- ]day|questionable|doubtful|probable|game[- ]time decision/.test(combined)) {
        return 'day-to-day';
    }
    if (/\bout\b|inactive|unavailable/.test(combined)) {
        return 'out';
    }
    return 'unknown';
}
function parseEspnInjuries(payload) {
    const topLevel = asRecord(payload);
    const teamEntries = asArray(topLevel['injuries']);
    const entries = [];
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
            const entry = {
                playerName,
                position: asString(position['abbreviation']),
                teamName,
                rawStatus: asString(injury['status']),
                injuryDate: asString(injury['date']),
                returnDate: asString(details['returnDate']),
                shortComment: asString(injury['shortComment']),
                longComment: asString(injury['longComment']),
                injuryType: asString(injuryType['name']) ||
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
function chooseStrongerInjury(first, second) {
    const firstStrength = STATUS_STRENGTH[first.normalizedStatus];
    const secondStrength = STATUS_STRENGTH[second.normalizedStatus];
    if (secondStrength !== firstStrength) {
        return secondStrength > firstStrength
            ? second
            : first;
    }
    const firstCommentLength = (first.longComment || first.shortComment).length;
    const secondCommentLength = (second.longComment || second.shortComment).length;
    return secondCommentLength > firstCommentLength
        ? second
        : first;
}
function matchInjuriesToPlayers(injuries, players) {
    const playersByName = new Map();
    for (const player of players) {
        const key = normalizeText(player.fullName);
        const candidates = playersByName.get(key) ?? [];
        candidates.push(player);
        playersByName.set(key, candidates);
    }
    const matchedByPlayerId = new Map();
    const unmatchedNames = new Set();
    let skippedGoalieCount = 0;
    for (const injury of injuries) {
        if (injury.position.toUpperCase() === 'G') {
            skippedGoalieCount += 1;
            continue;
        }
        let candidates = playersByName.get(normalizeText(injury.playerName)) ?? [];
        if (candidates.length > 1 && injury.position) {
            const matchingPosition = candidates.filter((candidate) => candidate.position === injury.position.toUpperCase());
            if (matchingPosition.length > 0) {
                candidates = matchingPosition;
            }
        }
        if (candidates.length > 1 && injury.teamName) {
            const teamAbbreviation = getEspnTeamAbbreviation(injury.teamName);
            const matchingTeam = candidates.filter((candidate) => candidate.nhlTeamAbbreviation === teamAbbreviation);
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
        unmatchedNames: [...unmatchedNames].sort((first, second) => first.localeCompare(second)),
        skippedGoalieCount
    };
}
function isPlayerIrEligible(status) {
    return (status === 'out' ||
        status === 'injured-reserve' ||
        status === 'long-term-injured-reserve');
}
function buildAvailabilityNote(injury) {
    const comment = injury.longComment || injury.shortComment;
    const pieces = [comment];
    if (injury.returnDate) {
        pieces.push(`Estimated return: ${injury.returnDate}.`);
    }
    return pieces
        .filter(Boolean)
        .join(' ')
        .trim()
        .slice(0, MAX_NOTE_LENGTH);
}
async function commitPendingWrites(writes) {
    for (let startIndex = 0; startIndex < writes.length; startIndex += MAX_BATCH_WRITES) {
        const batch = db.batch();
        for (const write of writes.slice(startIndex, startIndex + MAX_BATCH_WRITES)) {
            if (write.type === 'delete') {
                batch.delete(write.reference);
            }
            else if (write.data) {
                batch.set(write.reference, write.data);
            }
        }
        await batch.commit();
    }
}
async function verifyLeagueMembership(leagueId, userId) {
    const leagueRef = db.doc(`leagues/${leagueId}`);
    const memberRef = db.doc(`leagues/${leagueId}/members/${userId}`);
    const teamRef = db.doc(`leagues/${leagueId}/teams/${userId}`);
    const [leagueSnapshot, memberSnapshot, teamSnapshot] = await Promise.all([
        leagueRef.get(),
        memberRef.get(),
        teamRef.get()
    ]);
    if (!leagueSnapshot.exists) {
        throw new https_1.HttpsError('not-found', 'This league no longer exists.');
    }
    const leagueData = leagueSnapshot.data() ?? {};
    const memberData = memberSnapshot.data() ?? {};
    const teamData = teamSnapshot.data() ?? {};
    const isCommissioner = leagueData['commissionerId'] === userId;
    const hasMembership = memberSnapshot.exists &&
        memberData['uid'] === userId;
    const ownsExistingTeam = teamSnapshot.exists &&
        teamData['ownerId'] === userId;
    if (!isCommissioner &&
        !hasMembership &&
        !ownsExistingTeam) {
        throw new https_1.HttpsError('permission-denied', 'You are not a member of this league.');
    }
}
async function claimDailyRefresh(leagueId, userId, dailyKey, attemptId) {
    const lockRef = db.doc(`leagues/${leagueId}/playerAvailabilityDaily/${dailyKey}`);
    const syncRef = db.doc(`leagues/${leagueId}/playerAvailabilitySync/current`);
    return db.runTransaction(async (transaction) => {
        const lockSnapshot = await transaction.get(lockRef);
        const syncSnapshot = await transaction.get(syncRef);
        const lockData = lockSnapshot.data() ?? {};
        const syncData = syncSnapshot.data() ?? {};
        const lastDailySyncKey = asString(syncData['lastDailySyncKey']);
        const existingSuccessToday = lastDailySyncKey === dailyKey ||
            isTimestampOnDailyKey(syncData['lastDailySuccessfulSyncAt'], dailyKey) ||
            isTimestampOnDailyKey(syncData['lastSuccessfulSyncAt'], dailyKey);
        if (existingSuccessToday) {
            const completedAt = getIsoTimestamp(syncData['lastDailySuccessfulSyncAt']) ||
                getIsoTimestamp(syncData['lastSuccessfulSyncAt']);
            transaction.set(lockRef, {
                status: 'success',
                dailyKey,
                completedAt: getTimestampDate(syncData['lastDailySuccessfulSyncAt']) ??
                    getTimestampDate(syncData['lastSuccessfulSyncAt']) ??
                    firestore_1.FieldValue.serverTimestamp(),
                requestedBy: userId,
                source: 'existing-success',
                updatedAt: firestore_1.FieldValue.serverTimestamp()
            }, { merge: true });
            transaction.set(syncRef, {
                dailyKey,
                lastDailySyncKey: dailyKey,
                lastDailySuccessfulSyncAt: getTimestampDate(syncData['lastSuccessfulSyncAt']) ??
                    firestore_1.FieldValue.serverTimestamp()
            }, { merge: true });
            return {
                status: 'already-current',
                syncData,
                completedAt
            };
        }
        if (lockData['status'] === 'success') {
            return {
                status: 'already-current',
                syncData,
                completedAt: getIsoTimestamp(lockData['completedAt'])
            };
        }
        if ((lockData['status'] === 'running' &&
            isRecentTimestamp(lockData['startedAt'], RUNNING_LEASE_MINUTES)) ||
            (syncData['status'] === 'running' &&
                isRecentTimestamp(syncData['lastAttemptAt'], RUNNING_LEASE_MINUTES))) {
            return {
                status: 'in-progress',
                syncData,
                completedAt: ''
            };
        }
        if (lockData['status'] === 'error' &&
            isRecentTimestamp(lockData['lastAttemptAt'], ERROR_COOLDOWN_MINUTES)) {
            return {
                status: 'cooldown',
                syncData,
                completedAt: getIsoTimestamp(syncData['lastSuccessfulSyncAt'])
            };
        }
        transaction.set(lockRef, {
            status: 'running',
            dailyKey,
            attemptId,
            requestedBy: userId,
            startedAt: firestore_1.FieldValue.serverTimestamp(),
            lastAttemptAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(syncRef, {
            source: 'ESPN',
            status: 'running',
            trigger: 'daily-visit',
            dailyKey,
            lastAttemptAt: firestore_1.FieldValue.serverTimestamp(),
            updatedBy: userId,
            fetchedCount: 0,
            matchedCount: 0,
            unmatchedCount: 0,
            syncedRecordCount: 0,
            clearedRecordCount: 0,
            preservedManualOverrideCount: 0,
            skippedGoalieCount: 0,
            message: 'The first league visit of the day is securely refreshing ESPN injury data.'
        }, { merge: true });
        return {
            status: 'claimed',
            syncData,
            completedAt: ''
        };
    });
}
exports.nhlApiProxy = (0, https_1.onRequest)({
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    maxInstances: 10,
    cors: false
}, async (request, response) => {
    if (request.method !== 'GET') {
        response
            .status(405)
            .set('Allow', 'GET')
            .json({ message: 'Only GET requests are supported.' });
        return;
    }
    const target = getNhlProxyTarget(request.originalUrl);
    if (!target) {
        response.status(404).json({
            message: 'This NHL API route is not available through the app proxy.'
        });
        return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NHL_PROXY_TIMEOUT_MS);
    try {
        const upstreamResponse = await fetch(target, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'cycle-puck/1.0'
            },
            signal: controller.signal
        });
        const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
        response
            .status(upstreamResponse.status)
            .set('Content-Type', upstreamResponse.headers.get('content-type') ??
            'application/json; charset=utf-8')
            .set('Cache-Control', getNhlProxyCacheControl(target.pathname))
            .set('X-Content-Type-Options', 'nosniff')
            .send(responseBody);
    }
    catch (error) {
        const message = error instanceof Error
            ? error.message
            : 'Unknown NHL API proxy error.';
        console.error('NHL API proxy request failed.', {
            target: target.toString(),
            message
        });
        response.status(502).json({
            message: 'The NHL data service could not be reached. Please try again shortly.'
        });
    }
    finally {
        clearTimeout(timeout);
    }
});
exports.refreshDailyPlayerAvailability = (0, https_1.onCall)({
    region: FUNCTION_REGION,
    timeoutSeconds: 180,
    memory: '512MiB',
    maxInstances: 4,
    concurrency: 10,
    cors: true,
    invoker: 'public'
}, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', 'You must be logged in to refresh injuries.');
    }
    const leagueId = asString(asRecord(request.data)['leagueId']);
    if (!leagueId ||
        leagueId.length > 128 ||
        !/^[A-Za-z0-9_-]+$/.test(leagueId)) {
        throw new https_1.HttpsError('invalid-argument', 'A valid league ID is required.');
    }
    const userId = request.auth.uid;
    const dailyKey = getUtcDailyKey();
    const attemptId = (0, node_crypto_1.randomUUID)();
    await verifyLeagueMembership(leagueId, userId);
    const claim = await claimDailyRefresh(leagueId, userId, dailyKey, attemptId);
    if (claim.status === 'already-current') {
        return buildSkippedResult('already-current', dailyKey, 'Today’s shared injury report is already ready.', claim.syncData, claim.completedAt);
    }
    if (claim.status === 'in-progress') {
        return buildSkippedResult('in-progress', dailyKey, 'Another league member already started today’s injury refresh.', claim.syncData, '');
    }
    if (claim.status === 'cooldown') {
        return buildSkippedResult('cooldown', dailyKey, 'A recent refresh attempt failed. The last saved report is being used before another retry is allowed.', claim.syncData, claim.completedAt);
    }
    const lockRef = db.doc(`leagues/${leagueId}/playerAvailabilityDaily/${dailyKey}`);
    const syncRef = db.doc(`leagues/${leagueId}/playerAvailabilitySync/current`);
    try {
        const [players, espnPayload] = await Promise.all([
            loadCurrentNhlSkaters(),
            fetchJson(ESPN_NHL_INJURIES_URL)
        ]);
        const parsed = parseEspnInjuries(espnPayload);
        if (parsed.entries.length === 0) {
            throw new Error('ESPN returned no NHL injury entries, so the existing report was left unchanged.');
        }
        const matchResult = matchInjuriesToPlayers(parsed.entries, players);
        const availabilityCollection = db.collection(`leagues/${leagueId}/playerAvailability`);
        const existingSnapshot = await availabilityCollection.get();
        const existingByPlayerId = new Map();
        for (const document of existingSnapshot.docs) {
            const data = document.data();
            const playerId = data['playerId'];
            if (typeof playerId !== 'number') {
                continue;
            }
            existingByPlayerId.set(playerId, {
                source: data['source'] === 'espn'
                    ? 'espn'
                    : 'commissioner',
                reference: document.ref
            });
        }
        const matchedPlayerIds = new Set();
        const pendingWrites = [];
        let syncedRecordCount = 0;
        let preservedManualOverrideCount = 0;
        for (const match of matchResult.matches) {
            matchedPlayerIds.add(match.player.id);
            const existing = existingByPlayerId.get(match.player.id);
            if (existing?.source === 'commissioner') {
                preservedManualOverrideCount += 1;
                continue;
            }
            pendingWrites.push({
                type: 'set',
                reference: availabilityCollection.doc(String(match.player.id)),
                data: {
                    playerId: match.player.id,
                    playerName: match.player.fullName,
                    status: match.injury.normalizedStatus,
                    note: buildAvailabilityNote(match.injury),
                    irEligible: isPlayerIrEligible(match.injury.normalizedStatus),
                    updatedAt: firestore_1.FieldValue.serverTimestamp(),
                    updatedBy: userId,
                    source: 'espn',
                    leagueId,
                    externalSource: 'ESPN',
                    externalStatus: match.injury.rawStatus ||
                        match.injury.fantasyStatus ||
                        match.injury.injuryType ||
                        'Unknown',
                    externalReturnDate: match.injury.returnDate,
                    externalInjuryDate: match.injury.injuryDate,
                    externalTeamName: match.injury.teamName,
                    syncedAt: firestore_1.FieldValue.serverTimestamp()
                }
            });
            syncedRecordCount += 1;
        }
        const feedLooksCompleteEnoughToClear = parsed.teamEntryCount >= 10 ||
            parsed.entries.length >= 20;
        let clearedRecordCount = 0;
        if (feedLooksCompleteEnoughToClear) {
            for (const [playerId, existing] of existingByPlayerId) {
                if (existing.source === 'espn' &&
                    !matchedPlayerIds.has(playerId)) {
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
        const unmatchedCount = matchResult.unmatchedNames.length;
        const messageParts = [
            `Updated today’s report with ${matchResult.matches.length} matched injured skaters.`,
            `Saved ${syncedRecordCount} automatic records.`,
            `Preserved ${preservedManualOverrideCount} commissioner overrides.`
        ];
        if (clearedRecordCount > 0) {
            messageParts.push(`Cleared ${clearedRecordCount} players no longer listed by ESPN.`);
        }
        if (!feedLooksCompleteEnoughToClear) {
            messageParts.push('The ESPN feed was sparse, so older automatic records were preserved.');
        }
        if (unmatchedCount > 0) {
            messageParts.push(`${unmatchedCount} injury names could not be matched to current NHL rosters.`);
        }
        const message = messageParts
            .join(' ')
            .slice(0, 500);
        await Promise.all([
            lockRef.set({
                status: 'success',
                dailyKey,
                attemptId,
                requestedBy: userId,
                completedAt,
                fetchedCount: parsed.entries.length,
                matchedCount: matchResult.matches.length,
                unmatchedCount,
                syncedRecordCount,
                clearedRecordCount,
                preservedManualOverrideCount,
                skippedGoalieCount: matchResult.skippedGoalieCount,
                message,
                updatedAt: firestore_1.FieldValue.serverTimestamp()
            }, { merge: true }),
            syncRef.set({
                source: 'ESPN',
                status: 'success',
                trigger: 'daily-visit',
                dailyKey,
                lastDailySyncKey: dailyKey,
                lastAttemptAt: firestore_1.FieldValue.serverTimestamp(),
                lastSuccessfulSyncAt: firestore_1.FieldValue.serverTimestamp(),
                lastDailySuccessfulSyncAt: firestore_1.FieldValue.serverTimestamp(),
                updatedBy: userId,
                fetchedCount: parsed.entries.length,
                matchedCount: matchResult.matches.length,
                unmatchedCount,
                syncedRecordCount,
                clearedRecordCount,
                preservedManualOverrideCount,
                skippedGoalieCount: matchResult.skippedGoalieCount,
                message
            }, { merge: true })
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
            skippedGoalieCount: matchResult.skippedGoalieCount
        };
    }
    catch (error) {
        const message = (error instanceof Error
            ? error.message
            : 'Unable to refresh NHL injury data.').slice(0, 500);
        await Promise.all([
            lockRef.set({
                status: 'error',
                dailyKey,
                attemptId,
                requestedBy: userId,
                lastAttemptAt: firestore_1.FieldValue.serverTimestamp(),
                message,
                updatedAt: firestore_1.FieldValue.serverTimestamp()
            }, { merge: true }),
            syncRef.set({
                source: 'ESPN',
                status: 'error',
                trigger: 'daily-visit',
                dailyKey,
                lastAttemptAt: firestore_1.FieldValue.serverTimestamp(),
                updatedBy: userId,
                message
            }, { merge: true })
        ]);
        throw new https_1.HttpsError('unavailable', message);
    }
});
//# sourceMappingURL=index.js.map