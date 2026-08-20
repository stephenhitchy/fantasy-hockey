import { createHash, randomUUID } from 'node:crypto';

import { getAuth } from 'firebase-admin/auth';
import {
  DocumentReference,
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import { privateSeasonManagerHash } from './shared/core/operations/private-season-health.util';
import {
  PRIVACY_EXPORT_AUDIT_RETENTION_DAYS,
  PRIVACY_EXPORT_MAXIMUM_BYTES,
  PRIVACY_EXPORTS_PER_DAY,
  PRIVACY_OPERATIONS_PROJECTION_VERSION,
  PRIVACY_OPERATIONS_RELEASE_LABEL,
  PRIVACY_OPERATIONS_SCORING_VERSION,
  PRIVACY_REQUEST_ADMIN_NOTE_MAXIMUM,
  PRIVACY_REQUEST_MAXIMUM_PER_ACCOUNT,
  PRIVACY_REQUEST_PUBLIC_RESPONSE_MAXIMUM,
  PRIVACY_REQUEST_RESPONSE_TARGET_DAYS,
  PRIVACY_REQUEST_RETENTION_DAYS,
  PRIVACY_REQUEST_STATUSES,
  PRIVACY_REQUEST_SUBJECT_MAXIMUM,
  PRIVACY_REQUEST_TEXT_MAXIMUM,
  PRIVACY_RETENTION_CATALOG,
  boundedPrivacyText,
  buildPrivacyRequestPublicRecord,
  canTransitionPrivacyRequest,
  isPrivacyRequestTerminal,
  normalizePrivacyRequestStatus,
  normalizePrivacyRequestType,
  privacyExportFileName,
  privacyOwnerReference,
  privacyRequestStatusLabel,
  privacyRequestTypeLabel,
  type PrivacyRequestPublicRecord,
  type PrivacyRequestStatus,
  type PrivacyRequestTimelineEntry,
  type PrivacyRequestType,
} from './shared/core/privacy/privacy-request.util';
import {
  requireAuthenticatedUserId,
  requireVerifiedEmail,
  requireVerifiedRecentAuthentication,
} from './shared/security/auth-security.util';
import { requireFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const PLAN_PATH = 'platformOperations/privateSeason2026-27';
const CURRENT_BUILD_ID_PATTERN = /^release-candidate-56-[A-Za-z0-9._:-]{4,160}$/;
const PRIVACY_REQUEST_DAILY_LIMIT = 5;
const EXPORT_QUERY_LIMIT = 500;
const REQUEST_QUERY_LIMIT = 100;
const ADMIN_REQUEST_QUERY_LIMIT = 250;
const ADMIN_EXPORT_QUERY_LIMIT = 250;

interface PrivacyBuildIdentity {
  releaseLabel: string;
  buildId: string;
  scoringRulesVersion: number;
  projectionVersion: number;
}

interface PrivacyExportAuditView {
  exportId: string;
  generatedAt: string | null;
  fileName: string;
  byteSize: number;
  packageHash: string;
  recordCounts: Record<string, number>;
}

interface PrivacyRequestAdminView extends PrivacyRequestPublicRecord {
  ownerReference: string;
  adminNotes: string;
  overdue: boolean;
  lastUpdatedByRole: string;
}

interface PrivacyCenterResponse {
  generatedAt: string;
  requests: PrivacyRequestPublicRecord[];
  exports: PrivacyExportAuditView[];
  retention: typeof PRIVACY_RETENTION_CATALOG;
  responseTargetDays: number;
  responseTargetIsLegalDeadline: false;
}

interface PrivacyOperationsDashboard {
  generatedAt: string;
  requests: PrivacyRequestAdminView[];
  exports: Array<PrivacyExportAuditView & { ownerReference: string }>;
  summary: {
    totalRequests: number;
    openRequests: number;
    waitingForManager: number;
    overdueRequests: number;
    completedRequests: number;
    exportCount: number;
  };
  responseTargetDays: number;
  responseTargetIsLegalDeadline: false;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function iso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  if (value && typeof value === 'object' && 'toDate' in value) {
    const candidate = value as { toDate?: unknown };
    if (typeof candidate.toDate === 'function') {
      const parsed = candidate.toDate();
      return parsed instanceof Date && Number.isFinite(parsed.getTime())
        ? parsed.toISOString()
        : null;
    }
  }
  return null;
}

function number(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : minimum;
}

function buildIdentity(value: unknown, requireDeployableBuild: boolean): PrivacyBuildIdentity {
  const source = record(value);
  const build: PrivacyBuildIdentity = {
    releaseLabel: boundedPrivacyText(source['releaseLabel'], 80),
    buildId: boundedPrivacyText(source['buildId'], 180),
    scoringRulesVersion: number(source['scoringRulesVersion'], 0, 100),
    projectionVersion: number(source['projectionVersion'], 0, 100),
  };

  if (
    build.releaseLabel !== PRIVACY_OPERATIONS_RELEASE_LABEL ||
    !CURRENT_BUILD_ID_PATTERN.test(build.buildId) ||
    build.scoringRulesVersion !== PRIVACY_OPERATIONS_SCORING_VERSION ||
    build.projectionVersion !== PRIVACY_OPERATIONS_PROJECTION_VERSION
  ) {
    throw new HttpsError(
      'failed-precondition',
      'Refresh RinkRat. Privacy operations accept only the current RC56 / Scoring V4 / Projection V11 build.',
    );
  }

  if (requireDeployableBuild && build.buildId.endsWith('-local')) {
    throw new HttpsError(
      'failed-precondition',
      'Open the deployed RC56 site before completing a privacy operation.',
    );
  }

  return build;
}

async function requirePlatformAdmin(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
  actionLabel: string,
): Promise<string> {
  const adminId = requireFirestoreDocumentId(auth?.uid, 'platform administrator ID', {
    maxBytes: 128,
  });
  requireVerifiedRecentAuthentication(auth, actionLabel);

  if (auth?.token?.['platformAdmin'] !== true) {
    const snapshot = await db.doc(`platformAdmins/${adminId}`).get();
    if (!snapshot.exists || snapshot.data()?.['enabled'] !== true) {
      throw new HttpsError('permission-denied', 'Platform-administrator access is required.');
    }
  }

  return adminId;
}

function requireVerifiedManager(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
  actionLabel: string,
): string {
  const userId = requireAuthenticatedUserId(auth, actionLabel);
  requireVerifiedEmail(auth, actionLabel);
  return userId;
}

async function consumePrivacyRateLimit(
  userId: string,
  bucket: 'request' | 'export',
  maximumCount: number,
): Promise<void> {
  const reference = db.doc(`observabilityRateLimits/${userId}`);
  const dateKey = new Date().toISOString().slice(0, 10);
  const dateField = `privacy${bucket === 'request' ? 'Request' : 'Export'}DateKey`;
  const countField = `privacy${bucket === 'request' ? 'Request' : 'Export'}Count`;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const storedDateKey = boundedPrivacyText(data[dateField], 10);
    const storedCount = number(data[countField], 0, maximumCount + 1);

    if (storedDateKey !== dateKey) {
      transaction.set(reference, {
        [dateField]: dateKey,
        [countField]: 1,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    if (storedCount >= maximumCount) {
      throw new HttpsError(
        'resource-exhausted',
        bucket === 'export'
          ? 'The daily data-export limit has been reached. Try again tomorrow or submit a privacy request.'
          : 'The daily privacy-request update limit has been reached. Try again tomorrow.',
      );
    }

    transaction.set(reference, {
      [countField]: storedCount + 1,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

function timelineFromData(value: unknown, fallbackStatus: PrivacyRequestStatus): PrivacyRequestTimelineEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const item = record(entry);
      const status = normalizePrivacyRequestStatus(item['status']) ?? fallbackStatus;
      const kind = boundedPrivacyText(item['kind'], 40) as PrivacyRequestTimelineEntry['kind'];
      if (!['manager-request', 'manager-follow-up', 'administrator-response', 'status-change'].includes(kind)) {
        return null;
      }
      return {
        kind,
        message: boundedPrivacyText(item['message'], PRIVACY_REQUEST_PUBLIC_RESPONSE_MAXIMUM),
        status,
        occurredAt: iso(item['occurredAt']),
      } satisfies PrivacyRequestTimelineEntry;
    })
    .filter((entry): entry is PrivacyRequestTimelineEntry => entry !== null)
    .slice(-20);
}

function publicRequestFromSnapshot(
  snapshot: QueryDocumentSnapshot<DocumentData> | DocumentSnapshot<DocumentData>,
): PrivacyRequestPublicRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const status = normalizePrivacyRequestStatus(data['status']);
  if (!status) return null;
  return buildPrivacyRequestPublicRecord({
    ...data,
    requestId: snapshot.id,
    targetResponseAt: iso(data['targetResponseAt']),
    createdAt: iso(data['createdAt']),
    updatedAt: iso(data['updatedAt']),
    completedAt: iso(data['completedAt']),
    timeline: timelineFromData(data['timeline'], status),
  });
}

function exportAuditFromSnapshot(
  snapshot: QueryDocumentSnapshot<DocumentData> | DocumentSnapshot<DocumentData>,
): PrivacyExportAuditView {
  const data = snapshot.data() ?? {};
  const counts = record(data['recordCounts']);
  return {
    exportId: snapshot.id,
    generatedAt: iso(data['generatedAt']),
    fileName: boundedPrivacyText(data['fileName'], 160),
    byteSize: number(data['byteSize']),
    packageHash: boundedPrivacyText(data['packageHash'], 80),
    recordCounts: Object.fromEntries(
      Object.entries(counts)
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
        .map(([key, value]) => [key, number(value)]),
    ),
  };
}

function exportValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[maximum depth reached]';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (value instanceof DocumentReference) return { documentPath: value.path };
  if (Array.isArray(value)) return value.slice(0, 1_000).map((entry) => exportValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(source)
        .filter(([, entry]) => entry !== undefined && typeof entry !== 'function')
        .slice(0, 250)
        .map(([key, entry]) => [key, exportValue(entry, depth + 1)]),
    );
  }
  return String(value);
}

function leagueIdFromPath(path: string): string | null {
  const parts = path.split('/');
  return parts[0] === 'leagues' && parts[1] ? parts[1] : null;
}

function feedbackExport(data: DocumentData): Record<string, unknown> {
  return exportValue({
    feedbackId: data['feedbackId'],
    category: data['category'],
    severity: data['severity'],
    summary: data['summary'],
    message: data['message'],
    expectedResult: data['expectedResult'],
    reproductionSteps: data['reproductionSteps'],
    route: data['route'],
    allowFollowUp: data['allowFollowUp'],
    userAgent: data['userAgent'],
    language: data['language'],
    browser: data['browser'],
    technicalContext: data['technicalContext'],
    reportedRelease: data['reportedRelease'],
    buildId: data['buildId'],
    clientAppCheckStatus: data['clientAppCheckStatus'],
    serverAppCheckStatus: data['serverAppCheckStatus'],
    hasLeagueContext: data['hasLeagueContext'],
    leagueContextReference: data['leagueContextReference'],
    status: data['status'],
    resolutionRelease: data['resolutionRelease'],
    knownIssueId: data['knownIssueId'],
    knownIssueStatus: data['knownIssueStatus'],
    publicTitle: data['publicTitle'],
    publicSummary: data['publicSummary'],
    createdAt: data['createdAt'],
    updatedAt: data['updatedAt'],
    expiresAt: data['expiresAt'],
  }) as Record<string, unknown>;
}

function diagnosticExport(data: DocumentData): Record<string, unknown> {
  return exportValue({
    reportId: data['reportId'],
    fingerprint: data['fingerprint'],
    authenticated: data['authenticated'],
    category: data['category'],
    source: data['source'],
    route: data['route'],
    message: data['message'],
    stack: data['stack'],
    appVersion: data['appVersion'],
    userAgent: data['userAgent'],
    language: data['language'],
    status: data['status'],
    createdAt: data['createdAt'],
    updatedAt: data['updatedAt'],
    expiresAt: data['expiresAt'],
  }) as Record<string, unknown>;
}

async function trackedPrivateSeasonLeagueIds(): Promise<string[]> {
  const snapshot = await db.doc(PLAN_PATH).get();
  const slots = Array.isArray(snapshot.data()?.['leagueSlots'])
    ? snapshot.data()?.['leagueSlots'] as unknown[]
    : [];
  return [...new Set(slots
    .map((slot) => record(slot))
    .map((slot) => boundedPrivacyText(slot['leagueId'], 128))
    .filter(Boolean))];
}

async function buildLeagueMembershipExport(userId: string): Promise<Array<Record<string, unknown>>> {
  const [memberships, ownedTeams, commissionerLeagues] = await Promise.all([
    db.collectionGroup('members').where('uid', '==', userId).limit(50).get(),
    db.collectionGroup('teams').where('ownerId', '==', userId).limit(50).get(),
    db.collection('leagues').where('commissionerId', '==', userId).limit(50).get(),
  ]);
  const memberByLeague = new Map<string, DocumentData>();
  const teamByLeague = new Map<string, DocumentData>();
  const commissioned = new Set(commissionerLeagues.docs.map((document) => document.id));

  for (const document of memberships.docs) {
    const leagueId = leagueIdFromPath(document.ref.path);
    if (leagueId) memberByLeague.set(leagueId, document.data());
  }
  for (const document of ownedTeams.docs) {
    const leagueId = leagueIdFromPath(document.ref.path);
    if (leagueId) teamByLeague.set(leagueId, document.data());
  }

  const leagueIds = [...new Set([...memberByLeague.keys(), ...teamByLeague.keys(), ...commissioned])];
  const leagueSnapshots = await Promise.all(leagueIds.map((leagueId) => db.doc(`leagues/${leagueId}`).get()));

  return leagueSnapshots.map((snapshot) => {
    const leagueId = snapshot.id;
    const league = snapshot.data() ?? {};
    const member = memberByLeague.get(leagueId) ?? {};
    const team = teamByLeague.get(leagueId) ?? {};
    return exportValue({
      leagueId,
      leagueName: league['name'] ?? league['leagueName'] ?? 'League',
      season: league['season'] ?? null,
      leagueStatus: league['status'] ?? null,
      scoringRulesVersion: league['scoringRulesVersion'] ?? null,
      projectionVersion: league['projectionVersion'] ?? null,
      isCommissioner: commissioned.has(leagueId),
      memberRole: member['role'] ?? (commissioned.has(leagueId) ? 'commissioner' : 'manager'),
      joinedAt: member['joinedAt'] ?? member['createdAt'] ?? null,
      team: {
        teamName: team['teamName'] ?? null,
        wins: team['wins'] ?? null,
        losses: team['losses'] ?? null,
        ties: team['ties'] ?? null,
        pointsFor: team['pointsFor'] ?? null,
        pointsAgainst: team['pointsAgainst'] ?? null,
        favoriteTeamAbbreviation: team['favoriteTeamAbbreviation'] ?? null,
        favoriteTeamVariantId: team['favoriteTeamVariantId'] ?? null,
      },
    }) as Record<string, unknown>;
  });
}

async function buildPrivateSeasonExport(userId: string): Promise<{
  researchResponses: unknown[];
  engagementDays: unknown[];
}> {
  const leagueIds = await trackedPrivateSeasonLeagueIds();
  const researchResponses: unknown[] = [];
  const engagementDays: unknown[] = [];
  const planReference = db.doc(PLAN_PATH);

  for (const leagueId of leagueIds) {
    let safeLeagueId: string;
    try {
      safeLeagueId = requireFirestoreDocumentId(leagueId, 'private-season league ID', { maxBytes: 128 });
    } catch {
      continue;
    }
    const managerHash = privateSeasonManagerHash(userId, safeLeagueId);
    const [research, engagement] = await Promise.all([
      planReference.collection('researchResponses').where('managerHash', '==', managerHash).limit(100).get(),
      planReference.collection('leagueEngagement').doc(safeLeagueId)
        .collection('managerDays').where('managerHash', '==', managerHash).limit(400).get(),
    ]);

    for (const document of research.docs) {
      const data = document.data();
      researchResponses.push(exportValue({
        leagueId: safeLeagueId,
        milestone: data['milestone'],
        role: data['role'],
        answers: data['answers'],
        submittedAt: data['submittedAt'],
        updatedAt: data['updatedAt'],
      }));
    }
    for (const document of engagement.docs) {
      const data = document.data();
      engagementDays.push(exportValue({
        leagueId: safeLeagueId,
        dateKey: data['dateKey'],
        categories: data['categories'],
        firstSeenAt: data['firstSeenAt'],
        lastSeenAt: data['lastSeenAt'],
      }));
    }
  }

  return { researchResponses, engagementDays };
}

async function buildPrivacyExportPackage(userId: string): Promise<{
  packageData: Record<string, unknown>;
  recordCounts: Record<string, number>;
}> {
  const userRef = db.doc(`users/${userId}`);
  const publicProfileRef = db.doc(`publicProfiles/${userId}`);
  const watchlistRef = db.doc(`managerWatchlists/${userId}`);
  const notesRef = db.doc(`managerPlayerNotes/${userId}`);
  const [
    authUser,
    user,
    publicProfile,
    watchlist,
    notes,
    memberships,
    feedback,
    diagnostics,
    requests,
    exportAudits,
    privateSeason,
  ] = await Promise.all([
    getAuth().getUser(userId),
    userRef.get(),
    publicProfileRef.get(),
    watchlistRef.get(),
    notesRef.get(),
    buildLeagueMembershipExport(userId),
    db.collection('feedbackReports').where('userId', '==', userId).limit(EXPORT_QUERY_LIMIT).get(),
    db.collection('clientErrorReports').where('userId', '==', userId).limit(EXPORT_QUERY_LIMIT).get(),
    db.collection('privacyRequestOperations').where('ownerId', '==', userId).limit(REQUEST_QUERY_LIMIT).get(),
    db.collection('privacyExportAudits').where('ownerId', '==', userId).limit(EXPORT_QUERY_LIMIT).get(),
    buildPrivateSeasonExport(userId),
  ]);

  const privacyRequests = requests.docs
    .map((document) => publicRequestFromSnapshot(document))
    .filter((entry): entry is PrivacyRequestPublicRecord => entry !== null)
    .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
  const feedbackRecords = feedback.docs.map((document) => feedbackExport(document.data()));
  const diagnosticRecords = diagnostics.docs.map((document) => diagnosticExport(document.data()));
  const privacyExports = exportAudits.docs
    .map((document) => exportAuditFromSnapshot(document))
    .sort((left, right) => (right.generatedAt ?? '').localeCompare(left.generatedAt ?? ''));
  const accountProfile = exportValue(user.data() ?? {});
  const publicProfileData = exportValue(publicProfile.data() ?? {});
  const watchlistData = exportValue(watchlist.data() ?? {});
  const notesData = exportValue(notes.data() ?? {});
  const recordCounts = {
    leagueMemberships: memberships.length,
    feedbackReports: feedbackRecords.length,
    clientDiagnostics: diagnosticRecords.length,
    privacyRequests: privacyRequests.length,
    dataExportAudits: privacyExports.length,
    privateSeasonResearchResponses: privateSeason.researchResponses.length,
    privateSeasonEngagementDays: privateSeason.engagementDays.length,
  };

  return {
    recordCounts,
    packageData: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceRelease: PRIVACY_OPERATIONS_RELEASE_LABEL,
      scoringRulesVersion: PRIVACY_OPERATIONS_SCORING_VERSION,
      projectionVersion: PRIVACY_OPERATIONS_PROJECTION_VERSION,
      account: {
        authentication: {
          userId,
          email: authUser.email ?? null,
          emailVerified: authUser.emailVerified,
          disabled: authUser.disabled,
          createdAt: authUser.metadata.creationTime ?? null,
          lastSignInAt: authUser.metadata.lastSignInTime ?? null,
          providerIds: authUser.providerData.map((provider) => provider.providerId),
        },
        privateProfile: accountProfile,
        publicProfile: publicProfileData,
        watchlist: watchlistData,
        playerNotes: notesData,
      },
      leagueMemberships: memberships,
      supportAndDiagnostics: {
        feedbackReports: feedbackRecords,
        clientDiagnostics: diagnosticRecords,
      },
      privateSeason: privateSeason,
      privacyRequests,
      privacyExports,
      retentionSchedule: PRIVACY_RETENTION_CATALOG,
      deletion: {
        selfServiceLocation: '/account/settings',
        behavior: 'Permanent account deletion removes the login and account-linked private data while preserving anonymized competition history needed to avoid rewriting other managers’ completed results.',
      },
      notIncluded: [
        'Other managers’ private data',
        'Authentication tokens, passwords, secrets, and App Check credentials',
        'Raw server logs and security investigation material',
        'Full NHL provider payloads or public hockey data that is not personal account data',
        'Anonymous league competition history that cannot reasonably be tied back to the deleted account after anonymization',
      ],
      limits: {
        feedbackReportMaximum: EXPORT_QUERY_LIMIT,
        clientDiagnosticMaximum: EXPORT_QUERY_LIMIT,
        privacyRequestMaximum: REQUEST_QUERY_LIMIT,
        dataExportAuditMaximum: EXPORT_QUERY_LIMIT,
        maximumPackageBytes: PRIVACY_EXPORT_MAXIMUM_BYTES,
      },
    },
  };
}

function appendTimeline(
  existing: unknown,
  entry: Omit<PrivacyRequestTimelineEntry, 'occurredAt'> & { occurredAt: Timestamp },
): Array<Record<string, unknown>> {
  const current = Array.isArray(existing) ? existing.slice(-19) : [];
  return [...current, entry];
}

export const getMyPrivacyCenter = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 40,
    memory: '256MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<PrivacyCenterResponse> => {
    const userId = requireVerifiedManager(request.auth, 'review your privacy requests');
    buildIdentity(record(request.data)['build'], false);
    const [requests, exports] = await Promise.all([
      db.collection('privacyRequestOperations').where('ownerId', '==', userId).limit(REQUEST_QUERY_LIMIT).get(),
      db.collection('privacyExportAudits').where('ownerId', '==', userId).limit(400).get(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      requests: requests.docs
        .map((document) => publicRequestFromSnapshot(document))
        .filter((entry): entry is PrivacyRequestPublicRecord => entry !== null)
        .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')),
      exports: exports.docs
        .map((document) => exportAuditFromSnapshot(document))
        .sort((left, right) => (right.generatedAt ?? '').localeCompare(left.generatedAt ?? ''))
        .slice(0, 50),
      retention: PRIVACY_RETENTION_CATALOG,
      responseTargetDays: PRIVACY_REQUEST_RESPONSE_TARGET_DAYS,
      responseTargetIsLegalDeadline: false,
    };
  },
);

export const manageMyPrivacyRequest = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '256MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<{ updated: boolean; request: PrivacyRequestPublicRecord }> => {
    const userId = requireAuthenticatedUserId(request.auth, 'manage a privacy request');
    requireVerifiedRecentAuthentication(request.auth, 'manage a privacy request');
    const input = record(request.data);
    const build = buildIdentity(input['build'], true);
    const action = boundedPrivacyText(input['action'], 20);
    await consumePrivacyRateLimit(userId, 'request', PRIVACY_REQUEST_DAILY_LIMIT);

    if (action === 'create') {
      const requestType = normalizePrivacyRequestType(input['requestType']);
      const subject = boundedPrivacyText(input['subject'], PRIVACY_REQUEST_SUBJECT_MAXIMUM);
      const details = boundedPrivacyText(input['details'], PRIVACY_REQUEST_TEXT_MAXIMUM);
      if (!requestType || subject.length < 4 || details.length < 10) {
        throw new HttpsError(
          'invalid-argument',
          'Choose a request type and provide a short subject plus at least ten characters of detail.',
        );
      }

      const existing = await db.collection('privacyRequestOperations')
        .where('ownerId', '==', userId)
        .limit(PRIVACY_REQUEST_MAXIMUM_PER_ACCOUNT + 1)
        .get();
      if (existing.size >= PRIVACY_REQUEST_MAXIMUM_PER_ACCOUNT) {
        throw new HttpsError('resource-exhausted', 'The account privacy-request limit has been reached.');
      }

      const requestId = randomUUID();
      const reference = db.doc(`privacyRequestOperations/${requestId}`);
      const now = Timestamp.now();
      const targetResponseAt = Timestamp.fromMillis(
        now.toMillis() + PRIVACY_REQUEST_RESPONSE_TARGET_DAYS * 24 * 60 * 60 * 1_000,
      );
      const expiresAt = Timestamp.fromMillis(
        now.toMillis() + PRIVACY_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
      );
      const timeline = [{
        kind: 'manager-request',
        message: details,
        status: 'submitted',
        occurredAt: now,
      }];

      await reference.set({
        schemaVersion: 1,
        requestId,
        ownerId: userId,
        ownerReference: privacyOwnerReference(userId),
        requestType,
        subject,
        details,
        status: 'submitted',
        publicResponse: '',
        adminNotes: '',
        revision: 1,
        timeline,
        targetResponseAt,
        releaseLabel: build.releaseLabel,
        buildId: build.buildId,
        scoringRulesVersion: build.scoringRulesVersion,
        projectionVersion: build.projectionVersion,
        lastUpdatedByRole: 'manager',
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        expiresAt,
      });
      await reference.collection('changes').doc(randomUUID()).set({
        schemaVersion: 1,
        action: 'submitted',
        actorRole: 'manager',
        actorId: userId,
        revision: 1,
        requestType,
        status: 'submitted',
        releaseLabel: build.releaseLabel,
        buildId: build.buildId,
        createdAt: now,
      });

      const created = await reference.get();
      const publicRecord = publicRequestFromSnapshot(created);
      if (!publicRecord) throw new HttpsError('internal', 'The privacy request could not be read after creation.');
      return { updated: true, request: publicRecord };
    }

    const requestId = requireFirestoreDocumentId(input['requestId'], 'privacy request ID', { maxBytes: 128 });
    const expectedRevision = number(input['expectedRevision'], 1, 1_000_000);
    const reference = db.doc(`privacyRequestOperations/${requestId}`);

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new HttpsError('not-found', 'That privacy request no longer exists.');
      const data = snapshot.data() ?? {};
      if (data['ownerId'] !== userId) throw new HttpsError('permission-denied', 'That privacy request belongs to another account.');
      const status = normalizePrivacyRequestStatus(data['status']);
      const revision = number(data['revision'], 1, 1_000_000);
      if (!status) throw new HttpsError('failed-precondition', 'That privacy request has an invalid status.');
      if (revision !== expectedRevision) throw new HttpsError('aborted', 'This privacy request changed in another tab. Refresh before continuing.');
      if (isPrivacyRequestTerminal(status)) throw new HttpsError('failed-precondition', 'That privacy request is already closed.');

      const now = Timestamp.now();
      if (action === 'respond') {
        if (status !== 'waiting-for-manager') {
          throw new HttpsError('failed-precondition', 'A follow-up can be sent only when RinkRat is waiting for your response.');
        }
        const message = boundedPrivacyText(input['message'], PRIVACY_REQUEST_TEXT_MAXIMUM);
        if (message.length < 4) throw new HttpsError('invalid-argument', 'Add a short follow-up response.');
        transaction.set(reference, {
          status: 'in-review',
          revision: revision + 1,
          timeline: appendTimeline(data['timeline'], {
            kind: 'manager-follow-up',
            message,
            status: 'in-review',
            occurredAt: now,
          }),
          lastUpdatedByRole: 'manager',
          updatedAt: now,
          expiresAt: Timestamp.fromMillis(now.toMillis() + PRIVACY_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
        }, { merge: true });
        transaction.set(reference.collection('changes').doc(randomUUID()), {
          schemaVersion: 1,
          action: 'manager-follow-up',
          actorRole: 'manager',
          actorId: userId,
          revision: revision + 1,
          status: 'in-review',
          releaseLabel: build.releaseLabel,
          buildId: build.buildId,
          createdAt: now,
        });
        return;
      }

      if (action === 'cancel') {
        transaction.set(reference, {
          status: 'cancelled',
          revision: revision + 1,
          timeline: appendTimeline(data['timeline'], {
            kind: 'status-change',
            message: 'The manager cancelled this privacy request.',
            status: 'cancelled',
            occurredAt: now,
          }),
          lastUpdatedByRole: 'manager',
          updatedAt: now,
          completedAt: now,
          expiresAt: Timestamp.fromMillis(now.toMillis() + PRIVACY_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
        }, { merge: true });
        transaction.set(reference.collection('changes').doc(randomUUID()), {
          schemaVersion: 1,
          action: 'manager-cancelled',
          actorRole: 'manager',
          actorId: userId,
          revision: revision + 1,
          status: 'cancelled',
          releaseLabel: build.releaseLabel,
          buildId: build.buildId,
          createdAt: now,
        });
        return;
      }

      throw new HttpsError('invalid-argument', 'Choose a supported privacy-request action.');
    });

    const updated = await reference.get();
    const publicRecord = publicRequestFromSnapshot(updated);
    if (!publicRecord) throw new HttpsError('internal', 'The privacy request could not be read after the update.');
    return { updated: true, request: publicRecord };
  },
);

export const getMyPrivacyExport = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '1GiB',
    maxInstances: 3,
    concurrency: 1,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<{
    fileName: string;
    packageHash: string;
    byteSize: number;
    recordCounts: Record<string, number>;
    json: string;
  }> => {
    const userId = requireAuthenticatedUserId(request.auth, 'download your RinkRat data');
    requireVerifiedRecentAuthentication(request.auth, 'download your RinkRat data');
    const build = buildIdentity(record(request.data)['build'], true);
    await consumePrivacyRateLimit(userId, 'export', PRIVACY_EXPORTS_PER_DAY);

    const { packageData, recordCounts } = await buildPrivacyExportPackage(userId);
    const json = JSON.stringify(packageData, null, 2);
    const byteSize = Buffer.byteLength(json, 'utf8');
    if (byteSize > PRIVACY_EXPORT_MAXIMUM_BYTES) {
      throw new HttpsError(
        'resource-exhausted',
        'Your immediate export is larger than the current browser-download limit. Submit an Additional Data Access request so RinkRat can prepare it safely.',
        { maximumBytes: PRIVACY_EXPORT_MAXIMUM_BYTES, actualBytes: byteSize },
      );
    }

    const packageHash = createHash('sha256').update(json).digest('hex');
    const username = boundedPrivacyText(record(record(packageData)['account'])['username'], 60)
      || boundedPrivacyText(record(record(packageData)['account'])['displayName'], 60)
      || boundedPrivacyText(record(record(record(packageData)['account'])['privateProfile'])['username'], 60)
      || 'manager';
    const fileName = privacyExportFileName(username, new Date().toISOString().slice(0, 10));
    const exportId = randomUUID();
    const now = Timestamp.now();
    await db.doc(`privacyExportAudits/${exportId}`).set({
      schemaVersion: 1,
      exportId,
      ownerId: userId,
      ownerReference: privacyOwnerReference(userId),
      fileName,
      byteSize,
      packageHash,
      recordCounts,
      releaseLabel: build.releaseLabel,
      buildId: build.buildId,
      scoringRulesVersion: build.scoringRulesVersion,
      projectionVersion: build.projectionVersion,
      generatedAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + PRIVACY_EXPORT_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
    });

    return { fileName, packageHash, byteSize, recordCounts, json };
  },
);

export const getPrivacyRequestOperations = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<PrivacyOperationsDashboard> => {
    await requirePlatformAdmin(request.auth, 'review privacy requests');
    buildIdentity(record(request.data)['build'], true);
    const [requestSnapshot, exportSnapshot] = await Promise.all([
      db.collection('privacyRequestOperations').limit(ADMIN_REQUEST_QUERY_LIMIT).get(),
      db.collection('privacyExportAudits').limit(ADMIN_EXPORT_QUERY_LIMIT).get(),
    ]);
    const now = Date.now();
    const requests = requestSnapshot.docs
      .map((document): PrivacyRequestAdminView | null => {
        const data = document.data();
        const publicRecord = publicRequestFromSnapshot(document);
        if (!publicRecord) return null;
        const target = publicRecord.targetResponseAt ? Date.parse(publicRecord.targetResponseAt) : Number.NaN;
        return {
          ...publicRecord,
          ownerReference: boundedPrivacyText(data['ownerReference'], 40),
          adminNotes: boundedPrivacyText(data['adminNotes'], PRIVACY_REQUEST_ADMIN_NOTE_MAXIMUM),
          overdue: !isPrivacyRequestTerminal(publicRecord.status) && Number.isFinite(target) && target < now,
          lastUpdatedByRole: boundedPrivacyText(data['lastUpdatedByRole'], 30),
        };
      })
      .filter((entry): entry is PrivacyRequestAdminView => entry !== null)
      .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
    const exports = exportSnapshot.docs
      .map((document) => ({
        ...exportAuditFromSnapshot(document),
        ownerReference: boundedPrivacyText(document.data()['ownerReference'], 40),
      }))
      .sort((left, right) => (right.generatedAt ?? '').localeCompare(left.generatedAt ?? ''));

    return {
      generatedAt: new Date().toISOString(),
      requests,
      exports,
      summary: {
        totalRequests: requests.length,
        openRequests: requests.filter((entry) => !isPrivacyRequestTerminal(entry.status)).length,
        waitingForManager: requests.filter((entry) => entry.status === 'waiting-for-manager').length,
        overdueRequests: requests.filter((entry) => entry.overdue).length,
        completedRequests: requests.filter((entry) => entry.status === 'completed').length,
        exportCount: exports.length,
      },
      responseTargetDays: PRIVACY_REQUEST_RESPONSE_TARGET_DAYS,
      responseTargetIsLegalDeadline: false,
    };
  },
);

export const updatePrivacyRequestOperation = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '256MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<{ updated: true; request: PrivacyRequestAdminView }> => {
    const adminId = await requirePlatformAdmin(request.auth, 'update a privacy request');
    const input = record(request.data);
    const build = buildIdentity(input['build'], true);
    const requestId = requireFirestoreDocumentId(input['requestId'], 'privacy request ID', { maxBytes: 128 });
    const expectedRevision = number(input['expectedRevision'], 1, 1_000_000);
    const nextStatus = normalizePrivacyRequestStatus(input['status']);
    const publicResponse = boundedPrivacyText(input['publicResponse'], PRIVACY_REQUEST_PUBLIC_RESPONSE_MAXIMUM);
    const adminNotes = boundedPrivacyText(input['adminNotes'], PRIVACY_REQUEST_ADMIN_NOTE_MAXIMUM);
    const auditReason = boundedPrivacyText(input['auditReason'], 500);
    if (!nextStatus || auditReason.length < 12) {
      throw new HttpsError('invalid-argument', 'Choose a status and enter an audit reason of at least 12 characters.');
    }
    if (['waiting-for-manager', 'completed', 'declined'].includes(nextStatus) && publicResponse.length < 8) {
      throw new HttpsError('invalid-argument', 'A manager-visible response is required for that status.');
    }

    const reference = db.doc(`privacyRequestOperations/${requestId}`);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) throw new HttpsError('not-found', 'That privacy request no longer exists.');
      const data = snapshot.data() ?? {};
      const currentStatus = normalizePrivacyRequestStatus(data['status']);
      const revision = number(data['revision'], 1, 1_000_000);
      if (!currentStatus) throw new HttpsError('failed-precondition', 'That privacy request has an invalid status.');
      if (revision !== expectedRevision) throw new HttpsError('aborted', 'This privacy request changed in another tab. Refresh before continuing.');
      if (!canTransitionPrivacyRequest(currentStatus, nextStatus)) {
        throw new HttpsError('failed-precondition', `${privacyRequestStatusLabel(currentStatus)} requests cannot move to ${privacyRequestStatusLabel(nextStatus)}.`);
      }

      const now = Timestamp.now();
      const statusChanged = currentStatus !== nextStatus;
      const publicChanged = boundedPrivacyText(data['publicResponse'], PRIVACY_REQUEST_PUBLIC_RESPONSE_MAXIMUM) !== publicResponse;
      const timeline = statusChanged || publicChanged
        ? appendTimeline(data['timeline'], {
          kind: publicResponse ? 'administrator-response' : 'status-change',
          message: publicResponse || `Request status changed to ${privacyRequestStatusLabel(nextStatus)}.`,
          status: nextStatus,
          occurredAt: now,
        })
        : Array.isArray(data['timeline']) ? data['timeline'] : [];
      const completedAt = isPrivacyRequestTerminal(nextStatus)
        ? data['completedAt'] ?? now
        : null;

      transaction.set(reference, {
        status: nextStatus,
        publicResponse,
        adminNotes,
        revision: revision + 1,
        timeline,
        lastUpdatedByRole: 'administrator',
        updatedAt: now,
        completedAt,
        expiresAt: Timestamp.fromMillis(now.toMillis() + PRIVACY_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
      }, { merge: true });
      transaction.set(reference.collection('changes').doc(randomUUID()), {
        schemaVersion: 1,
        action: 'administrator-updated',
        actorRole: 'administrator',
        actorId: adminId,
        revision: revision + 1,
        previousStatus: currentStatus,
        status: nextStatus,
        publicResponse,
        adminNotes,
        auditReason,
        releaseLabel: build.releaseLabel,
        buildId: build.buildId,
        createdAt: now,
      });
    });

    const updated = await reference.get();
    const data = updated.data() ?? {};
    const publicRecord = publicRequestFromSnapshot(updated);
    if (!publicRecord) throw new HttpsError('internal', 'The privacy request could not be read after the update.');
    const target = publicRecord.targetResponseAt ? Date.parse(publicRecord.targetResponseAt) : Number.NaN;
    return {
      updated: true,
      request: {
        ...publicRecord,
        ownerReference: boundedPrivacyText(data['ownerReference'], 40),
        adminNotes: boundedPrivacyText(data['adminNotes'], PRIVACY_REQUEST_ADMIN_NOTE_MAXIMUM),
        overdue: !isPrivacyRequestTerminal(publicRecord.status) && Number.isFinite(target) && target < Date.now(),
        lastUpdatedByRole: boundedPrivacyText(data['lastUpdatedByRole'], 30),
      },
    };
  },
);

export async function pseudonymizePrivacyOperationsForDeletedAccount(userId: string): Promise<number> {
  const safeUserId = requireFirestoreDocumentId(userId, 'manager ID', { maxBytes: 128 });
  let changed = 0;
  const now = Timestamp.now();

  while (true) {
    const requests = await db.collection('privacyRequestOperations')
      .where('ownerId', '==', safeUserId)
      .limit(400)
      .get();
    if (requests.empty) break;

    for (const document of requests.docs) {
      const data = document.data();
      const status = normalizePrivacyRequestStatus(data['status']) ?? 'cancelled';
      const nextStatus: PrivacyRequestStatus = isPrivacyRequestTerminal(status) ? status : 'cancelled';
      await document.ref.set({
        ownerId: FieldValue.delete(),
        subject: '[removed after account deletion]',
        details: '',
        publicResponse: '',
        adminNotes: '',
        timeline: [],
        status: nextStatus,
        revision: number(data['revision'], 1, 1_000_000) + 1,
        lastUpdatedByRole: 'account-deletion',
        accountDeletedAt: now,
        completedAt: data['completedAt'] ?? now,
        updatedAt: now,
        expiresAt: Timestamp.fromMillis(now.toMillis() + PRIVACY_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1_000),
        pseudonymized: true,
      }, { merge: true });

      while (true) {
        const changes = await document.ref.collection('changes')
          .where('actorId', '==', safeUserId)
          .limit(400)
          .get();
        if (changes.empty) break;
        const batch = db.batch();
        for (const change of changes.docs) {
          batch.set(change.ref, {
            actorId: FieldValue.delete(),
            actorReference: privacyOwnerReference(safeUserId),
            accountDeletedAt: now,
            pseudonymized: true,
          }, { merge: true });
        }
        await batch.commit();
        changed += changes.size;
      }

      changed += 1;
    }
  }

  while (true) {
    const exports = await db.collection('privacyExportAudits')
      .where('ownerId', '==', safeUserId)
      .limit(400)
      .get();
    if (exports.empty) break;
    const batch = db.batch();
    for (const document of exports.docs) {
      batch.set(document.ref, {
        ownerId: FieldValue.delete(),
        fileName: 'rinkrat-deleted-account-data.json',
        accountDeletedAt: now,
        pseudonymized: true,
        updatedAt: now,
      }, { merge: true });
    }
    await batch.commit();
    changed += exports.size;
  }

  return changed;
}
