import { createHash } from 'node:crypto';

import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { enforceAppCheckCallableCanaryForLeague } from './app-check-canary-authority';
import { db } from './shared/core/firebase';
import { FantasyDraft } from './shared/core/draft/draft.models';
import { getCycleRosterSlotPickDocumentId } from './shared/core/cycle/cycle.service';
import {
  getAnchoredRegularSeasonCycleCount,
  STANDARD_FULL_CYCLE_SEASON_COUNT,
} from './shared/core/playoffs/playoff-format';
import {
  createFutureMatchupLineupAssignmentHash,
  deriveFutureMatchupLineupPlanStatus,
  FUTURE_MATCHUP_LINEUP_SCHEMA_VERSION,
  FutureMatchupLineupPlan,
  FutureMatchupLineupSlot,
  getFutureMatchupLineupMaterializedSlotCount,
  normalizeFutureMatchupLineupPlan,
  RequestedFutureMatchupLineupSlot,
  validateFutureMatchupLineupSlots,
} from './shared/core/team/future-matchup-lineup.util';
import { FantasyRoster } from './shared/core/team/roster.models';
import { normalizeFantasyRoster } from './shared/core/team/roster.service';
import { DEFAULT_STARTING_ROSTER_SIZE } from './shared/core/team/roster-config';
import {
  requireFirestoreDocumentId,
} from './shared/security/firestore-document-id.util';
import {
  FIRESTORE_ASSET_KEY_OPTIONS,
  FIRESTORE_AUTH_USER_ID_OPTIONS,
  FIRESTORE_LEAGUE_ID_OPTIONS,
  FIRESTORE_REQUEST_ID_OPTIONS,
  FIRESTORE_ROSTER_SLOT_ID_OPTIONS,
} from './shared/security/firestore-document-id-policies';
import { TRUSTED_WEB_ORIGINS } from './web-security';

const FUNCTION_REGION = 'us-central1';
const FIRST_CYCLE_NUMBER = 1;
const MAX_FUTURE_MATCHUP_PLAN_COUNT = STANDARD_FULL_CYCLE_SEASON_COUNT - 2;
const MAX_MUTATION_RECEIPTS_PER_CYCLE = 64;

type FutureLineupOperation = 'list' | 'save' | 'clear';

interface FutureMatchupLineupPlanSlotView {
  rosterSlotId: string;
  assetKey: string | null;
  resolution: FutureMatchupLineupSlot['resolution'];
  resolvedAssetKey?: string | null;
  reason?: string;
  resolvedAtMs?: number;
}

export interface FutureMatchupLineupPlanView {
  ownerId: string;
  cycleNumber: number;
  revision: number;
  status: FutureMatchupLineupPlan['status'];
  slots: FutureMatchupLineupPlanSlotView[];
  materializedSlotCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}

type ManageFutureMatchupLineupsResult =
  | { operation: 'list'; plans: FutureMatchupLineupPlanView[] }
  | { operation: 'save'; plan: FutureMatchupLineupPlanView }
  | {
      operation: 'clear';
      plan: null;
      clearedCycleNumber: number;
      revision: number;
    };

interface MutationReceipt {
  requestIdHash: string;
  requestHash: string;
  response: ManageFutureMatchupLineupsResult;
}

interface MutationState {
  latestRevision: number;
  receipts: MutationReceipt[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asOperation(value: unknown): FutureLineupOperation | null {
  return value === 'list' || value === 'save' || value === 'clear'
    ? value
    : null;
}

function requireCycleNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new HttpsError('invalid-argument', 'Choose a valid matchup number.');
  }

  return value;
}

function requireExpectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpsError(
      'invalid-argument',
      'The current lineup-plan revision is required.',
    );
  }

  return value;
}

function timestampMilliseconds(value: unknown): number | null {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const timestamp = value as {
    toMillis?: () => number;
    seconds?: number;
    nanoseconds?: number;
  };

  if (typeof timestamp.toMillis === 'function') {
    try {
      return timestamp.toMillis();
    } catch {
      return null;
    }
  }

  return typeof timestamp.seconds === 'number'
    ? timestamp.seconds * 1000 + (timestamp.nanoseconds ?? 0) / 1_000_000
    : null;
}

function planView(plan: FutureMatchupLineupPlan): FutureMatchupLineupPlanView {
  return {
    ownerId: plan.ownerId,
    cycleNumber: plan.cycleNumber,
    revision: plan.revision,
    status: plan.status,
    slots: plan.slots.map((slot) => ({
      rosterSlotId: slot.rosterSlotId,
      assetKey: slot.assetKey,
      resolution: slot.resolution,
      ...(slot.resolution !== 'planned'
        ? { resolvedAssetKey: slot.resolvedAssetKey ?? null }
        : {}),
      ...(slot.reason ? { reason: slot.reason } : {}),
      ...(timestampMilliseconds(slot.resolvedAt) !== null
        ? { resolvedAtMs: timestampMilliseconds(slot.resolvedAt)! }
        : {}),
    })),
    materializedSlotCount: getFutureMatchupLineupMaterializedSlotCount(plan),
    createdAtMs: timestampMilliseconds(plan.createdAt) ?? 0,
    updatedAtMs: timestampMilliseconds(plan.updatedAt) ?? 0,
  };
}

function requireSavedPlan(input: {
  value: unknown;
  ownerId: string;
  cycleNumber?: number;
  documentId?: string;
}): FutureMatchupLineupPlan {
  const plan = normalizeFutureMatchupLineupPlan(input.value);
  if (
    !plan ||
    plan.ownerId !== input.ownerId ||
    (input.cycleNumber !== undefined && plan.cycleNumber !== input.cycleNumber) ||
    (input.documentId !== undefined && input.documentId !== `cycle-${plan.cycleNumber}`)
  ) {
    throw new HttpsError(
      'failed-precondition',
      'A saved lineup plan has invalid authority evidence and needs support review.',
      { reason: 'plan-state-invalid' },
    );
  }

  return plan;
}

function requireSavedTargetPickAssetKey(input: {
  value: unknown;
  ownerId: string;
  rosterSlotId: string;
}): string {
  const pick = asRecord(input.value);
  const asset = asRecord(pick['asset']);
  let assetKey = '';

  try {
    assetKey = requireFirestoreDocumentId(
      asset['assetKey'],
      'saved target-pick asset',
      FIRESTORE_ASSET_KEY_OPTIONS,
    );
  } catch {
    // Recast malformed persisted authority as a server-state failure rather
    // than reporting invalid caller input.
  }

  if (
    !assetKey ||
    pick['ownerId'] !== input.ownerId ||
    pick['rosterSlotId'] !== input.rosterSlotId
  ) {
    throw new HttpsError(
      'failed-precondition',
      'A materialized lineup slot has invalid target-pick evidence and needs support review.',
      { reason: 'target-pick-state-invalid' },
    );
  }

  return assetKey;
}

function getPlanRef(leagueId: string, ownerId: string, cycleNumber: number) {
  return db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans/cycle-${cycleNumber}`,
  );
}

function getMutationStateRef(
  leagueId: string,
  ownerId: string,
  cycleNumber: number,
) {
  return db.doc(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlanMutationState/cycle-${cycleNumber}`,
  );
}

function requestIdHash(requestId: string): string {
  return createHash('sha256')
    .update(`future-matchup-lineup:${requestId}`)
    .digest('hex');
}

function mutationResponseRevision(value: unknown): number | null {
  const response = asRecord(value);
  const revision = response['operation'] === 'save'
    ? asRecord(response['plan'])['revision']
    : response['operation'] === 'clear'
      ? response['revision']
      : null;

  return typeof revision === 'number' &&
    Number.isSafeInteger(revision) &&
    revision > 0
    ? revision
    : null;
}

function mutationState(value: unknown): MutationState {
  if (value === undefined) {
    return { latestRevision: 0, receipts: [] };
  }

  const data = asRecord(value);
  const receipts = Array.isArray(data['receipts']) ? data['receipts'] : null;
  const latestRevision = data['latestRevision'];
  if (
    data['schemaVersion'] !== 1 ||
    typeof latestRevision !== 'number' ||
    !Number.isSafeInteger(latestRevision) ||
    latestRevision < 0 ||
    !receipts ||
    receipts.length > MAX_MUTATION_RECEIPTS_PER_CYCLE
  ) {
    throw new HttpsError(
      'failed-precondition',
      'The saved lineup mutation state is invalid and needs support review.',
      { reason: 'lineup-mutation-state-invalid' },
    );
  }

  const normalized = receipts.map((source) => {
    const receipt = asRecord(source);
    const savedRequestIdHash = receipt['requestIdHash'];
    const savedRequestHash = receipt['requestHash'];
    const response = receipt['response'];
    if (
      typeof savedRequestIdHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(savedRequestIdHash) ||
      typeof savedRequestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(savedRequestHash) ||
      !response ||
      typeof response !== 'object' ||
      Array.isArray(response)
    ) {
      throw new HttpsError(
        'failed-precondition',
        'The saved lineup mutation state is invalid and needs support review.',
        { reason: 'lineup-mutation-state-invalid' },
      );
    }

    return {
      requestIdHash: savedRequestIdHash,
      requestHash: savedRequestHash,
      response: response as ManageFutureMatchupLineupsResult,
    };
  });

  if (new Set(normalized.map((receipt) => receipt.requestIdHash)).size !== normalized.length) {
    throw new HttpsError(
      'failed-precondition',
      'The saved lineup mutation state is invalid and needs support review.',
      { reason: 'lineup-mutation-state-invalid' },
    );
  }

  const receiptRevisions = normalized.map(({ response }) =>
    mutationResponseRevision(response),
  );
  const maxReceiptRevision = receiptRevisions.reduce<number>(
    (maximum, revision) => Math.max(maximum, revision ?? 0),
    0,
  );
  if (
    receiptRevisions.some((revision) => revision === null) ||
    (receiptRevisions.length === 0
      ? latestRevision !== 0
      : maxReceiptRevision !== latestRevision)
  ) {
    throw new HttpsError(
      'failed-precondition',
      'The saved lineup mutation state is invalid and needs support review.',
      { reason: 'lineup-mutation-state-invalid' },
    );
  }

  return { latestRevision, receipts: normalized };
}

function existingMutationResponse(input: {
  receipts: MutationReceipt[];
  requestIdHash: string;
  requestHash: string;
}): ManageFutureMatchupLineupsResult | null {
  const receipt = input.receipts.find(
    (candidate) => candidate.requestIdHash === input.requestIdHash,
  );
  if (!receipt) {
    if (input.receipts.length >= MAX_MUTATION_RECEIPTS_PER_CYCLE) {
      throw new HttpsError(
        'resource-exhausted',
        'This matchup lineup has reached its safe edit limit.',
        { reason: 'lineup-mutation-limit-exceeded' },
      );
    }
    return null;
  }

  if (receipt.requestHash !== input.requestHash) {
    throw new HttpsError(
      'already-exists',
      'That request ID was already used for a different lineup change.',
      { reason: 'request-id-reused' },
    );
  }

  return receipt.response;
}

function getTargetPickRef(
  leagueId: string,
  cycleNumber: number,
  ownerId: string,
  rosterSlotId: string,
) {
  const documentId = getCycleRosterSlotPickDocumentId(ownerId, rosterSlotId);

  return db.doc(
    `leagues/${leagueId}/cycles/cycle-${cycleNumber}/rosterPicks/${documentId}`,
  );
}

function requireRequestedSlots(value: unknown): RequestedFutureMatchupLineupSlot[] {
  if (!Array.isArray(value)) {
    throw new HttpsError(
      'invalid-argument',
      'A complete active-lineup assignment is required.',
    );
  }
  if (value.length > DEFAULT_STARTING_ROSTER_SIZE) {
    throw new HttpsError(
      'invalid-argument',
      `A future lineup may contain at most ${DEFAULT_STARTING_ROSTER_SIZE} active slots.`,
    );
  }

  return value.map((source, index) => {
    const data = asRecord(source);
    const rosterSlotId = requireFirestoreDocumentId(
      data['rosterSlotId'],
      `lineup slot ${index + 1}`,
      FIRESTORE_ROSTER_SLOT_ID_OPTIONS,
    );
    const assetKey = data['assetKey'] === null
      ? null
      : requireFirestoreDocumentId(
          data['assetKey'],
          `lineup asset ${index + 1}`,
          FIRESTORE_ASSET_KEY_OPTIONS,
        );

    return { rosterSlotId, assetKey };
  });
}

function mutationRequestHash(input: {
  leagueId: string;
  ownerId: string;
  operation: 'save' | 'clear';
  cycleNumber: number;
  expectedRevision: number;
  assignmentHash?: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function listPlans(
  leagueId: string,
  ownerId: string,
): Promise<ManageFutureMatchupLineupsResult> {
  const snapshots = await db.collection(
    `leagues/${leagueId}/teams/${ownerId}/lineupPlans`,
  ).limit(MAX_FUTURE_MATCHUP_PLAN_COUNT + 1).get();
  if (snapshots.size > MAX_FUTURE_MATCHUP_PLAN_COUNT) {
    throw new HttpsError(
      'failed-precondition',
      'The saved lineup-plan set is unexpectedly large and needs support review.',
      { reason: 'lineup-plan-limit-exceeded' },
    );
  }
  const plans = snapshots.docs
    .map((snapshot) => requireSavedPlan({
      value: snapshot.data(),
      ownerId,
      documentId: snapshot.id,
    }))
    .sort((first, second) => first.cycleNumber - second.cycleNumber);

  return {
    operation: 'list',
    plans: plans.map((plan) => planView(plan)),
  };
}

async function requireOwnerPreconditions(
  leagueId: string,
  ownerId: string,
): Promise<{
  roster: FantasyRoster;
  regularSeasonCycleCount: number;
}> {
  const [
    teamSnapshot,
    memberSnapshot,
    rosterSnapshot,
    draftSnapshot,
    replaySnapshot,
    teams,
  ] =
    await Promise.all([
      db.doc(`leagues/${leagueId}/teams/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/members/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
      db.doc(`leagues/${leagueId}/draft/current`).get(),
      db.doc(`leagues/${leagueId}/historicalReplay/control`).get(),
      db.collection(`leagues/${leagueId}/teams`).get(),
    ]);

  if (
    !teamSnapshot.exists ||
    teamSnapshot.data()?.['ownerId'] !== ownerId ||
    !memberSnapshot.exists
  ) {
    throw new HttpsError(
      'permission-denied',
      'You do not own a team in this league.',
    );
  }

  if (!rosterSnapshot.exists) {
    throw new HttpsError(
      'failed-precondition',
      'Your authoritative roster is unavailable.',
      { reason: 'roster-unavailable' },
    );
  }

  if (!draftSnapshot.exists || (draftSnapshot.data() as FantasyDraft).status !== 'complete') {
    throw new HttpsError(
      'failed-precondition',
      'Finish the draft before planning future matchup lineups.',
      { reason: 'draft-incomplete' },
    );
  }

  if (replaySnapshot.exists && replaySnapshot.data()?.['enabled'] === true) {
    throw new HttpsError(
      'failed-precondition',
      'Future matchup lineups are unavailable during historical replay.',
      { reason: 'historical-replay-active' },
    );
  }

  const draft = draftSnapshot.data() as FantasyDraft;
  const initialNhlBlockNumber =
    typeof draft.initialNhlBlockNumber === 'number' &&
    Number.isSafeInteger(draft.initialNhlBlockNumber) &&
    draft.initialNhlBlockNumber > 0
      ? draft.initialNhlBlockNumber
      : FIRST_CYCLE_NUMBER;
  let regularSeasonCycleCount: number;

  try {
    regularSeasonCycleCount = getAnchoredRegularSeasonCycleCount(
      teams.size,
      initialNhlBlockNumber,
    );
  } catch (error: unknown) {
    throw new HttpsError(
      'failed-precondition',
      error instanceof Error ? error.message : 'The season schedule is unavailable.',
      { reason: 'season-schedule-unavailable' },
    );
  }

  return {
    roster: normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>),
    regularSeasonCycleCount,
  };
}

function assertFutureRegularSeasonCycle(
  cycleNumber: number,
  regularSeasonCycleCount: number,
): void {
  if (cycleNumber <= FIRST_CYCLE_NUMBER) {
    throw new HttpsError(
      'failed-precondition',
      'Only a future regular-season matchup may be planned.',
      { reason: 'cycle-started' },
    );
  }

  if (cycleNumber > regularSeasonCycleCount) {
    throw new HttpsError(
      'failed-precondition',
      'Playoff lineup planning is not supported by this contract.',
      { reason: 'playoffs-not-supported' },
    );
  }

}

async function savePlan(input: {
  leagueId: string;
  ownerId: string;
  cycleNumber: number;
  expectedRevision: number;
  requestId: string;
  requestedSlots: RequestedFutureMatchupLineupSlot[];
  roster: FantasyRoster;
}): Promise<ManageFutureMatchupLineupsResult> {
  const requestedSlots = [...input.requestedSlots].sort(
    (first, second) => first.rosterSlotId.localeCompare(second.rosterSlotId),
  );
  const preflightActiveSlotIds = new Set(
    input.roster.activeSlots.map((slot) => slot.slotId),
  );
  const requestedSlotIds = new Set(
    requestedSlots.map((slot) => slot.rosterSlotId),
  );
  if (
    requestedSlots.length !== preflightActiveSlotIds.size ||
    requestedSlotIds.size !== requestedSlots.length ||
    requestedSlots.some(
      (slot) => !preflightActiveSlotIds.has(slot.rosterSlotId),
    )
  ) {
    throw new HttpsError(
      'invalid-argument',
      'The lineup assignment must contain every current active roster slot exactly once.',
      { reason: 'invalid-lineup-slots' },
    );
  }
  // The submitted snapshot can contain resolved assets for immutable slots.
  // Keep this request hash separate from the persisted assignment hash, which
  // always represents the manager's original desired assignment for those
  // already-resolved slots.
  const submittedAssignmentHash =
    createFutureMatchupLineupAssignmentHash(requestedSlots);
  const requestHash = mutationRequestHash({
    leagueId: input.leagueId,
    ownerId: input.ownerId,
    operation: 'save',
    cycleNumber: input.cycleNumber,
    expectedRevision: input.expectedRevision,
    assignmentHash: submittedAssignmentHash,
  });
  const planRef = getPlanRef(input.leagueId, input.ownerId, input.cycleNumber);
  const mutationStateRef = getMutationStateRef(
    input.leagueId,
    input.ownerId,
    input.cycleNumber,
  );
  const savedRequestIdHash = requestIdHash(input.requestId);
  const rosterRef = db.doc(
    `leagues/${input.leagueId}/teams/${input.ownerId}/roster/current`,
  );
  const targetCycleRef = db.doc(
    `leagues/${input.leagueId}/cycles/cycle-${input.cycleNumber}`,
  );
  const precedingCycleRef = db.doc(
    `leagues/${input.leagueId}/cycles/cycle-${input.cycleNumber - 1}`,
  );
  const teamRef = db.doc(
    `leagues/${input.leagueId}/teams/${input.ownerId}`,
  );
  const memberRef = db.doc(
    `leagues/${input.leagueId}/members/${input.ownerId}`,
  );
  const draftRef = db.doc(`leagues/${input.leagueId}/draft/current`);
  const replayRef = db.doc(
    `leagues/${input.leagueId}/historicalReplay/control`,
  );
  const siblingPlansQuery = db.collection(
    `leagues/${input.leagueId}/teams/${input.ownerId}/lineupPlans`,
  ).limit(MAX_FUTURE_MATCHUP_PLAN_COUNT + 1);
  const latestCycleQuery = db.collection(
    `leagues/${input.leagueId}/cycles`,
  ).orderBy('cycleNumber', 'desc').limit(1);
  const targetPickRefs = requestedSlots.map((slot) =>
    getTargetPickRef(
      input.leagueId,
      input.cycleNumber,
      input.ownerId,
      slot.rosterSlotId,
    ),
  );
  const mutationAt = Timestamp.now();

  return db.runTransaction(async (transaction) => {
    const documentSnapshots = await Promise.all([
        transaction.get(mutationStateRef),
        transaction.get(planRef),
        transaction.get(rosterRef),
        transaction.get(targetCycleRef),
        transaction.get(precedingCycleRef),
        transaction.get(teamRef),
        transaction.get(memberRef),
        transaction.get(draftRef),
        transaction.get(replayRef),
        ...targetPickRefs.map((reference) => transaction.get(reference)),
      ]);
    const [
      mutationStateSnapshot,
      planSnapshot,
      rosterSnapshot,
      targetCycleSnapshot,
      precedingCycleSnapshot,
      teamSnapshot,
      memberSnapshot,
      draftSnapshot,
      replaySnapshot,
      ...pickSnapshots
    ] = documentSnapshots;
    const [siblingPlansSnapshot, latestCyclesSnapshot] = await Promise.all([
      transaction.get(siblingPlansQuery),
      transaction.get(latestCycleQuery),
    ]);

    if (
      !teamSnapshot.exists ||
      teamSnapshot.data()?.['ownerId'] !== input.ownerId ||
      !memberSnapshot.exists
    ) {
      throw new HttpsError(
        'permission-denied',
        'You do not own a team in this league.',
      );
    }

    const savedMutationState = mutationState(
      mutationStateSnapshot.exists ? mutationStateSnapshot.data() : undefined,
    );
    const existingResponse = existingMutationResponse({
      receipts: savedMutationState.receipts,
      requestIdHash: savedRequestIdHash,
      requestHash,
    });
    if (existingResponse) {
      return existingResponse;
    }

    if (!draftSnapshot.exists || draftSnapshot.data()?.['status'] !== 'complete') {
      throw new HttpsError(
        'failed-precondition',
        'Finish the draft before planning future matchup lineups.',
        { reason: 'draft-incomplete' },
      );
    }

    const latestCycleSnapshot = latestCyclesSnapshot.docs[0];
    if (!latestCycleSnapshot) {
      throw new HttpsError(
        'failed-precondition',
        'The current matchup authority is unavailable.',
        { reason: 'cycle-state-invalid' },
      );
    }
    const latestCycleNumber = latestCycleSnapshot.data()?.['cycleNumber'];
    const latestCyclePhase = latestCycleSnapshot.data()?.['phase'];
    const latestCycleStatus = latestCycleSnapshot.data()?.['status'];
    if (
      typeof latestCycleNumber !== 'number' ||
      !Number.isSafeInteger(latestCycleNumber) ||
      latestCycleNumber < FIRST_CYCLE_NUMBER ||
      latestCycleSnapshot.id !== `cycle-${latestCycleNumber}` ||
      (latestCyclePhase !== 'regular_season' && latestCyclePhase !== 'playoffs') ||
      (latestCycleStatus !== 'active' && latestCycleStatus !== 'complete')
    ) {
      throw new HttpsError(
        'failed-precondition',
        'The latest matchup authority is malformed and needs support review.',
        { reason: 'cycle-state-invalid' },
      );
    }

    if (replaySnapshot.exists && replaySnapshot.data()?.['enabled'] === true) {
      throw new HttpsError(
        'failed-precondition',
        'Future matchup lineups are unavailable during historical replay.',
        { reason: 'historical-replay-active' },
      );
    }

    if (siblingPlansSnapshot.size > MAX_FUTURE_MATCHUP_PLAN_COUNT) {
      throw new HttpsError(
        'failed-precondition',
        'The saved lineup-plan set is unexpectedly large and needs support review.',
        { reason: 'lineup-plan-limit-exceeded' },
      );
    }

    if (!rosterSnapshot.exists) {
      throw new HttpsError(
        'failed-precondition',
        'Your authoritative roster is unavailable.',
        { reason: 'roster-unavailable' },
      );
    }

    const savedRoster = normalizeFantasyRoster(
      rosterSnapshot.data() as Partial<FantasyRoster>,
    );
    if (savedRoster.activeSlots.some((slot) => Boolean(slot.pendingMove))) {
      throw new HttpsError(
        'failed-precondition',
        'Resolve the current pending roster move before saving future lineups.',
        { reason: 'pending-roster-move' },
      );
    }

    const savedTargetPickAssetKeys = pickSnapshots.map((snapshot, index) =>
      snapshot?.exists
        ? requireSavedTargetPickAssetKey({
            value: snapshot.data(),
            ownerId: input.ownerId,
            rosterSlotId: requestedSlots[index].rosterSlotId,
          })
        : null,
    );

    const existingPlan = planSnapshot.exists
      ? requireSavedPlan({
          value: planSnapshot.data(),
          ownerId: input.ownerId,
          cycleNumber: input.cycleNumber,
          documentId: planSnapshot.id,
        })
      : null;
    if (existingPlan && savedMutationState.latestRevision !== existingPlan.revision) {
      throw new HttpsError(
        'failed-precondition',
        'The saved lineup mutation state does not match the lineup plan.',
        { reason: 'lineup-mutation-state-invalid' },
      );
    }
    const currentRevision = existingPlan?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      throw new HttpsError(
        'aborted',
        'This lineup plan changed in another session.',
        {
          reason: 'revision-conflict',
          currentRevision,
          plan: existingPlan
            ? planView(existingPlan)
            : null,
        },
      );
    }

    if (targetCycleSnapshot.exists) {
      const phase = targetCycleSnapshot.data()?.['phase'];
      const status = targetCycleSnapshot.data()?.['status'];
      if (phase === 'playoffs') {
        throw new HttpsError(
          'failed-precondition',
          'Playoff lineup planning is not supported by this contract.',
          { reason: 'playoffs-not-supported' },
        );
      }
      if (status === 'complete') {
        throw new HttpsError(
          'failed-precondition',
          'That matchup is already complete.',
          { reason: 'cycle-started' },
        );
      }
      if (
        status !== 'active' ||
        !precedingCycleSnapshot.exists ||
        precedingCycleSnapshot.data()?.['status'] !== 'active'
      ) {
        throw new HttpsError(
          'failed-precondition',
          'That lineup boundary is already open and no earlier matchup can materialize a new assignment.',
          { reason: 'cycle-started' },
        );
      }
    } else {
      if (latestCyclePhase === 'playoffs') {
        throw new HttpsError(
          'failed-precondition',
          'Playoff lineup planning is not supported by this contract.',
          { reason: 'playoffs-not-supported' },
        );
      }
      if (latestCycleNumber >= input.cycleNumber) {
        throw new HttpsError(
          'failed-precondition',
          'That matchup is no longer available for future lineup planning.',
          { reason: 'cycle-started' },
        );
      }
    }

    const existingSlotById = new Map(
      existingPlan?.slots.map((slot) => [slot.rosterSlotId, slot] as const) ?? [],
    );
    const lockedSlotIds: string[] = [];
    const lockedRosterSlotIds = new Set<string>();
    requestedSlots.forEach((slot, index) => {
      const existingSlot = existingSlotById.get(slot.rosterSlotId);
      const pickSnapshot = pickSnapshots[index];
      const pickAssetKey = savedTargetPickAssetKeys[index];
      const existingWasMaterialized =
        existingSlot !== undefined && existingSlot.resolution !== 'planned';

      if (pickSnapshot?.exists || existingWasMaterialized) {
        lockedRosterSlotIds.add(slot.rosterSlotId);
        const existingHasResolvedAssetKey = Boolean(
          existingWasMaterialized &&
          existingSlot &&
          Object.prototype.hasOwnProperty.call(
            existingSlot,
            'resolvedAssetKey',
          ),
        );
        const resolvedAssetKey = existingHasResolvedAssetKey
          ? existingSlot?.resolvedAssetKey ?? null
          : existingSlot?.assetKey ?? null;
        if (
          pickSnapshot?.exists &&
          existingWasMaterialized &&
          existingHasResolvedAssetKey &&
          pickAssetKey !== resolvedAssetKey
        ) {
          throw new HttpsError(
            'failed-precondition',
            'A resolved lineup slot does not match its authoritative target pick.',
            { reason: 'plan-state-invalid', rosterSlotId: slot.rosterSlotId },
          );
        }
        const lockedAssetKey = pickSnapshot?.exists
          ? pickAssetKey
          : resolvedAssetKey;
        const submittedOriginalDesiredAsset =
          existingSlot !== undefined && slot.assetKey === existingSlot.assetKey;
        if (slot.assetKey !== lockedAssetKey && !submittedOriginalDesiredAsset) {
          lockedSlotIds.push(slot.rosterSlotId);
        }
      }
    });

    if (lockedSlotIds.length > 0) {
      throw new HttpsError(
        'failed-precondition',
        'A lineup boundary has already materialized for one or more slots; locked assignments cannot be replanned.',
        { reason: 'cycle-started', lockedSlotIds },
      );
    }

    let normalizedSlots: RequestedFutureMatchupLineupSlot[];
    try {
      normalizedSlots = validateFutureMatchupLineupSlots(
        savedRoster,
        requestedSlots,
        {
          lockedRosterSlotIds,
          targetCycleNumber: input.cycleNumber,
        },
      );
    } catch (error: unknown) {
      throw new HttpsError(
        'aborted',
        'Your roster changed while the lineup plan was being saved.',
        {
          reason: 'roster-revision-conflict',
          message: error instanceof Error ? error.message : undefined,
        },
      );
    }

    const slots: FutureMatchupLineupSlot[] = normalizedSlots.map((slot, index) => {
      const existingSlot = existingSlotById.get(slot.rosterSlotId);
      const pickAssetKey = savedTargetPickAssetKeys[index];

      if (lockedRosterSlotIds.has(slot.rosterSlotId)) {
        return existingSlot
          ? existingSlot.resolution !== 'planned'
            ? {
                ...existingSlot,
                ...(Object.prototype.hasOwnProperty.call(
                  existingSlot,
                  'resolvedAssetKey',
                )
                  ? {}
                  : { resolvedAssetKey: pickAssetKey ?? existingSlot.assetKey }),
              }
            : {
                ...existingSlot,
                resolution:
                  pickAssetKey === existingSlot.assetKey
                    ? 'unchanged' as const
                    : 'conflict' as const,
                resolvedAssetKey: pickAssetKey,
                reason:
                  pickAssetKey === existingSlot.assetKey
                    ? null
                    : 'target-window-already-materialized' as const,
                resolvedAt: mutationAt,
              }
          : {
              rosterSlotId: slot.rosterSlotId,
              assetKey: pickAssetKey,
              resolution: 'unchanged',
              resolvedAssetKey: pickAssetKey,
              resolvedAt: mutationAt,
            };
      }

      return {
        rosterSlotId: slot.rosterSlotId,
        assetKey: slot.assetKey,
        resolution: 'planned',
      };
    });

    const requestedSlotByAssetKey = new Map(
      slots.flatMap((slot) =>
        slot.assetKey && !lockedRosterSlotIds.has(slot.rosterSlotId)
          ? [[slot.assetKey, slot.rosterSlotId] as const]
          : [],
      ),
    );
    for (const siblingSnapshot of siblingPlansSnapshot.docs) {
      if (siblingSnapshot.ref.path === planRef.path) {
        continue;
      }
      const siblingPlan = requireSavedPlan({
        value: siblingSnapshot.data(),
        ownerId: input.ownerId,
        documentId: siblingSnapshot.id,
      });
      for (const siblingSlot of siblingPlan.slots) {
        if (!siblingSlot.assetKey || siblingSlot.resolution !== 'planned') {
          continue;
        }
        const requestedSlotId = requestedSlotByAssetKey.get(
          siblingSlot.assetKey,
        );
        if (requestedSlotId && requestedSlotId !== siblingSlot.rosterSlotId) {
          throw new HttpsError(
            'failed-precondition',
            'The same asset cannot be reserved for different persistent slots across matchup plans.',
            {
              reason: 'cross-cycle-asset-conflict',
              assetKey: siblingSlot.assetKey,
              requestedRosterSlotId: requestedSlotId,
              reservedRosterSlotId: siblingSlot.rosterSlotId,
              reservedCycleNumber: siblingPlan.cycleNumber,
            },
          );
        }
      }
    }

    const revision = savedMutationState.latestRevision + 1;
    const assignmentHash = createFutureMatchupLineupAssignmentHash(slots);
    const plan: FutureMatchupLineupPlan = {
      schemaVersion: FUTURE_MATCHUP_LINEUP_SCHEMA_VERSION,
      ownerId: input.ownerId,
      cycleNumber: input.cycleNumber,
      revision,
      status: deriveFutureMatchupLineupPlanStatus(slots),
      assignmentHash,
      slots,
      createdAt: existingPlan?.createdAt ?? mutationAt,
      updatedAt: mutationAt,
    };
    const response: ManageFutureMatchupLineupsResult = {
      operation: 'save',
      plan: planView(plan),
    };

    transaction.set(planRef, plan);
    transaction.set(mutationStateRef, {
      schemaVersion: 1,
      latestRevision: revision,
      receipts: [
        ...savedMutationState.receipts,
        { requestIdHash: savedRequestIdHash, requestHash, response },
      ],
      updatedAt: mutationAt,
    });

    return response;
  });
}

async function clearPlan(input: {
  leagueId: string;
  ownerId: string;
  cycleNumber: number;
  expectedRevision: number;
  requestId: string;
}): Promise<ManageFutureMatchupLineupsResult> {
  const requestHash = mutationRequestHash({
    leagueId: input.leagueId,
    ownerId: input.ownerId,
    operation: 'clear',
    cycleNumber: input.cycleNumber,
    expectedRevision: input.expectedRevision,
  });
  const planRef = getPlanRef(input.leagueId, input.ownerId, input.cycleNumber);
  const mutationStateRef = getMutationStateRef(
    input.leagueId,
    input.ownerId,
    input.cycleNumber,
  );
  const savedRequestIdHash = requestIdHash(input.requestId);
  const teamRef = db.doc(`leagues/${input.leagueId}/teams/${input.ownerId}`);
  const memberRef = db.doc(`leagues/${input.leagueId}/members/${input.ownerId}`);
  const draftRef = db.doc(`leagues/${input.leagueId}/draft/current`);
  const targetCycleRef = db.doc(
    `leagues/${input.leagueId}/cycles/cycle-${input.cycleNumber}`,
  );
  const replayRef = db.doc(
    `leagues/${input.leagueId}/historicalReplay/control`,
  );
  const mutationAt = Timestamp.now();

  return db.runTransaction(async (transaction) => {
    const [
      mutationStateSnapshot,
      planSnapshot,
      teamSnapshot,
      memberSnapshot,
      draftSnapshot,
      targetCycleSnapshot,
      replaySnapshot,
    ] = await Promise.all([
      transaction.get(mutationStateRef),
      transaction.get(planRef),
      transaction.get(teamRef),
      transaction.get(memberRef),
      transaction.get(draftRef),
      transaction.get(targetCycleRef),
      transaction.get(replayRef),
    ]);

    if (
      !teamSnapshot.exists ||
      teamSnapshot.data()?.['ownerId'] !== input.ownerId ||
      !memberSnapshot.exists
    ) {
      throw new HttpsError(
        'permission-denied',
        'You do not own a team in this league.',
      );
    }

    const savedMutationState = mutationState(
      mutationStateSnapshot.exists ? mutationStateSnapshot.data() : undefined,
    );
    const existingResponse = existingMutationResponse({
      receipts: savedMutationState.receipts,
      requestIdHash: savedRequestIdHash,
      requestHash,
    });
    if (existingResponse) {
      return existingResponse;
    }

    if (!draftSnapshot.exists || draftSnapshot.data()?.['status'] !== 'complete') {
      throw new HttpsError(
        'failed-precondition',
        'Finish the draft before changing future matchup lineups.',
        { reason: 'draft-incomplete' },
      );
    }

    if (replaySnapshot.exists && replaySnapshot.data()?.['enabled'] === true) {
      throw new HttpsError(
        'failed-precondition',
        'Future matchup lineups are unavailable during historical replay.',
        { reason: 'historical-replay-active' },
      );
    }

    if (
      targetCycleSnapshot.exists &&
      (targetCycleSnapshot.data()?.['phase'] === 'playoffs' ||
        targetCycleSnapshot.data()?.['status'] === 'complete')
    ) {
      throw new HttpsError(
        'failed-precondition',
        'That matchup is no longer editable.',
        {
          reason: targetCycleSnapshot.data()?.['phase'] === 'playoffs'
            ? 'playoffs-not-supported'
            : 'cycle-started',
        },
      );
    }

    const existingPlan = planSnapshot.exists
      ? requireSavedPlan({
          value: planSnapshot.data(),
          ownerId: input.ownerId,
          cycleNumber: input.cycleNumber,
          documentId: planSnapshot.id,
        })
      : null;
    if (existingPlan && savedMutationState.latestRevision !== existingPlan.revision) {
      throw new HttpsError(
        'failed-precondition',
        'The saved lineup mutation state does not match the lineup plan.',
        { reason: 'lineup-mutation-state-invalid' },
      );
    }
    const currentRevision = existingPlan?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      throw new HttpsError(
        'aborted',
        'This lineup plan changed in another session.',
        {
          reason: 'revision-conflict',
          currentRevision,
          plan: existingPlan ? planView(existingPlan) : null,
        },
      );
    }

    if (!existingPlan) {
      throw new HttpsError(
        'not-found',
        'That future lineup plan no longer exists.',
        { reason: 'plan-not-found' },
      );
    }

    const targetPickSnapshots = await Promise.all(
      existingPlan.slots.map((slot) =>
        transaction.get(getTargetPickRef(
          input.leagueId,
          input.cycleNumber,
          input.ownerId,
          slot.rosterSlotId,
        )),
      ),
    );

    if (
      getFutureMatchupLineupMaterializedSlotCount(existingPlan) > 0 ||
      targetPickSnapshots.some((snapshot) => snapshot.exists)
    ) {
      throw new HttpsError(
        'failed-precondition',
        'A lineup plan cannot be cleared after any target slot boundary is materialized.',
        { reason: 'cycle-started' },
      );
    }

    const revision = savedMutationState.latestRevision + 1;
    const response: ManageFutureMatchupLineupsResult = {
      operation: 'clear',
      plan: null,
      clearedCycleNumber: input.cycleNumber,
      revision,
    };

    transaction.delete(planRef);
    transaction.set(mutationStateRef, {
      schemaVersion: 1,
      latestRevision: revision,
      receipts: [
        ...savedMutationState.receipts,
        { requestIdHash: savedRequestIdHash, requestHash, response },
      ],
      updatedAt: mutationAt,
    });

    return response;
  });
}

export const manageFutureMatchupLineups = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request): Promise<ManageFutureMatchupLineupsResult> => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'You must be signed in.');
    }
    const ownerId = requireFirestoreDocumentId(
      request.auth.uid,
      'manager ID',
      FIRESTORE_AUTH_USER_ID_OPTIONS,
    );

    const data = asRecord(request.data);
    const leagueId = requireFirestoreDocumentId(
      data['leagueId'],
      'league ID',
      FIRESTORE_LEAGUE_ID_OPTIONS,
    );
    const operation = asOperation(data['operation']);
    if (!operation) {
      throw new HttpsError('invalid-argument', 'Choose a valid lineup-plan operation.');
    }

    // Future lineups are roster authority and intentionally share the existing
    // roster-action App Check canary rather than introducing a new control mode.
    await enforceAppCheckCallableCanaryForLeague(
      request,
      'executeSecureRosterAction',
      leagueId,
    );

    const [teamSnapshot, memberSnapshot] = await Promise.all([
      db.doc(`leagues/${leagueId}/teams/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/members/${ownerId}`).get(),
    ]);
    if (
      !teamSnapshot.exists ||
      teamSnapshot.data()?.['ownerId'] !== ownerId ||
      !memberSnapshot.exists
    ) {
      throw new HttpsError(
        'permission-denied',
        'You do not own a team in this league.',
      );
    }

    if (operation === 'list') {
      return listPlans(leagueId, ownerId);
    }

    const cycleNumber = requireCycleNumber(data['cycleNumber']);
    const expectedRevision = requireExpectedRevision(data['expectedRevision']);
    const requestId = requireFirestoreDocumentId(
      data['requestId'],
      'lineup request ID',
      FIRESTORE_REQUEST_ID_OPTIONS,
    );
    const preconditions = await requireOwnerPreconditions(leagueId, ownerId);
    assertFutureRegularSeasonCycle(
      cycleNumber,
      preconditions.regularSeasonCycleCount,
    );

    if (operation === 'clear') {
      return clearPlan({
        leagueId,
        ownerId,
        cycleNumber,
        expectedRevision,
        requestId,
      });
    }

    return savePlan({
      leagueId,
      ownerId,
      cycleNumber,
      expectedRevision,
      requestId,
      requestedSlots: requireRequestedSlots(data['slots']),
      roster: preconditions.roster,
    });
  },
);
