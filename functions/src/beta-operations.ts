import { createHash } from 'node:crypto';

import {
  DocumentData,
  FieldValue,
  Timestamp,
} from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  BETA_OPERATION_SHARD_COUNT,
  BETA_OPERATION_WINDOW_DAYS_DEFAULT,
  BETA_OPERATION_WINDOW_DAYS_MAXIMUM,
  betaHistogramPercentile,
  betaOperationsDateKeys,
  emptyBetaDurationAccumulator,
  mergeBetaDurationAccumulators,
  normalizeBetaDurationAccumulator,
  type BetaDurationAccumulator,
} from './shared/core/observability/beta-operations.util';
import { requireVerifiedRecentAuthentication } from './shared/security/auth-security.util';
import { requireFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const BETA_EVIDENCE_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1_000;
const BETA_EVIDENCE_MAX_EVENTS_PER_HOUR = 120;
const BETA_EVIDENCE_WINDOW_MILLISECONDS = 60 * 60 * 1_000;
const BETA_EVIDENCE_ADMIN_LIMIT = 1_000;
const BETA_KNOWN_ISSUE_LIMIT = 50;
const BETA_FEEDBACK_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const BETA_SAMPLE_ID_PATTERN = /^(?:action|route)-[A-Za-z0-9-]{8,120}$/;


interface BetaDurationOverview {
  total: number;
  successes: number;
  errors: number;
  uncertain: number;
  cancelled: number;
  skipped: number;
  averageDurationMilliseconds: number;
  p95DurationMilliseconds: number;
  maximumDurationMilliseconds: number;
}

interface BetaTriggerDurationOverview extends BetaDurationOverview {
  trigger: string;
}

const COMPETITIVE_ACTIONS = new Set([
  'add-drop',
  'waiver-claim',
  'draft-pick',
  'draft-queue',
  'draft-auto',
  'draft-clock',
  'draft-settings',
  'historical-replay',
  'lineup-swap',
  'injured-reserve',
  'roster-drop',
]);
const COMPETITIVE_OUTCOMES = new Set(['success', 'error', 'uncertain', 'cancelled']);
const METRIC_KINDS = new Set(['competitive-action', 'route-ready']);
const VIEWPORTS = new Set(['small-phone', 'phone', 'tablet', 'desktop', 'unknown']);
const FEEDBACK_STATUSES = new Set([
  'new',
  'investigating',
  'confirmed',
  'fix-next-release',
  'resolved',
  'not-reproducible',
  'deferred',
]);
const KNOWN_ISSUE_STATUSES = new Set([
  'investigating',
  'fix-prepared',
  'monitoring',
  'resolved',
]);
const ISSUE_SEVERITIES = new Set([
  'integrity',
  'blocker',
  'serious',
  'cosmetic',
  'idea',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, maximumLength = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

function asNumber(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function timestampMilliseconds(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function timestampIso(value: unknown): string | null {
  const milliseconds = timestampMilliseconds(value);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

function sanitizeRoute(value: unknown): string {
  const route = asString(value, 300).split(/[?#]/)[0] || '/';

  return route
    .replace(/\/leagues\/[^/]+/gi, '/leagues/:leagueId')
    .replace(/\/players\/[^/]+/gi, '/players/:playerId')
    .replace(/\/matchups\/[^/]+/gi, '/matchups/:matchupId')
    .replace(/\/assets\/[^/]+/gi, '/assets/:assetKey')
    .replace(/\/users\/[^/]+/gi, '/users/:userId')
    .slice(0, 300);
}

function browserFamily(userAgent: string): string {
  const value = userAgent.toLowerCase();

  if (value.includes('edg/')) return 'Edge';
  if (value.includes('crios/')) return 'Chrome iOS';
  if (value.includes('fxios/')) return 'Firefox iOS';
  if (value.includes('chrome/') || value.includes('chromium/')) return 'Chrome';
  if (value.includes('firefox/')) return 'Firefox';
  if (value.includes('safari/') && value.includes('mobile/')) return 'Mobile Safari';
  if (value.includes('safari/')) return 'Safari';
  return 'Other';
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0]?.trim() ?? '' : value?.trim() ?? '';
}

function dailyUserHash(userId: string, dateKey: string): string {
  return createHash('sha256')
    .update(`rinkrat-beta-evidence:${dateKey}:${userId}`)
    .digest('hex')
    .slice(0, 24);
}

function evidenceDocumentId(userId: string, sampleId: string): string {
  return createHash('sha256')
    .update(`rinkrat-beta-sample:${userId}:${sampleId}`)
    .digest('hex')
    .slice(0, 40);
}

function countEntries(value: Map<string, number>): Array<{ name: string; count: number }> {
  return [...value.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }));
}

function incrementCount(map: Map<string, number>, key: string): void {
  const normalized = key || 'Unknown';
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);

  if (!sorted.length) {
    return 0;
  }

  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return Math.round(sorted[index] ?? 0);
}

function average(values: number[]): number {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!valid.length) return 0;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

async function consumeEvidenceRateLimit(userId: string): Promise<void> {
  const safeUserId = requireFirestoreDocumentId(userId, 'manager ID', {
    maxBytes: 128,
  });
  const reference = db.doc(`observabilityRateLimits/${safeUserId}`);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const now = Timestamp.now();
    const startedAt = data['betaEvidenceWindowStartedAt'];
    const count = typeof data['betaEvidenceWindowCount'] === 'number'
      ? data['betaEvidenceWindowCount'] as number
      : 0;
    const expired = !(startedAt instanceof Timestamp) ||
      now.toMillis() - startedAt.toMillis() >= BETA_EVIDENCE_WINDOW_MILLISECONDS;

    if (expired) {
      transaction.set(reference, {
        betaEvidenceWindowStartedAt: now,
        betaEvidenceWindowCount: 1,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    if (count >= BETA_EVIDENCE_MAX_EVENTS_PER_HOUR) {
      throw new HttpsError('resource-exhausted', 'Beta evidence rate limit reached.');
    }

    transaction.set(reference, {
      betaEvidenceWindowCount: count + 1,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

async function requirePlatformAdmin(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
  options: { recentAuthentication?: boolean; actionLabel?: string } = {},
): Promise<string> {
  const userId = requireFirestoreDocumentId(auth?.uid, 'platform administrator ID', {
    maxBytes: 128,
  });

  if (auth?.token?.['platformAdmin'] !== true) {
    const snapshot = await db.doc(`platformAdmins/${userId}`).get();
    if (!snapshot.exists || snapshot.data()?.['enabled'] !== true) {
      throw new HttpsError(
        'permission-denied',
        'Platform-administrator access is required to open beta operations.',
      );
    }
  }

  if (options.recentAuthentication) {
    requireVerifiedRecentAuthentication(
      auth,
      options.actionLabel ?? 'change beta operations data',
    );
  }

  return userId;
}

function publicKnownIssue(documentId: string, data: DocumentData): Record<string, unknown> | null {
  const status = asString(data['status'], 30);
  const severity = asString(data['severity'], 30);
  const title = asString(data['title'], 120);
  const summary = asString(data['summary'], 600);

  if (
    !KNOWN_ISSUE_STATUSES.has(status) ||
    !ISSUE_SEVERITIES.has(severity) ||
    !title ||
    !summary
  ) {
    return null;
  }

  return {
    issueId: documentId.slice(0, 80),
    title,
    summary,
    status,
    severity,
    affectedRelease: asString(data['affectedRelease'], 80),
    resolutionRelease: asString(data['resolutionRelease'], 80),
    updatedAt: timestampIso(data['updatedAt']),
    resolvedAt: timestampIso(data['resolvedAt']),
  };
}

function durationOverview(accumulator: BetaDurationAccumulator): BetaDurationOverview {
  const normalized = normalizeBetaDurationAccumulator(accumulator);
  return {
    total: normalized.total,
    successes: normalized.successes,
    errors: normalized.errors,
    uncertain: normalized.uncertain,
    cancelled: normalized.cancelled,
    skipped: normalized.skipped,
    averageDurationMilliseconds: normalized.total > 0
      ? Math.round(normalized.durationSumMilliseconds / normalized.total)
      : 0,
    p95DurationMilliseconds: betaHistogramPercentile(
      normalized.durationBuckets,
      normalized.total,
      0.95,
    ),
    maximumDurationMilliseconds: normalized.durationMaximumMilliseconds,
  };
}

export const recordBetaOperationMetric = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 15,
    memory: '256MiB',
    maxInstances: 20,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<{ accepted: boolean }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in before RinkRat records beta evidence.');
    }

    const data = asRecord(request.data);
    const sampleId = asString(data['sampleId'], 140);
    const kind = asString(data['kind'], 40);
    const viewportCategory = asString(data['viewportCategory'], 20);
    const durationMilliseconds = asNumber(data['durationMilliseconds'], 0, 10 * 60 * 1_000);

    if (!BETA_SAMPLE_ID_PATTERN.test(sampleId)) {
      throw new HttpsError('invalid-argument', 'The beta evidence sample identity is invalid.');
    }

    if (!METRIC_KINDS.has(kind)) {
      throw new HttpsError('invalid-argument', 'Choose a supported beta evidence type.');
    }

    if (!VIEWPORTS.has(viewportCategory)) {
      throw new HttpsError('invalid-argument', 'The beta evidence viewport is invalid.');
    }

    if (durationMilliseconds === null) {
      throw new HttpsError('invalid-argument', 'The beta evidence duration is invalid.');
    }

    const evidenceId = evidenceDocumentId(request.auth.uid, sampleId);
    const evidenceReference = db.doc(`betaEvidenceEvents/${evidenceId}`);
    const existing = await evidenceReference.get();
    if (existing.exists) {
      return { accepted: true };
    }

    await consumeEvidenceRateLimit(request.auth.uid);

    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const userAgent = headerValue(request.rawRequest.headers['user-agent']).slice(0, 300);
    const route = sanitizeRoute(data['route']);
    const releaseLabel = asString(data['releaseLabel'], 80) || 'Unknown release';
    const buildId = asString(data['buildId'], 160) || 'unknown-build';
    const connectionType = asString(data['connectionType'], 24) || 'unknown';
    const clientAppCheckStatus = asString(data['appCheckClientStatus'], 30) || 'unknown';
    const payload: Record<string, unknown> = {
      evidenceId,
      schemaVersion: 1,
      kind,
      route,
      viewportCategory,
      online: data['online'] !== false,
      connectionType,
      releaseLabel,
      buildId,
      clientAppCheckStatus,
      serverAppCheckStatus: request.app ? 'valid' : 'missing',
      browser: browserFamily(userAgent),
      dailyUserHash: dailyUserHash(request.auth.uid, dateKey),
      dateKey,
      durationMilliseconds,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + BETA_EVIDENCE_RETENTION_MILLISECONDS),
    };

    if (kind === 'competitive-action') {
      const action = asString(data['action'], 40);
      const outcome = asString(data['outcome'], 30);

      if (!COMPETITIVE_ACTIONS.has(action) || !COMPETITIVE_OUTCOMES.has(outcome)) {
        throw new HttpsError('invalid-argument', 'The competitive action evidence is invalid.');
      }

      payload['action'] = action;
      payload['outcome'] = outcome;
    } else {
      payload['listenerCount'] = asNumber(data['listenerCount'], 0, 500) ?? 0;
    }

    try {
      await evidenceReference.create(payload);
    } catch (error: unknown) {
      const candidate = error as { code?: unknown };
      if (candidate.code !== 6 && candidate.code !== 'already-exists') {
        throw error;
      }
    }

    return { accepted: true };
  },
);

export const getPublicBetaKnownIssues = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 20,
    memory: '256MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (): Promise<{ generatedAt: string; issues: Array<Record<string, unknown>> }> => {
    const snapshot = await db.collection('betaKnownIssues')
      .orderBy('updatedAt', 'desc')
      .limit(BETA_KNOWN_ISSUE_LIMIT)
      .get();

    const issues = snapshot.docs
      .map((document) => publicKnownIssue(document.id, document.data()))
      .filter((issue): issue is Record<string, unknown> => Boolean(issue));

    return {
      generatedAt: new Date().toISOString(),
      issues,
    };
  },
);

export const updateBetaFeedbackTriage = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 35,
    memory: '256MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<{ updated: boolean; knownIssuePublished: boolean }> => {
    const adminId = await requirePlatformAdmin(request.auth, {
      recentAuthentication: true,
      actionLabel: 'change beta feedback triage',
    });
    const data = asRecord(request.data);
    const feedbackId = requireFirestoreDocumentId(data['feedbackId'], 'feedback reference', {
      minimumLength: 10,
      maxBytes: 80,
      pattern: BETA_FEEDBACK_ID_PATTERN,
    });
    const status = asString(data['status'], 30);
    const severity = asString(data['severity'], 30);
    const owner = asString(data['owner'], 80);
    const duplicateOfValue = asString(data['duplicateOf'], 80);
    const duplicateOf = duplicateOfValue
      ? requireFirestoreDocumentId(duplicateOfValue, 'duplicate feedback reference', {
          minimumLength: 10,
          maxBytes: 80,
          pattern: BETA_FEEDBACK_ID_PATTERN,
        })
      : '';
    const resolutionRelease = asString(data['resolutionRelease'], 80);
    const adminNotes = asString(data['adminNotes'], 2_000);
    const publishKnownIssue = data['publishKnownIssue'] === true;
    const knownIssueStatus = asString(data['knownIssueStatus'], 30);
    const publicTitle = asString(data['publicTitle'], 120);
    const publicSummary = asString(data['publicSummary'], 600);

    if (!FEEDBACK_STATUSES.has(status)) {
      throw new HttpsError('invalid-argument', 'Choose a valid beta feedback status.');
    }

    if (!ISSUE_SEVERITIES.has(severity)) {
      throw new HttpsError('invalid-argument', 'Choose a valid beta feedback severity.');
    }

    if (duplicateOf === feedbackId) {
      throw new HttpsError('invalid-argument', 'A report cannot be a duplicate of itself.');
    }

    if (publishKnownIssue) {
      if (!KNOWN_ISSUE_STATUSES.has(knownIssueStatus)) {
        throw new HttpsError('invalid-argument', 'Choose a valid public issue status.');
      }
      if (!publicTitle || !publicSummary) {
        throw new HttpsError(
          'invalid-argument',
          'Published known issues need a public title and summary.',
        );
      }
    }

    const feedbackReference = db.doc(`feedbackReports/${feedbackId}`);
    const knownIssueReference = db.doc(`betaKnownIssues/${feedbackId}`);

    await db.runTransaction(async (transaction) => {
      const feedbackSnapshot = await transaction.get(feedbackReference);
      if (!feedbackSnapshot.exists) {
        throw new HttpsError('not-found', 'That feedback report no longer exists.');
      }

      if (duplicateOf) {
        const duplicateSnapshot = await transaction.get(db.doc(`feedbackReports/${duplicateOf}`));
        if (!duplicateSnapshot.exists) {
          throw new HttpsError('not-found', 'The duplicate report reference does not exist.');
        }
      }

      const feedback = feedbackSnapshot.data() ?? {};
      const affectedRelease = asString(feedback['reportedRelease'], 80) ||
        asString(feedback['releaseLabel'], 80) ||
        'Multiple or under review';

      transaction.set(feedbackReference, {
        status,
        severity,
        owner,
        duplicateOf,
        resolutionRelease,
        adminNotes,
        knownIssueId: publishKnownIssue ? feedbackId : '',
        knownIssueStatus: publishKnownIssue ? knownIssueStatus : '',
        publicTitle: publishKnownIssue ? publicTitle : '',
        publicSummary: publishKnownIssue ? publicSummary : '',
        reviewedBy: adminId,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      if (publishKnownIssue) {
        transaction.set(knownIssueReference, {
          schemaVersion: 1,
          issueId: feedbackId,
          sourceFeedbackId: feedbackId,
          title: publicTitle,
          summary: publicSummary,
          status: knownIssueStatus,
          severity,
          affectedRelease,
          resolutionRelease,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          resolvedAt: knownIssueStatus === 'resolved'
            ? FieldValue.serverTimestamp()
            : null,
          publishedBy: adminId,
        }, { merge: true });
      } else {
        transaction.delete(knownIssueReference);
      }
    });

    await db.collection('adminAuditLogs').add({
      action: 'beta-feedback-triage-updated',
      targetId: feedbackId,
      status,
      severity,
      knownIssuePublished: publishKnownIssue,
      adminId,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      updated: true,
      knownIssuePublished: publishKnownIssue,
    };
  },
);

export const getBetaOperationsSnapshot = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<Record<string, unknown>> => {
    await requirePlatformAdmin(request.auth);

    const data = asRecord(request.data);
    const requestedDays = asNumber(
      data['windowDays'],
      1,
      BETA_OPERATION_WINDOW_DAYS_MAXIMUM,
    ) ?? BETA_OPERATION_WINDOW_DAYS_DEFAULT;
    const dateKeys = betaOperationsDateKeys(requestedDays);
    const startDate = dateKeys[0] ?? new Date().toISOString().slice(0, 10);
    const endDate = dateKeys.at(-1) ?? startDate;
    const windowStartedAt = Date.parse(`${startDate}T00:00:00.000Z`);
    const dailyReferences = dateKeys.flatMap((dateKey) =>
      Array.from({ length: BETA_OPERATION_SHARD_COUNT }, (_, index) =>
        db.doc(`betaOperationsDaily/${dateKey}-${index.toString().padStart(2, '0')}`),
      ),
    );

    const [
      evidenceSnapshot,
      knownIssueSnapshot,
      scheduleSnapshot,
      legacyAutomationSnapshot,
      queueConfigSnapshot,
      queueHealthSnapshot,
      draftAutomationSnapshot,
    ] = await Promise.all([
      db.collection('betaEvidenceEvents')
        .where('createdAt', '>=', Timestamp.fromMillis(windowStartedAt))
        .orderBy('createdAt', 'desc')
        .limit(BETA_EVIDENCE_ADMIN_LIMIT + 1)
        .get(),
      db.collection('betaKnownIssues')
        .orderBy('updatedAt', 'desc')
        .limit(BETA_KNOWN_ISSUE_LIMIT)
        .get(),
      db.collection('leagueAutomationSchedules').limit(500).get(),
      db.doc('appData/leagueAutomation').get(),
      db.doc('appData/leagueAutomationQueueConfig').get(),
      db.doc('appData/leagueAutomationQueueHealth').get(),
      db.doc('appData/draftAutomation').get(),
    ]);
    const dailySnapshots = await Promise.all(
      dailyReferences.map((reference) => reference.get()),
    );

    const clientSampleLimitReached = evidenceSnapshot.size > BETA_EVIDENCE_ADMIN_LIMIT;
    const evidence = evidenceSnapshot.docs
      .slice(0, BETA_EVIDENCE_ADMIN_LIMIT)
      .map((document) => document.data())
      .filter((item) => timestampMilliseconds(item['createdAt']) >= windowStartedAt);
    const actionEvidence = evidence.filter((item) => item['kind'] === 'competitive-action');
    const routeEvidence = evidence.filter((item) => item['kind'] === 'route-ready');
    const actionGroups = new Map<string, DocumentData[]>();
    const routeGroups = new Map<string, DocumentData[]>();
    const viewportCounts = new Map<string, number>();
    const browserCounts = new Map<string, number>();
    const buildCounts = new Map<string, number>();
    const uniqueDailyUsers = new Set<string>();

    for (const item of evidence) {
      incrementCount(viewportCounts, asString(item['viewportCategory'], 20));
      incrementCount(browserCounts, asString(item['browser'], 40));
      incrementCount(buildCounts, asString(item['releaseLabel'], 80));
      const dailyHash = asString(item['dailyUserHash'], 40);
      if (dailyHash) uniqueDailyUsers.add(dailyHash);
    }

    for (const item of actionEvidence) {
      const action = asString(item['action'], 40) || 'unknown';
      const list = actionGroups.get(action) ?? [];
      list.push(item);
      actionGroups.set(action, list);
    }

    for (const item of routeEvidence) {
      const route = sanitizeRoute(item['route']);
      const list = routeGroups.get(route) ?? [];
      list.push(item);
      routeGroups.set(route, list);
    }

    const actions = [...actionGroups.entries()]
      .map(([action, items]) => {
        const durations = items
          .map((item) => asNumber(item['durationMilliseconds'], 0, 10 * 60 * 1_000))
          .filter((value): value is number => value !== null);
        const successes = items.filter((item) => item['outcome'] === 'success').length;
        return {
          action,
          total: items.length,
          successes,
          errors: items.filter((item) => item['outcome'] === 'error').length,
          uncertain: items.filter((item) => item['outcome'] === 'uncertain').length,
          cancelled: items.filter((item) => item['outcome'] === 'cancelled').length,
          averageDurationMilliseconds: average(durations),
          p95DurationMilliseconds: percentile(durations, 0.95),
          maximumDurationMilliseconds: durations.length ? Math.max(...durations) : 0,
          successRatePercent: items.length
            ? Math.round((successes / items.length) * 1_000) / 10
            : 0,
        };
      })
      .sort((left, right) => right.total - left.total || left.action.localeCompare(right.action));

    const routes = [...routeGroups.entries()]
      .map(([route, items]) => {
        const durations = items
          .map((item) => asNumber(item['durationMilliseconds'], 0, 10 * 60 * 1_000))
          .filter((value): value is number => value !== null);
        const listeners = items
          .map((item) => asNumber(item['listenerCount'], 0, 500))
          .filter((value): value is number => value !== null);
        return {
          route,
          total: items.length,
          averageReadyMilliseconds: average(durations),
          p95ReadyMilliseconds: percentile(durations, 0.95),
          maximumReadyMilliseconds: durations.length ? Math.max(...durations) : 0,
          averageListenerCount: average(listeners),
          maximumListenerCount: listeners.length ? Math.max(...listeners) : 0,
        };
      })
      .sort((left, right) => right.total - left.total || left.route.localeCompare(right.route))
      .slice(0, 40);

    let serverScoring = emptyBetaDurationAccumulator();
    const serverScoringByTrigger = new Map<string, BetaDurationAccumulator>();

    for (const snapshot of dailySnapshots) {
      if (!snapshot.exists) continue;
      const daily = snapshot.data() ?? {};
      serverScoring = mergeBetaDurationAccumulators(
        serverScoring,
        normalizeBetaDurationAccumulator(daily['serverScoring']),
      );
      const triggerData = asRecord(daily['serverScoringByTrigger']);
      for (const [trigger, value] of Object.entries(triggerData)) {
        serverScoringByTrigger.set(
          trigger,
          mergeBetaDurationAccumulators(
            serverScoringByTrigger.get(trigger) ?? emptyBetaDurationAccumulator(),
            normalizeBetaDurationAccumulator(value),
          ),
        );
      }
    }

    const serverScoringByTriggerOverview: BetaTriggerDurationOverview[] = [
      ...serverScoringByTrigger.entries(),
    ]
      .map(([trigger, accumulator]) => ({
        trigger,
        ...durationOverview(accumulator),
      }))
      .sort((left, right) => right.total - left.total || left.trigger.localeCompare(right.trigger));

    const serverScoringOverview = {
      ...durationOverview(serverScoring),
      byTrigger: serverScoringByTriggerOverview,
    };

    const scheduleData = scheduleSnapshot.docs.map((document) => document.data());
    const now = Date.now();
    const overdueScheduleCount = scheduleData.filter((schedule) => {
      const nextScoringAt = timestampMilliseconds(schedule['nextScoringAt']);
      return schedule['scoringEnabled'] === true && nextScoringAt > 0 && nextScoringAt < now;
    }).length;
    const knownIssues = knownIssueSnapshot.docs
      .map((document) => publicKnownIssue(document.id, document.data()))
      .filter((issue): issue is Record<string, unknown> => Boolean(issue));
    const legacyAutomation = legacyAutomationSnapshot.data() ?? {};
    const queueConfig = queueConfigSnapshot.data() ?? {};
    const queueHealth = queueHealthSnapshot.data() ?? {};
    const draftAutomation = draftAutomationSnapshot.data() ?? {};

    return {
      generatedAt: new Date().toISOString(),
      windowDays: requestedDays,
      dateFrom: startDate,
      dateTo: endDate,
      clientSampleCount: evidence.length,
      clientSampleLimitReached,
      actionSampleCount: actionEvidence.length,
      routeSampleCount: routeEvidence.length,
      uniqueDailyUserCount: uniqueDailyUsers.size,
      appCheckValidCount: evidence.filter((item) => item['serverAppCheckStatus'] === 'valid').length,
      appCheckMissingCount: evidence.filter((item) => item['serverAppCheckStatus'] !== 'valid').length,
      actions,
      routes,
      browsers: countEntries(browserCounts),
      devices: countEntries(viewportCounts),
      builds: countEntries(buildCounts),
      serverScoring: serverScoringOverview,
      scoringFreshnessAvailable: false,
      scoringFreshnessMessage:
        'Worker duration is measured now. Exact NHL-update-to-visible-score freshness begins when live NHL source-update timestamps are available during the season.',
      queue: {
        mode: asString(queueConfig['mode'], 20) || 'shadow',
        scheduleCount: scheduleData.length,
        overdueScheduleCount,
        activeTaskCount: asNumber(queueHealth['pendingTaskCount'], 0, 100_000) ?? 0,
        maxPendingTasks: asNumber(queueHealth['maxPendingTasks'], 0, 100_000) ?? 24,
        dispatcherStatus: asString(queueHealth['status'], 40) || 'unknown',
        dispatcherLastRunAt: timestampIso(queueHealth['lastRunAt']),
        legacyStatus: asString(legacyAutomation['status'], 40) || 'unknown',
        legacyLastRunAt: timestampIso(legacyAutomation['lastRunAt']),
        failedLeagueCount: asNumber(legacyAutomation['failedLeagueCount'], 0, 100_000) ?? 0,
      },
      draftAutomation: {
        status: asString(draftAutomation['status'], 40) || 'unknown',
        lastRunAt: timestampIso(draftAutomation['lastRunAt']),
        durationMilliseconds: asNumber(
          draftAutomation['durationMilliseconds'],
          0,
          10 * 60 * 1_000,
        ) ?? 0,
        failedDraftCount: asNumber(draftAutomation['failedDraftCount'], 0, 100_000) ?? 0,
      },
      knownIssues,
      knownIssueSummary: {
        total: knownIssues.length,
        investigating: knownIssues.filter((issue) => issue['status'] === 'investigating').length,
        fixPrepared: knownIssues.filter((issue) => issue['status'] === 'fix-prepared').length,
        monitoring: knownIssues.filter((issue) => issue['status'] === 'monitoring').length,
        resolved: knownIssues.filter((issue) => issue['status'] === 'resolved').length,
      },
    };
  },
);
