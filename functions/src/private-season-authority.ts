import { createHash } from 'node:crypto';

import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import {
  buildPrivateSeasonReadiness,
  emptyPrivateSeasonPlan,
  normalizePrivateSeasonPlan,
  privateSeasonPlanHashInput,
  privateSeasonPolicy,
  PRIVATE_SEASON_DECISION_REASON_MINIMUM_LENGTH,
  PRIVATE_SEASON_MAXIMUM_LEAGUES,
  PRIVATE_SEASON_PROJECTION_VERSION,
  PRIVATE_SEASON_RELEASE_LABEL,
  PRIVATE_SEASON_SCORING_VERSION,
  type PrivateSeasonBuildIdentity,
  type PrivateSeasonGateOutcome,
  type PrivateSeasonLiveLeagueEvidence,
  type PrivateSeasonPlan,
} from './shared/core/operations/private-season.util';
import { requireVerifiedRecentAuthentication } from './shared/security/auth-security.util';
import { requireFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const PLAN_PATH = 'platformOperations/privateSeason2026-27';
const REASON_MINIMUM = PRIVATE_SEASON_DECISION_REASON_MINIMUM_LENGTH;
const CURRENT_BUILD_ID_PATTERN = /^release-candidate-55-[A-Za-z0-9._:-]{4,160}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new HttpsError('invalid-argument', 'The private-season plan revision is invalid. Refresh and try again.');
  }
  return value;
}
function reason(value: unknown): string {
  const result = text(value, 600);
  if (result.length < REASON_MINIMUM) {
    throw new HttpsError('invalid-argument', `Add at least ${REASON_MINIMUM} characters of audit rationale.`);
  }
  return result;
}
function iso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === 'string') return value;
  return null;
}
function planFromData(data: DocumentData | undefined): PrivateSeasonPlan {
  if (!data) return emptyPrivateSeasonPlan();
  const latest = record(data['latestDecision']);
  return normalizePrivateSeasonPlan({
    ...data,
    updatedAt: iso(data['updatedAt']),
    latestDecision: Object.keys(latest).length ? { ...latest, recordedAt: iso(latest['recordedAt']) } : null,
  });
}

async function requirePlatformAdmin(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
  recent = false,
): Promise<string> {
  const userId = requireFirestoreDocumentId(auth?.uid, 'platform administrator ID', { maxBytes: 128 });
  if (auth?.token?.['platformAdmin'] !== true) {
    const snapshot = await db.doc(`platformAdmins/${userId}`).get();
    if (!snapshot.exists || snapshot.data()?.['enabled'] !== true) {
      throw new HttpsError('permission-denied', 'Platform-administrator access is required.');
    }
  }
  if (recent) requireVerifiedRecentAuthentication(auth, 'change the private tester-season plan');
  return userId;
}

function buildIdentity(value: unknown, requireDeployableBuild = false): PrivateSeasonBuildIdentity {
  const source = record(value);
  const result = {
    releaseLabel: text(source['releaseLabel'], 80),
    buildId: text(source['buildId'], 180),
    scoringRulesVersion: typeof source['scoringRulesVersion'] === 'number' ? Math.round(source['scoringRulesVersion']) : 0,
    projectionVersion: typeof source['projectionVersion'] === 'number' ? Math.round(source['projectionVersion']) : 0,
  };
  if (
    result.releaseLabel !== PRIVATE_SEASON_RELEASE_LABEL || !CURRENT_BUILD_ID_PATTERN.test(result.buildId) ||
    result.scoringRulesVersion !== PRIVATE_SEASON_SCORING_VERSION ||
    result.projectionVersion !== PRIVATE_SEASON_PROJECTION_VERSION
  ) {
    throw new HttpsError(
      'failed-precondition',
      'Refresh RinkRat. The private-season gate accepts only the current RC55 / Scoring V4 / Projection V11 build.',
    );
  }
  if (requireDeployableBuild && result.buildId.endsWith('-local')) {
    throw new HttpsError(
      'failed-precondition',
      'Open the deployed RC55 site before changing or approving the private-season plan.',
    );
  }
  return result;
}

async function leagueEvidence(plan: PrivateSeasonPlan): Promise<PrivateSeasonLiveLeagueEvidence[]> {
  const slots = plan.leagueSlots.filter((entry) => entry.active).slice(0, PRIVATE_SEASON_MAXIMUM_LEAGUES);
  return Promise.all(slots.map(async (slot) => {
    if (!slot.leagueId) {
      return { slotId: slot.slotId, leagueId: '', exists: false, name: slot.label, teamCount: 0, maxTeams: 0, draftStatus: 'missing', draftOrderCount: 0, draftScheduled: false };
    }
    let leagueId: string;
    try {
      leagueId = requireFirestoreDocumentId(slot.leagueId, 'tester league ID', { maxBytes: 128 });
    } catch {
      return {
        slotId: slot.slotId,
        leagueId: slot.leagueId,
        exists: false,
        name: slot.label,
        teamCount: 0,
        maxTeams: 0,
        draftStatus: 'invalid-id',
        draftOrderCount: 0,
        draftScheduled: false,
      };
    }
    const [league, draft, teams] = await Promise.all([
      db.doc(`leagues/${leagueId}`).get(),
      db.doc(`leagues/${leagueId}/draft/current`).get(),
      db.collection(`leagues/${leagueId}/teams`).limit(20).get(),
    ]);
    if (!league.exists) {
      return { slotId: slot.slotId, leagueId, exists: false, name: slot.label, teamCount: 0, maxTeams: 0, draftStatus: 'missing', draftOrderCount: 0, draftScheduled: false };
    }
    const leagueData = league.data() ?? {};
    const draftData = draft.data() ?? {};
    return {
      slotId: slot.slotId,
      leagueId,
      exists: true,
      name: text(leagueData['name'], 80) || slot.label,
      teamCount: teams.size,
      maxTeams: typeof leagueData['maxTeams'] === 'number' ? Math.round(leagueData['maxTeams']) : 0,
      draftStatus: text(draftData['status'], 30) || 'setup',
      draftOrderCount: Array.isArray(draftData['roundOneOrder']) ? draftData['roundOneOrder'].length : 0,
      draftScheduled: Boolean(draftData['scheduledStartAt']),
    };
  }));
}

async function snapshotFor(plan: PrivateSeasonPlan, build: PrivateSeasonBuildIdentity) {
  const evidence = await leagueEvidence(plan);
  return {
    plan,
    readiness: buildPrivateSeasonReadiness({ plan, liveLeagueEvidence: evidence, build }),
    policy: privateSeasonPolicy(),
    build,
  };
}
function hash(plan: PrivateSeasonPlan): string {
  return createHash('sha256').update(JSON.stringify(privateSeasonPlanHashInput(plan))).digest('hex');
}

export const getPrivateSeasonControlCenter = onCall(
  { region: FUNCTION_REGION, timeoutSeconds: 45, memory: '512MiB', maxInstances: 5, cors: TRUSTED_WEB_ORIGINS, invoker: 'public' },
  async (request) => {
    await requirePlatformAdmin(request.auth);
    const build = buildIdentity(request.data?.['build']);
    const stored = await db.doc(PLAN_PATH).get();
    return snapshotFor(planFromData(stored.data()), build);
  },
);

export const updatePrivateSeasonPlan = onCall(
  { region: FUNCTION_REGION, timeoutSeconds: 60, memory: '512MiB', maxInstances: 3, cors: TRUSTED_WEB_ORIGINS, invoker: 'public' },
  async (request) => {
    const adminId = await requirePlatformAdmin(request.auth, true);
    const input = record(request.data);
    const expectedRevision = revision(input['expectedRevision']);
    const auditReason = reason(input['reason']);
    const build = buildIdentity(input['build'], true);
    const reference = db.doc(PLAN_PATH);

    await db.runTransaction(async (transaction) => {
      const stored = await transaction.get(reference);
      const current = planFromData(stored.data());
      if (current.revision !== expectedRevision) {
        throw new HttpsError('aborted', 'The plan changed in another session. Refresh before saving.');
      }
      const requested = normalizePrivateSeasonPlan(input['plan']);
      const next: PrivateSeasonPlan = {
        ...requested,
        revision: current.revision + 1,
        status: requested.status === 'rehearsal' ? 'rehearsal' : 'planning',
        latestDecision: current.latestDecision,
        updatedAt: null,
        updatedBy: adminId,
      };
      transaction.set(reference, { ...next, updatedAt: FieldValue.serverTimestamp() });
      transaction.set(reference.collection('changes').doc(), {
        schemaVersion: 1, action: 'plan-updated', revision: next.revision, reason: auditReason,
        releaseLabel: build.releaseLabel, buildId: build.buildId,
        leagueCount: next.leagueSlots.filter((entry) => entry.active).length,
        testerCount: next.testers.length, planHash: hash(next), actorId: adminId, createdAt: FieldValue.serverTimestamp(),
      });
    });

    const stored = await reference.get();
    return snapshotFor(planFromData(stored.data()), build);
  },
);

export const recordPrivateSeasonGateDecision = onCall(
  { region: FUNCTION_REGION, timeoutSeconds: 60, memory: '512MiB', maxInstances: 3, cors: TRUSTED_WEB_ORIGINS, invoker: 'public' },
  async (request) => {
    const adminId = await requirePlatformAdmin(request.auth, true);
    const input = record(request.data);
    const expectedRevision = revision(input['expectedRevision']);
    const outcome: PrivateSeasonGateOutcome | null = input['outcome'] === 'approved' || input['outcome'] === 'delayed'
      ? input['outcome']
      : null;
    if (!outcome) throw new HttpsError('invalid-argument', 'Choose approved or delayed.');
    const auditReason = reason(input['reason']);
    const build = buildIdentity(input['build'], true);
    const reference = db.doc(PLAN_PATH);
    const before = planFromData((await reference.get()).data());
    if (before.revision !== expectedRevision) throw new HttpsError('aborted', 'Refresh before deciding.');
    const readiness = buildPrivateSeasonReadiness({ plan: before, liveLeagueEvidence: await leagueEvidence(before), build });
    if (outcome === 'approved' && !readiness.readyForApproval) {
      throw new HttpsError('failed-precondition', `Approval is blocked by ${readiness.blockers.length} stop-the-line item(s).`, { blockers: readiness.blockers });
    }

    await db.runTransaction(async (transaction) => {
      const stored = await transaction.get(reference);
      const current = planFromData(stored.data());
      if (current.revision !== expectedRevision) throw new HttpsError('aborted', 'Refresh before deciding.');
      const nextRevision = current.revision + 1;
      const decisionId = createHash('sha256')
        .update(`private-season:${adminId}:${nextRevision}:${outcome}:${Date.now()}`)
        .digest('hex').slice(0, 40);
      const decidedPlan: PrivateSeasonPlan = {
        ...current, revision: nextRevision, status: outcome, updatedAt: null, updatedBy: adminId,
      };
      const decision = {
        decisionId, gate: 'private-season' as const, outcome, reason: auditReason,
        planRevision: nextRevision, planHash: hash(decidedPlan), releaseLabel: build.releaseLabel,
        buildId: build.buildId, recordedAt: null, recordedBy: adminId,
      };
      transaction.set(reference, {
        ...decidedPlan,
        latestDecision: { ...decision, recordedAt: FieldValue.serverTimestamp() },
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(reference.collection('decisions').doc(decisionId), {
        ...decision, recordedAt: FieldValue.serverTimestamp(), actorId: adminId,
        readinessStatus: readiness.status, blockerCount: readiness.blockers.length,
        advisoryCount: readiness.advisories.length, liveLeagueEvidence: readiness.liveLeagueEvidence,
      });
    });

    const stored = await reference.get();
    return snapshotFor(planFromData(stored.data()), build);
  },
);
