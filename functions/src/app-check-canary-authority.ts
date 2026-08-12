import { createHash } from 'node:crypto';

import {
  DocumentData,
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
} from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import { requireVerifiedRecentAuthentication } from './shared/security/auth-security.util';
import {
  APP_CHECK_CALLABLE_CANARY_CONTROL_CACHE_MILLISECONDS,
  APP_CHECK_CALLABLE_CANARY_CONTROL_PATH,
  APP_CHECK_CALLABLE_CANARY_HEALTH_PATH,
  APP_CHECK_CALLABLE_CANARY_MAXIMUM_LEAGUES,
  APP_CHECK_CALLABLE_CANARY_MINIMUM_REASON_LENGTH,
  APP_CHECK_CALLABLE_CANARY_OPTIONS,
  APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION,
  buildAppCheckCallableCanaryDecision,
  normalizeAppCheckCallableCanaryControl,
  normalizeAppCheckCallableCanaryLeagueId,
  normalizeAppCheckCallableCanaryLeagueIds,
  normalizeAppCheckCallableCanaryNames,
  type AppCheckCallableCanaryControl,
  type AppCheckCallableCanaryMode,
  type AppCheckCallableCanaryName,
} from './shared/security/app-check-callable-canary.util';
import { buildAppCheckEnforcementReadiness } from './shared/security/app-check-enforcement-readiness.util';
import { requireFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import {
  FIRESTORE_AUTH_USER_ID_OPTIONS,
  FIRESTORE_LEAGUE_ID_OPTIONS,
} from './shared/security/firestore-document-id-policies';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const APP_CHECK_CANARY_EVIDENCE_WINDOW_DAYS = 14;
const APP_CHECK_CANARY_EVIDENCE_LIMIT = 1_000;
const APP_CHECK_CANARY_LEAGUE_LIMIT = 100;

interface CallableRequestLike {
  auth?: {
    uid?: string;
    token?: Record<string, unknown>;
  } | null;
  app?: {
    appId?: string;
  } | null;
  data?: unknown;
}

interface CachedControl {
  value: AppCheckCallableCanaryControl;
  expiresAt: number;
}

interface AppCheckCallableCanaryHealth {
  schemaVersion: number;
  controlRevision: number;
  mode: AppCheckCallableCanaryMode;
  approvedBuildId: string | null;
  allowedCount: number;
  blockedCount: number;
  byCallable: Record<string, {
    allowedCount: number;
    blockedCount: number;
    lastStatus: string;
    lastEventAt: string | null;
  }>;
  startedAt: string | null;
  lastAllowedAt: string | null;
  lastBlockedAt: string | null;
  lastLeagueReference: string;
}

let cachedControl: CachedControl | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, maximumLength = 500): string {
  return typeof value === 'string'
    ? value.trim().slice(0, maximumLength)
    : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function timestampIso(value: unknown): string | null {
  return value instanceof Timestamp
    ? value.toDate().toISOString()
    : null;
}

function shortLeagueReference(leagueId: string): string {
  return createHash('sha256').update(leagueId).digest('hex').slice(0, 12);
}

async function requirePlatformAdmin(
  request: CallableRequestLike,
  options: { recentAuthentication?: boolean; actionLabel?: string } = {},
): Promise<string> {
  const userId = requireFirestoreDocumentId(
    request.auth?.uid,
    'platform administrator ID',
    FIRESTORE_AUTH_USER_ID_OPTIONS,
  );

  if (request.auth?.token?.['platformAdmin'] !== true) {
    const snapshot = await db.doc(`platformAdmins/${userId}`).get();
    if (!snapshot.exists || snapshot.data()?.['enabled'] !== true) {
      throw new HttpsError(
        'permission-denied',
        'Platform-administrator access is required to manage App Check canaries.',
      );
    }
  }

  if (options.recentAuthentication) {
    requireVerifiedRecentAuthentication(
      request.auth,
      options.actionLabel ?? 'change App Check canary routing',
    );
  }

  return userId;
}

async function loadAppCheckCallableCanaryControl(
  force = false,
): Promise<AppCheckCallableCanaryControl> {
  const now = Date.now();
  if (!force && cachedControl && cachedControl.expiresAt > now) {
    return cachedControl.value;
  }

  const snapshot = await db.doc(APP_CHECK_CALLABLE_CANARY_CONTROL_PATH).get();
  const value = normalizeAppCheckCallableCanaryControl(
    snapshot.exists ? snapshot.data() : null,
  );
  cachedControl = {
    value,
    expiresAt: now + APP_CHECK_CALLABLE_CANARY_CONTROL_CACHE_MILLISECONDS,
  };
  return value;
}

function invalidateControlCache(): void {
  cachedControl = null;
}

function healthFromDocument(data: DocumentData | undefined): AppCheckCallableCanaryHealth {
  const source = data ?? {};
  const rawByCallable = asRecord(source['byCallable']);
  const byCallable: AppCheckCallableCanaryHealth['byCallable'] = {};

  for (const option of APP_CHECK_CALLABLE_CANARY_OPTIONS) {
    const item = asRecord(rawByCallable[option.name]);
    byCallable[option.name] = {
      allowedCount: asNumber(item['allowedCount']),
      blockedCount: asNumber(item['blockedCount']),
      lastStatus: asString(item['lastStatus'], 20),
      lastEventAt: timestampIso(item['lastEventAt']),
    };
  }

  return {
    schemaVersion: APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION,
    controlRevision: asNumber(source['controlRevision']),
    mode: source['mode'] === 'canary' ? 'canary' : 'monitor',
    approvedBuildId: asString(source['approvedBuildId'], 180) || null,
    allowedCount: asNumber(source['allowedCount']),
    blockedCount: asNumber(source['blockedCount']),
    byCallable,
    startedAt: timestampIso(source['startedAt']),
    lastAllowedAt: timestampIso(source['lastAllowedAt']),
    lastBlockedAt: timestampIso(source['lastBlockedAt']),
    lastLeagueReference: asString(source['lastLeagueReference'], 24),
  };
}

async function loadEligibleLeagues(
  selectedLeagueIds: readonly string[],
): Promise<Array<{
  leagueId: string;
  name: string;
  draftStatus: string;
  selected: boolean;
  isInternalTest: boolean;
}>> {
  const [leagueSnapshot, queueConfigSnapshot] = await Promise.all([
    db.collection('leagues').limit(APP_CHECK_CANARY_LEAGUE_LIMIT).get(),
    db.doc('appData/leagueAutomationQueueConfig').get(),
  ]);
  const queueConfig = queueConfigSnapshot.data() ?? {};
  const internalTestLeagueIds = new Set(
    (Array.isArray(queueConfig['internalTestLeagueIds'])
      ? queueConfig['internalTestLeagueIds']
      : [])
      .map((value) => normalizeAppCheckCallableCanaryLeagueId(value))
      .filter((value): value is string => Boolean(value)),
  );
  const visibleDocuments = new Map<
    string,
    DocumentSnapshot<DocumentData, DocumentData>
  >(leagueSnapshot.docs.map((document) => [document.id, document] as const));
  const missingSelectedReferences = selectedLeagueIds
    .filter((leagueId) => !visibleDocuments.has(leagueId))
    .map((leagueId) => db.doc(`leagues/${leagueId}`));
  if (missingSelectedReferences.length) {
    const selectedSnapshots = await db.getAll(...missingSelectedReferences);
    for (const snapshot of selectedSnapshots) {
      if (snapshot.exists) {
        visibleDocuments.set(snapshot.id, snapshot);
      }
    }
  }
  const leagueDocuments = [...visibleDocuments.values()];
  const draftReferences = leagueDocuments.map((document) =>
    db.doc(`leagues/${document.id}/draft/current`),
  );
  const draftSnapshots = draftReferences.length
    ? await db.getAll(...draftReferences)
    : [];

  return leagueDocuments
    .map((document, index) => {
      const data = document.data() ?? {};
      const draftData = draftSnapshots[index]?.data() ?? {};
      return {
        leagueId: document.id,
        name: asString(data['name'], 80) || 'Unnamed league',
        draftStatus: asString(draftData['status'], 30) || 'not-configured',
        selected: selectedLeagueIds.includes(document.id),
        isInternalTest: internalTestLeagueIds.has(document.id),
      };
    })
    .sort((left, right) =>
      Number(right.selected) - Number(left.selected) ||
      left.name.localeCompare(right.name) ||
      left.leagueId.localeCompare(right.leagueId),
    );
}

async function loadReadiness(exactBuildId: string) {
  const windowStartedAt = Date.now() -
    APP_CHECK_CANARY_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
  const snapshot = await db.collection('betaEvidenceEvents')
    .where('createdAt', '>=', Timestamp.fromMillis(windowStartedAt))
    .orderBy('createdAt', 'desc')
    .limit(APP_CHECK_CANARY_EVIDENCE_LIMIT + 1)
    .get();
  const sampleLimitReached = snapshot.size > APP_CHECK_CANARY_EVIDENCE_LIMIT;
  const records = snapshot.docs
    .slice(0, APP_CHECK_CANARY_EVIDENCE_LIMIT)
    .map((document) => document.data());

  return buildAppCheckEnforcementReadiness(
    records,
    exactBuildId,
    undefined,
    { sampleLimitReached },
  );
}

async function validateCanaryLeagues(leagueIds: readonly string[]): Promise<void> {
  const [snapshots, queueConfigSnapshot] = await Promise.all([
    db.getAll(...leagueIds.map((leagueId) => db.doc(`leagues/${leagueId}`))),
    db.doc('appData/leagueAutomationQueueConfig').get(),
  ]);
  const missing = snapshots.findIndex((snapshot) => !snapshot.exists);
  if (missing >= 0) {
    throw new HttpsError(
      'not-found',
      'One selected App Check canary league no longer exists. Refresh the control panel and choose again.',
    );
  }

  const queueConfig = queueConfigSnapshot.data() ?? {};
  const internalTestLeagueIds = new Set(
    (Array.isArray(queueConfig['internalTestLeagueIds'])
      ? queueConfig['internalTestLeagueIds']
      : [])
      .map((value) => normalizeAppCheckCallableCanaryLeagueId(value))
      .filter((value): value is string => Boolean(value)),
  );
  if (leagueIds.some((leagueId) => !internalTestLeagueIds.has(leagueId))) {
    throw new HttpsError(
      'failed-precondition',
      'Every App Check canary league must first be marked Internal Test in the Scoring Queue Control Center.',
      { reason: 'app-check-canary-internal-test-required' },
    );
  }
}

async function recordCanaryDecision(
  control: AppCheckCallableCanaryControl,
  callableName: AppCheckCallableCanaryName,
  leagueId: string,
  status: 'allowed' | 'blocked',
): Promise<void> {
  const reference = db.doc(APP_CHECK_CALLABLE_CANARY_HEALTH_PATH);
  const allowedIncrement = status === 'allowed' ? 1 : 0;
  const blockedIncrement = status === 'blocked' ? 1 : 0;
  const update: Record<string, unknown> = {
    schemaVersion: APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION,
    controlRevision: control.revision,
    mode: control.mode,
    approvedBuildId: control.approvedBuildId,
    allowedCount: FieldValue.increment(allowedIncrement),
    blockedCount: FieldValue.increment(blockedIncrement),
    lastLeagueReference: shortLeagueReference(leagueId),
    updatedAt: FieldValue.serverTimestamp(),
    [`byCallable.${callableName}.allowedCount`]: FieldValue.increment(allowedIncrement),
    [`byCallable.${callableName}.blockedCount`]: FieldValue.increment(blockedIncrement),
    [`byCallable.${callableName}.lastStatus`]: status,
    [`byCallable.${callableName}.lastEventAt`]: FieldValue.serverTimestamp(),
  };

  if (status === 'allowed') {
    update['lastAllowedAt'] = FieldValue.serverTimestamp();
  } else {
    update['lastBlockedAt'] = FieldValue.serverTimestamp();
  }

  try {
    await reference.update(update);
  } catch {
    await reference.set({
      schemaVersion: APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION,
      controlRevision: control.revision,
      mode: control.mode,
      approvedBuildId: control.approvedBuildId,
      allowedCount: allowedIncrement,
      blockedCount: blockedIncrement,
      byCallable: {
        [callableName]: {
          allowedCount: allowedIncrement,
          blockedCount: blockedIncrement,
          lastStatus: status,
          lastEventAt: FieldValue.serverTimestamp(),
        },
      },
      startedAt: FieldValue.serverTimestamp(),
      lastAllowedAt: status === 'allowed' ? FieldValue.serverTimestamp() : null,
      lastBlockedAt: status === 'blocked' ? FieldValue.serverTimestamp() : null,
      lastLeagueReference: shortLeagueReference(leagueId),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}

export async function enforceAppCheckCallableCanaryForLeague(
  request: CallableRequestLike,
  callableName: AppCheckCallableCanaryName,
  leagueIdValue: unknown,
): Promise<void> {
  const leagueId = requireFirestoreDocumentId(
    leagueIdValue,
    'league ID',
    FIRESTORE_LEAGUE_ID_OPTIONS,
  );
  const control = await loadAppCheckCallableCanaryControl();
  const decision = buildAppCheckCallableCanaryDecision(control, {
    callableName,
    leagueId,
    appId: request.app?.appId,
  });

  if (!decision.selectedForCanary) {
    return;
  }

  await recordCanaryDecision(
    control,
    callableName,
    leagueId,
    decision.shouldReject ? 'blocked' : 'allowed',
  ).catch(() => undefined);

  if (decision.shouldReject) {
    throw new HttpsError(
      'failed-precondition',
      'RinkRat could not verify this device for the selected App Check canary. Reload the site and try again. No competitive action was applied.',
      {
        reason: 'app-check-canary-verification-required',
        callableName,
      },
    );
  }
}

async function buildAdminSnapshot() {
  const [controlSnapshot, healthSnapshot] = await Promise.all([
    db.doc(APP_CHECK_CALLABLE_CANARY_CONTROL_PATH).get(),
    db.doc(APP_CHECK_CALLABLE_CANARY_HEALTH_PATH).get(),
  ]);
  const control = normalizeAppCheckCallableCanaryControl(
    controlSnapshot.exists ? controlSnapshot.data() : null,
  );
  const leagues = await loadEligibleLeagues(control.canaryLeagueIds);
  const controlData = controlSnapshot.data() ?? {};

  return {
    control: {
      ...control,
      updatedAt: timestampIso(controlData['updatedAt']),
      canaryStartedAt: timestampIso(controlData['canaryStartedAt']),
      canaryStoppedAt: timestampIso(controlData['canaryStoppedAt']),
    },
    health: healthFromDocument(healthSnapshot.data()),
    callableOptions: APP_CHECK_CALLABLE_CANARY_OPTIONS,
    leagues,
    maximumCanaryLeagues: APP_CHECK_CALLABLE_CANARY_MAXIMUM_LEAGUES,
    minimumReasonLength: APP_CHECK_CALLABLE_CANARY_MINIMUM_REASON_LENGTH,
    automaticPromotion: false,
  };
}

export const getAppCheckCallableCanaryControl = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 45,
    memory: '256MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request) => {
    await requirePlatformAdmin(request);
    return buildAdminSnapshot();
  },
);

export const updateAppCheckCallableCanaryControl = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 5,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request) => {
    const adminId = await requirePlatformAdmin(request, {
      recentAuthentication: true,
      actionLabel: 'change selected-callable App Check canary routing',
    });
    const data = asRecord(request.data);
    const mode: AppCheckCallableCanaryMode = data['mode'] === 'canary'
      ? 'canary'
      : 'monitor';
    const reason = asString(data['reason'], 500);

    if (reason.length < APP_CHECK_CALLABLE_CANARY_MINIMUM_REASON_LENGTH) {
      throw new HttpsError(
        'invalid-argument',
        `Explain this App Check routing change in at least ${APP_CHECK_CALLABLE_CANARY_MINIMUM_REASON_LENGTH} characters.`,
      );
    }

    const selectedCallables = normalizeAppCheckCallableCanaryNames(
      data['selectedCallables'],
    );
    const canaryLeagueIds = normalizeAppCheckCallableCanaryLeagueIds(
      data['canaryLeagueIds'],
    );
    const exactBuildId = asString(data['buildId'], 180);
    const currentSnapshot = await db.doc(APP_CHECK_CALLABLE_CANARY_CONTROL_PATH).get();
    const current = normalizeAppCheckCallableCanaryControl(
      currentSnapshot.exists ? currentSnapshot.data() : null,
    );
    const revision = current.revision + 1;
    let approvedBuildId: string | null = null;
    let approvedAppId: string | null = null;

    if (mode === 'canary') {
      if (!exactBuildId) {
        throw new HttpsError(
          'invalid-argument',
          'The exact deployed build ID is required before starting an App Check canary.',
        );
      }
      if (!selectedCallables.length) {
        throw new HttpsError(
          'invalid-argument',
          'Choose at least one callable for the App Check canary.',
        );
      }
      if (!canaryLeagueIds.length) {
        throw new HttpsError(
          'invalid-argument',
          'Choose at least one exact league for the App Check canary.',
        );
      }
      if (!request.app?.appId) {
        throw new HttpsError(
          'failed-precondition',
          'This administrator browser does not currently have a valid App Check token. Reload RinkRat before starting a canary.',
          { reason: 'app-check-canary-admin-token-required' },
        );
      }

      const readiness = await loadReadiness(exactBuildId);
      if (!readiness.canaryEligible) {
        throw new HttpsError(
          'failed-precondition',
          'The exact build has not passed every App Check evidence gate. Continue monitoring the blockers shown in Beta Operations.',
          {
            reason: 'app-check-canary-readiness-required',
            blockers: readiness.blockers.slice(0, 12),
          },
        );
      }

      await validateCanaryLeagues(canaryLeagueIds);
      approvedBuildId = exactBuildId;
      approvedAppId = request.app.appId;
    }

    const controlReference = db.doc(APP_CHECK_CALLABLE_CANARY_CONTROL_PATH);
    const healthReference = db.doc(APP_CHECK_CALLABLE_CANARY_HEALTH_PATH);
    const auditReference = db.collection('adminAuditLogs').doc();
    const leagueReferences = canaryLeagueIds.map(shortLeagueReference);
    const batch = db.batch();

    batch.set(controlReference, {
      schemaVersion: APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION,
      mode,
      revision,
      approvedBuildId,
      approvedAppId,
      selectedCallables,
      canaryLeagueIds,
      reason,
      updatedBy: adminId,
      updatedAt: FieldValue.serverTimestamp(),
      automaticPromotion: false,
      ...(mode === 'canary'
        ? {
            canaryStartedAt: FieldValue.serverTimestamp(),
            canaryStoppedAt: null,
          }
        : {
            canaryStoppedAt: FieldValue.serverTimestamp(),
          }),
    }, { merge: true });

    if (mode === 'canary') {
      batch.set(healthReference, {
        schemaVersion: APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION,
        controlRevision: revision,
        mode,
        approvedBuildId,
        allowedCount: 0,
        blockedCount: 0,
        byCallable: {},
        startedAt: FieldValue.serverTimestamp(),
        lastAllowedAt: null,
        lastBlockedAt: null,
        lastLeagueReference: '',
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      batch.set(healthReference, {
        schemaVersion: APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION,
        controlRevision: revision,
        mode: 'monitor',
        approvedBuildId: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    batch.set(auditReference, {
      action: mode === 'canary'
        ? 'app-check-callable-canary-started'
        : 'app-check-callable-canary-returned-to-monitor',
      controlRevision: revision,
      approvedBuildId,
      selectedCallables,
      canaryLeagueReferences: leagueReferences,
      reason,
      adminId,
      appIdVerifiedForActivation: mode === 'canary',
      automaticPromotion: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();
    invalidateControlCache();
    return buildAdminSnapshot();
  },
);
