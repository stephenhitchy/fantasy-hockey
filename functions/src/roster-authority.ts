import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import { TRUSTED_WEB_ORIGINS } from './web-security';
import { DraftableAsset } from './shared/core/draft/draft.models';
import {
  FantasyRoster,
  PendingRosterSlotMove,
  RosterAsset,
  RosterStatus,
} from './shared/core/team/roster.models';
import {
  createEmptyFantasyRoster,
  normalizeFantasyRoster,
} from './shared/core/team/roster.service';
import {
  getAuthoritativeAvailabilityStatus,
  getEarliestEligibleCycleNumber,
  loadCanonicalDraftableAsset,
} from './roster-moves';

const FUNCTION_REGION = 'us-central1';
const DEFAULT_GAMES_PER_CYCLE = 6;
const IR_ELIGIBLE_STATUSES = new Set([
  'out',
  'injured-reserve',
  'long-term-injured-reserve',
]);

type SecureRosterAction =
  | 'add-drop'
  | 'add-open-slot'
  | 'cancel-queued-move'
  | 'move-active-to-ir'
  | 'activate-ir-active'
  | 'drop-to-waivers'
  | 'queue-active-bench-swap'
  | 'move-bench-to-ir'
  | 'activate-ir-to-bench'
  | 'place-waiver-claim'
  | 'process-waiver';

type RosterActionMode = 'immediate' | 'queued' | 'ownership-only';

interface SecureRosterActionRequest {
  leagueId?: unknown;
  action?: unknown;
  assetKey?: unknown;
  activeSlotId?: unknown;
  benchSlotId?: unknown;
  irSlotId?: unknown;
  rosterSlotId?: unknown;
  sourceRosterArea?: unknown;
  slotId?: unknown;
  waiverId?: unknown;
  waiverMoveType?: unknown;
  waiverRosterArea?: unknown;
  dropSlotId?: unknown;
  targetSlotId?: unknown;
  effectiveCycleNumber?: unknown;
  effectiveLabel?: unknown;
}

interface SecureRosterActionResult {
  applied: true;
  mode: RosterActionMode;
  effectiveCycleNumber: number | null;
  message: string;
}

interface FantasyWaiverClaim {
  ownerId: string;
  moveType: 'drop' | 'open-slot';
  rosterArea: 'active' | 'bench';
  dropSlotId: string | null;
  targetSlotId: string | null;
  waiverPriorityAtClaim: number;
  effectiveCycleNumber: number | null;
  effectiveLabel: string | null;
  claimedAt: string;
}

interface FantasyWaiver {
  id: string;
  assetKey: string;
  asset: DraftableAsset;
  droppedAsset?: RosterAsset | null;
  droppedByOwnerId: string;
  status: 'active' | 'claimed' | 'cleared';
  claims: FantasyWaiverClaim[];
  awardedToOwnerId?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asPositiveIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
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

function rosterContainsAsset(roster: FantasyRoster, assetKey: string): boolean {
  const assets = [
    ...roster.activeSlots.flatMap((slot) => [slot.asset, slot.pendingMove?.incomingAsset ?? null]),
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

function rosterAssetToDraftableAsset(asset: RosterAsset): DraftableAsset {
  const copy = { ...asset } as Record<string, unknown>;
  delete copy['cycleScore'];
  delete copy['rosterStatus'];

  return {
    ...copy,
    assetKey: getAssetKey(asset),
  } as DraftableAsset;
}

function createRosterAsset(
  asset: DraftableAsset,
  rosterStatus: RosterStatus,
  eligibleFromCycleNumber: number | null,
): RosterAsset {
  return {
    ...asset,
    assetKey: asset.assetKey,
    rosterStatus,
    eligibleFromCycleNumber,
    cycleScore: {
      cycleNumber: eligibleFromCycleNumber ?? 1,
      gamesCounted: 0,
      fantasyPoints: 0,
    },
  } as RosterAsset;
}

function createPendingRosterMove(
  moveType: PendingRosterSlotMove['moveType'],
  ownerId: string,
  slotId: string,
  currentAsset: RosterAsset | null,
  incomingAsset: DraftableAsset,
  sourceWaiverId: string | null,
  requestedEffectiveCycleNumber: number | null,
  requestedEffectiveLabel: string | null,
  sourceBenchSlotId: string | null = null,
  outgoingDestination: 'waivers' | 'bench' = 'waivers',
): PendingRosterSlotMove {
  return {
    id: `${ownerId}__${slotId}__${Date.now()}`,
    moveType,
    incomingAsset: createRosterAsset(
      incomingAsset,
      sourceBenchSlotId ? 'benched' : 'new',
      requestedEffectiveCycleNumber,
    ),
    outgoingAssetKey: getAssetKey(currentAsset) || null,
    sourceWaiverId,
    queuedByOwnerId: ownerId,
    queuedAt: new Date().toISOString(),
    requestedEffectiveCycleNumber,
    requestedEffectiveLabel,
    sourceBenchSlotId,
    outgoingDestination,
  };
}

function buildWaiverPayload(
  droppedAsset: RosterAsset,
  ownerId: string,
  effectiveCycleNumber: number | null,
  effectiveLabel: string | null,
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
    effectiveCycleNumber,
    effectiveLabel,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    processedAt: null,
  };
}

function rosterWrite(roster: FantasyRoster): Record<string, unknown> {
  return {
    schemaVersion: 2,
    activeSlots: roster.activeSlots,
    benchSlots: roster.benchSlots,
    irSlots: roster.irSlots,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function actionResult(
  mode: RosterActionMode,
  effectiveCycleNumber: number | null,
  message: string,
): SecureRosterActionResult {
  return { applied: true, mode, effectiveCycleNumber, message };
}

async function requireOwnerContext(leagueId: string, ownerId: string): Promise<{
  league: Record<string, unknown>;
  gamesPerCycle: number;
}> {
  const [leagueSnapshot, memberSnapshot, teamSnapshot, draftSnapshot] = await Promise.all([
    db.doc(`leagues/${leagueId}`).get(),
    db.doc(`leagues/${leagueId}/members/${ownerId}`).get(),
    db.doc(`leagues/${leagueId}/teams/${ownerId}`).get(),
    db.doc(`leagues/${leagueId}/draft/current`).get(),
  ]);

  if (!leagueSnapshot.exists || (!memberSnapshot.exists && !teamSnapshot.exists)) {
    throw new HttpsError('permission-denied', 'You are not a member of this league.');
  }
  if (!teamSnapshot.exists) {
    throw new HttpsError('failed-precondition', 'Your fantasy team was not found.');
  }
  if (!draftSnapshot.exists || draftSnapshot.data()?.['status'] !== 'complete') {
    throw new HttpsError('failed-precondition', 'Roster moves open after the draft is complete.');
  }

  const league = leagueSnapshot.data() ?? {};
  const scoringRules = asRecord(league['scoringRules']);
  const configuredGames = scoringRules['requiredGamesPerCycle'];
  const gamesPerCycle = typeof configuredGames === 'number' && Number.isFinite(configuredGames)
    ? Math.max(1, Math.floor(configuredGames))
    : DEFAULT_GAMES_PER_CYCLE;

  return { league, gamesPerCycle };
}

async function hasStartedFantasyCycle(leagueId: string): Promise<boolean> {
  const snapshot = await db.collection(`leagues/${leagueId}/cycles`).limit(1).get();
  return !snapshot.empty;
}

async function getAllRosterRefs(leagueId: string): Promise<Array<ReturnType<typeof db.doc>>> {
  const teamsSnapshot = await db.collection(`leagues/${leagueId}/teams`).get();
  return teamsSnapshot.docs.map((team: any) =>
    db.doc(`leagues/${leagueId}/teams/${team.id}/roster/current`),
  );
}

async function getFairEffectiveCycleNumber(
  leagueId: string,
  asset: DraftableAsset | RosterAsset,
  gamesPerCycle: number,
  requestedCycle: number | null,
): Promise<number> {
  const earliest = Math.max(
    asset.eligibleFromCycleNumber ?? 1,
    await getEarliestEligibleCycleNumber(asset, gamesPerCycle),
  );
  return Math.max(requestedCycle ?? earliest, earliest);
}

async function assertAssetIsFreeAgent(
  leagueId: string,
  assetKey: string,
): Promise<void> {
  const waiverSnapshot = await db.doc(`leagues/${leagueId}/waivers/${assetKey}`).get();
  if (waiverSnapshot.exists && waiverSnapshot.data()?.['status'] === 'active') {
    throw new HttpsError(
      'failed-precondition',
      'That player is on waivers and must be claimed through the waiver process.',
    );
  }
}

async function executeAddAction(options: {
  leagueId: string;
  ownerId: string;
  action: 'add-drop' | 'add-open-slot';
  assetKey: string;
  slotId: string;
  requestedCycle: number | null;
  requestedLabel: string | null;
  gamesPerCycle: number;
}): Promise<SecureRosterActionResult> {
  const {
    leagueId,
    ownerId,
    action,
    assetKey,
    slotId,
    requestedCycle,
    requestedLabel,
    gamesPerCycle,
  } = options;
  const asset = await loadCanonicalDraftableAsset(leagueId, assetKey);
  await assertAssetIsFreeAgent(leagueId, assetKey);
  const effectiveCycleNumber = await getFairEffectiveCycleNumber(
    leagueId,
    asset,
    gamesPerCycle,
    requestedCycle,
  );
  const effectiveLabel = requestedLabel || `Cycle ${effectiveCycleNumber}`;
  const queueAtSlotBoundary = await hasStartedFantasyCycle(leagueId);
  const rosterRefs = await getAllRosterRefs(leagueId);
  const rosterRef = db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`);
  const incomingWaiverRef = db.doc(`leagues/${leagueId}/waivers/${assetKey}`);

  return db.runTransaction(async (transaction: any) => {
    const [rosterSnapshots, incomingWaiverSnapshot] = await Promise.all([
      Promise.all(rosterRefs.map((reference) => transaction.get(reference))),
      transaction.get(incomingWaiverRef),
    ]);
    if (incomingWaiverSnapshot.exists && incomingWaiverSnapshot.data()?.['status'] === 'active') {
      throw new HttpsError(
        'failed-precondition',
        'That player moved onto waivers. Refresh and submit a waiver claim instead.',
      );
    }
    const ownerSnapshot = rosterSnapshots.find((snapshot) => snapshot.ref.path === rosterRef.path);
    if (!ownerSnapshot?.exists) {
      throw new HttpsError('failed-precondition', 'Your roster was not found.');
    }

    const roster = normalizeFantasyRoster(ownerSnapshot.data() as Partial<FantasyRoster>);
    if (rosterContainsAsset(roster, assetKey)) {
      throw new HttpsError('already-exists', 'That asset is already on your roster or reserved.');
    }
    for (const snapshot of rosterSnapshots) {
      if (!snapshot.exists || snapshot.ref.path === rosterRef.path) {
        continue;
      }
      if (rosterContainsAsset(
        normalizeFantasyRoster(snapshot.data() as Partial<FantasyRoster>),
        assetKey,
      )) {
        throw new HttpsError('already-exists', 'That asset is already owned or reserved.');
      }
    }

    const benchIndex = roster.benchSlots.findIndex((slot) => slot.slotId === slotId);
    if (benchIndex >= 0) {
      const benchSlot = roster.benchSlots[benchIndex];
      if (action === 'add-open-slot' && benchSlot.asset) {
        throw new HttpsError('failed-precondition', 'That bench slot is already filled.');
      }
      if (action === 'add-drop' && !benchSlot.asset) {
        throw new HttpsError('failed-precondition', 'That bench slot is already open.');
      }

      const droppedAsset = benchSlot.asset;
      if (droppedAsset && isBenchSlotReserved(roster, benchSlot.slotId)) {
        throw new HttpsError(
          'failed-precondition',
          'That bench player is reserved for a queued swap. Cancel the swap first.',
        );
      }
      roster.benchSlots[benchIndex] = {
        ...benchSlot,
        asset: createRosterAsset(asset, 'benched', effectiveCycleNumber),
      };
      transaction.set(rosterRef, rosterWrite(roster), { merge: true });

      if (droppedAsset) {
        transaction.set(
          db.doc(`leagues/${leagueId}/waivers/${getAssetKey(droppedAsset)}`),
          buildWaiverPayload(droppedAsset, ownerId, effectiveCycleNumber, effectiveLabel),
        );
      }
      transaction.set(db.collection(`leagues/${leagueId}/transactions`).doc(), {
        type: action === 'add-drop' ? 'add-drop' : 'add-open-slot',
        ownerId,
        addedAsset: asset,
        droppedAsset: droppedAsset ?? null,
        waiverId: droppedAsset ? getAssetKey(droppedAsset) : null,
        sourceRosterArea: 'bench',
        benchSlotId: slotId,
        dropSlotId: action === 'add-drop' ? slotId : null,
        targetSlotId: action === 'add-open-slot' ? slotId : null,
        rosterSlotId: slotId,
        effectiveCycleNumber,
        effectiveLabel,
        authority: 'cloud-function',
        createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult('ownership-only', effectiveCycleNumber, 'Bench roster move applied.');
    }

    const activeIndex = roster.activeSlots.findIndex((slot) => slot.slotId === slotId);
    if (activeIndex < 0) {
      throw new HttpsError('not-found', 'The selected roster slot was not found.');
    }
    const activeSlot = roster.activeSlots[activeIndex];
    if (activeSlot.pendingMove) {
      throw new HttpsError('failed-precondition', 'That slot already has a queued move.');
    }
    if (activeSlot.position !== asset.position) {
      throw new HttpsError(
        'failed-precondition',
        `This asset must be placed in a ${asset.position} active slot.`,
      );
    }
    if (action === 'add-open-slot' && activeSlot.asset) {
      throw new HttpsError('failed-precondition', 'That active slot is already filled.');
    }
    if (action === 'add-drop' && !activeSlot.asset) {
      throw new HttpsError('failed-precondition', 'That active slot is already open.');
    }

    const droppedAsset = activeSlot.asset;
    if (queueAtSlotBoundary) {
      const pendingMove = createPendingRosterMove(
        action === 'add-drop' ? 'add-drop' : 'add-open-slot',
        ownerId,
        activeSlot.slotId,
        activeSlot.asset,
        asset,
        null,
        effectiveCycleNumber,
        effectiveLabel,
      );
      roster.activeSlots[activeIndex] = { ...activeSlot, pendingMove };
      transaction.set(rosterRef, rosterWrite(roster), { merge: true });
      transaction.set(db.collection(`leagues/${leagueId}/transactions`).doc(), {
        type: action === 'add-drop' ? 'queue-add-drop' : 'queue-add-open-slot',
        ownerId,
        addedAsset: asset,
        droppedAsset: droppedAsset ?? null,
        dropSlotId: action === 'add-drop' ? slotId : null,
        targetSlotId: action === 'add-open-slot' ? slotId : null,
        rosterSlotId: slotId,
        queuedMoveId: pendingMove.id,
        effectiveCycleNumber,
        effectiveLabel,
        authority: 'cloud-function',
        createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult('queued', effectiveCycleNumber, 'Roster move queued for the slot boundary.');
    }

    roster.activeSlots[activeIndex] = {
      ...activeSlot,
      asset: createRosterAsset(asset, 'new', effectiveCycleNumber),
      pendingMove: null,
      openFromCycleNumber: null,
    };
    transaction.set(rosterRef, rosterWrite(roster), { merge: true });
    if (droppedAsset) {
      transaction.set(
        db.doc(`leagues/${leagueId}/waivers/${getAssetKey(droppedAsset)}`),
        buildWaiverPayload(droppedAsset, ownerId, effectiveCycleNumber, effectiveLabel),
      );
    }
    transaction.set(db.collection(`leagues/${leagueId}/transactions`).doc(), {
      type: action === 'add-drop' ? 'add-drop' : 'add-open-slot',
      ownerId,
      addedAsset: asset,
      droppedAsset: droppedAsset ?? null,
      waiverId: droppedAsset ? getAssetKey(droppedAsset) : null,
      dropSlotId: action === 'add-drop' ? slotId : null,
      targetSlotId: action === 'add-open-slot' ? slotId : null,
      rosterSlotId: slotId,
      effectiveCycleNumber,
      effectiveLabel,
      authority: 'cloud-function',
      createdAt: FieldValue.serverTimestamp(),
    });
    return actionResult('immediate', effectiveCycleNumber, 'Roster move applied.');
  });
}

async function executeSimpleOwnerAction(options: {
  leagueId: string;
  ownerId: string;
  action: Exclude<SecureRosterAction, 'add-drop' | 'add-open-slot' | 'place-waiver-claim' | 'process-waiver'>;
  input: SecureRosterActionRequest;
  gamesPerCycle: number;
}): Promise<SecureRosterActionResult> {
  const { leagueId, ownerId, action, input, gamesPerCycle } = options;
  const requestedCycle = asPositiveIntegerOrNull(input.effectiveCycleNumber);
  const requestedLabel = asString(input.effectiveLabel) || null;
  const rosterRef = db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`);

  let preflightFairCycle = requestedCycle;
  let preflightAssetKey = '';
  let preflightAvailabilityStatus = '';
  const requiresRosterPreflight = [
    'queue-active-bench-swap',
    'activate-ir-active',
    'move-active-to-ir',
    'move-bench-to-ir',
  ].includes(action);
  const preflightRoster = requiresRosterPreflight
    ? await rosterRef.get().then((snapshot) => snapshot.exists
      ? normalizeFantasyRoster(snapshot.data() as Partial<FantasyRoster>)
      : createEmptyFantasyRoster())
    : null;

  if (action === 'queue-active-bench-swap') {
    const benchAsset = preflightRoster?.benchSlots.find(
      (slot) => slot.slotId === asString(input.benchSlotId),
    )?.asset;
    if (!benchAsset) {
      throw new HttpsError('failed-precondition', 'The selected bench player was not found.');
    }
    preflightAssetKey = getAssetKey(benchAsset);
    preflightFairCycle = await getFairEffectiveCycleNumber(
      leagueId,
      benchAsset,
      gamesPerCycle,
      requestedCycle,
    );
  }
  if (action === 'activate-ir-active') {
    const irAsset = preflightRoster?.irSlots.find(
      (slot) => slot.slotId === asString(input.irSlotId),
    )?.asset;
    if (!irAsset) {
      throw new HttpsError('failed-precondition', 'The selected IR player was not found.');
    }
    preflightAssetKey = getAssetKey(irAsset);
    preflightFairCycle = await getFairEffectiveCycleNumber(
      leagueId,
      irAsset,
      gamesPerCycle,
      requestedCycle,
    );
  }
  if (action === 'move-active-to-ir') {
    const activeAsset = preflightRoster?.activeSlots.find(
      (slot) => slot.slotId === asString(input.activeSlotId),
    )?.asset;
    if (!activeAsset || activeAsset.assetType !== 'skater') {
      throw new HttpsError('failed-precondition', 'Only an active skater can move to IR.');
    }
    preflightAssetKey = getAssetKey(activeAsset);
    preflightAvailabilityStatus = await getAuthoritativeAvailabilityStatus(leagueId, activeAsset);
    if (!IR_ELIGIBLE_STATUSES.has(preflightAvailabilityStatus)) {
      throw new HttpsError('failed-precondition', 'That player is not currently IR eligible.');
    }
  }
  if (action === 'move-bench-to-ir') {
    const benchAsset = preflightRoster?.benchSlots.find(
      (slot) => slot.slotId === asString(input.benchSlotId),
    )?.asset;
    if (!benchAsset || benchAsset.assetType !== 'skater') {
      throw new HttpsError('failed-precondition', 'Only a bench skater can move to IR.');
    }
    preflightAssetKey = getAssetKey(benchAsset);
    preflightAvailabilityStatus = await getAuthoritativeAvailabilityStatus(leagueId, benchAsset);
    if (!IR_ELIGIBLE_STATUSES.has(preflightAvailabilityStatus)) {
      throw new HttpsError('failed-precondition', 'That player is not currently IR eligible.');
    }
  }

  return db.runTransaction(async (transaction: any) => {
    const snapshot = await transaction.get(rosterRef);
    if (!snapshot.exists) {
      throw new HttpsError('failed-precondition', 'Your roster was not found.');
    }
    const roster = normalizeFantasyRoster(snapshot.data() as Partial<FantasyRoster>);
    const transactionRef = db.collection(`leagues/${leagueId}/transactions`).doc();

    if (action === 'cancel-queued-move') {
      const slotId = asString(input.rosterSlotId);
      const index = roster.activeSlots.findIndex((slot) => slot.slotId === slotId);
      const slot = index >= 0 ? roster.activeSlots[index] : null;
      if (!slot?.pendingMove) {
        throw new HttpsError('failed-precondition', 'That slot no longer has a queued move.');
      }
      if (slot.pendingMove.sourceWaiverId) {
        throw new HttpsError('failed-precondition', 'An awarded waiver move cannot be canceled.');
      }
      const pendingMove = slot.pendingMove;
      roster.activeSlots[index] = { ...slot, pendingMove: null };
      transaction.set(rosterRef, rosterWrite(roster), { merge: true });
      transaction.set(transactionRef, {
        type: 'cancel-queued-move', ownerId,
        addedAsset: rosterAssetToDraftableAsset(pendingMove.incomingAsset),
        droppedAsset: slot.asset,
        rosterSlotId: slotId,
        queuedMoveId: pendingMove.id,
        effectiveLabel: 'Canceled before activation',
        authority: 'cloud-function',
        createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult('ownership-only', null, 'Queued move canceled.');
    }

    if (action === 'move-active-to-ir') {
      const activeSlotId = asString(input.activeSlotId);
      const activeIndex = roster.activeSlots.findIndex((slot) => slot.slotId === activeSlotId);
      const activeSlot = activeIndex >= 0 ? roster.activeSlots[activeIndex] : null;
      if (!activeSlot?.asset || activeSlot.pendingMove) {
        throw new HttpsError('failed-precondition', 'The active player is unavailable or reserved.');
      }
      if (
        activeSlot.asset.assetType !== 'skater' ||
        getAssetKey(activeSlot.asset) !== preflightAssetKey ||
        !IR_ELIGIBLE_STATUSES.has(preflightAvailabilityStatus)
      ) {
        throw new HttpsError(
          'failed-precondition',
          'The player or injury status changed. Refresh and try again.',
        );
      }
      const status = preflightAvailabilityStatus;
      const irIndex = roster.irSlots.findIndex((slot) => slot.asset === null);
      if (irIndex < 0) {
        throw new HttpsError('failed-precondition', 'All IR slots are already filled.');
      }
      const asset = activeSlot.asset;
      roster.activeSlots[activeIndex] = { ...activeSlot, asset: null, openFromCycleNumber: null };
      roster.irSlots[irIndex] = {
        ...roster.irSlots[irIndex],
        asset: { ...asset, rosterStatus: 'injured' },
      };
      transaction.set(rosterRef, rosterWrite(roster), { merge: true });
      transaction.set(transactionRef, {
        type: 'move-to-ir', ownerId, movedAsset: asset,
        activeSlotId, irSlotId: roster.irSlots[irIndex].slotId,
        availabilityStatus: status,
        effectiveCycleNumber: requestedCycle,
        effectiveLabel: requestedLabel,
        authority: 'cloud-function',
        createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult('ownership-only', requestedCycle, 'Player moved to IR.');
    }

    if (action === 'activate-ir-active') {
      const irSlotId = asString(input.irSlotId);
      const irIndex = roster.irSlots.findIndex((slot) => slot.slotId === irSlotId);
      const irAsset = irIndex >= 0 ? roster.irSlots[irIndex].asset : null;
      if (!irAsset || getAssetKey(irAsset) !== preflightAssetKey) {
        throw new HttpsError(
          'failed-precondition',
          'The selected IR player changed. Refresh and try again.',
        );
      }
      const requestedActiveSlotId = asString(input.activeSlotId);
      const activeIndex = roster.activeSlots.findIndex((slot) =>
        requestedActiveSlotId
          ? slot.slotId === requestedActiveSlotId
          : slot.position === irAsset.position && slot.asset === null,
      );
      if (activeIndex < 0) {
        throw new HttpsError('failed-precondition', `Choose a ${irAsset.position} active slot.`);
      }
      const activeSlot = roster.activeSlots[activeIndex];
      if (activeSlot.pendingMove || activeSlot.position !== irAsset.position) {
        throw new HttpsError('failed-precondition', 'The selected active slot is unavailable.');
      }
      const droppedAsset = activeSlot.asset;
      const fairCycle = preflightFairCycle ?? 1;
      const label = requestedLabel || `Cycle ${fairCycle}`;
      roster.activeSlots[activeIndex] = {
        ...activeSlot,
        asset: { ...irAsset, rosterStatus: 'moved', eligibleFromCycleNumber: fairCycle },
        openFromCycleNumber: null,
      };
      roster.irSlots[irIndex] = { ...roster.irSlots[irIndex], asset: null };
      transaction.set(rosterRef, rosterWrite(roster), { merge: true });
      if (droppedAsset) {
        transaction.set(
          db.doc(`leagues/${leagueId}/waivers/${getAssetKey(droppedAsset)}`),
          buildWaiverPayload(droppedAsset, ownerId, fairCycle, label),
        );
      }
      transaction.set(transactionRef, {
        type: 'activate-from-ir', ownerId, activatedAsset: irAsset,
        droppedAsset: droppedAsset ?? null,
        waiverId: droppedAsset ? getAssetKey(droppedAsset) : null,
        activeSlotId: activeSlot.slotId, irSlotId,
        effectiveCycleNumber: fairCycle, effectiveLabel: label,
        authority: 'cloud-function', createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult('ownership-only', fairCycle, 'IR player activated.');
    }

    if (action === 'drop-to-waivers') {
      const area = asString(input.sourceRosterArea);
      const slotId = asString(input.slotId);
      let droppedAsset: RosterAsset | null = null;
      if (area === 'active') {
        const index = roster.activeSlots.findIndex((slot) => slot.slotId === slotId);
        const slot = index >= 0 ? roster.activeSlots[index] : null;
        if (!slot?.asset || slot.pendingMove) {
          throw new HttpsError('failed-precondition', 'The active slot is empty or reserved.');
        }
        droppedAsset = slot.asset;
        roster.activeSlots[index] = { ...slot, asset: null, openFromCycleNumber: null };
      } else if (area === 'bench') {
        const index = roster.benchSlots.findIndex((slot) => slot.slotId === slotId);
        const slot = index >= 0 ? roster.benchSlots[index] : null;
        if (!slot?.asset) {
          throw new HttpsError('failed-precondition', 'The bench slot is empty.');
        }
        const assetKey = getAssetKey(slot.asset);
        if (roster.activeSlots.some((candidate) =>
          candidate.pendingMove?.sourceBenchSlotId === slotId &&
          getAssetKey(candidate.pendingMove.incomingAsset) === assetKey,
        )) {
          throw new HttpsError('failed-precondition', 'That bench player is reserved for a queued swap.');
        }
        droppedAsset = slot.asset;
        roster.benchSlots[index] = { ...slot, asset: null };
      } else if (area === 'ir') {
        const index = roster.irSlots.findIndex((slot) => slot.slotId === slotId);
        const slot = index >= 0 ? roster.irSlots[index] : null;
        if (!slot?.asset) {
          throw new HttpsError('failed-precondition', 'The IR slot is empty.');
        }
        droppedAsset = slot.asset;
        roster.irSlots[index] = { ...slot, asset: null };
      } else {
        throw new HttpsError('invalid-argument', 'Choose active, bench, or IR.');
      }
      const waiverId = getAssetKey(droppedAsset);
      transaction.set(rosterRef, rosterWrite(roster), { merge: true });
      transaction.set(
        db.doc(`leagues/${leagueId}/waivers/${waiverId}`),
        buildWaiverPayload(droppedAsset, ownerId, requestedCycle, requestedLabel),
      );
      transaction.set(transactionRef, {
        type: 'drop-to-waivers', ownerId, droppedAsset, waiverId,
        sourceRosterArea: area, dropSlotId: slotId,
        effectiveCycleNumber: requestedCycle, effectiveLabel: requestedLabel,
        authority: 'cloud-function', createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult(area === 'active' ? 'ownership-only' : 'immediate', requestedCycle, 'Asset dropped to waivers.');
    }

    if (action === 'queue-active-bench-swap') {
      const activeSlotId = asString(input.activeSlotId);
      const benchSlotId = asString(input.benchSlotId);
      const activeIndex = roster.activeSlots.findIndex((slot) => slot.slotId === activeSlotId);
      const benchIndex = roster.benchSlots.findIndex((slot) => slot.slotId === benchSlotId);
      const activeSlot = activeIndex >= 0 ? roster.activeSlots[activeIndex] : null;
      const benchAsset = benchIndex >= 0 ? roster.benchSlots[benchIndex].asset : null;
      if (
        !activeSlot ||
        !benchAsset ||
        activeSlot.pendingMove ||
        getAssetKey(benchAsset) !== preflightAssetKey
      ) {
        throw new HttpsError(
          'failed-precondition',
          'The active or bench slot changed. Refresh and try again.',
        );
      }
      if (activeSlot.position !== benchAsset.position) {
        throw new HttpsError('failed-precondition', `That bench asset requires a ${benchAsset.position} slot.`);
      }
      const fairCycle = preflightFairCycle ?? 1;
      const label = requestedLabel || `Cycle ${fairCycle}`;
      const pendingMove = createPendingRosterMove(
        'add-drop', ownerId, activeSlot.slotId, activeSlot.asset,
        rosterAssetToDraftableAsset(benchAsset), null, fairCycle, label,
        benchSlotId, 'bench',
      );
      roster.activeSlots[activeIndex] = { ...activeSlot, pendingMove };
      transaction.set(rosterRef, rosterWrite(roster), { merge: true });
      transaction.set(transactionRef, {
        type: 'queue-active-bench-swap', ownerId,
        movedAsset: benchAsset, droppedAsset: activeSlot.asset,
        activeSlotId, benchSlotId, rosterSlotId: activeSlotId,
        queuedMoveId: pendingMove.id, effectiveCycleNumber: fairCycle,
        effectiveLabel: label, authority: 'cloud-function',
        createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult('queued', fairCycle, 'Bench swap queued.');
    }

    if (action === 'move-bench-to-ir') {
      const benchSlotId = asString(input.benchSlotId);
      const benchIndex = roster.benchSlots.findIndex((slot) => slot.slotId === benchSlotId);
      const asset = benchIndex >= 0 ? roster.benchSlots[benchIndex].asset : null;
      if (
        !asset ||
        asset.assetType !== 'skater' ||
        getAssetKey(asset) !== preflightAssetKey ||
        !IR_ELIGIBLE_STATUSES.has(preflightAvailabilityStatus)
      ) {
        throw new HttpsError(
          'failed-precondition',
          'The player or injury status changed. Refresh and try again.',
        );
      }
      const status = preflightAvailabilityStatus;
      const assetKey = getAssetKey(asset);
      if (roster.activeSlots.some((slot) =>
        slot.pendingMove?.sourceBenchSlotId === benchSlotId &&
        getAssetKey(slot.pendingMove.incomingAsset) === assetKey,
      )) {
        throw new HttpsError('failed-precondition', 'Cancel the queued swap before moving this player to IR.');
      }
      const irIndex = roster.irSlots.findIndex((slot) => slot.asset === null);
      if (irIndex < 0) {
        throw new HttpsError('failed-precondition', 'All IR slots are filled.');
      }
      roster.benchSlots[benchIndex] = { ...roster.benchSlots[benchIndex], asset: null };
      roster.irSlots[irIndex] = {
        ...roster.irSlots[irIndex],
        asset: { ...asset, rosterStatus: 'injured' },
      };
      transaction.set(rosterRef, rosterWrite(roster), { merge: true });
      transaction.set(transactionRef, {
        type: 'move-bench-to-ir', ownerId, movedAsset: asset,
        benchSlotId, irSlotId: roster.irSlots[irIndex].slotId,
        availabilityStatus: status, effectiveCycleNumber: requestedCycle,
        effectiveLabel: requestedLabel, authority: 'cloud-function',
        createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult('ownership-only', requestedCycle, 'Bench player moved to IR.');
    }

    if (action === 'activate-ir-to-bench') {
      const irSlotId = asString(input.irSlotId);
      const irIndex = roster.irSlots.findIndex((slot) => slot.slotId === irSlotId);
      const irAsset = irIndex >= 0 ? roster.irSlots[irIndex].asset : null;
      if (!irAsset) {
        throw new HttpsError('failed-precondition', 'The selected IR player was not found.');
      }
      const requestedBenchSlotId = asString(input.benchSlotId);
      const benchIndex = requestedBenchSlotId
        ? roster.benchSlots.findIndex((slot) => slot.slotId === requestedBenchSlotId)
        : roster.benchSlots.findIndex((slot) => slot.asset === null);
      if (benchIndex < 0) {
        throw new HttpsError('failed-precondition', 'Choose a bench slot.');
      }
      const benchSlot = roster.benchSlots[benchIndex];
      const droppedAsset = benchSlot.asset;
      if (droppedAsset) {
        const droppedKey = getAssetKey(droppedAsset);
        if (roster.activeSlots.some((slot) =>
          slot.pendingMove?.sourceBenchSlotId === benchSlot.slotId &&
          getAssetKey(slot.pendingMove.incomingAsset) === droppedKey,
        )) {
          throw new HttpsError('failed-precondition', 'That bench player is reserved for a queued swap.');
        }
      }
      roster.irSlots[irIndex] = { ...roster.irSlots[irIndex], asset: null };
      roster.benchSlots[benchIndex] = {
        ...benchSlot,
        asset: { ...irAsset, rosterStatus: 'benched' },
      };
      transaction.set(rosterRef, rosterWrite(roster), { merge: true });
      if (droppedAsset) {
        transaction.set(
          db.doc(`leagues/${leagueId}/waivers/${getAssetKey(droppedAsset)}`),
          buildWaiverPayload(droppedAsset, ownerId, requestedCycle, requestedLabel),
        );
      }
      transaction.set(transactionRef, {
        type: 'activate-ir-to-bench', ownerId, activatedAsset: irAsset,
        droppedAsset: droppedAsset ?? null,
        waiverId: droppedAsset ? getAssetKey(droppedAsset) : null,
        irSlotId, benchSlotId: benchSlot.slotId,
        effectiveCycleNumber: requestedCycle, effectiveLabel: requestedLabel,
        authority: 'cloud-function', createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult('ownership-only', requestedCycle, 'IR player moved to the bench.');
    }

    throw new HttpsError('invalid-argument', 'That roster action is not supported.');
  });
}

async function placeWaiverClaim(options: {
  leagueId: string;
  ownerId: string;
  input: SecureRosterActionRequest;
}): Promise<SecureRosterActionResult> {
  const { leagueId, ownerId, input } = options;
  const waiverId = asString(input.waiverId);
  const moveType = asString(input.waiverMoveType);
  const selectedSlotId = moveType === 'open-slot'
    ? asString(input.targetSlotId)
    : asString(input.dropSlotId);
  if (!waiverId || !['drop', 'open-slot'].includes(moveType) || !selectedSlotId) {
    throw new HttpsError('invalid-argument', 'Waiver, move type, and roster slot are required.');
  }

  const waiverRef = db.doc(`leagues/${leagueId}/waivers/${waiverId}`);
  const rosterRef = db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`);
  const teamRef = db.doc(`leagues/${leagueId}/teams/${ownerId}`);
  const requestedCycle = asPositiveIntegerOrNull(input.effectiveCycleNumber);
  const requestedLabel = asString(input.effectiveLabel) || null;

  return db.runTransaction(async (transaction: any) => {
    const [waiverSnapshot, rosterSnapshot, teamSnapshot] = await Promise.all([
      transaction.get(waiverRef),
      transaction.get(rosterRef),
      transaction.get(teamRef),
    ]);
    if (!waiverSnapshot.exists || !rosterSnapshot.exists) {
      throw new HttpsError('not-found', 'The waiver or roster was not found.');
    }
    const waiver = { id: waiverSnapshot.id, ...waiverSnapshot.data() } as FantasyWaiver;
    if (waiver.status !== 'active') {
      throw new HttpsError('failed-precondition', 'That waiver is no longer active.');
    }
    if (waiver.droppedByOwnerId === ownerId) {
      throw new HttpsError('failed-precondition', 'You cannot claim your own current waiver drop.');
    }
    if (!waiver.asset || waiver.asset.assetKey !== waiver.assetKey) {
      throw new HttpsError('failed-precondition', 'The waiver asset is invalid.');
    }
    const roster = normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>);
    if (rosterContainsAsset(roster, waiver.assetKey)) {
      throw new HttpsError('already-exists', 'That asset is already on your roster.');
    }
    const activeSlot = roster.activeSlots.find((slot) => slot.slotId === selectedSlotId);
    const benchSlot = roster.benchSlots.find((slot) => slot.slotId === selectedSlotId);
    if (!activeSlot && !benchSlot) {
      throw new HttpsError('not-found', 'The selected roster slot was not found.');
    }
    const rosterArea: 'active' | 'bench' = benchSlot ? 'bench' : 'active';
    if (activeSlot) {
      if (activeSlot.pendingMove || activeSlot.position !== waiver.asset.position) {
        throw new HttpsError('failed-precondition', 'The selected active slot is unavailable.');
      }
      if ((moveType === 'open-slot' && activeSlot.asset) || (moveType === 'drop' && !activeSlot.asset)) {
        throw new HttpsError('failed-precondition', 'The active slot state changed.');
      }
    }
    if (benchSlot && ((moveType === 'open-slot' && benchSlot.asset) || (moveType === 'drop' && !benchSlot.asset))) {
      throw new HttpsError('failed-precondition', 'The bench slot state changed.');
    }
    if (benchSlot && moveType === 'drop' && isBenchSlotReserved(roster, benchSlot.slotId)) {
      throw new HttpsError(
        'failed-precondition',
        'That bench player is reserved for a queued swap. Cancel the swap first.',
      );
    }

    const teamData = teamSnapshot.data() ?? {};
    const priority = typeof teamData['waiverPriority'] === 'number'
      ? teamData['waiverPriority']
      : 999;
    const claim: FantasyWaiverClaim = {
      ownerId,
      moveType: moveType as 'drop' | 'open-slot',
      rosterArea,
      dropSlotId: moveType === 'drop' ? selectedSlotId : null,
      targetSlotId: moveType === 'open-slot' ? selectedSlotId : null,
      waiverPriorityAtClaim: priority,
      effectiveCycleNumber: requestedCycle,
      effectiveLabel: requestedLabel,
      claimedAt: new Date().toISOString(),
    };
    const existingClaims = Array.isArray(waiver.claims) ? waiver.claims : [];
    const claims = [...existingClaims.filter((candidate) => candidate.ownerId !== ownerId), claim];
    transaction.set(waiverRef, { claims, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(db.collection(`leagues/${leagueId}/transactions`).doc(), {
      type: 'waiver-claim', ownerId, waiverId, waiverAsset: waiver.asset,
      targetSlotId: claim.targetSlotId, dropSlotId: claim.dropSlotId,
      effectiveCycleNumber: requestedCycle, effectiveLabel: requestedLabel,
      authority: 'cloud-function', createdAt: FieldValue.serverTimestamp(),
    });
    return actionResult('ownership-only', requestedCycle, 'Waiver claim submitted.');
  });
}

async function processWaiver(options: {
  leagueId: string;
  commissionerId: string;
  input: SecureRosterActionRequest;
}): Promise<SecureRosterActionResult> {
  const { leagueId, commissionerId, input } = options;
  const waiverId = asString(input.waiverId);
  if (!waiverId) {
    throw new HttpsError('invalid-argument', 'Waiver ID is required.');
  }
  const [leagueSnapshot, teamsSnapshot] = await Promise.all([
    db.doc(`leagues/${leagueId}`).get(),
    db.collection(`leagues/${leagueId}/teams`).get(),
  ]);
  if (!leagueSnapshot.exists || leagueSnapshot.data()?.['commissionerId'] !== commissionerId) {
    throw new HttpsError('permission-denied', 'Only the commissioner can process waivers.');
  }
  const queueAtSlotBoundary = await hasStartedFantasyCycle(leagueId);
  const teamRefs = teamsSnapshot.docs.map((document: any) => document.ref);
  const waiverRef = db.doc(`leagues/${leagueId}/waivers/${waiverId}`);
  const requestedCycle = asPositiveIntegerOrNull(input.effectiveCycleNumber);
  const requestedLabel = asString(input.effectiveLabel) || null;

  return db.runTransaction(async (transaction: any) => {
    const waiverSnapshot = await transaction.get(waiverRef);
    if (!waiverSnapshot.exists) {
      throw new HttpsError('not-found', 'That waiver was not found.');
    }
    const waiver = { id: waiverSnapshot.id, ...waiverSnapshot.data() } as FantasyWaiver;
    if (waiver.status !== 'active') {
      throw new HttpsError('failed-precondition', 'That waiver has already been processed.');
    }
    if (!waiver.asset || getAssetKey(waiver.asset) !== waiver.assetKey) {
      throw new HttpsError('failed-precondition', 'The waiver asset is invalid.');
    }

    const teamSnapshots = await Promise.all(
      teamRefs.map((reference: any) => transaction.get(reference)),
    );
    const teams = teamSnapshots
      .filter((snapshot: any) => snapshot.exists)
      .map((snapshot: any) => ({ id: snapshot.id, ...snapshot.data() }));
    teams.sort((first: Record<string, unknown>, second: Record<string, unknown>) => {
      const a = typeof first['waiverPriority'] === 'number'
        ? first['waiverPriority'] as number
        : 999;
      const b = typeof second['waiverPriority'] === 'number'
        ? second['waiverPriority'] as number
        : 999;
      return a - b;
    });
    const teamByOwner = new Map<string, Record<string, unknown>>(
      teams.map((team: Record<string, unknown>) => [asString(team['id']), team]),
    );

    const claims = (Array.isArray(waiver.claims) ? waiver.claims : [])
      .filter((claim) => claim.ownerId !== waiver.droppedByOwnerId);
    if (claims.length === 0) {
      transaction.set(waiverRef, {
        status: 'cleared', processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(db.collection(`leagues/${leagueId}/transactions`).doc(), {
        type: 'waiver-cleared', ownerId: commissionerId, waiverId,
        waiverAsset: waiver.asset, authority: 'cloud-function',
        createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult('ownership-only', requestedCycle, 'Waiver cleared with no claims.');
    }

    const orderedClaims = [...claims].sort((first, second) => {
      const firstPriority = teamByOwner.get(first.ownerId)?.['waiverPriority'];
      const secondPriority = teamByOwner.get(second.ownerId)?.['waiverPriority'];
      return (typeof firstPriority === 'number' ? firstPriority : 999) -
        (typeof secondPriority === 'number' ? secondPriority : 999);
    });
    const leagueOwnerIds = teams.map((team: Record<string, unknown>) => asString(team['id']));
    const rosterRefs = leagueOwnerIds.map((ownerId) =>
      db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`),
    );
    const rosterSnapshots = await Promise.all(
      rosterRefs.map((reference) => transaction.get(reference)),
    );
    const rosters = new Map(leagueOwnerIds.map((ownerId, index) => [
      ownerId,
      rosterSnapshots[index]?.exists
        ? normalizeFantasyRoster(rosterSnapshots[index].data() as Partial<FantasyRoster>)
        : null,
    ]));
    if ([...rosters.values()].some((roster) =>
      roster ? rosterContainsAsset(roster, waiver.assetKey) : false,
    )) {
      throw new HttpsError(
        'failed-precondition',
        'The waiver asset is already owned or reserved. No award was made.',
      );
    }

    let winner: FantasyWaiverClaim | null = null;
    let winnerRoster: FantasyRoster | null = null;
    let winnerSlotId = '';
    let activeIndex = -1;
    let benchIndex = -1;
    for (const claim of orderedClaims) {
      const roster = rosters.get(claim.ownerId);
      const slotId = claim.moveType === 'open-slot' ? claim.targetSlotId : claim.dropSlotId;
      if (!roster || !slotId || rosterContainsAsset(roster, waiver.assetKey)) {
        continue;
      }
      const candidateActiveIndex = roster.activeSlots.findIndex((slot) => slot.slotId === slotId);
      const candidateBenchIndex = roster.benchSlots.findIndex((slot) => slot.slotId === slotId);
      const active = candidateActiveIndex >= 0 ? roster.activeSlots[candidateActiveIndex] : null;
      const bench = candidateBenchIndex >= 0 ? roster.benchSlots[candidateBenchIndex] : null;
      const eligible = active
        ? !active.pendingMove && active.position === waiver.asset.position &&
          ((claim.moveType === 'open-slot' && !active.asset) || (claim.moveType === 'drop' && Boolean(active.asset)))
        : bench
          ? !isBenchSlotReserved(roster, bench.slotId) &&
            ((claim.moveType === 'open-slot' && !bench.asset) ||
              (claim.moveType === 'drop' && Boolean(bench.asset)))
          : false;
      if (!eligible) {
        continue;
      }
      winner = claim;
      winnerRoster = roster;
      winnerSlotId = slotId;
      activeIndex = candidateActiveIndex;
      benchIndex = candidateBenchIndex;
      break;
    }

    if (!winner || !winnerRoster) {
      transaction.set(waiverRef, {
        status: 'cleared', processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(db.collection(`leagues/${leagueId}/transactions`).doc(), {
        type: 'waiver-cleared', ownerId: commissionerId, waiverId,
        waiverAsset: waiver.asset, reason: 'no-eligible-claims',
        authority: 'cloud-function', createdAt: FieldValue.serverTimestamp(),
      });
      return actionResult(
        'ownership-only',
        requestedCycle,
        'Waiver cleared because no claims remained eligible.',
      );
    }

    const isBench = benchIndex >= 0;
    const droppedAsset = isBench
      ? winnerRoster.benchSlots[benchIndex].asset
      : winnerRoster.activeSlots[activeIndex].asset;
    const cycles = [winner.effectiveCycleNumber, requestedCycle]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    const effectiveCycleNumber = cycles.length ? Math.max(...cycles) : null;
    const effectiveLabel = effectiveCycleNumber
      ? `Cycle ${effectiveCycleNumber}`
      : winner.effectiveLabel || requestedLabel || 'After current slot window';
    let pendingMove: PendingRosterSlotMove | null = null;

    if (isBench) {
      const slot = winnerRoster.benchSlots[benchIndex];
      winnerRoster.benchSlots[benchIndex] = {
        ...slot,
        asset: createRosterAsset(waiver.asset, 'benched', effectiveCycleNumber),
      };
    } else if (queueAtSlotBoundary) {
      const slot = winnerRoster.activeSlots[activeIndex];
      pendingMove = createPendingRosterMove(
        'waiver-award', winner.ownerId, slot.slotId, slot.asset,
        waiver.asset, waiver.id, effectiveCycleNumber, effectiveLabel,
      );
      winnerRoster.activeSlots[activeIndex] = { ...slot, pendingMove };
    } else {
      const slot = winnerRoster.activeSlots[activeIndex];
      winnerRoster.activeSlots[activeIndex] = {
        ...slot,
        asset: createRosterAsset(waiver.asset, 'new', effectiveCycleNumber),
        pendingMove: null,
        openFromCycleNumber: null,
      };
    }

    transaction.set(
      db.doc(`leagues/${leagueId}/teams/${winner.ownerId}/roster/current`),
      rosterWrite(winnerRoster),
      { merge: true },
    );
    if ((isBench || !queueAtSlotBoundary) && droppedAsset) {
      transaction.set(
        db.doc(`leagues/${leagueId}/waivers/${getAssetKey(droppedAsset)}`),
        buildWaiverPayload(droppedAsset, winner.ownerId, effectiveCycleNumber, effectiveLabel),
      );
    }

    const winnerPriorityValue = teamByOwner.get(winner.ownerId)?.['waiverPriority'];
    const winnerPriority = typeof winnerPriorityValue === 'number' ? winnerPriorityValue : teams.length;
    for (const [index, team] of teams.entries()) {
      const teamOwnerId = asString(team['id']);
      const value = team['waiverPriority'];
      const currentPriority = typeof value === 'number' ? value : index + 1;
      const nextPriority = teamOwnerId === winner.ownerId
        ? Math.max(1, teams.length)
        : currentPriority > winnerPriority
          ? Math.max(1, currentPriority - 1)
          : currentPriority;
      transaction.set(
        db.doc(`leagues/${leagueId}/teams/${teamOwnerId}`),
        { waiverPriority: nextPriority, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }

    transaction.set(waiverRef, {
      status: 'claimed', awardedToOwnerId: winner.ownerId,
      queuedMoveId: pendingMove?.id ?? null, rosterSlotId: winnerSlotId,
      effectiveCycleNumber, effectiveLabel,
      processedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(db.collection(`leagues/${leagueId}/transactions`).doc(), {
      type: !isBench && queueAtSlotBoundary ? 'queue-waiver-award' : 'waiver-award',
      ownerId: winner.ownerId, winningOwnerId: winner.ownerId,
      waiverId, waiverAsset: waiver.asset, addedAsset: waiver.asset,
      droppedAsset: droppedAsset ?? null, rosterSlotId: winnerSlotId,
      queuedMoveId: pendingMove?.id ?? null,
      effectiveCycleNumber, effectiveLabel, authority: 'cloud-function',
      createdAt: FieldValue.serverTimestamp(),
    });
    return actionResult(
      !isBench && queueAtSlotBoundary ? 'queued' : 'ownership-only',
      effectiveCycleNumber,
      `Waiver awarded to ${winner.ownerId}.`,
    );
  });
}

export const ensureFantasyRoster = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request: any): Promise<{ ensured: true; created: boolean; migrated: boolean }> => {
    const ownerId = request.auth?.uid;
    const leagueId = asString(asRecord(request.data)['leagueId']);
    if (!ownerId) {
      throw new HttpsError('unauthenticated', 'You must be signed in.');
    }
    if (!leagueId) {
      throw new HttpsError('invalid-argument', 'League ID is required.');
    }

    const [memberSnapshot, teamSnapshot] = await Promise.all([
      db.doc(`leagues/${leagueId}/members/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/teams/${ownerId}`).get(),
    ]);
    if (!teamSnapshot.exists || (!memberSnapshot.exists && !teamSnapshot.exists)) {
      throw new HttpsError('permission-denied', 'You do not own a team in this league.');
    }

    const rosterRef = db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`);
    return db.runTransaction(async (transaction: any) => {
      const snapshot = await transaction.get(rosterRef);
      if (!snapshot.exists) {
        const roster = createEmptyFantasyRoster();
        transaction.set(rosterRef, {
          ...rosterWrite(roster),
          createdAt: FieldValue.serverTimestamp(),
        });
        return { ensured: true as const, created: true, migrated: false };
      }

      const source = snapshot.data() as Partial<FantasyRoster>;
      const roster = normalizeFantasyRoster(source);
      const needsMigration =
        source.schemaVersion !== 2 ||
        !Array.isArray(source.benchSlots) || source.benchSlots.length !== 3 ||
        !Array.isArray(source.irSlots) || source.irSlots.length !== 3 ||
        !Array.isArray(source.activeSlots) || source.activeSlots.length !== 14;
      if (needsMigration) {
        transaction.set(rosterRef, rosterWrite(roster), { merge: true });
      }
      return { ensured: true as const, created: false, migrated: needsMigration };
    });
  },
);

export const executeSecureRosterAction = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request: any): Promise<SecureRosterActionResult> => {
    const ownerId = request.auth?.uid;
    if (!ownerId) {
      throw new HttpsError('unauthenticated', 'You must be signed in to change a roster.');
    }
    const input = asRecord(request.data) as unknown as SecureRosterActionRequest;
    const leagueId = asString(input.leagueId);
    const action = asString(input.action) as SecureRosterAction;
    if (!leagueId || !action) {
      throw new HttpsError('invalid-argument', 'League and roster action are required.');
    }

    const validActions: SecureRosterAction[] = [
      'add-drop', 'add-open-slot', 'cancel-queued-move', 'move-active-to-ir',
      'activate-ir-active', 'drop-to-waivers', 'queue-active-bench-swap',
      'move-bench-to-ir', 'activate-ir-to-bench', 'place-waiver-claim', 'process-waiver',
    ];
    if (!validActions.includes(action)) {
      throw new HttpsError('invalid-argument', 'That roster action is not supported.');
    }

    const { gamesPerCycle } = await requireOwnerContext(leagueId, ownerId);

    if (action === 'add-drop' || action === 'add-open-slot') {
      const assetKey = asString(input.assetKey);
      const slotId = action === 'add-drop'
        ? asString(input.dropSlotId)
        : asString(input.targetSlotId);
      if (!assetKey || !slotId) {
        throw new HttpsError('invalid-argument', 'Asset and roster slot are required.');
      }
      return executeAddAction({
        leagueId, ownerId, action, assetKey, slotId,
        requestedCycle: asPositiveIntegerOrNull(input.effectiveCycleNumber),
        requestedLabel: asString(input.effectiveLabel) || null,
        gamesPerCycle,
      });
    }

    if (action === 'place-waiver-claim') {
      return placeWaiverClaim({ leagueId, ownerId, input });
    }
    if (action === 'process-waiver') {
      return processWaiver({ leagueId, commissionerId: ownerId, input });
    }

    return executeSimpleOwnerAction({ leagueId, ownerId, action, input, gamesPerCycle });
  },
);
