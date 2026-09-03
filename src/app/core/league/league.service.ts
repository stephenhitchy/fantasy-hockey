import {
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { auth, db } from '../firebase';
import { functions } from '../firebase-functions';
import {
  CURRENT_SCORING_RULES_VERSION,
  SCORING_RULES_V3_VERSION,
  defaultScoringRules,
  scoringRulesForVersion,
  ScoringRules,
} from '../scoring/scoring-rules';
import { getLeagueTeams } from '../team/team.service';
import type { DashboardLeagueActivity } from './dashboard-league-activity.models';
import {
  DEFAULT_LEAGUE_LOGO_ID,
  DEFAULT_LEAGUE_LOGO_PALETTE_ID,
  LeagueLogoId,
  LeagueLogoPaletteId,
  normalizeLeagueLogoId,
  normalizeLeagueLogoPaletteId,
} from '../../shared/league-logo/league-logo.data';
import {
  getProfileIcon,
  getRandomProfileIconId,
  getSeededProfileIconId,
  isProfileIconId,
  ProfileIconId,
} from '../../shared/profile-icon/profile-icon.data';
import { buildLeagueIdentityRepair } from './league-identity-repair.util';

export interface League {
  id: string;
  name: string;
  leagueLogoId: LeagueLogoId;
  leagueLogoPaletteId: LeagueLogoPaletteId;
  commissionerId: string;
  inviteCode: string;
  maxTeams: number;
  teamCount?: number;
  joinStatus?: 'open' | 'locked' | 'full';
  joinLockedAt?: unknown;
  joinLockedReason?: string | null;
  matchupFormat: string;
  scoringRules: ScoringRules;
  scoringRulesVersion?: number;
  authoritySchemaVersion?: number;
  documentSchemaVersion?: number;
  createdByAuthority?: string;
  competitionSettingsLocked?: boolean;
  migratedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface LeagueMember {
  uid: string;
  leagueId: string;
  username: string;
  profileIconId?: ProfileIconId;
  role: 'commissioner' | 'member';
  inviteCodeUsed: string | null;
  joinedAt?: unknown;
}

export interface LeagueInvite {
  inviteCode: string;
  leagueId: string;
  createdBy: string;
  active: boolean;
  joinCount?: number;
  expiresAt?: unknown;
  lockedAt?: unknown;
  lockedReason?: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface DeleteLeagueRequest {
  leagueId: string;
  confirmationName: string;
}

interface DeleteLeagueResponse {
  deleted: boolean;
  leagueId: string;
}

interface CreateLeagueSecureRequest {
  requestId: string;
  name: string;
  maxTeams: number;
  username: string;
  leagueLogoId: LeagueLogoId;
  leagueLogoPaletteId: LeagueLogoPaletteId;
  profileIconId: ProfileIconId;
}

interface CreateLeagueSecureResponse {
  created: true;
  leagueId: string;
  inviteCode: string;
  idempotentReplay: boolean;
  authoritySchemaVersion: number;
}

interface JoinLeagueSecureRequest {
  requestId: string;
  inviteCode: string;
  username: string;
  profileIconId: ProfileIconId;
}

interface JoinLeagueSecureResponse {
  joined: true;
  leagueId: string;
  inviteCode: string;
  alreadyMember: boolean;
  idempotentReplay: boolean;
  teamCount: number;
  maxTeams: number;
  authoritySchemaVersion: number;
}

interface RemoveLeagueMemberSecureRequest {
  requestId: string;
  leagueId: string;
  targetOwnerId: string;
  confirmationTeamName: string;
}

export interface RemoveLeagueMemberSecureResponse {
  removed: true;
  leagueId: string;
  targetOwnerId: string;
  removedTeamName: string;
  teamCount: number;
  maxTeams: number;
  joinStatus: 'open' | 'locked' | 'full';
  idempotentReplay: boolean;
  auditId: string;
}

interface UpdateLeagueCosmeticsSecureRequest {
  requestId: string;
  leagueId: string;
  name: string;
  leagueLogoId: LeagueLogoId;
  leagueLogoPaletteId: LeagueLogoPaletteId;
  reason: string;
}

interface UpdateLeagueCosmeticsSecureResponse {
  updated: true;
  leagueId: string;
  changed: boolean;
  idempotentReplay: boolean;
  authoritySchemaVersion: number;
}

interface MigrateLeagueAuthoritySchemaRequest {
  leagueId: string;
  reason: string;
}

export interface MigrateLeagueAuthoritySchemaResponse {
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

interface PendingLeagueCreationRequest {
  fingerprint: string;
  requestId: string;
  profileIconId: ProfileIconId;
  createdAt: number;
}

interface PendingLeagueJoinRequest {
  fingerprint: string;
  requestId: string;
  profileIconId: ProfileIconId;
  createdAt: number;
}

interface PendingLeagueMemberRemovalRequest {
  fingerprint: string;
  requestId: string;
  createdAt: number;
}

export interface LeagueSummary {
  leagueId: string;
  leagueName: string;
  leagueLogoId: LeagueLogoId;
  leagueLogoPaletteId: LeagueLogoPaletteId;
  inviteCode: string;
  myTeamName: string;
  teamCount: number;
  maxTeams: number;

  isCommissioner: boolean;
  wins: number;
  losses: number;
  ties: number;
  dashboardActivity?: DashboardLeagueActivity;

  topOffensivePlayer?: {
    name: string;
    teamLogo: string;
    points: number;
  };
  topDefensivePlayer?: {
    name: string;
    teamLogo: string;
    points: number;
  };
  topGoalie?: {
    name: string;
    teamLogo: string;
    points: number;
  };
}


function normalizeLeagueScoringRules(league: Partial<League>): League {
  const storedRules = league.scoringRules;
  const base = scoringRulesForVersion(league.scoringRulesVersion);

  const normalizedRules: ScoringRules = {
    ...base,
    ...(storedRules ?? {}),
    forward: {
      ...base.forward,
      ...(storedRules?.forward ?? {}),
      goal: {
        ...base.forward.goal,
        ...(storedRules?.forward?.goal ?? {}),
      },
      primaryAssist: {
        ...base.forward.primaryAssist,
        ...(storedRules?.forward?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...base.forward.secondaryAssist,
        ...(storedRules?.forward?.secondaryAssist ?? {}),
      },
    },
    defense: {
      ...base.defense,
      ...(storedRules?.defense ?? {}),
      goal: {
        ...base.defense.goal,
        ...(storedRules?.defense?.goal ?? {}),
      },
      primaryAssist: {
        ...base.defense.primaryAssist,
        ...(storedRules?.defense?.primaryAssist ?? {}),
      },
      secondaryAssist: {
        ...base.defense.secondaryAssist,
        ...(storedRules?.defense?.secondaryAssist ?? {}),
      },
    },
    goalieSavePercentageTiers:
      Array.isArray(storedRules?.goalieSavePercentageTiers) &&
      storedRules.goalieSavePercentageTiers.length > 0
        ? storedRules.goalieSavePercentageTiers
        : base.goalieSavePercentageTiers,
  };

  /*
   * Pre-V3 documents continue receiving the frozen V3 defense/goalie upgrade.
   * V3 leagues are not silently converted to V4 by a browser deployment.
   */
  if (
    typeof league.scoringRulesVersion !== 'number' ||
    league.scoringRulesVersion < SCORING_RULES_V3_VERSION
  ) {
    const v3 = scoringRulesForVersion(SCORING_RULES_V3_VERSION);
    normalizedRules.defense = v3.defense;
    normalizedRules.defenseToiBaseMultiplier = v3.defenseToiBaseMultiplier;
    normalizedRules.defenseToiPlusMinusModifier = v3.defenseToiPlusMinusModifier;
    normalizedRules.defenseToiFloor = v3.defenseToiFloor;
    normalizedRules.defenseToiCeiling = v3.defenseToiCeiling;
    normalizedRules.goalieGameBase = v3.goalieGameBase;
    normalizedRules.goalieSave = v3.goalieSave;
    normalizedRules.goalieWin = v3.goalieWin;
    normalizedRules.goalieShutout = v3.goalieShutout;
    normalizedRules.goalieSavePercentageBaseline = v3.goalieSavePercentageBaseline;
    normalizedRules.goalieSavePercentageBasePoints = v3.goalieSavePercentageBasePoints;
    normalizedRules.goalieSavePercentagePointsPerPercentagePoint =
      v3.goalieSavePercentagePointsPerPercentagePoint;
    normalizedRules.goalieSavePercentageMinimum = v3.goalieSavePercentageMinimum;
    normalizedRules.goalieSavePercentageMaximum = v3.goalieSavePercentageMaximum;
    normalizedRules.goalieSavePercentageTiers = v3.goalieSavePercentageTiers;
    normalizedRules.goalieGameMaximum = v3.goalieGameMaximum;
  }

  return {
    id: league.id ?? '',
    name: league.name ?? '',
    leagueLogoId: normalizeLeagueLogoId(league.leagueLogoId),
    leagueLogoPaletteId: normalizeLeagueLogoPaletteId(league.leagueLogoPaletteId),
    commissionerId: league.commissionerId ?? '',
    inviteCode: league.inviteCode ?? '',
    maxTeams: typeof league.maxTeams === 'number' ? league.maxTeams : 2,
    teamCount: typeof league.teamCount === 'number' ? league.teamCount : undefined,
    joinStatus:
      league.joinStatus === 'open' ||
      league.joinStatus === 'locked' ||
      league.joinStatus === 'full'
        ? league.joinStatus
        : undefined,
    joinLockedAt: league.joinLockedAt,
    joinLockedReason:
      typeof league.joinLockedReason === 'string' || league.joinLockedReason === null
        ? league.joinLockedReason
        : undefined,
    matchupFormat: league.matchupFormat ?? 'cycle_matchup',
    scoringRules: normalizedRules,
    scoringRulesVersion:
      typeof league.scoringRulesVersion === 'number' &&
      league.scoringRulesVersion >= CURRENT_SCORING_RULES_VERSION
        ? league.scoringRulesVersion
        : SCORING_RULES_V3_VERSION,
    authoritySchemaVersion:
      typeof league.authoritySchemaVersion === 'number'
        ? league.authoritySchemaVersion
        : undefined,
    documentSchemaVersion:
      typeof league.documentSchemaVersion === 'number'
        ? league.documentSchemaVersion
        : undefined,
    createdByAuthority:
      typeof league.createdByAuthority === 'string'
        ? league.createdByAuthority
        : undefined,
    competitionSettingsLocked: league.competitionSettingsLocked === true,
    migratedAt: league.migratedAt,
    createdAt: league.createdAt,
    updatedAt: league.updatedAt,
  };
}

function normalizeInviteCode(inviteCode: string): string {
  return inviteCode.trim().toUpperCase();
}

function normalizeUsername(username: string): string {
  const trimmedUsername = username.trim();

  return trimmedUsername || 'Unknown User';
}

const PENDING_LEAGUE_CREATION_STORAGE_KEY = 'rinkrat:pending-league-creation:v1';
const PENDING_LEAGUE_JOIN_STORAGE_KEY = 'rinkrat:pending-league-join:v1';
const PENDING_LEAGUE_MEMBER_REMOVAL_STORAGE_KEY =
  'rinkrat:pending-league-member-removal:v1';
const PENDING_LEAGUE_REQUEST_MAX_AGE_MS = 2 * 60 * 60 * 1000;
let inMemoryPendingLeagueCreation: PendingLeagueCreationRequest | null = null;
let inMemoryPendingLeagueJoin: PendingLeagueJoinRequest | null = null;
let inMemoryPendingLeagueMemberRemoval: PendingLeagueMemberRemovalRequest | null = null;

function createLeagueRequestId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();

  if (randomUuid) {
    return randomUuid;
  }

  return `league-${Date.now()}-${Math.random().toString(36).slice(2, 18)}`;
}

function getLeagueCreationFingerprint(input: {
  name: string;
  maxTeams: number;
  username: string;
  leagueLogoId: LeagueLogoId;
  leagueLogoPaletteId: LeagueLogoPaletteId;
}): string {
  return JSON.stringify(input);
}

function getLeagueJoinFingerprint(input: {
  inviteCode: string;
  username: string;
}): string {
  return JSON.stringify(input);
}

function getLeagueMemberRemovalFingerprint(input: {
  leagueId: string;
  targetOwnerId: string;
  confirmationTeamName: string;
}): string {
  return JSON.stringify(input);
}

function isUsablePendingLeagueCreation(
  candidate: Partial<PendingLeagueCreationRequest> | null,
): candidate is PendingLeagueCreationRequest {
  const createdAt = typeof candidate?.createdAt === 'number' ? candidate.createdAt : 0;

  return Boolean(
    candidate?.fingerprint &&
    candidate.requestId &&
    isProfileIconId(candidate.profileIconId) &&
    Date.now() - createdAt <= PENDING_LEAGUE_REQUEST_MAX_AGE_MS,
  );
}

function isUsablePendingLeagueJoin(
  candidate: Partial<PendingLeagueJoinRequest> | null,
): candidate is PendingLeagueJoinRequest {
  const createdAt = typeof candidate?.createdAt === 'number' ? candidate.createdAt : 0;

  return Boolean(
    candidate?.fingerprint &&
    candidate.requestId &&
    isProfileIconId(candidate.profileIconId) &&
    Date.now() - createdAt <= PENDING_LEAGUE_REQUEST_MAX_AGE_MS,
  );
}

function isUsablePendingLeagueMemberRemoval(
  candidate: Partial<PendingLeagueMemberRemovalRequest> | null,
): candidate is PendingLeagueMemberRemovalRequest {
  const createdAt = typeof candidate?.createdAt === 'number' ? candidate.createdAt : 0;

  return Boolean(
    candidate?.fingerprint &&
    candidate.requestId &&
    Date.now() - createdAt <= PENDING_LEAGUE_REQUEST_MAX_AGE_MS,
  );
}

function readPendingRequest<T extends { requestId: string }>(
  storageKey: string,
  inMemoryValue: T | null,
  validator: (candidate: Partial<T> | null) => candidate is T,
): T | null {
  try {
    const rawValue = globalThis.sessionStorage?.getItem(storageKey);

    if (rawValue) {
      const candidate = JSON.parse(rawValue) as Partial<T>;

      if (validator(candidate)) {
        return candidate;
      }

      globalThis.sessionStorage?.removeItem(storageKey);
    }
  } catch {
    // Continue with the in-memory request when storage is unavailable.
  }

  return validator(inMemoryValue) ? inMemoryValue : null;
}

function writePendingRequest<T>(storageKey: string, pending: T): void {
  try {
    globalThis.sessionStorage?.setItem(storageKey, JSON.stringify(pending));
  } catch {
    // The in-memory copy still preserves idempotency for this open tab.
  }
}

function clearPendingRequest(storageKey: string): void {
  try {
    globalThis.sessionStorage?.removeItem(storageKey);
  } catch {
    // Storage cleanup is best-effort after authoritative confirmation.
  }
}

function readPendingLeagueCreation(): PendingLeagueCreationRequest | null {
  const pending = readPendingRequest(
    PENDING_LEAGUE_CREATION_STORAGE_KEY,
    inMemoryPendingLeagueCreation,
    isUsablePendingLeagueCreation,
  );
  inMemoryPendingLeagueCreation = pending;
  return pending;
}

function getOrCreatePendingLeagueCreation(
  fingerprint: string,
): PendingLeagueCreationRequest {
  const existing = readPendingLeagueCreation();

  if (existing?.fingerprint === fingerprint) {
    return existing;
  }

  const pending: PendingLeagueCreationRequest = {
    fingerprint,
    requestId: createLeagueRequestId(),
    profileIconId: getRandomProfileIconId(),
    createdAt: Date.now(),
  };

  inMemoryPendingLeagueCreation = pending;
  writePendingRequest(PENDING_LEAGUE_CREATION_STORAGE_KEY, pending);
  return pending;
}

function clearPendingLeagueCreation(requestId: string): void {
  const existing = readPendingLeagueCreation();

  if (existing?.requestId !== requestId) {
    return;
  }

  inMemoryPendingLeagueCreation = null;
  clearPendingRequest(PENDING_LEAGUE_CREATION_STORAGE_KEY);
}

function readPendingLeagueJoin(): PendingLeagueJoinRequest | null {
  const pending = readPendingRequest(
    PENDING_LEAGUE_JOIN_STORAGE_KEY,
    inMemoryPendingLeagueJoin,
    isUsablePendingLeagueJoin,
  );
  inMemoryPendingLeagueJoin = pending;
  return pending;
}

function getOrCreatePendingLeagueJoin(
  fingerprint: string,
): PendingLeagueJoinRequest {
  const existing = readPendingLeagueJoin();

  if (existing?.fingerprint === fingerprint) {
    return existing;
  }

  const pending: PendingLeagueJoinRequest = {
    fingerprint,
    requestId: createLeagueRequestId(),
    profileIconId: getRandomProfileIconId(),
    createdAt: Date.now(),
  };

  inMemoryPendingLeagueJoin = pending;
  writePendingRequest(PENDING_LEAGUE_JOIN_STORAGE_KEY, pending);
  return pending;
}

function clearPendingLeagueJoin(requestId: string): void {
  const existing = readPendingLeagueJoin();

  if (existing?.requestId !== requestId) {
    return;
  }

  inMemoryPendingLeagueJoin = null;
  clearPendingRequest(PENDING_LEAGUE_JOIN_STORAGE_KEY);
}

function readPendingLeagueMemberRemoval(): PendingLeagueMemberRemovalRequest | null {
  const pending = readPendingRequest(
    PENDING_LEAGUE_MEMBER_REMOVAL_STORAGE_KEY,
    inMemoryPendingLeagueMemberRemoval,
    isUsablePendingLeagueMemberRemoval,
  );
  inMemoryPendingLeagueMemberRemoval = pending;
  return pending;
}

function getOrCreatePendingLeagueMemberRemoval(
  fingerprint: string,
): PendingLeagueMemberRemovalRequest {
  const existing = readPendingLeagueMemberRemoval();

  if (existing?.fingerprint === fingerprint) {
    return existing;
  }

  const pending: PendingLeagueMemberRemovalRequest = {
    fingerprint,
    requestId: createLeagueRequestId(),
    createdAt: Date.now(),
  };

  inMemoryPendingLeagueMemberRemoval = pending;
  writePendingRequest(PENDING_LEAGUE_MEMBER_REMOVAL_STORAGE_KEY, pending);
  return pending;
}

function clearPendingLeagueMemberRemoval(requestId: string): void {
  const existing = readPendingLeagueMemberRemoval();

  if (existing?.requestId !== requestId) {
    return;
  }

  inMemoryPendingLeagueMemberRemoval = null;
  clearPendingRequest(PENDING_LEAGUE_MEMBER_REMOVAL_STORAGE_KEY);
}

async function requireFreshVerifiedEmail(actionLabel: string): Promise<void> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error(`You must be logged in to ${actionLabel}.`);
  }

  try {
    await user.reload();
    await user.getIdToken(true);
  } catch {
    throw new Error('RinkRat could not verify your email status. Check your connection and try again.');
  }

  if (!user.emailVerified) {
    throw new Error(
      `Verify your email address before you ${actionLabel}. Open Account Settings to resend the verification email.`,
    );
  }
}

function getCallableErrorMessage(
  error: unknown,
  operation: 'create' | 'join' = 'create',
): string {
  const record = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const rawMessage = typeof record.message === 'string' ? record.message.trim() : '';
  const message = rawMessage
    .replace(/^FirebaseError:\s*/i, '')
    .replace(/^\[functions\/[^\]]+\]\s*/i, '')
    .trim();

  if (message) {
    return message;
  }

  if (code.includes('unauthenticated')) {
    return operation === 'join'
      ? 'You must be logged in to join a league.'
      : 'You must be logged in to create a league.';
  }

  if (code.includes('not-found') && operation === 'join') {
    return 'No league was found with that invite code.';
  }

  if (code.includes('resource-exhausted')) {
    return operation === 'join'
      ? 'This league is full or this account reached a temporary join limit.'
      : 'This account reached a temporary league-creation limit.';
  }

  if (code.includes('failed-precondition') || code.includes('aborted')) {
    return operation === 'join'
      ? 'The league join could not be completed. Refresh the league code and try again.'
      : 'The previous league creation is still being reconciled. Wait a moment and try again.';
  }

  return operation === 'join'
    ? 'Unable to join the league right now. Please try again.'
    : 'Unable to create the league right now. Please try again.';
}

function getLeagueRef(leagueId: string) {
  return doc(db, 'leagues', leagueId);
}

function getLeagueMemberRef(leagueId: string, userId: string) {
  return doc(db, 'leagues', leagueId, 'members', userId);
}

function getLeagueTeamRef(leagueId: string, ownerId: string) {
  return doc(db, 'leagues', leagueId, 'teams', ownerId);
}

function getLeagueIdFromMembershipPath(membershipPath: string): string | null {
  const pathParts = membershipPath.split('/');
  const leaguesIndex = pathParts.lastIndexOf('leagues');

  if (leaguesIndex < 0 || pathParts.length <= leaguesIndex + 1) {
    return null;
  }

  return pathParts[leaguesIndex + 1] || null;
}

export async function createLeague(
  name: string,
  maxTeams: number,
  username: string,
  leagueLogoId: LeagueLogoId = DEFAULT_LEAGUE_LOGO_ID,
  leagueLogoPaletteId: LeagueLogoPaletteId = DEFAULT_LEAGUE_LOGO_PALETTE_ID,
): Promise<string> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to create a league.');
  }

  await requireFreshVerifiedEmail('create a league');

  const trimmedName = name.trim();
  const normalizedUsername = normalizeUsername(username);
  const normalizedLeagueLogoId = normalizeLeagueLogoId(leagueLogoId);
  const normalizedLeagueLogoPaletteId = normalizeLeagueLogoPaletteId(
    leagueLogoPaletteId,
  );

  if (!trimmedName) {
    throw new Error('Please enter a league name.');
  }

  if (trimmedName.length > 80) {
    throw new Error('League name must be 80 characters or fewer.');
  }

  if (!Number.isInteger(maxTeams) || maxTeams < 2 || maxTeams > 12) {
    throw new Error('League size must be between 2 and 12 teams.');
  }

  const fingerprint = getLeagueCreationFingerprint({
    name: trimmedName,
    maxTeams,
    username: normalizedUsername,
    leagueLogoId: normalizedLeagueLogoId,
    leagueLogoPaletteId: normalizedLeagueLogoPaletteId,
  });
  const pending = getOrCreatePendingLeagueCreation(fingerprint);
  const callable = httpsCallable<
    CreateLeagueSecureRequest,
    CreateLeagueSecureResponse
  >(functions, 'createLeagueSecure', { timeout: 50_000 });

  try {
    const response = await callable({
      requestId: pending.requestId,
      name: trimmedName,
      maxTeams,
      username: normalizedUsername,
      leagueLogoId: normalizedLeagueLogoId,
      leagueLogoPaletteId: normalizedLeagueLogoPaletteId,
      profileIconId: pending.profileIconId,
    });

    if (!response.data.created || !response.data.leagueId) {
      throw new Error('The server could not confirm the new league.');
    }

    clearPendingLeagueCreation(pending.requestId);
    return response.data.leagueId;
  } catch (error: unknown) {
    throw new Error(getCallableErrorMessage(error));
  }
}

export async function getMyLeagues(): Promise<League[]> {
  const user = auth.currentUser;

  if (!user) {
    return [];
  }

  const membershipsQuery = query(collectionGroup(db, 'members'), where('uid', '==', user.uid));

  const membershipSnapshot = await getDocs(membershipsQuery);
  const leagueIds: string[] = Array.from(
    new Set<string>(
      membershipSnapshot.docs
        .map((membershipDocument) => getLeagueIdFromMembershipPath(membershipDocument.ref.path))
        .filter((leagueId): leagueId is string => Boolean(leagueId)),
    ),
  );

  const leagueSnapshots = await Promise.all(
    leagueIds.map((leagueId) => getDoc(getLeagueRef(leagueId))),
  );

  const leagues = leagueSnapshots
    .filter((leagueSnapshot) => leagueSnapshot.exists())
    .map((leagueSnapshot) => normalizeLeagueScoringRules(leagueSnapshot.data() as Partial<League>))
    .sort((first, second) => first.name.localeCompare(second.name));

  return leagues;
}

export async function deleteLeaguePermanently(
  leagueId: string,
  confirmationName: string,
): Promise<void> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to delete a league.');
  }

  const normalizedLeagueId = leagueId.trim();
  const normalizedConfirmationName = confirmationName.trim();

  if (!normalizedLeagueId) {
    throw new Error('This league is still loading.');
  }

  if (!normalizedConfirmationName) {
    throw new Error('Type the full league name before deleting it.');
  }

  const callable = httpsCallable<DeleteLeagueRequest, DeleteLeagueResponse>(
    functions,
    'deleteLeague',
    { timeout: 600_000 },
  );

  try {
    const result = await callable({
      leagueId: normalizedLeagueId,
      confirmationName: normalizedConfirmationName,
    });

    if (!result.data.deleted || result.data.leagueId !== normalizedLeagueId) {
      throw new Error('The server could not confirm that the league was deleted.');
    }
  } catch (error: unknown) {
    const record = error && typeof error === 'object'
      ? error as { code?: unknown; message?: unknown }
      : {};
    const code = typeof record.code === 'string' ? record.code : '';
    const rawMessage = typeof record.message === 'string' ? record.message.trim() : '';
    const message = rawMessage
      .replace(/^FirebaseError:\s*/i, '')
      .replace(/^\[functions\/[^\]]+\]\s*/i, '')
      .trim();

    if (message) {
      throw new Error(message);
    }

    if (code.includes('permission-denied')) {
      throw new Error('Only the league commissioner can permanently delete this league.');
    }

    if (code.includes('failed-precondition')) {
      throw new Error('The confirmation name did not exactly match the league name.');
    }

    if (code.includes('not-found')) {
      throw new Error('This league no longer exists.');
    }

    throw new Error('The league could not be deleted. Please try again.');
  }
}

export async function getLeagueById(leagueId: string): Promise<League | null> {
  const leagueSnapshot = await getDoc(getLeagueRef(leagueId));

  if (!leagueSnapshot.exists()) {
    return null;
  }

  return normalizeLeagueScoringRules(leagueSnapshot.data() as Partial<League>);
}

export async function getMyLeagueSummaries(
  options: { includeDashboardActivity?: boolean } = {},
): Promise<LeagueSummary[]> {
  const user = auth.currentUser;

  if (!user) {
    return [];
  }

  const leagues = await getMyLeagues();
  const dashboardActivityModule = options.includeDashboardActivity
    ? import('./dashboard-league-activity.service')
    : null;

  // Team collections are independent, so fetch them together instead of
  // paying one mobile network round trip per league in sequence.
  return Promise.all(
    leagues.map(async (league): Promise<LeagueSummary> => {
      const teams = await getLeagueTeams(league.id);
      const myTeam = teams.find((team) => team.ownerId === user.uid);

      const isCommissioner = league.commissionerId === user.uid;
      const dashboardActivity = dashboardActivityModule
        ? await (await dashboardActivityModule).getDashboardLeagueActivity({
            leagueId: league.id,
            ownerId: user.uid,
            isCommissioner,
            teamCount: teams.length,
            maxTeams: league.maxTeams,
            teams,
          })
        : undefined;

      return {
        leagueId: league.id,
        leagueName: league.name,
        leagueLogoId: league.leagueLogoId,
        leagueLogoPaletteId: league.leagueLogoPaletteId,
        inviteCode: league.inviteCode,
        myTeamName: myTeam?.teamName ?? 'Unnamed Team',
        teamCount: teams.length,
        maxTeams: league.maxTeams,
        isCommissioner,
        wins: myTeam?.wins ?? 0,
        losses: myTeam?.losses ?? 0,
        ties: myTeam?.ties ?? 0,
        dashboardActivity,
        topOffensivePlayer: {
          name: 'TBD',
          teamLogo: '🏒',
          points: 0,
        },
        topDefensivePlayer: {
          name: 'TBD',
          teamLogo: '🛡️',
          points: 0,
        },
        topGoalie: {
          name: 'TBD',
          teamLogo: '🥅',
          points: 0,
        },
      };
    }),
  );
}

export async function joinLeagueByInviteCode(
  inviteCode: string,
  username: string,
): Promise<string> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to join a league.');
  }

  await requireFreshVerifiedEmail('join a league');

  const normalizedInviteCode = normalizeInviteCode(inviteCode);
  const normalizedUsername = normalizeUsername(username);

  if (normalizedInviteCode.length !== 6 || !/^[A-Z0-9]+$/.test(normalizedInviteCode)) {
    throw new Error('Enter the six-character league invite code exactly as it appears.');
  }

  const fingerprint = getLeagueJoinFingerprint({
    inviteCode: normalizedInviteCode,
    username: normalizedUsername,
  });
  const pending = getOrCreatePendingLeagueJoin(fingerprint);
  const callable = httpsCallable<
    JoinLeagueSecureRequest,
    JoinLeagueSecureResponse
  >(functions, 'joinLeagueSecure', { timeout: 60_000 });

  try {
    const response = await callable({
      requestId: pending.requestId,
      inviteCode: normalizedInviteCode,
      username: normalizedUsername,
      profileIconId: pending.profileIconId,
    });

    if (!response.data.joined || !response.data.leagueId) {
      throw new Error('The server could not confirm the league membership.');
    }

    clearPendingLeagueJoin(pending.requestId);
    return response.data.leagueId;
  } catch (error: unknown) {
    throw new Error(getCallableErrorMessage(error, 'join'));
  }
}

function getMemberRemovalCallableErrorMessage(error: unknown): string {
  const record = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const rawMessage = typeof record.message === 'string' ? record.message.trim() : '';
  const message = rawMessage
    .replace(/^FirebaseError:\s*/i, '')
    .replace(/^\[functions\/[^\]]+\]\s*/i, '')
    .trim();

  if (message) {
    return message;
  }

  if (code.includes('permission-denied')) {
    return 'Only the current league commissioner can remove a member.';
  }

  if (code.includes('not-found')) {
    return 'This member is no longer in the league. Refresh League HQ.';
  }

  if (code.includes('failed-precondition') || code.includes('aborted')) {
    return 'The member could not be removed safely. Confirm the Draft has not been configured, then refresh League HQ.';
  }

  if (code.includes('already-exists')) {
    return 'That removal request was already used. Refresh League HQ before trying again.';
  }

  return 'The member could not be removed. No league data was changed; try again.';
}

export async function removeLeagueMemberBeforeDraft(input: {
  leagueId: string;
  targetOwnerId: string;
  confirmationTeamName: string;
}): Promise<RemoveLeagueMemberSecureResponse> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to remove a league member.');
  }

  await requireFreshVerifiedEmail('remove a league member');

  const leagueId = input.leagueId.trim();
  const targetOwnerId = input.targetOwnerId.trim();
  const confirmationTeamName = input.confirmationTeamName.trim();

  if (!leagueId || !targetOwnerId || !confirmationTeamName) {
    throw new Error('Choose a member and type their team name exactly.');
  }

  if (targetOwnerId === user.uid) {
    throw new Error('The commissioner cannot remove their own team.');
  }

  const fingerprint = getLeagueMemberRemovalFingerprint({
    leagueId,
    targetOwnerId,
    confirmationTeamName,
  });
  const pending = getOrCreatePendingLeagueMemberRemoval(fingerprint);
  const callable = httpsCallable<
    RemoveLeagueMemberSecureRequest,
    RemoveLeagueMemberSecureResponse
  >(functions, 'removeLeagueMemberSecure', { timeout: 60_000 });

  try {
    const response = await callable({
      requestId: pending.requestId,
      leagueId,
      targetOwnerId,
      confirmationTeamName,
    });

    if (
      response.data.removed !== true ||
      response.data.leagueId !== leagueId ||
      response.data.targetOwnerId !== targetOwnerId ||
      response.data.removedTeamName !== confirmationTeamName ||
      !Number.isInteger(response.data.teamCount) ||
      response.data.teamCount < 1 ||
      !Number.isInteger(response.data.maxTeams) ||
      response.data.maxTeams < 2 ||
      response.data.maxTeams > 12 ||
      response.data.teamCount >= response.data.maxTeams ||
      response.data.joinStatus !== 'open' ||
      typeof response.data.idempotentReplay !== 'boolean' ||
      typeof response.data.auditId !== 'string' ||
      !response.data.auditId.startsWith('member-removed-')
    ) {
      throw new Error('The server could not confirm the member removal. Refresh League HQ.');
    }

    clearPendingLeagueMemberRemoval(pending.requestId);
    return response.data;
  } catch (error: unknown) {
    throw new Error(getMemberRemovalCallableErrorMessage(error));
  }
}


export async function updateLeaguePresentation(input: {
  leagueId: string;
  name: string;
  leagueLogoId: LeagueLogoId;
  leagueLogoPaletteId: LeagueLogoPaletteId;
  reason?: string;
}): Promise<UpdateLeagueCosmeticsSecureResponse> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to update league presentation.');
  }

  await requireFreshVerifiedEmail('update league presentation');

  const normalizedLeagueId = input.leagueId.trim();
  const normalizedName = input.name.trim();

  if (!normalizedLeagueId) {
    throw new Error('This league is still loading.');
  }

  if (!normalizedName || normalizedName.length > 80) {
    throw new Error('League name must be between 1 and 80 characters.');
  }

  const callable = httpsCallable<
    UpdateLeagueCosmeticsSecureRequest,
    UpdateLeagueCosmeticsSecureResponse
  >(functions, 'updateLeagueCosmeticsSecure', { timeout: 50_000 });

  try {
    const response = await callable({
      requestId: createLeagueRequestId(),
      leagueId: normalizedLeagueId,
      name: normalizedName,
      leagueLogoId: normalizeLeagueLogoId(input.leagueLogoId),
      leagueLogoPaletteId: normalizeLeagueLogoPaletteId(
        input.leagueLogoPaletteId,
      ),
      reason: input.reason?.trim() || 'Commissioner updated league presentation.',
    });

    return response.data;
  } catch (error: unknown) {
    throw new Error(getCallableErrorMessage(error));
  }
}

export async function migrateLeagueAuthoritySchema(
  leagueId: string,
  reason = 'Release Readiness migrated the league authority schema.',
): Promise<MigrateLeagueAuthoritySchemaResponse> {
  const user = auth.currentUser;

  if (!user) {
    throw new Error('You must be logged in to migrate league authority.');
  }

  const normalizedLeagueId = leagueId.trim();

  if (!normalizedLeagueId) {
    throw new Error('This league is still loading.');
  }

  const callable = httpsCallable<
    MigrateLeagueAuthoritySchemaRequest,
    MigrateLeagueAuthoritySchemaResponse
  >(functions, 'migrateLeagueAuthoritySchema', { timeout: 130_000 });

  try {
    const response = await callable({
      leagueId: normalizedLeagueId,
      reason: reason.trim(),
    });
    return response.data;
  } catch (error: unknown) {
    throw new Error(getCallableErrorMessage(error));
  }
}

export async function ensureLeagueProfileIcon(
  leagueId: string,
  username?: string | null,
): Promise<ProfileIconId> {
  const user = auth.currentUser;

  if (!user || !leagueId) {
    throw new Error('Your league account is still loading.');
  }

  const memberRef = getLeagueMemberRef(leagueId, user.uid);
  const teamRef = getLeagueTeamRef(leagueId, user.uid);
  const [memberSnapshot, teamSnapshot] = await Promise.all([
    getDoc(memberRef),
    getDoc(teamRef),
  ]);

  const memberData = memberSnapshot.exists()
    ? (memberSnapshot.data() as Partial<LeagueMember>)
    : null;
  const teamData = teamSnapshot.exists()
    ? (teamSnapshot.data() as Partial<{
        managerName: string;
        profileIconId: ProfileIconId;
      }>)
    : null;
  const resolvedProfileIconId = isProfileIconId(teamData?.profileIconId)
    ? teamData.profileIconId
    : isProfileIconId(memberData?.profileIconId)
      ? memberData.profileIconId
      : getRandomProfileIconId();

  const repair = buildLeagueIdentityRepair({
    member: memberData,
    team: teamData,
    profileIconId: resolvedProfileIconId,
    username: username ? normalizeUsername(username) : null,
  });

  if (!repair.member && !repair.team) {
    return resolvedProfileIconId;
  }

  const batch = writeBatch(db);

  if (repair.member) {
    batch.set(
      memberRef,
      { ...repair.member, updatedAt: serverTimestamp() },
      { merge: true },
    );
  }

  if (repair.team) {
    batch.set(
      teamRef,
      { ...repair.team, updatedAt: serverTimestamp() },
      { merge: true },
    );
  }

  await batch.commit();

  return resolvedProfileIconId;
}

export async function syncManagerNameForLeague(
  leagueId: string,
  username: string,
): Promise<void> {
  const user = auth.currentUser;

  if (!user || !leagueId) {
    return;
  }

  const normalizedUsername = normalizeUsername(username);
  const batch = writeBatch(db);

  batch.set(
    getLeagueMemberRef(leagueId, user.uid),
    { username: normalizedUsername, updatedAt: serverTimestamp() },
    { merge: true },
  );

  batch.set(
    getLeagueTeamRef(leagueId, user.uid),
    {
      managerName: normalizedUsername,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();
}

export async function syncManagerNameAcrossLeagues(username: string): Promise<void> {
  const user = auth.currentUser;

  if (!user) {
    return;
  }

  const normalizedUsername = normalizeUsername(username);
  const leagues = await getMyLeagues();

  for (let startIndex = 0; startIndex < leagues.length; startIndex += 200) {
    const batch = writeBatch(db);
    const leagueChunk = leagues.slice(startIndex, startIndex + 200);

    for (const league of leagueChunk) {
      batch.set(
        getLeagueMemberRef(league.id, user.uid),
        { username: normalizedUsername, updatedAt: serverTimestamp() },
        { merge: true },
      );
      batch.set(
        getLeagueTeamRef(league.id, user.uid),
        {
          managerName: normalizedUsername,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }

    await batch.commit();
  }
}

export async function updateLeagueProfileIcon(
  leagueId: string,
  profileIconId: ProfileIconId,
): Promise<void> {
  const user = auth.currentUser;

  if (!user || !leagueId) {
    throw new Error('Your league account is still loading.');
  }

  const normalizedProfileIconId = getProfileIcon(profileIconId).id;
  const batch = writeBatch(db);

  batch.set(
    getLeagueMemberRef(leagueId, user.uid),
    { profileIconId: normalizedProfileIconId, updatedAt: serverTimestamp() },
    { merge: true },
  );
  batch.set(
    getLeagueTeamRef(leagueId, user.uid),
    {
      profileIconId: normalizedProfileIconId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();
}

export function getLeagueIdentityProfileIconId(
  ownerId: string,
  storedProfileIconId?: string | null,
): ProfileIconId {
  return getProfileIcon(storedProfileIconId ?? getSeededProfileIconId(ownerId)).id;
}
