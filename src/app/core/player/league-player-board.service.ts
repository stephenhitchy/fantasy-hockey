import { type DraftableAsset } from '../draft/draft.models';
import {
  getFantasyDraft,
  getPublicLeagueWaiversOnce,
} from '../draft/draft.service';
import { getLeagueById, type League } from '../league/league.service';
import {
  loadSharedProjectionSnapshot,
  loadSharedProjectionSnapshotById,
  loadSharedProjectionSnapshotFresh,
  type SharedProjectionSnapshotMetadata,
} from '../projection/projection-snapshot.service';
import {
  getFantasyRosterOnce,
} from '../team/roster.service';
import { type FantasyRoster } from '../team/roster.models';
import { getLeagueTeams, type FantasyTeam } from '../team/team.service';
import {
  buildLeaguePlayerOwnership,
  buildLeaguePlayerReservedAssetKeys,
  type LeaguePlayerOwnership,
} from './league-player-board.util';

const LEAGUE_PLAYER_BOARD_CACHE_MILLISECONDS = 30_000;

interface LeaguePlayerBoardCacheEntry {
  expiresAt: number;
  promise: Promise<LeaguePlayerBoardBaseData>;
}

const leaguePlayerBoardCache = new Map<string, LeaguePlayerBoardCacheEntry>();

export interface LoadLeaguePlayerBoardOptions {
  forceRefresh?: boolean;
}

export interface LeaguePlayerBoardBaseData {
  league: League;
  teams: FantasyTeam[];
  assets: DraftableAsset[];
  snapshotMetadata: SharedProjectionSnapshotMetadata;
  ownershipByAssetKey: Map<string, LeaguePlayerOwnership>;
  reservedAssetKeys: Set<string>;
}


async function loadBestProjectionSnapshot(leagueId: string, forceRefresh = false) {
  const current = await (forceRefresh
    ? loadSharedProjectionSnapshotFresh(leagueId)
    : loadSharedProjectionSnapshot(leagueId));
  if (current) {
    return current;
  }

  const draft = await getFantasyDraft(leagueId);
  const pinnedSnapshotId = draft?.serverDraftProjectionSnapshotId?.trim();

  return pinnedSnapshotId
    ? loadSharedProjectionSnapshotById(leagueId, pinnedSnapshotId)
    : null;
}

async function fetchLeaguePlayerBoardBaseData(
  leagueId: string,
  forceRefresh = false,
): Promise<LeaguePlayerBoardBaseData> {
  const [league, teams, snapshot] = await Promise.all([
    getLeagueById(leagueId),
    getLeagueTeams(leagueId),
    loadBestProjectionSnapshot(leagueId, forceRefresh),
  ]);

  if (!league) {
    throw new Error('League not found.');
  }

  if (!snapshot) {
    throw new Error('Player rankings are not ready for this league yet.');
  }

  const rosterEntries = await Promise.all(
    teams.map(async (team) => [
      team.ownerId,
      await getFantasyRosterOnce(leagueId, team.ownerId),
    ] as const),
  );
  const rostersByOwnerId = new Map<string, FantasyRoster | null>(rosterEntries);

  return {
    league,
    teams,
    assets: snapshot.assets,
    snapshotMetadata: snapshot.metadata,
    ownershipByAssetKey: buildLeaguePlayerOwnership(teams, rostersByOwnerId),
    reservedAssetKeys: buildLeaguePlayerReservedAssetKeys(rostersByOwnerId),
  };
}

export function loadLeaguePlayerBoardBaseData(
  leagueId: string,
  options: LoadLeaguePlayerBoardOptions = {},
): Promise<LeaguePlayerBoardBaseData> {
  const normalizedLeagueId = leagueId.trim();
  if (!normalizedLeagueId) {
    return Promise.reject(new Error('League not found.'));
  }

  if (options.forceRefresh) {
    leaguePlayerBoardCache.delete(normalizedLeagueId);
  }

  const cached = leaguePlayerBoardCache.get(normalizedLeagueId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = fetchLeaguePlayerBoardBaseData(normalizedLeagueId, options.forceRefresh === true).catch((error) => {
    leaguePlayerBoardCache.delete(normalizedLeagueId);
    throw error;
  });

  leaguePlayerBoardCache.set(normalizedLeagueId, {
    expiresAt: Date.now() + LEAGUE_PLAYER_BOARD_CACHE_MILLISECONDS,
    promise,
  });

  return promise;
}

export async function loadLeagueWaiverAssetKeysOnce(
  leagueId: string,
): Promise<Set<string>> {
  const waivers = await getPublicLeagueWaiversOnce(leagueId);
  return new Set(
    waivers
      .filter((waiver) => waiver.status === 'active')
      .map((waiver) => waiver.assetKey)
      .filter((assetKey): assetKey is string => typeof assetKey === 'string' && Boolean(assetKey)),
  );
}
