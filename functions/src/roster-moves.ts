import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { db } from './shared/core/firebase';
import { DraftableAsset } from './shared/core/draft/draft.models';
import {
  FantasyRoster,
  RosterAsset,
} from './shared/core/team/roster.models';
import { normalizeFantasyRoster } from './shared/core/team/roster.service';
import { createFrozenCycleProjection } from './shared/core/projection/cycle-projection.util';
import {
  loadSharedProjectionSnapshot,
  loadSharedProjectionSnapshotForCycle,
  SHARED_PROJECTION_VERSION,
} from './shared/core/projection/projection-snapshot.service';

const FUNCTION_REGION = 'us-central1';
const NHL_API_BASE_URL = 'https://api-web.nhle.com/v1';
const DEFAULT_GAMES_PER_CYCLE = 6;

type ImmediateRosterMoveType =
  | 'add-drop-active'
  | 'add-open-active'
  | 'active-bench-swap'
  | 'activate-ir-active'
  | 'move-active-to-ir'
  | 'drop-active';

interface ImmediateRosterMoveRequest {
  leagueId?: unknown;
  moveType?: unknown;
  activeSlotId?: unknown;
  benchSlotId?: unknown;
  irSlotId?: unknown;
  addAsset?: unknown;
}

interface SlotWindowContext {
  cycleNumber: number;
  cycleRefPath: string;
  teamWindowsRefPath: string;
  rosterPickRefPath: string;
}

interface NhlScheduleGame {
  id?: number;
  gameDate?: string;
  gameType?: number;
  gameState?: string;
  homeTeam?: { score?: number };
  awayTeam?: { score?: number };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function getAssetTeamAbbreviation(asset: DraftableAsset | RosterAsset): string {
  return asset.assetType === 'skater'
    ? asset.player.nhlTeamAbbreviation
    : asset.teamAbbreviation;
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

async function getAuthoritativeAvailabilityStatus(
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
  const leagueOverrideStatus = asString(leagueOverrideSnapshot.data()?.['status']);

  if (leagueOverrideStatus) {
    return leagueOverrideStatus;
  }

  const globalRecord = asArray(globalAvailabilitySnapshot.data()?.['records'])
    .map(asRecord)
    .find((record) => asNumber(record['playerId'], -1) === asset.player.id);
  const globalStatus = asString(globalRecord?.['status']);

  return globalStatus || asString(asset.availabilityStatus);
}

function getNhlSeasonForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;

  return `${startYear}${startYear + 1}`;
}

function getScheduleGameState(game: NhlScheduleGame): 'scheduled' | 'live' | 'final' {
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

async function getEarliestEligibleCycleNumber(
  asset: DraftableAsset | RosterAsset,
  gamesPerCycle: number,
): Promise<number> {
  const team = getAssetTeamAbbreviation(asset).toLowerCase();
  const season = getNhlSeasonForDate(new Date());
  const response = await fetch(`${NHL_API_BASE_URL}/club-schedule-season/${team}/${season}`);

  if (!response.ok) {
    throw new HttpsError(
      'unavailable',
      `Unable to verify ${team.toUpperCase()}'s current six-game window.`,
    );
  }

  const body = asRecord(await response.json());
  const schedule = asArray(body['games'])
    .map((value) => asRecord(value) as NhlScheduleGame)
    .filter((game) => game.gameType === 2)
    .sort((first, second) => asString(first.gameDate).localeCompare(asString(second.gameDate)));

  if (schedule.length === 0) {
    throw new HttpsError(
      'failed-precondition',
      `No regular-season schedule was found for ${team.toUpperCase()}.`,
    );
  }

  const normalizedGamesPerCycle = Math.max(1, Math.floor(gamesPerCycle));
  const totalCycleCount = Math.max(1, Math.ceil(schedule.length / normalizedGamesPerCycle));

  for (let index = 0; index < totalCycleCount; index += 1) {
    const cycleGames = schedule.slice(
      index * normalizedGamesPerCycle,
      (index + 1) * normalizedGamesPerCycle,
    );
    const states = cycleGames.map(getScheduleGameState);
    const complete = cycleGames.length > 0 && states.every((state) => state === 'final');

    if (complete) {
      continue;
    }

    const started = states.some((state) => state === 'final' || state === 'live');
    return started ? index + 2 : index + 1;
  }

  return totalCycleCount + 1;
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
    };
  }

  return null;
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
    completedGameIds: [],
    liveGameIds: [],
    appearanceGameIds: [],
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

export const applyImmediateRosterMove = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
  },
  async (request) => {
    const ownerId = request.auth?.uid;
    if (!ownerId) {
      throw new HttpsError('unauthenticated', 'You must be signed in to change your roster.');
    }

    const input = request.data as ImmediateRosterMoveRequest;
    const leagueId = asString(input.leagueId);
    const moveType = asString(input.moveType) as ImmediateRosterMoveType;
    const activeSlotId = asString(input.activeSlotId);
    const benchSlotId = asString(input.benchSlotId);
    const irSlotId = asString(input.irSlotId);
    const addAsset = input.addAsset && typeof input.addAsset === 'object'
      ? input.addAsset as DraftableAsset
      : null;
    const canTargetOpenSlot =
      moveType === 'add-open-active' ||
      moveType === 'active-bench-swap' ||
      moveType === 'activate-ir-active';

    if (!leagueId || !activeSlotId) {
      throw new HttpsError('invalid-argument', 'League and active roster slot are required.');
    }

    if (!['add-drop-active', 'add-open-active', 'active-bench-swap', 'activate-ir-active', 'move-active-to-ir', 'drop-active'].includes(moveType)) {
      throw new HttpsError('invalid-argument', 'That immediate roster move type is not supported.');
    }

    if ((moveType === 'add-drop-active' || moveType === 'add-open-active') && !addAsset) {
      throw new HttpsError('invalid-argument', 'The incoming player is required.');
    }

    if (moveType === 'active-bench-swap' && !benchSlotId) {
      throw new HttpsError('invalid-argument', 'The bench slot is required.');
    }

    if (moveType === 'activate-ir-active' && !irSlotId) {
      throw new HttpsError('invalid-argument', 'The IR slot is required.');
    }

    const [leagueSnapshot, memberSnapshot, draftSnapshot, teamsSnapshot] = await Promise.all([
      db.doc(`leagues/${leagueId}`).get(),
      db.doc(`leagues/${leagueId}/members/${ownerId}`).get(),
      db.doc(`leagues/${leagueId}/draft/current`).get(),
      db.collection(`leagues/${leagueId}/teams`).get(),
    ]);

    if (!leagueSnapshot.exists || !memberSnapshot.exists) {
      throw new HttpsError('permission-denied', 'You are not a member of this league.');
    }

    if (!draftSnapshot.exists || draftSnapshot.data()?.['status'] !== 'complete') {
      throw new HttpsError('failed-precondition', 'Roster moves open after the draft is complete.');
    }

    const context = await findSlotWindowContext(leagueId, ownerId, activeSlotId);
    if (!context) {
      throw new HttpsError(
        'failed-precondition',
        'The current slot window is not ready yet. Refresh and try again.',
      );
    }

    const scoringRules = asRecord(leagueSnapshot.data()?.['scoringRules']);
    const gamesPerCycle = Math.max(
      1,
      Math.floor(asNumber(scoringRules['requiredGamesPerCycle'], DEFAULT_GAMES_PER_CYCLE)),
    );

    let incomingEligibilityCycle = 1;
    if (addAsset) {
      if (!asString(addAsset.assetKey) || !asString(addAsset.position)) {
        throw new HttpsError('invalid-argument', 'The incoming asset is invalid.');
      }
      incomingEligibilityCycle = await getEarliestEligibleCycleNumber(addAsset, gamesPerCycle);
    }

    const rosterRef = db.doc(`leagues/${leagueId}/teams/${ownerId}/roster/current`);
    const cycleRef = db.doc(context.cycleRefPath);
    const teamWindowsRef = db.doc(context.teamWindowsRefPath);
    const rosterPickRef = db.doc(context.rosterPickRefPath);
    const rosterRefs = teamsSnapshot.docs.map((team) => {
      const teamOwnerId = asString(team.data()['ownerId']) || team.id;
      return db.doc(`leagues/${leagueId}/teams/${teamOwnerId}/roster/current`);
    });

    const [preflightRosterSnapshot, preflightRosterPickSnapshot] = await Promise.all([
      rosterRef.get(),
      rosterPickRef.get(),
    ]);

    if (!preflightRosterSnapshot.exists) {
      throw new HttpsError('failed-precondition', 'The current roster assignment was not found.');
    }

    const preflightRoster = normalizeFantasyRoster(
      preflightRosterSnapshot.data() as Partial<FantasyRoster>,
    );
    const preflightActiveSlot = preflightRoster.activeSlots.find(
      (slot) => slot.slotId === activeSlotId,
    );
    const preflightRosterPickAsset = preflightRosterPickSnapshot.data()?.['asset'] as
      | DraftableAsset
      | undefined;

    if (!preflightActiveSlot) {
      throw new HttpsError('failed-precondition', 'The current active-slot assignment is unavailable.');
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

    const preflightOutgoingAssetKey = getAssetKey(preflightRosterPickAsset);
    const preflightActiveAsset = preflightActiveSlot.asset;

    if (preflightActiveAsset) {
      if (getAssetKey(preflightActiveAsset) !== preflightOutgoingAssetKey) {
        throw new HttpsError(
          'aborted',
          'The active roster and current cycle assignment are out of sync. Refresh and try again.',
        );
      }
    } else if (!canTargetOpenSlot) {
      throw new HttpsError('failed-precondition', 'The active roster slot is already empty.');
    }

    // The saved scoring window is the primary lock, but the server also checks
    // the outgoing NHL team's real schedule. This closes the small gap between
    // puck drop and the next scoring-worker refresh: both individual assets
    // truly must be untouched for an immediate current-cycle rewrite.
    if (preflightActiveAsset) {
      const outgoingEligibilityCycle = Math.max(
        preflightActiveAsset.eligibleFromCycleNumber ?? 1,
        await getEarliestEligibleCycleNumber(preflightActiveAsset, gamesPerCycle),
      );

      if (outgoingEligibilityCycle > context.cycleNumber) {
        throw new HttpsError(
          'failed-precondition',
          `The current player's Cycle ${context.cycleNumber} block has already started. This move must wait until Cycle ${outgoingEligibilityCycle}.`,
        );
      }
    }

    let preflightMoveToIrAvailabilityStatus = '';

    if (moveType === 'move-active-to-ir') {
      if (!preflightActiveAsset || preflightActiveAsset.assetType !== 'skater') {
        throw new HttpsError('failed-precondition', 'Only skaters can be moved to IR.');
      }

      preflightMoveToIrAvailabilityStatus = await getAuthoritativeAvailabilityStatus(
        leagueId,
        preflightActiveAsset,
      );

      if (!IR_ELIGIBLE_STATUSES.has(preflightMoveToIrAvailabilityStatus)) {
        throw new HttpsError(
          'failed-precondition',
          'That player is not currently eligible for an IR roster slot.',
        );
      }
    }

    let preflightBenchAssetKey = '';
    let preflightBenchEligibilityCycle: number | null = null;
    let preflightIrAssetKey = '';
    let preflightIrEligibilityCycle: number | null = null;

    if (moveType === 'active-bench-swap' || moveType === 'activate-ir-active') {
      if (moveType === 'active-bench-swap') {
        const preflightBenchSlot = preflightRoster.benchSlots.find(
          (slot) => slot.slotId === benchSlotId,
        );
        const preflightBenchAsset = preflightBenchSlot?.asset ?? null;

        if (!preflightBenchAsset) {
          throw new HttpsError('failed-precondition', 'The selected bench player is unavailable.');
        }

        preflightBenchAssetKey = getAssetKey(preflightBenchAsset);
        preflightBenchEligibilityCycle = Math.max(
          preflightBenchAsset.eligibleFromCycleNumber ?? 1,
          await getEarliestEligibleCycleNumber(preflightBenchAsset, gamesPerCycle),
        );
      } else {
        const preflightIrSlot = preflightRoster.irSlots.find((slot) => slot.slotId === irSlotId);
        const preflightIrAsset = preflightIrSlot?.asset ?? null;

        if (!preflightIrAsset) {
          throw new HttpsError('failed-precondition', 'The selected IR player is unavailable.');
        }

        preflightIrAssetKey = getAssetKey(preflightIrAsset);
        preflightIrEligibilityCycle = Math.max(
          preflightIrAsset.eligibleFromCycleNumber ?? 1,
          await getEarliestEligibleCycleNumber(preflightIrAsset, gamesPerCycle),
        );
      }
    }

    const preflightIncomingAsset = moveType === 'active-bench-swap'
      ? rosterAssetToDraftableAsset(
          preflightRoster.benchSlots.find((slot) => slot.slotId === benchSlotId)!.asset!,
        )
      : moveType === 'activate-ir-active'
        ? rosterAssetToDraftableAsset(
            preflightRoster.irSlots.find((slot) => slot.slotId === irSlotId)!.asset!,
          )
        : addAsset;
    const resolvedIncomingAsset = preflightIncomingAsset
      ? await resolveIncomingProjectionForCycle(
          leagueId,
          context.cycleNumber,
          preflightIncomingAsset,
        )
      : null;

    return db.runTransaction(async (transaction) => {
      const [rosterSnapshot, cycleSnapshot, teamWindowsSnapshot, rosterPickSnapshot, ...allRosterSnapshots] =
        await Promise.all([
          transaction.get(rosterRef),
          transaction.get(cycleRef),
          transaction.get(teamWindowsRef),
          transaction.get(rosterPickRef),
          ...rosterRefs.map((reference) => transaction.get(reference)),
        ]);

      if (
        !rosterSnapshot.exists ||
        !cycleSnapshot.exists ||
        (!canTargetOpenSlot && !rosterPickSnapshot.exists)
      ) {
        throw new HttpsError('failed-precondition', 'The current roster assignment is unavailable.');
      }

      const roster = normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>);
      const activeSlotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === activeSlotId);
      if (activeSlotIndex < 0) {
        throw new HttpsError('not-found', 'The selected active roster slot was not found.');
      }

      const activeSlot = roster.activeSlots[activeSlotIndex];
      if (activeSlot.pendingMove) {
        throw new HttpsError('failed-precondition', 'That active slot already has a queued move.');
      }

      const transactionPickAsset = rosterPickSnapshot.data()?.['asset'];
      if (
        activeSlot.asset &&
        getAssetKey(transactionPickAsset) !== preflightOutgoingAssetKey
      ) {
        throw new HttpsError(
          'aborted',
          'The active-slot assignment changed while the move was being checked. Please try again.',
        );
      }

      const teamWindowsData = teamWindowsSnapshot.exists
        ? teamWindowsSnapshot.data() ?? {}
        : {};

      if (canTargetOpenSlot && asString(teamWindowsData['status']) === 'complete') {
        throw new HttpsError(
          'failed-precondition',
          `Cycle ${context.cycleNumber} is already complete for this team. The move must begin in the next cycle.`,
        );
      }

      const windows = asArray(teamWindowsData['windows']).map(asRecord);
      const windowIndex = windows.findIndex(
        (window) => asString(window['rosterSlotId']) === activeSlotId,
      );

      if (windowIndex >= 0 && !isUntouchedWindow(windows[windowIndex])) {
        throw new HttpsError(
          'failed-precondition',
          'This slot has started its current six-game window. The move must wait for the next boundary.',
        );
      }

      let incomingAsset: DraftableAsset | null = null;
      const outgoingAsset = activeSlot.asset;
      let droppedAsset: RosterAsset | null = outgoingAsset;
      let benchSlotIdForTransaction: string | null = null;
      let irSlotIdForTransaction: string | null = null;
      const removesActiveAssignment =
        moveType === 'move-active-to-ir' || moveType === 'drop-active';

      if (
        (moveType === 'add-drop-active' ||
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
        if (!IR_ELIGIBLE_STATUSES.has(preflightMoveToIrAvailabilityStatus)) {
          throw new HttpsError(
            'failed-precondition',
            'That player is not currently eligible for an IR roster slot.',
          );
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
      } else if (moveType === 'active-bench-swap') {
        const benchSlotIndex = roster.benchSlots.findIndex((slot) => slot.slotId === benchSlotId);
        if (benchSlotIndex < 0 || !roster.benchSlots[benchSlotIndex].asset) {
          throw new HttpsError('failed-precondition', 'The selected bench player is unavailable.');
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

        if (incomingEligibilityCycle > context.cycleNumber) {
          throw new HttpsError(
            'failed-precondition',
            `The incoming player's current block has started. The earliest fair activation is Cycle ${incomingEligibilityCycle}.`,
          );
        }

        if (moveType === 'add-drop-active' && !outgoingAsset) {
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

        const incomingKey = incomingAsset.assetKey;
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

        const activeWaiverSnapshot = await transaction.get(
          db.doc(`leagues/${leagueId}/waivers/${incomingKey}`),
        );
        if (activeWaiverSnapshot.exists && activeWaiverSnapshot.data()?.['status'] === 'active') {
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

      if (removesActiveAssignment) {
        if (windowIndex >= 0) {
          windows.splice(windowIndex, 1);
        }
        transaction.delete(rosterPickRef);
      } else if (incomingAsset) {
        const resetWindow = buildResetWindow(
          windowIndex >= 0 ? windows[windowIndex] : {},
          incomingAsset,
          ownerId,
          activeSlotId,
          context.cycleNumber,
        );
        if (windowIndex >= 0) {
          windows[windowIndex] = resetWindow;
        } else {
          windows.push(resetWindow);
        }

        const existingPick = rosterPickSnapshot.exists ? rosterPickSnapshot.data() ?? {} : {};
        const fallbackOrder = 100000 + activeSlotIndex + 1;
        transaction.set(rosterPickRef, {
          ...existingPick,
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
          snapshotSource: 'immediate-untouched-roster-move',
          snapshottedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
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
          moveType === 'activate-ir-active' ||
          moveType === 'drop-active') &&
        droppedAsset
      ) {
        waiverId = getAssetKey(droppedAsset);
        transaction.set(
          db.doc(`leagues/${leagueId}/waivers/${waiverId}`),
          buildWaiverPayload(droppedAsset, ownerId, context.cycleNumber),
        );
      }

      const transactionType = moveType === 'active-bench-swap'
        ? 'active-bench-swap-activated'
        : moveType === 'activate-ir-active'
          ? 'activate-from-ir'
          : moveType === 'move-active-to-ir'
            ? 'move-to-ir'
            : moveType === 'drop-active'
              ? 'drop-to-waivers'
              : moveType === 'add-drop-active'
                ? 'add-drop'
                : 'add-open-slot';
      const transactionRef = db.collection(`leagues/${leagueId}/transactions`).doc();
      transaction.set(transactionRef, {
        type: transactionType,
        ownerId,
        addedAsset:
          moveType === 'add-drop-active' || moveType === 'add-open-active'
            ? incomingAsset
            : null,
        movedAsset: moveType === 'active-bench-swap'
          ? roster.activeSlots[activeSlotIndex].asset
          : moveType === 'move-active-to-ir'
            ? outgoingAsset
            : null,
        activatedAsset: moveType === 'activate-ir-active'
          ? roster.activeSlots[activeSlotIndex].asset
          : null,
        droppedAsset:
          moveType === 'move-active-to-ir' || moveType === 'active-bench-swap'
            ? null
            : droppedAsset,
        waiverId,
        activeSlotId,
        benchSlotId: benchSlotIdForTransaction,
        irSlotId: irSlotIdForTransaction,
        sourceRosterArea: moveType === 'drop-active' ? 'active' : null,
        targetSlotId: moveType === 'add-open-active' ? activeSlotId : null,
        dropSlotId:
          moveType === 'add-drop-active' || moveType === 'drop-active'
            ? activeSlotId
            : null,
        rosterSlotId: activeSlotId,
        effectiveCycleNumber: context.cycleNumber,
        effectiveLabel: `Cycle ${context.cycleNumber}`,
        immediateUntouchedWindow: true,
        createdAt: FieldValue.serverTimestamp(),
      });

      return {
        applied: true as const,
        cycleNumber: context.cycleNumber,
        activeSlotId,
        message: `Applied immediately to untouched Cycle ${context.cycleNumber}.`,
      };
    });
  },
);
