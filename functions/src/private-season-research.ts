import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import { privateSeasonManagerHash } from './shared/core/operations/private-season-health.util';
import {
  buildPrivateSeasonMilestoneSummary,
  buildPrivateSeasonResearchSummary,
  normalizePrivateSeasonResearchAnswers,
  normalizePrivateSeasonResearchMilestone,
  normalizePrivateSeasonResearchResponse,
  privateSeasonResearchMilestoneAvailable,
  privateSeasonResearchMilestoneLabel,
  privateSeasonResearchMilestonePrompt,
  privateSeasonResearchResponseId,
  PRIVATE_SEASON_RESEARCH_MILESTONES,
  PRIVATE_SEASON_RESEARCH_PROJECTION_VERSION,
  PRIVATE_SEASON_RESEARCH_RELEASE_LABEL,
  PRIVATE_SEASON_RESEARCH_RESPONSE_LIMIT,
  PRIVATE_SEASON_RESEARCH_SCORING_VERSION,
  type PrivateSeasonResearchLeagueState,
  type PrivateSeasonResearchMilestone,
  type PrivateSeasonResearchResponse,
  type PrivateSeasonResearchRole,
} from './shared/core/operations/private-season-research.util';
import {
  emptyPrivateSeasonPlan,
  normalizePrivateSeasonPlan,
  type PrivateSeasonBuildIdentity,
  type PrivateSeasonPlan,
} from './shared/core/operations/private-season.util';
import { requireFirestoreDocumentId } from './shared/security/firestore-document-id.util';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const PLAN_PATH = 'platformOperations/privateSeason2026-27';
const CURRENT_BUILD_ID_PATTERN = /^release-candidate-56-[A-Za-z0-9._:-]{4,160}$/;
const RESPONSE_DAILY_LIMIT = 20;
const TRANSACTION_SCAN_LIMIT = 100;
const MANAGER_DAY_SCAN_LIMIT = 250;

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

function planFromData(data: DocumentData | undefined): PrivateSeasonPlan {
  if (!data) return emptyPrivateSeasonPlan();
  const latestDecision = record(data['latestDecision']);
  return normalizePrivateSeasonPlan({
    ...data,
    updatedAt: iso(data['updatedAt']),
    latestDecision: Object.keys(latestDecision).length > 0
      ? { ...latestDecision, recordedAt: iso(latestDecision['recordedAt']) }
      : null,
  });
}

function buildIdentity(value: unknown, requireDeployableBuild = false): PrivateSeasonBuildIdentity {
  const source = record(value);
  const build: PrivateSeasonBuildIdentity = {
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
    build.releaseLabel !== PRIVATE_SEASON_RESEARCH_RELEASE_LABEL ||
    !CURRENT_BUILD_ID_PATTERN.test(build.buildId) ||
    build.scoringRulesVersion !== PRIVATE_SEASON_RESEARCH_SCORING_VERSION ||
    build.projectionVersion !== PRIVATE_SEASON_RESEARCH_PROJECTION_VERSION
  ) {
    throw new HttpsError(
      'failed-precondition',
      'Refresh RinkRat. Tester research accepts only the current RC55 / Scoring V4 / Projection V11 build.',
    );
  }

  if (requireDeployableBuild && build.buildId.endsWith('-local')) {
    throw new HttpsError(
      'failed-precondition',
      'Open the deployed RC55 site before saving tester-season research.',
    );
  }

  return build;
}

async function requirePlatformAdmin(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
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

  return adminId;
}

function requireVerifiedManager(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined,
): string {
  const userId = requireFirestoreDocumentId(auth?.uid, 'manager ID', { maxBytes: 128 });
  if (auth?.token?.['email_verified'] !== true) {
    throw new HttpsError('failed-precondition', 'Verify your email before submitting tester feedback.');
  }
  return userId;
}

function timestampSortValue(value: unknown): number {
  const parsed = iso(value);
  return parsed ? Date.parse(parsed) : 0;
}

async function firstManagerRosterActionAt(
  leagueId: string,
  ownerId: string,
): Promise<string | null> {
  const snapshot = await db.collection(`leagues/${leagueId}/transactions`)
    .where('ownerId', '==', ownerId)
    .limit(TRANSACTION_SCAN_LIMIT)
    .get();
  const matching = snapshot.docs
    .map((document) => document.data())
    .filter((entry) => ROSTER_ACTION_TYPES.has(text(entry['type'], 50)))
    .sort((left, right) => timestampSortValue(left['createdAt']) - timestampSortValue(right['createdAt']))[0];
  return matching ? iso(matching['createdAt']) : null;
}

async function firstManagerGameCenterViewAt(
  leagueId: string,
  managerHash: string,
): Promise<string | null> {
  const snapshot = await db.doc(PLAN_PATH)
    .collection('leagueEngagement')
    .doc(leagueId)
    .collection('managerDays')
    .where('managerHash', '==', managerHash)
    .limit(MANAGER_DAY_SCAN_LIMIT)
    .get();
  const matching = snapshot.docs
    .map((document) => document.data())
    .filter((entry) => Array.isArray(entry['categories']) && entry['categories'].includes('game-center'))
    .sort((left, right) => text(left['dateKey'], 10).localeCompare(text(right['dateKey'], 10)))[0];
  if (!matching) return null;
  return iso(matching['firstSeenAt'])
    ?? (text(matching['dateKey'], 10) ? `${text(matching['dateKey'], 10)}T00:00:00.000Z` : null);
}

async function consumeResearchRateLimit(userId: string): Promise<void> {
  const reference = db.doc(`observabilityRateLimits/${userId}`);
  const dateKey = new Date().toISOString().slice(0, 10);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.data() ?? {};
    const storedDateKey = text(data['privateSeasonResearchDateKey'], 10);
    const storedCount = typeof data['privateSeasonResearchCount'] === 'number'
      ? Math.max(0, Math.round(data['privateSeasonResearchCount']))
      : 0;

    if (storedDateKey !== dateKey) {
      transaction.set(reference, {
        privateSeasonResearchDateKey: dateKey,
        privateSeasonResearchCount: 1,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    if (storedCount >= RESPONSE_DAILY_LIMIT) {
      throw new HttpsError('resource-exhausted', 'Tester-feedback update limit reached for today.');
    }

    transaction.set(reference, {
      privateSeasonResearchCount: storedCount + 1,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

function responseFromData(data: DocumentData | undefined): PrivateSeasonResearchResponse | null {
  if (!data) return null;
  return normalizePrivateSeasonResearchResponse({
    ...data,
    submittedAt: iso(data['submittedAt']),
    updatedAt: iso(data['updatedAt']),
  });
}

async function leagueEvidence(input: {
  userId: string;
  leagueId: string;
  leagueLabel: string;
  planStatus: string;
  nowMilliseconds: number;
}): Promise<{
  state: PrivateSeasonResearchLeagueState | null;
  eligibility: Record<PrivateSeasonResearchMilestone, boolean>;
}> {
  const leagueId = requireFirestoreDocumentId(input.leagueId, 'private-season league ID', {
    maxBytes: 128,
  });
  const planReference = db.doc(PLAN_PATH);
  const managerHash = privateSeasonManagerHash(input.userId, leagueId);
  const [member, league, draft, engagement, managerMatchupViewedAt, managerRosterActionAt, teams] = await Promise.all([
    db.doc(`leagues/${leagueId}/members/${input.userId}`).get(),
    db.doc(`leagues/${leagueId}`).get(),
    db.doc(`leagues/${leagueId}/draft/current`).get(),
    planReference.collection('leagueEngagement').doc(leagueId).get(),
    firstManagerGameCenterViewAt(leagueId, managerHash),
    firstManagerRosterActionAt(leagueId, input.userId),
    db.collection(`leagues/${leagueId}/teams`).limit(20).get(),
  ]);

  if (!member.exists || !league.exists) {
    return {
      state: null,
      eligibility: Object.fromEntries(
        PRIVATE_SEASON_RESEARCH_MILESTONES.map((milestone) => [milestone, false]),
      ) as Record<PrivateSeasonResearchMilestone, boolean>,
    };
  }

  const leagueData = league.data() ?? {};
  const memberData = member.data() ?? {};
  const draftData = draft.data() ?? {};
  const engagementData = engagement.data() ?? {};
  const teamCount = teams.size;
  const draftComplete = text(draftData['status'], 30) === 'complete';
  const leagueFirstMatchupViewedAt = iso(engagementData['firstMatchupViewedAt']);
  const activatedAt = teamCount >= 6 && draftComplete && leagueFirstMatchupViewedAt
    ? leagueFirstMatchupViewedAt
    : null;
  const role: PrivateSeasonResearchRole =
    text(leagueData['commissionerId'], 128) === input.userId ||
    text(memberData['role'], 30) === 'commissioner'
      ? 'commissioner'
      : 'manager';
  const responseSnapshots = await Promise.all(
    PRIVATE_SEASON_RESEARCH_MILESTONES.map((milestone) =>
      planReference.collection('researchResponses')
        .doc(privateSeasonResearchResponseId(input.userId, leagueId, milestone))
        .get()),
  );
  const responses = new Map<PrivateSeasonResearchMilestone, PrivateSeasonResearchResponse>();
  responseSnapshots.forEach((snapshot, index) => {
    const response = responseFromData(snapshot.data());
    if (response) responses.set(PRIVATE_SEASON_RESEARCH_MILESTONES[index], response);
  });
  const eligibility = {} as Record<PrivateSeasonResearchMilestone, boolean>;
  const milestones = PRIVATE_SEASON_RESEARCH_MILESTONES.map((milestone) => {
    const available = privateSeasonResearchMilestoneAvailable({
      milestone,
      draftComplete,
      firstMatchupViewedAt: managerMatchupViewedAt,
      firstRosterActionAt: managerRosterActionAt,
      activatedAt,
      planStatus: input.planStatus,
      nowMilliseconds: input.nowMilliseconds,
    });
    const response = responses.get(milestone) ?? null;
    eligibility[milestone] = available.available;
    return {
      milestone,
      label: privateSeasonResearchMilestoneLabel(milestone),
      prompt: privateSeasonResearchMilestonePrompt(milestone),
      availability: response ? 'submitted' as const : available.available ? 'available' as const : 'locked' as const,
      lockedReason: available.reason,
      response,
    };
  });

  return {
    state: {
      leagueId,
      leagueLabel: input.leagueLabel || text(leagueData['name'], 80) || 'Tester league',
      role,
      teamCount,
      milestones,
    },
    eligibility,
  };
}

async function managerSnapshot(
  userId: string,
  build: PrivateSeasonBuildIdentity,
): Promise<Record<string, unknown>> {
  const planSnapshot = await db.doc(PLAN_PATH).get();
  const plan = planFromData(planSnapshot.data());
  const activeSlots = plan.leagueSlots.filter((slot) => slot.active && slot.leagueId);
  const nowMilliseconds = Date.now();
  const evidence = await Promise.all(activeSlots.map((slot) => leagueEvidence({
    userId,
    leagueId: slot.leagueId,
    leagueLabel: slot.label,
    planStatus: plan.status,
    nowMilliseconds,
  }).catch(() => null)));
  const leagues = evidence
    .map((entry) => entry?.state ?? null)
    .filter((entry): entry is PrivateSeasonResearchLeagueState => Boolean(entry));

  return {
    generatedAt: new Date(nowMilliseconds).toISOString(),
    build,
    planStatus: plan.status,
    tracked: leagues.length > 0,
    privacyNote: 'Responses use a pseudonymous manager reference. Do not enter names, emails, phone numbers, medical details, or private incident evidence.',
    leagues,
  };
}

async function dashboardSnapshot(
  plan: PrivateSeasonPlan,
  build: PrivateSeasonBuildIdentity,
): Promise<Record<string, unknown>> {
  const activeSlots = plan.leagueSlots.filter((slot) => slot.active && slot.leagueId);
  const nowMilliseconds = Date.now();
  const [responseSnapshot, leagueEvidenceRows] = await Promise.all([
    db.doc(PLAN_PATH).collection('researchResponses').limit(PRIVATE_SEASON_RESEARCH_RESPONSE_LIMIT).get(),
    Promise.all(activeSlots.map(async (slot) => {
      const leagueId = requireFirestoreDocumentId(slot.leagueId, 'private-season league ID', {
        maxBytes: 128,
      });
      const [league, draft, engagement, teams] = await Promise.all([
        db.doc(`leagues/${leagueId}`).get(),
        db.doc(`leagues/${leagueId}/draft/current`).get(),
        db.doc(PLAN_PATH).collection('leagueEngagement').doc(leagueId).get(),
        db.collection(`leagues/${leagueId}/teams`).limit(20).get(),
      ]);
      const draftComplete = text(draft.data()?.['status'], 30) === 'complete';
      const firstMatchupViewedAt = iso(engagement.data()?.['firstMatchupViewedAt']);
      const activatedAt = teams.size >= 6 && draftComplete && firstMatchupViewedAt
        ? firstMatchupViewedAt
        : null;
      const managerEvidence = await Promise.all(teams.docs.map(async (team) => {
        const ownerId = requireFirestoreDocumentId(team.id, 'private-season manager ID', {
          maxBytes: 128,
        });
        const managerHash = privateSeasonManagerHash(ownerId, leagueId);
        const [matchupViewedAt, rosterActionAt] = await Promise.all([
          firstManagerGameCenterViewAt(leagueId, managerHash),
          firstManagerRosterActionAt(leagueId, ownerId),
        ]);
        return { matchupViewedAt, rosterActionAt };
      }));
      const datedAvailability = (milestone: PrivateSeasonResearchMilestone): boolean =>
        privateSeasonResearchMilestoneAvailable({
          milestone,
          draftComplete,
          firstMatchupViewedAt,
          firstRosterActionAt: null,
          activatedAt,
          planStatus: plan.status,
          nowMilliseconds,
        }).available;
      const eligibleCounts: Record<PrivateSeasonResearchMilestone, number> = {
        'after-join': teams.size,
        'after-draft': draftComplete ? teams.size : 0,
        'after-first-matchup': managerEvidence.filter((entry) => entry.matchupViewedAt).length,
        'after-first-transaction': managerEvidence.filter((entry) => entry.rosterActionAt).length,
        'week-4': datedAvailability('week-4') ? teams.size : 0,
        midseason: datedAvailability('midseason') ? teams.size : 0,
        'season-end': datedAvailability('season-end') ? teams.size : 0,
      };
      return {
        leagueId,
        leagueLabel: slot.label || text(league.data()?.['name'], 80) || 'Tester league',
        teamCount: teams.size,
        eligibleCounts,
      };
    })),
  ]);
  const responses = responseSnapshot.docs
    .map((document) => responseFromData(document.data()))
    .filter((response): response is PrivateSeasonResearchResponse => Boolean(response))
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''));
  const leagueSummaries = leagueEvidenceRows.map((league) => {
    const leagueResponses = responses.filter((response) => response.leagueId === league.leagueId);
    return {
      leagueId: league.leagueId,
      leagueLabel: league.leagueLabel,
      teamCount: league.teamCount,
      responseCount: leagueResponses.length,
      uniqueRespondentCount: new Set(leagueResponses.map((response) => response.managerHash)).size,
      milestones: PRIVATE_SEASON_RESEARCH_MILESTONES.map((milestone) =>
        buildPrivateSeasonMilestoneSummary({
          milestone,
          responses: leagueResponses,
          eligibleCount: league.eligibleCounts[milestone],
        })),
    };
  });

  return {
    generatedAt: new Date(nowMilliseconds).toISOString(),
    build,
    planStatus: plan.status,
    responseLimitReached: responseSnapshot.size >= PRIVATE_SEASON_RESEARCH_RESPONSE_LIMIT,
    summary: buildPrivateSeasonResearchSummary(responses),
    milestones: PRIVATE_SEASON_RESEARCH_MILESTONES.map((milestone) =>
      buildPrivateSeasonMilestoneSummary({
        milestone,
        responses,
        eligibleCount: leagueEvidenceRows.reduce(
          (sum, league) => sum + league.eligibleCounts[milestone],
          0,
        ),
      })),
    leagues: leagueSummaries,
    responses,
  };
}

export const getPrivateSeasonResearch = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<Record<string, unknown>> => {
    const userId = requireVerifiedManager(request.auth);
    const build = buildIdentity(request.data?.['build']);
    return managerSnapshot(userId, build);
  },
);

export const submitPrivateSeasonResearch = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 10,
    cors: TRUSTED_WEB_ORIGINS,
    invoker: 'public',
  },
  async (request): Promise<Record<string, unknown>> => {
    const userId = requireVerifiedManager(request.auth);
    const input = record(request.data);
    const build = buildIdentity(input['build'], true);
    const leagueId = requireFirestoreDocumentId(input['leagueId'], 'private-season league ID', {
      maxBytes: 128,
    });
    const milestone = normalizePrivateSeasonResearchMilestone(input['milestone']);
    const expectedRevision = integer(input['expectedRevision'], 0, 1_000_000);
    const answers = normalizePrivateSeasonResearchAnswers(input['answers']);

    if (!milestone || expectedRevision === null || !answers) {
      throw new HttpsError(
        'invalid-argument',
        'Complete the required tester-feedback fields and remove email addresses or phone numbers from free text.',
      );
    }

    const planReference = db.doc(PLAN_PATH);
    const [planSnapshot, memberSnapshot, leagueSnapshot] = await Promise.all([
      planReference.get(),
      db.doc(`leagues/${leagueId}/members/${userId}`).get(),
      db.doc(`leagues/${leagueId}`).get(),
    ]);
    const plan = planFromData(planSnapshot.data());
    const slot = plan.leagueSlots.find((candidate) => candidate.active && candidate.leagueId === leagueId);
    if (!slot) {
      throw new HttpsError('failed-precondition', 'This league is not part of the active tester-season cohort.');
    }
    if (!memberSnapshot.exists || !leagueSnapshot.exists) {
      throw new HttpsError('permission-denied', 'Tracked league membership is required.');
    }
    const evidence = await leagueEvidence({
      userId,
      leagueId,
      leagueLabel: slot.label,
      planStatus: plan.status,
      nowMilliseconds: Date.now(),
    });
    const evidenceState = evidence.state;
    if (!evidenceState || !evidence.eligibility[milestone]) {
      throw new HttpsError('failed-precondition', 'That milestone survey is not available yet.');
    }

    await consumeResearchRateLimit(userId);
    const managerHash = privateSeasonManagerHash(userId, leagueId);
    const responseId = privateSeasonResearchResponseId(userId, leagueId, milestone);
    const responseReference = planReference.collection('researchResponses').doc(responseId);
    const role: PrivateSeasonResearchRole = evidenceState.role;

    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(responseReference);
      const currentRevision = typeof current.data()?.['revision'] === 'number'
        ? Math.max(0, Math.round(current.data()?.['revision']))
        : 0;
      if (currentRevision !== expectedRevision) {
        throw new HttpsError('aborted', 'That response changed in another session. Refresh before saving.');
      }
      transaction.set(responseReference, {
        schemaVersion: 1,
        responseId,
        leagueId,
        leagueLabel: evidenceState.leagueLabel,
        managerHash,
        role,
        milestone,
        revision: currentRevision + 1,
        answers,
        releaseLabel: build.releaseLabel,
        buildId: build.buildId,
        submittedAt: current.exists && current.data()?.['submittedAt']
          ? current.data()?.['submittedAt']
          : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    return managerSnapshot(userId, build);
  },
);

export const getPrivateSeasonResearchDashboard = onCall(
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
    return dashboardSnapshot(planFromData(planSnapshot.data()), build);
  },
);

