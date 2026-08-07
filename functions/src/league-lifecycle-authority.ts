import { createHash, randomBytes } from 'node:crypto';

import { DocumentData, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
} from './shared/core/scoring/scoring-rules';
import { createEmptyFantasyRoster } from './shared/core/team/roster.service';
import {
  getEffectiveActiveLeagueCount,
  getOccupiedLeagueOwnerIds,
  isDraftJoinLocked,
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
const LEAGUE_AUTHORITY_SCHEMA_VERSION = 1;
const LEAGUE_CREATION_REQUEST_SCHEMA_VERSION = 1;
const LEAGUE_CREATION_REQUEST_RETENTION_DAYS = 30;
const LEAGUE_JOIN_REQUEST_SCHEMA_VERSION = 1;
const LEAGUE_JOIN_REQUEST_RETENTION_DAYS = 30;
const LEAGUE_INVITE_EXPIRY_DAYS = 180;
const INVITE_CODE_LENGTH = 6;
const MAX_INVITE_CODE_ATTEMPTS = 20;
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

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
    token?: { email?: unknown; email_verified?: unknown };
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
  auth: { token?: { email?: unknown; email_verified?: unknown } } | undefined,
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
    ? data as CreateLeagueSecureRequest
    : {};

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
    ? data as JoinLeagueSecureRequest
    : {};

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
            createdByAuthority: 'createLeagueSecure',
            competitionSettingsLocked: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          });

          transaction.create(inviteRef, {
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
          });

          transaction.create(memberRef, {
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
            id: 'league-created',
            leagueId: leagueRef.id,
            action: 'league-created',
            actorId: userId,
            actorRole: 'commissioner',
            authority: 'cloud-function',
            authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
            reason: 'Initial server-authoritative league creation.',
            release: 'Security Batch S1B',
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
            username: input.username,
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
            managerName: input.username,
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
            updatedAt: timestamp,
          },
          { merge: true },
        );
      }

      if (!alreadyMember) {
        const auditId = `member-joined-${userId}-${requestRef.id.slice(0, 12)}`;
        const auditRef = db.doc(`leagues/${leagueId}/audit/${auditId}`);
        transaction.create(auditRef, {
          id: auditId,
          leagueId,
          action: 'member-joined',
          actorId: userId,
          actorRole: 'member',
          authority: 'cloud-function',
          authoritySchemaVersion: LEAGUE_AUTHORITY_SCHEMA_VERSION,
          reason: 'Atomic invite-code league join.',
          release: 'Security Batch S1B',
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
