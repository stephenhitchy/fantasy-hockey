import { getDoc } from 'firebase/firestore';

import {
  getFantasyDraft,
  getOwnerWaiverClaimsOnce,
} from '../draft/draft.service';
import {
  getActiveLeagueCycles,
  getCycleMatchupsOnce,
  getLatestCycle,
} from '../cycle/cycle.service';
import {
  getCycleTeamWindowsRef,
  normalizeFantasyTeamCycleWindows,
} from '../cycle/asset-cycle-window.service';
import type { FantasyCycle, FantasyMatchup, FantasyTeamCycleWindows } from '../cycle/cycle.models';
import { getFantasyRosterOnce } from '../team/roster.service';
import type { FantasyTeam } from '../team/team.service';
import type {
  DashboardLeagueActivity,
  DashboardNhlRosterEntry,
  DashboardNhlRosterGameContextRefresh,
} from './dashboard-league-activity.models';
import { buildDashboardLeagueActivity } from './dashboard-league-activity.util';

export interface DashboardLeagueActivityRequest {
  leagueId: string;
  ownerId: string;
  isCommissioner: boolean;
  teamCount: number;
  maxTeams: number;
  teams: FantasyTeam[];
}

async function getOwnerMatchupAcrossActiveCycles(
  leagueId: string,
  ownerId: string,
  cycles: FantasyCycle[],
): Promise<FantasyMatchup | null> {
  const orderedCycles = [...cycles].sort(
    (first, second) => first.cycleNumber - second.cycleNumber,
  );
  const matchupGroups = await Promise.all(
    orderedCycles.map(async (cycle) => ({
      cycle,
      matchups: await getCycleMatchupsOnce(leagueId, cycle.cycleNumber),
    })),
  );

  const ownerMatchups = matchupGroups
    .flatMap(({ cycle, matchups }) =>
      matchups
        .filter(
          (matchup) =>
            matchup.teamAOwnerId === ownerId || matchup.teamBOwnerId === ownerId,
        )
        .map((matchup) => ({ cycleNumber: cycle.cycleNumber, matchup })),
    )
    .sort((first, second) => {
      if (first.cycleNumber !== second.cycleNumber) {
        return first.cycleNumber - second.cycleNumber;
      }

      return first.matchup.id.localeCompare(second.matchup.id);
    });

  return (
    ownerMatchups.find(({ matchup }) => matchup.status !== 'complete')?.matchup ??
    ownerMatchups.at(-1)?.matchup ??
    null
  );
}

async function getTeamWindows(
  leagueId: string,
  cycleNumber: number,
  ownerId: string | null,
): Promise<FantasyTeamCycleWindows | null> {
  if (!ownerId) {
    return null;
  }

  const snapshot = await getDoc(getCycleTeamWindowsRef(leagueId, cycleNumber, ownerId));

  if (!snapshot.exists()) {
    return null;
  }

  return normalizeFantasyTeamCycleWindows(ownerId, cycleNumber, snapshot.data());
}

export async function refreshDashboardNhlRosterGameContexts(
  entries: readonly DashboardNhlRosterEntry[],
): Promise<DashboardNhlRosterGameContextRefresh> {
  const requests = new Map<string, {
    leagueId: string;
    ownerId: string;
    cycleNumber: number;
    entries: DashboardNhlRosterEntry[];
  }>();

  for (const entry of entries) {
    const cycleNumber = entry.matchupCycleNumber;

    if (!entry.ownerId || cycleNumber === null) {
      continue;
    }

    const key = `${entry.leagueId}\u0000${entry.ownerId}\u0000${cycleNumber}`;
    const request = requests.get(key) ?? {
      leagueId: entry.leagueId,
      ownerId: entry.ownerId,
      cycleNumber,
      entries: [],
    };
    request.entries.push(entry);
    requests.set(key, request);
  }

  const results = await Promise.all(
    [...requests.values()].map(async (request) => {
      try {
        const windows = await getTeamWindows(
          request.leagueId,
          request.cycleNumber,
          request.ownerId,
        );

        return {
          request,
          windows,
          failed: false,
        } as const;
      } catch {
        return {
          request,
          windows: null,
          failed: true,
        } as const;
      }
    }),
  );
  const failedLeagueIds = new Set<string>();
  const contexts: DashboardNhlRosterGameContextRefresh['contexts'] = [];

  for (const result of results) {
    if (result.failed) {
      failedLeagueIds.add(result.request.leagueId);
      continue;
    }

    for (const entry of result.request.entries) {
      const assetWindow = result.windows?.windows.find(
        (window) => window.assetKey === entry.assetKey,
      );

      contexts.push({
        leagueId: entry.leagueId,
        cycleNumber: result.request.cycleNumber,
        assetKey: entry.assetKey,
        scheduledGameIds: assetWindow?.scheduledGameIds ?? [],
        gameScores: assetWindow?.gameScores ?? {},
      });
    }
  }

  return {
    contexts,
    failedLeagueIds: [...failedLeagueIds].sort(),
  };
}

export async function getDashboardLeagueActivity(
  request: DashboardLeagueActivityRequest,
): Promise<DashboardLeagueActivity> {
  try {
    const draft = await getFantasyDraft(request.leagueId);

    if (!draft || draft.status !== 'complete') {
      return buildDashboardLeagueActivity({
        ...request,
        draft,
        latestCycle: null,
        matchup: null,
        myWindows: null,
        opponentWindows: null,
        roster: null,
        waiverClaims: [],
      });
    }

    const [activeCycles, latestCycle, roster, waiverClaims] = await Promise.all([
      getActiveLeagueCycles(request.leagueId),
      getLatestCycle(request.leagueId),
      getFantasyRosterOnce(request.leagueId, request.ownerId),
      getOwnerWaiverClaimsOnce(request.leagueId, request.ownerId, 12).catch(() => []),
    ]);
    const matchup = await getOwnerMatchupAcrossActiveCycles(
      request.leagueId,
      request.ownerId,
      activeCycles,
    );

    let myWindows: FantasyTeamCycleWindows | null = null;
    let opponentWindows: FantasyTeamCycleWindows | null = null;

    if (matchup) {
      const opponentOwnerId = matchup.teamAOwnerId === request.ownerId
        ? matchup.teamBOwnerId
        : matchup.teamAOwnerId;

      [myWindows, opponentWindows] = await Promise.all([
        getTeamWindows(request.leagueId, matchup.cycleNumber, request.ownerId),
        getTeamWindows(request.leagueId, matchup.cycleNumber, opponentOwnerId),
      ]);
    }

    return buildDashboardLeagueActivity({
      ...request,
      draft,
      latestCycle,
      matchup,
      myWindows,
      opponentWindows,
      roster,
      waiverClaims,
    });
  } catch {
    return {
      stage: 'season-preparing',
      statusLabel: 'League Ready',
      tone: 'neutral',
      headline: 'Open your league',
      detail: 'The activity summary is still reconnecting, but your league remains available.',
      primaryActionLabel: 'Open League HQ',
      primaryActionRoute: ['/leagues', request.leagueId],
      injuredStarterCount: 0,
      queuedMoveCount: 0,
      boundarySlotCount: 0,
      nhlTeamRosterCounts: [],
      recentWaiverOutcome: null,
      matchup: null,
    };
  }
}
