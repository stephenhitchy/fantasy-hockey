import { createHash, randomBytes } from 'node:crypto';

import { DocumentData, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import { requireVerifiedRecentAuthentication } from './shared/security/auth-security.util';
import {
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
} from './shared/core/scoring/scoring-rules';
import { createEmptyFantasyRoster } from './shared/core/team/roster.service';
import {
  getCanonicalJoinStatus,
  getEffectiveActiveLeagueCount,
  getOccupiedLeagueOwnerIds,
  getUnexpectedDocumentKeys,
  isDraftJoinLocked,
  LEAGUE_AUDIT_SCHEMA_VERSION,
  LEAGUE_AUTHORITY_SCHEMA_VERSION,
  LEAGUE_DOCUMENT_KEYS,
  LEAGUE_DOCUMENT_SCHEMA_VERSION,
  LEAGUE_INVITE_DOCUMENT_KEYS,
  LEAGUE_INVITE_SCHEMA_VERSION,
  LEAGUE_MEMBER_DOCUMENT_KEYS,
  LEAGUE_MEMBER_SCHEMA_VERSION,
  LEAGUE_TEAM_DOCUMENT_KEYS,
  LEAGUE_TEAM_SCHEMA_VERSION,
  LEAGUE_CREATION_WINDOW_MILLISECONDS,
  LEAGUE_JOIN_DAILY_WINDOW_MILLISECONDS,
  LEAGUE_JOIN_SHORT_WINDOW_MILLISECONDS,
  LEAGUE_LIFECYCLE_STATE_SCHEMA_VERSION,
  MAX_ACTIVE_LEAGUES_PER_USER,
  MAX_JOIN_ATTEMPTS_PER_10_MINUTES,
  MAX_JOIN_ATTEMPTS_PER_24_HOURS,
  MAX_LEAGUE_CREATIONS_PER_24_HOURS,
  normalizeRollingWindow,
} from './league-lifecycle-authority.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const LEAGUE_CREATION_REQUEST_SCHEMA_VERSION = 1;
const LEAGUE_CREATION_REQUEST_RETENTION_DAYS = 30;
const LEAGUE_JOIN_REQUEST_SCHEMA_VERSION = 1;
const LEAGUE_JOIN_REQUEST_RETENTION_DAYS = 30;
const LEAGUE_INVITE_EXPIRY_DAYS = 180;
const INVITE_CODE_LENGTH = 6;
const MAX_INVITE_CODE_ATTEMPTS = 20;
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const LEAGUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COMMISSIONER_REASON_MAX_LENGTH = 240;
const SECURITY_RELEASE_LABEL = 'Security Batch S1C';

const SUPPORTED_LEAGUE_LOGO_IDS = new Set([
  'crossed-sticks',
  'rink-rat',
  'goalie-mask',
  'crown-puck',
  'arcade-net',
  'lightning-skate',
  'helmet-stars',
  'rink-badge',
]);

const SUPPORTED_LEAGUE_LOGO_PALETTE_IDS = new Set([
  'rink-gold',
  'ice-blue',
  'crimson',
  'emerald',
  'violet',
  'retro-orange',
  'neon-arcade',
  'silver',
]);

const SUPPORTED_PROFILE_ICON_IDS = new Set([
  'emerald-visor',
  'red-line-rat',
  'purple-sniper',
  'teal-captain',
  'whiteout-goalie',
  'crease-split',
  'blue-line-blaster',
  'open-ice-hit',
  'masked-veteran',
  'water-break',
  'jersey-neon-diamond',
  'jersey-arcade-viper',
  'jersey-red-chevron',
  'jersey-royal-crest',
  'jersey-forest-cross',
  'jersey-speed-stripes',
  'jersey-north-star',
  'jersey-emerald-starburst',
  'jersey-pine-star',
  'jersey-violet-crystal',
  'jersey-ice-orbit',
  'jersey-wing-rush',
  'jersey-blue-compass',
  'jersey-frost-vortex',
  'jersey-teal-tide',
  'hockey-referee',
  'hockey-ice-resurfacer',
  'hockey-goalie-mask',
  'hockey-skates',
  'hockey-crossed-sticks',
  'hockey-visor-helmet',
  'hockey-goal-light',
  'hockey-goalie-gear',
  'hockey-championship-cup',
  'hockey-bench-gear',
]);

interface CreateLeagueSecureRequest {
  requestId?: unknown;
  name?: unknown;
  maxTeams?: unknown;
  username?: unknown;
  leagueLogoId?: unknown;
  leagueLogoPaletteId?: unknown;
  profileIconId?: unknown;
}

interface NormalizedCreateLeagueRequest {
  requestId: string;
  name: string;
  maxTeams: number;
  username: string;
  leagueLogoId: string;
  leagueLogoPaletteId: string;
  profileIconId: string;
}

export interface CreateLeagueSecureResult {
  created: true;
  leagueId: string;
  inviteCode: string;
  idempotentReplay: boolean;
  authoritySchemaVersion: number;
}

interface JoinLeagueSecureRequest {
  requestId?: unknown;
  inviteCode?: unknown;
  username?: unknown;
  profileIconId?: unknown;
}

interface NormalizedJoinLeagueRequest {
  requestId: string;
  inviteCode: string;
  username: string;
  profileIconId: string;
}

export interface JoinLeagueSecureResult {
  joined: true;
  leagueId: string;
  inviteCode: string;
  alreadyMember: boolean;
  idempotentReplay: boolean;
  teamCount: number;
  maxTeams: number;
  authoritySchemaVersion: number;
}

interface UpdateLeagueCosmeticsSecureRequest {
  requestId?: unknown;
  leagueId?: unknown;
  name?: unknown;
  leagueLogoId?: unknown;
  leagueLogoPaletteId?: unknown;
  reason?: unknown;
}

interface NormalizedUpdateLeagueCosmeticsRequest {
  requestId: string;
  leagueId: string;
  name: string;
  leagueLogoId: string;
  leagueLogoPaletteId: string;
  reason: string;
}

export interface UpdateLeagueCosmeticsSecureResult {
  updated: true;
  leagueId: string;
  changed: boolean;
  idempotentReplay: boolean;
  authoritySchemaVersion: number;
}

interface MigrateLeagueAuthoritySchemaRequest {
  leagueId?: unknown;
  reason?: unknown;
}

export interface MigrateLeagueAuthoritySchemaResult {
  migrated: true;
  leagueId: string;
  idempotentReplay: boolean;
  authoritySchemaVersion: number;
  teamCount: number;
  memberCount: number;
  repairedMemberCount: number;
  repairedTeamCount: number;
  repairedRosterCount: number;
  removedUnexpectedFieldCount: number;
}

interface LeagueLifecycleQuotaState {
  activeLeagueCount: number;
  creationWindowStartedAtMilliseconds: number | null;
  creationCount: number;
  joinShortWindowStartedAtMilliseconds: number | null;
  joinShortCount: number;
  joinDailyWindowStartedAtMilliseconds: number | null;
  joinDailyCount: number;
}

class InviteCodeCollisionError extends Error {
  constructor() {
    super('Invite code collision.');
    this.name = 'InviteCodeCollisionError';
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireAuthenticatedUserId(
  auth: {
    uid?: string;
    token?: Record<string, unknown>;
  } | undefined,
  actionLabel = 'continue',
): string {
  const userId = asString(auth?.uid);

  if (!userId) {
    throw new HttpsError(
      'unauthenticated',
      `You must be signed in to ${actionLabel}.`,
    );
  }

  return userId;
}

function requireVerifiedEmail(
  auth: { token?: Record<string, unknown> } | undefined,
  actionLabel: string,
): void {
  const token = auth?.token ?? {};
  const email = asString(token['email']);
  const emailVerified = token['email_verified'] === true;

  if (!email || !emailVerified) {
    throw new HttpsError(
      'failed-precondition',
      `Verify your email address before you ${actionLabel}. Open Account Settings to resend the verification email.`,
      { reason: 'email-verification-required' },
    );
  }
}

function requireRequestId(value: unknown, operationLabel = 'league creation'): string {
  const requestId = asString(value);

  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new HttpsError(
      'invalid-argument',
      `The ${operationLabel} request could not be verified. Refresh the page and try again.`,
    );
  }

  return requestId;
}

function requireLeagueId(value: unknown): string {
  const leagueId = asString(value);

  if (!LEAGUE_ID_PATTERN.test(leagueId)) {
    throw new HttpsError(
      'invalid-argument',
      'A valid league ID is required.',
    );
  }

  return leagueId;
}

function requireCommissionerReason(value: unknown, fallback: string): string {
  const reason = asString(value) || fallback;

  if (reason.length < 8 || reason.length > COMMISSIONER_REASON_MAX_LENGTH) {
    throw new HttpsError(
      'invalid-argument',
      `The audit reason must be between 8 and ${COMMISSIONER_REASON_MAX_LENGTH} characters.`,
    );
  }

  return reason;
}

async function requirePlatformAdministrator(
  auth: { uid?: string; token?: Record<string, unknown> } | undefined,
): Promise<string> {
  const userId = requireAuthenticatedUserId(auth, 'migrate league authority');

  if (auth?.token?.['platformAdmin'] === true) {
    return userId;
  }

  const adminSnapshot = await db.doc(`platformAdmins/${userId}`).get();

  if (!adminSnapshot.exists || adminSnapshot.data()?.['enabled'] !== true) {
    throw new HttpsError(
      'permission-denied',
      'Only a RinkRat platform administrator can migrate league authority.',
    );
  }

  return userId;
}

function requireInviteCode(value: unknown): string {
  const inviteCode = asString(value).toUpperCase();

  if (
    inviteCode.length !== INVITE_CODE_LENGTH ||
    !/^[A-Z0-9]+$/.test(inviteCode)
  ) {
    throw new HttpsError(
      'invalid-argument',
      'Enter the six-character league invite code exactly as it appears.',
    );
  }

  return inviteCode;
}

function requireLeagueName(value: unknown): string {
  const name = asString(value);

  if (name.length < 1 || name.length > 80) {
    throw new HttpsError(
      'invalid-argument',
      'League name must be between 1 and 80 characters.',
    );
  }

  return name;
}

function requireUsername(value: unknown): string {
  const username = asString(value);

  if (username.length < 1 || username.length > 40) {
    throw new HttpsError(
      'invalid-argument',
      'Your manager display name must be between 1 and 40 characters.',
    );
  }

  return username;
}

function requireMaxTeams(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 2 ||
    value > 12
  ) {
    throw new HttpsError(
      'invalid-argument',
      'League size must be between 2 and 12 teams.',
    );
  }

  return value;
}

function requireOnlyInputKeys(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
  operationLabel: string,
): void {
  const unexpectedKeys = Object.keys(input).filter(
    (key) => !allowedKeys.includes(key),
  );

  if (unexpectedKeys.length > 0) {
    throw new HttpsError(
      'invalid-argument',
      `${operationLabel} included unsupported fields. Refresh the page and try again.`,
      { unexpectedFields: unexpectedKeys.slice(0, 10) },
    );
  }
}

function requireSupportedValue(
  value: unknown,
  supportedValues: ReadonlySet<string>,
  message: string,
): string {
  const normalized = asString(value);

  if (!supportedValues.has(normalized)) {
    throw new HttpsError('invalid-argument', message);
  }

  return normalized;
}

function normalizeRequest(data: unknown): NormalizedCreateLeagueRequest {
  const input = data && typeof data === 'object' && !Array.isArray(data)
    ? data as CreateLeagueSecureRequest & Record<string, unknown>
    : {};
  requireOnlyInputKeys(
    input,
    ['requestId', 'name', 'maxTeams', 'username', 'leagueLogoId', 'leagueLogoPaletteId', 'profileIconId'],
    'League creation',
  );

  return {
    requestId: requireRequestId(input.requestId),
    name: requireLeagueName(input.name),
    maxTeams: requireMaxTeams(input.maxTeams),
    username: requireUsername(input.username),
    leagueLogoId: requireSupportedValue(
      input.leagueLogoId,
      SUPPORTED_LEAGUE_LOGO_IDS,
      'Choose a supported league emblem.',
    ),
    leagueLogoPaletteId: requireSupportedValue(
      input.leagueLogoPaletteId,
      SUPPORTED_LEAGUE_LOGO_PALETTE_IDS,
      'Choose a supported league color variant.',
    ),
    profileIconId: requireSupportedValue(
      input.profileIconId,
      SUPPORTED_PROFILE_ICON_IDS,
      'Choose a supported manager icon.',
    ),
  };
}

function normalizeJoinRequest(data: unknown): NormalizedJoinLeagueRequest {
  const input = data && typeof data === 'object' && !Array.isArray(data)
    ? data as JoinLeagueSecureRequest & Record<string, unknown>
    : {};
  requireOnlyInputKeys(
    input,
    ['requestId', 'inviteCode', 'username', 'profileIconId'],
    'League join',
  );

  return {
    requestId: requireRequestId(input.requestId, 'league join'),
    inviteCode: requireInviteCode(input.inviteCode),
    username: requireUsername(input.username),
    profileIconId: requireSupportedValue(
      input.profileIconId,
      SUPPORTED_PROFILE_ICON_IDS,
      'Choose a supported manager icon.',
    ),
  };
}

function normalizeUpdateLeagueCosmeticsRequest(
  data: unknown,
): NormalizedUpdateLeagueCosmeticsRequest {
  const input = data && typeof data === 'object' && !Array.isArray(data)
    ? data as UpdateLeagueCosmeticsSecureRequest & Record<string, unknown>
    : {};
  requireOnlyInputKeys(
    input,
    ['requestId', 'leagueId', 'name', 'leagueLogoId', 'leagueLogoPaletteId', 'reason'],
    'League presentation update',
  );

  return {
    requestId: requireRequestId(input.requestId, 'league presentation update'),
    leagueId: requireLeagueId(input.leagueId),
    name: requireLeagueName(input.name),
    leagueLogoId: requireSupportedValue(
      input.leagueLogoId,
      SUPPORTED_LEAGUE_LOGO_IDS,
      'Choose a supported league emblem.',
    ),
    leagueLogoPaletteId: requireSupportedValue(
      input.leagueLogoPaletteId,
      SUPPORTED_LEAGUE_LOGO_PALETTE_IDS,
      'Choose a supported league color variant.',
    ),
    reason: requireCommissionerReason(
      input.reason,
      'Commissioner updated league presentation.',
    ),
  };
}

function normalizeMigrationRequest(data: unknown): { leagueId: string; reason: string } {
  const input = data && typeof data === 'object' && !Array.isArray(data)
    ? data as MigrateLeagueAuthoritySchemaRequest & Record<string, unknown>
    : {};
  requireOnlyInputKeys(input, ['leagueId', 'reason'], 'League authority migration');

  return {
    leagueId: requireLeagueId(input.leagueId),
    reason: requireCommissionerReason(
      input.reason,
      'Platform administrator migrated the league authority schema.',
    ),
  };
}

function createCosmeticsPayloadHash(input: NormalizedUpdateLeagueCosmeticsRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({
      leagueId: input.leagueId,
      name: input.name,
      leagueLogoId: input.leagueLogoId,
      leagueLogoPaletteId: input.leagueLogoPaletteId,
      reason: input.reason,
    }))
    .digest('hex');
}

function createAuditDocumentId(prefix: string, requestId: string): string {
  return `${prefix}-${createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;
}

function createInviteCodeCandidate(): string {
  const randomValues = randomBytes(INVITE_CODE_LENGTH);

  return Array.from(
    randomValues,
    (value) => INVITE_CODE_ALPHABET[value % INVITE_CODE_ALPHABET.length],
  ).join('');
}

function createPayloadHash(input: NormalizedCreateLeagueRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({
      name: input.name,
      maxTeams: input.maxTeams,
      username: input.username,
      leagueLogoId: input.leagueLogoId,
      leagueLogoPaletteId: input.leagueLogoPaletteId,
      profileIconId: input.profileIconId,
    }))
    .digest('hex');
}

function createRequestDocumentId(userId: string, requestId: string): string {
  return createHash('sha256')
    .update(`${userId}:${requestId}`)
    .digest('hex');
}

function createJoinPayloadHash(input: NormalizedJoinLeagueRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({
      inviteCode: input.inviteCode,
      username: input.username,
      profileIconId: input.profileIconId,
    }))
    .digest('hex');
}

function createJoinRequestDocumentId(userId: string, requestId: string): string {
  return createHash('sha256')
    .update(`join:${userId}:${requestId}`)
    .digest('hex');
}

function leagueIdFromNestedPath(path: string): string | null {
  const parts = path.split('/');
  const leagueIndex = parts.indexOf('leagues');

  return leagueIndex >= 0 && parts.length > leagueIndex + 1
    ? parts[leagueIndex + 1] || null
    : null;
}

async function countExistingLeagueMemberships(userId: string): Promise<number> {
  const [membershipSnapshot, commissionerSnapshot] = await Promise.all([
    db.collectionGroup('members').where('uid', '==', userId).get(),
    db.collection('leagues').where('commissionerId', '==', userId).get(),
  ]);
  const leagueIds = new Set<string>();

  for (const document of membershipSnapshot.docs) {
    const leagueId = leagueIdFromNestedPath(document.ref.path);

    if (leagueId) {
      leagueIds.add(leagueId);
    }
  }

  for (const document of commissionerSnapshot.docs) {
    leagueIds.add(document.id);
  }

  return leagueIds.size;
}

function timestampMilliseconds(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function readQuotaState(
  data: DocumentData | undefined,
  measuredActiveLeagueCount: number,
): LeagueLifecycleQuotaState {
  const source = data ?? {};

  return {
    activeLeagueCount: getEffectiveActiveLeagueCount(
      source['activeLeagueCount'],
      measuredActiveLeagueCount,
    ),
    creationWindowStartedAtMilliseconds: timestampMilliseconds(
      source['creationWindowStartedAt'],
    ),
    creationCount:
      typeof source['creationCount'] === 'number' &&
      Number.isInteger(source['creationCount'])
        ? Math.max(0, source['creationCount'])
        : 0,
    joinShortWindowStartedAtMilliseconds: timestampMilliseconds(
      source['joinShortWindowStartedAt'],
    ),
    joinShortCount:
      typeof source['joinShortCount'] === 'number' &&
      Number.isInteger(source['joinShortCount'])
        ? Math.max(0, source['joinShortCount'])
        : 0,
    joinDailyWindowStartedAtMilliseconds: timestampMilliseconds(
      source['joinDailyWindowStartedAt'],
    ),
    joinDailyCount:
      typeof source['joinDailyCount'] === 'number' &&
      Number.isInteger(source['joinDailyCount'])
        ? Math.max(0, source['joinDailyCount'])
        : 0,
  };
}

function quotaDocumentData(
  state: LeagueLifecycleQuotaState,
  nowMilliseconds: number,
): Record<string, unknown> {
  return {
    schemaVersion: LEAGUE_LIFECYCLE_STATE_SCHEMA_VERSION,
    activeLeagueCount: state.activeLeagueCount,
    creationWindowStartedAt: state.creationWindowStartedAtMilliseconds === null
      ? null
      : Timestamp.fromMillis(state.creationWindowStartedAtMilliseconds),
    creationCount: state.creationCount,
    joinShortWindowStartedAt: state.joinShortWindowStartedAtMilliseconds === null
      ? null
      : Timestamp.fromMillis(state.joinShortWindowStartedAtMilliseconds),
    joinShortCount: state.joinShortCount,
    joinDailyWindowStartedAt: state.joinDailyWindowStartedAtMilliseconds === null
      ? null
      : Timestamp.fromMillis(state.joinDailyWindowStartedAtMilliseconds),
    joinDailyCount: state.joinDailyCount,
    limits: {
      maxActiveLeagues: MAX_ACTIVE_LEAGUES_PER_USER,
      maxCreationsPer24Hours: MAX_LEAGUE_CREATIONS_PER_24_HOURS,
      maxJoinAttemptsPer10Minutes: MAX_JOIN_ATTEMPTS_PER_10_MINUTES,
      maxJoinAttemptsPer24Hours: MAX_JOIN_ATTEMPTS_PER_24_HOURS,
    },
    lastReconciledAt: Timestamp.fromMillis(nowMilliseconds),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function applyCreationQuota(
  state: LeagueLifecycleQuotaState,
  nowMilliseconds: number,
): LeagueLifecycleQuotaState {
  const creationWindow = normalizeRollingWindow(
    {
      startedAtMilliseconds: state.creationWindowStartedAtMilliseconds,
      count: state.creationCount,
    },
    nowMilliseconds,
    LEAGUE_CREATION_WINDOW_MILLISECONDS,
  );

  if (state.activeLeagueCount >= MAX_ACTIVE_LEAGUES_PER_USER) {
    throw new HttpsError(
      'resource-exhausted',
      `You can belong to at most ${MAX_ACTIVE_LEAGUES_PER_USER} active RinkRat leagues during the beta.`,
      { reason: 'active-league-limit' },
    );
  }

  if (creationWindow.count >= MAX_LEAGUE_CREATIONS_PER_24_HOURS) {
    throw new HttpsError(
      'resource-exhausted',
      `You can create at most ${MAX_LEAGUE_CREATIONS_PER_24_HOURS} leagues in a rolling 24-hour period during the beta.`,
      { reason: 'league-creation-rate-limit' },
    );
  }

  return {
    ...state,
    activeLeagueCount: state.activeLeagueCount + 1,
    creationWindowStartedAtMilliseconds: creationWindow.startedAtMilliseconds,
    creationCount: creationWindow.count + 1,
  };
}

function applyJoinAttemptQuota(
  state: LeagueLifecycleQuotaState,
  nowMilliseconds: number,
): LeagueLifecycleQuotaState {
  const shortWindow = normalizeRollingWindow(
    {
      startedAtMilliseconds: state.joinShortWindowStartedAtMilliseconds,
      count: state.joinShortCount,
    },
    nowMilliseconds,
    LEAGUE_JOIN_SHORT_WINDOW_MILLISECONDS,
  );
  const dailyWindow = normalizeRollingWindow(
    {
      startedAtMilliseconds: state.joinDailyWindowStartedAtMilliseconds,
      count: state.joinDailyCount,
    },
    nowMilliseconds,
    LEAGUE_JOIN_DAILY_WINDOW_MILLISECONDS,
  );

  if (shortWindow.count >= MAX_JOIN_ATTEMPTS_PER_10_MINUTES) {
    throw new HttpsError(
      'resource-exhausted',
      'Too many invite-code attempts were made from this account. Wait a few minutes before trying again.',
      { reason: 'join-short-rate-limit' },
    );
  }

  if (dailyWindow.count >= MAX_JOIN_ATTEMPTS_PER_24_HOURS) {
    throw new HttpsError(
      'resource-exhausted',
      'This account reached the temporary daily invite-code attempt limit.',
      { reason: 'join-daily-rate-limit' },
    );
  }

  return {
    ...state,
    joinShortWindowStartedAtMilliseconds: shortWindow.startedAtMilliseconds,
    joinShortCount: shortWindow.count + 1,
    joinDailyWindowStartedAtMilliseconds: dailyWindow.startedAtMilliseconds,
    joinDailyCount: dailyWindow.count + 1,
  };
}

function createTeamDocument(
  ownerId: string,
  managerName: string,
  profileIconId: string,
  waiverPriority = 1,
): Record<string, unknown> {
  return {
    schemaVersion: LEAGUE_TEAM_SCHEMA_VERSION,
    id: ownerId,
    ownerId,
    teamName: managerName,
    managerName,
    profileIconId,
    logo: '',
    wins: 0,
    losses: 0,
    ties: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    waiverPriority,
    draftPosition: null,
    authority: 'league-lifecycle-authority',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function readCompletedRequest(
  data: DocumentData,
  userId: string,
  payloadHash: string,
): CreateLeagueSecureResult {
  if (asString(data['ownerId']) !== userId) {
    throw new HttpsError(
      'permission-denied',
      'This league creation request belongs to a different account.',
    );
  }

  if (asString(data['payloadHash']) !== payloadHash) {
    throw new HttpsError(
      'failed-precondition',
      'This request was already used with different league settings. Refresh the page and try again.',
    );
  }

  const leagueId = asString(data['leagueId']);
  const inviteCode = asString(data['inviteCode']);

  if (!leagueId || !inviteCode || data['status'] !== 'complete') {
    throw new HttpsError(
      'aborted',
      'The previous league creation is still being reconciled. Wait a moment and try again.',
    );
  }

  return {
    created: true,
    leagueId,
    inviteCode,
    idempotentReplay: true,
    authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
  };
}

export const createLeagueSecure = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '256MiB',
    maxInstances: 40,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<CreateLeagueSecureResult> => {
    const userId = requireAuthenticatedUserId(request.auth, 'create a league');
    requireVerifiedEmail(request.auth, 'create a league');

    const input = normalizeRequest(request.data);
    const payloadHash = createPayloadHash(input);
    const requestRef = db.doc(
      `leagueCreationRequests/${createRequestDocumentId(userId, input.requestId)}`,
    );
    const lifecycleRef = db.doc(`leagueLifecycleState/${userId}`);
    const leagueRef = db.collection('leagues').doc();
    const measuredActiveLeagueCount = await countExistingLeagueMemberships(userId);
    const nowMilliseconds = Date.now();

    for (let attempt = 0; attempt < MAX_INVITE_CODE_ATTEMPTS; attempt += 1) {
      const inviteCode = createInviteCodeCandidate();
      const inviteRef = db.doc(`leagueInvites/${inviteCode}`);

      try {
        return await db.runTransaction(async (transaction) => {
          const requestSnapshot = await transaction.get(requestRef);

          if (requestSnapshot.exists) {
            return readCompletedRequest(
              requestSnapshot.data() ?? {},
              userId,
              payloadHash,
            );
          }

          const [inviteSnapshot, lifecycleSnapshot] = await Promise.all([
            transaction.get(inviteRef),
            transaction.get(lifecycleRef),
          ]);

          if (inviteSnapshot.exists) {
            throw new InviteCodeCollisionError();
          }

          const quotaState = applyCreationQuota(
            readQuotaState(
              lifecycleSnapshot.data(),
              measuredActiveLeagueCount,
            ),
            nowMilliseconds,
          );
          const memberRef = db.doc(`leagues/${leagueRef.id}/members/${userId}`);
          const teamRef = db.doc(`leagues/${leagueRef.id}/teams/${userId}`);
          const rosterRef = db.doc(
            `leagues/${leagueRef.id}/teams/${userId}/roster/current`,
          );
          const auditRef = db.doc(`leagues/${leagueRef.id}/audit/league-created`);
          const timestamp = FieldValue.serverTimestamp();
          const roster = createEmptyFantasyRoster();
          const inviteExpiresAt = Timestamp.fromMillis(
            nowMilliseconds + LEAGUE_INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
          );

          transaction.create(leagueRef, {
            id: leagueRef.id,
            name: input.name,
            leagueLogoId: input.leagueLogoId,
            leagueLogoPaletteId: input.leagueLogoPaletteId,
            commissionerId: userId,
            inviteCode,
            maxTeams: input.maxTeams,
            teamCount: 1,
            joinStatus: 'open',
            joinLockedAt: null,
            joinLockedReason: null,
            matchupFormat: 'cycle_matchup',
            requiredGamesPerCycle: defaultScoringRules.requiredGamesPerCycle,
            scoringRules: defaultScoringRules,
            scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
            authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
            documentSchemaVersion: LEAGUE_DOCUMENT_SCHEMA_VERSION,
            createdByAuthority: 'createLeagueSecure',
            competitionSettingsLocked: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          });

          transaction.create(inviteRef, {
            schemaVersion: LEAGUE_INVITE_SCHEMA_VERSION,
            inviteCode,
            leagueId: leagueRef.id,
            createdBy: userId,
            active: true,
            joinCount: 1,
            expiresAt: inviteExpiresAt,
            lockedAt: null,
            lockedReason: null,
            createdAt: timestamp,
            updatedAt: timestamp,
            authority: 'createLeagueSecure',
          });

          transaction.create(memberRef, {
            schemaVersion: LEAGUE_MEMBER_SCHEMA_VERSION,
            uid: userId,
            leagueId: leagueRef.id,
            username: input.username,
            profileIconId: input.profileIconId,
            role: 'commissioner',
            inviteCodeUsed: null,
            joinedAt: timestamp,
            authority: 'createLeagueSecure',
          });

          transaction.create(
            teamRef,
            createTeamDocument(userId, input.username, input.profileIconId),
          );

          transaction.create(rosterRef, {
            ...roster,
            createdAt: timestamp,
            updatedAt: timestamp,
          });

          transaction.create(auditRef, {
            schemaVersion: LEAGUE_AUDIT_SCHEMA_VERSION,
            id: 'league-created',
            leagueId: leagueRef.id,
            action: 'league-created',
            actorId: userId,
            actorRole: 'commissioner',
            authority: 'cloud-function',
            authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
            reason: 'Initial server-authoritative league creation.',
            release: SECURITY_RELEASE_LABEL,
            values: {
              name: input.name,
              maxTeams: input.maxTeams,
              leagueLogoId: input.leagueLogoId,
              leagueLogoPaletteId: input.leagueLogoPaletteId,
              scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
              requiredGamesPerCycle: defaultScoringRules.requiredGamesPerCycle,
              matchupFormat: 'cycle_matchup',
              inviteExpiresAt,
            },
            createdAt: timestamp,
          });

          transaction.create(requestRef, {
            schemaVersion: LEAGUE_CREATION_REQUEST_SCHEMA_VERSION,
            requestId: input.requestId,
            ownerId: userId,
            payloadHash,
            status: 'complete',
            leagueId: leagueRef.id,
            inviteCode,
            authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
            createdAt: timestamp,
            expiresAt: Timestamp.fromMillis(
              nowMilliseconds + LEAGUE_CREATION_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            ),
          });

          transaction.set(
            lifecycleRef,
            quotaDocumentData(quotaState, nowMilliseconds),
            { merge: true },
          );

          return {
            created: true as const,
            leagueId: leagueRef.id,
            inviteCode,
            idempotentReplay: false,
            authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
          };
        });
      } catch (error: unknown) {
        if (error instanceof InviteCodeCollisionError) {
          continue;
        }

        throw error;
      }
    }

    throw new HttpsError(
      'resource-exhausted',
      'RinkRat could not reserve a unique invite code. Please try again.',
    );
  },
);

function readCompletedJoinRequest(
  data: DocumentData,
  userId: string,
  payloadHash: string,
): JoinLeagueSecureResult | null {
  if (asString(data['ownerId']) !== userId) {
    throw new HttpsError(
      'permission-denied',
      'This league-join request belongs to a different account.',
    );
  }

  if (asString(data['payloadHash']) !== payloadHash) {
    throw new HttpsError(
      'failed-precondition',
      'This join request was already used with different information. Refresh the page and try again.',
    );
  }

  if (data['status'] !== 'complete') {
    return null;
  }

  const leagueId = asString(data['leagueId']);
  const inviteCode = asString(data['inviteCode']);
  const teamCount = typeof data['teamCount'] === 'number'
    ? Math.max(1, Math.trunc(data['teamCount']))
    : 1;
  const maxTeams = typeof data['maxTeams'] === 'number'
    ? Math.max(2, Math.trunc(data['maxTeams']))
    : 2;

  if (!leagueId || !inviteCode) {
    throw new HttpsError(
      'aborted',
      'The prior league join is still being reconciled. Wait a moment and try again.',
    );
  }

  return {
    joined: true,
    leagueId,
    inviteCode,
    alreadyMember: data['alreadyMember'] === true,
    idempotentReplay: true,
    teamCount,
    maxTeams,
    authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
  };
}

async function reserveJoinAttempt(
  userId: string,
  input: NormalizedJoinLeagueRequest,
  payloadHash: string,
  measuredActiveLeagueCount: number,
  nowMilliseconds: number,
): Promise<void> {
  const requestRef = db.doc(
    `leagueJoinRequests/${createJoinRequestDocumentId(userId, input.requestId)}`,
  );
  const lifecycleRef = db.doc(`leagueLifecycleState/${userId}`);

  await db.runTransaction(async (transaction) => {
    const [requestSnapshot, lifecycleSnapshot] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(lifecycleRef),
    ]);

    const requestData = requestSnapshot.data() ?? {};

    if (requestSnapshot.exists) {
      if (asString(requestData['ownerId']) !== userId) {
        throw new HttpsError(
          'permission-denied',
          'This league-join request belongs to a different account.',
        );
      }

      if (asString(requestData['payloadHash']) !== payloadHash) {
        throw new HttpsError(
          'failed-precondition',
          'This join request was already used with different information. Refresh the page and try again.',
        );
      }

      // A confirmed idempotent replay performs no new invite-code work and
      // therefore does not consume another attempt. Unresolved retries still
      // pass through the rolling quota so one reused request ID cannot become
      // an unlimited invite-code or callable-abuse bypass.
      if (requestData['status'] === 'complete') {
        return;
      }
    }

    const quotaState = applyJoinAttemptQuota(
      readQuotaState(
        lifecycleSnapshot.data(),
        measuredActiveLeagueCount,
      ),
      nowMilliseconds,
    );

    transaction.set(
      lifecycleRef,
      quotaDocumentData(quotaState, nowMilliseconds),
      { merge: true },
    );

    if (requestSnapshot.exists) {
      const priorAttemptCount = typeof requestData['attemptCount'] === 'number'
        ? Math.max(0, Math.trunc(requestData['attemptCount']))
        : 1;

      transaction.set(requestRef, {
        attemptCount: priorAttemptCount + 1,
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      transaction.create(requestRef, {
        schemaVersion: LEAGUE_JOIN_REQUEST_SCHEMA_VERSION,
        requestId: input.requestId,
        ownerId: userId,
        payloadHash,
        inviteCodeHash: createHash('sha256').update(input.inviteCode).digest('hex'),
        status: 'reserved',
        attemptCount: 1,
        createdAt: FieldValue.serverTimestamp(),
        lastAttemptAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(
          nowMilliseconds + LEAGUE_JOIN_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ),
      });
    }
  });
}

export const joinLeagueSecure = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '256MiB',
    maxInstances: 80,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<JoinLeagueSecureResult> => {
    const userId = requireAuthenticatedUserId(request.auth, 'join a league');
    requireVerifiedEmail(request.auth, 'join a league');

    const input = normalizeJoinRequest(request.data);
    const payloadHash = createJoinPayloadHash(input);
    const requestRef = db.doc(
      `leagueJoinRequests/${createJoinRequestDocumentId(userId, input.requestId)}`,
    );
    const lifecycleRef = db.doc(`leagueLifecycleState/${userId}`);
    const inviteRef = db.doc(`leagueInvites/${input.inviteCode}`);
    const measuredActiveLeagueCount = await countExistingLeagueMemberships(userId);
    const nowMilliseconds = Date.now();

    await reserveJoinAttempt(
      userId,
      input,
      payloadHash,
      measuredActiveLeagueCount,
      nowMilliseconds,
    );

    return db.runTransaction(async (transaction) => {
      const requestSnapshot = await transaction.get(requestRef);

      if (!requestSnapshot.exists) {
        throw new HttpsError(
          'aborted',
          'RinkRat could not reserve this join request. Refresh the page and try again.',
        );
      }

      const requestData = requestSnapshot.data() ?? {};
      const completedRequest = readCompletedJoinRequest(
        requestData,
        userId,
        payloadHash,
      );

      if (completedRequest) {
        return completedRequest;
      }

      const inviteSnapshot = await transaction.get(inviteRef);

      if (!inviteSnapshot.exists) {
        throw new HttpsError('not-found', 'No league was found with that invite code.');
      }

      const inviteData = inviteSnapshot.data() ?? {};
      const leagueId = asString(inviteData['leagueId']);

      if (
        !leagueId ||
        asString(inviteData['inviteCode']) !== input.inviteCode
      ) {
        throw new HttpsError('not-found', 'No league was found with that invite code.');
      }

      const leagueRef = db.doc(`leagues/${leagueId}`);
      const draftRef = db.doc(`leagues/${leagueId}/draft/current`);
      const memberRef = db.doc(`leagues/${leagueId}/members/${userId}`);
      const teamRef = db.doc(`leagues/${leagueId}/teams/${userId}`);
      const rosterRef = db.doc(`leagues/${leagueId}/teams/${userId}/roster/current`);
      const membersQuery = db.collection(`leagues/${leagueId}/members`).limit(25);
      const teamsQuery = db.collection(`leagues/${leagueId}/teams`).limit(25);
      const [
        leagueSnapshot,
        draftSnapshot,
        memberSnapshot,
        teamSnapshot,
        rosterSnapshot,
        lifecycleSnapshot,
        membersSnapshot,
        teamsSnapshot,
      ] = await Promise.all([
        transaction.get(leagueRef),
        transaction.get(draftRef),
        transaction.get(memberRef),
        transaction.get(teamRef),
        transaction.get(rosterRef),
        transaction.get(lifecycleRef),
        transaction.get(membersQuery),
        transaction.get(teamsQuery),
      ]);

      if (!leagueSnapshot.exists) {
        throw new HttpsError('not-found', 'This league no longer exists.');
      }

      const leagueData = leagueSnapshot.data() ?? {};

      if (asString(leagueData['inviteCode']) !== input.inviteCode) {
        throw new HttpsError(
          'failed-precondition',
          'This invite code no longer matches the league.',
        );
      }

      const maxTeams = typeof leagueData['maxTeams'] === 'number'
        ? Math.max(2, Math.min(12, Math.trunc(leagueData['maxTeams'])))
        : 2;
      const occupiedOwnerIds = getOccupiedLeagueOwnerIds(
        membersSnapshot.docs.map((document) => document.id),
        teamsSnapshot.docs.map((document) => document.id),
      );
      const alreadyMember = memberSnapshot.exists || teamSnapshot.exists;
      const existingMemberData = memberSnapshot.data() ?? {};
      const existingTeamData = teamSnapshot.data() ?? {};
      const existingTeamProfileIconId = asString(existingTeamData['profileIconId']);
      const existingMemberProfileIconId = asString(existingMemberData['profileIconId']);
      const resolvedProfileIconId = SUPPORTED_PROFILE_ICON_IDS.has(existingTeamProfileIconId)
        ? existingTeamProfileIconId
        : SUPPORTED_PROFILE_ICON_IDS.has(existingMemberProfileIconId)
          ? existingMemberProfileIconId
          : input.profileIconId;
      const storedTeamCount = typeof leagueData['teamCount'] === 'number'
        ? Math.max(0, Math.trunc(leagueData['teamCount']))
        : 0;
      const currentTeamCount = Math.max(occupiedOwnerIds.length, storedTeamCount);
      const quotaState = readQuotaState(
        lifecycleSnapshot.data(),
        measuredActiveLeagueCount,
      );

      if (!alreadyMember) {
        const expiresAtMilliseconds = timestampMilliseconds(inviteData['expiresAt']);
        const inviteExpired = expiresAtMilliseconds !== null && expiresAtMilliseconds <= nowMilliseconds;
        const joinStatus = asString(leagueData['joinStatus']);

        if (inviteData['active'] !== true || inviteExpired) {
          throw new HttpsError(
            'failed-precondition',
            inviteExpired
              ? 'This league invite has expired. Ask the commissioner for a new invite.'
              : 'This league invite is no longer active.',
            { reason: inviteExpired ? 'invite-expired' : 'invite-inactive' },
          );
        }

        if (joinStatus === 'locked' || joinStatus === 'full' || isDraftJoinLocked(draftSnapshot.data())) {
          throw new HttpsError(
            'failed-precondition',
            'League entry closed when the draft order was saved. Ask the commissioner to create a new league if another team is needed.',
            { reason: 'draft-join-locked' },
          );
        }

        if (currentTeamCount >= maxTeams) {
          throw new HttpsError(
            'resource-exhausted',
            `This league is full (${maxTeams} of ${maxTeams} teams).`,
            { reason: 'league-full' },
          );
        }

        if (quotaState.activeLeagueCount >= MAX_ACTIVE_LEAGUES_PER_USER) {
          throw new HttpsError(
            'resource-exhausted',
            `You can belong to at most ${MAX_ACTIVE_LEAGUES_PER_USER} active RinkRat leagues during the beta.`,
            { reason: 'active-league-limit' },
          );
        }
      }

      const timestamp = FieldValue.serverTimestamp();
      const roster = createEmptyFantasyRoster();
      const resultingTeamCount = alreadyMember
        ? currentTeamCount
        : currentTeamCount + 1;
      const resultingQuotaState: LeagueLifecycleQuotaState = alreadyMember
        ? quotaState
        : {
            ...quotaState,
            activeLeagueCount: quotaState.activeLeagueCount + 1,
          };

      if (!memberSnapshot.exists) {
        transaction.create(memberRef, {
          schemaVersion: LEAGUE_MEMBER_SCHEMA_VERSION,
          uid: userId,
          leagueId,
          username: input.username,
          profileIconId: resolvedProfileIconId,
          role: 'member',
          inviteCodeUsed: input.inviteCode,
          joinedAt: timestamp,
          authority: 'joinLeagueSecure',
        });
      } else {
        transaction.set(
          memberRef,
          {
            schemaVersion: LEAGUE_MEMBER_SCHEMA_VERSION,
            username: input.username,
            authority: getOptionalString(existingMemberData['authority'], 80) ?? 'joinLeagueSecure',
            updatedAt: timestamp,
            ...(SUPPORTED_PROFILE_ICON_IDS.has(existingMemberProfileIconId)
              ? {}
              : { profileIconId: resolvedProfileIconId }),
          },
          { merge: true },
        );
      }

      if (!teamSnapshot.exists) {
        transaction.create(
          teamRef,
          createTeamDocument(
            userId,
            input.username,
            resolvedProfileIconId,
            Math.max(1, resultingTeamCount),
          ),
        );
      } else {
        transaction.set(
          teamRef,
          {
            schemaVersion: LEAGUE_TEAM_SCHEMA_VERSION,
            managerName: input.username,
            authority: getOptionalString(existingTeamData['authority'], 80) ?? 'joinLeagueSecure',
            ...(SUPPORTED_PROFILE_ICON_IDS.has(existingTeamProfileIconId)
              ? {}
              : { profileIconId: resolvedProfileIconId }),
            updatedAt: timestamp,
          },
          { merge: true },
        );
      }

      if (!rosterSnapshot.exists) {
        transaction.create(rosterRef, {
          ...roster,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }

      const leagueIsFull = resultingTeamCount >= maxTeams;

      if (!alreadyMember) {
        transaction.set(
          leagueRef,
          {
            teamCount: resultingTeamCount,
            authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
            documentSchemaVersion: LEAGUE_DOCUMENT_SCHEMA_VERSION,
            competitionSettingsLocked: true,
            joinStatus: leagueIsFull ? 'full' : 'open',
            joinLockedAt: leagueIsFull ? timestamp : null,
            joinLockedReason: leagueIsFull ? 'league-full' : null,
            updatedAt: timestamp,
          },
          { merge: true },
        );

        transaction.set(
          inviteRef,
          {
            schemaVersion: LEAGUE_INVITE_SCHEMA_VERSION,
            authority: 'joinLeagueSecure',
            active: !leagueIsFull,
            joinCount: resultingTeamCount,
            lockedAt: leagueIsFull ? timestamp : null,
            lockedReason: leagueIsFull ? 'league-full' : null,
            lastJoinedAt: timestamp,
            updatedAt: timestamp,
          },
          { merge: true },
        );
      } else if (storedTeamCount !== resultingTeamCount) {
        transaction.set(
          leagueRef,
          {
            teamCount: resultingTeamCount,
            authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
            documentSchemaVersion: LEAGUE_DOCUMENT_SCHEMA_VERSION,
            competitionSettingsLocked: true,
            updatedAt: timestamp,
          },
          { merge: true },
        );
      }

      if (!alreadyMember) {
        const auditId = `member-joined-${userId}-${requestRef.id.slice(0, 12)}`;
        const auditRef = db.doc(`leagues/${leagueId}/audit/${auditId}`);
        transaction.create(auditRef, {
          schemaVersion: LEAGUE_AUDIT_SCHEMA_VERSION,
          id: auditId,
          leagueId,
          action: 'member-joined',
          actorId: userId,
          actorRole: 'member',
          authority: 'cloud-function',
          authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
          reason: 'Atomic invite-code league join.',
          release: SECURITY_RELEASE_LABEL,
          values: {
            inviteCodeUsed: input.inviteCode,
            resultingTeamCount,
            maxTeams,
          },
          createdAt: timestamp,
        });
      }

      transaction.set(
        lifecycleRef,
        quotaDocumentData(resultingQuotaState, nowMilliseconds),
        { merge: true },
      );
      transaction.set(requestRef, {
        status: 'complete',
        leagueId,
        inviteCode: input.inviteCode,
        alreadyMember,
        teamCount: resultingTeamCount,
        maxTeams,
        completedAt: timestamp,
        updatedAt: timestamp,
      }, { merge: true });

      return {
        joined: true as const,
        leagueId,
        inviteCode: input.inviteCode,
        alreadyMember,
        idempotentReplay: false,
        teamCount: resultingTeamCount,
        maxTeams,
        authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
      };
    });
  },
);


function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

function getNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(0, value)
    : fallback;
}

function getProfileIconOrFallback(value: unknown): string {
  const profileIconId = asString(value);
  return SUPPORTED_PROFILE_ICON_IDS.has(profileIconId)
    ? profileIconId
    : 'hockey-referee';
}

function getLeagueLogoOrFallback(value: unknown): string {
  const logoId = asString(value);
  return SUPPORTED_LEAGUE_LOGO_IDS.has(logoId)
    ? logoId
    : 'rink-rat';
}

function getLeaguePaletteOrFallback(value: unknown): string {
  const paletteId = asString(value);
  return SUPPORTED_LEAGUE_LOGO_PALETTE_IDS.has(paletteId)
    ? paletteId
    : 'rink-gold';
}

function getBoundedDisplayText(
  value: unknown,
  fallback: string,
  maximumLength: number,
): string {
  const text = asString(value);
  return text && text.length <= maximumLength ? text : fallback;
}

function getOptionalTimestamp(value: unknown): Timestamp | null {
  return value instanceof Timestamp ? value : null;
}

function getOptionalString(value: unknown, maximumLength: number): string | null {
  const text = asString(value);
  return text && text.length <= maximumLength ? text : null;
}

function buildCanonicalMemberDocument(input: {
  leagueId: string;
  ownerId: string;
  commissionerId: string;
  memberData: Record<string, unknown>;
  teamData: Record<string, unknown>;
  timestamp: ReturnType<typeof FieldValue.serverTimestamp>;
}): Record<string, unknown> {
  const fallbackName = getBoundedDisplayText(
    input.teamData['managerName'] ?? input.teamData['teamName'],
    input.ownerId === input.commissionerId ? 'Commissioner' : 'RinkRat Manager',
    40,
  );
  const username = getBoundedDisplayText(
    input.memberData['username'],
    fallbackName,
    40,
  );
  const profileIconId = getProfileIconOrFallback(
    input.memberData['profileIconId'] ?? input.teamData['profileIconId'],
  );
  const inviteCodeUsed = asString(input.memberData['inviteCodeUsed']);
  const accountDeleted = input.memberData['accountDeleted'] === true;
  const accountDeletedAt = getOptionalTimestamp(input.memberData['accountDeletedAt']);

  return {
    schemaVersion: LEAGUE_MEMBER_SCHEMA_VERSION,
    uid: input.ownerId,
    leagueId: input.leagueId,
    username,
    profileIconId,
    role: input.ownerId === input.commissionerId ? 'commissioner' : 'member',
    inviteCodeUsed: inviteCodeUsed.length === INVITE_CODE_LENGTH ? inviteCodeUsed : null,
    joinedAt: getOptionalTimestamp(input.memberData['joinedAt']) ?? input.timestamp,
    authority: getOptionalString(input.memberData['authority'], 80) ?? 'migrateLeagueAuthoritySchema',
    ...(accountDeleted ? { accountDeleted: true } : {}),
    ...(accountDeletedAt ? { accountDeletedAt } : {}),
    updatedAt: input.timestamp,
  };
}

function buildCanonicalTeamDocument(input: {
  ownerId: string;
  commissionerId: string;
  memberData: Record<string, unknown>;
  teamData: Record<string, unknown>;
  waiverPriority: number;
  timestamp: ReturnType<typeof FieldValue.serverTimestamp>;
}): Record<string, unknown> {
  const managerName = getBoundedDisplayText(
    input.teamData['managerName'] ?? input.memberData['username'],
    input.ownerId === input.commissionerId ? 'Commissioner' : 'RinkRat Manager',
    40,
  );
  const teamName = getBoundedDisplayText(
    input.teamData['teamName'],
    `${managerName}'s Team`.slice(0, 60),
    60,
  );
  const profileIconId = getProfileIconOrFallback(
    input.teamData['profileIconId'] ?? input.memberData['profileIconId'],
  );
  const logo = getBoundedDisplayText(input.teamData['logo'], '', 240);
  const draftPositionValue = input.teamData['draftPosition'];
  const draftPosition = typeof draftPositionValue === 'number' && Number.isInteger(draftPositionValue)
    ? Math.max(1, Math.min(32, draftPositionValue))
    : null;
  const accountDeleted = input.teamData['accountDeleted'] === true;
  const accountDeletedAt = getOptionalTimestamp(input.teamData['accountDeletedAt']);

  return {
    schemaVersion: LEAGUE_TEAM_SCHEMA_VERSION,
    id: input.ownerId,
    ownerId: input.ownerId,
    teamName,
    managerName,
    profileIconId,
    logo,
    wins: getNonNegativeInteger(input.teamData['wins'], 0),
    losses: getNonNegativeInteger(input.teamData['losses'], 0),
    ties: getNonNegativeInteger(input.teamData['ties'], 0),
    pointsFor: Math.max(0, getFiniteNumber(input.teamData['pointsFor'], 0)),
    pointsAgainst: Math.max(0, getFiniteNumber(input.teamData['pointsAgainst'], 0)),
    waiverPriority: Math.max(
      1,
      Math.min(32, getNonNegativeInteger(input.teamData['waiverPriority'], input.waiverPriority)),
    ),
    draftPosition,
    createdAt: getOptionalTimestamp(input.teamData['createdAt']) ?? input.timestamp,
    updatedAt: input.timestamp,
    authority: getOptionalString(input.teamData['authority'], 80) ?? 'migrateLeagueAuthoritySchema',
    ...(accountDeleted ? { accountDeleted: true } : {}),
    ...(accountDeletedAt ? { accountDeletedAt } : {}),
  };
}

function buildCanonicalLeagueDocument(input: {
  leagueId: string;
  data: Record<string, unknown>;
  commissionerId: string;
  inviteCode: string;
  teamCount: number;
  draftLocked: boolean;
  timestamp: ReturnType<typeof FieldValue.serverTimestamp>;
}): Record<string, unknown> {
  const maxTeams = Math.max(
    input.teamCount,
    Math.min(12, Math.max(2, getNonNegativeInteger(input.data['maxTeams'], 6))),
  );
  const joinStatus = getCanonicalJoinStatus({
    teamCount: input.teamCount,
    maxTeams,
    draftLocked: input.draftLocked,
    storedStatus: input.data['joinStatus'],
  });
  const joinLockedAt = joinStatus === 'open'
    ? null
    : getOptionalTimestamp(input.data['joinLockedAt']) ?? input.timestamp;
  const joinLockedReason = joinStatus === 'full'
    ? 'league-full'
    : joinStatus === 'locked'
      ? getOptionalString(input.data['joinLockedReason'], 80) ?? 'authority-migration-draft-lock'
      : null;

  return {
    id: input.leagueId,
    name: getBoundedDisplayText(input.data['name'], 'RinkRat League', 80),
    leagueLogoId: getLeagueLogoOrFallback(input.data['leagueLogoId']),
    leagueLogoPaletteId: getLeaguePaletteOrFallback(input.data['leagueLogoPaletteId']),
    commissionerId: input.commissionerId,
    inviteCode: input.inviteCode,
    maxTeams,
    teamCount: input.teamCount,
    joinStatus,
    joinLockedAt,
    joinLockedReason,
    matchupFormat: 'cycle_matchup',
    requiredGamesPerCycle: defaultScoringRules.requiredGamesPerCycle,
    scoringRules: defaultScoringRules,
    scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
    authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
    documentSchemaVersion: LEAGUE_DOCUMENT_SCHEMA_VERSION,
    createdByAuthority: getOptionalString(input.data['createdByAuthority'], 80) ?? 'migrateLeagueAuthoritySchema',
    competitionSettingsLocked: true,
    createdAt: getOptionalTimestamp(input.data['createdAt']) ?? input.timestamp,
    migratedAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

function buildCanonicalInviteDocument(input: {
  data: Record<string, unknown>;
  leagueId: string;
  inviteCode: string;
  commissionerId: string;
  teamCount: number;
  joinStatus: 'open' | 'locked' | 'full';
  timestamp: ReturnType<typeof FieldValue.serverTimestamp>;
}): Record<string, unknown> {
  const joinOpen = input.joinStatus === 'open';
  const expiresAt = getOptionalTimestamp(input.data['expiresAt']) ?? Timestamp.fromMillis(
    Date.now() + LEAGUE_INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );

  return {
    schemaVersion: LEAGUE_INVITE_SCHEMA_VERSION,
    inviteCode: input.inviteCode,
    leagueId: input.leagueId,
    createdBy: input.commissionerId,
    active: joinOpen,
    joinCount: input.teamCount,
    expiresAt,
    lockedAt: joinOpen
      ? null
      : getOptionalTimestamp(input.data['lockedAt']) ?? input.timestamp,
    lockedReason: joinOpen
      ? null
      : getOptionalString(input.data['lockedReason'], 80) ?? input.joinStatus,
    ...(getOptionalTimestamp(input.data['lastJoinedAt'])
      ? { lastJoinedAt: getOptionalTimestamp(input.data['lastJoinedAt']) }
      : {}),
    createdAt: getOptionalTimestamp(input.data['createdAt']) ?? input.timestamp,
    updatedAt: input.timestamp,
    authority: 'migrateLeagueAuthoritySchema',
  };
}

export const updateLeagueCosmeticsSecure = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '256MiB',
    maxInstances: 40,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<UpdateLeagueCosmeticsSecureResult> => {
    const userId = requireAuthenticatedUserId(request.auth, 'update league presentation');
    requireVerifiedEmail(request.auth, 'update league presentation');
    const input = normalizeUpdateLeagueCosmeticsRequest(request.data);
    const payloadHash = createCosmeticsPayloadHash(input);
    const leagueRef = db.doc(`leagues/${input.leagueId}`);
    const auditId = createAuditDocumentId('league-presentation', input.requestId);
    const auditRef = db.doc(`leagues/${input.leagueId}/audit/${auditId}`);

    return db.runTransaction(async (transaction) => {
      const [leagueSnapshot, auditSnapshot] = await Promise.all([
        transaction.get(leagueRef),
        transaction.get(auditRef),
      ]);

      if (!leagueSnapshot.exists) {
        throw new HttpsError('not-found', 'This league no longer exists.');
      }

      const leagueData = leagueSnapshot.data() ?? {};

      if (asString(leagueData['commissionerId']) !== userId) {
        throw new HttpsError(
          'permission-denied',
          'Only the league commissioner can update league presentation.',
        );
      }

      if (
        getNonNegativeInteger(leagueData['authoritySchemaVersion'], 0) <
        LEAGUE_AUTHORITY_SCHEMA_VERSION
      ) {
        throw new HttpsError(
          'failed-precondition',
          'This league must complete its authority migration before presentation settings can change.',
          { reason: 'authority-migration-required' },
        );
      }

      if (auditSnapshot.exists) {
        const auditData = auditSnapshot.data() ?? {};

        if (
          asString(auditData['actorId']) !== userId ||
          asString(auditData['payloadHash']) !== payloadHash
        ) {
          throw new HttpsError(
            'already-exists',
            'That league-settings request identifier was already used for different information.',
          );
        }

        return {
          updated: true,
          leagueId: input.leagueId,
          changed: auditData['changed'] === true,
          idempotentReplay: true,
          authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
        };
      }

      const previousValues = {
        name: getBoundedDisplayText(leagueData['name'], 'RinkRat League', 80),
        leagueLogoId: getLeagueLogoOrFallback(leagueData['leagueLogoId']),
        leagueLogoPaletteId: getLeaguePaletteOrFallback(leagueData['leagueLogoPaletteId']),
      };
      const nextValues = {
        name: input.name,
        leagueLogoId: input.leagueLogoId,
        leagueLogoPaletteId: input.leagueLogoPaletteId,
      };
      const changed = JSON.stringify(previousValues) !== JSON.stringify(nextValues);
      const timestamp = FieldValue.serverTimestamp();

      if (changed) {
        transaction.update(leagueRef, {
          ...nextValues,
          documentSchemaVersion: LEAGUE_DOCUMENT_SCHEMA_VERSION,
          authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
          competitionSettingsLocked: true,
          updatedAt: timestamp,
        });
      }

      transaction.create(auditRef, {
        schemaVersion: LEAGUE_AUDIT_SCHEMA_VERSION,
        id: auditId,
        leagueId: input.leagueId,
        action: 'league-presentation-updated',
        actorId: userId,
        actorRole: 'commissioner',
        authority: 'cloud-function',
        authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
        requestId: input.requestId,
        payloadHash,
        changed,
        reason: input.reason,
        release: SECURITY_RELEASE_LABEL,
        previousValues,
        newValues: nextValues,
        createdAt: timestamp,
      });

      return {
        updated: true,
        leagueId: input.leagueId,
        changed,
        idempotentReplay: false,
        authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
      };
    });
  },
);

export const migrateLeagueAuthoritySchema = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '512MiB',
    maxInstances: 3,
    concurrency: 1,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<MigrateLeagueAuthoritySchemaResult> => {
    const platformAdminId = await requirePlatformAdministrator(request.auth);
    requireVerifiedRecentAuthentication(
      request.auth,
      'migrate this league to the current authority schema',
    );
    const input = normalizeMigrationRequest(request.data);
    const leagueRef = db.doc(`leagues/${input.leagueId}`);
    const preliminaryLeagueSnapshot = await leagueRef.get();

    if (!preliminaryLeagueSnapshot.exists) {
      throw new HttpsError('not-found', 'This league no longer exists.');
    }

    const preliminaryLeagueData = preliminaryLeagueSnapshot.data() ?? {};
    let inviteCode = asString(preliminaryLeagueData['inviteCode']).toUpperCase();

    for (let attempt = 0; attempt < MAX_INVITE_CODE_ATTEMPTS; attempt += 1) {
      if (
        inviteCode.length !== INVITE_CODE_LENGTH ||
        !/^[A-Z0-9]+$/.test(inviteCode)
      ) {
        inviteCode = createInviteCodeCandidate();
      }

      const inviteRef = db.doc(`leagueInvites/${inviteCode}`);
      const auditRef = db.doc(
        `leagues/${input.leagueId}/audit/authority-migrated-v${LEAGUE_AUTHORITY_SCHEMA_VERSION}`,
      );

      try {
        return await db.runTransaction(async (transaction) => {
          const membersQuery = db.collection(`leagues/${input.leagueId}/members`).limit(40);
          const teamsQuery = db.collection(`leagues/${input.leagueId}/teams`).limit(40);
          const draftRef = db.doc(`leagues/${input.leagueId}/draft/current`);
          const [
            leagueSnapshot,
            inviteSnapshot,
            auditSnapshot,
            draftSnapshot,
            memberSnapshots,
            teamSnapshots,
          ] = await Promise.all([
            transaction.get(leagueRef),
            transaction.get(inviteRef),
            transaction.get(auditRef),
            transaction.get(draftRef),
            transaction.get(membersQuery),
            transaction.get(teamsQuery),
          ]);

          if (!leagueSnapshot.exists) {
            throw new HttpsError('not-found', 'This league no longer exists.');
          }

          const leagueData = leagueSnapshot.data() ?? {};

          if (asString(leagueData['deletionStatus']) === 'deleting') {
            throw new HttpsError(
              'failed-precondition',
              'A league being deleted cannot be migrated.',
            );
          }

          if (
            inviteSnapshot.exists &&
            asString((inviteSnapshot.data() ?? {})['leagueId']) !== input.leagueId
          ) {
            throw new InviteCodeCollisionError();
          }

          const memberByOwner = new Map(
            memberSnapshots.docs.map((document) => [document.id, document.data() ?? {}]),
          );
          const teamByOwner = new Map(
            teamSnapshots.docs.map((document) => [document.id, document.data() ?? {}]),
          );
          const commissionerId = asString(leagueData['commissionerId']) ||
            memberSnapshots.docs.find(
              (document) => asString(document.data()?.['role']) === 'commissioner',
            )?.id || '';

          if (!LEAGUE_ID_PATTERN.test(commissionerId)) {
            throw new HttpsError(
              'failed-precondition',
              'The existing league commissioner could not be verified safely.',
            );
          }

          const ownerIds = getOccupiedLeagueOwnerIds(
            memberSnapshots.docs.map((document) => document.id),
            teamSnapshots.docs.map((document) => document.id),
          );

          if (!ownerIds.includes(commissionerId)) {
            ownerIds.unshift(commissionerId);
          }

          if (ownerIds.length > 12) {
            throw new HttpsError(
              'failed-precondition',
              'This league has more than 12 occupied owner records and requires manual review.',
            );
          }

          const rosterSnapshots = await Promise.all(
            ownerIds.map((ownerId) => transaction.get(
              db.doc(`leagues/${input.leagueId}/teams/${ownerId}/roster/current`),
            )),
          );
          const rosterExistsByOwner = new Map(
            ownerIds.map((ownerId, index) => [ownerId, rosterSnapshots[index]?.exists === true]),
          );
          const timestamp = FieldValue.serverTimestamp();
          const canonicalLeague = buildCanonicalLeagueDocument({
            leagueId: input.leagueId,
            data: leagueData,
            commissionerId,
            inviteCode,
            teamCount: ownerIds.length,
            draftLocked: isDraftJoinLocked(draftSnapshot.data()),
            timestamp,
          });
          const joinStatus = canonicalLeague['joinStatus'] as 'open' | 'locked' | 'full';
          const canonicalInvite = buildCanonicalInviteDocument({
            data: inviteSnapshot.data() ?? {},
            leagueId: input.leagueId,
            inviteCode,
            commissionerId,
            teamCount: ownerIds.length,
            joinStatus,
            timestamp,
          });
          let repairedMemberCount = 0;
          let repairedTeamCount = 0;
          let repairedRosterCount = 0;
          let removedUnexpectedFieldCount = getUnexpectedDocumentKeys(
            leagueData,
            LEAGUE_DOCUMENT_KEYS,
          ).length + getUnexpectedDocumentKeys(
            inviteSnapshot.data() ?? {},
            LEAGUE_INVITE_DOCUMENT_KEYS,
          ).length;

          transaction.set(leagueRef, canonicalLeague);
          transaction.set(inviteRef, canonicalInvite);

          ownerIds.forEach((ownerId, index) => {
            const memberData = memberByOwner.get(ownerId) ?? {};
            const teamData = teamByOwner.get(ownerId) ?? {};
            const memberRef = db.doc(`leagues/${input.leagueId}/members/${ownerId}`);
            const teamRef = db.doc(`leagues/${input.leagueId}/teams/${ownerId}`);

            removedUnexpectedFieldCount += getUnexpectedDocumentKeys(
              memberData,
              LEAGUE_MEMBER_DOCUMENT_KEYS,
            ).length;
            removedUnexpectedFieldCount += getUnexpectedDocumentKeys(
              teamData,
              LEAGUE_TEAM_DOCUMENT_KEYS,
            ).length;

            if (!memberByOwner.has(ownerId)) {
              repairedMemberCount += 1;
            }

            if (!teamByOwner.has(ownerId)) {
              repairedTeamCount += 1;
            }

            transaction.set(memberRef, buildCanonicalMemberDocument({
              leagueId: input.leagueId,
              ownerId,
              commissionerId,
              memberData,
              teamData,
              timestamp,
            }));
            transaction.set(teamRef, buildCanonicalTeamDocument({
              ownerId,
              commissionerId,
              memberData,
              teamData,
              waiverPriority: index + 1,
              timestamp,
            }));

            if (rosterExistsByOwner.get(ownerId) !== true) {
              const rosterRef = db.doc(
                `leagues/${input.leagueId}/teams/${ownerId}/roster/current`,
              );
              transaction.create(rosterRef, {
                ...createEmptyFantasyRoster(),
                createdAt: timestamp,
                updatedAt: timestamp,
                authority: 'migrateLeagueAuthoritySchema',
              });
              repairedRosterCount += 1;
            }
          });

          if (!auditSnapshot.exists) {
            transaction.create(auditRef, {
              schemaVersion: LEAGUE_AUDIT_SCHEMA_VERSION,
              id: `authority-migrated-v${LEAGUE_AUTHORITY_SCHEMA_VERSION}`,
              leagueId: input.leagueId,
              action: 'league-authority-migrated',
              actorId: platformAdminId,
              actorRole: 'platform-admin',
              authority: 'cloud-function',
              authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
              reason: input.reason,
              release: SECURITY_RELEASE_LABEL,
              previousValues: {
                authoritySchemaVersion: getNonNegativeInteger(
                  leagueData['authoritySchemaVersion'],
                  0,
                ),
                scoringRulesVersion: getNonNegativeInteger(
                  leagueData['scoringRulesVersion'],
                  0,
                ),
                requiredGamesPerCycle: getNonNegativeInteger(
                  leagueData['requiredGamesPerCycle'],
                  0,
                ),
                unexpectedLeagueFields: getUnexpectedDocumentKeys(
                  leagueData,
                  LEAGUE_DOCUMENT_KEYS,
                ),
              },
              newValues: {
                authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
                documentSchemaVersion: LEAGUE_DOCUMENT_SCHEMA_VERSION,
                scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
                requiredGamesPerCycle: defaultScoringRules.requiredGamesPerCycle,
                matchupFormat: 'cycle_matchup',
                teamCount: ownerIds.length,
                inviteCode,
              },
              repairedMemberCount,
              repairedTeamCount,
              repairedRosterCount,
              removedUnexpectedFieldCount,
              createdAt: timestamp,
            });
          }

          return {
            migrated: true as const,
            leagueId: input.leagueId,
            idempotentReplay: auditSnapshot.exists,
            authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
            teamCount: ownerIds.length,
            memberCount: ownerIds.length,
            repairedMemberCount,
            repairedTeamCount,
            repairedRosterCount,
            removedUnexpectedFieldCount,
          };
        });
      } catch (error: unknown) {
        if (error instanceof InviteCodeCollisionError) {
          inviteCode = '';
          continue;
        }

        throw error;
      }
    }

    throw new HttpsError(
      'resource-exhausted',
      'RinkRat could not reserve a safe invite code for this migration.',
    );
  },
);

export async function releaseActiveLeagueQuotaForUsers(
  userIds: readonly string[],
): Promise<void> {
  const uniqueUserIds = [...new Set(userIds.map(asString).filter(Boolean))];

  await Promise.all(uniqueUserIds.map(async (userId) => {
    const stateRef = db.doc(`leagueLifecycleState/${userId}`);

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(stateRef);

      if (!snapshot.exists) {
        return;
      }

      const data = snapshot.data() ?? {};
      const currentCount = typeof data['activeLeagueCount'] === 'number'
        ? Math.max(0, Math.trunc(data['activeLeagueCount']))
        : 0;

      transaction.set(stateRef, {
        activeLeagueCount: Math.max(0, currentCount - 1),
        lastMembershipReleasedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }));
}
