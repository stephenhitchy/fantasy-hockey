import { createHash } from 'node:crypto';

import {
  ActiveRosterPosition,
  FantasyRoster,
  RosterAsset,
} from './roster.models';
import { DraftableAsset } from '../draft/draft.models';

export const FUTURE_MATCHUP_LINEUP_SCHEMA_VERSION = 1;

export type FutureMatchupLineupPlanStatus =
  | 'planned'
  | 'partially-applied'
  | 'applied'
  | 'conflicted';

export type FutureMatchupLineupSlotResolution =
  | 'planned'
  | 'applied'
  | 'unchanged'
  | 'conflict';

export type FutureMatchupLineupConflictReason =
  | 'pending-roster-move'
  | 'desired-asset-unavailable'
  | 'desired-asset-not-benched'
  | 'position-mismatch'
  | 'roster-slot-missing'
  | 'roster-changed-during-rollover'
  | 'plan-changed-during-rollover'
  | 'target-window-already-materialized';

export interface FutureMatchupLineupSlot {
  rosterSlotId: string;
  /** The manager's requested assignment. It remains immutable after resolution. */
  assetKey: string | null;
  resolution: FutureMatchupLineupSlotResolution;
  /** The authoritative target-window assignment once this slot resolves. */
  resolvedAssetKey?: string | null;
  reason?: FutureMatchupLineupConflictReason | null;
  resolvedAt?: unknown;
}

export interface FutureMatchupLineupPlan {
  schemaVersion: typeof FUTURE_MATCHUP_LINEUP_SCHEMA_VERSION;
  ownerId: string;
  cycleNumber: number;
  revision: number;
  status: FutureMatchupLineupPlanStatus;
  assignmentHash: string;
  slots: FutureMatchupLineupSlot[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface RequestedFutureMatchupLineupSlot {
  rosterSlotId: string;
  assetKey: string | null;
}

export interface FutureLineupBoundaryResolution {
  kind: 'ignore' | 'unchanged' | 'swap' | 'conflict';
  desiredAssetKey: string | null;
  incomingAsset: RosterAsset | null;
  sourceBenchSlotId: string | null;
  reason: FutureMatchupLineupConflictReason | null;
}

export interface FutureMatchupUntouchedWindowIdentity {
  ownerId: string;
  rosterSlotId: string;
  cycleNumber: number;
  assetKey: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asPositiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A selected-matchup swap may rewrite only a window with no ownership event.
 * This deliberately checks every durable scoring/start marker instead of
 * assuming a zero score means the player has not played.
 */
export function futureMatchupWindowOwnershipStarted(value: unknown): boolean {
  const window = asRecord(value);
  const status = asNonEmptyString(window['status']);
  const gameStates = asRecord(window['gameStates']);

  return status === 'active' ||
    status === 'complete' ||
    window['startedAt'] != null ||
    window['completedAt'] != null ||
    asFiniteNumber(window['gamesPlayed']) !== 0 ||
    asFiniteNumber(window['actualGamesPlayed']) !== 0 ||
    asFiniteNumber(window['fantasyPoints']) !== 0 ||
    asArray(window['completedGameIds']).length > 0 ||
    asArray(window['liveGameIds']).length > 0 ||
    asArray(window['appearanceGameIds']).length > 0 ||
    asArray(window['incompleteFinalGameIds']).length > 0 ||
    Object.keys(asRecord(window['gameScores'])).length > 0 ||
    Object.keys(asRecord(window['gameInputCompleteness'])).length > 0 ||
    Object.keys(asRecord(window['scoringAssetKeyByGameId'])).length > 0 ||
    window['injuryReplacementWindow'] != null ||
    Object.values(gameStates).some(
      (state) => state === 'live' || state === 'final',
    );
}

export function requireUntouchedFutureMatchupWindow(input: {
  value: unknown;
  identity: FutureMatchupUntouchedWindowIdentity;
}): Record<string, unknown> {
  const window = asRecord(input.value);
  const asset = asRecord(window['asset']);
  const exactZeroFields = [
    'gamesPlayed',
    'actualGamesPlayed',
    'fantasyPoints',
  ];
  const exactEmptyArrayFields = [
    'completedGameIds',
    'liveGameIds',
    'appearanceGameIds',
  ];
  const gameStates = asRecord(window['gameStates']);

  if (
    asNonEmptyString(window['ownerId']) !== input.identity.ownerId ||
    asNonEmptyString(window['rosterSlotId']) !== input.identity.rosterSlotId ||
    asPositiveInteger(window['cycleNumber']) !== input.identity.cycleNumber ||
    asNonEmptyString(window['assetKey']) !== input.identity.assetKey ||
    asNonEmptyString(asset['assetKey']) !== input.identity.assetKey ||
    asNonEmptyString(window['status']) !== 'scheduled' ||
    !Array.isArray(window['scheduledGameIds']) ||
    !Array.isArray(window['scheduledGameDates']) ||
    !Array.isArray(window['scheduledGameLabels']) ||
    exactZeroFields.some((field) => window[field] !== 0) ||
    exactEmptyArrayFields.some(
      (field) => !Array.isArray(window[field]) || window[field].length > 0,
    ) ||
    (window['incompleteFinalGameIds'] !== undefined &&
      (!Array.isArray(window['incompleteFinalGameIds']) ||
        window['incompleteFinalGameIds'].length > 0)) ||
    !window['gameStates'] ||
    typeof window['gameStates'] !== 'object' ||
    Array.isArray(window['gameStates']) ||
    Object.values(gameStates).some((state) => state !== 'scheduled') ||
    !window['gameScores'] ||
    typeof window['gameScores'] !== 'object' ||
    Array.isArray(window['gameScores']) ||
    Object.keys(asRecord(window['gameScores'])).length > 0 ||
    futureMatchupWindowOwnershipStarted(window)
  ) {
    throw new Error(
      `Future matchup window ${input.identity.ownerId}/` +
        `${input.identity.rosterSlotId}/cycle-${input.identity.cycleNumber} ` +
        'is not an exact untouched assignment.',
    );
  }

  return window;
}

/**
 * Rebuilds an exact scheduled window after authority has proved that no game,
 * point, or start marker belongs to the previous player. Started windows never
 * reach this helper.
 */
export function buildFutureMatchupResetWindow(input: {
  previous: unknown;
  asset: DraftableAsset;
  ownerId: string;
  rosterSlotId: string;
  cycleNumber: number;
  playerWindowContinuity: unknown;
  nowIso: string;
}): Record<string, unknown> {
  const previous = asRecord(input.previous);

  return {
    ...previous,
    id:
      asNonEmptyString(previous['id']) ||
      `${input.ownerId}__${input.rosterSlotId}__cycle-${input.cycleNumber}`,
    ownerId: input.ownerId,
    rosterSlotId: input.rosterSlotId,
    cycleNumber: input.cycleNumber,
    position: input.asset.position,
    assetKey: input.asset.assetKey,
    asset: input.asset,
    status: 'scheduled',
    scheduledGameIds: [],
    scheduledGameDates: [],
    scheduledGameLabels: [],
    scheduleTeamAbbreviation: null,
    sourceTeamAbbreviationByGameId: {},
    teamIdentityChanged: false,
    playerWindowContinuity: input.playerWindowContinuity,
    injuryReplacementWindow: null,
    scoringAssetKeyByGameId: {},
    completedGameIds: [],
    liveGameIds: [],
    appearanceGameIds: [],
    incompleteFinalGameIds: [],
    gameInputCompleteness: {},
    gameScores: {},
    gameStates: {},
    scheduledGames: 0,
    gamesPlayed: 0,
    actualGamesPlayed: 0,
    gamesLeft: 0,
    fantasyPoints: 0,
    frozenProjectionPoints:
      input.asset.frozenCycleProjectionPoints ??
      input.asset.projectedCyclePoints ??
      null,
    frozenProjectionVersion: input.asset.frozenProjectionVersion ?? null,
    frozenProjectionSource: input.asset.frozenProjectionSource ?? null,
    frozenProjectionSnapshotId:
      input.asset.frozenProjectionSnapshotId ??
      input.asset.sharedProjectionSnapshotId ??
      null,
    frozenProjectionGeneratedAt:
      input.asset.frozenProjectionGeneratedAt ??
      input.asset.projectionGeneratedAt ??
      null,
    frozenProjectionFrozenAt: input.nowIso,
    frozenProjectionTargetGameIds: [],
    firstScheduledGameDate: null,
    lastScheduledGameDate: null,
    startedAt: null,
    completedAt: null,
    createdAt: previous['createdAt'] ?? input.nowIso,
    updatedAt: input.nowIso,
  };
}

function isSlotResolution(value: unknown): value is FutureMatchupLineupSlotResolution {
  return value === 'planned' || value === 'applied' ||
    value === 'unchanged' || value === 'conflict';
}

function isConflictReason(value: unknown): value is FutureMatchupLineupConflictReason {
  return value === 'pending-roster-move' ||
    value === 'desired-asset-unavailable' ||
    value === 'desired-asset-not-benched' ||
    value === 'position-mismatch' ||
    value === 'roster-slot-missing' ||
    value === 'roster-changed-during-rollover' ||
    value === 'plan-changed-during-rollover' ||
    value === 'target-window-already-materialized';
}

export function getFutureLineupRosterAssetKey(asset: RosterAsset | null): string {
  if (!asset) {
    return '';
  }

  if (asset.assetKey) {
    return asset.assetKey;
  }

  if (asset.assetType === 'skater') {
    const player = asset.player as {
      id?: number | string;
      playerId?: number | string;
      nhlPlayerId?: number | string;
    };
    const playerId = player.id ?? player.playerId ?? player.nhlPlayerId;

    return playerId ? `skater-${playerId}` : '';
  }

  return asset.teamAbbreviation
    ? `goalie-unit-${asset.teamAbbreviation}`
    : '';
}

export function createFutureMatchupLineupAssignmentHash(
  slots: ReadonlyArray<RequestedFutureMatchupLineupSlot>,
): string {
  const canonical = [...slots]
    .sort((first, second) => first.rosterSlotId.localeCompare(second.rosterSlotId))
    .map((slot) => `${slot.rosterSlotId}:${slot.assetKey ?? '-'}`)
    .join('|');

  return createHash('sha256').update(canonical).digest('hex');
}

export function createFutureMatchupLineupActivationAuditDocumentId(input: {
  ownerId: string;
  cycleNumber: number;
  revision: number;
  rosterSlotId: string;
}): string {
  const identityHash = createHash('sha256')
    .update(JSON.stringify([
      input.ownerId,
      input.cycleNumber,
      input.revision,
      input.rosterSlotId,
    ]))
    .digest('hex');

  return `future-lineup-${identityHash}`;
}

export function deriveFutureMatchupLineupPlanStatus(
  slots: ReadonlyArray<FutureMatchupLineupSlot>,
): FutureMatchupLineupPlanStatus {
  if (slots.some((slot) => slot.resolution === 'conflict')) {
    return 'conflicted';
  }

  const resolvedCount = slots.filter(
    (slot) => slot.resolution === 'applied' || slot.resolution === 'unchanged',
  ).length;

  if (resolvedCount === 0) {
    return 'planned';
  }

  return resolvedCount === slots.length ? 'applied' : 'partially-applied';
}

export function getFutureMatchupLineupMaterializedSlotCount(
  plan: FutureMatchupLineupPlan,
): number {
  return plan.slots.filter((slot) => slot.resolution !== 'planned').length;
}

export function normalizeFutureMatchupLineupPlan(
  value: unknown,
): FutureMatchupLineupPlan | null {
  const data = asRecord(value);
  const ownerId = asNonEmptyString(data['ownerId']);
  const cycleNumber = asPositiveInteger(data['cycleNumber']);
  const revision = asPositiveInteger(data['revision']);
  const assignmentHash = asNonEmptyString(data['assignmentHash']);
  const sourceSlots = Array.isArray(data['slots']) ? data['slots'] : [];

  if (
    data['schemaVersion'] !== FUTURE_MATCHUP_LINEUP_SCHEMA_VERSION ||
    !ownerId ||
    !cycleNumber ||
    !revision ||
    !/^[a-f0-9]{64}$/.test(assignmentHash) ||
    sourceSlots.length === 0
  ) {
    return null;
  }

  const slots: FutureMatchupLineupSlot[] = [];
  const seenSlotIds = new Set<string>();

  for (const sourceSlot of sourceSlots) {
    const slotData = asRecord(sourceSlot);
    const rosterSlotId = asNonEmptyString(slotData['rosterSlotId']);
    const assetKeyValue = slotData['assetKey'];
    const assetKey = assetKeyValue === null ? null : asNonEmptyString(assetKeyValue);
    const resolution = slotData['resolution'];
    const resolvedAssetKeyValue = slotData['resolvedAssetKey'];
    const resolvedAssetKey = resolvedAssetKeyValue === null
      ? null
      : asNonEmptyString(resolvedAssetKeyValue);
    const hasResolvedAssetKey = Object.prototype.hasOwnProperty.call(
      slotData,
      'resolvedAssetKey',
    );

    if (
      !rosterSlotId ||
      seenSlotIds.has(rosterSlotId) ||
      (assetKeyValue !== null && !assetKey) ||
      !isSlotResolution(resolution) ||
      (resolution === 'planned' && hasResolvedAssetKey) ||
      (resolution !== 'planned' && !hasResolvedAssetKey) ||
      (hasResolvedAssetKey &&
        resolvedAssetKeyValue !== null &&
        !resolvedAssetKey)
    ) {
      return null;
    }

    seenSlotIds.add(rosterSlotId);
    const reason = isConflictReason(slotData['reason'])
      ? slotData['reason']
      : null;
    slots.push({
      rosterSlotId,
      assetKey,
      resolution,
      ...(resolution !== 'planned' ? { resolvedAssetKey } : {}),
      ...(reason ? { reason } : {}),
      ...(slotData['resolvedAt'] !== undefined
        ? { resolvedAt: slotData['resolvedAt'] }
        : {}),
    });
  }

  slots.sort((first, second) => first.rosterSlotId.localeCompare(second.rosterSlotId));
  if (createFutureMatchupLineupAssignmentHash(slots) !== assignmentHash) {
    return null;
  }

  return {
    schemaVersion: FUTURE_MATCHUP_LINEUP_SCHEMA_VERSION,
    ownerId,
    cycleNumber,
    revision,
    status: deriveFutureMatchupLineupPlanStatus(slots),
    assignmentHash,
    slots,
    createdAt: data['createdAt'],
    updatedAt: data['updatedAt'],
  };
}

function assetMatchesPosition(
  asset: RosterAsset,
  position: ActiveRosterPosition,
): boolean {
  return asset.position === position;
}

/**
 * Validates the complete desired active lineup against current ownership.
 * Existing active assets stay bound to their persistent active slot; only a
 * compatible bench asset may replace one. This restriction is what makes the
 * plan deterministic even though roster slots cross matchup boundaries at
 * different times.
 */
export function validateFutureMatchupLineupSlots(
  roster: FantasyRoster,
  requestedSlots: ReadonlyArray<RequestedFutureMatchupLineupSlot>,
  options: {
    lockedRosterSlotIds?: ReadonlySet<string>;
    targetCycleNumber: number;
  },
): RequestedFutureMatchupLineupSlot[] {
  if (requestedSlots.length !== roster.activeSlots.length) {
    throw new Error('A future lineup must include every active roster slot exactly once.');
  }

  const requestedBySlotId = new Map<string, RequestedFutureMatchupLineupSlot>();
  const desiredAssetKeys = new Set<string>();
  const activeOwnerSlotByAssetKey = new Map<string, string>();
  const ownedBenchAssetByKey = new Map<string, RosterAsset>();

  for (const activeSlot of roster.activeSlots) {
    const assetKey = getFutureLineupRosterAssetKey(activeSlot.asset);
    if (assetKey) {
      activeOwnerSlotByAssetKey.set(assetKey, activeSlot.slotId);
    }
  }

  for (const benchSlot of roster.benchSlots) {
    const assetKey = getFutureLineupRosterAssetKey(benchSlot.asset);
    if (assetKey && benchSlot.asset) {
      ownedBenchAssetByKey.set(assetKey, benchSlot.asset);
    }
  }

  for (const sourceSlot of requestedSlots) {
    const rosterSlotId = asNonEmptyString(sourceSlot.rosterSlotId);
    const assetKey = sourceSlot.assetKey === null
      ? null
      : asNonEmptyString(sourceSlot.assetKey);

    if (!rosterSlotId || requestedBySlotId.has(rosterSlotId)) {
      throw new Error('A future lineup contains a missing or duplicate roster slot.');
    }

    if (sourceSlot.assetKey !== null && !assetKey) {
      throw new Error(`Future lineup slot ${rosterSlotId} has an invalid asset.`);
    }

    if (assetKey && desiredAssetKeys.has(assetKey)) {
      throw new Error(`Asset ${assetKey} may appear in only one active roster slot.`);
    }

    if (assetKey) {
      desiredAssetKeys.add(assetKey);
    }
    requestedBySlotId.set(rosterSlotId, { rosterSlotId, assetKey });
  }

  for (const activeSlot of roster.activeSlots) {
    const requested = requestedBySlotId.get(activeSlot.slotId);
    if (!requested) {
      throw new Error(`Future lineup slot ${activeSlot.slotId} is required.`);
    }

    // A target pick or an earlier per-slot resolution is immutable. Its asset
    // may no longer be on the current roster, so ownership validation applies
    // only to the still-planned slots that the manager can actually edit.
    if (options.lockedRosterSlotIds?.has(activeSlot.slotId)) {
      continue;
    }

    const currentAssetKey = getFutureLineupRosterAssetKey(activeSlot.asset);

    if (requested.assetKey === null) {
      if (currentAssetKey) {
        throw new Error(
          `Occupied slot ${activeSlot.slotId} cannot be cleared by a lineup plan.`,
        );
      }
      continue;
    }

    if (requested.assetKey === currentAssetKey) {
      continue;
    }

    const activeOwnerSlotId = activeOwnerSlotByAssetKey.get(requested.assetKey);
    if (activeOwnerSlotId) {
      throw new Error(
        `Active asset ${requested.assetKey} must remain in ${activeOwnerSlotId}.`,
      );
    }

    const benchAsset = ownedBenchAssetByKey.get(requested.assetKey);
    if (!benchAsset) {
      throw new Error(
        `Asset ${requested.assetKey} is not currently active or benched for this team.`,
      );
    }

    if ((benchAsset.eligibleFromCycleNumber ?? 1) > options.targetCycleNumber) {
      throw new Error(
        `Asset ${requested.assetKey} is not eligible until Cycle ${benchAsset.eligibleFromCycleNumber}.`,
      );
    }

    if (!assetMatchesPosition(benchAsset, activeSlot.position)) {
      throw new Error(
        `Asset ${requested.assetKey} is not eligible for ${activeSlot.slotId}.`,
      );
    }
  }

  return roster.activeSlots
    .map((slot) => requestedBySlotId.get(slot.slotId)!)
    .sort((first, second) => first.rosterSlotId.localeCompare(second.rosterSlotId));
}

export function resolveFutureLineupSlotAtBoundary(input: {
  roster: FantasyRoster;
  rosterSlotId: string;
  planSlot: FutureMatchupLineupSlot;
  targetCycleNumber: number;
}): FutureLineupBoundaryResolution {
  const activeSlot = input.roster.activeSlots.find(
    (slot) => slot.slotId === input.rosterSlotId,
  );

  if (!activeSlot) {
    return {
      kind: 'conflict',
      desiredAssetKey: input.planSlot.assetKey,
      incomingAsset: null,
      sourceBenchSlotId: null,
      reason: 'roster-slot-missing',
    };
  }

  const currentAssetKey = getFutureLineupRosterAssetKey(activeSlot.asset);

  if (input.planSlot.resolution !== 'planned') {
    return {
      kind: 'ignore',
      desiredAssetKey: input.planSlot.assetKey,
      incomingAsset: activeSlot.asset,
      sourceBenchSlotId: null,
      reason: null,
    };
  }

  if (activeSlot.pendingMove) {
    return {
      kind: 'conflict',
      desiredAssetKey: input.planSlot.assetKey,
      incomingAsset: activeSlot.asset,
      sourceBenchSlotId: null,
      reason: 'pending-roster-move',
    };
  }

  if (input.planSlot.assetKey === null) {
    return currentAssetKey
      ? {
          kind: 'conflict',
          desiredAssetKey: null,
          incomingAsset: activeSlot.asset,
          sourceBenchSlotId: null,
          reason: 'roster-changed-during-rollover',
        }
      : {
          kind: 'unchanged',
          desiredAssetKey: null,
          incomingAsset: null,
          sourceBenchSlotId: null,
          reason: null,
        };
  }

  if (input.planSlot.assetKey === currentAssetKey) {
    return {
      kind: 'unchanged',
      desiredAssetKey: input.planSlot.assetKey,
      incomingAsset: activeSlot.asset,
      sourceBenchSlotId: null,
      reason: null,
    };
  }

  const activeElsewhere = input.roster.activeSlots.some(
    (slot) => getFutureLineupRosterAssetKey(slot.asset) === input.planSlot.assetKey,
  );
  if (activeElsewhere) {
    return {
      kind: 'conflict',
      desiredAssetKey: input.planSlot.assetKey,
      incomingAsset: activeSlot.asset,
      sourceBenchSlotId: null,
      reason: 'desired-asset-not-benched',
    };
  }

  const benchSlot = input.roster.benchSlots.find(
    (slot) => getFutureLineupRosterAssetKey(slot.asset) === input.planSlot.assetKey,
  );

  if (!benchSlot?.asset) {
    return {
      kind: 'conflict',
      desiredAssetKey: input.planSlot.assetKey,
      incomingAsset: activeSlot.asset,
      sourceBenchSlotId: null,
      reason: 'desired-asset-unavailable',
    };
  }

  if ((benchSlot.asset.eligibleFromCycleNumber ?? 1) > input.targetCycleNumber) {
    return {
      kind: 'conflict',
      desiredAssetKey: input.planSlot.assetKey,
      incomingAsset: activeSlot.asset,
      sourceBenchSlotId: benchSlot.slotId,
      reason: 'desired-asset-unavailable',
    };
  }

  if (!assetMatchesPosition(benchSlot.asset, activeSlot.position)) {
    return {
      kind: 'conflict',
      desiredAssetKey: input.planSlot.assetKey,
      incomingAsset: activeSlot.asset,
      sourceBenchSlotId: benchSlot.slotId,
      reason: 'position-mismatch',
    };
  }

  return {
    kind: 'swap',
    desiredAssetKey: input.planSlot.assetKey,
    incomingAsset: benchSlot.asset,
    sourceBenchSlotId: benchSlot.slotId,
    reason: null,
  };
}
