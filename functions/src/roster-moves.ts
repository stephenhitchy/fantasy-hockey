import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { enforceAppCheckCallableCanaryForLeague } from './app-check-canary-authority';
import { db } from './shared/core/firebase';
import { queueNhlSharedCacheObservation } from './shared/core/nhl/nhl-shared-cache.service';
import {
  loadCurrentNhlPlayerTeamIdentity,
  type NhlPlayerTeamIdentitySnapshot,
} from './shared/core/nhl/nhl-player-team-identity.service';
import { TRUSTED_WEB_ORIGINS } from './web-security';
import {
  optionalFirestoreDocumentId,
  requireFirestoreDocumentId,
} from './shared/security/firestore-document-id.util';
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
import {
  resolveServerRosterMoveReplayContext,
  type ServerRosterMoveReplayContext,
} from './shared/core/replay/roster-move-replay-context.util';
import {
  buildSourceNhlTargetGameIdsByTeam,
} from './shared/core/cycle/cycle-window-selection.util';
import { createPlayerWindowContinuity } from './shared/core/cycle/player-window-continuity.util';

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
  addAssetKey?: unknown;
  addAsset?: unknown;
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
  gameType?: number;
  gameState?: string;
  homeTeam?: { score?: number };
  awayTeam?: { score?: number };
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

function isBenchSlotReserved(roster: FantasyRoster, benchSlotId: string): boolean {
  const benchAsset = roster.benchSlots.find((slot) => slot.slotId === benchSlotId)?.asset;
  const assetKey = getAssetKey(benchAsset);

  return Boolean(assetKey) && roster.activeSlots.some((slot) =>
    slot.pendingMove?.sourceBenchSlotId === benchSlotId &&
    getAssetKey(slot.pendingMove.incomingAsset) === assetKey,
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

    const states = blockGames.map((game) =>
      getScheduleGameState(game, input.completedThroughDate ?? null),
    );
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
  const team = teamAbbreviation.toLowerCase();
  const season = replayContext.mode === 'historical-replay'
    ? replayContext.seasonOverride
    : getNhlSeasonForDate(new Date());
  const completedThroughDate = replayContext.mode === 'historical-replay'
    ? replayContext.completedThroughDate
    : null;
  const response = await fetch(`${NHL_API_BASE_URL}/club-schedule-season/${team}/${season}`);

  if (!response.ok) {
    throw new HttpsError(
      'unavailable',
      `Unable to verify ${team.toUpperCase()}'s current six-game window.`,
    );
  }

  const payload = await response.json();

  queueNhlSharedCacheObservation({
    url: `${NHL_API_BASE_URL}/club-schedule-season/${team}/${season}`,
    payload,
    source: 'functions-core',
  });

  const body = asRecord(payload);
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

export const applyImmediateRosterMove = onCall(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: TRUSTED_WEB_ORIGINS,
  },
  async (request) => {
    const authenticatedOwnerId = request.auth?.uid;
    if (!authenticatedOwnerId) {
      throw new HttpsError('unauthenticated', 'You must be signed in to change your roster.');
    }

    const ownerId = requireFirestoreDocumentId(
      authenticatedOwnerId,
      'manager ID',
      { maxBytes: 128 },
    );
    const input = asRecord(request.data) as unknown as ImmediateRosterMoveRequest;
    const leagueId = requireFirestoreDocumentId(input.leagueId, 'league ID', {
      minimumLength: 6,
      maxBytes: 128,
      pattern: /^[A-Za-z0-9_-]+$/,
    });
    await enforceAppCheckCallableCanaryForLeague(
      request,
      'applyImmediateRosterMove',
      leagueId,
    );
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

    if (!['add-drop-active', 'add-open-active', 'active-bench-swap', 'activate-ir-active', 'move-active-to-ir', 'drop-active'].includes(moveType)) {
      throw new HttpsError('invalid-argument', 'That immediate roster move type is not supported.');
    }

    const rawRequestedAssetKey = asString(input.addAssetKey) || getAssetKey(input.addAsset);
    const requestedAssetKey = rawRequestedAssetKey
      ? requireFirestoreDocumentId(rawRequestedAssetKey, 'asset key', {
          maxBytes: 160,
          pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
        })
      : '';
    const addAsset = requestedAssetKey
      ? await loadCanonicalDraftableAsset(leagueId, requestedAssetKey)
      : null;
    const canTargetOpenSlot =
      moveType === 'add-open-active' ||
      moveType === 'active-bench-swap' ||
      moveType === 'activate-ir-active';

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
    const rosterRefs = teamsSnapshot.docs.map((team) =>
      db.doc(`leagues/${leagueId}/teams/${team.id}/roster/current`),
    );

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
    const rosterMoveReplayContext = await loadRosterMoveReplayContext(leagueId);

    if (rosterMoveReplayContext.mode === 'blocked') {
      throw new HttpsError(
        'failed-precondition',
        rosterMoveReplayContext.message,
      );
    }

    let rosterMoveIdentity: NhlPlayerTeamIdentitySnapshot | null = null;
    const preflightSelectedIncomingAsset = moveType === 'active-bench-swap'
      ? preflightRoster.benchSlots.find((slot) => slot.slotId === benchSlotId)
          ?.asset
      : moveType === 'activate-ir-active'
        ? preflightRoster.irSlots.find((slot) => slot.slotId === irSlotId)
            ?.asset
        : null;
    const requiredIdentityPlayerIds = getSkaterPlayerIds([
      preflightActiveSlot.asset,
      addAsset,
      preflightSelectedIncomingAsset,
    ]);

    if (
      rosterMoveReplayContext.mode === 'live' &&
      requiredIdentityPlayerIds.length > 0
    ) {
      const identityBoundaryMilliseconds = Date.now();
      rosterMoveIdentity = await loadCurrentNhlPlayerTeamIdentity({
        requiredPlayerIds: requiredIdentityPlayerIds,
        minimumGeneratedAtMilliseconds: identityBoundaryMilliseconds,
      });
    }

    const currentTeamAbbreviationByPlayerId = rosterMoveIdentity?.byPlayerId;
    const preflightActiveAsset = preflightActiveSlot.asset
      ? applyCurrentNhlTeamIdentity(
          preflightActiveSlot.asset,
          currentTeamAbbreviationByPlayerId,
        )
      : null;
    const authoritativeAddAsset = addAsset
      ? applyCurrentNhlTeamIdentity(
          addAsset,
          currentTeamAbbreviationByPlayerId,
        )
      : null;

    if (authoritativeAddAsset) {
      incomingEligibilityCycle = await getEarliestEligibleCycleNumber(
        authoritativeAddAsset,
        gamesPerCycle,
        leagueId,
        currentTeamAbbreviationByPlayerId,
      );
    }

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
        await getEarliestEligibleCycleNumber(
          preflightActiveAsset,
          gamesPerCycle,
          leagueId,
          currentTeamAbbreviationByPlayerId,
        ),
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
    let preflightIrBenchSlotId = '';
    let preflightIrBenchAssetKey = '';

    if (moveType === 'active-bench-swap' || moveType === 'activate-ir-active') {
      if (moveType === 'active-bench-swap') {
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
        preflightBenchEligibilityCycle = Math.max(
          preflightBenchAsset.eligibleFromCycleNumber ?? 1,
          await getEarliestEligibleCycleNumber(
            preflightBenchAsset,
            gamesPerCycle,
            leagueId,
            currentTeamAbbreviationByPlayerId,
          ),
        );
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

    const rawPreflightIncomingAsset = moveType === 'active-bench-swap'
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
    const transactionRef = db.collection(`leagues/${leagueId}/transactions`).doc();

    return db.runTransaction(async (transaction) => {
      const [
        rosterSnapshot,
        cycleSnapshot,
        teamWindowsSnapshot,
        rosterPickSnapshot,
        playoffBankSnapshot,
        ...allRosterSnapshots
      ] =
        await Promise.all([
          transaction.get(rosterRef),
          transaction.get(cycleRef),
          transaction.get(teamWindowsRef),
          transaction.get(rosterPickRef),
          playoffBankRef
            ? transaction.get(playoffBankRef)
            : Promise.resolve(null),
          ...rosterRefs.map((reference) => transaction.get(reference)),
        ]);

      if (
        !rosterSnapshot.exists ||
        !cycleSnapshot.exists ||
        (!canTargetOpenSlot && !rosterPickSnapshot.exists) ||
        (playoffBankRef && !playoffBankSnapshot?.exists)
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
      const playoffBankData = playoffBankSnapshot?.exists
        ? playoffBankSnapshot.data() ?? {}
        : null;

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

        const savedBankPick = asArray(playoffBankData['picks'])
          .map(asRecord)
          .find((pick) => asString(pick['rosterSlotId']) === activeSlotId);

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
            bankPickAssetKey !== rosterPickAssetKey ||
            bankContinuityId !== rosterContinuityId
          ) {
            throw new HttpsError(
              'aborted',
              'The playoff bank and active cycle assignment are out of sync. No move was applied.',
            );
          }
        } else if (savedBankPick) {
          throw new HttpsError(
            'aborted',
            'The playoff bank still owns this open slot. No move was applied.',
          );
        }
      }

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
      const outgoingAsset = activeSlot.asset
        ? applyCurrentNhlTeamIdentity(
            activeSlot.asset,
            currentTeamAbbreviationByPlayerId,
          )
        : null;
      let droppedAsset: RosterAsset | null = moveType === 'activate-ir-active'
        ? null
        : outgoingAsset;
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

        const incomingKey = requireRosterMoveAssetKey(
          incomingAsset.assetKey,
          'incoming asset key',
        );
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
      let nextRosterPickForBank: Record<string, unknown> | null = null;
      let resetWindowForBank: Record<string, unknown> | null = null;

      if (removesActiveAssignment) {
        if (windowIndex >= 0) {
          windows.splice(windowIndex, 1);
        }
        transaction.delete(rosterPickRef);
      } else if (incomingAsset) {
        const playerWindowContinuity = createPlayerWindowContinuity({
          ownerId,
          rosterSlotId: activeSlotId,
          asset: incomingAsset,
          activationKey: `move-${transactionRef.id}`,
        });
        const resetWindow = buildResetWindow(
          windowIndex >= 0 ? windows[windowIndex] : {},
          incomingAsset,
          ownerId,
          activeSlotId,
          context.cycleNumber,
        );
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
        const incomingSourceNhlTargetGameIds = asArray(
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
          snapshotSource: 'immediate-untouched-roster-move',
          playerWindowContinuity: playerWindowContinuity ?? null,
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
        : moveType === 'activate-ir-active'
          ? 'activate-from-ir'
          : moveType === 'move-active-to-ir'
            ? 'move-to-ir'
            : moveType === 'drop-active'
              ? 'drop-to-waivers'
              : moveType === 'add-drop-active'
                ? 'add-drop'
                : 'add-open-slot';
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
            : moveType === 'activate-ir-active'
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
        ...(rosterMoveIdentity
          ? {
              nhlPlayerTeamIdentityHash: rosterMoveIdentity.identityHash,
              nhlPlayerTeamIdentityGeneratedAt:
                rosterMoveIdentity.generatedAt,
            }
          : {}),
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
