import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
} from 'firebase/firestore';

import { db } from '../firebase';
import {
  getCycleTeamWindowsRef,
  normalizeFantasyTeamCycleWindows,
} from '../cycle/asset-cycle-window.service';
import type { AssetCycleWindowStatus } from '../cycle/cycle.models';
import type { DraftableAsset } from '../draft/draft.models';
import type { ActiveRosterSlot, RosterAsset } from '../team/roster.models';
import {
  resolveRosterMoveAssetCycleEligibility,
} from './roster-move-eligibility.service';
import {
  resolveActiveBenchSwapTimingPreview,
  type ActiveBenchSwapTimingPreview,
} from './active-bench-swap-timing.util';

interface ActiveSlotWindowEvidence {
  cycleNumber: number;
  status: AssetCycleWindowStatus;
  scheduledGames: number;
  gamesPlayed: number;
  actualGamesPlayed: number;
  fantasyPoints: number;
  completedGameIds: number[];
  liveGameIds: number[];
  appearanceGameIds: number[];
}

export interface PreviewActiveBenchSwapTimingInput {
  leagueId: string;
  ownerId: string;
  activeSlot: ActiveRosterSlot;
  benchAsset: RosterAsset;
  requiredGamesPerCycle: number;
}

function getRosterAssetKey(asset: RosterAsset): string {
  if (asset.assetKey) {
    return asset.assetKey;
  }

  return asset.assetType === 'skater'
    ? `skater-${asset.player.id}`
    : `goalie-unit-${asset.teamAbbreviation}`;
}

function rosterAssetToDraftableAsset(asset: RosterAsset): DraftableAsset {
  if (asset.assetType === 'skater') {
    return {
      assetType: 'skater',
      assetKey: getRosterAssetKey(asset),
      position: asset.position,
      player: asset.player,
    };
  }

  return {
    assetType: 'team-goalie-unit',
    assetKey: getRosterAssetKey(asset),
    position: 'G',
    teamName: asset.teamName,
    teamAbbreviation: asset.teamAbbreviation,
    teamLogoUrl: asset.teamLogoUrl,
  };
}

function getCycleRosterSlotPickRef(
  leagueId: string,
  cycleNumber: number,
  ownerId: string,
  rosterSlotId: string,
) {
  const documentId = `${ownerId}__${rosterSlotId}`.replace(/[^a-zA-Z0-9_-]/g, '-');

  return doc(
    db,
    'leagues',
    leagueId,
    'cycles',
    `cycle-${cycleNumber}`,
    'rosterPicks',
    documentId,
  );
}

async function loadLatestActiveSlotWindow(
  leagueId: string,
  ownerId: string,
  rosterSlotId: string,
): Promise<ActiveSlotWindowEvidence | null> {
  const cyclesSnapshot = await getDocs(
    query(
      collection(db, 'leagues', leagueId, 'cycles'),
      orderBy('cycleNumber', 'desc'),
    ),
  );

  for (const cycleDocument of cyclesSnapshot.docs) {
    const cycleData = cycleDocument.data() as {
      cycleNumber?: unknown;
      status?: unknown;
    };

    if (cycleData.status !== 'active' || typeof cycleData.cycleNumber !== 'number') {
      continue;
    }

    const cycleNumber = cycleData.cycleNumber;
    const [teamWindowsSnapshot, rosterPickSnapshot] = await Promise.all([
      getDoc(getCycleTeamWindowsRef(leagueId, cycleNumber, ownerId)),
      getDoc(getCycleRosterSlotPickRef(leagueId, cycleNumber, ownerId, rosterSlotId)),
    ]);

    if (teamWindowsSnapshot.exists()) {
      const window = normalizeFantasyTeamCycleWindows(
        ownerId,
        cycleNumber,
        teamWindowsSnapshot.data(),
      ).windows.find((candidate) => candidate.rosterSlotId === rosterSlotId);

      if (window) {
        return {
          cycleNumber: window.cycleNumber,
          status: window.status,
          scheduledGames: window.scheduledGames,
          gamesPlayed: window.gamesPlayed,
          actualGamesPlayed: window.actualGamesPlayed,
          fantasyPoints: window.fantasyPoints,
          completedGameIds: window.completedGameIds,
          liveGameIds: window.liveGameIds,
          appearanceGameIds: window.appearanceGameIds,
        };
      }
    }

    // A current roster pick can exist briefly before its materialized scoring
    // window. It is still authoritative evidence that this slot is untouched.
    if (rosterPickSnapshot.exists()) {
      return {
        cycleNumber,
        status: 'scheduled',
        scheduledGames: 0,
        gamesPlayed: 0,
        actualGamesPlayed: 0,
        fantasyPoints: 0,
        completedGameIds: [],
        liveGameIds: [],
        appearanceGameIds: [],
      };
    }
  }

  return null;
}

function isUntouchedWindow(window: ActiveSlotWindowEvidence | null): boolean {
  return Boolean(
    window &&
    window.gamesPlayed === 0 &&
    window.actualGamesPlayed === 0 &&
    window.fantasyPoints === 0 &&
    window.completedGameIds.length === 0 &&
    window.liveGameIds.length === 0 &&
    window.appearanceGameIds.length === 0,
  );
}

/**
 * Produces read-only confirmation copy from the same persisted window and NHL
 * schedule facts used by roster moves. This never authorizes a write; the
 * existing roster action independently re-reads and validates those facts.
 */
export async function previewActiveBenchSwapTiming({
  leagueId,
  ownerId,
  activeSlot,
  benchAsset,
  requiredGamesPerCycle,
}: PreviewActiveBenchSwapTimingInput): Promise<ActiveBenchSwapTimingPreview> {
  const gamesPerCycle = Number.isFinite(requiredGamesPerCycle)
    ? Math.max(1, Math.floor(requiredGamesPerCycle))
    : 6;
  const [benchEligibility, currentWindow] = await Promise.all([
    resolveRosterMoveAssetCycleEligibility(
      rosterAssetToDraftableAsset(benchAsset),
      gamesPerCycle,
    ),
    loadLatestActiveSlotWindow(leagueId, ownerId, activeSlot.slotId),
  ]);

  if (activeSlot.asset && !currentWindow) {
    throw new Error(
      'The active player’s current matchup window is not available yet. Refresh and try again.',
    );
  }

  const immediateCycleNumber = currentWindow?.cycleNumber ?? activeSlot.openFromCycleNumber ?? null;
  const activeAssignmentUntouched =
    isUntouchedWindow(currentWindow) ||
    (!currentWindow && !activeSlot.asset && typeof activeSlot.openFromCycleNumber === 'number');
  const benchEarliestCycleNumber = Math.max(
    benchAsset.eligibleFromCycleNumber ?? 1,
    benchEligibility.earliestEligibleCycleNumber,
  );

  return resolveActiveBenchSwapTimingPreview({
    activeCycleNumber: currentWindow?.cycleNumber ?? activeSlot.openFromCycleNumber ?? null,
    activeFinalGames: currentWindow?.gamesPlayed ?? 0,
    activeLiveGames: currentWindow?.liveGameIds.length ?? 0,
    activeScheduledGames: currentWindow?.scheduledGames || gamesPerCycle,
    activeWindowStatus: currentWindow?.status ?? null,
    activeAssignmentUntouched,
    immediateCycleNumber,
    openFromCycleNumber: activeSlot.openFromCycleNumber ?? null,
    benchCurrentCycleNumber: benchEligibility.currentCycleNumber,
    benchFinalGames: benchEligibility.completedGamesInCurrentCycle,
    benchLiveGames: benchEligibility.liveGamesInCurrentCycle,
    benchScheduledGames: benchEligibility.scheduledGamesInCurrentCycle,
    benchCurrentCycleHasStarted: benchEligibility.currentCycleHasStarted,
    benchEarliestCycleNumber,
  });
}
