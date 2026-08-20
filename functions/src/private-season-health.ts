import { createHash } from 'node:crypto';

import { FieldValue, Timestamp, type DocumentData, type Query } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  buildPrivateSeasonHealthSummary,
  normalizePrivateSeasonEngagementCategory,
  normalizePrivateSeasonWeeklyHealthRecord,
  privateSeasonManagerDayId,
  privateSeasonManagerHash,
  privateSeasonRetentionManagerRequirement,
  privateSeasonWeeklyHealthHashInput,
  PRIVATE_SEASON_HEALTH_PROJECTION_VERSION,
  PRIVATE_SEASON_HEALTH_RELEASE_LABEL,
  PRIVATE_SEASON_HEALTH_SCORING_VERSION,
  PRIVATE_SEASON_HEALTH_WEEKLY_REASON_MINIMUM_LENGTH,
  PRIVATE_SEASON_HEALTH_WEEKLY_RECORD_LIMIT,
  type PrivateSeasonActionEvidence,
  type PrivateSeasonHealthThresholds,
  type PrivateSeasonLeagueHealthEvidence,
  type PrivateSeasonWeeklyHealthRecord,
} from './shared/core/operations/private-season-health.util';
import {
  emptyPrivateSeasonPlan,
  normalizePrivateSeasonPlan,
  type PrivateSeasonBuildIdentity,
  type PrivateSeasonPlan,
} from './shared/core/operations/private-season.util';
import { requireVerifiedRecentAuthentication } from './shared/security/auth-security.util';
import { requireFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const PLAN_PATH = 'platformOperations/privateSeason2026-27';
const CURRENT_BUILD_ID_PATTERN = /^release-candidate-55-[A-Za-z0-9._:-]{4,160}$/;
const ENGAGEMENT_DAILY_LIMIT = 24;
const HEALTH_EVIDENCE_WINDOW_DAYS = 35;
const HEALTH_EVIDENCE_LIMIT = 2_000;
const INTEGRITY_REPORT_LIMIT = 200;
const SERVICE_INCIDENT_SCAN_LIMIT = 50;
const TRANSACTION_SCAN_LIMIT = 100;
const MANAGER_DAY_QUERY_LIMIT = 1_000;

const OPEN_FEEDBACK_STATUSES = new Set([
  'new',
  'investigating',
  'confirmed',
  'fix-next-release',
]);

const ROSTER_ACTION_TYPES = new Set([
  'add-drop',
  'add-open-slot',
  'queue-add-drop',
  'queue-add-open-slot',
  'waiver-claim',
  'waiver-award',
  'queue-waiver-award',
  'drop-to-waivers',
  'move-to-ir',
  'move-bench-to-ir',
  'activate-from-ir',
  'activate-ir-to-bench',
  'active-bench-swap',
  'active-bench-swap-activated',
  'slot-move-activated',
]);

const HEALTH_THRESHOLDS: PrivateSeasonHealthThresholds = {
  unresolvedP0IntegrityDefectsMaximum: 0,
  confirmedCoreActionReliabilityPercentMinimum: 99.5,
  sixMemberLeagueDraftCompletionPercentMinimum: 75,
  createdLeagueSixVerifiedMemberPercentMinimum: 60,
  fourWeekLeagueRetentionPercentMinimum: 70,
  medianSupportMinutesPerActiveLeagueWeekMaximum: 20,
  nextSeasonCommissionerIntentPercentMinimum: 70,
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximumLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number' || value instanceof Date) {
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  return null;
}

function dateKey(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function planFromData(data: DocumentData | undefined): PrivateSeasonPlan {
  if (!data) {
    return emptyPrivateSeasonPlan();
  }

  const latestDecision = record(data['latestDecision']);
  return normalizePrivateSeasonPlan({
    ...data,
    updatedAt: iso(data['updatedAt']),
    latestDecision: Object.keys(latestDecision).length > 0
      ? { ...latestDecision, recordedAt: iso(latestDecision['recordedAt']) }
      : null,
  });
}

function weeklyRecordFromData(
  data: DocumentData,
  activeSlots: readonly { slotId: string; leagueId: string }[],
): PrivateSeasonWeeklyHealthRecord | null {
  return normalizePrivateSeasonWeeklyHealthRecord({
    ...data,
    updatedAt: iso(data['updatedAt']),
  }, activeSlots);
}

function buildIdentity(value: unknown, requireDeployableBuild = false): PrivateSeasonBuildIdentity {
  const source = record(value);
  const result: PrivateSeasonBuildIdentity = {
    releaseLabel: text(source['releaseLabel'], 80),
    buildId: text(source['buildId'], 180),
    scoringRulesVersion: typeof source['scoringRulesVersion'] === 'number'
      ? Math.round(source['scoringRulesVersion'])
      : 0,
    projectionVersion: typeof source['projectionVersion'] === 'number'
      ? Math.round(source['projectionVersion'])
      : 0,
  };

  if (
    result.releaseLabel !== PRIVATE_SEASON_HEALTH_RELEASE_LABEL ||
    !CURRENT_BUILD_ID_PATTERN.test(result.buildId) ||
    result.scoringRulesVersion !== PRIVATE_SEASON_HEALTH_SCORING_VERSION ||
    result.projectionVersion !== PRIVATE_SEASON_HEALTH_PROJECTION_VERSION
  ) {
    throw new HttpsError(
      'failed-precondition',
      'Refresh RinkRat. Private-season health accepts only the current RC55 / Scoring V4 / Projection V11 build.',
    );
  }

  if (requireDeployableBuild && result.buildId.endsWith('-local')) {
    throw new HttpsError(
      'failed-precondition',
      'Open the deployed RC55 site before recording private-season evidence.',
    );
  }

  return result;
}

async function requirePlatformAdmin(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
  recent = false,
): Promise<string> {
  const adminId = requireFirestoreDocumentId(auth?.uid, 'platform administrator ID', {
    maxBytes: 128,
  });

  if (auth?.token?.['platformAdmin'] !== true) {
    const snapshot = await db.doc(`platformAdmins/${adminId}`).get();
    if (!snapshot.exists || snapshot.data()?.['enabled'] !== true) {
      throw new HttpsError('permission-denied', 'Platform-administrator access is required.');
    }
  }

  if (recent) {
    requireVerifiedRecentAuthentication(auth, 'change private-season weekly evidence');
  }

  return adminId;
}

function requireVerifiedManager(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
): string {
  const userId = requireFirestoreDocumentId(auth?.uid, 'manager ID', { maxBytes: 128 });

  if (auth?.token?.['email_verified'] !== true) {
    throw new HttpsError('failed-precondition', 'Verify your email before recording tester-season activity.');
  }

  return userId;
}

function auditReason(value: unknown): string {
  const candidate = text(value, 600);
  if (candidate.length < PRIVATE_SEASON_HEALTH_WEEKLY_REASON_MINIMUM_LENGTH) {
    throw new HttpsError(
      'invalid-argument',
      `Add at least ${PRIVATE_SEASON_HEALTH_WEEKLY_REASON_MINIMUM_LENGTH} characters of audit rationale.`,
    );
  }
  return candidate;
}

function timestampSortValue(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  const parsed = iso(value);
  return parsed ? Date.parse(parsed) : 0;
}

async function consumeEngagementRateLimit(userId: string, currentDateKey: string): Promise<void> {
  const reference = db.doc(`observabilityRateLimits/${userId}`);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const storedDateKey = text(data['privateSeasonEngagementDateKey'], 10);
    const storedCount = typeof data['privateSeasonEngagementCount'] === 'number'
      ? Math.max(0, Math.round(data['privateSeasonEngagementCount']))
      : 0;

    if (storedDateKey !== currentDateKey) {
      transaction.set(reference, {
        privateSeasonEngagementDateKey: currentDateKey,
        privateSeasonEngagementCount: 1,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    if (storedCount >= ENGAGEMENT_DAILY_LIMIT) {
      throw new HttpsError('resource-exhausted', 'Private-season activity limit reached for today.');
    }

    transaction.set(reference, {
      privateSeasonEngagementCount: storedCount + 1,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

async function loadManagerDays(
  leagueId: string,
  startDateKey: string,
  endDateKey: string | null = null,
): Promise<DocumentData[]> {
  let managerDayQuery: Query<DocumentData> = db
    .doc(PLAN_PATH)
    .collection('leagueEngagement')
    .doc(leagueId)
    .collection('managerDays')
    .where('dateKey', '>=', startDateKey);

  if (endDateKey) {
    managerDayQuery = managerDayQuery.where('dateKey', '<=', endDateKey);
  }

  const snapshot = await managerDayQuery.limit(MANAGER_DAY_QUERY_LIMIT).get();
  return snapshot.docs.map((document) => document.data());
}

function uniqueManagerCount(values: readonly DocumentData[]): number {
  return new Set(
    values
      .map((entry) => text(entry['managerHash'], 40))
      .filter(Boolean),
  ).size;
}

async function firstRosterActionAt(leagueId: string): Promise<string | null> {
  const ordered = await db.collection(`leagues/${leagueId}/transactions`)
    .orderBy('createdAt', 'asc')
    .limit(TRANSACTION_SCAN_LIMIT)
    .get()
    .catch(() => null);
  const fallback = ordered ?? await db.collection(`leagues/${leagueId}/transactions`)
    .limit(TRANSACTION_SCAN_LIMIT)
    .get();
  const matching = fallback.docs
    .map((document) => document.data())
    .filter((entry) => ROSTER_ACTION_TYPES.has(text(entry['type'], 50)))
    .sort((left, right) => timestampSortValue(left['createdAt']) - timestampSortValue(right['createdAt']))[0];

  return matching ? iso(matching['createdAt']) : null;
}

function missingLeagueHealthEvidence(
  slot: { slotId: string; leagueId: string; label: string; expectedManagerCount: number },
  leagueId = slot.leagueId,
): PrivateSeasonLeagueHealthEvidence {
  return {
    slotId: slot.slotId,
    leagueId,
    label: slot.label,
    expectedManagerCount: slot.expectedManagerCount,
    exists: false,
    teamCount: 0,
    draftStatus: 'missing',
    draftCompletedAt: null,
    firstMatchupViewedAt: null,
    firstRosterActionAt: null,
    activatedAt: null,
    latestEngagementAt: null,
    activeManagerCount7Days: 0,
    fourWeekDue: false,
    fourWeekWindowClosed: false,
    fourWeekActiveManagerCount: 0,
    fourWeekRequiredManagerCount: privateSeasonRetentionManagerRequirement(slot.expectedManagerCount),
    retainedAtFourWeeks: false,
  };
}

async function leagueHealthEvidence(
  slot: { slotId: string; leagueId: string; label: string; expectedManagerCount: number },
  nowMilliseconds: number,
): Promise<PrivateSeasonLeagueHealthEvidence> {
  let leagueId: string;
  try {
    leagueId = requireFirestoreDocumentId(slot.leagueId, 'private-season league ID', {
      maxBytes: 128,
    });
  } catch {
    return missingLeagueHealthEvidence(slot);
  }
  const engagementReference = db.doc(PLAN_PATH)
    .collection('leagueEngagement')
    .doc(leagueId);
  const recentStart = dateKey(nowMilliseconds - 6 * 24 * 60 * 60 * 1_000);
  const [league, draft, teams, engagement, recentDays, rosterActionAt] = await Promise.all([
    db.doc(`leagues/${leagueId}`).get(),
    db.doc(`leagues/${leagueId}/draft/current`).get(),
    db.collection(`leagues/${leagueId}/teams`).limit(20).get(),
    engagementReference.get(),
    loadManagerDays(leagueId, recentStart),
    firstRosterActionAt(leagueId),
  ]);

  if (!league.exists) {
    return missingLeagueHealthEvidence(slot, leagueId);
  }

  const draftData = draft.data() ?? {};
  const engagementData = engagement.data() ?? {};
  const draftStatus = text(draftData['status'], 30) || 'setup';
  const draftCompletedAt = draftStatus === 'complete'
    ? iso(draftData['completedAt']) ?? iso(draftData['updatedAt']) ?? iso(draftData['startedAt'])
    : null;
  const firstMatchupViewedAt = iso(engagementData['firstMatchupViewedAt']);
  const activatedAt = teams.size >= 6 && draftStatus === 'complete' && firstMatchupViewedAt
    ? firstMatchupViewedAt
    : null;
  const latestEngagementAt = iso(engagementData['lastEngagementAt']);
  const requiredManagers = privateSeasonRetentionManagerRequirement(
    Math.max(slot.expectedManagerCount, teams.size),
  );
  let fourWeekDue = false;
  let fourWeekWindowClosed = false;
  let fourWeekActiveManagerCount = 0;

  if (activatedAt) {
    const activatedMilliseconds = Date.parse(activatedAt);
    const dueMilliseconds = activatedMilliseconds + 28 * 24 * 60 * 60 * 1_000;
    const windowStartMilliseconds = activatedMilliseconds + 21 * 24 * 60 * 60 * 1_000;
    const windowEndMilliseconds = activatedMilliseconds + 35 * 24 * 60 * 60 * 1_000;
    fourWeekDue = nowMilliseconds >= dueMilliseconds;
    fourWeekWindowClosed = nowMilliseconds >= windowEndMilliseconds;

    if (nowMilliseconds >= windowStartMilliseconds) {
      const retentionDays = await loadManagerDays(
        leagueId,
        dateKey(windowStartMilliseconds),
        dateKey(Math.min(nowMilliseconds, windowEndMilliseconds)),
      );
      fourWeekActiveManagerCount = uniqueManagerCount(retentionDays);
    }
  }

  return {
    slotId: slot.slotId,
    leagueId,
    label: slot.label,
    expectedManagerCount: slot.expectedManagerCount,
    exists: true,
    teamCount: teams.size,
    draftStatus,
    draftCompletedAt,
    firstMatchupViewedAt,
    firstRosterActionAt: rosterActionAt,
    activatedAt,
    latestEngagementAt,
    activeManagerCount7Days: uniqueManagerCount(recentDays),
    fourWeekDue,
    fourWeekWindowClosed,
    fourWeekActiveManagerCount,
    fourWeekRequiredManagerCount: requiredManagers,
    retainedAtFourWeeks: fourWeekDue && fourWeekActiveManagerCount >= requiredManagers,
  };
}

async function actionEvidence(buildId: string, nowMilliseconds: number): Promise<PrivateSeasonActionEvidence> {
  const startedAt = Timestamp.fromMillis(
    nowMilliseconds - HEALTH_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  );
  const snapshot = await db.collection('betaEvidenceEvents')
    .where('createdAt', '>=', startedAt)
    .orderBy('createdAt', 'desc')
    .limit(HEALTH_EVIDENCE_LIMIT)
    .get();
  const actions = snapshot.docs
    .map((document) => document.data())
    .filter((entry) =>
      entry['kind'] === 'competitive-action' &&
      text(entry['buildId'], 180) === buildId);

  return {
    buildId,
    total: actions.length,
    successes: actions.filter((entry) => entry['outcome'] === 'success').length,
    errors: actions.filter((entry) => entry['outcome'] === 'error').length,
    uncertain: actions.filter((entry) => entry['outcome'] === 'uncertain').length,
    cancelled: actions.filter((entry) => entry['outcome'] === 'cancelled').length,
  };
}

async function unresolvedIntegrityCount(): Promise<number> {
  const [feedbackSnapshot, incidentSnapshot] = await Promise.all([
    db.collection('feedbackReports')
      .orderBy('createdAt', 'desc')
      .limit(INTEGRITY_REPORT_LIMIT)
      .get(),
    db.collection('publicServiceIncidents')
      .orderBy('updatedAt', 'desc')
      .limit(SERVICE_INCIDENT_SCAN_LIMIT)
      .get(),
  ]);

  const feedbackCount = feedbackSnapshot.docs
    .map((document) => document.data())
    .filter((entry) =>
      text(entry['severity'], 30) === 'integrity' &&
      OPEN_FEEDBACK_STATUSES.has(text(entry['status'], 30)))
    .length;
  const activeP0IncidentCount = incidentSnapshot.docs
    .map((document) => document.data())
    .filter((entry) =>
      text(entry['severity'], 10) === 'p0' && text(entry['status'], 30) !== 'resolved')
    .length;

  return feedbackCount + activeP0IncidentCount;
}

async function healthSnapshot(
  plan: PrivateSeasonPlan,
  build: PrivateSeasonBuildIdentity,
): Promise<Record<string, unknown>> {
  const planReference = db.doc(PLAN_PATH);
  const activeSlots = plan.leagueSlots
    .filter((slot) => slot.active && slot.leagueId)
    .map((slot) => ({
      slotId: slot.slotId,
      leagueId: slot.leagueId,
      label: slot.label,
      expectedManagerCount: slot.expectedManagerCount,
    }));
  const nowMilliseconds = Date.now();
  const evidenceBuildId = plan.freeze.approvedBuildId || build.buildId;
  const [weeklySnapshot, integrityCount, actions, leagues] = await Promise.all([
    planReference.collection('weeklyHealth')
      .orderBy('weekEnding', 'desc')
      .limit(PRIVATE_SEASON_HEALTH_WEEKLY_RECORD_LIMIT)
      .get(),
    unresolvedIntegrityCount(),
    actionEvidence(evidenceBuildId, nowMilliseconds),
    Promise.all(activeSlots.map((slot) => leagueHealthEvidence(slot, nowMilliseconds))),
  ]);
  const weeklyRecords = weeklySnapshot.docs
    .map((document) => weeklyRecordFromData(document.data(), activeSlots))
    .filter((entry): entry is PrivateSeasonWeeklyHealthRecord => Boolean(entry));
  const summary = buildPrivateSeasonHealthSummary({
    leagues,
    weeklyRecords,
    actions,
    unresolvedIntegrityCount: integrityCount,
    thresholds: HEALTH_THRESHOLDS,
  });

  return {
    generatedAt: new Date(nowMilliseconds).toISOString(),
    planRevision: plan.revision,
    planStatus: plan.status,
    planReleaseLabel: plan.freeze.approvedReleaseLabel,
    planBuildId: plan.freeze.approvedBuildId,
    build,
    thresholds: HEALTH_THRESHOLDS,
    leagues,
    weeklyRecords,
    actions,
    unresolvedIntegrityCount: integrityCount,
    summary,
    retentionDefinition: {
      observationStartsDay: 22,
      dueDay: 28,
      observationClosesDay: 35,
      minimumManagers: 3,
      managerRatio: 0.5,
      note: 'Initial tester-season operating definition; refine only from observed evidence.',
    },
  };
}

export const recordPrivateSeasonEngagement = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 25,
    memory: '256MiB',
    maxInstances: 20,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<{ accepted: boolean; reason: string }> => {
    const userId = requireVerifiedManager(request.auth);
    const input = record(request.data);
    const build = buildIdentity(input['build'], true);
    const category = normalizePrivateSeasonEngagementCategory(input['category']);
    if (!category) {
      throw new HttpsError('invalid-argument', 'Choose a supported private-season activity category.');
    }
    const leagueId = requireFirestoreDocumentId(input['leagueId'], 'private-season league ID', {
      maxBytes: 128,
    });
    const planReference = db.doc(PLAN_PATH);
    const [planSnapshot, memberSnapshot] = await Promise.all([
      planReference.get(),
      db.doc(`leagues/${leagueId}/members/${userId}`).get(),
    ]);
    const plan = planFromData(planSnapshot.data());
    const tracked = plan.leagueSlots.some((slot) => slot.active && slot.leagueId === leagueId);

    if (!tracked) {
      return { accepted: false, reason: 'not-tracked' };
    }

    if (!memberSnapshot.exists) {
      throw new HttpsError('permission-denied', 'League membership is required.');
    }

    const currentDateKey = dateKey(Date.now());
    await consumeEngagementRateLimit(userId, currentDateKey);
    const managerHash = privateSeasonManagerHash(userId, leagueId);
    const summaryReference = planReference.collection('leagueEngagement').doc(leagueId);
    const dayReference = summaryReference
      .collection('managerDays')
      .doc(privateSeasonManagerDayId(managerHash, currentDateKey));

    await db.runTransaction(async (transaction) => {
      const [summarySnapshot, daySnapshot] = await Promise.all([
        transaction.get(summaryReference),
        transaction.get(dayReference),
      ]);
      const summary = summarySnapshot.data() ?? {};
      const day = daySnapshot.data() ?? {};
      const categories = new Set(
        (Array.isArray(day['categories']) ? day['categories'] : [])
          .map((value) => normalizePrivateSeasonEngagementCategory(value))
          .filter((value): value is NonNullable<typeof value> => Boolean(value)),
      );
      categories.add(category);
      transaction.set(dayReference, {
        schemaVersion: 1,
        dateKey: currentDateKey,
        managerHash,
        categories: [...categories].sort(),
        releaseLabel: build.releaseLabel,
        buildId: build.buildId,
        firstSeenAt: daySnapshot.exists && day['firstSeenAt']
          ? day['firstSeenAt']
          : FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(summaryReference, {
        schemaVersion: 1,
        leagueId,
        firstEngagementAt: summarySnapshot.exists && summary['firstEngagementAt']
          ? summary['firstEngagementAt']
          : FieldValue.serverTimestamp(),
        firstMatchupViewedAt: category === 'game-center' && !summary['firstMatchupViewedAt']
          ? FieldValue.serverTimestamp()
          : summary['firstMatchupViewedAt'] ?? null,
        lastEngagementAt: FieldValue.serverTimestamp(),
        latestDateKey: currentDateKey,
        uniqueManagerHashes: FieldValue.arrayUnion(managerHash),
        managerDayCount: daySnapshot.exists
          ? (typeof summary['managerDayCount'] === 'number'
            ? Math.max(0, Math.round(summary['managerDayCount']))
            : 0)
          : FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return { accepted: true, reason: 'recorded' };
  },
);

export const getPrivateSeasonHealthDashboard = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 90,
    memory: '1GiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<Record<string, unknown>> => {
    await requirePlatformAdmin(request.auth);
    const build = buildIdentity(request.data?.['build']);
    const planSnapshot = await db.doc(PLAN_PATH).get();
    return healthSnapshot(planFromData(planSnapshot.data()), build);
  },
);

export const updatePrivateSeasonWeeklyHealth = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 90,
    memory: '1GiB',
    maxInstances: 3,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<Record<string, unknown>> => {
    const adminId = await requirePlatformAdmin(request.auth, true);
    const input = record(request.data);
    const build = buildIdentity(input['build'], true);
    const reason = auditReason(input['reason']);
    const expectedRevision = integer(input['expectedRevision'], 0, 1_000_000);
    if (expectedRevision === null) {
      throw new HttpsError('invalid-argument', 'The weekly record revision is invalid. Refresh and try again.');
    }
    const planReference = db.doc(PLAN_PATH);
    const planSnapshot = await planReference.get();
    const plan = planFromData(planSnapshot.data());
    const activeSlots = plan.leagueSlots
      .filter((slot) => slot.active && slot.leagueId)
      .map((slot) => ({ slotId: slot.slotId, leagueId: slot.leagueId }));
    const normalized = normalizePrivateSeasonWeeklyHealthRecord(input['record'], activeSlots);
    if (!normalized) {
      throw new HttpsError('invalid-argument', 'Choose a valid week-ending date and weekly evidence values.');
    }
    const weekMilliseconds = Date.parse(`${normalized.weekEnding}T00:00:00.000Z`);
    if (
      weekMilliseconds < Date.now() - 400 * 24 * 60 * 60 * 1_000 ||
      weekMilliseconds > Date.now() + 14 * 24 * 60 * 60 * 1_000
    ) {
      throw new HttpsError('invalid-argument', 'The weekly evidence date is outside the supported tester-season range.');
    }
    const weeklyReference = planReference.collection('weeklyHealth').doc(normalized.weekEnding);

    await db.runTransaction(async (transaction) => {
      const stored = await transaction.get(weeklyReference);
      const currentRevision = typeof stored.data()?.['revision'] === 'number'
        ? Math.max(0, Math.round(stored.data()?.['revision']))
        : 0;
      if (currentRevision !== expectedRevision) {
        throw new HttpsError('aborted', 'That weekly record changed in another session. Refresh before saving.');
      }
      const next: PrivateSeasonWeeklyHealthRecord = {
        ...normalized,
        revision: currentRevision + 1,
        updatedAt: null,
        updatedBy: adminId,
      };
      const recordHash = createHash('sha256')
        .update(JSON.stringify(privateSeasonWeeklyHealthHashInput(next)))
        .digest('hex');
      transaction.set(weeklyReference, {
        ...next,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(planReference.collection('weeklyHealthChanges').doc(), {
        schemaVersion: 1,
        action: 'weekly-health-updated',
        weekEnding: next.weekEnding,
        revision: next.revision,
        recordHash,
        reason,
        releaseLabel: build.releaseLabel,
        buildId: build.buildId,
        actorId: adminId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return healthSnapshot(plan, build);
  },
);
