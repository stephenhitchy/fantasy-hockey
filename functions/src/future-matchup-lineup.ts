import { createHash } from 'node:crypto';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { enforceAppCheckCallableCanaryForLeague } from './app-check-canary-authority';
import { db } from './shared/core/firebase';
import { DraftableAsset, FantasyDraft } from './shared/core/draft/draft.models';
import { getCycleRosterSlotPickDocumentId } from './shared/core/cycle/cycle.service';
import { createPlayerWindowContinuity } from './shared/core/cycle/player-window-continuity.util';
import {
  getAnchoredRegularSeasonCycleCount,
  STANDARD_FULL_CYCLE_SEASON_COUNT,
} from './shared/core/playoffs/playoff-format';
import {
  createFutureMatchupLineupAssignmentHash,
  buildFutureMatchupResetWindow,
  deriveFutureMatchupLineupPlanStatus,
  FUTURE_MATCHUP_LINEUP_SCHEMA_VERSION,
  FutureMatchupLineupPlan,
  FutureMatchupLineupSlot,
  futureMatchupWindowOwnershipStarted,
  getFutureLineupRosterAssetKey,
  getFutureMatchupLineupMaterializedSlotCount,
  normalizeFutureMatchupLineupPlan,
  requireUntouchedFutureMatchupWindow,
  RequestedFutureMatchupLineupSlot,
  validateFutureMatchupLineupSlots,
} from './shared/core/team/future-matchup-lineup.util';
import { FantasyRoster, RosterAsset } from './shared/core/team/roster.models';
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
import {
  defaultScoringRules,
  scoringRulesForVersion,
} from './shared/core/scoring/scoring-rules';
import { TRUSTED_WEB_ORIGINS } from './web-security';
import {
  applyCurrentNhlTeamIdentity,
  getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds,
  loadExactRosterActionPlayerTeamIdentity,
  loadUntouchedRosterSwapScheduleEvidence,
  resolveIncomingProjectionForCycle,
} from './roster-moves';

const FUNCTION_REGION = 'us-central1';
const FIRST_CYCLE_NUMBER = 1;
const MAX_FUTURE_MATCHUP_PLAN_COUNT = STANDARD_FULL_CYCLE_SEASON_COUNT - 1;
const MAX_MUTATION_RECEIPTS_PER_CYCLE = 64;

type FutureLineupOperation = 'list' | 'save' | 'clear' | 'swap';

type FutureMatchupLineupSwapTimingReason =
  | 'selected-matchup-untouched'
  | 'requested-matchup-materialized'
  | 'outgoing-started'
  | 'incoming-started'
  | 'incoming-not-yet-eligible';

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
    }
  | {
      operation: 'swap';
      mode: 'immediate' | 'queued';
      requestedCycleNumber: number;
      effectiveCycleNumber: number;
      timingReason: FutureMatchupLineupSwapTimingReason;
      plan: FutureMatchupLineupPlanView;
      effectiveStart: {
        cycleNumber: number;
        evidence: 'lineup-plan-boundary';
        reason: string;
      };
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

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asOperation(value: unknown): FutureLineupOperation | null {
  return value === 'list' || value === 'save' || value === 'clear' || value === 'swap'
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
  const revision = response['operation'] === 'save' || response['operation'] === 'swap'
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
  operation: 'save' | 'clear' | 'swap';
  cycleNumber?: number;
  requestedCycleNumber?: number;
  expectedEffectiveCycleNumber?: number;
  expectedRevision: number;
  assignmentHash?: string;
  activeSlotId?: string;
  benchSlotId?: string;
  expectedOutgoingAssetKey?: string | null;
  expectedIncomingAssetKey?: string;
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
  requiredGamesPerCycle: number;
}> {
  const [
    leagueSnapshot,
    teamSnapshot,
    memberSnapshot,
    rosterSnapshot,
    draftSnapshot,
    replaySnapshot,
    teams,
  ] =
    await Promise.all([
      db.doc(`leagues/${leagueId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/members/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
      db.doc(`leagues/${leagueId}/draft/current`).get(),
      db.doc(`leagues/${leagueId}/historicalReplay/control`).get(),
      db.collection(`leagues/${leagueId}/teams`).get(),
    ]);

  if (
    !leagueSnapshot.exists ||
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
    requiredGamesPerCycle: requireLeagueRequiredGamesPerCycle(
      asRecord(leagueSnapshot.data()),
    ),
  };
}

function requireLeagueRequiredGamesPerCycle(
  league: Record<string, unknown>,
): number {
  const scoringRules = asRecord(league['scoringRules']);
  const configured = scoringRules['requiredGamesPerCycle'] ??
    league['requiredGamesPerCycle'];
  const contractRequiredGames = scoringRulesForVersion(
    league['scoringRulesVersion'],
  ).requiredGamesPerCycle ?? defaultScoringRules.requiredGamesPerCycle;
  const value = configured ?? contractRequiredGames;

  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new HttpsError(
      'failed-precondition',
      'The league scoring contract has an invalid game-count requirement.',
      { reason: 'scoring-rules-invalid' },
    );
  }

  return value;
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

  assertRegularSeasonSwapCycle(cycleNumber, regularSeasonCycleCount);
}

function assertRegularSeasonSwapCycle(
  cycleNumber: number,
  regularSeasonCycleCount: number,
): void {
  if (cycleNumber < FIRST_CYCLE_NUMBER) {
    throw new HttpsError(
      'invalid-argument',
      'The selected regular-season matchup is invalid.',
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

interface FutureLineupSwapCycleEvidence {
  cycleNumber: number;
  phase: unknown;
  status: unknown;
  data: Record<string, unknown>;
  picks: Array<Record<string, unknown>>;
  teamWindows: Record<string, unknown> | null;
}

interface FutureLineupSwapTiming {
  effectiveCycleNumber: number;
  mode: 'immediate' | 'queued';
  timingReason: FutureMatchupLineupSwapTimingReason;
  application: 'materialized-swap' | 'plan';
}

function rosterAssetToDraftableAsset(asset: RosterAsset): DraftableAsset {
  const copy = { ...asset } as Record<string, unknown>;
  delete copy['cycleScore'];
  delete copy['rosterStatus'];

  return {
    ...copy,
    assetKey: getFutureLineupRosterAssetKey(asset),
  } as DraftableAsset;
}

function createActiveRosterAsset(
  asset: DraftableAsset,
  cycleNumber: number,
): RosterAsset {
  return {
    ...asset,
    rosterStatus: 'active',
    eligibleFromCycleNumber: cycleNumber,
    cycleScore: {
      cycleNumber,
      gamesCounted: 0,
      fantasyPoints: 0,
    },
  } as RosterAsset;
}

function rosterAssetTeamAbbreviation(asset: RosterAsset | DraftableAsset): string {
  return (
    asset.assetType === 'skater'
      ? asset.player.nhlTeamAbbreviation
      : asset.teamAbbreviation
  ).trim().toUpperCase();
}

function requireCompleteFrozenGameIds(input: {
  value: unknown;
  requiredGamesPerCycle: number;
  assignment: 'outgoing' | 'incoming';
}): number[] {
  const gameIds = Array.isArray(input.value)
    ? input.value.filter(
        (gameId): gameId is number =>
          typeof gameId === 'number' &&
          Number.isSafeInteger(gameId) &&
          gameId > 0,
      )
    : [];

  if (
    !Array.isArray(input.value) ||
    input.value.length !== input.requiredGamesPerCycle ||
    gameIds.length !== input.requiredGamesPerCycle ||
    new Set(gameIds).size !== input.requiredGamesPerCycle
  ) {
    throw new HttpsError(
      'failed-precondition',
      `The ${input.assignment} player does not have one complete frozen NHL game block.`,
      {
        reason: 'incomplete-frozen-game-evidence',
        assignment: input.assignment,
        requiredGamesPerCycle: input.requiredGamesPerCycle,
      },
    );
  }

  return gameIds;
}

function sameGameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length &&
    left.every((gameId, index) => gameId === right[index]);
}

function rosterPickAssetKey(pick: Record<string, unknown>): string {
  return asNonEmptyString(asRecord(pick['asset'])['assetKey']);
}

function findEvidenceWindow(
  evidence: FutureLineupSwapCycleEvidence,
  predicate: (window: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const windows = Array.isArray(evidence.teamWindows?.['windows'])
    ? evidence.teamWindows?.['windows'] as unknown[]
    : [];

  return windows.map(asRecord).find(predicate) ?? null;
}

function requireCompleteTeamWindowSlotEvidence(input: {
  teamWindows: Record<string, unknown>;
  cycle: Record<string, unknown>;
  windows: readonly Record<string, unknown>[];
  ownerId: string;
  cycleNumber: number;
  activeSlotId: string;
}): string[] {
  const invalidEvidence = (): never => {
    throw new HttpsError(
      'failed-precondition',
      'The matchup team-window slot evidence is incomplete or malformed.',
      { reason: 'team-window-state-invalid' },
    );
  };
  const requireExactRosterSlotIds = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > DEFAULT_STARTING_ROSTER_SIZE
    ) {
      return invalidEvidence();
    }
    const rosterSlotIds = value.map((entry) => {
      let rosterSlotId: string;
      try {
        rosterSlotId = requireFirestoreDocumentId(
          entry,
          'expected roster slot ID',
          FIRESTORE_ROSTER_SLOT_ID_OPTIONS,
        );
      } catch {
        return invalidEvidence();
      }
      return entry === rosterSlotId ? rosterSlotId : invalidEvidence();
    });
    return new Set(rosterSlotIds).size === rosterSlotIds.length
      ? rosterSlotIds
      : invalidEvidence();
  };
  if (
    input.teamWindows['ownerId'] !== input.ownerId ||
    input.teamWindows['cycleNumber'] !== input.cycleNumber
  ) {
    return invalidEvidence();
  }
  const expectedRosterSlotIds = requireExactRosterSlotIds(
    input.teamWindows['expectedRosterSlotIds'],
  );
  const cycleExpectedRosterSlotIds = requireExactRosterSlotIds(
    asRecord(input.cycle['expectedRosterSlotIdsByOwner'])[input.ownerId],
  );
  const expectedRosterSlotIdSet = new Set(expectedRosterSlotIds);
  if (
    expectedRosterSlotIds.length !== cycleExpectedRosterSlotIds.length ||
    expectedRosterSlotIds.some(
      (slotId, index) => slotId !== cycleExpectedRosterSlotIds[index],
    ) ||
    !expectedRosterSlotIdSet.has(input.activeSlotId) ||
    input.windows.length !== expectedRosterSlotIds.length
  ) {
    return invalidEvidence();
  }

  const seenWindowSlotIds = new Set<string>();
  for (const window of input.windows) {
    let rosterSlotId: string;
    try {
      rosterSlotId = requireFirestoreDocumentId(
        window['rosterSlotId'],
        'team-window roster slot ID',
        FIRESTORE_ROSTER_SLOT_ID_OPTIONS,
      );
    } catch {
      return invalidEvidence();
    }
    if (
      window['rosterSlotId'] !== rosterSlotId ||
      window['ownerId'] !== input.ownerId ||
      window['cycleNumber'] !== input.cycleNumber ||
      !expectedRosterSlotIdSet.has(rosterSlotId) ||
      seenWindowSlotIds.has(rosterSlotId)
    ) {
      return invalidEvidence();
    }
    seenWindowSlotIds.add(rosterSlotId);
  }

  return seenWindowSlotIds.size === expectedRosterSlotIds.length
    ? expectedRosterSlotIds
    : invalidEvidence();
}

function resolveFutureLineupSwapTiming(input: {
  requestedCycleNumber: number;
  regularSeasonCycleCount: number;
  latestCycleNumber: number;
  incomingEligibleFromCycleNumber: number;
  activeSlotId: string;
  outgoingAssetKey: string | null;
  incomingAssetKey: string;
  evidenceByCycle: ReadonlyMap<number, FutureLineupSwapCycleEvidence>;
  allowMaterializedSwap: boolean;
  freshStartedReasonByCycle?: ReadonlyMap<
    number,
    Extract<FutureMatchupLineupSwapTimingReason, 'outgoing-started' | 'incoming-started'>
  >;
}): FutureLineupSwapTiming {
  let effectiveCycleNumber = Math.max(
    input.requestedCycleNumber,
    input.incomingEligibleFromCycleNumber,
  );
  let timingReason: FutureMatchupLineupSwapTimingReason =
    effectiveCycleNumber > input.requestedCycleNumber
      ? 'incoming-not-yet-eligible'
      : 'selected-matchup-untouched';

  while (effectiveCycleNumber <= input.regularSeasonCycleCount) {
    const evidence = input.evidenceByCycle.get(effectiveCycleNumber) ?? null;
    const freshStartedReason = input.freshStartedReasonByCycle?.get(
      effectiveCycleNumber,
    );

    if (freshStartedReason) {
      effectiveCycleNumber += 1;
      timingReason = freshStartedReason;
      continue;
    }

    if (!evidence) {
      if (input.latestCycleNumber >= effectiveCycleNumber) {
        throw new HttpsError(
          'failed-precondition',
          'A matchup document is missing from the active season authority.',
          { reason: 'cycle-state-invalid', cycleNumber: effectiveCycleNumber },
        );
      }

      return {
        effectiveCycleNumber,
        mode:
          effectiveCycleNumber === input.requestedCycleNumber
            ? 'immediate'
            : 'queued',
        timingReason,
        application: 'plan',
      };
    }

    if (evidence.phase === 'playoffs') {
      throw new HttpsError(
        'failed-precondition',
        'Playoff lineup planning is not supported by this contract.',
        { reason: 'playoffs-not-supported' },
      );
    }
    if (evidence.phase !== 'regular_season') {
      throw new HttpsError(
        'failed-precondition',
        'The selected matchup has malformed season-phase authority.',
        { reason: 'cycle-state-invalid', cycleNumber: effectiveCycleNumber },
      );
    }
    if (evidence.status === 'complete') {
      effectiveCycleNumber += 1;
      timingReason = 'requested-matchup-materialized';
      continue;
    }
    if (evidence.status !== 'active') {
      throw new HttpsError(
        'failed-precondition',
        'The selected matchup has malformed status authority.',
        { reason: 'cycle-state-invalid', cycleNumber: effectiveCycleNumber },
      );
    }

    const targetPicks = evidence.picks.filter(
      (pick) => asNonEmptyString(pick['rosterSlotId']) === input.activeSlotId,
    );
    if (targetPicks.length > 1) {
      throw new HttpsError(
        'failed-precondition',
        'The selected roster slot has duplicate matchup assignments.',
        { reason: 'target-pick-state-invalid' },
      );
    }
    const targetPick = targetPicks[0] ?? null;
    const targetWindow = findEvidenceWindow(
      evidence,
      (window) => asNonEmptyString(window['rosterSlotId']) === input.activeSlotId,
    );
    const incomingPicks = evidence.picks.filter(
      (pick) => rosterPickAssetKey(pick) === input.incomingAssetKey,
    );
    const incomingWindow = findEvidenceWindow(
      evidence,
      (window) => asNonEmptyString(window['assetKey']) === input.incomingAssetKey,
    );

    if (targetWindow && !targetPick) {
      throw new HttpsError(
        'failed-precondition',
        'The selected roster window is missing its authoritative roster pick.',
        { reason: 'target-pick-state-invalid' },
      );
    }

    if (targetPick) {
      if (!targetWindow) {
        throw new HttpsError(
          'failed-precondition',
          'The selected roster pick is missing its authoritative scoring window.',
          { reason: 'target-pick-state-invalid' },
        );
      }
      if (rosterPickAssetKey(targetPick) !== input.outgoingAssetKey) {
        effectiveCycleNumber += 1;
        timingReason = futureMatchupWindowOwnershipStarted(targetWindow)
          ? 'outgoing-started'
          : 'requested-matchup-materialized';
        continue;
      }
      if (targetWindow && futureMatchupWindowOwnershipStarted(targetWindow)) {
        effectiveCycleNumber += 1;
        timingReason = 'outgoing-started';
        continue;
      }
      if (incomingPicks.length > 0 || incomingWindow) {
        effectiveCycleNumber += 1;
        timingReason = incomingWindow &&
          futureMatchupWindowOwnershipStarted(incomingWindow)
          ? 'incoming-started'
          : 'requested-matchup-materialized';
        continue;
      }

      if (!input.allowMaterializedSwap) {
        effectiveCycleNumber += 1;
        timingReason = 'requested-matchup-materialized';
        continue;
      }

      return {
        effectiveCycleNumber,
        mode:
          effectiveCycleNumber === input.requestedCycleNumber
            ? 'immediate'
            : 'queued',
        timingReason,
        application: 'materialized-swap',
      };
    }

    if (incomingPicks.length > 0 || incomingWindow) {
      effectiveCycleNumber += 1;
      timingReason = incomingWindow &&
        futureMatchupWindowOwnershipStarted(incomingWindow)
        ? 'incoming-started'
        : 'requested-matchup-materialized';
      continue;
    }

    const precedingCycle = input.evidenceByCycle.get(
      effectiveCycleNumber - 1,
    );
    if (
      effectiveCycleNumber > input.latestCycleNumber ||
      precedingCycle?.status === 'active'
    ) {
      return {
        effectiveCycleNumber,
        mode:
          effectiveCycleNumber === input.requestedCycleNumber
            ? 'immediate'
            : 'queued',
        timingReason,
        application: 'plan',
      };
    }

    effectiveCycleNumber += 1;
    timingReason = 'requested-matchup-materialized';
  }

  throw new HttpsError(
    'failed-precondition',
    'No remaining regular-season matchup can accept this roster move.',
    { reason: 'playoffs-not-supported' },
  );
}

async function loadFutureLineupSwapCycleEvidence(input: {
  leagueId: string;
  ownerId: string;
  regularSeasonCycleCount: number;
}): Promise<{
  latestCycleNumber: number;
  evidenceByCycle: Map<number, FutureLineupSwapCycleEvidence>;
}> {
  const cyclesSnapshot = await db.collection(`leagues/${input.leagueId}/cycles`)
    .orderBy('cycleNumber', 'asc')
    .limit(input.regularSeasonCycleCount + 1)
    .get();
  const evidence = await Promise.all(cyclesSnapshot.docs.map(async (cycle) => {
    const cycleNumber = cycle.data()?.['cycleNumber'];
    if (
      typeof cycleNumber !== 'number' ||
      !Number.isSafeInteger(cycleNumber) ||
      cycleNumber < 1 ||
      cycle.id !== `cycle-${cycleNumber}`
    ) {
      throw new HttpsError(
        'failed-precondition',
        'The saved matchup authority is malformed.',
        { reason: 'cycle-state-invalid' },
      );
    }
    const [picksSnapshot, teamWindowsSnapshot] = await Promise.all([
      cycle.ref.collection('rosterPicks').where('ownerId', '==', input.ownerId).get(),
      cycle.ref.collection('teamWindows').doc(input.ownerId).get(),
    ]);

    return {
      cycleNumber,
      phase: cycle.data()?.['phase'],
      status: cycle.data()?.['status'],
      data: asRecord(cycle.data()),
      picks: picksSnapshot.docs.map((pick) => asRecord(pick.data())),
      teamWindows: teamWindowsSnapshot.exists
        ? asRecord(teamWindowsSnapshot.data())
        : null,
    } satisfies FutureLineupSwapCycleEvidence;
  }));
  const evidenceByCycle = new Map(
    evidence.map((entry) => [entry.cycleNumber, entry] as const),
  );

  return {
    latestCycleNumber: evidence.reduce(
      (latest, entry) => Math.max(latest, entry.cycleNumber),
      0,
    ),
    evidenceByCycle,
  };
}

function validateFutureLineupSwapRoster(input: {
  roster: FantasyRoster;
  ownerId: string;
  requestedCycleNumber: number;
  activeSlotId: string;
  benchSlotId: string;
  expectedOutgoingAssetKey: string | null;
  expectedIncomingAssetKey: string;
  requestedPlan: FutureMatchupLineupPlan | null;
  requestedCycleEvidence: FutureLineupSwapCycleEvidence | null;
}): {
  outgoingAsset: RosterAsset | null;
  incomingAsset: RosterAsset;
  ownershipShape:
    | 'physical-swap'
    | 'physical-promotion'
    | 'planned-replacement'
    | 'planned-reversal'
    | 'requested-assignment';
} {
  if (input.roster.activeSlots.some((slot) => Boolean(slot.pendingMove))) {
    throw new HttpsError(
      'failed-precondition',
      'Resolve the current pending roster move before changing future lineups.',
      { reason: 'pending-roster-move' },
    );
  }
  const activeSlot = input.roster.activeSlots.find(
    (slot) => slot.slotId === input.activeSlotId,
  );
  const benchSlot = input.roster.benchSlots.find(
    (slot) => slot.slotId === input.benchSlotId,
  );
  const currentActiveAsset = activeSlot?.asset ?? null;
  const submittedBenchAsset = benchSlot?.asset ?? null;
  const currentActiveAssetKey = getFutureLineupRosterAssetKey(currentActiveAsset);
  const submittedBenchAssetKey = getFutureLineupRosterAssetKey(submittedBenchAsset);
  const plannedSlot = input.requestedPlan?.slots.find(
    (slot) => slot.rosterSlotId === input.activeSlotId,
  ) ?? null;
  const plannedOutgoingAssetKey = plannedSlot?.resolution === 'planned'
    ? plannedSlot.assetKey
    : null;

  if (input.expectedOutgoingAssetKey === input.expectedIncomingAssetKey) {
    throw new HttpsError(
      'invalid-argument',
      'Choose two different players for this matchup lineup change.',
      { reason: 'same-asset-swap' },
    );
  }

  if (!activeSlot) {
    throw new HttpsError(
      'aborted',
      'The selected active player changed. Refresh the roster and try again.',
      { reason: 'roster-revision-conflict' },
    );
  }

  let outgoingAsset: RosterAsset | null;
  let incomingAsset: RosterAsset;
  let ownershipShape:
    | 'physical-swap'
    | 'physical-promotion'
    | 'planned-replacement'
    | 'planned-reversal'
    | 'requested-assignment';

  if (input.expectedOutgoingAssetKey === null) {
    if (
      currentActiveAsset ||
      plannedOutgoingAssetKey !== null ||
      !submittedBenchAsset ||
      submittedBenchAssetKey !== input.expectedIncomingAssetKey
    ) {
      throw new HttpsError(
        'aborted',
        'The selected empty roster slot changed. Refresh the roster and try again.',
        { reason: 'roster-revision-conflict' },
      );
    }
    outgoingAsset = null;
    incomingAsset = submittedBenchAsset;
    ownershipShape = 'physical-promotion';
  } else if (
    currentActiveAsset &&
    currentActiveAssetKey === input.expectedOutgoingAssetKey
  ) {
    if (
      !submittedBenchAsset ||
      submittedBenchAssetKey !== input.expectedIncomingAssetKey
    ) {
      throw new HttpsError(
        'aborted',
        'The selected bench player changed. Refresh the roster and try again.',
        { reason: 'roster-revision-conflict' },
      );
    }
    outgoingAsset = currentActiveAsset;
    incomingAsset = submittedBenchAsset;
    ownershipShape = 'physical-swap';
  } else if (plannedOutgoingAssetKey === input.expectedOutgoingAssetKey) {
    if (
      currentActiveAsset &&
      currentActiveAssetKey === input.expectedIncomingAssetKey &&
      submittedBenchAssetKey === input.expectedOutgoingAssetKey &&
      submittedBenchAsset
    ) {
      // Reversing an unmaterialized A -> B plan selects conceptual bench player
      // A while A is still physically active and B still occupies the submitted
      // bench slot. No physical roster ownership moves until materialization.
      outgoingAsset = submittedBenchAsset;
      incomingAsset = currentActiveAsset;
      ownershipShape = 'planned-reversal';
    } else {
      if (
        !submittedBenchAsset ||
        submittedBenchAssetKey !== input.expectedIncomingAssetKey
      ) {
        throw new HttpsError(
          'aborted',
          'The selected bench player changed. Refresh the roster and try again.',
          { reason: 'roster-revision-conflict' },
        );
      }
      const plannedOutgoingMatches = input.roster.benchSlots.filter(
        (slot) =>
          getFutureLineupRosterAssetKey(slot.asset) ===
            input.expectedOutgoingAssetKey,
      );
      if (plannedOutgoingMatches.length !== 1 || !plannedOutgoingMatches[0].asset) {
        throw new HttpsError(
          'aborted',
          'The selected planned player is no longer on the expected bench. Refresh and try again.',
          { reason: 'roster-revision-conflict' },
        );
      }
      outgoingAsset = plannedOutgoingMatches[0].asset;
      incomingAsset = submittedBenchAsset;
      ownershipShape = 'planned-replacement';
    }
  } else {
    const requestedPicks = (input.requestedCycleEvidence?.picks ?? []).filter(
      (pick) => asNonEmptyString(pick['rosterSlotId']) === input.activeSlotId,
    );
    const requestedWindows = Array.isArray(
      input.requestedCycleEvidence?.teamWindows?.['windows'],
    )
      ? (input.requestedCycleEvidence?.teamWindows?.['windows'] as unknown[])
        .map(asRecord)
        .filter(
          (window) =>
            asNonEmptyString(window['rosterSlotId']) === input.activeSlotId,
        )
      : [];
    const requestedPick = requestedPicks.length === 1
      ? requestedPicks[0]
      : null;
    const requestedWindow = requestedWindows.length === 1
      ? requestedWindows[0]
      : null;
    const requestedAssignmentAsset = requestedPick
      ? asRecord(requestedPick['asset']) as unknown as RosterAsset
      : null;
    const requestedAssignmentIsExact = Boolean(
      requestedPick &&
      requestedWindow &&
      asNonEmptyString(requestedPick['ownerId']) === input.ownerId &&
      rosterPickAssetKey(requestedPick) === input.expectedOutgoingAssetKey &&
      asNonEmptyString(requestedWindow['ownerId']) === input.ownerId &&
      asNonEmptyString(requestedWindow['rosterSlotId']) === input.activeSlotId &&
      requestedWindow['cycleNumber'] === input.requestedCycleNumber &&
      asNonEmptyString(requestedWindow['assetKey']) ===
        input.expectedOutgoingAssetKey &&
      requestedAssignmentAsset &&
      getFutureLineupRosterAssetKey(requestedAssignmentAsset) ===
        input.expectedOutgoingAssetKey,
    );

    if (
      !requestedAssignmentIsExact ||
      !requestedAssignmentAsset ||
      !submittedBenchAsset ||
      submittedBenchAssetKey !== input.expectedIncomingAssetKey
    ) {
      throw new HttpsError(
        'aborted',
        'The selected matchup starter changed. Refresh the lineup and try again.',
        { reason: 'roster-revision-conflict' },
      );
    }

    // An overlapping selected matchup may still display an older authoritative
    // assignment after the physical roster has advanced. That exact pick/window
    // may establish the outgoing identity for timing, but it can never authorize
    // an immediate materialized rewrite of the physical roster.
    outgoingAsset = requestedAssignmentAsset;
    incomingAsset = submittedBenchAsset;
    ownershipShape = 'requested-assignment';
  }

  if (
    (outgoingAsset && outgoingAsset.position !== activeSlot.position) ||
    incomingAsset.position !== activeSlot.position
  ) {
    throw new HttpsError(
      'failed-precondition',
      `The replacement must play ${activeSlot.position}.`,
      { reason: 'position-mismatch' },
    );
  }
  const benchReserved = input.roster.activeSlots.some(
    (slot) =>
      slot.pendingMove?.sourceBenchSlotId === input.benchSlotId &&
      getFutureLineupRosterAssetKey(slot.pendingMove.incomingAsset) ===
        input.expectedIncomingAssetKey,
  );
  if (benchReserved) {
    throw new HttpsError(
      'failed-precondition',
      'That bench player is reserved for another scheduled roster move.',
      { reason: 'pending-roster-move' },
    );
  }

  return { outgoingAsset, incomingAsset, ownershipShape };
}

function swapTimingReasonText(
  reason: FutureMatchupLineupSwapTimingReason,
  requestedCycleNumber: number,
  effectiveCycleNumber: number,
): string {
  if (reason === 'selected-matchup-untouched') {
    return `The selected slot and incoming player were untouched in Matchup ${requestedCycleNumber}; the assignment changed immediately.`;
  }
  if (reason === 'outgoing-started') {
    return `The outgoing player's Matchup ${requestedCycleNumber} assignment had started, so the change begins in Matchup ${effectiveCycleNumber}.`;
  }
  if (reason === 'incoming-started') {
    return `The incoming player's Matchup ${requestedCycleNumber} assignment had started, so the change begins in Matchup ${effectiveCycleNumber}.`;
  }
  if (reason === 'incoming-not-yet-eligible') {
    return `The incoming player is first eligible in Matchup ${effectiveCycleNumber}.`;
  }

  return `The selected matchup assignment was already fixed, so the change begins in Matchup ${effectiveCycleNumber}.`;
}

async function swapFutureMatchupLineup(input: {
  leagueId: string;
  ownerId: string;
  requestedCycleNumber: number;
  expectedEffectiveCycleNumber: number;
  activeSlotId: string;
  benchSlotId: string;
  expectedRevision: number;
  requestId: string;
  expectedOutgoingAssetKey: string | null;
  expectedIncomingAssetKey: string;
  roster: FantasyRoster;
  regularSeasonCycleCount: number;
  requiredGamesPerCycle: number;
}): Promise<ManageFutureMatchupLineupsResult> {
  const requestHash = mutationRequestHash({
    leagueId: input.leagueId,
    ownerId: input.ownerId,
    operation: 'swap',
    requestedCycleNumber: input.requestedCycleNumber,
    expectedEffectiveCycleNumber: input.expectedEffectiveCycleNumber,
    expectedRevision: input.expectedRevision,
    activeSlotId: input.activeSlotId,
    benchSlotId: input.benchSlotId,
    expectedOutgoingAssetKey: input.expectedOutgoingAssetKey,
    expectedIncomingAssetKey: input.expectedIncomingAssetKey,
  });
  const savedRequestIdHash = requestIdHash(input.requestId);
  const planRef = getPlanRef(
    input.leagueId,
    input.ownerId,
    input.expectedEffectiveCycleNumber,
  );
  const requestedPlanRef = getPlanRef(
    input.leagueId,
    input.ownerId,
    input.requestedCycleNumber,
  );
  const expectedMutationStateRef = getMutationStateRef(
    input.leagueId,
    input.ownerId,
    input.expectedEffectiveCycleNumber,
  );
  const replaySnapshot = await expectedMutationStateRef.get();
  if (replaySnapshot.exists) {
    const savedState = mutationState(replaySnapshot.data());
    const replay = existingMutationResponse({
      receipts: savedState.receipts,
      requestIdHash: savedRequestIdHash,
      requestHash,
    });
    if (replay) {
      return replay;
    }
  }

  const [
    preflightPlanSnapshot,
    preflightRequestedPlanSnapshot,
    preflightCycleEvidence,
  ] = await Promise.all([
    planRef.get(),
    requestedPlanRef.get(),
    loadFutureLineupSwapCycleEvidence({
      leagueId: input.leagueId,
      ownerId: input.ownerId,
      regularSeasonCycleCount: input.regularSeasonCycleCount,
    }),
  ]);
  if (preflightPlanSnapshot.exists) {
    requireSavedPlan({
        value: preflightPlanSnapshot.data(),
        ownerId: input.ownerId,
        cycleNumber: input.expectedEffectiveCycleNumber,
        documentId: preflightPlanSnapshot.id,
      });
  }
  const preflightRequestedPlan = preflightRequestedPlanSnapshot.exists
    ? requireSavedPlan({
        value: preflightRequestedPlanSnapshot.data(),
        ownerId: input.ownerId,
        cycleNumber: input.requestedCycleNumber,
        documentId: preflightRequestedPlanSnapshot.id,
      })
    : null;
  const preflightRequestedCycleEvidence =
    preflightCycleEvidence.evidenceByCycle.get(input.requestedCycleNumber) ?? null;
  if (
    input.requestedCycleNumber === FIRST_CYCLE_NUMBER &&
    !preflightRequestedCycleEvidence
  ) {
    throw new HttpsError(
      'failed-precondition',
      'Matchup 1 lineup changes become available after the season matchup is created.',
      { reason: 'cycle-state-invalid', cycleNumber: FIRST_CYCLE_NUMBER },
    );
  }
  const preflightAssets = validateFutureLineupSwapRoster({
    roster: input.roster,
    ownerId: input.ownerId,
    requestedCycleNumber: input.requestedCycleNumber,
    activeSlotId: input.activeSlotId,
    benchSlotId: input.benchSlotId,
    expectedOutgoingAssetKey: input.expectedOutgoingAssetKey,
    expectedIncomingAssetKey: input.expectedIncomingAssetKey,
    requestedPlan: preflightRequestedPlan,
    requestedCycleEvidence: preflightRequestedCycleEvidence,
  });
  const incomingEligibleFromCycleNumber = Math.max(
    1,
    preflightAssets.incomingAsset.eligibleFromCycleNumber ?? 1,
  );
  let preflightTiming = resolveFutureLineupSwapTiming({
    requestedCycleNumber: input.requestedCycleNumber,
    regularSeasonCycleCount: input.regularSeasonCycleCount,
    latestCycleNumber: preflightCycleEvidence.latestCycleNumber,
    incomingEligibleFromCycleNumber,
    activeSlotId: input.activeSlotId,
    outgoingAssetKey: input.expectedOutgoingAssetKey,
    incomingAssetKey: input.expectedIncomingAssetKey,
    evidenceByCycle: preflightCycleEvidence.evidenceByCycle,
    allowMaterializedSwap: preflightAssets.ownershipShape === 'physical-swap',
  });
  const actionBoundaryMilliseconds = Date.now();
  let resolvedIncomingAsset: DraftableAsset | null = null;
  let authoritativeOutgoingAsset = preflightAssets.outgoingAsset;
  let currentTeamAbbreviationByPlayerId: ReadonlyMap<number, string> | undefined;
  let scheduleEvidence: Awaited<
    ReturnType<typeof loadUntouchedRosterSwapScheduleEvidence>
  > | null = null;
  let verifiedOutgoingGameIds: number[] | null = null;
  let verifiedIncomingGameIds: number[] | null = null;
  const freshStartedReasonByCycle = new Map<
    number,
    Extract<FutureMatchupLineupSwapTimingReason, 'outgoing-started' | 'incoming-started'>
  >();
  const verifiedPromotionScheduleByCycle = new Map<number, {
    incomingGameIds: number[];
    scheduleEvidence: Awaited<
      ReturnType<typeof loadUntouchedRosterSwapScheduleEvidence>
    >;
  }>();
  let promotionIncomingTeamAbbreviation: string | null = null;

  if (preflightAssets.ownershipShape === 'physical-promotion') {
    while (preflightTiming.application === 'plan') {
      const evidence = preflightCycleEvidence.evidenceByCycle.get(
        preflightTiming.effectiveCycleNumber,
      );
      if (!evidence || evidence.status !== 'active') {
        break;
      }
      if (!promotionIncomingTeamAbbreviation) {
        const playerIds = preflightAssets.incomingAsset.assetType === 'skater'
          ? [preflightAssets.incomingAsset.player.id]
          : [];
        const identity = await loadExactRosterActionPlayerTeamIdentity(
          playerIds,
          actionBoundaryMilliseconds,
        );
        currentTeamAbbreviationByPlayerId = identity?.byPlayerId;
        const authoritativeIncomingAsset = applyCurrentNhlTeamIdentity(
          preflightAssets.incomingAsset,
          identity?.byPlayerId,
        );
        promotionIncomingTeamAbbreviation = rosterAssetTeamAbbreviation(
          authoritativeIncomingAsset,
        );
      }
      const sourceGameIdsByTeam = asRecord(
        evidence.data['sourceNhlTargetGameIdsByTeam'],
      );
      const incomingGameIds = requireCompleteFrozenGameIds({
        value: sourceGameIdsByTeam[promotionIncomingTeamAbbreviation],
        requiredGamesPerCycle: input.requiredGamesPerCycle,
        assignment: 'incoming',
      });
      const promotionScheduleEvidence =
        await loadUntouchedRosterSwapScheduleEvidence({
          incomingTeamAbbreviation: promotionIncomingTeamAbbreviation,
          incomingScheduledGameIds: incomingGameIds,
          boundaryMilliseconds: actionBoundaryMilliseconds,
        });
      verifiedPromotionScheduleByCycle.set(
        preflightTiming.effectiveCycleNumber,
        {
          incomingGameIds,
          scheduleEvidence: promotionScheduleEvidence,
        },
      );
      if (!promotionScheduleEvidence.startedReason) {
        break;
      }
      freshStartedReasonByCycle.set(
        preflightTiming.effectiveCycleNumber,
        promotionScheduleEvidence.startedReason,
      );
      preflightTiming = resolveFutureLineupSwapTiming({
        requestedCycleNumber: input.requestedCycleNumber,
        regularSeasonCycleCount: input.regularSeasonCycleCount,
        latestCycleNumber: preflightCycleEvidence.latestCycleNumber,
        incomingEligibleFromCycleNumber,
        activeSlotId: input.activeSlotId,
        outgoingAssetKey: input.expectedOutgoingAssetKey,
        incomingAssetKey: input.expectedIncomingAssetKey,
        evidenceByCycle: preflightCycleEvidence.evidenceByCycle,
        allowMaterializedSwap: false,
        freshStartedReasonByCycle,
      });
    }
  }

  if (
    preflightTiming.effectiveCycleNumber !== input.expectedEffectiveCycleNumber
  ) {
    throw new HttpsError(
      'aborted',
      `The matchup timing changed. Review Matchup ${preflightTiming.effectiveCycleNumber} and try again.`,
      {
        reason: 'swap-timing-conflict',
        mode: preflightTiming.mode,
        timingReason: preflightTiming.timingReason,
        effectiveCycleNumber: preflightTiming.effectiveCycleNumber,
        startedGameIds: [
          ...new Set(
            [...verifiedPromotionScheduleByCycle.values()].flatMap(
              ({ scheduleEvidence: evidence }) => evidence.startedGameIds,
            ),
          ),
        ].sort((left, right) => left - right),
      },
    );
  }

  if (preflightTiming.application === 'materialized-swap') {
    if (!preflightAssets.outgoingAsset) {
      throw new HttpsError(
        'aborted',
        'The selected matchup assignment changed while the move was checked.',
        { reason: 'swap-timing-conflict' },
      );
    }
    const playerIds = [
      preflightAssets.outgoingAsset.assetType === 'skater'
        ? preflightAssets.outgoingAsset.player.id
        : null,
      preflightAssets.incomingAsset.assetType === 'skater'
        ? preflightAssets.incomingAsset.player.id
        : null,
    ].filter(
      (playerId): playerId is number =>
        typeof playerId === 'number' && Number.isSafeInteger(playerId) && playerId > 0,
    );
    const identity = await loadExactRosterActionPlayerTeamIdentity(
      playerIds,
      actionBoundaryMilliseconds,
    );
    currentTeamAbbreviationByPlayerId = identity?.byPlayerId;
    authoritativeOutgoingAsset = applyCurrentNhlTeamIdentity(
      preflightAssets.outgoingAsset,
      identity?.byPlayerId,
    );
    const authoritativeIncomingAsset = applyCurrentNhlTeamIdentity(
      preflightAssets.incomingAsset,
      identity?.byPlayerId,
    );
    resolvedIncomingAsset = applyCurrentNhlTeamIdentity(
      await resolveIncomingProjectionForCycle(
        input.leagueId,
        input.expectedEffectiveCycleNumber,
        rosterAssetToDraftableAsset(authoritativeIncomingAsset),
      ),
      identity?.byPlayerId,
    );

    const evidence = preflightCycleEvidence.evidenceByCycle.get(
      input.expectedEffectiveCycleNumber,
    );
    const targetPick = evidence?.picks.find(
      (pick) => asNonEmptyString(pick['rosterSlotId']) === input.activeSlotId,
    );
    const targetWindow = evidence
      ? findEvidenceWindow(
          evidence,
          (window) => asNonEmptyString(window['rosterSlotId']) === input.activeSlotId,
        )
      : null;
    if (
      !evidence ||
      !targetPick ||
      targetPick['injuryReplacementWindow'] != null
    ) {
      throw new HttpsError(
        'aborted',
        'The selected matchup assignment changed while the move was checked.',
        { reason: 'swap-timing-conflict' },
      );
    }
    const sourceGameIdsByTeam = asRecord(
      evidence.data['sourceNhlTargetGameIdsByTeam'],
    );
    const savedWindowGameIds = targetWindow?.['scheduledGameIds'];
    const outgoingFrozenGameIds =
      savedWindowGameIds === undefined ||
        (Array.isArray(savedWindowGameIds) && savedWindowGameIds.length === 0)
        ? targetPick['sourceNhlTargetGameIds']
        : savedWindowGameIds;
    const outgoingGameIds = requireCompleteFrozenGameIds({
      value: outgoingFrozenGameIds,
      requiredGamesPerCycle: input.requiredGamesPerCycle,
      assignment: 'outgoing',
    });
    const incomingTeamAbbreviation = rosterAssetTeamAbbreviation(
      resolvedIncomingAsset,
    );
    const incomingGameIds = requireCompleteFrozenGameIds({
      value: sourceGameIdsByTeam[incomingTeamAbbreviation],
      requiredGamesPerCycle: input.requiredGamesPerCycle,
      assignment: 'incoming',
    });
    verifiedOutgoingGameIds = outgoingGameIds;
    verifiedIncomingGameIds = incomingGameIds;
    scheduleEvidence = await loadUntouchedRosterSwapScheduleEvidence({
      outgoingTeamAbbreviation: rosterAssetTeamAbbreviation(
        authoritativeOutgoingAsset,
      ),
      outgoingScheduledGameIds: outgoingGameIds,
      incomingTeamAbbreviation,
      incomingScheduledGameIds: incomingGameIds,
      boundaryMilliseconds: actionBoundaryMilliseconds,
    });
    if (scheduleEvidence.startedReason) {
      const freshTiming = resolveFutureLineupSwapTiming({
        requestedCycleNumber: input.requestedCycleNumber,
        regularSeasonCycleCount: input.regularSeasonCycleCount,
        latestCycleNumber: preflightCycleEvidence.latestCycleNumber,
        incomingEligibleFromCycleNumber,
        activeSlotId: input.activeSlotId,
        outgoingAssetKey: input.expectedOutgoingAssetKey,
        incomingAssetKey: input.expectedIncomingAssetKey,
        evidenceByCycle: preflightCycleEvidence.evidenceByCycle,
        allowMaterializedSwap: preflightAssets.ownershipShape === 'physical-swap',
        freshStartedReasonByCycle: new Map([
          [input.expectedEffectiveCycleNumber, scheduleEvidence.startedReason],
        ]),
      });
      throw new HttpsError(
        'aborted',
        `An NHL game reached puck drop. Review Matchup ${freshTiming.effectiveCycleNumber} and try again.`,
        {
          reason: 'swap-timing-conflict',
          mode: freshTiming.mode,
          timingReason: freshTiming.timingReason,
          effectiveCycleNumber: freshTiming.effectiveCycleNumber,
          startedGameIds: scheduleEvidence.startedGameIds,
        },
      );
    }
  }

  const mutationStateRef = expectedMutationStateRef;
  const leagueRef = db.doc(`leagues/${input.leagueId}`);
  const rosterRef = db.doc(
    `leagues/${input.leagueId}/teams/${input.ownerId}/roster/current`,
  );
  const teamRef = db.doc(`leagues/${input.leagueId}/teams/${input.ownerId}`);
  const memberRef = db.doc(`leagues/${input.leagueId}/members/${input.ownerId}`);
  const draftRef = db.doc(`leagues/${input.leagueId}/draft/current`);
  const replayRef = db.doc(
    `leagues/${input.leagueId}/historicalReplay/control`,
  );
  const targetCycleRef = db.doc(
    `leagues/${input.leagueId}/cycles/cycle-${input.expectedEffectiveCycleNumber}`,
  );
  const targetPickRef = getTargetPickRef(
    input.leagueId,
    input.expectedEffectiveCycleNumber,
    input.ownerId,
    input.activeSlotId,
  );
  const targetTeamWindowsRef = targetCycleRef
    .collection('teamWindows')
    .doc(input.ownerId);
  const siblingPlansQuery = db.collection(
    `leagues/${input.leagueId}/teams/${input.ownerId}/lineupPlans`,
  ).limit(MAX_FUTURE_MATCHUP_PLAN_COUNT + 1);
  const cyclesQuery = db.collection(`leagues/${input.leagueId}/cycles`)
    .orderBy('cycleNumber', 'asc')
    .limit(input.regularSeasonCycleCount + 1);
  const mutationAt = Timestamp.now();

  return db.runTransaction(async (transaction) => {
    const [
      mutationStateSnapshot,
      planSnapshot,
      requestedPlanSnapshot,
      leagueSnapshot,
      rosterSnapshot,
      teamSnapshot,
      memberSnapshot,
      draftSnapshot,
      historicalReplaySnapshot,
      siblingPlansSnapshot,
      cyclesSnapshot,
      targetCycleSnapshot,
      targetPickSnapshot,
      targetTeamWindowsSnapshot,
    ] = await Promise.all([
      transaction.get(mutationStateRef),
      transaction.get(planRef),
      transaction.get(requestedPlanRef),
      transaction.get(leagueRef),
      transaction.get(rosterRef),
      transaction.get(teamRef),
      transaction.get(memberRef),
      transaction.get(draftRef),
      transaction.get(replayRef),
      transaction.get(siblingPlansQuery),
      transaction.get(cyclesQuery),
      transaction.get(targetCycleRef),
      transaction.get(targetPickRef),
      transaction.get(targetTeamWindowsRef),
    ]);
    const transactionCycleEvidence = await Promise.all(
      cyclesSnapshot.docs.map(async (cycle) => {
        const cycleNumber = cycle.data()?.['cycleNumber'];
        if (
          typeof cycleNumber !== 'number' ||
          !Number.isSafeInteger(cycleNumber) ||
          cycleNumber < 1 ||
          cycle.id !== `cycle-${cycleNumber}`
        ) {
          throw new HttpsError(
            'failed-precondition',
            'The saved matchup authority is malformed.',
            { reason: 'cycle-state-invalid' },
          );
        }
        const [picksSnapshot, teamWindowsSnapshot] = await Promise.all([
          transaction.get(
            cycle.ref.collection('rosterPicks').where('ownerId', '==', input.ownerId),
          ),
          transaction.get(cycle.ref.collection('teamWindows').doc(input.ownerId)),
        ]);

        return {
          cycleNumber,
          phase: cycle.data()?.['phase'],
          status: cycle.data()?.['status'],
          data: asRecord(cycle.data()),
          picks: picksSnapshot.docs.map((pick) => asRecord(pick.data())),
          teamWindows: teamWindowsSnapshot.exists
            ? asRecord(teamWindowsSnapshot.data())
            : null,
        } satisfies FutureLineupSwapCycleEvidence;
      }),
    );

    if (
      !leagueSnapshot.exists ||
      !teamSnapshot.exists ||
      teamSnapshot.data()?.['ownerId'] !== input.ownerId ||
      !memberSnapshot.exists
    ) {
      throw new HttpsError(
        'permission-denied',
        'You do not own a team in this league.',
      );
    }
    const transactionRequiredGamesPerCycle =
      requireLeagueRequiredGamesPerCycle(asRecord(leagueSnapshot.data()));
    if (transactionRequiredGamesPerCycle !== input.requiredGamesPerCycle) {
      throw new HttpsError(
        'aborted',
        'The league scoring contract changed while the matchup move was checked.',
        { reason: 'swap-timing-conflict' },
      );
    }
    if (!draftSnapshot.exists || draftSnapshot.data()?.['status'] !== 'complete') {
      throw new HttpsError(
        'failed-precondition',
        'Finish the draft before changing future matchup lineups.',
        { reason: 'draft-incomplete' },
      );
    }
    if (
      historicalReplaySnapshot.exists &&
      historicalReplaySnapshot.data()?.['enabled'] === true
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Future matchup lineups are unavailable during historical replay.',
        { reason: 'historical-replay-active' },
      );
    }
    if (!rosterSnapshot.exists) {
      throw new HttpsError(
        'failed-precondition',
        'Your authoritative roster is unavailable.',
        { reason: 'roster-unavailable' },
      );
    }
    if (siblingPlansSnapshot.size > MAX_FUTURE_MATCHUP_PLAN_COUNT) {
      throw new HttpsError(
        'failed-precondition',
        'The saved lineup-plan set is unexpectedly large and needs support review.',
        { reason: 'lineup-plan-limit-exceeded' },
      );
    }

    const savedMutationState = mutationState(
      mutationStateSnapshot.exists ? mutationStateSnapshot.data() : undefined,
    );
    const replay = existingMutationResponse({
      receipts: savedMutationState.receipts,
      requestIdHash: savedRequestIdHash,
      requestHash,
    });
    if (replay) {
      return replay;
    }
    const savedRoster = normalizeFantasyRoster(
      rosterSnapshot.data() as Partial<FantasyRoster>,
    );
    const existingPlan = planSnapshot.exists
      ? requireSavedPlan({
          value: planSnapshot.data(),
          ownerId: input.ownerId,
          cycleNumber: input.expectedEffectiveCycleNumber,
          documentId: planSnapshot.id,
        })
      : null;
    const requestedPlan = requestedPlanSnapshot.exists
      ? requireSavedPlan({
          value: requestedPlanSnapshot.data(),
          ownerId: input.ownerId,
          cycleNumber: input.requestedCycleNumber,
          documentId: requestedPlanSnapshot.id,
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
    const evidenceByCycle = new Map(
      transactionCycleEvidence.map((entry) => [entry.cycleNumber, entry] as const),
    );
    if (
      input.requestedCycleNumber === FIRST_CYCLE_NUMBER &&
      !evidenceByCycle.has(FIRST_CYCLE_NUMBER)
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Matchup 1 lineup authority changed while the move was checked.',
        { reason: 'cycle-state-invalid', cycleNumber: FIRST_CYCLE_NUMBER },
      );
    }
    const latestCycleNumber = transactionCycleEvidence.reduce(
      (latest, entry) => Math.max(latest, entry.cycleNumber),
      0,
    );
    const transactionAssets = validateFutureLineupSwapRoster({
      roster: savedRoster,
      ownerId: input.ownerId,
      requestedCycleNumber: input.requestedCycleNumber,
      activeSlotId: input.activeSlotId,
      benchSlotId: input.benchSlotId,
      expectedOutgoingAssetKey: input.expectedOutgoingAssetKey,
      expectedIncomingAssetKey: input.expectedIncomingAssetKey,
      requestedPlan,
      requestedCycleEvidence:
        evidenceByCycle.get(input.requestedCycleNumber) ?? null,
    });
    if (verifiedPromotionScheduleByCycle.size > 0) {
      if (
        transactionAssets.ownershipShape !== 'physical-promotion' ||
        !promotionIncomingTeamAbbreviation
      ) {
        throw new HttpsError(
          'aborted',
          'The selected empty roster slot changed while the move was checked.',
          { reason: 'swap-timing-conflict' },
        );
      }
      for (
        const [cycleNumber, verifiedPromotion] of
        verifiedPromotionScheduleByCycle
      ) {
        const promotionEvidence = evidenceByCycle.get(cycleNumber);
        const targetPicks = promotionEvidence?.picks.filter(
          (pick) => asNonEmptyString(pick['rosterSlotId']) === input.activeSlotId,
        ) ?? [];
        const targetWindow = promotionEvidence
          ? findEvidenceWindow(
              promotionEvidence,
              (window) =>
                asNonEmptyString(window['rosterSlotId']) === input.activeSlotId,
            )
          : null;
        if (
          !promotionEvidence ||
          promotionEvidence.phase !== 'regular_season' ||
          promotionEvidence.status !== 'active' ||
          targetPicks.length > 0 ||
          targetWindow
        ) {
          throw new HttpsError(
            'aborted',
            'The selected empty roster slot changed while the move was checked.',
            { reason: 'swap-timing-conflict' },
          );
        }
        const sourceGameIdsByTeam = asRecord(
          promotionEvidence.data['sourceNhlTargetGameIdsByTeam'],
        );
        const transactionIncomingGameIds = requireCompleteFrozenGameIds({
          value: sourceGameIdsByTeam[promotionIncomingTeamAbbreviation],
          requiredGamesPerCycle: transactionRequiredGamesPerCycle,
          assignment: 'incoming',
        });
        if (
          !sameGameIds(
            transactionIncomingGameIds,
            verifiedPromotion.incomingGameIds,
          )
        ) {
          throw new HttpsError(
            'aborted',
            'The frozen NHL game block changed while the matchup move was checked.',
            { reason: 'swap-timing-conflict' },
          );
        }
        if (!verifiedPromotion.scheduleEvidence.startedReason) {
          const crossedGameIds =
            getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds({
              startMillisecondsByGameId:
                verifiedPromotion.scheduleEvidence.startMillisecondsByGameId,
              observedAtMilliseconds: Date.now(),
            });
          if (crossedGameIds.length > 0) {
            const crossedFreshStartedReasonByCycle = new Map(
              freshStartedReasonByCycle,
            );
            crossedFreshStartedReasonByCycle.set(
              cycleNumber,
              'incoming-started',
            );
            const crossedTiming = resolveFutureLineupSwapTiming({
              requestedCycleNumber: input.requestedCycleNumber,
              regularSeasonCycleCount: input.regularSeasonCycleCount,
              latestCycleNumber,
              incomingEligibleFromCycleNumber: Math.max(
                1,
                transactionAssets.incomingAsset.eligibleFromCycleNumber ?? 1,
              ),
              activeSlotId: input.activeSlotId,
              outgoingAssetKey: input.expectedOutgoingAssetKey,
              incomingAssetKey: input.expectedIncomingAssetKey,
              evidenceByCycle,
              allowMaterializedSwap: false,
              freshStartedReasonByCycle: crossedFreshStartedReasonByCycle,
            });
            throw new HttpsError(
              'aborted',
              `NHL game ${crossedGameIds.join(', ')} reached puck drop while the matchup move was checked.`,
              {
                reason: 'swap-timing-conflict',
                mode: crossedTiming.mode,
                timingReason: crossedTiming.timingReason,
                effectiveCycleNumber: crossedTiming.effectiveCycleNumber,
                startedGameIds: crossedGameIds,
              },
            );
          }
        }
      }
    }
    const timing = resolveFutureLineupSwapTiming({
      requestedCycleNumber: input.requestedCycleNumber,
      regularSeasonCycleCount: input.regularSeasonCycleCount,
      latestCycleNumber,
      incomingEligibleFromCycleNumber: Math.max(
        1,
        transactionAssets.incomingAsset.eligibleFromCycleNumber ?? 1,
      ),
      activeSlotId: input.activeSlotId,
      outgoingAssetKey: input.expectedOutgoingAssetKey,
      incomingAssetKey: input.expectedIncomingAssetKey,
      evidenceByCycle,
      allowMaterializedSwap: transactionAssets.ownershipShape === 'physical-swap',
      freshStartedReasonByCycle,
    });
    if (
      timing.effectiveCycleNumber !== input.expectedEffectiveCycleNumber ||
      timing.application !== preflightTiming.application
    ) {
      throw new HttpsError(
        'aborted',
        `The matchup timing changed. Review Matchup ${timing.effectiveCycleNumber} and try again.`,
        {
          reason: 'swap-timing-conflict',
          mode: timing.mode,
          timingReason: timing.timingReason,
          effectiveCycleNumber: timing.effectiveCycleNumber,
        },
      );
    }

    const targetEvidence = evidenceByCycle.get(
      input.expectedEffectiveCycleNumber,
    ) ?? null;
    const targetPicksBySlotId = new Map(
      (targetEvidence?.picks ?? []).flatMap((pick) => {
        const rosterSlotId = asNonEmptyString(pick['rosterSlotId']);
        return rosterSlotId ? [[rosterSlotId, pick] as const] : [];
      }),
    );
    const existingSlotById = new Map(
      existingPlan?.slots.map((slot) => [slot.rosterSlotId, slot] as const) ?? [],
    );
    const requestedSlots: RequestedFutureMatchupLineupSlot[] =
      savedRoster.activeSlots.map((slot) => {
        const pick = targetPicksBySlotId.get(slot.slotId);
        const existingSlot = existingSlotById.get(slot.slotId);
        const assetKey = slot.slotId === input.activeSlotId
          ? input.expectedIncomingAssetKey
          : existingSlot?.assetKey ??
            ((pick
              ? rosterPickAssetKey(pick)
              : getFutureLineupRosterAssetKey(slot.asset)) || null);

        return { rosterSlotId: slot.slotId, assetKey };
      });
    const lockedRosterSlotIds = new Set(targetPicksBySlotId.keys());
    if (timing.application === 'materialized-swap') {
      lockedRosterSlotIds.delete(input.activeSlotId);
    }
    let normalizedSlots: RequestedFutureMatchupLineupSlot[];
    try {
      normalizedSlots = validateFutureMatchupLineupSlots(
        savedRoster,
        requestedSlots,
        {
          lockedRosterSlotIds,
          targetCycleNumber: input.expectedEffectiveCycleNumber,
        },
      );
    } catch (error: unknown) {
      throw new HttpsError(
        'aborted',
        'Your roster changed while the matchup move was being saved.',
        {
          reason: 'roster-revision-conflict',
          message: error instanceof Error ? error.message : undefined,
        },
      );
    }

    const revision = savedMutationState.latestRevision + 1;
    const planSlots: FutureMatchupLineupSlot[] = normalizedSlots.map((slot) => {
      const pick = targetPicksBySlotId.get(slot.rosterSlotId);
      const existingSlot = existingSlotById.get(slot.rosterSlotId);
      if (
        slot.rosterSlotId === input.activeSlotId &&
        timing.application === 'materialized-swap'
      ) {
        return {
          rosterSlotId: slot.rosterSlotId,
          assetKey: input.expectedIncomingAssetKey,
          resolution: 'applied',
          resolvedAssetKey: input.expectedIncomingAssetKey,
          resolvedAt: mutationAt,
        };
      }
      if (pick) {
        const pickAssetKey = rosterPickAssetKey(pick) || null;
        if (existingSlot && existingSlot.resolution !== 'planned') {
          return existingSlot;
        }
        return {
          rosterSlotId: slot.rosterSlotId,
          assetKey: existingSlot?.assetKey ?? pickAssetKey,
          resolution:
            (existingSlot?.assetKey ?? pickAssetKey) === pickAssetKey
              ? 'unchanged'
              : 'conflict',
          resolvedAssetKey: pickAssetKey,
          ...((existingSlot?.assetKey ?? pickAssetKey) === pickAssetKey
            ? {}
            : { reason: 'target-window-already-materialized' as const }),
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
      planSlots.flatMap((slot) =>
        slot.assetKey &&
          (slot.resolution === 'planned' || slot.rosterSlotId === input.activeSlotId)
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
        const requestedSlotId = requestedSlotByAssetKey.get(siblingSlot.assetKey);
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

    const assignmentHash = createFutureMatchupLineupAssignmentHash(planSlots);
    const plan: FutureMatchupLineupPlan = {
      schemaVersion: FUTURE_MATCHUP_LINEUP_SCHEMA_VERSION,
      ownerId: input.ownerId,
      cycleNumber: input.expectedEffectiveCycleNumber,
      revision,
      status: deriveFutureMatchupLineupPlanStatus(planSlots),
      assignmentHash,
      slots: planSlots,
      createdAt: existingPlan?.createdAt ?? mutationAt,
      updatedAt: mutationAt,
    };
    const response: ManageFutureMatchupLineupsResult = {
      operation: 'swap',
      mode: timing.mode,
      requestedCycleNumber: input.requestedCycleNumber,
      effectiveCycleNumber: timing.effectiveCycleNumber,
      timingReason: timing.timingReason,
      plan: planView(plan),
      effectiveStart: {
        cycleNumber: timing.effectiveCycleNumber,
        evidence: 'lineup-plan-boundary',
        reason: swapTimingReasonText(
          timing.timingReason,
          input.requestedCycleNumber,
          timing.effectiveCycleNumber,
        ),
      },
    };

    if (timing.application === 'materialized-swap') {
      const transactionOutgoingRosterAsset = transactionAssets.outgoingAsset;
      if (
        !targetCycleSnapshot.exists ||
        targetCycleSnapshot.data()?.['phase'] !== 'regular_season' ||
        targetCycleSnapshot.data()?.['status'] !== 'active' ||
        !targetPickSnapshot.exists ||
        !resolvedIncomingAsset ||
        !scheduleEvidence ||
        !verifiedOutgoingGameIds ||
        !verifiedIncomingGameIds ||
        !transactionOutgoingRosterAsset
      ) {
        throw new HttpsError(
          'aborted',
          'The selected matchup assignment changed while the move was checked.',
          { reason: 'swap-timing-conflict' },
        );
      }
      const savedPick = asRecord(targetPickSnapshot.data());
      if (
        asNonEmptyString(savedPick['ownerId']) !== input.ownerId ||
        asNonEmptyString(savedPick['rosterSlotId']) !== input.activeSlotId ||
        rosterPickAssetKey(savedPick) !== input.expectedOutgoingAssetKey ||
        savedPick['injuryReplacementWindow'] != null
      ) {
        throw new HttpsError(
          'aborted',
          'The selected matchup roster pick changed while the move was checked.',
          { reason: 'swap-timing-conflict' },
        );
      }
      const teamWindowsData = targetTeamWindowsSnapshot.exists
        ? asRecord(targetTeamWindowsSnapshot.data())
        : {};
      const windows = Array.isArray(teamWindowsData['windows'])
        ? (teamWindowsData['windows'] as unknown[]).map(asRecord)
        : [];
      const matchingWindowIndexes = windows.flatMap((window, index) =>
        asNonEmptyString(window['rosterSlotId']) === input.activeSlotId
          ? [index]
          : [],
      );
      if (matchingWindowIndexes.length > 1) {
        throw new HttpsError(
          'failed-precondition',
          'The selected roster slot has duplicate scoring windows.',
          { reason: 'plan-state-invalid' },
        );
      }
      const windowIndex = matchingWindowIndexes[0] ?? -1;
      if (windowIndex < 0) {
        throw new HttpsError(
          'aborted',
          'The selected matchup scoring window disappeared while the move was checked.',
          { reason: 'swap-timing-conflict' },
        );
      }
      let previousWindow: Record<string, unknown>;
      try {
        previousWindow = requireUntouchedFutureMatchupWindow({
          value: windows[windowIndex],
          identity: {
            ownerId: input.ownerId,
            rosterSlotId: input.activeSlotId,
            cycleNumber: input.expectedEffectiveCycleNumber,
            assetKey: input.expectedOutgoingAssetKey,
          },
        });
      } catch (error: unknown) {
        throw new HttpsError(
          'aborted',
          'The selected matchup scoring window changed while the move was checked.',
          {
            reason: 'swap-timing-conflict',
            message: error instanceof Error ? error.message : undefined,
          },
        );
      }
      const transactionWindowGameIds = previousWindow['scheduledGameIds'];
      const transactionOutgoingFrozenGameIds =
        transactionWindowGameIds === undefined ||
          (Array.isArray(transactionWindowGameIds) &&
            transactionWindowGameIds.length === 0)
          ? savedPick['sourceNhlTargetGameIds']
          : transactionWindowGameIds;
      const transactionOutgoingGameIds = requireCompleteFrozenGameIds({
        value: transactionOutgoingFrozenGameIds,
        requiredGamesPerCycle: transactionRequiredGamesPerCycle,
        assignment: 'outgoing',
      });
      const sourceGameIdsByTeam = asRecord(
        targetCycleSnapshot.data()?.['sourceNhlTargetGameIdsByTeam'],
      );
      const incomingTeamAbbreviation = rosterAssetTeamAbbreviation(
        resolvedIncomingAsset,
      );
      const incomingSourceGameIds = requireCompleteFrozenGameIds({
        value: sourceGameIdsByTeam[incomingTeamAbbreviation],
        requiredGamesPerCycle: transactionRequiredGamesPerCycle,
        assignment: 'incoming',
      });
      if (
        !sameGameIds(transactionOutgoingGameIds, verifiedOutgoingGameIds) ||
        !sameGameIds(incomingSourceGameIds, verifiedIncomingGameIds)
      ) {
        throw new HttpsError(
          'aborted',
          'The frozen NHL game block changed while the matchup move was checked.',
          { reason: 'swap-timing-conflict' },
        );
      }
      const crossedGameIds =
        getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds({
          startMillisecondsByGameId:
            scheduleEvidence.startMillisecondsByGameId,
          observedAtMilliseconds: Date.now(),
        });
      if (crossedGameIds.length > 0) {
        throw new HttpsError(
          'aborted',
          `NHL game ${crossedGameIds.join(', ')} reached puck drop while the matchup move was checked.`,
          { reason: 'swap-timing-conflict' },
        );
      }
      const continuity = createPlayerWindowContinuity({
        ownerId: input.ownerId,
        rosterSlotId: input.activeSlotId,
        asset: resolvedIncomingAsset,
        activationKey: `lineup-swap-${savedRequestIdHash}`,
        assignmentNotBefore: Date.now(),
      });
      const nowIso = new Date().toISOString();
      const transactionOutgoingAsset = applyCurrentNhlTeamIdentity(
        transactionOutgoingRosterAsset,
        currentTeamAbbreviationByPlayerId,
      );
      const resetWindow = buildFutureMatchupResetWindow({
        previous: previousWindow,
        asset: resolvedIncomingAsset,
        ownerId: input.ownerId,
        rosterSlotId: input.activeSlotId,
        cycleNumber: input.expectedEffectiveCycleNumber,
        playerWindowContinuity: continuity ?? null,
        nowIso,
      });
      if (windowIndex >= 0) {
        windows[windowIndex] = resetWindow;
      } else {
        windows.push(resetWindow);
      }
      const expectedRosterSlotIds = requireCompleteTeamWindowSlotEvidence({
        teamWindows: teamWindowsData,
        cycle: asRecord(targetCycleSnapshot.data()),
        windows,
        ownerId: input.ownerId,
        cycleNumber: input.expectedEffectiveCycleNumber,
        activeSlotId: input.activeSlotId,
      });
      const completedWindowCount = windows.filter(
        (window) => asNonEmptyString(window['status']) === 'complete',
      ).length;
      const hasStartedWindow = windows.some(
        (window) => futureMatchupWindowOwnershipStarted(window),
      );
      const teamWindowStatus =
        completedWindowCount === expectedRosterSlotIds.length
          ? 'complete'
          : hasStartedWindow
            ? 'active'
            : 'scheduled';

      const activeSlotIndex = savedRoster.activeSlots.findIndex(
        (slot) => slot.slotId === input.activeSlotId,
      );
      const benchSlotIndex = savedRoster.benchSlots.findIndex(
        (slot) => slot.slotId === input.benchSlotId,
      );
      savedRoster.activeSlots[activeSlotIndex] = {
        ...savedRoster.activeSlots[activeSlotIndex],
        asset: createActiveRosterAsset(
          resolvedIncomingAsset,
          input.expectedEffectiveCycleNumber,
        ),
        pendingMove: null,
        openFromCycleNumber: null,
      };
      savedRoster.benchSlots[benchSlotIndex] = {
        ...savedRoster.benchSlots[benchSlotIndex],
        asset: {
          ...transactionOutgoingAsset,
          rosterStatus: 'benched',
        },
      };
      const {
        sourceNhlTargetGameIds: _outgoingSourceGameIds,
        injuryReplacementWindow: _outgoingInjuryReplacementWindow,
        ...savedPickBase
      } = savedPick;
      transaction.set(targetPickRef, {
        ...savedPickBase,
        asset: resolvedIncomingAsset,
        rosterArea: 'active',
        rosterSlotId: input.activeSlotId,
        snapshotCycleNumber: input.expectedEffectiveCycleNumber,
        snapshotSource: 'future-lineup-plan',
        playerWindowContinuity: continuity ?? null,
        sourceNhlTargetGameIds: incomingSourceGameIds,
        sourceNhlTargetGameIdsByTeam: sourceGameIdsByTeam,
        snapshottedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(rosterRef, {
        schemaVersion: savedRoster.schemaVersion,
        activeSlots: savedRoster.activeSlots,
        benchSlots: savedRoster.benchSlots,
        irSlots: savedRoster.irSlots,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(targetTeamWindowsRef, {
        id: input.ownerId,
        ownerId: input.ownerId,
        cycleNumber: input.expectedEffectiveCycleNumber,
        expectedRosterSlotIds,
        windows,
        completedWindowCount,
        totalWindowCount: expectedRosterSlotIds.length,
        status: teamWindowStatus,
        completedAt: teamWindowStatus === 'complete'
          ? teamWindowsData['completedAt'] ?? FieldValue.serverTimestamp()
          : null,
        createdAt: teamWindowsData['createdAt'] ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      const auditIdentityHash = createHash('sha256')
        .update(JSON.stringify({
          ownerId: input.ownerId,
          cycleNumber: input.expectedEffectiveCycleNumber,
          requestIdHash: savedRequestIdHash,
        }))
        .digest('hex');
      const auditRef = db.doc(
        `leagues/${input.leagueId}/transactions/future-lineup-swap-${auditIdentityHash}`,
      );
      transaction.set(auditRef, {
        type: 'active-bench-swap-activated',
        ownerId: input.ownerId,
        activeSlotId: input.activeSlotId,
        benchSlotId: input.benchSlotId,
        rosterSlotId: input.activeSlotId,
        movedAsset: resolvedIncomingAsset,
        outgoingAsset: transactionOutgoingAsset,
        effectiveCycleNumber: input.expectedEffectiveCycleNumber,
        effectiveLabel: `Matchup ${input.expectedEffectiveCycleNumber}`,
        immediateUntouchedWindow: true,
        futureMatchupLineupRequestIdHash: savedRequestIdHash,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

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

    const expectedRevision = requireExpectedRevision(data['expectedRevision']);
    const requestId = requireFirestoreDocumentId(
      data['requestId'],
      'lineup request ID',
      FIRESTORE_REQUEST_ID_OPTIONS,
    );
    const preconditions = await requireOwnerPreconditions(leagueId, ownerId);

    if (operation === 'swap') {
      const requestedCycleNumber = requireCycleNumber(
        data['requestedCycleNumber'],
      );
      const expectedEffectiveCycleNumber = requireCycleNumber(
        data['expectedEffectiveCycleNumber'],
      );
      const activeSlotId = requireFirestoreDocumentId(
        data['activeSlotId'],
        'active roster slot ID',
        FIRESTORE_ROSTER_SLOT_ID_OPTIONS,
      );
      const benchSlotId = requireFirestoreDocumentId(
        data['benchSlotId'],
        'bench roster slot ID',
        FIRESTORE_ROSTER_SLOT_ID_OPTIONS,
      );
      const expectedOutgoingAssetKey = data['expectedOutgoingAssetKey'] === null
        ? null
        : requireFirestoreDocumentId(
            data['expectedOutgoingAssetKey'],
            'expected outgoing asset',
            FIRESTORE_ASSET_KEY_OPTIONS,
          );
      const expectedIncomingAssetKey = requireFirestoreDocumentId(
        data['expectedIncomingAssetKey'],
        'expected incoming asset',
        FIRESTORE_ASSET_KEY_OPTIONS,
      );
      assertRegularSeasonSwapCycle(
        requestedCycleNumber,
        preconditions.regularSeasonCycleCount,
      );
      assertRegularSeasonSwapCycle(
        expectedEffectiveCycleNumber,
        preconditions.regularSeasonCycleCount,
      );
      if (expectedEffectiveCycleNumber < requestedCycleNumber) {
        throw new HttpsError(
          'invalid-argument',
          'The effective matchup cannot precede the selected matchup.',
        );
      }

      return swapFutureMatchupLineup({
        leagueId,
        ownerId,
        requestedCycleNumber,
        expectedEffectiveCycleNumber,
        activeSlotId,
        benchSlotId,
        expectedRevision,
        requestId,
        expectedOutgoingAssetKey,
        expectedIncomingAssetKey,
        roster: preconditions.roster,
        regularSeasonCycleCount: preconditions.regularSeasonCycleCount,
        requiredGamesPerCycle: preconditions.requiredGamesPerCycle,
      });
    }

    const cycleNumber = requireCycleNumber(data['cycleNumber']);
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
