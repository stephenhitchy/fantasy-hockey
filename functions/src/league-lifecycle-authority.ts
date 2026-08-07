import { createHash, randomBytes } from 'node:crypto';

import { DocumentData, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
} from './shared/core/scoring/scoring-rules';
import { createEmptyFantasyRoster } from './shared/core/team/roster.service';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const LEAGUE_AUTHORITY_SCHEMA_VERSION = 1;
const LEAGUE_CREATION_REQUEST_SCHEMA_VERSION = 1;
const LEAGUE_CREATION_REQUEST_RETENTION_DAYS = 30;
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

class InviteCodeCollisionError extends Error {
  constructor() {
    super('Invite code collision.');
    this.name = 'InviteCodeCollisionError';
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireAuthenticatedUserId(auth: { uid?: string } | undefined): string {
  const userId = asString(auth?.uid);

  if (!userId) {
    throw new HttpsError('unauthenticated', 'You must be signed in to create a league.');
  }

  return userId;
}

function requireRequestId(value: unknown): string {
  const requestId = asString(value);

  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new HttpsError(
      'invalid-argument',
      'The league creation request could not be verified. Refresh the page and try again.',
    );
  }

  return requestId;
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

function createTeamDocument(
  ownerId: string,
  managerName: string,
  profileIconId: string,
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
    waiverPriority: 1,
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
    const userId = requireAuthenticatedUserId(request.auth);
    const input = normalizeRequest(request.data);
    const payloadHash = createPayloadHash(input);
    const requestRef = db.doc(
      `leagueCreationRequests/${createRequestDocumentId(userId, input.requestId)}`,
    );
    const leagueRef = db.collection('leagues').doc();

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

          const inviteSnapshot = await transaction.get(inviteRef);

          if (inviteSnapshot.exists) {
            throw new InviteCodeCollisionError();
          }

          const memberRef = db.doc(`leagues/${leagueRef.id}/members/${userId}`);
          const teamRef = db.doc(`leagues/${leagueRef.id}/teams/${userId}`);
          const rosterRef = db.doc(
            `leagues/${leagueRef.id}/teams/${userId}/roster/current`,
          );
          const auditRef = db.doc(`leagues/${leagueRef.id}/audit/league-created`);
          const timestamp = FieldValue.serverTimestamp();
          const roster = createEmptyFantasyRoster();

          transaction.create(leagueRef, {
            id: leagueRef.id,
            name: input.name,
            leagueLogoId: input.leagueLogoId,
            leagueLogoPaletteId: input.leagueLogoPaletteId,
            commissionerId: userId,
            inviteCode,
            maxTeams: input.maxTeams,
            matchupFormat: 'cycle_matchup',
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
            release: 'Security Batch S1A',
            values: {
              name: input.name,
              maxTeams: input.maxTeams,
              leagueLogoId: input.leagueLogoId,
              leagueLogoPaletteId: input.leagueLogoPaletteId,
              scoringRulesVersion: CURRENT_SCORING_RULES_VERSION,
              requiredGamesPerCycle: defaultScoringRules.requiredGamesPerCycle,
              matchupFormat: 'cycle_matchup',
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
              Date.now() + LEAGUE_CREATION_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            ),
          });

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
