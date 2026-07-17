import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';

import { db } from '../firebase';
import { DraftPick } from '../draft/draft.models';
import { getFrozenCycleProjection } from '../projection/cycle-projection.util';
import {
  AssetCycleWindowStatus,
  FantasyAssetCycleWindow,
  FantasyCycle,
  FantasyTeamCycleWindows,
} from './cycle.models';
import { CycleAssetScoreSummary, CycleScoringResult } from './cycle-scoring.service';

function getCycleDocumentId(cycleNumber: number): string {
  return `cycle-${cycleNumber}`;
}

function getTeamWindowsCollectionRef(leagueId: string, cycleNumber: number) {
  return collection(
    db,
    'leagues',
    leagueId,
    'cycles',
    getCycleDocumentId(cycleNumber),
    'teamWindows',
  );
}

export function getCycleTeamWindowsRef(leagueId: string, cycleNumber: number, ownerId: string) {
  return doc(getTeamWindowsCollectionRef(leagueId, cycleNumber), ownerId);
}

function getRosterSlotId(pick: DraftPick): string {
  return pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`;
}

function getWindowId(pick: DraftPick, cycleNumber: number): string {
  return pick.cycleWindowId ?? `${pick.ownerId}__${getRosterSlotId(pick)}__cycle-${cycleNumber}`;
}

function getPickWindowCycleNumber(pick: DraftPick, fallbackCycleNumber: number): number {
  return pick.snapshotCycleNumber ?? fallbackCycleNumber;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function normalizeNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}

function normalizeGameStateRecord(value: unknown): Record<string, 'scheduled' | 'live' | 'final'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, 'scheduled' | 'live' | 'final'] =>
        entry[1] === 'scheduled' || entry[1] === 'live' || entry[1] === 'final',
    ),
  );
}

function normalizeNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
  );
}

function normalizeAssetCycleWindow(
  value: Partial<FantasyAssetCycleWindow>,
  ownerId: string,
  cycleNumber: number,
): FantasyAssetCycleWindow {
  return {
    id: value.id ?? '',
    ownerId: value.ownerId ?? ownerId,
    rosterSlotId: value.rosterSlotId ?? '',
    cycleNumber: value.cycleNumber ?? cycleNumber,
    position: value.position ?? 'C',
    assetKey: value.assetKey ?? value.asset?.assetKey ?? '',
    asset: value.asset as FantasyAssetCycleWindow['asset'],
    status:
      value.status === 'complete' ? 'complete' : value.status === 'active' ? 'active' : 'scheduled',
    scheduledGameIds: normalizeNumberArray(value.scheduledGameIds),
    scheduledGameDates: normalizeStringArray(value.scheduledGameDates),
    scheduledGameLabels: normalizeStringArray(value.scheduledGameLabels),
    completedGameIds: normalizeNumberArray(value.completedGameIds),
    liveGameIds: normalizeNumberArray(value.liveGameIds),
    appearanceGameIds: normalizeNumberArray(value.appearanceGameIds),
    gameScores: normalizeNumberRecord(value.gameScores),
    gameStates: normalizeGameStateRecord(value.gameStates),
    scheduledGames: typeof value.scheduledGames === 'number' ? value.scheduledGames : 0,
    gamesPlayed: typeof value.gamesPlayed === 'number' ? value.gamesPlayed : 0,
    actualGamesPlayed: typeof value.actualGamesPlayed === 'number' ? value.actualGamesPlayed : 0,
    gamesLeft: typeof value.gamesLeft === 'number' ? value.gamesLeft : 0,
    fantasyPoints: typeof value.fantasyPoints === 'number' ? value.fantasyPoints : 0,
    frozenProjectionPoints:
      typeof value.frozenProjectionPoints === 'number' ? value.frozenProjectionPoints : null,
    frozenProjectionVersion:
      typeof value.frozenProjectionVersion === 'number' ? value.frozenProjectionVersion : null,
    frozenProjectionSource:
      value.frozenProjectionSource === 'shared-snapshot' ||
      value.frozenProjectionSource === 'roster' ||
      value.frozenProjectionSource === 'draft-pick' ||
      value.frozenProjectionSource === 'legacy'
        ? value.frozenProjectionSource
        : null,
    frozenProjectionSnapshotId:
      typeof value.frozenProjectionSnapshotId === 'string'
        ? value.frozenProjectionSnapshotId
        : null,
    frozenProjectionGeneratedAt:
      typeof value.frozenProjectionGeneratedAt === 'string'
        ? value.frozenProjectionGeneratedAt
        : null,
    frozenProjectionFrozenAt:
      typeof value.frozenProjectionFrozenAt === 'string' ? value.frozenProjectionFrozenAt : null,
    frozenProjectionTargetGameIds: normalizeNumberArray(value.frozenProjectionTargetGameIds),
    firstScheduledGameDate:
      typeof value.firstScheduledGameDate === 'string' ? value.firstScheduledGameDate : null,
    lastScheduledGameDate:
      typeof value.lastScheduledGameDate === 'string' ? value.lastScheduledGameDate : null,
    startedAt: value.startedAt ?? null,
    completedAt: value.completedAt ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function normalizeFantasyTeamCycleWindows(
  ownerId: string,
  cycleNumber: number,
  data: Partial<FantasyTeamCycleWindows>,
): FantasyTeamCycleWindows {
  return {
    id: ownerId,
    ownerId,
    cycleNumber,
    expectedRosterSlotIds: normalizeStringArray(data.expectedRosterSlotIds),
    windows: Array.isArray(data.windows)
      ? data.windows.map((window) =>
          normalizeAssetCycleWindow(
            window as Partial<FantasyAssetCycleWindow>,
            ownerId,
            cycleNumber,
          ),
        )
      : [],
    completedWindowCount:
      typeof data.completedWindowCount === 'number' ? data.completedWindowCount : 0,
    totalWindowCount: typeof data.totalWindowCount === 'number' ? data.totalWindowCount : 0,
    status:
      data.status === 'complete' ? 'complete' : data.status === 'active' ? 'active' : 'scheduled',
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    completedAt: data.completedAt ?? null,
  };
}

function getSummaryForPick(
  pick: DraftPick,
  cycleNumber: number,
  scoring: CycleScoringResult,
): CycleAssetScoreSummary | null {
  const pickWindowCycleNumber = getPickWindowCycleNumber(pick, cycleNumber);
  const windowId = getWindowId(pick, pickWindowCycleNumber);

  return scoring.windowScores[windowId] ?? scoring.assetScores[pick.asset.assetKey] ?? null;
}

function buildWindow(
  pick: DraftPick,
  cycleNumber: number,
  summary: CycleAssetScoreSummary | null,
  previous: FantasyAssetCycleWindow | null,
): FantasyAssetCycleWindow {
  const rosterSlotId = getRosterSlotId(pick);
  const pickWindowCycleNumber = getPickWindowCycleNumber(pick, cycleNumber);
  const windowId = getWindowId(pick, pickWindowCycleNumber);
  const status = summary?.status ?? previous?.status ?? 'scheduled';
  const nowIso = new Date().toISOString();
  const startedAt =
    status === 'scheduled' ? (previous?.startedAt ?? null) : (previous?.startedAt ?? nowIso);
  const completedAt = status === 'complete' ? (previous?.completedAt ?? nowIso) : null;

  return {
    id: windowId,
    ownerId: pick.ownerId,
    rosterSlotId,
    cycleNumber: pickWindowCycleNumber,
    position: pick.asset.position,
    assetKey: pick.asset.assetKey,
    asset: pick.asset,
    status,
    scheduledGameIds: summary?.scheduledGameIds ?? normalizeNumberArray(previous?.scheduledGameIds),
    scheduledGameDates:
      summary?.scheduledGameDates ?? normalizeStringArray(previous?.scheduledGameDates),
    scheduledGameLabels:
      summary?.scheduledGameLabels ?? normalizeStringArray(previous?.scheduledGameLabels),
    completedGameIds: summary?.completedGameIds ?? normalizeNumberArray(previous?.completedGameIds),
    liveGameIds: summary?.liveGameIds ?? normalizeNumberArray(previous?.liveGameIds),
    appearanceGameIds:
      summary?.appearanceGameIds ?? normalizeNumberArray(previous?.appearanceGameIds),
    gameScores: summary?.gameScores ?? normalizeNumberRecord(previous?.gameScores),
    gameStates: summary?.gameStates ?? normalizeGameStateRecord(previous?.gameStates),
    scheduledGames: summary?.scheduledGames ?? previous?.scheduledGames ?? 0,
    gamesPlayed: summary?.gamesPlayed ?? previous?.gamesPlayed ?? 0,
    actualGamesPlayed: summary?.actualGamesPlayed ?? previous?.actualGamesPlayed ?? 0,
    gamesLeft: summary?.gamesLeft ?? previous?.gamesLeft ?? 0,
    fantasyPoints: summary?.currentScore ?? previous?.fantasyPoints ?? 0,
    frozenProjectionPoints:
      previous?.frozenProjectionPoints ?? getFrozenCycleProjection(pick.asset),
    frozenProjectionVersion:
      previous?.frozenProjectionVersion ?? pick.asset.frozenProjectionVersion ?? null,
    frozenProjectionSource:
      previous?.frozenProjectionSource ?? pick.asset.frozenProjectionSource ?? null,
    frozenProjectionSnapshotId:
      previous?.frozenProjectionSnapshotId ??
      pick.asset.frozenProjectionSnapshotId ??
      pick.asset.sharedProjectionSnapshotId ??
      null,
    frozenProjectionGeneratedAt:
      previous?.frozenProjectionGeneratedAt ??
      pick.asset.frozenProjectionGeneratedAt ??
      pick.asset.projectionGeneratedAt ??
      null,
    frozenProjectionFrozenAt:
      previous?.frozenProjectionFrozenAt ?? pick.asset.frozenProjectionFrozenAt ?? null,
    frozenProjectionTargetGameIds:
      summary?.scheduledGameIds ?? normalizeNumberArray(previous?.frozenProjectionTargetGameIds),
    firstScheduledGameDate:
      summary?.firstScheduledGameDate ?? previous?.firstScheduledGameDate ?? null,
    lastScheduledGameDate:
      summary?.lastScheduledGameDate ?? previous?.lastScheduledGameDate ?? null,
    startedAt,
    completedAt,
    createdAt: previous?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

function stableWindowFingerprint(teamWindows: FantasyTeamCycleWindows): string {
  return JSON.stringify({
    expectedRosterSlotIds: teamWindows.expectedRosterSlotIds,
    windows: teamWindows.windows.map((window) => ({
      id: window.id,
      assetKey: window.assetKey,
      status: window.status,
      scheduledGameIds: window.scheduledGameIds,
      scheduledGameDates: window.scheduledGameDates,
      scheduledGameLabels: window.scheduledGameLabels,
      completedGameIds: window.completedGameIds,
      liveGameIds: window.liveGameIds,
      appearanceGameIds: window.appearanceGameIds,
      gameScores: window.gameScores,
      gameStates: window.gameStates,
      scheduledGames: window.scheduledGames,
      gamesPlayed: window.gamesPlayed,
      actualGamesPlayed: window.actualGamesPlayed,
      gamesLeft: window.gamesLeft,
      fantasyPoints: window.fantasyPoints,
      frozenProjectionPoints: window.frozenProjectionPoints,
      frozenProjectionVersion: window.frozenProjectionVersion,
      frozenProjectionSource: window.frozenProjectionSource,
      frozenProjectionSnapshotId: window.frozenProjectionSnapshotId,
      frozenProjectionGeneratedAt: window.frozenProjectionGeneratedAt,
      frozenProjectionFrozenAt: window.frozenProjectionFrozenAt,
      frozenProjectionTargetGameIds: window.frozenProjectionTargetGameIds,
    })),
    completedWindowCount: teamWindows.completedWindowCount,
    totalWindowCount: teamWindows.totalWindowCount,
    status: teamWindows.status,
  });
}

export interface CycleTeamWindowSyncResult {
  writeCount: number;
  teamStatusByOwnerId: Record<string, AssetCycleWindowStatus>;
  completedOwnerIds: string[];
  newlyCompletedOwnerIds: string[];
  completionFingerprint: string;
}

export function isFantasyTeamCycleWindowsComplete(
  teamWindows: FantasyTeamCycleWindows | null | undefined,
): boolean {
  if (!teamWindows || teamWindows.expectedRosterSlotIds.length === 0) {
    return false;
  }

  const completedSlotIds = new Set(
    teamWindows.windows
      .filter((window) => window.status === 'complete')
      .map((window) => window.rosterSlotId),
  );

  return teamWindows.expectedRosterSlotIds.every((slotId) => completedSlotIds.has(slotId));
}

export function getFantasyTeamCycleWindowScore(
  teamWindows: FantasyTeamCycleWindows | null | undefined,
): number {
  if (!teamWindows) {
    return 0;
  }

  const expectedSlotIds = new Set(teamWindows.expectedRosterSlotIds);
  const scoreBySlotId = new Map<string, number>();

  for (const window of teamWindows.windows) {
    if (!expectedSlotIds.has(window.rosterSlotId)) {
      continue;
    }

    scoreBySlotId.set(
      window.rosterSlotId,
      Number.isFinite(window.fantasyPoints) ? window.fantasyPoints : 0,
    );
  }

  return [...scoreBySlotId.values()].reduce((total, score) => total + score, 0);
}

export function listenToCycleTeamWindows(
  leagueId: string,
  cycleNumber: number,
  callback: (teamWindows: FantasyTeamCycleWindows[]) => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    getTeamWindowsCollectionRef(leagueId, cycleNumber),
    (snapshot) => {
      callback(
        snapshot.docs
          .map((windowDocument) =>
            normalizeFantasyTeamCycleWindows(
              windowDocument.id,
              cycleNumber,
              windowDocument.data() as Partial<FantasyTeamCycleWindows>,
            ),
          )
          .sort((first, second) => first.ownerId.localeCompare(second.ownerId)),
      );
    },
    (error) => {
      const normalizedError =
        error instanceof Error ? error : new Error('Unable to load cycle-window progress.');

      if (onError) {
        onError(normalizedError);
        return;
      }

      console.error('Unable to load cycle-window progress.', error);
    },
  );
}

/**
 * Persists compact per-team slot-window documents. It reads one document per
 * team, compares meaningful data, and writes only teams whose window progress
 * actually changed.
 */
export async function syncCycleTeamWindows(
  leagueId: string,
  cycle: FantasyCycle,
  picks: DraftPick[],
  scoring: CycleScoringResult,
): Promise<CycleTeamWindowSyncResult> {
  const existingSnapshot = await getDocs(getTeamWindowsCollectionRef(leagueId, cycle.cycleNumber));
  const existingByOwnerId = new Map(
    existingSnapshot.docs.map(
      (snapshot) =>
        [
          snapshot.id,
          normalizeFantasyTeamCycleWindows(
            snapshot.id,
            cycle.cycleNumber,
            snapshot.data() as Partial<FantasyTeamCycleWindows>,
          ),
        ] as const,
    ),
  );

  const ownerIds = new Set<string>([
    ...Object.keys(cycle.expectedRosterSlotIdsByOwner ?? {}),
    ...picks.map((pick) => pick.ownerId),
  ]);
  const batch = writeBatch(db);
  let writeCount = 0;
  const teamStatusByOwnerId: Record<string, AssetCycleWindowStatus> = {};
  const completedOwnerIds: string[] = [];
  const newlyCompletedOwnerIds: string[] = [];

  for (const ownerId of ownerIds) {
    const ownerPicks = picks.filter((pick) => pick.ownerId === ownerId);
    const existing = existingByOwnerId.get(ownerId) ?? null;
    const previousByWindowId = new Map(
      (existing?.windows ?? []).map((window) => [window.id, window] as const),
    );
    const expectedRosterSlotIds =
      cycle.expectedRosterSlotIdsByOwner?.[ownerId] ?? ownerPicks.map(getRosterSlotId);
    const windows = ownerPicks
      .map((pick) => {
        const windowId = getWindowId(pick, getPickWindowCycleNumber(pick, cycle.cycleNumber));

        return buildWindow(
          pick,
          cycle.cycleNumber,
          getSummaryForPick(pick, cycle.cycleNumber, scoring),
          previousByWindowId.get(windowId) ?? null,
        );
      })
      .sort((first, second) => first.rosterSlotId.localeCompare(second.rosterSlotId));
    const completedSlotIds = new Set(
      windows.filter((window) => window.status === 'complete').map((window) => window.rosterSlotId),
    );
    const isComplete =
      expectedRosterSlotIds.length > 0 &&
      expectedRosterSlotIds.every((slotId) => completedSlotIds.has(slotId));
    const hasActiveWindow = windows.some((window) => window.status !== 'scheduled');
    const next: FantasyTeamCycleWindows = {
      id: ownerId,
      ownerId,
      cycleNumber: cycle.cycleNumber,
      expectedRosterSlotIds,
      windows,
      completedWindowCount: completedSlotIds.size,
      totalWindowCount: expectedRosterSlotIds.length,
      status: isComplete ? 'complete' : hasActiveWindow ? 'active' : 'scheduled',
      createdAt: existing?.createdAt ?? serverTimestamp(),
      updatedAt: serverTimestamp(),
      completedAt: isComplete ? (existing?.completedAt ?? serverTimestamp()) : null,
    };

    teamStatusByOwnerId[ownerId] = next.status;

    if (next.status === 'complete') {
      completedOwnerIds.push(ownerId);

      if (existing?.status !== 'complete') {
        newlyCompletedOwnerIds.push(ownerId);
      }
    }

    if (existing && stableWindowFingerprint(existing) === stableWindowFingerprint(next)) {
      continue;
    }

    writeCount += 1;
    batch.set(getCycleTeamWindowsRef(leagueId, cycle.cycleNumber, ownerId), next, { merge: true });
  }

  if (writeCount > 0) {
    await batch.commit();
  }

  const completionFingerprint = Object.entries(teamStatusByOwnerId)
    .sort(([firstOwnerId], [secondOwnerId]) => firstOwnerId.localeCompare(secondOwnerId))
    .map(([ownerId, status]) => `${ownerId}:${status === 'complete' ? 'complete' : 'pending'}`)
    .join('|');

  return {
    writeCount,
    teamStatusByOwnerId,
    completedOwnerIds: completedOwnerIds.sort(),
    newlyCompletedOwnerIds: newlyCompletedOwnerIds.sort(),
    completionFingerprint,
  };
}
