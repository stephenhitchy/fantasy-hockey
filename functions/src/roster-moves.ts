import { createHash } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { enforceAppCheckCallableCanaryForLeague } from './app-check-canary-authority';
import { db } from './shared/core/firebase';
import {
  getCurrentNhlPlayerTeamIdentity,
  getNhlTeamSeasonSchedule,
} from './shared/core/nhl/nhl-api.service';
import {
  hasNhlGameReachedStartSafetyBoundary,
  isNhlGameExplicitlyDeferred,
} from './shared/core/nhl/nhl-game-runtime-state.util';
import {
  loadCurrentNhlPlayerTeamIdentity,
  type NhlPlayerTeamIdentitySnapshot,
} from './shared/core/nhl/nhl-player-team-identity.service';
import { TRUSTED_WEB_ORIGINS } from './web-security';
import {
  optionalFirestoreDocumentId,
  requireFirestoreDocumentId,
} from './shared/security/firestore-document-id.util';
import {
  buildRosterActionSubmissionEvidence,
  createRosterActionRequestFingerprint,
  createRosterActionTransactionId,
  resolveRosterActionSubmission,
} from './shared/core/team/roster-action-idempotency.util';
import {
  DraftableAsset,
  InjuryReplacementWindowPlan,
} from './shared/core/draft/draft.models';
import {
  FantasyRoster,
  PendingRosterSlotMove,
  RosterAsset,
} from './shared/core/team/roster.models';
import { normalizeFantasyRoster } from './shared/core/team/roster.service';
import { createFrozenCycleProjection } from './shared/core/projection/cycle-projection.util';
import {
  loadSharedProjectionSnapshot,
  loadSharedProjectionSnapshotForCycle,
  SHARED_PROJECTION_VERSION,
} from './shared/core/projection/projection-snapshot.service';
import {
  resolveServerRosterMoveReplayContext,
  type ServerRosterMoveReplayContext,
} from './shared/core/replay/roster-move-replay-context.util';
import {
  buildSourceNhlTargetGameIdsByTeam,
} from './shared/core/cycle/cycle-window-selection.util';
import {
  createPlayerWindowContinuity,
  normalizePlayerWindowContinuity,
} from './shared/core/cycle/player-window-continuity.util';
import {
  buildInjuryReplacementWindowPlan,
  getInjuryReplacementProtectedGameIds,
  getInjuryReplacementAssetKeyByGameId,
  getInjuryReplacementGameIds,
  getInjuryReplacementPlanAuthorityFingerprint,
  hasConsistentInjuryReplacementWindowEvidence,
  hasPreservedInjuryReplacementProtectedGameOwnership,
  requireValidInjuryReplacementWindowPlan,
  resolveConsistentInjuryReplacementWindowPlan,
} from './shared/core/cycle/injury-replacement-window.util';

const FUNCTION_REGION = 'us-central1';
const DEFAULT_GAMES_PER_CYCLE = 6;
export const AUTOMATIC_INJURY_AVAILABILITY_MAX_AGE_MILLISECONDS =
  12 * 60 * 60 * 1000;

type ImmediateRosterMoveType =
  | 'add-drop-active'
  | 'add-open-active'
  | 'active-bench-swap'
  | 'activate-ir-active'
  | 'move-active-to-ir'
  | 'injury-replacement'
  | 'injury-active-bench-swap'
  | 'injury-add-drop-active'
  | 'injury-add-open-active'
  | 'drop-active';

interface ImmediateRosterMoveRequest {
  leagueId?: unknown;
  moveType?: unknown;
  activeSlotId?: unknown;
  benchSlotId?: unknown;
  irSlotId?: unknown;
  addAssetKey?: unknown;
  addAsset?: unknown;
  expectedOutgoingAssetKey?: unknown;
  submissionId?: unknown;
}

export type AutomaticInjuryReplacementSource =
  | 'global-availability-refresh'
  | 'league-availability-override'
  | 'scheduled-backstop';

export interface AutomaticQueuedInjuryReplacementRequest {
  leagueId: string;
  ownerId: string;
  activeSlotId: string;
  moveType:
    | 'injury-active-bench-swap'
    | 'injury-add-drop-active'
    | 'injury-add-open-active';
  benchSlotId: string | null;
  incomingAssetKey: string;
  expectedPendingMoveId: string;
  expectedPendingMoveFingerprint: string;
  expectedQueueTransactionId?: string | null;
  expectedMoveToIrTransactionId?: string | null;
  expectedIrSlotId?: string | null;
  source: AutomaticInjuryReplacementSource;
}

export interface AutomaticInjuryReplacementReceiptIdentity {
  submissionId: string;
  requestFingerprint: string;
  transactionId: string;
}

type MixedPlayerInjuryMoveType =
  | 'injury-replacement'
  | 'injury-active-bench-swap'
  | 'injury-add-drop-active'
  | 'injury-add-open-active';

interface ImmediateRosterMoveCallableRequest {
  auth?: {
    uid?: string;
    token?: Record<string, unknown>;
  } | null;
  app?: {
    appId?: string;
  } | null;
  data?: unknown;
}

interface ImmediateRosterMoveExecutionOptions {
  authenticatedOwnerId: unknown;
  input: unknown;
  callableRequest?: ImmediateRosterMoveCallableRequest;
  automaticInjuryReplacement?: {
    expectedPendingMoveId: string;
    expectedPendingMoveFingerprint: string;
    expectedQueueTransactionId?: string | null;
    expectedMoveToIrTransactionId?: string | null;
    expectedIrSlotId?: string | null;
    source: AutomaticInjuryReplacementSource;
  };
}

interface SlotWindowContext {
  cycleNumber: number;
  cycleRefPath: string;
  teamWindowsRefPath: string;
  rosterPickRefPath: string;
  playoffBankRefPath: string | null;
}

interface NhlScheduleGame {
  id?: number;
  gameDate?: string;
  startTimeUTC?: string;
  gameType?: number;
  gameState?: string;
  gameScheduleState?: string;
  homeTeam?: { abbrev?: string; score?: number };
  awayTeam?: { abbrev?: string; score?: number };
}

interface RosterMoveSeasonWindowAnchor {
  initialNhlBlockNumber: number;
  anchorReady: boolean;
  sourceGameIdsByTeam: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isActiveOrLegacyMissingRosterArea(value: unknown): boolean {
  return value === undefined || value === null || value === 'active';
}

function hasExactPlayerWindowContinuityCopies(input: {
  first: unknown;
  second: unknown;
  ownerId: string;
  activeSlotId: string;
  assetKey: string;
}): boolean {
  const firstMissing = input.first === undefined || input.first === null;
  const secondMissing = input.second === undefined || input.second === null;

  if (firstMissing || secondMissing) {
    return firstMissing && secondMissing;
  }

  try {
    const first = normalizePlayerWindowContinuity(input.first);
    const second = normalizePlayerWindowContinuity(input.second);

    return Boolean(
      first &&
      second &&
      first.ownerId === input.ownerId &&
      second.ownerId === input.ownerId &&
      first.rosterSlotId === input.activeSlotId &&
      second.rosterSlotId === input.activeSlotId &&
      first.assetKey === input.assetKey &&
      second.assetKey === input.assetKey &&
      JSON.stringify(first) === JSON.stringify(second),
    );
  } catch {
    return false;
  }
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requireRosterMoveAssetKey(value: unknown, label = 'asset key'): string {
  return requireFirestoreDocumentId(value, label, {
    maxBytes: 160,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  });
}

function getAssetKey(asset: unknown): string {
  const data = asRecord(asset);
  const directKey = asString(data['assetKey']);

  if (directKey) {
    return directKey;
  }

  if (data['assetType'] === 'skater') {
    const player = asRecord(data['player']);
    const playerId = player['id'] ?? player['playerId'] ?? player['nhlPlayerId'];

    return typeof playerId === 'number' || typeof playerId === 'string'
      ? `skater-${playerId}`
      : '';
  }

  const teamAbbreviation = asString(data['teamAbbreviation']);
  return teamAbbreviation ? `goalie-unit-${teamAbbreviation}` : '';
}

export async function loadCanonicalDraftableAsset(
  leagueId: string,
  assetKey: string,
): Promise<DraftableAsset> {
  const snapshot = await loadSharedProjectionSnapshot(leagueId).catch(() => null);
  const asset = snapshot?.assets.find((candidate) => candidate.assetKey === assetKey) ?? null;

  if (!asset) {
    throw new HttpsError(
      'failed-precondition',
      'That player or goalie unit is not available in the league\'s authoritative player pool.',
    );
  }

  return {
    ...asset,
    assetKey,
  } as DraftableAsset;
}

function getAssetTeamAbbreviation(asset: DraftableAsset | RosterAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
}

export function applyCurrentNhlTeamIdentity<
  T extends DraftableAsset | RosterAsset,
>(
  asset: T,
  currentTeamAbbreviationByPlayerId?: ReadonlyMap<number, string>,
): T {
  if (asset.assetType !== 'skater' || !currentTeamAbbreviationByPlayerId) {
    return asset;
  }

  const currentTeamAbbreviation = currentTeamAbbreviationByPlayerId
    .get(asset.player.id)
    ?.trim()
    .toUpperCase();

  if (!currentTeamAbbreviation) {
    throw new HttpsError(
      'failed-precondition',
      `Current NHL team identity is unavailable for player ${asset.player.id}. Try again shortly.`,
    );
  }

  return {
    ...asset,
    player: {
      ...asset.player,
      nhlTeamAbbreviation: currentTeamAbbreviation,
      teamLogoUrl:
        `https://assets.nhle.com/logos/nhl/svg/${currentTeamAbbreviation}_light.svg`,
    },
  } as T;
}

function getSkaterPlayerIds(
  assets: readonly (
    | DraftableAsset
    | RosterAsset
    | null
    | undefined
  )[],
): number[] {
  return [
    ...new Set(
      assets
        .filter(
          (asset): asset is RosterAsset | DraftableAsset =>
            Boolean(asset) && asset!.assetType === 'skater',
        )
        .map((asset) =>
          asset.assetType === 'skater' ? asset.player.id : 0,
        )
        .filter((playerId) => playerId > 0),
    ),
  ];
}

/**
 * Loads post-click current-club evidence for only the skaters involved in an
 * add/drop. Scoring workers still use the shared full-league identity catalog;
 * an interactive roster action must not refresh all 32 clubs just to verify
 * one or two players.
 */
export async function loadExactRosterActionPlayerTeamIdentity(
  playerIdsValue: Iterable<number>,
  actionBoundaryMilliseconds: number,
): Promise<NhlPlayerTeamIdentitySnapshot | null> {
  const playerIds = [
    ...new Set(
      [...playerIdsValue]
        .filter((playerId) => Number.isSafeInteger(playerId) && playerId > 0),
    ),
  ].sort((first, second) => first - second);

  if (playerIds.length === 0) {
    return null;
  }

  const settled = await Promise.allSettled(
    playerIds.map((playerId) => getCurrentNhlPlayerTeamIdentity(playerId, true)),
  );
  const byPlayerId = new Map<number, string>();

  settled.forEach((result, index) => {
    const playerId = playerIds[index];

    if (result.status === 'rejected') {
      console.warn('Unable to load exact roster-action NHL player identity.', {
        playerId,
        error: result.reason,
      });
      return;
    }

    if (result.value) {
      byPlayerId.set(result.value.playerId, result.value.teamAbbreviation);
    }
  });

  const missingPlayerIds = playerIds.filter((playerId) => !byPlayerId.has(playerId));
  if (missingPlayerIds.length > 0) {
    throw new HttpsError(
      'unavailable',
      `Current NHL team evidence is unavailable for player ${missingPlayerIds.join(', ')}. No roster move was applied.`,
    );
  }

  const generatedAt = new Date(
    Math.max(Date.now(), actionBoundaryMilliseconds),
  ).toISOString();
  const identityHash = createHash('sha256')
    .update(JSON.stringify(
      [...byPlayerId.entries()].map(([playerId, teamAbbreviation]) => ({
        playerId,
        teamAbbreviation,
      })),
    ))
    .digest('hex');

  return {
    generatedAt,
    identityHash,
    playerCount: byPlayerId.size,
    byPlayerId,
    teamConfirmedAtByPlayerId: new Map(
      playerIds.map((playerId) => [playerId, generatedAt] as const),
    ),
  };
}

function getRosterPickDocumentId(ownerId: string, rosterSlotId: string): string {
  return `${ownerId}__${rosterSlotId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function getWindowId(ownerId: string, rosterSlotId: string, cycleNumber: number): string {
  return `${ownerId}__${rosterSlotId}__cycle-${cycleNumber}`;
}

function isUntouchedWindow(window: Record<string, unknown>): boolean {
  return asNumber(window['gamesPlayed']) === 0 &&
    asNumber(window['actualGamesPlayed']) === 0 &&
    asNumber(window['fantasyPoints']) === 0 &&
    asArray(window['completedGameIds']).length === 0 &&
    asArray(window['liveGameIds']).length === 0 &&
    asArray(window['appearanceGameIds']).length === 0;
}

function filterGameRecord(
  value: unknown,
  allowedGameIds: ReadonlySet<number>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter(([gameId]) => {
      const parsed = Number(gameId);
      return Number.isSafeInteger(parsed) && allowedGameIds.has(parsed);
    }),
  );
}

function getInjuryReplacementProjectionPoints(
  plan: InjuryReplacementWindowPlan,
): number | null {
  let hasProjection = false;
  const projectedPoints = plan.segments.reduce((total, segment) => {
    const projection =
      segment.asset.frozenCycleProjectionPoints ??
      segment.asset.projectedCyclePoints;

    if (typeof projection !== 'number' || !Number.isFinite(projection)) {
      return total;
    }

    hasProjection = true;
    return total + projection *
      (segment.scheduledGameIds.length / plan.requiredGames);
  }, 0);

  return hasProjection ? Number(projectedPoints.toFixed(1)) : null;
}

interface InjuryReplacementPlanCopy {
  label: string;
  value: unknown;
}

function selectCurrentInjuryReplacementPlanFromCopies(
  copies: readonly InjuryReplacementPlanCopy[],
): InjuryReplacementWindowPlan | null {
  const presentCopies = copies.filter(
    (copy) => copy.value !== undefined && copy.value !== null,
  );

  if (presentCopies.length > 0 && presentCopies.length !== copies.length) {
    const missingLabels = copies
      .filter((copy) => copy.value === undefined || copy.value === null)
      .map((copy) => copy.label)
      .join(', ');

    throw new HttpsError(
      'failed-precondition',
      `The saved active-slot injury ownership is incomplete (${missingLabels}). ` +
        'No roster move was applied.',
    );
  }

  try {
    return resolveConsistentInjuryReplacementWindowPlan({
      values: copies.map((copy) => copy.value),
      context: 'The saved active-slot window',
    });
  } catch (error: unknown) {
    throw new HttpsError(
      'failed-precondition',
      error instanceof Error
        ? `${error.message} No roster move was applied.`
        : 'The saved active-slot injury ownership is invalid. No roster move was applied.',
    );
  }
}

function selectCurrentInjuryReplacementPlan(
  pickValue: unknown,
  windowValue: unknown,
): InjuryReplacementWindowPlan | null {
  return selectCurrentInjuryReplacementPlanFromCopies([
    { label: 'cycle window', value: windowValue },
    { label: 'cycle pick', value: pickValue },
  ]);
}

function assertWindowPreservesSelectedInjuryReplacementPlan(input: {
  window: Record<string, unknown> | null;
  selectedPlan: InjuryReplacementWindowPlan | null;
  context: string;
}): void {
  if (!input.selectedPlan) {
    return;
  }

  const windowPlan = requireValidInjuryReplacementWindowPlan(
    input.window?.['injuryReplacementWindow'],
    input.context,
  );

  if (
    !input.window ||
    !windowPlan ||
    !hasConsistentInjuryReplacementWindowEvidence({
      plan: windowPlan,
      scheduledGameIds: input.window['scheduledGameIds'],
      scoringAssetKeyByGameId: input.window['scoringAssetKeyByGameId'],
      assetKey: asString(input.window['assetKey']),
      ownerId: asString(input.window['ownerId']),
      rosterSlotId: asString(input.window['rosterSlotId']),
      position: asString(input.window['position']),
      scheduleTeamAbbreviation: asString(
        input.window['scheduleTeamAbbreviation'],
      ),
      sourceTeamAbbreviationByGameId: asRecord(
        input.window['sourceTeamAbbreviationByGameId'],
      ) as Record<string, string>,
      completedGameIds: asArray(input.window['completedGameIds']) as number[],
      liveGameIds: asArray(input.window['liveGameIds']) as number[],
      incompleteFinalGameIds: asArray(
        input.window['incompleteFinalGameIds'],
      ) as number[],
      appearanceGameIds: asArray(input.window['appearanceGameIds']) as number[],
      gameStates: asRecord(input.window['gameStates']),
    }) ||
    !hasPreservedInjuryReplacementProtectedGameOwnership({
      previousPlan: windowPlan,
      nextPlan: input.selectedPlan,
      protectedGameIds: getInjuryReplacementProtectedGameIds({
        completedGameIds: asArray(input.window['completedGameIds']) as number[],
        liveGameIds: asArray(input.window['liveGameIds']) as number[],
        incompleteFinalGameIds: asArray(
          input.window['incompleteFinalGameIds'],
        ) as number[],
        appearanceGameIds: asArray(
          input.window['appearanceGameIds'],
        ) as number[],
        gameStates: asRecord(input.window['gameStates']),
      }),
      previousAssetKey: asString(input.window['assetKey']),
      previousScheduleTeamAbbreviation: asString(
        input.window['scheduleTeamAbbreviation'],
      ),
      previousSourceTeamAbbreviationByGameId: asRecord(
        input.window['sourceTeamAbbreviationByGameId'],
      ) as Record<string, string>,
    })
  ) {
    throw new HttpsError(
      'failed-precondition',
      `${input.context} changed protected injury-replacement game ownership. ` +
        'No roster move was applied.',
    );
  }
}

function assertInjuryReplacementPlanPreservesTransactionProtectedGames(input: {
  window: Record<string, unknown> | null;
  previousPlan: InjuryReplacementWindowPlan | null;
  nextPlan: InjuryReplacementWindowPlan;
  context: string;
}): void {
  const protectedGameIds = getInjuryReplacementProtectedGameIds({
    completedGameIds: asArray(input.window?.['completedGameIds']) as number[],
    liveGameIds: asArray(input.window?.['liveGameIds']) as number[],
    incompleteFinalGameIds: asArray(
      input.window?.['incompleteFinalGameIds'],
    ) as number[],
    appearanceGameIds: asArray(
      input.window?.['appearanceGameIds'],
    ) as number[],
    gameStates: asRecord(input.window?.['gameStates']),
  });

  if (protectedGameIds.length === 0) {
    return;
  }

  if (
    !hasPreservedInjuryReplacementProtectedGameOwnership({
      previousPlan: input.previousPlan,
      nextPlan: input.nextPlan,
      protectedGameIds,
      previousAssetKey: asString(input.window?.['assetKey']),
      previousScheduleTeamAbbreviation: asString(
        input.window?.['scheduleTeamAbbreviation'],
      ),
      previousSourceTeamAbbreviationByGameId: asRecord(
        input.window?.['sourceTeamAbbreviationByGameId'],
      ) as Record<string, string>,
    })
  ) {
    throw new HttpsError(
      'aborted',
      `${input.context} gained a protected live or final game while the injury replacement was being checked. ` +
        'No roster move was applied; retry with the latest scoring window.',
    );
  }
}

function rosterContainsAsset(roster: FantasyRoster, assetKey: string): boolean {
  const activeAssets = roster.activeSlots.flatMap((slot) => [
    slot.asset,
    slot.pendingMove?.incomingAsset ?? null,
  ]);
  const assets = [
    ...activeAssets,
    ...roster.benchSlots.map((slot) => slot.asset),
    ...roster.irSlots.map((slot) => slot.asset),
  ];

  return assets.some((asset) => getAssetKey(asset) === assetKey);
}

function isBenchSlotReserved(roster: FantasyRoster, benchSlotId: string): boolean {
  const benchAsset = roster.benchSlots.find((slot) => slot.slotId === benchSlotId)?.asset;
  const assetKey = getAssetKey(benchAsset);

  return Boolean(assetKey) && roster.activeSlots.some((slot) =>
    slot.pendingMove?.sourceBenchSlotId === benchSlotId &&
    getAssetKey(slot.pendingMove.incomingAsset) === assetKey,
  );
}

export function getQueuedBenchSwapInjuryPromotionFingerprint(input: {
  pendingMove: PendingRosterSlotMove | null | undefined;
  ownerId: string;
  activeSlotId: string;
  benchSlotId: string;
  outgoingAssetKey: string;
  incomingAssetKey: string;
}): string | null {
  const pendingMove = input.pendingMove;
  const pendingMoveId = asString(pendingMove?.id);
  const ownerId = asString(input.ownerId);
  const activeSlotId = asString(input.activeSlotId);
  const benchSlotId = asString(input.benchSlotId);
  const outgoingAssetKey = asString(input.outgoingAssetKey);
  const incomingAssetKey = asString(input.incomingAssetKey);

  if (
    !pendingMove ||
    !pendingMoveId ||
    !ownerId ||
    !activeSlotId ||
    !benchSlotId ||
    !outgoingAssetKey ||
    !incomingAssetKey ||
    pendingMove.moveType !== 'add-drop' ||
    pendingMove.queuedByOwnerId !== ownerId ||
    pendingMove.sourceBenchSlotId !== benchSlotId ||
    pendingMove.sourceWaiverId !== null ||
    pendingMove.outgoingDestination !== 'bench' ||
    pendingMove.outgoingAssetKey !== outgoingAssetKey ||
    getAssetKey(pendingMove.incomingAsset) !== incomingAssetKey
  ) {
    return null;
  }

  return createHash('sha256')
    .update(JSON.stringify({
      activeSlotId,
      pendingMoveId,
      moveType: pendingMove.moveType,
      queuedByOwnerId: pendingMove.queuedByOwnerId,
      queuedAt: pendingMove.queuedAt,
      requestedEffectiveCycleNumber:
        pendingMove.requestedEffectiveCycleNumber,
      requestedEffectiveLabel: pendingMove.requestedEffectiveLabel,
      sourceBenchSlotId: pendingMove.sourceBenchSlotId,
      sourceWaiverId: pendingMove.sourceWaiverId,
      outgoingDestination: pendingMove.outgoingDestination,
      outgoingAssetKey: pendingMove.outgoingAssetKey,
      incomingAssetKey: getAssetKey(pendingMove.incomingAsset),
    }))
    .digest('hex');
}

export function getQueuedFreeAgentInjuryPromotionFingerprint(input: {
  pendingMove: PendingRosterSlotMove | null | undefined;
  ownerId: string;
  activeSlotId: string;
  outgoingAssetKey: string;
  incomingAssetKey: string;
}): string | null {
  const pendingMove = input.pendingMove;
  const pendingMoveId = asString(pendingMove?.id);
  const ownerId = asString(input.ownerId);
  const activeSlotId = asString(input.activeSlotId);
  const outgoingAssetKey = asString(input.outgoingAssetKey);
  const incomingAssetKey = asString(input.incomingAssetKey);

  if (
    !pendingMove ||
    !pendingMoveId ||
    !ownerId ||
    !activeSlotId ||
    !outgoingAssetKey ||
    !incomingAssetKey ||
    pendingMove.moveType !== 'add-drop' ||
    pendingMove.queuedByOwnerId !== ownerId ||
    pendingMove.sourceBenchSlotId !== null ||
    pendingMove.sourceWaiverId !== null ||
    pendingMove.outgoingDestination !== 'waivers' ||
    pendingMove.outgoingAssetKey !== outgoingAssetKey ||
    getAssetKey(pendingMove.incomingAsset) !== incomingAssetKey
  ) {
    return null;
  }

  return createHash('sha256')
    .update(JSON.stringify({
      activeSlotId,
      pendingMoveId,
      moveType: pendingMove.moveType,
      queuedByOwnerId: pendingMove.queuedByOwnerId,
      queuedAt: pendingMove.queuedAt,
      requestedEffectiveCycleNumber:
        pendingMove.requestedEffectiveCycleNumber,
      requestedEffectiveLabel: pendingMove.requestedEffectiveLabel,
      sourceBenchSlotId: pendingMove.sourceBenchSlotId,
      sourceWaiverId: pendingMove.sourceWaiverId,
      outgoingDestination: pendingMove.outgoingDestination,
      outgoingAssetKey: pendingMove.outgoingAssetKey,
      incomingAssetKey: getAssetKey(pendingMove.incomingAsset),
    }))
    .digest('hex');
}

export function getQueuedIrAddOpenInjuryPromotionFingerprint(input: {
  pendingMove: PendingRosterSlotMove | null | undefined;
  ownerId: string;
  activeSlotId: string;
  activePosition: string;
  incomingAssetKey: string;
  irSlotId: string;
  irAsset: RosterAsset | null | undefined;
  queueTransactionId: string;
  queueTransaction: unknown;
  moveToIrTransactionId: string;
  moveToIrTransaction: unknown;
}): string | null {
  const pendingMove = input.pendingMove;
  const pendingMoveId = asString(pendingMove?.id);
  const ownerId = asString(input.ownerId);
  const activeSlotId = asString(input.activeSlotId);
  const activePosition = asString(input.activePosition);
  const incomingAssetKey = asString(input.incomingAssetKey);
  const irSlotId = asString(input.irSlotId);
  const irAssetKey = getAssetKey(input.irAsset);
  const queueTransactionId = asString(input.queueTransactionId);
  const queueTransaction = asRecord(input.queueTransaction);
  const moveToIrTransactionId = asString(input.moveToIrTransactionId);
  const moveToIrTransaction = asRecord(input.moveToIrTransaction);
  const pendingIncomingAssetKey = getAssetKey(pendingMove?.incomingAsset);
  const pendingIncomingPosition = asString(pendingMove?.incomingAsset?.position);
  const irPosition = asString(input.irAsset?.position);
  const movedAssetKey = getAssetKey(moveToIrTransaction['movedAsset']);
  const movedPosition = asString(asRecord(moveToIrTransaction['movedAsset'])['position']);
  const queueAddedAssetKey = getAssetKey(queueTransaction['addedAsset']);
  const queueAddedPosition = asString(asRecord(queueTransaction['addedAsset'])['position']);
  const pendingQueuedAtMilliseconds = pendingMove
    ? Date.parse(asString(pendingMove.queuedAt))
    : Number.NaN;
  const queueCreatedAtMilliseconds = getTimestampMilliseconds(
    queueTransaction['createdAt'],
  );
  const moveToIrCreatedAtMilliseconds = getTimestampMilliseconds(
    moveToIrTransaction['createdAt'],
  );
  const requestedEffectiveCycleNumber =
    pendingMove?.requestedEffectiveCycleNumber ?? null;
  const queueEffectiveCycleNumber =
    typeof queueTransaction['effectiveCycleNumber'] === 'number'
      ? queueTransaction['effectiveCycleNumber']
      : null;
  const requestedEffectiveLabel = pendingMove?.requestedEffectiveLabel ?? null;
  const queueEffectiveLabel = typeof queueTransaction['effectiveLabel'] === 'string'
    ? queueTransaction['effectiveLabel']
    : null;
  const moveToIrEffectiveCycleNumber =
    typeof moveToIrTransaction['effectiveCycleNumber'] === 'number'
      ? moveToIrTransaction['effectiveCycleNumber']
      : null;
  const moveToIrEffectiveLabel =
    typeof moveToIrTransaction['effectiveLabel'] === 'string'
      ? moveToIrTransaction['effectiveLabel']
      : null;

  if (
    !pendingMove ||
    !pendingMoveId ||
    !ownerId ||
    !activeSlotId ||
    !activePosition ||
    !incomingAssetKey ||
    !irSlotId ||
    !irAssetKey ||
    !queueTransactionId ||
    !moveToIrTransactionId ||
    !Number.isSafeInteger(requestedEffectiveCycleNumber) ||
    (requestedEffectiveCycleNumber ?? 0) <= 0 ||
    !asString(requestedEffectiveLabel) ||
    pendingMove.moveType !== 'add-open-slot' ||
    pendingMove.queuedByOwnerId !== ownerId ||
    pendingMove.outgoingAssetKey !== null ||
    pendingMove.sourceBenchSlotId !== null ||
    pendingMove.sourceWaiverId !== null ||
    pendingMove.outgoingDestination !== 'waivers' ||
    pendingIncomingAssetKey !== incomingAssetKey ||
    pendingIncomingPosition !== activePosition ||
    input.irAsset?.assetType !== 'skater' ||
    irPosition !== activePosition ||
    queueTransaction['type'] !== 'queue-add-open-slot' ||
    queueTransaction['authority'] !== 'cloud-function' ||
    asString(queueTransaction['ownerId']) !== ownerId ||
    asString(queueTransaction['targetSlotId']) !== activeSlotId ||
    asString(queueTransaction['rosterSlotId']) !== activeSlotId ||
    asString(queueTransaction['queuedMoveId']) !== pendingMoveId ||
    queueAddedAssetKey !== incomingAssetKey ||
    queueAddedPosition !== activePosition ||
    queueTransaction['droppedAsset'] !== null ||
    queueEffectiveCycleNumber !== requestedEffectiveCycleNumber ||
    queueEffectiveLabel !== requestedEffectiveLabel ||
    moveToIrTransaction['type'] !== 'move-to-ir' ||
    moveToIrTransaction['authority'] !== 'cloud-function' ||
    asString(moveToIrTransaction['ownerId']) !== ownerId ||
    asString(moveToIrTransaction['activeSlotId']) !== activeSlotId ||
    asString(moveToIrTransaction['irSlotId']) !== irSlotId ||
    movedAssetKey !== irAssetKey ||
    movedPosition !== activePosition ||
    !IR_ELIGIBLE_STATUSES.has(asString(moveToIrTransaction['availabilityStatus'])) ||
    moveToIrEffectiveCycleNumber !== requestedEffectiveCycleNumber ||
    moveToIrEffectiveLabel !== requestedEffectiveLabel ||
    !Number.isFinite(pendingQueuedAtMilliseconds) ||
    queueCreatedAtMilliseconds === null ||
    moveToIrCreatedAtMilliseconds === null ||
    queueCreatedAtMilliseconds < pendingQueuedAtMilliseconds ||
    queueCreatedAtMilliseconds - pendingQueuedAtMilliseconds > 60 * 1000 ||
    moveToIrCreatedAtMilliseconds > pendingQueuedAtMilliseconds ||
    moveToIrCreatedAtMilliseconds > queueCreatedAtMilliseconds ||
    queueCreatedAtMilliseconds - moveToIrCreatedAtMilliseconds > 5 * 60 * 1000
  ) {
    return null;
  }

  return createHash('sha256')
    .update(JSON.stringify({
      activePosition,
      activeSlotId,
      incomingAssetKey,
      irAssetKey,
      irSlotId,
      moveToIrCreatedAtMilliseconds,
      moveToIrTransactionId,
      moveToIrAvailabilityStatus:
        asString(moveToIrTransaction['availabilityStatus']),
      moveToIrEffectiveCycleNumber,
      moveToIrEffectiveLabel,
      pendingMoveId,
      pendingMoveType: pendingMove.moveType,
      pendingQueuedAt: pendingMove.queuedAt,
      queueCreatedAtMilliseconds,
      queuedByOwnerId: pendingMove.queuedByOwnerId,
      queueTransactionId,
      requestedEffectiveCycleNumber,
      requestedEffectiveLabel,
      sourceBenchSlotId: pendingMove.sourceBenchSlotId,
      sourceWaiverId: pendingMove.sourceWaiverId,
      outgoingDestination: pendingMove.outgoingDestination,
    }))
    .digest('hex');
}

function getQueuedInjuryPromotionFingerprint(input: {
  moveType: ImmediateRosterMoveType;
  pendingMove: PendingRosterSlotMove | null | undefined;
  ownerId: string;
  activeSlotId: string;
  benchSlotId: string;
  outgoingAssetKey: string;
  incomingAssetKey: string;
}): string | null {
  if (input.moveType === 'injury-add-drop-active') {
    return getQueuedFreeAgentInjuryPromotionFingerprint({
      pendingMove: input.pendingMove,
      ownerId: input.ownerId,
      activeSlotId: input.activeSlotId,
      outgoingAssetKey: input.outgoingAssetKey,
      incomingAssetKey: input.incomingAssetKey,
    });
  }

  if (isBenchSourcedInjuryMove(input.moveType)) {
    return getQueuedBenchSwapInjuryPromotionFingerprint({
      pendingMove: input.pendingMove,
      ownerId: input.ownerId,
      activeSlotId: input.activeSlotId,
      benchSlotId: input.benchSlotId,
      outgoingAssetKey: input.outgoingAssetKey,
      incomingAssetKey: input.incomingAssetKey,
    });
  }

  return null;
}

export function createAutomaticInjuryReplacementReceiptIdentity(input: {
  leagueId: string;
  ownerId: string;
  activeSlotId: string;
  moveType?: MixedPlayerInjuryMoveType;
  benchSlotId?: string | null;
  incomingAssetKey?: string | null;
  pendingMoveId: string;
  pendingMoveFingerprint: string;
  queueTransactionId?: string | null;
  moveToIrTransactionId?: string | null;
  irSlotId?: string | null;
}): AutomaticInjuryReplacementReceiptIdentity {
  const moveType = input.moveType ?? 'injury-replacement';
  const submissionId = `auto_injury_${createHash('sha256')
    .update(
      `${input.leagueId}:${input.ownerId}:${input.activeSlotId}:${input.pendingMoveId}`,
    )
    .digest('hex')
    .slice(0, 48)}`;
  const requestFingerprint = createRosterActionRequestFingerprint({
    activeSlotId: input.activeSlotId,
    benchSlotId: input.benchSlotId ?? null,
    incomingAssetKey: input.incomingAssetKey ?? null,
    expectedPendingMoveId: input.pendingMoveId,
    expectedPendingMoveFingerprint: input.pendingMoveFingerprint,
    expectedQueueTransactionId: input.queueTransactionId ?? null,
    expectedMoveToIrTransactionId: input.moveToIrTransactionId ?? null,
    expectedIrSlotId: input.irSlotId ?? null,
    moveType,
  });

  return {
    submissionId,
    requestFingerprint,
    transactionId: createRosterActionTransactionId({
      namespace: 'automatic-injury-replacement',
      leagueId: input.leagueId,
      ownerId: input.ownerId,
      submissionId,
    }),
  };
}

function isExclusiveQueuedBenchSwapReservation(input: {
  roster: FantasyRoster;
  activeSlotId: string;
  benchSlotId: string;
  pendingMoveId: string;
  incomingAssetKey: string;
}): boolean {
  const reservations = input.roster.activeSlots.filter(
    (slot) => slot.pendingMove?.sourceBenchSlotId === input.benchSlotId,
  );

  return reservations.length === 1 &&
    reservations[0].slotId === input.activeSlotId &&
    reservations[0].pendingMove?.id === input.pendingMoveId &&
    getAssetKey(reservations[0].pendingMove?.incomingAsset) ===
      input.incomingAssetKey;
}

function isExclusiveQueuedFreeAgentReservation(input: {
  roster: FantasyRoster;
  activeSlotId: string;
  pendingMoveId: string;
  incomingAssetKey: string;
}): boolean {
  const pendingReservations = input.roster.activeSlots.filter(
    (slot) => getAssetKey(slot.pendingMove?.incomingAsset) === input.incomingAssetKey,
  );
  const currentAssets = [
    ...input.roster.activeSlots.map((slot) => slot.asset),
    ...input.roster.benchSlots.map((slot) => slot.asset),
    ...input.roster.irSlots.map((slot) => slot.asset),
  ];

  return pendingReservations.length === 1 &&
    pendingReservations[0].slotId === input.activeSlotId &&
    pendingReservations[0].pendingMove?.id === input.pendingMoveId &&
    !currentAssets.some(
      (asset) => getAssetKey(asset) === input.incomingAssetKey,
    );
}

function createRosterAsset(asset: DraftableAsset, cycleNumber: number, status: 'new' | 'active' | 'benched'): RosterAsset {
  return {
    ...asset,
    rosterStatus: status,
    eligibleFromCycleNumber: cycleNumber,
    cycleScore: {
      cycleNumber,
      gamesCounted: 0,
      fantasyPoints: 0,
    },
  } as RosterAsset;
}

function rosterAssetToDraftableAsset(asset: RosterAsset): DraftableAsset {
  const copy = { ...asset } as Record<string, unknown>;
  delete copy['cycleScore'];
  delete copy['rosterStatus'];

  return {
    ...copy,
    assetKey: getAssetKey(asset),
  } as DraftableAsset;
}


function clearFrozenProjectionFields(asset: DraftableAsset): DraftableAsset {
  const copy: DraftableAsset = { ...asset };

  delete copy.frozenCycleProjectionPoints;
  delete copy.frozenProjectionCycleNumber;
  delete copy.frozenProjectionSource;
  delete copy.frozenProjectionVersion;
  delete copy.frozenProjectionSnapshotId;
  delete copy.frozenProjectionGeneratedAt;
  delete copy.frozenProjectionFrozenAt;

  return copy;
}

async function resolveIncomingProjectionForCycle(
  leagueId: string,
  cycleNumber: number,
  incomingAsset: DraftableAsset,
): Promise<DraftableAsset> {
  const assetKey = getAssetKey(incomingAsset);
  const [targetSnapshot, currentSnapshot] = await Promise.all([
    loadSharedProjectionSnapshotForCycle(leagueId, cycleNumber).catch(() => null),
    loadSharedProjectionSnapshot(leagueId).catch(() => null),
  ]);
  const targetAsset = targetSnapshot?.assets.find((asset) => asset.assetKey === assetKey) ?? null;
  const currentAsset = currentSnapshot?.assets.find((asset) => {
    if (asset.assetKey !== assetKey) {
      return false;
    }

    return asset.targetProjectionCycleNumber == null ||
      asset.targetProjectionCycleNumber === cycleNumber;
  }) ?? null;
  const sharedAsset = targetAsset ?? currentAsset;
  const baseAsset = clearFrozenProjectionFields({
    ...incomingAsset,
    ...(sharedAsset ?? {}),
    assetKey,
  } as DraftableAsset);
  const frozenAt = new Date().toISOString();
  const source = sharedAsset ? 'shared-snapshot' : 'roster';

  return {
    ...baseAsset,
    frozenCycleProjectionPoints: createFrozenCycleProjection(baseAsset),
    frozenProjectionCycleNumber: cycleNumber,
    frozenProjectionSource: source,
    frozenProjectionVersion: sharedAsset ? SHARED_PROJECTION_VERSION : null,
    frozenProjectionSnapshotId:
      sharedAsset?.sharedProjectionSnapshotId ?? null,
    frozenProjectionGeneratedAt:
      sharedAsset?.projectionGeneratedAt ?? null,
    frozenProjectionFrozenAt: frozenAt,
  } as DraftableAsset;
}

const IR_ELIGIBLE_STATUSES = new Set([
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
]);

const INJURY_LINEUP_ELIGIBLE_STATUSES = new Set([
  'day-to-day',
  ...IR_ELIGIBLE_STATUSES,
]);

function isMixedPlayerInjuryMove(
  moveType: ImmediateRosterMoveType,
): moveType is MixedPlayerInjuryMoveType {
  return moveType === 'injury-replacement' ||
    moveType === 'injury-active-bench-swap' ||
    moveType === 'injury-add-drop-active' ||
    moveType === 'injury-add-open-active';
}

function isBenchSourcedInjuryMove(
  moveType: ImmediateRosterMoveType,
): boolean {
  return moveType === 'injury-replacement' ||
    moveType === 'injury-active-bench-swap';
}

function getEligibleStatusesForInjuryMove(
  moveType: ImmediateRosterMoveType,
): ReadonlySet<string> {
  return moveType === 'injury-replacement' ||
      moveType === 'injury-add-open-active' ||
      moveType === 'move-active-to-ir'
    ? IR_ELIGIBLE_STATUSES
    : INJURY_LINEUP_ELIGIBLE_STATUSES;
}

function requiresFreshInjuryAvailabilityAuthority(
  moveType: ImmediateRosterMoveType,
): boolean {
  return moveType === 'injury-active-bench-swap' ||
    moveType === 'injury-add-drop-active' ||
    moveType === 'injury-add-open-active';
}

export function resolveAuthoritativeAvailabilityStatus(
  asset: RosterAsset,
  leagueOverrideData: unknown,
  globalAvailabilityData: unknown,
): string {
  if (asset.assetType !== 'skater') {
    return '';
  }

  const leagueOverrideStatus = asString(
    asRecord(leagueOverrideData)['status'],
  );

  if (leagueOverrideStatus) {
    return leagueOverrideStatus;
  }

  const globalRecord = asArray(asRecord(globalAvailabilityData)['records'])
    .map(asRecord)
    .find((record) => asNumber(record['playerId'], -1) === asset.player.id);
  const globalStatus = asString(globalRecord?.['status']);

  return globalStatus || asString(asset.availabilityStatus);
}

function getTimestampMilliseconds(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }

  const timestamp = value as {
    toMillis?: () => number;
    toDate?: () => Date;
  } | null;

  if (typeof timestamp?.toMillis === 'function') {
    const milliseconds = timestamp.toMillis();

    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  if (typeof timestamp?.toDate === 'function') {
    const milliseconds = timestamp.toDate().getTime();

    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  const textMilliseconds = typeof value === 'string'
    ? new Date(value).getTime()
    : Number.NaN;

  return Number.isFinite(textMilliseconds) ? textMilliseconds : null;
}

/**
 * Unattended roster writes and the destination-preserving injury routes
 * require fresh positive authority. They never trust a cached roster asset
 * status when the shared injury report is missing or stale.
 */
export function resolveAutomaticInjuryAvailabilityStatus(
  asset: RosterAsset,
  leagueOverrideData: unknown,
  globalAvailabilityData: unknown,
  nowMilliseconds = Date.now(),
  expectedLeagueId: string | null = null,
): string {
  if (asset.assetType !== 'skater') {
    return '';
  }

  const leagueOverrideStatus =
    resolveTrustedCommissionerAvailabilityStatus(
      leagueOverrideData,
      expectedLeagueId,
      asset.player.id,
    );

  if (leagueOverrideStatus) {
    return leagueOverrideStatus;
  }

  const globalData = asRecord(globalAvailabilityData);
  const lastSuccessfulMilliseconds = getTimestampMilliseconds(
    globalData['lastSuccessfulSyncAt'],
  );
  const reportIsFresh =
    lastSuccessfulMilliseconds !== null &&
    lastSuccessfulMilliseconds <= nowMilliseconds + 5 * 60 * 1000 &&
    nowMilliseconds - lastSuccessfulMilliseconds <=
      AUTOMATIC_INJURY_AVAILABILITY_MAX_AGE_MILLISECONDS;

  if (
    asString(globalData['status']) !== 'success' ||
    asString(globalData['source']).toUpperCase() !== 'ESPN' ||
    globalData['draftReadinessSourceComplete'] !== true ||
    !reportIsFresh
  ) {
    return '';
  }

  const globalRecord = asArray(globalData['records'])
    .map(asRecord)
    .find((record) => asNumber(record['playerId'], -1) === asset.player.id);

  return asString(globalRecord?.['status']);
}

export function resolveTrustedCommissionerAvailabilityStatus(
  value: unknown,
  expectedLeagueId: string | null,
  expectedPlayerId: number,
): string {
  const record = asRecord(value);

  if (
    record['source'] !== 'commissioner' ||
    asNumber(record['playerId'], -1) !== expectedPlayerId ||
    (expectedLeagueId !== null &&
      asString(record['leagueId']) !== expectedLeagueId)
  ) {
    return '';
  }

  return asString(record['status']);
}

export async function getAuthoritativeAvailabilityStatus(
  leagueId: string,
  asset: RosterAsset,
): Promise<string> {
  if (asset.assetType !== 'skater') {
    return '';
  }

  const [leagueOverrideSnapshot, globalAvailabilitySnapshot] = await Promise.all([
    db.doc(`leagues/${leagueId}/playerAvailability/${asset.player.id}`).get(),
    db.doc('appData/playerAvailability').get(),
  ]);

  return resolveAuthoritativeAvailabilityStatus(
    asset,
    leagueOverrideSnapshot.data(),
    globalAvailabilitySnapshot.data(),
  );
}

async function getAutomaticInjuryAvailabilityStatus(
  leagueId: string,
  asset: RosterAsset,
): Promise<string> {
  if (asset.assetType !== 'skater') {
    return '';
  }

  const [leagueOverrideSnapshot, globalAvailabilitySnapshot] = await Promise.all([
    db.doc(`leagues/${leagueId}/playerAvailability/${asset.player.id}`).get(),
    db.doc('appData/playerAvailability').get(),
  ]);

  return resolveAutomaticInjuryAvailabilityStatus(
    asset,
    leagueOverrideSnapshot.data(),
    globalAvailabilitySnapshot.data(),
    Date.now(),
    leagueId,
  );
}

function getNhlSeasonForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;

  return `${startYear}${startYear + 1}`;
}

function getScheduleGameState(
  game: NhlScheduleGame,
  completedThroughDate: string | null = null,
): 'scheduled' | 'live' | 'final' {
  if (completedThroughDate) {
    return asString(game.gameDate) <= completedThroughDate
      ? 'final'
      : 'scheduled';
  }

  const state = asString(game.gameState).toUpperCase();

  if (state === 'OFF' || state === 'FINAL') {
    return 'final';
  }

  if (state === 'LIVE' || state === 'CRIT') {
    return 'live';
  }

  if (
    !state &&
    typeof game.homeTeam?.score === 'number' &&
    typeof game.awayTeam?.score === 'number'
  ) {
    return 'final';
  }

  return 'scheduled';
}

function getScheduleGameStartMilliseconds(game: NhlScheduleGame): number | null {
  const startTimeUTC = asString(game.startTimeUTC);

  if (!startTimeUTC) {
    return null;
  }

  const milliseconds = Date.parse(startTimeUTC);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds(
  input: {
    startMillisecondsByGameId: Readonly<Record<string, number>>;
    observedAtMilliseconds: number;
  },
): number[] {
  if (!Number.isFinite(input.observedAtMilliseconds)) {
    return [];
  }

  return Object.entries(input.startMillisecondsByGameId)
    .flatMap(([gameIdValue, startMilliseconds]) => {
      const gameId = Number(gameIdValue);

      return Number.isSafeInteger(gameId) &&
          gameId > 0 &&
          Number.isFinite(startMilliseconds) &&
          startMilliseconds <= input.observedAtMilliseconds
        ? [gameId]
        : [];
    })
    .sort((left, right) => left - right);
}

async function loadRosterMoveScheduleForTeam(
  teamAbbreviationValue: string,
): Promise<NhlScheduleGame[]> {
  const teamAbbreviation = teamAbbreviationValue.trim().toUpperCase();

  if (!/^[A-Z0-9]{2,4}$/.test(teamAbbreviation)) {
    throw new HttpsError(
      'failed-precondition',
      'The saved roster-move team identity is invalid.',
    );
  }

  const season = getNhlSeasonForDate(new Date());
  let schedule: NhlScheduleGame[];

  try {
    schedule = await getNhlTeamSeasonSchedule(
      teamAbbreviation,
      season,
      'near-live-canary',
    );
  } catch (error: unknown) {
    console.warn('Unable to load the roster-move NHL schedule.', {
      teamAbbreviation,
      error,
    });
    throw new HttpsError(
      'unavailable',
      `Unable to verify ${teamAbbreviation}'s current six-game schedule.`,
    );
  }

  const sortedSchedule = [...schedule].sort((first, second) => {
      const firstStart = getScheduleGameStartMilliseconds(first);
      const secondStart = getScheduleGameStartMilliseconds(second);

      if (firstStart !== null && secondStart !== null && firstStart !== secondStart) {
        return firstStart - secondStart;
      }

      return asString(first.gameDate).localeCompare(asString(second.gameDate)) ||
        asNumber(first.id) - asNumber(second.id);
    });

  if (sortedSchedule.length === 0) {
    throw new HttpsError(
      'failed-precondition',
      `No regular-season schedule was found for ${teamAbbreviation}.`,
    );
  }

  return sortedSchedule;
}

function getStartedScheduledGameIds(input: {
  scheduledGameIds: readonly number[];
  schedule: readonly NhlScheduleGame[];
  boundaryMilliseconds: number;
}): Set<number> {
  const scheduleById = new Map(
    input.schedule.flatMap((game) =>
      typeof game.id === 'number' && Number.isSafeInteger(game.id)
        ? [[game.id, game] as const]
        : [],
    ),
  );
  const startedGameIds = new Set<number>();

  for (const gameId of input.scheduledGameIds) {
    const game = scheduleById.get(gameId);

    if (!game) {
      throw new HttpsError(
        'failed-precondition',
        `The NHL schedule is missing frozen game ${gameId}. No injury replacement was applied.`,
      );
    }

    const state = getScheduleGameState(game);
    const startMilliseconds = getScheduleGameStartMilliseconds(game);

    if (state === 'live' || state === 'final') {
      if (startMilliseconds === null) {
        throw new HttpsError(
          'failed-precondition',
          `NHL game ${gameId} has started without an exact puck-drop time. Try again shortly.`,
        );
      }
      startedGameIds.add(gameId);
      continue;
    }

    if (startMilliseconds === null) {
      throw new HttpsError(
        'failed-precondition',
        `NHL game ${gameId} is missing its puck-drop time. No injury replacement was applied.`,
      );
    }

    if (startMilliseconds <= input.boundaryMilliseconds) {
      startedGameIds.add(gameId);
    }
  }

  return startedGameIds;
}

function selectFutureInjuryReplacementGames(input: {
  schedule: readonly NhlScheduleGame[];
  boundaryMilliseconds: number;
  count: number;
}): NhlScheduleGame[] {
  const games = input.schedule.filter((game) => {
    const gameId = game.id;
    const startMilliseconds = getScheduleGameStartMilliseconds(game);

    return typeof gameId === 'number' &&
      Number.isSafeInteger(gameId) &&
      getScheduleGameState(game) === 'scheduled' &&
      startMilliseconds !== null &&
      startMilliseconds > input.boundaryMilliseconds;
  }).slice(0, input.count);

  if (games.length !== input.count) {
    throw new HttpsError(
      'failed-precondition',
      `The replacement does not have ${input.count} verifiable future game${
        input.count === 1 ? '' : 's'
      } remaining. No roster change was applied.`,
    );
  }

  return games;
}

async function loadRosterMoveReplayContext(
  leagueId: string | null,
): Promise<ServerRosterMoveReplayContext> {
  if (!leagueId) {
    return {
      mode: 'live',
      safePregameRecovery: false,
    };
  }

  const snapshot = await db.doc(
    `leagues/${leagueId}/historicalReplay/control`,
  ).get();

  return resolveServerRosterMoveReplayContext(
    snapshot.exists ? snapshot.data() : null,
  );
}

async function loadRosterMoveSeasonWindowAnchor(
  leagueId: string | null,
): Promise<RosterMoveSeasonWindowAnchor> {
  if (!leagueId) {
    return {
      initialNhlBlockNumber: 1,
      anchorReady: false,
      sourceGameIdsByTeam: null,
    };
  }

  const draftSnapshot = await db.doc(`leagues/${leagueId}/draft/current`).get();
  const data = draftSnapshot.data() ?? {};
  const value = data['initialNhlBlockNumber'];
  const initialNhlBlockNumber =
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : 1;

  return {
    initialNhlBlockNumber,
    anchorReady: data['seasonWindowAnchorStatus'] === 'ready',
    sourceGameIdsByTeam: data['seasonWindowSourceGameIdsByTeam'] ?? null,
  };
}

export function toLeagueRelativeCycleNumber(
  sourceNhlBlockNumber: number,
  initialNhlBlockNumber: number,
): number {
  return Math.max(1, sourceNhlBlockNumber - initialNhlBlockNumber + 1);
}

/**
 * Resolves the first fair source block without allowing a provider reorder to
 * replace any game frozen by the Draft season-window plan.
 */
export function determineEarliestEligibleSourceBlock(input: {
  schedule: NhlScheduleGame[];
  gamesPerCycle: number;
  initialNhlBlockNumber?: number;
  frozenSourceGameIdsByTeam?: unknown;
  teamAbbreviation?: string;
  completedThroughDate?: string | null;
  actionBoundaryMilliseconds?: number | null;
}): number {
  const gamesPerCycle = Math.max(1, Math.floor(input.gamesPerCycle));
  const initialNhlBlockNumber =
    typeof input.initialNhlBlockNumber === 'number' &&
    Number.isSafeInteger(input.initialNhlBlockNumber) &&
    input.initialNhlBlockNumber > 0
      ? input.initialNhlBlockNumber
      : 1;
  const openingIndex = initialNhlBlockNumber - 1;
  const hasFrozenSourcePlan =
    input.frozenSourceGameIdsByTeam !== null &&
    input.frozenSourceGameIdsByTeam !== undefined;
  const teamAbbreviation = asString(input.teamAbbreviation).toUpperCase();
  const gameById = new Map(
    input.schedule
      .filter((game) => typeof game.id === 'number' && Number.isSafeInteger(game.id))
      .map((game) => [game.id as number, game] as const),
  );

  if (hasFrozenSourcePlan && !/^[A-Z0-9]{2,4}$/.test(teamAbbreviation)) {
    throw new HttpsError(
      'failed-precondition',
      'The NHL team identity is missing from the frozen season-window plan. RinkRat cannot safely time this move.',
    );
  }

  const totalBlockCount = Math.max(
    initialNhlBlockNumber,
    Math.ceil(input.schedule.length / gamesPerCycle),
  );

  for (let index = openingIndex; index < totalBlockCount; index += 1) {
    const sourceNhlBlockNumber = index + 1;
    let blockGames: NhlScheduleGame[];

    if (hasFrozenSourcePlan) {
      let frozenIds: number[];

      try {
        const targetGameIdsByTeam = buildSourceNhlTargetGameIdsByTeam(
          input.frozenSourceGameIdsByTeam,
          sourceNhlBlockNumber,
          gamesPerCycle,
        );
        frozenIds = targetGameIdsByTeam[teamAbbreviation] ?? [];
      } catch (error: unknown) {
        const message = error instanceof Error
          ? error.message
          : 'The frozen NHL source-game plan is malformed.';

        throw new HttpsError(
          'failed-precondition',
          `${message} RinkRat cannot safely time this move.`,
        );
      }

      if (frozenIds.length !== gamesPerCycle) {
        throw new HttpsError(
          'failed-precondition',
          `The frozen NHL source-game plan is missing ${teamAbbreviation} for source block ${sourceNhlBlockNumber}. RinkRat cannot safely time this move.`,
        );
      }

      const missingGameIds = frozenIds.filter((gameId) => !gameById.has(gameId));

      if (missingGameIds.length > 0) {
        throw new HttpsError(
          'failed-precondition',
          `The NHL schedule is missing frozen game id(s) for ${teamAbbreviation} source block ${sourceNhlBlockNumber}: ${missingGameIds.join(', ')}.`,
        );
      }

      blockGames = frozenIds.map((gameId) => gameById.get(gameId)!);
    } else {
      blockGames = input.schedule.slice(
        index * gamesPerCycle,
        (index + 1) * gamesPerCycle,
      );
    }

    const states = blockGames.map((game) => {
      const state = getScheduleGameState(game, input.completedThroughDate ?? null);

      if (state !== 'scheduled' || input.actionBoundaryMilliseconds === null ||
          input.actionBoundaryMilliseconds === undefined) {
        return state;
      }

      const reachedStartBoundary = hasNhlGameReachedStartSafetyBoundary({
        source: game,
        observedAtMilliseconds: input.actionBoundaryMilliseconds,
      });
      if (reachedStartBoundary) {
        return 'live';
      }

      if (isNhlGameExplicitlyDeferred(game)) {
        return 'scheduled';
      }

      if (getScheduleGameStartMilliseconds(game) === null) {
        throw new HttpsError(
          'failed-precondition',
          `NHL game ${String(game.id ?? '')} is missing its exact puck-drop time. RinkRat cannot safely time this move.`,
        );
      }

      return 'scheduled';
    });
    const complete = blockGames.length > 0 &&
      states.every((state) => state === 'final');

    if (complete) {
      continue;
    }

    const started = states.some((state) => state === 'final' || state === 'live');

    return started ? index + 2 : index + 1;
  }

  return totalBlockCount + 1;
}

export interface RosterMoveAssetCycleEligibility<
  TAsset extends DraftableAsset | RosterAsset,
> {
  asset: TAsset;
  earliestEligibleCycleNumber: number;
  currentTeamAbbreviationByPlayerId?: ReadonlyMap<number, string>;
}

export async function resolveRosterMoveAssetCycleEligibility<
  TAsset extends DraftableAsset | RosterAsset,
>(
  asset: TAsset,
  gamesPerCycle: number,
  leagueId: string | null = null,
  currentTeamAbbreviationByPlayerId?: ReadonlyMap<number, string>,
  minimumIdentityGeneratedAtMilliseconds?: number,
): Promise<RosterMoveAssetCycleEligibility<TAsset>> {
  const [replayContext, seasonWindowAnchor] = await Promise.all([
    loadRosterMoveReplayContext(leagueId),
    loadRosterMoveSeasonWindowAnchor(leagueId),
  ]);

  if (replayContext.mode === 'blocked') {
    throw new HttpsError('failed-precondition', replayContext.message);
  }

  let resolvedCurrentTeamAbbreviationByPlayerId =
    replayContext.mode === 'historical-replay'
      ? undefined
      : currentTeamAbbreviationByPlayerId;

  if (
    replayContext.mode !== 'historical-replay' &&
    asset.assetType === 'skater' &&
    !resolvedCurrentTeamAbbreviationByPlayerId
  ) {
    resolvedCurrentTeamAbbreviationByPlayerId = (
      await loadCurrentNhlPlayerTeamIdentity({
        requiredPlayerIds: [asset.player.id],
        minimumGeneratedAtMilliseconds:
          minimumIdentityGeneratedAtMilliseconds,
      })
    ).byPlayerId;
  }

  const authoritativeAsset = replayContext.mode === 'historical-replay'
    ? asset
    : applyCurrentNhlTeamIdentity(
        asset,
        resolvedCurrentTeamAbbreviationByPlayerId,
      );
  const teamAbbreviation = getAssetTeamAbbreviation(authoritativeAsset)
    .trim()
    .toUpperCase();
  const season = replayContext.mode === 'historical-replay'
    ? replayContext.seasonOverride
    : getNhlSeasonForDate(new Date());
  const completedThroughDate = replayContext.mode === 'historical-replay'
    ? replayContext.completedThroughDate
    : null;
  let schedule: NhlScheduleGame[];

  try {
    schedule = replayContext.mode === 'historical-replay'
      ? await getNhlTeamSeasonSchedule(teamAbbreviation, season, 'standard')
      : await loadRosterMoveScheduleForTeam(teamAbbreviation);
  } catch (error: unknown) {
    if (error instanceof HttpsError) {
      throw error;
    }

    console.warn('Unable to resolve the roster-move NHL schedule.', {
      teamAbbreviation,
      season,
      error,
    });
    throw new HttpsError(
      'unavailable',
      `Unable to verify ${teamAbbreviation}'s current six-game window.`,
    );
  }

  if (schedule.length === 0) {
    throw new HttpsError(
      'failed-precondition',
      `No regular-season schedule was found for ${teamAbbreviation}.`,
    );
  }

  const initialNhlBlockNumber = replayContext.mode === 'historical-replay'
    ? 1
    : seasonWindowAnchor.initialNhlBlockNumber;
  if (
    replayContext.mode !== 'historical-replay' &&
    seasonWindowAnchor.anchorReady &&
    (seasonWindowAnchor.sourceGameIdsByTeam === null ||
      seasonWindowAnchor.sourceGameIdsByTeam === undefined)
  ) {
    throw new HttpsError(
      'failed-precondition',
      'The frozen NHL season-window plan is unavailable. RinkRat cannot safely time this move.',
    );
  }

  const sourceNhlBlockNumber = determineEarliestEligibleSourceBlock({
    schedule,
    gamesPerCycle,
    initialNhlBlockNumber,
    frozenSourceGameIdsByTeam:
      replayContext.mode !== 'historical-replay' && seasonWindowAnchor.anchorReady
        ? seasonWindowAnchor.sourceGameIdsByTeam
        : undefined,
    teamAbbreviation,
    completedThroughDate,
    actionBoundaryMilliseconds:
      replayContext.mode === 'historical-replay'
        ? null
        : minimumIdentityGeneratedAtMilliseconds ?? null,
  });

  const earliestEligibleCycleNumber = replayContext.mode === 'historical-replay'
    ? sourceNhlBlockNumber
    : toLeagueRelativeCycleNumber(
        sourceNhlBlockNumber,
        seasonWindowAnchor.initialNhlBlockNumber,
      );

  return {
    asset: authoritativeAsset,
    earliestEligibleCycleNumber,
    ...(resolvedCurrentTeamAbbreviationByPlayerId
      ? {
          currentTeamAbbreviationByPlayerId:
            resolvedCurrentTeamAbbreviationByPlayerId,
        }
      : {}),
  };
}

export async function getEarliestEligibleCycleNumber(
  asset: DraftableAsset | RosterAsset,
  gamesPerCycle: number,
  leagueId: string | null = null,
  currentTeamAbbreviationByPlayerId?: ReadonlyMap<number, string>,
  minimumIdentityGeneratedAtMilliseconds?: number,
): Promise<number> {
  return (
    await resolveRosterMoveAssetCycleEligibility(
      asset,
      gamesPerCycle,
      leagueId,
      currentTeamAbbreviationByPlayerId,
      minimumIdentityGeneratedAtMilliseconds,
    )
  ).earliestEligibleCycleNumber;
}

async function findSlotWindowContext(
  leagueId: string,
  ownerId: string,
  activeSlotId: string,
): Promise<SlotWindowContext | null> {
  const [cyclesSnapshot, rosterSnapshot] = await Promise.all([
    db.collection(`leagues/${leagueId}/cycles`).get(),
    db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`).get(),
  ]);
  const activeCycles = cyclesSnapshot.docs
    .map((snapshot) => ({
      snapshot,
      data: snapshot.data(),
      cycleNumber: asNumber(snapshot.data()['cycleNumber']),
    }))
    .filter((entry) => entry.data['status'] === 'active' && entry.cycleNumber > 0)
    .sort((first, second) => second.cycleNumber - first.cycleNumber);

  // An untouched slot can be deliberately opened during an active cycle by an
  // immediate IR move or drop. That slot no longer has a roster-pick/window,
  // so its persisted openFromCycleNumber is the only safe way to identify the
  // exact asynchronous cycle it may still rejoin.
  if (rosterSnapshot.exists) {
    const roster = normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>);
    const activeSlot = roster.activeSlots.find((slot) => slot.slotId === activeSlotId);
    const openFromCycleNumber =
      !activeSlot?.asset && typeof activeSlot?.openFromCycleNumber === 'number'
        ? activeSlot.openFromCycleNumber
        : null;

    if (openFromCycleNumber) {
      const openCycle = activeCycles.find(
        (entry) => entry.cycleNumber === openFromCycleNumber,
      );

      if (openCycle) {
        return {
          cycleNumber: openCycle.cycleNumber,
          cycleRefPath: openCycle.snapshot.ref.path,
          teamWindowsRefPath: `${openCycle.snapshot.ref.path}/teamWindows/${ownerId}`,
          rosterPickRefPath:
            `${openCycle.snapshot.ref.path}/rosterPicks/${getRosterPickDocumentId(ownerId, activeSlotId)}`,
          playoffBankRefPath: await findAssignedPlayoffBankRefPath({
            leagueId,
            ownerId,
            cycleNumber: openCycle.cycleNumber,
            cycleData: openCycle.data,
          }),
        };
      }
    }
  }

  for (const cycle of activeCycles) {
    const teamWindowsRefPath = `${cycle.snapshot.ref.path}/teamWindows/${ownerId}`;
    const rosterPickRefPath =
      `${cycle.snapshot.ref.path}/rosterPicks/${getRosterPickDocumentId(ownerId, activeSlotId)}`;
    const [teamWindowsSnapshot, rosterPickSnapshot] = await Promise.all([
      db.doc(teamWindowsRefPath).get(),
      db.doc(rosterPickRefPath).get(),
    ]);
    const windows = teamWindowsSnapshot.exists
      ? asArray(teamWindowsSnapshot.data()?.['windows']).map(asRecord)
      : [];
    const hasWindow = windows.some(
      (window) => asString(window['rosterSlotId']) === activeSlotId,
    );

    // Immediately after the draft, Cycle 1 roster-pick snapshots can exist a
    // few moments before the first scoring worker creates teamWindows. A saved
    // roster-pick with no window yet is therefore an untouched assignment.
    if (!hasWindow && !rosterPickSnapshot.exists) {
      continue;
    }

    return {
      cycleNumber: cycle.cycleNumber,
      cycleRefPath: cycle.snapshot.ref.path,
      teamWindowsRefPath,
      rosterPickRefPath,
      playoffBankRefPath: await findAssignedPlayoffBankRefPath({
        leagueId,
        ownerId,
        cycleNumber: cycle.cycleNumber,
        cycleData: cycle.data,
      }),
    };
  }

  return null;
}

async function findAssignedPlayoffBankRefPath(input: {
  leagueId: string;
  ownerId: string;
  cycleNumber: number;
  cycleData: Record<string, unknown>;
}): Promise<string | null> {
  if (asString(input.cycleData['phase']) !== 'playoffs') {
    return null;
  }

  const snapshot = await db.collection(
    `leagues/${input.leagueId}/playoffWindowBanks/${input.ownerId}/windows`,
  ).get();
  const matches = snapshot.docs.filter((document) => {
    const data = document.data();

    return asNumber(data['sourceCycleNumber']) === input.cycleNumber &&
      asString(data['assignmentStatus']) === 'assigned';
  });

  if (matches.length !== 1) {
    throw new HttpsError(
      'failed-precondition',
      `The assigned playoff window for Cycle ${input.cycleNumber} is unavailable. Refresh and try again.`,
    );
  }

  return matches[0].ref.path;
}

function buildResetWindow(
  previous: Record<string, unknown>,
  asset: DraftableAsset,
  ownerId: string,
  activeSlotId: string,
  cycleNumber: number,
): Record<string, unknown> {
  const now = new Date().toISOString();

  return {
    ...previous,
    id: asString(previous['id']) || getWindowId(ownerId, activeSlotId, cycleNumber),
    ownerId,
    rosterSlotId: activeSlotId,
    cycleNumber,
    position: asset.position,
    assetKey: asset.assetKey,
    asset,
    status: 'scheduled',
    scheduledGameIds: [],
    scheduledGameDates: [],
    scheduledGameLabels: [],
    scheduleTeamAbbreviation: null,
    sourceTeamAbbreviationByGameId: {},
    teamIdentityChanged: false,
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
      asset.frozenCycleProjectionPoints ?? asset.projectedCyclePoints ?? null,
    frozenProjectionVersion: asset.frozenProjectionVersion ?? null,
    frozenProjectionSource: asset.frozenProjectionSource ?? null,
    frozenProjectionSnapshotId:
      asset.frozenProjectionSnapshotId ?? asset.sharedProjectionSnapshotId ?? null,
    frozenProjectionGeneratedAt:
      asset.frozenProjectionGeneratedAt ?? asset.projectionGeneratedAt ?? null,
    frozenProjectionFrozenAt: now,
    frozenProjectionTargetGameIds: [],
    firstScheduledGameDate: null,
    lastScheduledGameDate: null,
    startedAt: null,
    completedAt: null,
    createdAt: previous['createdAt'] ?? now,
    updatedAt: now,
  };
}

function buildWaiverPayload(
  droppedAsset: RosterAsset,
  ownerId: string,
  cycleNumber: number,
): Record<string, unknown> {
  const asset = rosterAssetToDraftableAsset(droppedAsset);

  return {
    assetKey: asset.assetKey,
    asset,
    droppedAsset,
    droppedByOwnerId: ownerId,
    status: 'active',
    claims: [],
    awardedToOwnerId: null,
    effectiveCycleNumber: cycleNumber,
    effectiveLabel: `Cycle ${cycleNumber}`,
    queuedMoveId: null,
    rosterSlotId: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    processedAt: null,
  };
}

function resolveImmediateAddReplayResult(
  documentValue: unknown,
  submissionId: string | null,
  requestFingerprint: string | null,
): {
  applied: true;
  cycleNumber: number;
  activeSlotId: string;
  message: string;
} | null {
  const resolution = resolveRosterActionSubmission(
    documentValue,
    submissionId,
    requestFingerprint,
  );

  if (resolution.status === 'missing') {
    return null;
  }

  if (resolution.status === 'conflict') {
    throw new HttpsError(
      'failed-precondition',
      'This add/drop submission identifier was already used for a different roster move. Refresh before trying again.',
      { reason: 'roster-submission-id-reused' },
    );
  }

  const result = resolution.result;
  if (
    result['applied'] !== true ||
    typeof result['cycleNumber'] !== 'number' ||
    !Number.isSafeInteger(result['cycleNumber']) ||
    typeof result['activeSlotId'] !== 'string' ||
    typeof result['message'] !== 'string'
  ) {
    throw new HttpsError(
      'failed-precondition',
      'The saved add/drop result is malformed. No additional roster move was applied.',
    );
  }

  return {
    applied: true,
    cycleNumber: result['cycleNumber'],
    activeSlotId: result['activeSlotId'],
    message: result['message'],
  };
}

async function executeImmediateRosterMove(
  options: ImmediateRosterMoveExecutionOptions,
) {
    const authenticatedOwnerId = options.authenticatedOwnerId;
    if (!authenticatedOwnerId) {
      throw new HttpsError('unauthenticated', 'You must be signed in to change your roster.');
    }

    const ownerId = requireFirestoreDocumentId(
      authenticatedOwnerId,
      'manager ID',
      { maxBytes: 128 },
    );
    const input = asRecord(options.input) as unknown as ImmediateRosterMoveRequest;
    const leagueId = requireFirestoreDocumentId(input.leagueId, 'league ID', {
      minimumLength: 6,
      maxBytes: 128,
      pattern: /^[A-Za-z0-9_-]+$/,
    });
    if (options.callableRequest) {
      await enforceAppCheckCallableCanaryForLeague(
        options.callableRequest,
        'applyImmediateRosterMove',
        leagueId,
      );
    }
    const moveType = asString(input.moveType) as ImmediateRosterMoveType;
    const activeSlotId = requireFirestoreDocumentId(
      input.activeSlotId,
      'active roster slot ID',
      { maxBytes: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/ },
    );
    const benchSlotId = optionalFirestoreDocumentId(
      input.benchSlotId,
      'bench roster slot ID',
      { maxBytes: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/ },
    ) ?? '';
    const irSlotId = optionalFirestoreDocumentId(
      input.irSlotId,
      'injured reserve slot ID',
      { maxBytes: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/ },
    ) ?? '';
    const expectedOutgoingAssetKey = optionalFirestoreDocumentId(
      input.expectedOutgoingAssetKey,
      'expected outgoing asset key',
      { maxBytes: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ },
    );
    const submissionId = optionalFirestoreDocumentId(
      input.submissionId,
      'roster submission identifier',
      {
        minimumLength: 8,
        maxBytes: 120,
        pattern: /^[A-Za-z0-9_-]+$/,
      },
    );

    if (![
      'add-drop-active',
      'add-open-active',
      'active-bench-swap',
      'activate-ir-active',
      'move-active-to-ir',
      'injury-replacement',
      'injury-active-bench-swap',
      'injury-add-drop-active',
      'injury-add-open-active',
      'drop-active',
    ].includes(moveType)) {
      throw new HttpsError('invalid-argument', 'That immediate roster move type is not supported.');
    }

    const rawRequestedAssetKey = asString(input.addAssetKey) || getAssetKey(input.addAsset);
    const requestedAssetKey = rawRequestedAssetKey
      ? requireFirestoreDocumentId(rawRequestedAssetKey, 'asset key', {
          maxBytes: 160,
          pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
        })
      : '';
    const isImmediateAdd =
      moveType === 'add-drop-active' ||
      moveType === 'add-open-active' ||
      moveType === 'injury-add-drop-active' ||
      moveType === 'injury-add-open-active';
    const automaticInjuryReplacement = options.automaticInjuryReplacement;
    const expectedAutomaticPendingMoveId = automaticInjuryReplacement
      ? requireFirestoreDocumentId(
          automaticInjuryReplacement.expectedPendingMoveId,
          'queued roster move ID',
          {
            minimumLength: 1,
            maxBytes: 320,
          },
        )
      : null;
    const expectedAutomaticPendingMoveFingerprint = automaticInjuryReplacement
      ? asString(automaticInjuryReplacement.expectedPendingMoveFingerprint)
      : '';
    const expectedAutomaticQueueTransactionId = automaticInjuryReplacement?.expectedQueueTransactionId
      ? requireFirestoreDocumentId(
          automaticInjuryReplacement.expectedQueueTransactionId,
          'queued add-open transaction ID',
          { minimumLength: 1, maxBytes: 320 },
        )
      : null;
    const expectedAutomaticMoveToIrTransactionId = automaticInjuryReplacement?.expectedMoveToIrTransactionId
      ? requireFirestoreDocumentId(
          automaticInjuryReplacement.expectedMoveToIrTransactionId,
          'move-to-IR transaction ID',
          { minimumLength: 1, maxBytes: 320 },
        )
      : null;
    const expectedAutomaticIrSlotId = automaticInjuryReplacement?.expectedIrSlotId
      ? requireFirestoreDocumentId(
          automaticInjuryReplacement.expectedIrSlotId,
          'injured reserve slot ID',
          { maxBytes: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/ },
        )
      : null;
    const canTargetOpenSlot =
      moveType === 'add-open-active' ||
      moveType === 'active-bench-swap' ||
      moveType === 'activate-ir-active';

    if (automaticInjuryReplacement && !isMixedPlayerInjuryMove(moveType)) {
      throw new HttpsError(
        'invalid-argument',
        'Automatic injury automation can only promote an exact queued injury transaction.',
      );
    }
    if (moveType === 'injury-add-open-active' && !automaticInjuryReplacement) {
      throw new HttpsError(
        'invalid-argument',
        'An injury add-open recovery requires exact server-saved transaction evidence.',
      );
    }
    if (
      moveType === 'injury-add-open-active' &&
      (
        !expectedAutomaticQueueTransactionId ||
        !expectedAutomaticMoveToIrTransactionId ||
        !expectedAutomaticIrSlotId
      )
    ) {
      throw new HttpsError(
        'invalid-argument',
        'An injury add-open recovery requires exact IR and transaction history.',
      );
    }
    if (
      automaticInjuryReplacement &&
      !/^[a-f0-9]{64}$/.test(expectedAutomaticPendingMoveFingerprint)
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Automatic injury automation requires an exact queued-move fingerprint.',
      );
    }

    if (isImmediateAdd && !requestedAssetKey) {
      throw new HttpsError('invalid-argument', 'The incoming player is required.');
    }
    if (
      (moveType === 'add-drop-active' ||
        moveType === 'injury-add-drop-active') &&
      submissionId &&
      !expectedOutgoingAssetKey
    ) {
      throw new HttpsError(
        'invalid-argument',
        'The player selected to be dropped is required. Refresh and review the transaction again.',
      );
    }

    if (
      (moveType === 'active-bench-swap' ||
        isBenchSourcedInjuryMove(moveType)) &&
      !benchSlotId
    ) {
      throw new HttpsError('invalid-argument', 'The bench slot is required.');
    }

    if (moveType === 'activate-ir-active' && !irSlotId) {
      throw new HttpsError('invalid-argument', 'The IR slot is required.');
    }

    const automaticReceiptIdentity =
      automaticInjuryReplacement && expectedAutomaticPendingMoveId
        ? createAutomaticInjuryReplacementReceiptIdentity({
            leagueId,
            ownerId,
            activeSlotId,
            benchSlotId,
            moveType: moveType as MixedPlayerInjuryMoveType,
            incomingAssetKey: requestedAssetKey || null,
            pendingMoveId: expectedAutomaticPendingMoveId,
            pendingMoveFingerprint:
              expectedAutomaticPendingMoveFingerprint,
            queueTransactionId: expectedAutomaticQueueTransactionId,
            moveToIrTransactionId: expectedAutomaticMoveToIrTransactionId,
            irSlotId: expectedAutomaticIrSlotId,
          })
        : null;
    const replaySubmissionId = automaticReceiptIdentity?.submissionId ??
      (submissionId && isImmediateAdd ? submissionId : null);
    const requestFingerprint = automaticReceiptIdentity?.requestFingerprint ??
      (replaySubmissionId
          ? createRosterActionRequestFingerprint({
            activeSlotId,
            addAssetKey: requestedAssetKey,
            benchSlotId: benchSlotId || null,
            expectedOutgoingAssetKey,
            moveType,
          })
        : null);
    const transactionRef = replaySubmissionId
      ? db.doc(
          `leagues/${leagueId}/transactions/${
            automaticReceiptIdentity?.transactionId ??
            createRosterActionTransactionId({
              namespace: 'roster-add',
              leagueId,
              ownerId,
              submissionId: replaySubmissionId,
            })
          }`,
        )
      : db.collection(`leagues/${leagueId}/transactions`).doc();
    const [
      leagueSnapshot,
      memberSnapshot,
      draftSnapshot,
      teamsSnapshot,
      replaySnapshot,
    ] = await Promise.all([
      db.doc(`leagues/${leagueId}`).get(),
      db.doc(`leagues/${leagueId}/members/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/draft/current`).get(),
      db.collection(`leagues/${leagueId}/teams`).get(),
      replaySubmissionId
        ? transactionRef.get()
        : Promise.resolve(null),
    ]);

    if (!leagueSnapshot.exists || !memberSnapshot.exists) {
      throw new HttpsError('permission-denied', 'You are not a member of this league.');
    }

    if (!draftSnapshot.exists || draftSnapshot.data()?.['status'] !== 'complete') {
      throw new HttpsError('failed-precondition', 'Roster moves open after the draft is complete.');
    }

    if (replaySnapshot?.exists) {
      const replay = resolveImmediateAddReplayResult(
        replaySnapshot.data(),
        replaySubmissionId,
        requestFingerprint,
      );
      if (replay) {
        return replay;
      }
    }

    const addAsset = requestedAssetKey
      ? await loadCanonicalDraftableAsset(leagueId, requestedAssetKey)
      : null;

    const context = await findSlotWindowContext(leagueId, ownerId, activeSlotId);
    if (!context) {
      throw new HttpsError(
        'failed-precondition',
        'The current slot window is not ready yet. Refresh and try again.',
      );
    }
    if (
      moveType === 'injury-add-open-active' &&
      context.playoffBankRefPath
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Legacy IR vacancy recovery is limited to an exact regular-season scoring window.',
      );
    }
    const actionBoundaryMilliseconds = Date.now();

    const scoringRules = asRecord(leagueSnapshot.data()?.['scoringRules']);
    const gamesPerCycle = Math.max(
      1,
      Math.floor(asNumber(scoringRules['requiredGamesPerCycle'], DEFAULT_GAMES_PER_CYCLE)),
    );

    let incomingEligibilityCycle = 1;
    if (addAsset && (!asString(addAsset.assetKey) || !asString(addAsset.position))) {
      throw new HttpsError('invalid-argument', 'The incoming asset is invalid.');
    }

    const rosterRef = db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`);
    const cycleRef = db.doc(context.cycleRefPath);
    const teamWindowsRef = db.doc(context.teamWindowsRefPath);
    const rosterPickRef = db.doc(context.rosterPickRefPath);
    const playoffBankRef = context.playoffBankRefPath
      ? db.doc(context.playoffBankRefPath)
      : null;
    const rosterRefs = teamsSnapshot.docs
      .filter((team) => team.id !== ownerId)
      .map((team) =>
        db.doc(`leagues/${leagueId}/teams/${team.id}/roster/current`),
      );
    const sourceQueueTransactionRef = expectedAutomaticQueueTransactionId
      ? db.doc(
          `leagues/${leagueId}/transactions/${expectedAutomaticQueueTransactionId}`,
        )
      : null;
    const sourceMoveToIrTransactionRef = expectedAutomaticMoveToIrTransactionId
      ? db.doc(
          `leagues/${leagueId}/transactions/${expectedAutomaticMoveToIrTransactionId}`,
        )
      : null;

    const [
      preflightRosterSnapshot,
      preflightRosterPickSnapshot,
      preflightTeamWindowsSnapshot,
      preflightPlayoffBankSnapshot,
      preflightSourceQueueTransactionSnapshot,
      preflightSourceMoveToIrTransactionSnapshot,
    ] = await Promise.all([
      rosterRef.get(),
      rosterPickRef.get(),
      teamWindowsRef.get(),
      playoffBankRef
        ? playoffBankRef.get()
        : Promise.resolve(null),
      sourceQueueTransactionRef
        ? sourceQueueTransactionRef.get()
        : Promise.resolve(null),
      sourceMoveToIrTransactionRef
        ? sourceMoveToIrTransactionRef.get()
        : Promise.resolve(null),
    ]);

    if (
      !preflightRosterSnapshot.exists ||
      (playoffBankRef && !preflightPlayoffBankSnapshot?.exists)
    ) {
      throw new HttpsError('failed-precondition', 'The current roster assignment was not found.');
    }

    const preflightRoster = normalizeFantasyRoster(
      preflightRosterSnapshot.data() as Partial<FantasyRoster>,
    );
    const preflightMatchingActiveSlots = preflightRoster.activeSlots.filter(
      (slot) => slot.slotId === activeSlotId,
    );
    const preflightActiveSlot = preflightMatchingActiveSlots[0];
    const preflightRosterPickAsset = preflightRosterPickSnapshot.data()?.['asset'] as
      | DraftableAsset
      | undefined;
    const preflightPlayoffBankData = preflightPlayoffBankSnapshot?.exists
      ? preflightPlayoffBankSnapshot.data() ?? {}
      : null;
    let preflightBankPick: Record<string, unknown> | null = null;
    let preflightBankWindow: Record<string, unknown> | null = null;

    if (
      !preflightActiveSlot ||
      (
        moveType === 'injury-add-open-active' &&
        preflightMatchingActiveSlots.length !== 1
      )
    ) {
      throw new HttpsError('failed-precondition', 'The current active-slot assignment is unavailable.');
    }

    if (
      expectedAutomaticPendingMoveId &&
      preflightActiveSlot.pendingMove?.id !== expectedAutomaticPendingMoveId
    ) {
      throw new HttpsError(
        'failed-precondition',
        'The queued bench swap changed before automatic injury replacement began. No move was applied.',
      );
    }

    if (!preflightActiveSlot.asset && canTargetOpenSlot) {
      if (preflightActiveSlot.openFromCycleNumber !== context.cycleNumber) {
        throw new HttpsError(
          'failed-precondition',
          'That open slot is no longer eligible to join the current cycle immediately.',
        );
      }
    } else if (!preflightRosterPickSnapshot.exists || !preflightRosterPickAsset) {
      throw new HttpsError('failed-precondition', 'The current active-slot assignment is unavailable.');
    }

    if (preflightPlayoffBankData) {
      if (
        asString(preflightPlayoffBankData['ownerId']) !== ownerId ||
        asNumber(preflightPlayoffBankData['sourceCycleNumber']) !==
          context.cycleNumber ||
        asString(preflightPlayoffBankData['assignmentStatus']) !== 'assigned'
      ) {
        throw new HttpsError(
          'failed-precondition',
          'The assigned playoff window changed while the move was being checked. Refresh and try again.',
        );
      }

      preflightBankPick = asArray(preflightPlayoffBankData['picks'])
        .map(asRecord)
        .find((pick) => asString(pick['rosterSlotId']) === activeSlotId) ?? null;
      preflightBankWindow = asArray(preflightPlayoffBankData['slotWindows'])
        .map(asRecord)
        .find((window) => asString(window['rosterSlotId']) === activeSlotId) ?? null;

      if (preflightRosterPickSnapshot.exists) {
        const rosterPickData = preflightRosterPickSnapshot.data() ?? {};
        const rosterPickAssetKey = getAssetKey(rosterPickData['asset']);
        const bankPickAssetKey = getAssetKey(preflightBankPick?.['asset']);
        const rosterContinuityId = asString(
          asRecord(rosterPickData['playerWindowContinuity'])['continuityId'],
        );
        const bankContinuityId = asString(
          asRecord(preflightBankPick?.['playerWindowContinuity'])['continuityId'],
        );

        if (
          !preflightBankPick ||
          !preflightBankWindow ||
          bankPickAssetKey !== rosterPickAssetKey ||
          bankContinuityId !== rosterContinuityId
        ) {
          throw new HttpsError(
            'failed-precondition',
            'The playoff bank and active cycle assignment are out of sync. No move was applied.',
          );
        }
      } else if (preflightBankPick || preflightBankWindow) {
        throw new HttpsError(
          'failed-precondition',
          'The playoff bank still owns this open slot. No move was applied.',
        );
      }
    }

    const preflightOutgoingAssetKey = getAssetKey(preflightRosterPickAsset);
    const preflightMatchingLegacyIrSlots =
      moveType === 'injury-add-open-active'
        ? preflightRoster.irSlots.filter(
            (slot) => slot.slotId === expectedAutomaticIrSlotId,
          )
        : [];
    const preflightLegacyIrSlot =
      preflightMatchingLegacyIrSlots.length === 1
        ? preflightMatchingLegacyIrSlots[0]
        : null;
    const preflightLegacyIrAsset = preflightLegacyIrSlot?.asset ?? null;
    if (automaticInjuryReplacement) {
      const preflightIncomingAssetKey =
        moveType === 'injury-add-drop-active' ||
        moveType === 'injury-add-open-active'
        ? getAssetKey(preflightActiveSlot.pendingMove?.incomingAsset)
        : getAssetKey(
            preflightRoster.benchSlots.find(
              (slot) => slot.slotId === benchSlotId,
            )?.asset,
          );
      const observedPendingMoveFingerprint = moveType === 'injury-add-open-active'
        ? getQueuedIrAddOpenInjuryPromotionFingerprint({
            pendingMove: preflightActiveSlot.pendingMove,
            ownerId,
            activeSlotId,
            activePosition: preflightActiveSlot.position,
            incomingAssetKey: preflightIncomingAssetKey,
            irSlotId: expectedAutomaticIrSlotId ?? '',
            irAsset: preflightLegacyIrAsset,
            queueTransactionId: expectedAutomaticQueueTransactionId ?? '',
            queueTransaction:
              preflightSourceQueueTransactionSnapshot?.data(),
            moveToIrTransactionId:
              expectedAutomaticMoveToIrTransactionId ?? '',
            moveToIrTransaction:
              preflightSourceMoveToIrTransactionSnapshot?.data(),
          })
        : getQueuedInjuryPromotionFingerprint({
            moveType,
            pendingMove: preflightActiveSlot.pendingMove,
            ownerId,
            activeSlotId,
            benchSlotId,
            outgoingAssetKey: preflightOutgoingAssetKey,
            incomingAssetKey: preflightIncomingAssetKey,
          });
      const legacyReservationIsExclusive =
        moveType !== 'injury-add-open-active' ||
        Boolean(
          preflightActiveSlot.asset === null &&
          preflightActiveSlot.openFromCycleNumber === null &&
          preflightActiveSlot.pendingMove &&
          preflightMatchingLegacyIrSlots.length === 1 &&
          preflightLegacyIrAsset &&
          getAssetKey(preflightLegacyIrAsset) === preflightOutgoingAssetKey &&
          preflightRoster.activeSlots.filter(
            (slot) =>
              slot.pendingMove?.id === preflightActiveSlot.pendingMove?.id,
          ).length === 1 &&
          preflightRoster.irSlots.filter(
            (slot) => getAssetKey(slot.asset) === preflightOutgoingAssetKey,
          ).length === 1 &&
          isExclusiveQueuedFreeAgentReservation({
            roster: preflightRoster,
            activeSlotId,
            pendingMoveId: preflightActiveSlot.pendingMove.id,
            incomingAssetKey: preflightIncomingAssetKey,
          }),
        );

      if (
        observedPendingMoveFingerprint !==
          expectedAutomaticPendingMoveFingerprint ||
        !legacyReservationIsExclusive
      ) {
        throw new HttpsError(
          'failed-precondition',
          'The queued injury transaction changed before automatic replacement began. No move was applied.',
        );
      }
    }
    if (
      (moveType === 'add-drop-active' ||
        moveType === 'injury-add-drop-active') &&
      expectedOutgoingAssetKey &&
      getAssetKey(preflightActiveSlot.asset) !== expectedOutgoingAssetKey
    ) {
      throw new HttpsError(
        'aborted',
        'The selected active player changed before the move was checked. Refresh and review the add/drop again.',
      );
    }
    if (
      preflightActiveSlot.asset &&
      (moveType === 'add-drop-active' || moveType === 'active-bench-swap')
    ) {
      throw new HttpsError(
        'failed-precondition',
        'Changing an occupied active slot must be scheduled for the next eligible matchup unless the server verifies an injury transaction.',
      );
    }
    const rosterMoveReplayContext = await loadRosterMoveReplayContext(leagueId);

    if (rosterMoveReplayContext.mode === 'blocked') {
      throw new HttpsError(
        'failed-precondition',
        rosterMoveReplayContext.message,
      );
    }

    let rosterMoveIdentity: NhlPlayerTeamIdentitySnapshot | null = null;
    const preflightSelectedIncomingAsset =
      moveType === 'active-bench-swap' || isBenchSourcedInjuryMove(moveType)
      ? preflightRoster.benchSlots.find((slot) => slot.slotId === benchSlotId)
          ?.asset
      : moveType === 'activate-ir-active'
        ? preflightRoster.irSlots.find((slot) => slot.slotId === irSlotId)
            ?.asset
        : null;
    const requiredIdentityPlayerIds = getSkaterPlayerIds([
      preflightActiveSlot.asset,
      preflightLegacyIrAsset,
      addAsset,
      preflightSelectedIncomingAsset,
    ]);

    if (
      rosterMoveReplayContext.mode === 'live' &&
      requiredIdentityPlayerIds.length > 0
    ) {
      const identityBoundaryMilliseconds = Date.now();
      rosterMoveIdentity = isImmediateAdd
        ? await loadExactRosterActionPlayerTeamIdentity(
            requiredIdentityPlayerIds,
            identityBoundaryMilliseconds,
          )
        : await loadCurrentNhlPlayerTeamIdentity({
            requiredPlayerIds: requiredIdentityPlayerIds,
            minimumGeneratedAtMilliseconds: identityBoundaryMilliseconds,
          });
    }

    const currentTeamAbbreviationByPlayerId = rosterMoveIdentity?.byPlayerId;
    const preflightActiveAssetSource = preflightActiveSlot.asset ??
      (moveType === 'injury-add-open-active' ? preflightLegacyIrAsset : null);
    const preflightActiveAsset = preflightActiveAssetSource
      ? applyCurrentNhlTeamIdentity(
          preflightActiveAssetSource,
          currentTeamAbbreviationByPlayerId,
        )
      : null;
    const authoritativeAddAsset = addAsset
      ? applyCurrentNhlTeamIdentity(
          addAsset,
          currentTeamAbbreviationByPlayerId,
        )
      : null;

    if (preflightActiveAsset) {
      if (
        getAssetKey(preflightActiveAsset) !== preflightOutgoingAssetKey
      ) {
        throw new HttpsError(
          'aborted',
          'The active roster and current cycle assignment are out of sync. Refresh and try again.',
        );
      }
    } else if (
      !canTargetOpenSlot &&
      moveType !== 'injury-add-open-active'
    ) {
      throw new HttpsError('failed-precondition', 'The active roster slot is already empty.');
    }

    // The saved scoring window is the primary lock, but the server also checks
    // the outgoing NHL team's real schedule. This closes the small gap between
    // puck drop and the next scoring-worker refresh: both individual assets
    // truly must be untouched for an immediate current-cycle rewrite.
    const [resolvedIncomingEligibilityCycle, resolvedOutgoingEligibilityCycle] =
      await Promise.all([
        authoritativeAddAsset
          ? getEarliestEligibleCycleNumber(
              authoritativeAddAsset,
              gamesPerCycle,
              leagueId,
              currentTeamAbbreviationByPlayerId,
              actionBoundaryMilliseconds,
            )
          : Promise.resolve(1),
        preflightActiveAsset && !isMixedPlayerInjuryMove(moveType)
          ? getEarliestEligibleCycleNumber(
              preflightActiveAsset,
              gamesPerCycle,
              leagueId,
              currentTeamAbbreviationByPlayerId,
              actionBoundaryMilliseconds,
            )
          : Promise.resolve(null),
      ]);
    incomingEligibilityCycle = resolvedIncomingEligibilityCycle;

    if (
      preflightActiveAsset &&
      !isMixedPlayerInjuryMove(moveType) &&
      resolvedOutgoingEligibilityCycle !== null
    ) {
      const outgoingEligibilityCycle = Math.max(
        preflightActiveAsset.eligibleFromCycleNumber ?? 1,
        resolvedOutgoingEligibilityCycle,
      );

      if (outgoingEligibilityCycle > context.cycleNumber) {
        throw new HttpsError(
          'failed-precondition',
          `The current player's Cycle ${context.cycleNumber} block has already started. This move must wait until Cycle ${outgoingEligibilityCycle}.`,
        );
      }
    }

    let preflightMoveToIrAvailabilityStatus = '';

    if (moveType === 'move-active-to-ir' || isMixedPlayerInjuryMove(moveType)) {
      if (!preflightActiveAsset || preflightActiveAsset.assetType !== 'skater') {
        throw new HttpsError(
          'failed-precondition',
          isMixedPlayerInjuryMove(moveType)
            ? 'Only injured skaters can use an immediate injury transaction.'
            : 'Only skaters can be moved to IR.',
        );
      }

      preflightMoveToIrAvailabilityStatus =
        automaticInjuryReplacement ||
        requiresFreshInjuryAvailabilityAuthority(moveType)
          ? await getAutomaticInjuryAvailabilityStatus(
              leagueId,
              preflightActiveAsset,
            )
          : await getAuthoritativeAvailabilityStatus(
              leagueId,
              preflightActiveAsset,
            );

      if (
        !getEligibleStatusesForInjuryMove(moveType).has(
          preflightMoveToIrAvailabilityStatus,
        )
      ) {
        throw new HttpsError(
          'failed-precondition',
          isMixedPlayerInjuryMove(moveType)
            ? 'That player is no longer eligible for an immediate injury transaction.'
            : 'That player is not currently eligible for an IR roster slot.',
        );
      }
    }

    let preflightBenchAssetKey = '';
    let preflightBenchEligibilityCycle: number | null = null;
    let preflightSupersededQueuedMoveId = '';
    let preflightSupersededQueuedMoveFingerprint = '';
    let preflightIrAssetKey = '';
    let preflightIrEligibilityCycle: number | null = null;
    let preflightIrBenchSlotId = '';
    let preflightIrBenchAssetKey = '';

    if (
      moveType === 'active-bench-swap' ||
      isBenchSourcedInjuryMove(moveType) ||
      moveType === 'activate-ir-active'
    ) {
      if (moveType === 'active-bench-swap' || isBenchSourcedInjuryMove(moveType)) {
        const preflightBenchSlot = preflightRoster.benchSlots.find(
          (slot) => slot.slotId === benchSlotId,
        );
        const preflightBenchAsset = preflightBenchSlot?.asset
          ? applyCurrentNhlTeamIdentity(
              preflightBenchSlot.asset,
              currentTeamAbbreviationByPlayerId,
            )
          : null;

        if (!preflightBenchAsset) {
          throw new HttpsError('failed-precondition', 'The selected bench player is unavailable.');
        }

        preflightBenchAssetKey = getAssetKey(preflightBenchAsset);
        const queuedMovePromotionFingerprint =
          isBenchSourcedInjuryMove(moveType)
            ? getQueuedInjuryPromotionFingerprint({
                moveType,
                pendingMove: preflightActiveSlot.pendingMove,
                ownerId,
                activeSlotId,
                benchSlotId,
                outgoingAssetKey: preflightOutgoingAssetKey,
                incomingAssetKey: preflightBenchAssetKey,
              })
            : null;
        const queuedMovePromotionIsExclusive = Boolean(
          queuedMovePromotionFingerprint &&
          preflightActiveSlot.pendingMove &&
          isExclusiveQueuedBenchSwapReservation({
            roster: preflightRoster,
            activeSlotId,
            benchSlotId,
            pendingMoveId: preflightActiveSlot.pendingMove.id,
            incomingAssetKey: preflightBenchAssetKey,
          }),
        );

        if (
          isBenchSourcedInjuryMove(moveType) &&
          preflightActiveSlot.pendingMove &&
          !queuedMovePromotionIsExclusive
        ) {
          throw new HttpsError(
            'failed-precondition',
            'That active slot already has a different queued move. Cancel it before replacing the injured player.',
          );
        }

        if (
          isBenchSlotReserved(preflightRoster, benchSlotId) &&
          !queuedMovePromotionIsExclusive
        ) {
          throw new HttpsError(
            'failed-precondition',
            'That bench player is reserved for another scheduled lineup move.',
          );
        }

        if (
          queuedMovePromotionIsExclusive &&
          preflightActiveSlot.pendingMove &&
          queuedMovePromotionFingerprint
        ) {
          preflightSupersededQueuedMoveId = preflightActiveSlot.pendingMove.id;
          preflightSupersededQueuedMoveFingerprint =
            queuedMovePromotionFingerprint;
        }

        if (moveType === 'active-bench-swap') {
          preflightBenchEligibilityCycle = Math.max(
            preflightBenchAsset.eligibleFromCycleNumber ?? 1,
            await getEarliestEligibleCycleNumber(
              preflightBenchAsset,
              gamesPerCycle,
              leagueId,
              currentTeamAbbreviationByPlayerId,
              actionBoundaryMilliseconds,
            ),
          );
        }
      } else {
        const preflightIrSlot = preflightRoster.irSlots.find((slot) => slot.slotId === irSlotId);
        const preflightIrAsset = preflightIrSlot?.asset
          ? applyCurrentNhlTeamIdentity(
              preflightIrSlot.asset,
              currentTeamAbbreviationByPlayerId,
            )
          : null;

        if (!preflightIrAsset) {
          throw new HttpsError('failed-precondition', 'The selected IR player is unavailable.');
        }

        preflightIrAssetKey = getAssetKey(preflightIrAsset);
        preflightIrEligibilityCycle = Math.max(
          preflightIrAsset.eligibleFromCycleNumber ?? 1,
          await getEarliestEligibleCycleNumber(
            preflightIrAsset,
            gamesPerCycle,
            leagueId,
            currentTeamAbbreviationByPlayerId,
            actionBoundaryMilliseconds,
          ),
        );

        if (preflightActiveSlot.asset) {
          const requestedBenchSlot = benchSlotId
            ? preflightRoster.benchSlots.find((slot) => slot.slotId === benchSlotId) ?? null
            : null;
          const fallbackOpenBenchSlot = !benchSlotId
            ? preflightRoster.benchSlots.find(
                (slot) => slot.asset === null && !isBenchSlotReserved(preflightRoster, slot.slotId),
              ) ?? null
            : null;
          const selectedBenchSlot = requestedBenchSlot ?? fallbackOpenBenchSlot;

          if (!selectedBenchSlot) {
            throw new HttpsError(
              'failed-precondition',
              benchSlotId
                ? 'The selected bench destination is unavailable.'
                : 'Every usable bench spot is full. Choose the bench player or goalie unit to place on waivers.',
            );
          }

          if (isBenchSlotReserved(preflightRoster, selectedBenchSlot.slotId)) {
            throw new HttpsError(
              'failed-precondition',
              'That bench spot is reserved for another scheduled lineup move.',
            );
          }

          preflightIrBenchSlotId = selectedBenchSlot.slotId;
          preflightIrBenchAssetKey = getAssetKey(selectedBenchSlot.asset);
        }
      }
    }

    if (
      moveType === 'injury-add-drop-active' &&
      preflightActiveSlot.pendingMove
    ) {
      const pendingMoveFingerprint =
        getQueuedFreeAgentInjuryPromotionFingerprint({
          pendingMove: preflightActiveSlot.pendingMove,
          ownerId,
          activeSlotId,
          outgoingAssetKey: preflightOutgoingAssetKey,
          incomingAssetKey: requestedAssetKey,
        });
      const pendingMoveIsExclusive = Boolean(
        pendingMoveFingerprint &&
        isExclusiveQueuedFreeAgentReservation({
          roster: preflightRoster,
          activeSlotId,
          pendingMoveId: preflightActiveSlot.pendingMove.id,
          incomingAssetKey: requestedAssetKey,
        }),
      );

      if (!pendingMoveFingerprint || !pendingMoveIsExclusive) {
        throw new HttpsError(
          'failed-precondition',
          'That active slot already has a different queued move. Cancel it before replacing the injured player.',
        );
      }

      preflightSupersededQueuedMoveId = preflightActiveSlot.pendingMove.id;
      preflightSupersededQueuedMoveFingerprint = pendingMoveFingerprint;
    }
    if (
      moveType === 'injury-add-open-active' &&
      preflightActiveSlot.pendingMove
    ) {
      preflightSupersededQueuedMoveId = preflightActiveSlot.pendingMove.id;
      preflightSupersededQueuedMoveFingerprint =
        expectedAutomaticPendingMoveFingerprint;
    }

    const rawPreflightIncomingAsset =
      moveType === 'active-bench-swap' || isBenchSourcedInjuryMove(moveType)
        ? rosterAssetToDraftableAsset(
            preflightRoster.benchSlots.find((slot) => slot.slotId === benchSlotId)!.asset!,
          )
        : moveType === 'activate-ir-active'
          ? rosterAssetToDraftableAsset(
              preflightRoster.irSlots.find((slot) => slot.slotId === irSlotId)!.asset!,
            )
          : authoritativeAddAsset;
    const preflightIncomingAsset = rawPreflightIncomingAsset
      ? applyCurrentNhlTeamIdentity(
          rawPreflightIncomingAsset,
          currentTeamAbbreviationByPlayerId,
        )
      : null;
    const resolvedIncomingAsset = preflightIncomingAsset
      ? applyCurrentNhlTeamIdentity(
          await resolveIncomingProjectionForCycle(
            leagueId,
            context.cycleNumber,
            preflightIncomingAsset,
          ),
          currentTeamAbbreviationByPlayerId,
        )
      : null;
    let preflightInjuryPlan: InjuryReplacementWindowPlan | null = null;
    let preflightExistingInjuryTransactionId = '';
    let preflightExistingInjuryPlanFingerprint = '';
    let preflightCurrentSegmentGameIds: number[] = [];
    let preflightInjuryGameDateById: Record<string, string> = {};
    let preflightInjuryGameLabelById: Record<string, string> = {};
    let preflightInjuryOwnershipChangeStartMillisecondsByGameId: Record<
      string,
      number
    > = {};

    if (isMixedPlayerInjuryMove(moveType)) {
      if (rosterMoveReplayContext.mode !== 'live') {
        throw new HttpsError(
          'failed-precondition',
          'Injury replacement is unavailable while historical replay is active.',
        );
      }
      if (
        !preflightActiveAsset ||
        preflightActiveAsset.assetType !== 'skater' ||
        !resolvedIncomingAsset ||
        resolvedIncomingAsset.assetType !== 'skater'
      ) {
        throw new HttpsError(
          'failed-precondition',
          'An injured skater and a matching replacement skater are required.',
        );
      }
      if (preflightActiveAsset.position !== resolvedIncomingAsset.position) {
        throw new HttpsError(
          'failed-precondition',
          `The replacement must play ${preflightActiveAsset.position}.`,
        );
      }
      if (
        !getEligibleStatusesForInjuryMove(moveType).has(
          preflightMoveToIrAvailabilityStatus,
        )
      ) {
        throw new HttpsError(
          'failed-precondition',
          'The active player is no longer eligible for an immediate injury transaction.',
        );
      }

      const preflightWindows = preflightTeamWindowsSnapshot.exists
        ? asArray(preflightTeamWindowsSnapshot.data()?.['windows']).map(asRecord)
        : [];
      const preflightMatchingWindows = preflightWindows.filter(
        (window) => asString(window['rosterSlotId']) === activeSlotId,
      );
      const preflightWindow =
        moveType === 'injury-add-open-active'
          ? preflightMatchingWindows.length === 1
            ? preflightMatchingWindows[0]
            : null
          : preflightMatchingWindows[0] ?? null;
      const pickData = preflightRosterPickSnapshot.data() ?? {};
      if (moveType === 'injury-add-open-active') {
        const continuityIsExact = hasExactPlayerWindowContinuityCopies({
          first: pickData['playerWindowContinuity'],
          second: preflightWindow?.['playerWindowContinuity'],
          ownerId,
          activeSlotId,
          assetKey: preflightOutgoingAssetKey,
        });

        if (
          !preflightWindow ||
          asString(preflightWindow['ownerId']) !== ownerId ||
          asString(preflightWindow['rosterSlotId']) !== activeSlotId ||
          asString(preflightWindow['assetKey']) !== preflightOutgoingAssetKey ||
          getAssetKey(preflightWindow['asset']) !== preflightOutgoingAssetKey ||
          asString(preflightWindow['position']) !== preflightActiveAsset.position ||
          asString(pickData['ownerId']) !== ownerId ||
          asString(pickData['rosterSlotId']) !== activeSlotId ||
          !isActiveOrLegacyMissingRosterArea(pickData['rosterArea']) ||
          getAssetKey(pickData['asset']) !== preflightOutgoingAssetKey ||
          asString(asRecord(pickData['asset'])['position']) !==
            preflightActiveAsset.position ||
          !continuityIsExact
        ) {
          throw new HttpsError(
            'failed-precondition',
            'The IR vacancy no longer matches its exact active scoring window. No move was applied.',
          );
        }
      }
      const previousPlan = preflightPlayoffBankData
        ? selectCurrentInjuryReplacementPlanFromCopies([
            {
              label: 'cycle window',
              value: preflightWindow?.['injuryReplacementWindow'],
            },
            {
              label: 'playoff bank window',
              value: preflightBankWindow?.['injuryReplacementWindow'],
            },
            {
              label: 'cycle pick',
              value: pickData['injuryReplacementWindow'],
            },
            {
              label: 'playoff bank pick',
              value: preflightBankPick?.['injuryReplacementWindow'],
            },
          ])
        : selectCurrentInjuryReplacementPlan(
            pickData['injuryReplacementWindow'],
            preflightWindow?.['injuryReplacementWindow'],
          );

      assertWindowPreservesSelectedInjuryReplacementPlan({
        window: preflightWindow,
        selectedPlan: previousPlan,
        context: 'The current cycle window',
      });
      if (preflightPlayoffBankData) {
        assertWindowPreservesSelectedInjuryReplacementPlan({
          window: preflightBankWindow,
          selectedPlan: previousPlan,
          context: 'The assigned playoff bank window',
        });
      }

      if (previousPlan && previousPlan.requiredGames !== gamesPerCycle) {
        throw new HttpsError(
          'failed-precondition',
          'The saved injury-replacement game allowance does not match this league. No roster move was applied.',
        );
      }

      preflightExistingInjuryTransactionId = previousPlan?.latestTransactionId ?? '';
      preflightExistingInjuryPlanFingerprint = previousPlan
        ? getInjuryReplacementPlanAuthorityFingerprint(previousPlan)
        : '';
      const currentSegment = previousPlan?.segments.at(-1);
      const currentScheduledGameIds = currentSegment?.scheduledGameIds ??
        asArray(preflightWindow?.['scheduledGameIds'] ?? pickData['sourceNhlTargetGameIds'])
          .filter(
            (gameId): gameId is number =>
              typeof gameId === 'number' &&
              Number.isSafeInteger(gameId) &&
              gameId > 0,
          );
      preflightCurrentSegmentGameIds = [...currentScheduledGameIds];

      if (currentScheduledGameIds.length === 0) {
        throw new HttpsError(
          'failed-precondition',
          'The active slot does not have a verifiable six-game schedule yet. Try again shortly.',
        );
      }

      const sourceTeamAbbreviationByGameId = asRecord(
        preflightWindow?.['sourceTeamAbbreviationByGameId'],
      );
      const fallbackOutgoingTeamAbbreviation =
        currentSegment?.sourceTeamAbbreviation ??
        (asString(preflightWindow?.['scheduleTeamAbbreviation']) ||
          getAssetTeamAbbreviation(preflightActiveAsset));
      const outgoingTeamAbbreviations = [
        ...new Set(
          currentScheduledGameIds.map((gameId) =>
            currentSegment?.sourceTeamAbbreviationByGameId?.[String(gameId)] ??
            (asString(sourceTeamAbbreviationByGameId[String(gameId)]) ||
              fallbackOutgoingTeamAbbreviation),
          ),
        ),
      ];
      const retainedSegmentTeamAbbreviations = previousPlan?.segments.flatMap(
        (segment) => segment.scheduledGameIds.map(
          (gameId) =>
            segment.sourceTeamAbbreviationByGameId?.[String(gameId)] ??
            (asString(sourceTeamAbbreviationByGameId[String(gameId)]) ||
              segment.sourceTeamAbbreviation),
        ),
      ) ?? [];
      const incomingTeamAbbreviation =
        getAssetTeamAbbreviation(resolvedIncomingAsset).trim().toUpperCase();
      const requiredTeamAbbreviations = [
        ...new Set([
          ...retainedSegmentTeamAbbreviations,
          ...outgoingTeamAbbreviations,
          incomingTeamAbbreviation,
        ]),
      ];
      const schedulesByTeam = new Map(
        await Promise.all(
          requiredTeamAbbreviations.map(async (teamAbbreviation) => [
            teamAbbreviation,
            await loadRosterMoveScheduleForTeam(teamAbbreviation),
          ] as const),
        ),
      );
      const outgoingSchedule = [
        ...new Map(
          outgoingTeamAbbreviations.flatMap((teamAbbreviation) =>
            (schedulesByTeam.get(teamAbbreviation) ?? []).map(
              (game) => [game.id, game] as const,
            ),
          ),
        ).values(),
      ];
      const incomingSchedule =
        schedulesByTeam.get(incomingTeamAbbreviation) ?? [];
      const startedCurrentGameIds = getStartedScheduledGameIds({
        scheduledGameIds: currentScheduledGameIds,
        schedule: outgoingSchedule,
        boundaryMilliseconds: actionBoundaryMilliseconds,
      });
      const priorRetainedGameCount = previousPlan
        ? previousPlan.segments.slice(0, -1).reduce(
            (total, segment) => total + segment.scheduledGameIds.length,
            0,
          )
        : 0;
      const remainingGames = gamesPerCycle -
        priorRetainedGameCount -
        startedCurrentGameIds.size;

      if (remainingGames <= 0) {
        throw new HttpsError(
          'failed-precondition',
          'This active slot has already used all of its games for the matchup.',
        );
      }

      const incomingGames = selectFutureInjuryReplacementGames({
        schedule: incomingSchedule,
        boundaryMilliseconds: actionBoundaryMilliseconds,
        count: remainingGames,
      });
      const ownershipChangingGames = [
        ...currentScheduledGameIds
          .filter((gameId) => !startedCurrentGameIds.has(gameId))
          .map((gameId) => outgoingSchedule.find((game) => game.id === gameId)),
        ...incomingGames,
      ];
      preflightInjuryOwnershipChangeStartMillisecondsByGameId =
        Object.fromEntries(
          ownershipChangingGames.map((game) => {
            const gameId = game?.id;
            const startMilliseconds = game
              ? getScheduleGameStartMilliseconds(game)
              : null;

            if (
              typeof gameId !== 'number' ||
              !Number.isSafeInteger(gameId) ||
              startMilliseconds === null
            ) {
              throw new HttpsError(
                'failed-precondition',
                'An ownership-changing NHL game is missing its exact puck-drop evidence. No roster move was applied.',
              );
            }

            return [String(gameId), startMilliseconds];
          }),
        );
      const incomingContinuity = createPlayerWindowContinuity({
        ownerId,
        rosterSlotId: activeSlotId,
        asset: resolvedIncomingAsset,
        activationKey: `injury-${transactionRef.id}`,
        assignmentNotBefore: actionBoundaryMilliseconds,
      });

      preflightInjuryPlan = buildInjuryReplacementWindowPlan({
        previousPlan,
        currentAsset: rosterAssetToDraftableAsset(preflightActiveAsset),
        currentPlayerWindowContinuity:
          currentSegment?.playerWindowContinuity ??
          (pickData['playerWindowContinuity'] as
            | import('./shared/core/draft/draft.models').PlayerWindowContinuity
            | undefined),
        currentScheduledGameIds,
        startedCurrentGameIds,
        currentSourceTeamAbbreviation:
          currentSegment?.sourceTeamAbbreviation ??
          getAssetTeamAbbreviation(preflightActiveAsset),
        currentSourceTeamAbbreviationByGameId: Object.fromEntries(
          currentScheduledGameIds.map((gameId) => [
            String(gameId),
            currentSegment?.sourceTeamAbbreviationByGameId?.[String(gameId)] ??
              (asString(sourceTeamAbbreviationByGameId[String(gameId)]) ||
                fallbackOutgoingTeamAbbreviation),
          ]),
        ),
        existingSourceTeamAbbreviationByGameId: Object.fromEntries(
          Object.entries(sourceTeamAbbreviationByGameId).flatMap(
            ([gameId, team]) => {
              const normalizedTeam = asString(team).trim().toUpperCase();
              return normalizedTeam ? [[gameId, normalizedTeam]] : [];
            },
          ),
        ),
        incomingAsset: resolvedIncomingAsset,
        incomingScheduledGameIds: incomingGames.map((game) => game.id!),
        incomingSourceTeamAbbreviation:
          getAssetTeamAbbreviation(resolvedIncomingAsset),
        incomingPlayerWindowContinuity: incomingContinuity ?? undefined,
        transactionId: transactionRef.id,
        boundaryMilliseconds: actionBoundaryMilliseconds,
        requiredGames: gamesPerCycle,
      });
      const verifiedScheduleEvidenceByGameId = new Map<
        number,
        { game: NhlScheduleGame; sourceTeam: string }
      >();

      for (const segment of preflightInjuryPlan.segments) {
        for (const gameId of segment.scheduledGameIds) {
          const sourceTeam =
            segment.sourceTeamAbbreviationByGameId?.[String(gameId)] ??
            segment.sourceTeamAbbreviation;
          const game = (schedulesByTeam.get(sourceTeam) ?? []).find(
            (candidate) => candidate.id === gameId,
          );
          const homeTeam = asString(game?.homeTeam?.abbrev).toUpperCase();
          const awayTeam = asString(game?.awayTeam?.abbrev).toUpperCase();

          if (!game || (homeTeam !== sourceTeam && awayTeam !== sourceTeam)) {
            throw new HttpsError(
              'failed-precondition',
              `NHL game ${gameId} could not be verified for ${sourceTeam}. No roster move was applied.`,
            );
          }

          verifiedScheduleEvidenceByGameId.set(gameId, { game, sourceTeam });
        }
      }

      preflightInjuryGameDateById = Object.fromEntries(
        getInjuryReplacementGameIds(preflightInjuryPlan).map((gameId) => [
          String(gameId),
          asString(verifiedScheduleEvidenceByGameId.get(gameId)?.game.gameDate),
        ]),
      );
      preflightInjuryGameLabelById = Object.fromEntries(
        preflightInjuryPlan.segments.flatMap((segment) =>
          segment.scheduledGameIds.map((gameId) => {
            const evidence = verifiedScheduleEvidenceByGameId.get(gameId)!;
            const game = evidence.game;
            const team = evidence.sourceTeam;
            const homeTeam = asString(game?.homeTeam?.abbrev).toUpperCase();
            const awayTeam = asString(game?.awayTeam?.abbrev).toUpperCase();
            const label = homeTeam === team
              ? `vs ${awayTeam}`
              : `@ ${homeTeam}`;

            return [String(gameId), label] as const;
          }),
        ),
      );
    }

    const incomingWaiverRef = isImmediateAdd && requestedAssetKey
      ? db.doc(`leagues/${leagueId}/waivers/${requestedAssetKey}`)
      : null;

    return db.runTransaction(async (transaction) => {
      const [
        submissionSnapshot,
        rosterSnapshot,
        cycleSnapshot,
        teamWindowsSnapshot,
        rosterPickSnapshot,
        playoffBankSnapshot,
        incomingWaiverSnapshot,
        sourceQueueTransactionSnapshot,
        sourceMoveToIrTransactionSnapshot,
        ...allRosterSnapshots
      ] =
        await Promise.all([
          replaySubmissionId
            ? transaction.get(transactionRef)
            : Promise.resolve(null),
          transaction.get(rosterRef),
          transaction.get(cycleRef),
          transaction.get(teamWindowsRef),
          transaction.get(rosterPickRef),
          playoffBankRef
            ? transaction.get(playoffBankRef)
            : Promise.resolve(null),
          incomingWaiverRef
            ? transaction.get(incomingWaiverRef)
            : Promise.resolve(null),
          sourceQueueTransactionRef
            ? transaction.get(sourceQueueTransactionRef)
            : Promise.resolve(null),
          sourceMoveToIrTransactionRef
            ? transaction.get(sourceMoveToIrTransactionRef)
            : Promise.resolve(null),
          ...rosterRefs.map((reference) => transaction.get(reference)),
        ]);

      if (submissionSnapshot?.exists) {
        const replay = resolveImmediateAddReplayResult(
          submissionSnapshot.data(),
          replaySubmissionId,
          requestFingerprint,
        );
        if (replay) {
          return replay;
        }
      }

      if (
        !rosterSnapshot.exists ||
        !cycleSnapshot.exists ||
        (!canTargetOpenSlot && !rosterPickSnapshot.exists) ||
        (playoffBankRef && !playoffBankSnapshot?.exists)
      ) {
        throw new HttpsError('failed-precondition', 'The current roster assignment is unavailable.');
      }

      const transactionCycleData = cycleSnapshot.data() ?? {};
      if (
        asString(transactionCycleData['status']) !== 'active' ||
        asNumber(transactionCycleData['cycleNumber']) !== context.cycleNumber
      ) {
        throw new HttpsError(
          'aborted',
          'The active matchup changed while the roster move was being checked. No move was applied.',
        );
      }

      const roster = normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>);
      const matchingActiveSlotIndexes = roster.activeSlots.flatMap(
        (slot, index) => slot.slotId === activeSlotId ? [index] : [],
      );
      const activeSlotIndex = matchingActiveSlotIndexes[0] ?? -1;
      if (
        activeSlotIndex < 0 ||
        (
          moveType === 'injury-add-open-active' &&
          matchingActiveSlotIndexes.length !== 1
        )
      ) {
        throw new HttpsError('not-found', 'The selected active roster slot was not found.');
      }

      const activeSlot = roster.activeSlots[activeSlotIndex];
      if (
        activeSlot.asset &&
        (moveType === 'add-drop-active' || moveType === 'active-bench-swap')
      ) {
        throw new HttpsError(
          'failed-precondition',
          'Changing an occupied active slot must be scheduled for the next eligible matchup unless the server verifies an injury transaction.',
        );
      }
      // An injury transaction reaches its branch so the transaction can
      // promote one exact reservation. Every other pending move still fails
      // closed during the fingerprint and exclusivity checks below.
      if (activeSlot.pendingMove && !isMixedPlayerInjuryMove(moveType)) {
        throw new HttpsError('failed-precondition', 'That active slot already has a queued move.');
      }

      if (
        (moveType === 'add-drop-active' ||
          moveType === 'injury-add-drop-active') &&
        expectedOutgoingAssetKey &&
        getAssetKey(activeSlot.asset) !== expectedOutgoingAssetKey
      ) {
        throw new HttpsError(
          'aborted',
          'The selected active player changed before the move was saved. Refresh and review the add/drop again.',
        );
      }

      const transactionPickAsset = rosterPickSnapshot.data()?.['asset'];
      const transactionActiveAssetKey = getAssetKey(activeSlot.asset);
      if (
        activeSlot.asset &&
        (
          getAssetKey(transactionPickAsset) !== preflightOutgoingAssetKey ||
          transactionActiveAssetKey !== preflightOutgoingAssetKey
        )
      ) {
        throw new HttpsError(
          'aborted',
          'The active-slot assignment changed while the move was being checked. Please try again.',
        );
      }
      const transactionMatchingLegacyIrSlots =
        moveType === 'injury-add-open-active'
          ? roster.irSlots.filter(
              (slot) => slot.slotId === expectedAutomaticIrSlotId,
            )
          : [];
      const transactionLegacyIrSlot =
        transactionMatchingLegacyIrSlots.length === 1
          ? transactionMatchingLegacyIrSlots[0]
          : null;
      const transactionLegacyIrAsset = transactionLegacyIrSlot?.asset ?? null;
      if (moveType === 'injury-add-open-active') {
        const incomingKey = getAssetKey(activeSlot.pendingMove?.incomingAsset);
        const observedFingerprint =
          getQueuedIrAddOpenInjuryPromotionFingerprint({
            pendingMove: activeSlot.pendingMove,
            ownerId,
            activeSlotId,
            activePosition: activeSlot.position,
            incomingAssetKey: incomingKey,
            irSlotId: expectedAutomaticIrSlotId ?? '',
            irAsset: transactionLegacyIrAsset,
            queueTransactionId: expectedAutomaticQueueTransactionId ?? '',
            queueTransaction: sourceQueueTransactionSnapshot?.data(),
            moveToIrTransactionId:
              expectedAutomaticMoveToIrTransactionId ?? '',
            moveToIrTransaction: sourceMoveToIrTransactionSnapshot?.data(),
          });
        const exactReservationStillExists = Boolean(
          activeSlot.asset === null &&
          activeSlot.openFromCycleNumber === null &&
          activeSlot.pendingMove &&
          transactionMatchingLegacyIrSlots.length === 1 &&
          getAssetKey(transactionPickAsset) === preflightOutgoingAssetKey &&
          getAssetKey(transactionLegacyIrAsset) === preflightOutgoingAssetKey &&
          roster.activeSlots.filter(
            (slot) => slot.pendingMove?.id === activeSlot.pendingMove?.id,
          ).length === 1 &&
          roster.irSlots.filter(
            (slot) => getAssetKey(slot.asset) === preflightOutgoingAssetKey,
          ).length === 1 &&
          isExclusiveQueuedFreeAgentReservation({
            roster,
            activeSlotId,
            pendingMoveId: activeSlot.pendingMove.id,
            incomingAssetKey: incomingKey,
          }),
        );

        if (
          observedFingerprint !== expectedAutomaticPendingMoveFingerprint ||
          observedFingerprint !== preflightSupersededQueuedMoveFingerprint ||
          activeSlot.pendingMove?.id !== preflightSupersededQueuedMoveId ||
          !exactReservationStillExists
        ) {
          throw new HttpsError(
            'aborted',
            'The IR vacancy or queued add-open transaction changed while the injury replacement was being checked.',
          );
        }
      }

      const teamWindowsData = teamWindowsSnapshot.exists
        ? teamWindowsSnapshot.data() ?? {}
        : {};
      const playoffBankData = playoffBankSnapshot?.exists
        ? playoffBankSnapshot.data() ?? {}
        : null;
      let savedBankPick: Record<string, unknown> | null = null;
      let savedBankWindow: Record<string, unknown> | null = null;

      if (playoffBankData) {
        if (
          asString(playoffBankData['ownerId']) !== ownerId ||
          asNumber(playoffBankData['sourceCycleNumber']) !==
            context.cycleNumber ||
          asString(playoffBankData['assignmentStatus']) !== 'assigned'
        ) {
          throw new HttpsError(
            'aborted',
            'The assigned playoff window changed while the move was being checked. Refresh and try again.',
          );
        }

        savedBankPick = asArray(playoffBankData['picks'])
          .map(asRecord)
          .find((pick) => asString(pick['rosterSlotId']) === activeSlotId) ?? null;
        savedBankWindow = asArray(playoffBankData['slotWindows'])
          .map(asRecord)
          .find((window) => asString(window['rosterSlotId']) === activeSlotId) ?? null;

        if (rosterPickSnapshot.exists) {
          const rosterPickData = rosterPickSnapshot.data() ?? {};
          const rosterPickAssetKey = getAssetKey(rosterPickData['asset']);
          const bankPickAssetKey = getAssetKey(savedBankPick?.['asset']);
          const rosterContinuityId = asString(
            asRecord(rosterPickData['playerWindowContinuity'])['continuityId'],
          );
          const bankContinuityId = asString(
            asRecord(savedBankPick?.['playerWindowContinuity'])['continuityId'],
          );

          if (
            !savedBankPick ||
            !savedBankWindow ||
            bankPickAssetKey !== rosterPickAssetKey ||
            bankContinuityId !== rosterContinuityId
          ) {
            throw new HttpsError(
              'aborted',
              'The playoff bank and active cycle assignment are out of sync. No move was applied.',
            );
          }
        } else if (savedBankPick || savedBankWindow) {
          throw new HttpsError(
            'aborted',
            'The playoff bank still owns this open slot. No move was applied.',
          );
        }
      }

      if (
        (canTargetOpenSlot || isMixedPlayerInjuryMove(moveType)) &&
        asString(teamWindowsData['status']) === 'complete'
      ) {
        throw new HttpsError(
          'failed-precondition',
          `Cycle ${context.cycleNumber} is already complete for this team. The move must begin in the next cycle.`,
        );
      }

      const windows = asArray(teamWindowsData['windows']).map(asRecord);
      const matchingWindowIndexes = windows.flatMap(
        (window, index) =>
          asString(window['rosterSlotId']) === activeSlotId ? [index] : [],
      );
      const windowIndex =
        moveType === 'injury-add-open-active' &&
        matchingWindowIndexes.length !== 1
          ? -1
          : matchingWindowIndexes[0] ?? -1;

      if (
        !isMixedPlayerInjuryMove(moveType) &&
        windowIndex >= 0 &&
        !isUntouchedWindow(windows[windowIndex])
      ) {
        throw new HttpsError(
          'failed-precondition',
          'This slot has started its current six-game window. The move must wait for the next boundary.',
        );
      }

      if (isMixedPlayerInjuryMove(moveType)) {
        if (!preflightInjuryPlan) {
          throw new HttpsError(
            'aborted',
            'The injury-replacement ownership plan is unavailable. Please try again.',
          );
        }

        const savedPickData = rosterPickSnapshot.data() ?? {};
        const savedWindow = windowIndex >= 0 ? windows[windowIndex] : null;
        if (moveType === 'injury-add-open-active') {
          const continuityIsExact = hasExactPlayerWindowContinuityCopies({
            first: savedPickData['playerWindowContinuity'],
            second: savedWindow?.['playerWindowContinuity'],
            ownerId,
            activeSlotId,
            assetKey: preflightOutgoingAssetKey,
          });

          if (
            !savedWindow ||
            asString(savedWindow['ownerId']) !== ownerId ||
            asString(savedWindow['rosterSlotId']) !== activeSlotId ||
            asString(savedWindow['assetKey']) !== preflightOutgoingAssetKey ||
            getAssetKey(savedWindow['asset']) !== preflightOutgoingAssetKey ||
            asString(savedWindow['position']) !== preflightActiveAsset?.position ||
            asString(savedPickData['ownerId']) !== ownerId ||
            asString(savedPickData['rosterSlotId']) !== activeSlotId ||
            !isActiveOrLegacyMissingRosterArea(savedPickData['rosterArea']) ||
            getAssetKey(savedPickData['asset']) !== preflightOutgoingAssetKey ||
            asString(asRecord(savedPickData['asset'])['position']) !==
              preflightActiveAsset?.position ||
            !continuityIsExact
          ) {
            throw new HttpsError(
              'aborted',
              'The IR vacancy scoring identity changed while the injury replacement was being checked.',
            );
          }
        }
        const savedExistingPlan = playoffBankData
          ? selectCurrentInjuryReplacementPlanFromCopies([
              {
                label: 'cycle window',
                value: savedWindow?.['injuryReplacementWindow'],
              },
              {
                label: 'playoff bank window',
                value: savedBankWindow?.['injuryReplacementWindow'],
              },
              {
                label: 'cycle pick',
                value: savedPickData['injuryReplacementWindow'],
              },
              {
                label: 'playoff bank pick',
                value: savedBankPick?.['injuryReplacementWindow'],
              },
            ])
          : selectCurrentInjuryReplacementPlan(
              savedPickData['injuryReplacementWindow'],
              savedWindow?.['injuryReplacementWindow'],
            );
        assertWindowPreservesSelectedInjuryReplacementPlan({
          window: savedWindow,
          selectedPlan: savedExistingPlan,
          context: 'The current cycle window',
        });
        if (playoffBankData) {
          assertWindowPreservesSelectedInjuryReplacementPlan({
            window: savedBankWindow,
            selectedPlan: savedExistingPlan,
            context: 'The assigned playoff bank window',
          });
        }
        const savedCurrentSegmentGameIds =
          savedExistingPlan?.segments.at(-1)?.scheduledGameIds ??
          asArray(savedWindow?.['scheduledGameIds'] ?? savedPickData['sourceNhlTargetGameIds'])
            .filter(
              (gameId): gameId is number =>
                typeof gameId === 'number' &&
                Number.isSafeInteger(gameId) &&
                gameId > 0,
            );

        if (
          (savedExistingPlan?.latestTransactionId ?? '') !==
            preflightExistingInjuryTransactionId ||
          (savedExistingPlan
            ? getInjuryReplacementPlanAuthorityFingerprint(savedExistingPlan)
            : '') !== preflightExistingInjuryPlanFingerprint ||
          JSON.stringify(savedCurrentSegmentGameIds) !==
            JSON.stringify(preflightCurrentSegmentGameIds)
        ) {
          throw new HttpsError(
            'aborted',
            'The scoring window changed while the injury replacement was being checked. Please try again.',
          );
        }

        if (
          automaticInjuryReplacement ||
          requiresFreshInjuryAvailabilityAuthority(moveType)
        ) {
          const crossedPuckDropGameIds =
            getReachedAutomaticInjuryReplacementOwnershipBoundaryGameIds({
              startMillisecondsByGameId:
                preflightInjuryOwnershipChangeStartMillisecondsByGameId,
              observedAtMilliseconds: Date.now(),
            });

          if (crossedPuckDropGameIds.length > 0) {
            throw new HttpsError(
              'aborted',
              `NHL game ${crossedPuckDropGameIds.join(', ')} reached puck drop while the injury transaction was being checked. ` +
                'No roster move was applied; the next retry will use fresh game ownership.',
            );
          }
        }

        assertInjuryReplacementPlanPreservesTransactionProtectedGames({
          window: savedWindow,
          previousPlan: savedExistingPlan,
          nextPlan: preflightInjuryPlan,
          context: 'The current cycle window',
        });
        if (playoffBankData) {
          assertInjuryReplacementPlanPreservesTransactionProtectedGames({
            window: savedBankWindow,
            previousPlan: savedExistingPlan,
            nextPlan: preflightInjuryPlan,
            context: 'The assigned playoff bank window',
          });
        }
      }

      let incomingAsset: DraftableAsset | null = null;
      const outgoingAssetSource = activeSlot.asset ??
        (moveType === 'injury-add-open-active'
          ? transactionLegacyIrAsset
          : null);
      const outgoingAsset = outgoingAssetSource
        ? applyCurrentNhlTeamIdentity(
            outgoingAssetSource,
            currentTeamAbbreviationByPlayerId,
          )
        : null;
      let droppedAsset: RosterAsset | null =
        moveType === 'activate-ir-active' ||
        moveType === 'injury-add-open-active'
        ? null
        : outgoingAsset;
      let benchSlotIdForTransaction: string | null = null;
      let irSlotIdForTransaction: string | null = null;
      let supersededQueuedMoveId: string | null = null;
      const removesActiveAssignment =
        moveType === 'move-active-to-ir' || moveType === 'drop-active';

      if (moveType === 'injury-add-open-active') {
        irSlotIdForTransaction = expectedAutomaticIrSlotId;
      }

      let transactionMoveToIrAvailabilityStatus = '';
      if (moveType === 'move-active-to-ir' || isMixedPlayerInjuryMove(moveType)) {
        if (!outgoingAsset || outgoingAsset.assetType !== 'skater') {
          throw new HttpsError(
            'failed-precondition',
            isMixedPlayerInjuryMove(moveType)
              ? 'Only injured skaters can use an immediate injury transaction.'
              : 'Only skaters can be moved to IR.',
          );
        }

        const [leagueOverrideSnapshot, globalAvailabilitySnapshot] =
          await Promise.all([
            transaction.get(
              db.doc(
                `leagues/${leagueId}/playerAvailability/${outgoingAsset.player.id}`,
              ),
            ),
            transaction.get(db.doc('appData/playerAvailability')),
          ]);
        transactionMoveToIrAvailabilityStatus =
          automaticInjuryReplacement ||
          requiresFreshInjuryAvailabilityAuthority(moveType)
            ? resolveAutomaticInjuryAvailabilityStatus(
                outgoingAsset,
                leagueOverrideSnapshot.data(),
                globalAvailabilitySnapshot.data(),
                Date.now(),
                leagueId,
              )
            : resolveAuthoritativeAvailabilityStatus(
                outgoingAsset,
                leagueOverrideSnapshot.data(),
                globalAvailabilitySnapshot.data(),
              );

        if (
          !getEligibleStatusesForInjuryMove(moveType).has(
            transactionMoveToIrAvailabilityStatus,
          )
        ) {
          throw new HttpsError(
            'failed-precondition',
            isMixedPlayerInjuryMove(moveType)
              ? 'The active player is no longer eligible for an immediate injury transaction.'
              : 'That player is no longer eligible for an IR roster slot.',
          );
        }
      }

      if (
        (moveType === 'add-drop-active' ||
          moveType === 'injury-add-drop-active' ||
          moveType === 'move-active-to-ir' ||
          moveType === 'drop-active') &&
        !outgoingAsset
      ) {
        throw new HttpsError('failed-precondition', 'The active roster slot is already empty.');
      }

      if (!outgoingAsset && canTargetOpenSlot) {
        if (activeSlot.openFromCycleNumber !== context.cycleNumber) {
          throw new HttpsError(
            'failed-precondition',
            'That open slot can no longer join the current cycle immediately.',
          );
        }
      }

      if (moveType === 'move-active-to-ir') {
        if (!outgoingAsset || outgoingAsset.assetType !== 'skater') {
          throw new HttpsError('failed-precondition', 'Only skaters can be moved to IR.');
        }

        const openIrSlotIndex = roster.irSlots.findIndex((slot) => slot.asset === null);
        if (openIrSlotIndex < 0) {
          throw new HttpsError('failed-precondition', 'All IR slots are already filled.');
        }

        irSlotIdForTransaction = roster.irSlots[openIrSlotIndex].slotId;
        roster.irSlots[openIrSlotIndex] = {
          ...roster.irSlots[openIrSlotIndex],
          asset: { ...outgoingAsset, rosterStatus: 'injured' },
        };
        roster.activeSlots[activeSlotIndex] = {
          ...activeSlot,
          asset: null,
          pendingMove: null,
          openFromCycleNumber: context.cycleNumber,
        };
      } else if (moveType === 'drop-active') {
        roster.activeSlots[activeSlotIndex] = {
          ...activeSlot,
          asset: null,
          pendingMove: null,
          openFromCycleNumber: context.cycleNumber,
        };
      } else if (moveType === 'activate-ir-active') {
        const irSlotIndex = roster.irSlots.findIndex((slot) => slot.slotId === irSlotId);
        if (irSlotIndex < 0 || !roster.irSlots[irSlotIndex].asset) {
          throw new HttpsError('failed-precondition', 'The selected IR player is unavailable.');
        }

        const irAsset = roster.irSlots[irSlotIndex].asset!;
        if (getAssetKey(irAsset) !== preflightIrAssetKey) {
          throw new HttpsError(
            'aborted',
            'The selected IR slot changed while the move was being checked. Please try again.',
          );
        }

        if (irAsset.position !== activeSlot.position) {
          throw new HttpsError(
            'failed-precondition',
            `That IR player can only move into a ${irAsset.position} slot.`,
          );
        }

        const earliest = preflightIrEligibilityCycle ?? Number.MAX_SAFE_INTEGER;
        if (earliest > context.cycleNumber) {
          throw new HttpsError(
            'failed-precondition',
            `The IR player's current block has already started. The earliest fair activation is Cycle ${earliest}.`,
          );
        }

        incomingAsset = resolvedIncomingAsset;
        if (!incomingAsset || getAssetKey(incomingAsset) !== preflightIrAssetKey) {
          throw new HttpsError('aborted', 'The IR player projection could not be refreshed. Please try again.');
        }

        if (outgoingAsset) {
          if (!preflightIrBenchSlotId) {
            throw new HttpsError(
              'failed-precondition',
              'Choose the bench spot that should receive the displaced starter.',
            );
          }

          const benchSlotIndex = roster.benchSlots.findIndex(
            (slot) => slot.slotId === preflightIrBenchSlotId,
          );
          if (benchSlotIndex < 0) {
            throw new HttpsError('failed-precondition', 'The selected bench destination was not found.');
          }

          const selectedBenchSlot = roster.benchSlots[benchSlotIndex];
          if (isBenchSlotReserved(roster, selectedBenchSlot.slotId)) {
            throw new HttpsError(
              'failed-precondition',
              'That bench spot is reserved for another scheduled lineup move.',
            );
          }

          if (getAssetKey(selectedBenchSlot.asset) !== preflightIrBenchAssetKey) {
            throw new HttpsError(
              'aborted',
              'The selected bench destination changed while the move was being checked. Please try again.',
            );
          }

          droppedAsset = selectedBenchSlot.asset;
          roster.benchSlots[benchSlotIndex] = {
            ...selectedBenchSlot,
            asset: { ...outgoingAsset, rosterStatus: 'benched' },
          };
          benchSlotIdForTransaction = selectedBenchSlot.slotId;
        }

        roster.activeSlots[activeSlotIndex] = {
          ...activeSlot,
          asset: createRosterAsset(
            incomingAsset,
            context.cycleNumber,
            'active',
          ),
          pendingMove: null,
          openFromCycleNumber: null,
        };
        roster.irSlots[irSlotIndex] = {
          ...roster.irSlots[irSlotIndex],
          asset: null,
        };
        irSlotIdForTransaction = irSlotId;
      } else if (isBenchSourcedInjuryMove(moveType)) {
        const benchSlotIndex = roster.benchSlots.findIndex(
          (slot) => slot.slotId === benchSlotId,
        );
        const benchAsset = benchSlotIndex >= 0
          ? roster.benchSlots[benchSlotIndex].asset
          : null;

        if (
          !outgoingAsset ||
          outgoingAsset.assetType !== 'skater' ||
          !benchAsset ||
          benchAsset.assetType !== 'skater' ||
          !preflightInjuryPlan ||
          !resolvedIncomingAsset
        ) {
          throw new HttpsError(
            'failed-precondition',
            'The injured player or selected bench replacement is no longer available.',
          );
        }

        const queuedMovePromotionFingerprint =
          getQueuedInjuryPromotionFingerprint({
            moveType,
            pendingMove: activeSlot.pendingMove,
            ownerId,
            activeSlotId,
            benchSlotId,
            outgoingAssetKey: getAssetKey(outgoingAsset),
            incomingAssetKey: getAssetKey(benchAsset),
          });
        const queuedMovePromotionIsExclusive = Boolean(
          queuedMovePromotionFingerprint &&
          activeSlot.pendingMove &&
          isExclusiveQueuedBenchSwapReservation({
            roster,
            activeSlotId,
            benchSlotId,
            pendingMoveId: activeSlot.pendingMove.id,
            incomingAssetKey: getAssetKey(benchAsset),
          }),
        );

        if (preflightSupersededQueuedMoveId) {
          if (
            !activeSlot.pendingMove ||
            activeSlot.pendingMove.id !== preflightSupersededQueuedMoveId ||
            queuedMovePromotionFingerprint !==
              preflightSupersededQueuedMoveFingerprint ||
            !queuedMovePromotionIsExclusive
          ) {
            throw new HttpsError(
              'aborted',
              'The queued bench swap changed while the injury transaction was being checked. Please try again.',
            );
          }

          supersededQueuedMoveId = preflightSupersededQueuedMoveId;
        } else if (activeSlot.pendingMove) {
          throw new HttpsError(
            'aborted',
            'A queued move was added to this active slot while the injury replacement was being checked. Please try again.',
          );
        }

        if (
          isBenchSlotReserved(roster, benchSlotId) &&
          !supersededQueuedMoveId
        ) {
          throw new HttpsError(
            'failed-precondition',
            'That bench player is reserved for another scheduled lineup move.',
          );
        }
        if (
          getAssetKey(benchAsset) !== preflightBenchAssetKey ||
          getAssetKey(resolvedIncomingAsset) !== preflightBenchAssetKey
        ) {
          throw new HttpsError(
            'aborted',
            'The selected bench replacement changed while the move was being checked.',
          );
        }
        if (outgoingAsset.position !== benchAsset.position) {
          throw new HttpsError(
            'failed-precondition',
            `The replacement must play ${outgoingAsset.position}.`,
          );
        }
        incomingAsset = resolvedIncomingAsset;
        droppedAsset = null;
        benchSlotIdForTransaction = benchSlotId;
        roster.benchSlots[benchSlotIndex] = {
          ...roster.benchSlots[benchSlotIndex],
          asset: moveType === 'injury-replacement'
            ? null
            : { ...outgoingAsset, rosterStatus: 'benched' },
        };
        if (moveType === 'injury-replacement') {
          const openIrSlotIndex = roster.irSlots.findIndex(
            (slot) => slot.asset === null,
          );
          if (openIrSlotIndex < 0) {
            throw new HttpsError(
              'failed-precondition',
              'All Injured Reserve slots are already filled.',
            );
          }

          irSlotIdForTransaction = roster.irSlots[openIrSlotIndex].slotId;
          roster.irSlots[openIrSlotIndex] = {
            ...roster.irSlots[openIrSlotIndex],
            asset: { ...outgoingAsset, rosterStatus: 'injured' },
          };
        }
        roster.activeSlots[activeSlotIndex] = {
          ...activeSlot,
          asset: createRosterAsset(
            resolvedIncomingAsset,
            context.cycleNumber,
            'active',
          ),
          pendingMove: null,
          openFromCycleNumber: null,
        };
      } else if (moveType === 'active-bench-swap') {
        const benchSlotIndex = roster.benchSlots.findIndex((slot) => slot.slotId === benchSlotId);
        if (benchSlotIndex < 0 || !roster.benchSlots[benchSlotIndex].asset) {
          throw new HttpsError('failed-precondition', 'The selected bench player is unavailable.');
        }

        if (isBenchSlotReserved(roster, benchSlotId)) {
          throw new HttpsError(
            'failed-precondition',
            'That bench player is reserved for another scheduled lineup move.',
          );
        }

        const benchAsset = roster.benchSlots[benchSlotIndex].asset!;
        if (getAssetKey(benchAsset) !== preflightBenchAssetKey) {
          throw new HttpsError(
            'aborted',
            'The selected bench slot changed while the move was being checked. Please try again.',
          );
        }

        if (benchAsset.position !== activeSlot.position) {
          throw new HttpsError(
            'failed-precondition',
            `That bench asset can only move into a ${benchAsset.position} slot.`,
          );
        }

        const earliest = preflightBenchEligibilityCycle ?? Number.MAX_SAFE_INTEGER;
        if (earliest > context.cycleNumber) {
          throw new HttpsError(
            'failed-precondition',
            `The bench player has already started Cycle ${context.cycleNumber} and cannot activate until Cycle ${earliest}.`,
          );
        }

        incomingAsset = resolvedIncomingAsset;
        if (!incomingAsset || getAssetKey(incomingAsset) !== preflightBenchAssetKey) {
          throw new HttpsError('aborted', 'The bench player projection could not be refreshed. Please try again.');
        }
        roster.activeSlots[activeSlotIndex] = {
          ...activeSlot,
          asset: createRosterAsset(
            incomingAsset,
            context.cycleNumber,
            'active',
          ),
          pendingMove: null,
          openFromCycleNumber: null,
        };
        roster.benchSlots[benchSlotIndex] = {
          ...roster.benchSlots[benchSlotIndex],
          asset: outgoingAsset
            ? { ...outgoingAsset, rosterStatus: 'benched' }
            : null,
        };
        benchSlotIdForTransaction = benchSlotId;
      } else {
        incomingAsset = resolvedIncomingAsset;
        if (!incomingAsset) {
          throw new HttpsError('aborted', 'The incoming projection could not be refreshed. Please try again.');
        }
        if (incomingAsset.position !== activeSlot.position) {
          throw new HttpsError(
            'failed-precondition',
            `This player must be placed in a ${incomingAsset.position} active slot.`,
          );
        }

        if (
          !isMixedPlayerInjuryMove(moveType) &&
          incomingEligibilityCycle > context.cycleNumber
        ) {
          throw new HttpsError(
            'failed-precondition',
            `The incoming player's current block has started. The earliest fair activation is Cycle ${incomingEligibilityCycle}.`,
          );
        }

        if (
          (moveType === 'add-drop-active' ||
            moveType === 'injury-add-drop-active') &&
          !outgoingAsset
        ) {
          throw new HttpsError('failed-precondition', 'The selected drop slot is already open.');
        }
        if (moveType === 'add-open-active') {
          if (activeSlot.asset) {
            throw new HttpsError('failed-precondition', 'The selected open slot is no longer open.');
          }
          if (activeSlot.openFromCycleNumber !== context.cycleNumber) {
            throw new HttpsError(
              'failed-precondition',
              'That open slot can no longer join the current cycle immediately.',
            );
          }
          droppedAsset = null;
        }

        const incomingKey = requireRosterMoveAssetKey(
          incomingAsset.assetKey,
          'incoming asset key',
        );
        if (moveType === 'injury-add-drop-active' && activeSlot.pendingMove) {
          const queuedMovePromotionFingerprint =
            getQueuedFreeAgentInjuryPromotionFingerprint({
              pendingMove: activeSlot.pendingMove,
              ownerId,
              activeSlotId,
              outgoingAssetKey: getAssetKey(outgoingAsset),
              incomingAssetKey: incomingKey,
            });
          const queuedMovePromotionIsExclusive = Boolean(
            queuedMovePromotionFingerprint &&
            isExclusiveQueuedFreeAgentReservation({
              roster,
              activeSlotId,
              pendingMoveId: activeSlot.pendingMove.id,
              incomingAssetKey: incomingKey,
            }),
          );

          if (
            !preflightSupersededQueuedMoveId ||
            activeSlot.pendingMove.id !== preflightSupersededQueuedMoveId ||
            queuedMovePromotionFingerprint !==
              preflightSupersededQueuedMoveFingerprint ||
            !queuedMovePromotionIsExclusive
          ) {
            throw new HttpsError(
              'aborted',
              'The queued free-agent transaction changed while the injury transaction was being checked. Please try again.',
            );
          }

          supersededQueuedMoveId = preflightSupersededQueuedMoveId;
        }
        if (moveType === 'injury-add-open-active') {
          supersededQueuedMoveId = preflightSupersededQueuedMoveId;
        }

        if (rosterContainsAsset(roster, incomingKey)) {
          const rosterWithoutPromotedReservation = supersededQueuedMoveId
            ? {
                ...roster,
                activeSlots: roster.activeSlots.map((slot) =>
                  slot.slotId === activeSlotId
                    ? { ...slot, pendingMove: null }
                    : slot,
                ),
              }
            : null;

          if (
            !rosterWithoutPromotedReservation ||
            rosterContainsAsset(rosterWithoutPromotedReservation, incomingKey)
          ) {
            throw new HttpsError(
              'already-exists',
              'That player or goalie unit is already owned or reserved on your roster.',
            );
          }
        }
        for (const snapshot of allRosterSnapshots as Array<{
          exists: boolean;
          data(): unknown;
        }>) {
          if (!snapshot.exists) {
            continue;
          }
          const otherRoster = normalizeFantasyRoster(snapshot.data() as Partial<FantasyRoster>);
          if (rosterContainsAsset(otherRoster, incomingKey)) {
            throw new HttpsError(
              'already-exists',
              'That player or goalie unit is already owned or reserved by another roster move.',
            );
          }
        }

        if (
          !incomingWaiverSnapshot ||
          incomingWaiverSnapshot.ref.path !==
            `leagues/${leagueId}/waivers/${incomingKey}`
        ) {
          throw new HttpsError(
            'failed-precondition',
            'The incoming waiver state could not be verified. No roster move was applied.',
          );
        }
        if (
          incomingWaiverSnapshot.exists &&
          incomingWaiverSnapshot.data()?.['status'] === 'active'
        ) {
          throw new HttpsError(
            'failed-precondition',
            'That player is still on waivers and must be claimed through the waiver process.',
          );
        }

        roster.activeSlots[activeSlotIndex] = {
          ...activeSlot,
          asset: createRosterAsset(incomingAsset, context.cycleNumber, 'active'),
          pendingMove: null,
          openFromCycleNumber: null,
        };
      }

      const cycleExpectedByOwner = asRecord(
        cycleSnapshot.data()?.['expectedRosterSlotIdsByOwner'],
      );
      const existingExpectedRosterSlotIds = [
        ...new Set([
          ...asArray(teamWindowsData['expectedRosterSlotIds']).map(asString).filter(Boolean),
          ...asArray(cycleExpectedByOwner[ownerId]).map(asString).filter(Boolean),
        ]),
      ];
      const expectedRosterSlotIds = removesActiveAssignment
        ? existingExpectedRosterSlotIds.filter((slotId) => slotId !== activeSlotId)
        : [...new Set([...existingExpectedRosterSlotIds, activeSlotId])];
      let nextRosterPickForBank: Record<string, unknown> | null = null;
      let resetWindowForBank: Record<string, unknown> | null = null;

      if (removesActiveAssignment) {
        if (windowIndex >= 0) {
          windows.splice(windowIndex, 1);
        }
        transaction.delete(rosterPickRef);
      } else if (incomingAsset) {
        const playerWindowContinuity = isMixedPlayerInjuryMove(moveType)
          ? preflightInjuryPlan?.segments.at(-1)?.playerWindowContinuity ?? null
          : createPlayerWindowContinuity({
              ownerId,
              rosterSlotId: activeSlotId,
              asset: incomingAsset,
              activationKey: `move-${transactionRef.id}`,
              assignmentNotBefore: Date.now(),
            });
        const previousWindow = windowIndex >= 0 ? windows[windowIndex] : {};
        let resetWindow: Record<string, unknown>;

        if (isMixedPlayerInjuryMove(moveType)) {
          if (!preflightInjuryPlan) {
            throw new HttpsError(
              'aborted',
              'The injury-replacement ownership plan is unavailable. Please try again.',
            );
          }

          const scheduledGameIds = getInjuryReplacementGameIds(preflightInjuryPlan);
          const scheduledGameIdSet = new Set(scheduledGameIds);
          const completedGameIds = asArray(previousWindow['completedGameIds'])
            .filter(
              (gameId): gameId is number =>
                typeof gameId === 'number' && scheduledGameIdSet.has(gameId),
            );
          const liveGameIds = asArray(previousWindow['liveGameIds'])
            .filter(
              (gameId): gameId is number =>
                typeof gameId === 'number' && scheduledGameIdSet.has(gameId),
            );
          const appearanceGameIds = asArray(previousWindow['appearanceGameIds'])
            .filter(
              (gameId): gameId is number =>
                typeof gameId === 'number' && scheduledGameIdSet.has(gameId),
            );
          const incompleteFinalGameIds = asArray(
            previousWindow['incompleteFinalGameIds'],
          ).filter(
            (gameId): gameId is number =>
              typeof gameId === 'number' && scheduledGameIdSet.has(gameId),
          );
          const gameScores = filterGameRecord(
            previousWindow['gameScores'],
            scheduledGameIdSet,
          );
          const fantasyPoints = Number(
            Object.values(gameScores).reduce<number>(
              (total, value) =>
                total +
                (typeof value === 'number' && Number.isFinite(value) ? value : 0),
              0,
            ).toFixed(1),
          );
          const nowIso = new Date(actionBoundaryMilliseconds).toISOString();

          resetWindow = {
            ...previousWindow,
            id:
              asString(previousWindow['id']) ||
              getWindowId(ownerId, activeSlotId, context.cycleNumber),
            ownerId,
            rosterSlotId: activeSlotId,
            cycleNumber: context.cycleNumber,
            position: incomingAsset.position,
            assetKey: incomingAsset.assetKey,
            asset: incomingAsset,
            status:
              completedGameIds.length > 0 ||
              liveGameIds.length > 0 ||
              incompleteFinalGameIds.length > 0
                ? 'active'
                : 'scheduled',
            scheduledGameIds,
            scheduledGameDates: scheduledGameIds.map(
              (gameId) => preflightInjuryGameDateById[String(gameId)] ?? '',
            ),
            scheduledGameLabels: scheduledGameIds.map(
              (gameId) => preflightInjuryGameLabelById[String(gameId)] ?? '',
            ),
            scheduleTeamAbbreviation:
              preflightInjuryPlan.segments.at(-1)?.sourceTeamAbbreviation ?? null,
            sourceTeamAbbreviationByGameId: Object.fromEntries(
              preflightInjuryPlan.segments.flatMap((segment) =>
                segment.scheduledGameIds.map((gameId) => [
                  String(gameId),
                  segment.sourceTeamAbbreviationByGameId?.[String(gameId)] ??
                    segment.sourceTeamAbbreviation,
                ]),
              ),
            ),
            teamIdentityChanged: false,
            injuryReplacementWindow: preflightInjuryPlan,
            scoringAssetKeyByGameId:
              getInjuryReplacementAssetKeyByGameId(preflightInjuryPlan),
            completedGameIds,
            liveGameIds,
            appearanceGameIds,
            incompleteFinalGameIds,
            gameInputCompleteness: filterGameRecord(
              previousWindow['gameInputCompleteness'],
              scheduledGameIdSet,
            ),
            gameScores,
            gameStates: filterGameRecord(
              previousWindow['gameStates'],
              scheduledGameIdSet,
            ),
            scheduledGames: scheduledGameIds.length,
            gamesPlayed: completedGameIds.length,
            actualGamesPlayed: appearanceGameIds.filter((gameId) =>
              completedGameIds.includes(gameId),
            ).length,
            gamesLeft: Math.max(0, scheduledGameIds.length - completedGameIds.length),
            fantasyPoints,
            frozenProjectionPoints:
              getInjuryReplacementProjectionPoints(preflightInjuryPlan),
            frozenProjectionVersion: incomingAsset.frozenProjectionVersion ?? null,
            frozenProjectionSource: incomingAsset.frozenProjectionSource ?? null,
            frozenProjectionSnapshotId:
              incomingAsset.frozenProjectionSnapshotId ??
              incomingAsset.sharedProjectionSnapshotId ??
              null,
            frozenProjectionGeneratedAt:
              incomingAsset.frozenProjectionGeneratedAt ??
              incomingAsset.projectionGeneratedAt ??
              null,
            frozenProjectionFrozenAt: nowIso,
            frozenProjectionTargetGameIds: scheduledGameIds,
            firstScheduledGameDate:
              preflightInjuryGameDateById[String(scheduledGameIds[0])] ?? null,
            lastScheduledGameDate:
              preflightInjuryGameDateById[
                String(scheduledGameIds.at(-1) ?? '')
              ] ?? null,
            startedAt:
              completedGameIds.length > 0 ||
              liveGameIds.length > 0 ||
              incompleteFinalGameIds.length > 0
                ? previousWindow['startedAt'] ?? nowIso
                : null,
            completedAt: null,
            createdAt: previousWindow['createdAt'] ?? nowIso,
            updatedAt: nowIso,
          };
        } else {
          resetWindow = buildResetWindow(
            previousWindow,
            incomingAsset,
            ownerId,
            activeSlotId,
            context.cycleNumber,
          );
        }
        resetWindow['playerWindowContinuity'] =
          playerWindowContinuity ?? null;
        resetWindowForBank = {
          ...resetWindow,
          updatedAt: new Date().toISOString(),
        };
        if (windowIndex >= 0) {
          windows[windowIndex] = resetWindow;
        } else {
          windows.push(resetWindow);
        }

        const existingPick = rosterPickSnapshot.exists ? rosterPickSnapshot.data() ?? {} : {};
        const {
          sourceNhlTargetGameIds: _outgoingSourceNhlTargetGameIds,
          ...existingPickWithoutDirectTargetIds
        } = existingPick;
        const cycleSourceNhlTargetGameIdsByTeam = asRecord(
          cycleSnapshot.data()?.['sourceNhlTargetGameIdsByTeam'],
        );
        const savedSourceNhlTargetGameIdsByTeam = asRecord(
          existingPick['sourceNhlTargetGameIdsByTeam'],
        );
        const sourceNhlTargetGameIdsByTeam =
          Object.keys(cycleSourceNhlTargetGameIdsByTeam).length > 0
            ? cycleSourceNhlTargetGameIdsByTeam
            : savedSourceNhlTargetGameIdsByTeam;
        const incomingTeamAbbreviation = getAssetTeamAbbreviation(incomingAsset)
          .trim()
          .toUpperCase();
        const incomingSourceNhlTargetGameIds = isMixedPlayerInjuryMove(moveType)
          ? preflightInjuryPlan?.segments.at(-1)?.scheduledGameIds ?? []
          : asArray(
              sourceNhlTargetGameIdsByTeam[incomingTeamAbbreviation],
            ).filter(
              (gameId): gameId is number =>
                typeof gameId === 'number' &&
                Number.isSafeInteger(gameId) &&
                gameId > 0,
            );
        const fallbackOrder = 100000 + activeSlotIndex + 1;
        const nextRosterPick = {
          ...existingPickWithoutDirectTargetIds,
          overallPick: asNumber(existingPick['overallPick'], fallbackOrder),
          round: asNumber(existingPick['round']),
          pickInRound: asNumber(existingPick['pickInRound'], activeSlot.slotNumber),
          ownerId,
          asset: incomingAsset,
          rosterArea: 'active',
          rosterSlotId: activeSlotId,
          cycleWindowId: getWindowId(ownerId, activeSlotId, context.cycleNumber),
          snapshotCycleNumber: context.cycleNumber,
          snapshotOrder: asNumber(existingPick['snapshotOrder'], fallbackOrder),
          snapshotSource: isMixedPlayerInjuryMove(moveType)
            ? 'injury-replacement'
            : 'immediate-untouched-roster-move',
          playerWindowContinuity: playerWindowContinuity ?? null,
          ...(isMixedPlayerInjuryMove(moveType) && preflightInjuryPlan
            ? { injuryReplacementWindow: preflightInjuryPlan }
            : {}),
          snapshottedAt: FieldValue.serverTimestamp(),
          ...(incomingSourceNhlTargetGameIds.length > 0
            ? { sourceNhlTargetGameIds: incomingSourceNhlTargetGameIds }
            : {}),
          sourceNhlTargetGameIdsByTeam,
        };
        transaction.set(rosterPickRef, nextRosterPick);
        nextRosterPickForBank = {
          ...nextRosterPick,
          snapshottedAt: new Date().toISOString(),
        };
      }

      if (playoffBankRef && playoffBankData) {
        const bankWindowNumber = Math.floor(
          asNumber(playoffBankData['windowNumber']),
        );
        const bankPicks = asArray(playoffBankData['picks']).map(asRecord);
        const bankSlotWindows = asArray(playoffBankData['slotWindows']).map(asRecord);
        const bankPickIndex = bankPicks.findIndex(
          (pick) => asString(pick['rosterSlotId']) === activeSlotId,
        );
        const bankWindowIndex = bankSlotWindows.findIndex(
          (window) => asString(window['rosterSlotId']) === activeSlotId,
        );

        if (removesActiveAssignment) {
          if (bankPickIndex >= 0) {
            bankPicks.splice(bankPickIndex, 1);
          }
          if (bankWindowIndex >= 0) {
            bankSlotWindows.splice(bankWindowIndex, 1);
          }
        } else if (nextRosterPickForBank && resetWindowForBank) {
          const bankPick = {
            ...nextRosterPickForBank,
            playoffWindowNumber: bankWindowNumber,
          };

          if (bankPickIndex >= 0) {
            bankPicks[bankPickIndex] = bankPick;
          } else {
            bankPicks.push(bankPick);
          }

          if (bankWindowIndex >= 0) {
            bankSlotWindows[bankWindowIndex] = resetWindowForBank;
          } else {
            bankSlotWindows.push(resetWindowForBank);
          }
        }

        const bankExpectedRosterSlotIds = removesActiveAssignment
          ? asArray(playoffBankData['expectedRosterSlotIds'])
              .map(asString)
              .filter((slotId) => slotId && slotId !== activeSlotId)
          : [
              ...new Set([
                ...asArray(playoffBankData['expectedRosterSlotIds'])
                  .map(asString)
                  .filter(Boolean),
                activeSlotId,
              ]),
            ];
        const bankExpectedWindows = bankSlotWindows.filter((window) =>
          bankExpectedRosterSlotIds.includes(
            asString(window['rosterSlotId']),
          ),
        );
        const bankCompletedWindowCount = bankExpectedWindows.filter(
          (window) => asString(window['status']) === 'complete',
        ).length;
        const bankHasStartedWindow = bankExpectedWindows.some(
          (window) =>
            asString(window['status']) !== 'scheduled' ||
            asNumber(window['gamesPlayed']) > 0 ||
            asArray(window['liveGameIds']).length > 0,
        );
        const bankTotalWindowCount = bankExpectedRosterSlotIds.length;
        const bankStatus =
          bankTotalWindowCount > 0 &&
          bankCompletedWindowCount === bankTotalWindowCount
            ? 'complete'
            : bankHasStartedWindow
              ? 'active'
              : 'scheduled';
        const bankTeamScore = Number(
          bankExpectedWindows
            .reduce(
              (total, window) => total + asNumber(window['fantasyPoints']),
              0,
            )
            .toFixed(1),
        );

        transaction.set(
          playoffBankRef,
          {
            picks: bankPicks,
            slotWindows: bankSlotWindows,
            expectedRosterSlotIds: bankExpectedRosterSlotIds,
            playerWindowContinuitySchemaVersion: 1,
            teamScore: bankTeamScore,
            completedWindowCount: bankCompletedWindowCount,
            totalWindowCount: bankTotalWindowCount,
            status: bankStatus,
            completedAt:
              bankStatus === 'complete'
                ? playoffBankData['completedAt'] ?? FieldValue.serverTimestamp()
                : null,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      transaction.set(rosterRef, {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        benchSlots: roster.benchSlots,
        irSlots: roster.irSlots,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      const expectedWindows = windows.filter((window) =>
        expectedRosterSlotIds.includes(asString(window['rosterSlotId'])),
      );
      const completedWindowCount = expectedWindows.filter(
        (window) => asString(window['status']) === 'complete',
      ).length;
      const hasStartedWindow = expectedWindows.some((window) =>
        asString(window['status']) !== 'scheduled' ||
        asNumber(window['gamesPlayed']) > 0 ||
        asArray(window['liveGameIds']).length > 0,
      );
      const totalExpectedWindowCount = expectedRosterSlotIds.length;
      const teamWindowStatus =
        totalExpectedWindowCount > 0 && completedWindowCount === totalExpectedWindowCount
          ? 'complete'
          : hasStartedWindow
            ? 'active'
            : 'scheduled';

      transaction.set(teamWindowsRef, {
        id: ownerId,
        ownerId,
        cycleNumber: context.cycleNumber,
        expectedRosterSlotIds,
        windows,
        completedWindowCount,
        totalWindowCount: totalExpectedWindowCount,
        status: teamWindowStatus,
        completedAt: teamWindowStatus === 'complete'
          ? (teamWindowsData['completedAt'] ?? FieldValue.serverTimestamp())
          : null,
        createdAt: teamWindowsData['createdAt'] ?? FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      const nextExpectedRosterSlotIdsByOwner = {
        ...cycleExpectedByOwner,
        [ownerId]: expectedRosterSlotIds,
      };
      const totalCycleExpectedWindowCount = Object.values(
        nextExpectedRosterSlotIdsByOwner,
      ).reduce<number>(
        (total, value) => total + asArray(value).map(asString).filter(Boolean).length,
        0,
      );

      transaction.set(cycleRef, {
        expectedRosterSlotIdsByOwner: nextExpectedRosterSlotIdsByOwner,
        totalExpectedWindowCount: totalCycleExpectedWindowCount,
        activeWindowCount: totalCycleExpectedWindowCount,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      let waiverId: string | null = null;
      if (
        (moveType === 'add-drop-active' ||
          moveType === 'injury-add-drop-active' ||
          moveType === 'activate-ir-active' ||
          moveType === 'drop-active') &&
        droppedAsset
      ) {
        waiverId = requireRosterMoveAssetKey(
          getAssetKey(droppedAsset),
          'dropped asset key',
        );
        transaction.set(
          db.doc(`leagues/${leagueId}/waivers/${waiverId}`),
          buildWaiverPayload(droppedAsset, ownerId, context.cycleNumber),
        );
      }

      const transactionType = moveType === 'active-bench-swap'
        ? 'active-bench-swap-activated'
        : moveType === 'injury-replacement'
          ? 'injury-replacement'
        : moveType === 'injury-active-bench-swap'
          ? 'injury-active-bench-swap'
        : moveType === 'injury-add-drop-active'
          ? 'injury-add-drop-active'
        : moveType === 'injury-add-open-active'
          ? 'add-open-slot'
        : moveType === 'activate-ir-active'
          ? 'activate-from-ir'
          : moveType === 'move-active-to-ir'
            ? 'move-to-ir'
            : moveType === 'drop-active'
              ? 'drop-to-waivers'
              : moveType === 'add-drop-active'
                ? 'add-drop'
                : 'add-open-slot';
      const result = {
        applied: true as const,
        cycleNumber: context.cycleNumber,
        activeSlotId,
        message: isMixedPlayerInjuryMove(moveType)
          ? `Injury transaction applied to the remaining games in Cycle ${context.cycleNumber}.`
          : `Applied immediately to untouched Cycle ${context.cycleNumber}.`,
      };
      transaction.set(transactionRef, {
        type: transactionType,
        ownerId,
        addedAsset:
          moveType === 'add-drop-active' ||
          moveType === 'add-open-active' ||
          moveType === 'injury-add-drop-active' ||
          moveType === 'injury-add-open-active'
            ? incomingAsset
            : null,
        movedAsset: moveType === 'active-bench-swap'
          ? roster.activeSlots[activeSlotIndex].asset
          : moveType === 'move-active-to-ir'
            ? outgoingAsset
            : isBenchSourcedInjuryMove(moveType)
              ? outgoingAsset
            : moveType === 'activate-ir-active'
              ? outgoingAsset
              : null,
        activatedAsset: moveType === 'activate-ir-active'
          ? roster.activeSlots[activeSlotIndex].asset
          : isMixedPlayerInjuryMove(moveType)
            ? roster.activeSlots[activeSlotIndex].asset
          : null,
        droppedAsset:
          moveType === 'move-active-to-ir' ||
          moveType === 'active-bench-swap' ||
          moveType === 'injury-active-bench-swap'
            ? null
            : droppedAsset,
        waiverId,
        activeSlotId,
        benchSlotId: benchSlotIdForTransaction,
        irSlotId: irSlotIdForTransaction,
        sourceRosterArea:
          moveType === 'drop-active' || moveType === 'injury-add-drop-active'
            ? 'active'
            : null,
        targetSlotId:
          moveType === 'add-open-active' ||
          moveType === 'injury-add-open-active'
            ? activeSlotId
            : null,
        dropSlotId:
          moveType === 'add-drop-active' ||
          moveType === 'injury-add-drop-active' ||
          moveType === 'drop-active'
            ? activeSlotId
            : null,
        rosterSlotId: activeSlotId,
        effectiveCycleNumber: context.cycleNumber,
        effectiveLabel: `Cycle ${context.cycleNumber}`,
        immediateUntouchedWindow: !isMixedPlayerInjuryMove(moveType),
        injuryReplacementWindow: isMixedPlayerInjuryMove(moveType)
          ? preflightInjuryPlan
          : null,
        availabilityStatus: isMixedPlayerInjuryMove(moveType)
          ? transactionMoveToIrAvailabilityStatus
          : null,
        outgoingDestination: moveType === 'injury-active-bench-swap'
          ? 'bench'
          : moveType === 'injury-add-drop-active'
            ? 'waivers'
          : moveType === 'injury-add-open-active'
            ? 'injured-reserve'
            : moveType === 'injury-replacement'
              ? 'injured-reserve'
              : null,
        ...(supersededQueuedMoveId
          ? { supersededQueuedMoveId }
          : {}),
        ...(automaticInjuryReplacement
          ? {
              actorType: 'availability-automation',
              automaticInjuryReplacementSource:
                automaticInjuryReplacement.source,
              automaticInjuryReplacementPendingMoveId:
                expectedAutomaticPendingMoveId,
            }
          : {}),
        ...(moveType === 'injury-add-open-active'
          ? {
              sourceQueueAddOpenTransactionId:
                expectedAutomaticQueueTransactionId,
              sourceMoveToIrTransactionId:
                expectedAutomaticMoveToIrTransactionId,
              preservedIrSlotId: expectedAutomaticIrSlotId,
            }
          : {}),
        ...(rosterMoveIdentity
          ? {
              nhlPlayerTeamIdentityHash: rosterMoveIdentity.identityHash,
              nhlPlayerTeamIdentityGeneratedAt:
                rosterMoveIdentity.generatedAt,
            }
          : {}),
        ...buildRosterActionSubmissionEvidence({
          submissionId: replaySubmissionId,
          requestFingerprint,
          result: { ...result },
        }),
        createdAt: FieldValue.serverTimestamp(),
      });

      return result;
    });
}

export async function applyAutomaticQueuedInjuryReplacement(
  input: AutomaticQueuedInjuryReplacementRequest,
) {
  return executeImmediateRosterMove({
    authenticatedOwnerId: input.ownerId,
    input: {
      leagueId: input.leagueId,
      moveType: input.moveType,
      activeSlotId: input.activeSlotId,
      benchSlotId: input.benchSlotId,
      addAssetKey:
        input.moveType === 'injury-add-drop-active' ||
        input.moveType === 'injury-add-open-active'
          ? input.incomingAssetKey
          : null,
    },
    automaticInjuryReplacement: {
      expectedPendingMoveId: input.expectedPendingMoveId,
      expectedPendingMoveFingerprint: input.expectedPendingMoveFingerprint,
      expectedQueueTransactionId: input.expectedQueueTransactionId ?? null,
      expectedMoveToIrTransactionId:
        input.expectedMoveToIrTransactionId ?? null,
      expectedIrSlotId: input.expectedIrSlotId ?? null,
      source: input.source,
    },
  });
}

export const applyImmediateRosterMove = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request) => executeImmediateRosterMove({
    authenticatedOwnerId: request.auth?.uid,
    input: request.data,
    callableRequest: request,
  }),
);
