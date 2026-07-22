import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  where,
  Transaction,
  serverTimestamp,
  writeBatch,
} from '../firebase-admin-compat';

import { db } from '../firebase';

import { FantasyCycle, FantasyMatchup } from './cycle.models';

import { CycleScoringResult } from './cycle-scoring.service';

import {
  getCycleTeamWindowsRef,
  getFantasyTeamCycleWindowScore,
  isFantasyTeamCycleWindowsComplete,
  normalizeFantasyTeamCycleWindows,
} from './asset-cycle-window.service';

import { FantasyTeam } from '../team/team.service';

import { DraftableAsset, DraftPick, DraftProjection, FantasyDraft } from '../draft/draft.models';

import { FantasyRoster, PendingRosterSlotMove, RosterAsset } from '../team/roster.models';

import { normalizeFantasyRoster } from '../team/roster.service';

import {
  getPlayoffRoundLabel,
  getStandardRegularSeasonCycleCount,
} from '../playoffs/playoff-format';

import {
  applyPlayoffRoundResults,
  assignPlayoffRoundWindows,
  createStandardFantasyPlayoffs,
  getFantasyPlayoffsRef,
  getPlayoffRoundMatchups,
  getPlayoffRoundOwnerIds,
  normalizeFantasyPlayoffs,
} from '../playoffs/playoff.service';

import { FantasyPlayoffRoundResult, FantasyPlayoffs } from '../playoffs/playoff.models';

import {
  createInitialPlayoffBankPayloads,
  getAllPlayoffWindowBanks,
  getEarliestUnassignedPlayoffWindow,
  getPlayoffWindowBankRef,
} from '../playoffs/playoff-window-bank.service';

import { FantasyPlayoffWindowBank } from '../playoffs/playoff-window-bank.models';

import { getRawCycleProjection } from '../projection/cycle-projection.util';

import {
  createFrozenWindowProjectionFields,
  ensureWindowProjectionBundle,
  FrozenWindowProjectionFields,
} from '../projection/window-projection.service';

import { defaultScoringRules } from '../scoring/scoring-rules';

const FIRST_CYCLE_NUMBER = 1;

function reportCycleListenerError(
  error: unknown,
  fallbackMessage: string,
  onError?: (error: Error) => void,
): void {
  const normalizedError = error instanceof Error ? error : new Error(fallbackMessage);

  if (onError) {
    onError(normalizedError);
    return;
  }

  console.error(fallbackMessage, error);
}

interface CyclePairing {
  teamAOwnerId: string;
  teamBOwnerId: string | null;
}

export interface CycleSchedulePreviewMatchup {
  id: string;
  teamAOwnerId: string;
  teamBOwnerId: string | null;
}

export interface CycleSchedulePreviewCycle {
  cycleNumber: number;
  matchups: CycleSchedulePreviewMatchup[];
}

export interface CycleMatchupCompletionResult {
  newlyCompletedMatchupIds: string[];
  completedMatchupCount: number;
  totalMatchupCount: number;
  pendingMatchupCount: number;
  cycleCompleted: boolean;
}

function getCycleDocumentId(cycleNumber: number): string {
  return `cycle-${cycleNumber}`;
}

function getCycleRef(leagueId: string, cycleNumber: number) {
  return doc(db, 'leagues', leagueId, 'cycles', getCycleDocumentId(cycleNumber));
}

function getDraftRef(leagueId: string) {
  return doc(db, 'leagues', leagueId, 'draft', 'current');
}

function getDraftPicksRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'draft', 'current', 'picks');
}

function getDraftPickDocumentId(overallPick: number): string {
  return overallPick.toString().padStart(3, '0');
}

function getTeamRef(leagueId: string, ownerId: string) {
  return doc(db, 'leagues', leagueId, 'teams', ownerId);
}

function getTeamRosterRef(leagueId: string, ownerId: string) {
  return doc(db, 'leagues', leagueId, 'teams', ownerId, 'roster', 'current');
}

function getWaiverRef(leagueId: string, waiverId: string) {
  return doc(db, 'leagues', leagueId, 'waivers', waiverId);
}

function getTransactionsRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'transactions');
}

function getCyclesRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'cycles');
}

function getCycleMatchupsRef(leagueId: string, cycleNumber: number) {
  return collection(db, 'leagues', leagueId, 'cycles', getCycleDocumentId(cycleNumber), 'matchups');
}

function getCycleMatchupRef(leagueId: string, cycleNumber: number, matchupId: string) {
  return doc(
    db,
    'leagues',
    leagueId,
    'cycles',
    getCycleDocumentId(cycleNumber),
    'matchups',
    matchupId,
  );
}

function getCycleRosterPicksRef(leagueId: string, cycleNumber: number) {
  return collection(
    db,
    'leagues',
    leagueId,
    'cycles',
    getCycleDocumentId(cycleNumber),
    'rosterPicks',
  );
}

function getCycleRosterPickRef(leagueId: string, cycleNumber: number, overallPick: number) {
  return doc(
    db,
    'leagues',
    leagueId,
    'cycles',
    getCycleDocumentId(cycleNumber),
    'rosterPicks',
    getDraftPickDocumentId(overallPick),
  );
}

function getCycleRosterSlotPickDocumentId(ownerId: string, rosterSlotId: string): string {
  return `${ownerId}__${rosterSlotId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function getCycleRosterSlotPickRef(
  leagueId: string,
  cycleNumber: number,
  ownerId: string,
  rosterSlotId: string,
) {
  return doc(
    getCycleRosterPicksRef(leagueId, cycleNumber),
    getCycleRosterSlotPickDocumentId(ownerId, rosterSlotId),
  );
}

function getRosterSlotIdFromPick(pick: DraftPick): string {
  return pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`;
}

function getCycleWindowId(ownerId: string, rosterSlotId: string, cycleNumber: number): string {
  return `${ownerId}__${rosterSlotId}__cycle-${cycleNumber}`;
}

function buildExpectedRosterSlotIdsByOwner(picks: DraftPick[]): Record<string, string[]> {
  const slotsByOwnerId: Record<string, string[]> = {};

  for (const pick of picks) {
    const slotId = getRosterSlotIdFromPick(pick);
    slotsByOwnerId[pick.ownerId] ??= [];

    if (!slotsByOwnerId[pick.ownerId].includes(slotId)) {
      slotsByOwnerId[pick.ownerId].push(slotId);
    }
  }

  for (const slotIds of Object.values(slotsByOwnerId)) {
    slotIds.sort();
  }

  return slotsByOwnerId;
}

function countExpectedWindows(expectedRosterSlotIdsByOwner: Record<string, string[]>): number {
  return Object.values(expectedRosterSlotIdsByOwner).reduce(
    (total, slotIds) => total + slotIds.length,
    0,
  );
}

function normalizeCycle(
  data: Partial<FantasyCycle>,
  fallbackCycleNumber: number = FIRST_CYCLE_NUMBER,
): FantasyCycle {
  return {
    id: data.id ?? getCycleDocumentId(fallbackCycleNumber),
    cycleNumber: data.cycleNumber ?? fallbackCycleNumber,
    status: data.status ?? 'active',
    phase: data.phase === 'playoffs' ? 'playoffs' : 'regular_season',
    playoffRoundNumber:
      typeof data.playoffRoundNumber === 'number' ? data.playoffRoundNumber : null,
    playoffRoundCount: typeof data.playoffRoundCount === 'number' ? data.playoffRoundCount : null,
    playoffRoundLabel: typeof data.playoffRoundLabel === 'string' ? data.playoffRoundLabel : null,
    matchupIds: Array.isArray(data.matchupIds) ? data.matchupIds : [],
    windowSchemaVersion:
      typeof data.windowSchemaVersion === 'number' ? data.windowSchemaVersion : 0,
    expectedRosterSlotIdsByOwner:
      data.expectedRosterSlotIdsByOwner && typeof data.expectedRosterSlotIdsByOwner === 'object'
        ? data.expectedRosterSlotIdsByOwner
        : {},
    parentCycleNumber: typeof data.parentCycleNumber === 'number' ? data.parentCycleNumber : null,
    overlapsPreviousCycle: data.overlapsPreviousCycle === true,
    bankedPlayoffWindowsEnabled: data.bankedPlayoffWindowsEnabled === true,
    totalExpectedWindowCount:
      typeof data.totalExpectedWindowCount === 'number' ? data.totalExpectedWindowCount : 0,
    activeWindowCount: typeof data.activeWindowCount === 'number' ? data.activeWindowCount : 0,
    completedWindowCount:
      typeof data.completedWindowCount === 'number' ? data.completedWindowCount : 0,
    matchupCompletionSchemaVersion:
      typeof data.matchupCompletionSchemaVersion === 'number'
        ? data.matchupCompletionSchemaVersion
        : 0,
    totalMatchupCount:
      typeof data.totalMatchupCount === 'number'
        ? data.totalMatchupCount
        : Array.isArray(data.matchupIds)
          ? data.matchupIds.length
          : 0,
    completedMatchupCount:
      typeof data.completedMatchupCount === 'number' ? data.completedMatchupCount : 0,
    pendingMatchupCount:
      typeof data.pendingMatchupCount === 'number'
        ? data.pendingMatchupCount
        : Math.max(
            0,
            (typeof data.totalMatchupCount === 'number'
              ? data.totalMatchupCount
              : Array.isArray(data.matchupIds)
                ? data.matchupIds.length
                : 0) -
              (typeof data.completedMatchupCount === 'number' ? data.completedMatchupCount : 0),
          ),
    lastMatchupCompletedAt: data.lastMatchupCompletedAt ?? null,
    standingsAppliedAt: data.standingsAppliedAt ?? null,
    projectionAccuracyStatus: data.projectionAccuracyStatus === 'complete' ? 'complete' : 'pending',
    projectionAccuracyAssetCount:
      typeof data.projectionAccuracyAssetCount === 'number' ? data.projectionAccuracyAssetCount : 0,
    projectionAccuracyProjectionVersions: Array.isArray(data.projectionAccuracyProjectionVersions)
      ? data.projectionAccuracyProjectionVersions.filter(
          (value): value is number => typeof value === 'number',
        )
      : [],
    projectionAccuracyUpdatedAt: data.projectionAccuracyUpdatedAt ?? null,
    startedAt: data.startedAt,
    completedAt: data.completedAt ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

function normalizeMatchup(data: Partial<FantasyMatchup>): FantasyMatchup {
  return {
    id: data.id ?? '',
    cycleNumber: data.cycleNumber ?? FIRST_CYCLE_NUMBER,
    phase: data.phase === 'playoffs' ? 'playoffs' : 'regular_season',
    bracketType:
      data.bracketType === 'consolation'
        ? 'consolation'
        : data.bracketType === 'championship'
          ? 'championship'
          : null,
    playoffRoundNumber:
      typeof data.playoffRoundNumber === 'number' ? data.playoffRoundNumber : null,
    playoffMatchupId: typeof data.playoffMatchupId === 'string' ? data.playoffMatchupId : null,
    teamASeed: typeof data.teamASeed === 'number' ? data.teamASeed : null,
    teamBSeed: typeof data.teamBSeed === 'number' ? data.teamBSeed : null,
    teamAWindowNumber: typeof data.teamAWindowNumber === 'number' ? data.teamAWindowNumber : null,
    teamBWindowNumber: typeof data.teamBWindowNumber === 'number' ? data.teamBWindowNumber : null,
    teamAWindowCycleNumber:
      typeof data.teamAWindowCycleNumber === 'number' ? data.teamAWindowCycleNumber : null,
    teamBWindowCycleNumber:
      typeof data.teamBWindowCycleNumber === 'number' ? data.teamBWindowCycleNumber : null,
    winnerPlace: typeof data.winnerPlace === 'number' ? data.winnerPlace : null,
    loserPlace: typeof data.loserPlace === 'number' ? data.loserPlace : null,
    tieBrokenByHigherSeed: data.tieBrokenByHigherSeed === true,
    teamAOwnerId: data.teamAOwnerId ?? '',
    teamBOwnerId: data.teamBOwnerId ?? null,
    teamAScore: typeof data.teamAScore === 'number' ? data.teamAScore : 0,
    teamBScore: typeof data.teamBScore === 'number' ? data.teamBScore : 0,
    winnerOwnerId: data.winnerOwnerId ?? null,
    status: data.status ?? 'active',
    completedAt: data.completedAt ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

function getRosterAssetKey(asset: RosterAsset | null): string {
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

  return asset.teamAbbreviation ? `goalie-unit-${asset.teamAbbreviation}` : '';
}

function getStoredProjectionFields(asset: DraftableAsset | RosterAsset): DraftProjection {
  const projection = asset as DraftProjection;

  return {
    projectedSeasonPoints: projection.projectedSeasonPoints ?? null,
    projectedCyclePoints: projection.projectedCyclePoints ?? null,
    frozenCycleProjectionPoints: projection.frozenCycleProjectionPoints ?? null,
    frozenProjectionCycleNumber: projection.frozenProjectionCycleNumber ?? null,
    frozenProjectionSource: projection.frozenProjectionSource ?? null,
    frozenProjectionVersion: projection.frozenProjectionVersion ?? null,
    frozenProjectionSnapshotId: projection.frozenProjectionSnapshotId ?? null,
    frozenProjectionGeneratedAt: projection.frozenProjectionGeneratedAt ?? null,
    frozenProjectionFrozenAt: projection.frozenProjectionFrozenAt ?? null,
    seasonBaselineCyclePoints: projection.seasonBaselineCyclePoints ?? null,
    recentFormAdjustment: projection.recentFormAdjustment ?? null,
    roleAdjustment: projection.roleAdjustment ?? null,
    scheduleStrengthAdjustment: projection.scheduleStrengthAdjustment ?? null,
    scheduleStrengthMultiplier: projection.scheduleStrengthMultiplier ?? null,
    scheduleDifficultyRating: projection.scheduleDifficultyRating ?? null,
    scheduleDifficultyLabel: projection.scheduleDifficultyLabel ?? null,
    scheduleDataConfidence: projection.scheduleDataConfidence ?? null,
    projectionHomeGames: projection.projectionHomeGames ?? null,
    projectionRoadGames: projection.projectionRoadGames ?? null,
    projectionBackToBackGames: projection.projectionBackToBackGames ?? null,
    projectionRestAdvantageGames: projection.projectionRestAdvantageGames ?? null,
    projectionOpponentAbbreviations: projection.projectionOpponentAbbreviations ?? null,
    projectionDataSeason: projection.projectionDataSeason ?? null,
    projectionDataSource: projection.projectionDataSource ?? null,
    projectionGamesPlayed: projection.projectionGamesPlayed ?? null,
    recentFormSampleSize: projection.recentFormSampleSize ?? null,
    seasonFantasyPointsPerGame: projection.seasonFantasyPointsPerGame ?? null,
    recentThreeGameFantasyPointsPerGame: projection.recentThreeGameFantasyPointsPerGame ?? null,
    recentFiveGameFantasyPointsPerGame: projection.recentFiveGameFantasyPointsPerGame ?? null,
    recentTenGameFantasyPointsPerGame: projection.recentTenGameFantasyPointsPerGame ?? null,
    recentTwentyGameFantasyPointsPerGame: projection.recentTwentyGameFantasyPointsPerGame ?? null,
    draftProjectedSeasonPoints: projection.draftProjectedSeasonPoints ?? null,
    draftProjectedCyclePoints: projection.draftProjectedCyclePoints ?? null,
    draftRecentTrendAdjustment: projection.draftRecentTrendAdjustment ?? null,
    draftRoleAdjustment: projection.draftRoleAdjustment ?? null,
    draftReliabilityRating: projection.draftReliabilityRating ?? null,
    draftVolatilityPenalty: projection.draftVolatilityPenalty ?? null,
    draftFloorAdjustedCyclePoints: projection.draftFloorAdjustedCyclePoints ?? null,
    draftValueAboveReplacement: projection.draftValueAboveReplacement ?? null,
    draftScore: projection.draftScore ?? null,
    draftRank: projection.draftRank ?? null,
    draftPositionRank: projection.draftPositionRank ?? null,
    cycleValueAboveReplacement: projection.cycleValueAboveReplacement ?? null,
    cycleScore: projection.cycleScore ?? null,
    cycleRank: projection.cycleRank ?? null,
    cyclePositionRank: projection.cyclePositionRank ?? null,
    seasonAverageTimeOnIceMinutes: projection.seasonAverageTimeOnIceMinutes ?? null,
    recentAverageTimeOnIceMinutes: projection.recentAverageTimeOnIceMinutes ?? null,
    actualRecentAppearances: projection.actualRecentAppearances ?? null,
    missedRecentTeamGames: projection.missedRecentTeamGames ?? null,
    weightedRecentAppearances: projection.weightedRecentAppearances ?? null,
    fullWeightRecentGames: projection.fullWeightRecentGames ?? null,
    partialWeightRecentGames: projection.partialWeightRecentGames ?? null,
    healthyProjectedCyclePoints: projection.healthyProjectedCyclePoints ?? null,
    scheduledGamesInProjectionCycle: projection.scheduledGamesInProjectionCycle ?? null,
    expectedGamesAvailable: projection.expectedGamesAvailable ?? null,
    expectedGamesMissed: projection.expectedGamesMissed ?? null,
    availabilityAdjustment: projection.availabilityAdjustment ?? null,
    availabilityAdjustedCyclePoints: projection.availabilityAdjustedCyclePoints ?? null,
    availabilityStatus: projection.availabilityStatus ?? null,
    availabilityLabel: projection.availabilityLabel ?? null,
    availabilityReturnDate: projection.availabilityReturnDate ?? null,
    availabilityNote: projection.availabilityNote ?? null,
    availabilityAsOf: projection.availabilityAsOf ?? null,
    targetProjectionCycleNumber: projection.targetProjectionCycleNumber ?? null,
    sharedProjectionSnapshotId: projection.sharedProjectionSnapshotId ?? null,
    projectionGeneratedAt: projection.projectionGeneratedAt ?? null,
    balancedDraftValue: projection.balancedDraftValue ?? null,
    balancedRank: projection.balancedRank ?? null,
    positionRank: projection.positionRank ?? null,
    reliabilityRating: projection.reliabilityRating ?? null,
    volatilityPenalty: projection.volatilityPenalty ?? null,
    floorAdjustedCyclePoints: projection.floorAdjustedCyclePoints ?? null,
    floorAdjustedDraftValue: projection.floorAdjustedDraftValue ?? null,
  };
}

function rosterAssetToDraftableAsset(asset: RosterAsset): DraftableAsset {
  const assetKey = getRosterAssetKey(asset);

  if (asset.assetType === 'skater') {
    return {
      assetType: 'skater',
      assetKey,
      position: asset.position,
      player: asset.player,
      ...getStoredProjectionFields(asset),
    };
  }

  return {
    assetType: 'team-goalie-unit',
    assetKey,
    position: 'G',
    teamName: asset.teamName,
    teamAbbreviation: asset.teamAbbreviation,
    teamLogoUrl: asset.teamLogoUrl,
    ...getStoredProjectionFields(asset),
  };
}

function buildActivatedDropWaiverPayload(
  droppedAsset: RosterAsset,
  droppedByOwnerId: string,
  effectiveCycleNumber: number,
) {
  const asset = rosterAssetToDraftableAsset(droppedAsset);

  return {
    assetKey: asset.assetKey,
    asset,
    droppedAsset,
    droppedByOwnerId,
    status: 'active',
    claims: [],
    awardedToOwnerId: null,
    effectiveCycleNumber,
    effectiveLabel: `Cycle ${effectiveCycleNumber}`,
    queuedMoveId: null,
    rosterSlotId: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    processedAt: null,
  };
}

async function loadWindowProjectionAssetsByKey(
  leagueId: string,
  teamCount: number,
  targetCycleNumber: number,
): Promise<Map<string, DraftableAsset>> {
  const bundle = await ensureWindowProjectionBundle({
    leagueId,
    teamCount,
    requiredGamesPerCycle: defaultScoringRules.requiredGamesPerCycle,
    targetCycleNumber,
  });

  if (bundle.errorMessage) {
    console.warn(
      `Cycle ${targetCycleNumber} opened with the best saved projection snapshot because the automatic refresh did not complete.`,
      bundle.errorMessage,
    );
  }

  return bundle.assetsByKey;
}

function hasUsableCycleProjection(
  asset: DraftableAsset | RosterAsset | null,
  cycleNumber?: number,
): boolean {
  if (!asset || getRawCycleProjection(asset as DraftProjection) === null) {
    return false;
  }

  const targetCycleNumber = (asset as DraftProjection).targetProjectionCycleNumber;

  return (
    cycleNumber === undefined ||
    targetCycleNumber === null ||
    targetCycleNumber === undefined ||
    targetCycleNumber === cycleNumber
  );
}

function createDraftableAssetFromRosterAsset(
  rosterAsset: RosterAsset,
  sharedProjectionAsset: DraftableAsset | null,
  draftFallbackAsset: DraftableAsset | null,
  cycleNumber: number,
): DraftableAsset {
  let projectionAsset: DraftableAsset | RosterAsset = rosterAsset;
  let frozenProjectionSource: FrozenWindowProjectionFields['frozenProjectionSource'] = 'roster';

  if (hasUsableCycleProjection(sharedProjectionAsset, cycleNumber)) {
    projectionAsset = sharedProjectionAsset as DraftableAsset;
    frozenProjectionSource = 'shared-snapshot';
  } else if (!hasUsableCycleProjection(rosterAsset, cycleNumber)) {
    if (draftFallbackAsset) {
      projectionAsset = draftFallbackAsset;
      frozenProjectionSource = 'draft-pick';
    } else if (sharedProjectionAsset) {
      // A target-cycle mismatch must never silently freeze an availability-
      // adjusted projection for the wrong six-game window. Use the stable
      // season projection fields only as a last-resort legacy baseline.
      projectionAsset = {
        ...sharedProjectionAsset,
        projectedCyclePoints:
          sharedProjectionAsset.draftProjectedCyclePoints ??
          sharedProjectionAsset.projectedCyclePoints ??
          null,
        availabilityAdjustedCyclePoints: null,
        expectedGamesAvailable: null,
        scheduledGamesInProjectionCycle: null,
        targetProjectionCycleNumber: cycleNumber,
      } as DraftableAsset;
      frozenProjectionSource = 'legacy';
    }
  }

  const projectedFields = getStoredProjectionFields(projectionAsset);

  const baseAsset: DraftableAsset =
    rosterAsset.assetType === 'skater'
      ? {
          assetType: 'skater',
          assetKey: getRosterAssetKey(rosterAsset),
          position: rosterAsset.position,
          player: rosterAsset.player,
          ...projectedFields,
        }
      : {
          assetType: 'team-goalie-unit',
          assetKey: getRosterAssetKey(rosterAsset),
          position: 'G',
          teamName: rosterAsset.teamName,
          teamAbbreviation: rosterAsset.teamAbbreviation,
          teamLogoUrl: rosterAsset.teamLogoUrl,
          ...projectedFields,
        };

  return {
    ...baseAsset,
    ...createFrozenWindowProjectionFields(baseAsset, cycleNumber, frozenProjectionSource),
  };
}

async function buildCurrentRosterSnapshotPicks(
  leagueId: string,
  teams: FantasyTeam[],
  draftPicks: DraftPick[],
  cycleNumber: number,
  includedOwnerIds?: Set<string>,
): Promise<DraftPick[]> {
  const draftPickByOwnerAndAssetKey = new Map<string, DraftPick>();

  for (const pick of draftPicks) {
    draftPickByOwnerAndAssetKey.set(`${pick.ownerId}::${pick.asset.assetKey}`, pick);
  }

  const eligibleTeams = includedOwnerIds
    ? teams.filter((team) => includedOwnerIds.has(team.ownerId))
    : teams;

  const [rosterSnapshots, projectionAssetsByKey] = await Promise.all([
    Promise.all(
      eligibleTeams.map(async (team) => {
        const rosterSnapshot = await getDoc(getTeamRosterRef(leagueId, team.ownerId));

        const roster: FantasyRoster | null = rosterSnapshot.exists()
          ? normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>)
          : null;

        return {
          ownerId: team.ownerId,
          roster,
        };
      }),
    ),
    loadWindowProjectionAssetsByKey(leagueId, teams.length, cycleNumber),
  ]);

  const snapshotPicks: DraftPick[] = [];

  for (const [teamIndex, rosterSnapshot] of rosterSnapshots.entries()) {
    const activeSlots = rosterSnapshot.roster?.activeSlots ?? [];

    for (const [slotIndex, slot] of activeSlots.entries()) {
      if (!slot.asset) {
        continue;
      }

      const assetKey = getRosterAssetKey(slot.asset);

      if (!assetKey) {
        continue;
      }

      const matchingDraftPick =
        draftPickByOwnerAndAssetKey.get(`${rosterSnapshot.ownerId}::${assetKey}`) ?? null;
      const snapshotOrder =
        matchingDraftPick?.overallPick ?? 100000 + teamIndex * 100 + slotIndex + 1;

      snapshotPicks.push({
        overallPick: snapshotOrder,
        round: matchingDraftPick?.round ?? 0,
        pickInRound: matchingDraftPick?.pickInRound ?? slot.slotNumber,
        ownerId: rosterSnapshot.ownerId,
        rosterSlotId: slot.slotId,
        cycleWindowId: getCycleWindowId(rosterSnapshot.ownerId, slot.slotId, cycleNumber),
        snapshotCycleNumber: cycleNumber,
        snapshotOrder,
        asset: createDraftableAssetFromRosterAsset(
          slot.asset,
          projectionAssetsByKey.get(assetKey) ?? null,
          matchingDraftPick?.asset ?? null,
          cycleNumber,
        ),
      });
    }
  }

  return snapshotPicks.sort((first, second) => {
    if (first.ownerId !== second.ownerId) {
      return first.ownerId.localeCompare(second.ownerId);
    }

    return (
      (first.snapshotOrder ?? first.overallPick) - (second.snapshotOrder ?? second.overallPick)
    );
  });
}

function writeCycleRosterPickSnapshots(
  transaction: Transaction,
  leagueId: string,
  cycleNumber: number,
  draftPicks: DraftPick[],
): void {
  for (const pick of draftPicks) {
    transaction.set(
      getCycleRosterSlotPickRef(leagueId, cycleNumber, pick.ownerId, getRosterSlotIdFromPick(pick)),
      {
        ...pick,
        snapshotCycleNumber: cycleNumber,
        snapshotSource: 'active-roster',
        snapshottedAt: serverTimestamp(),
      },
    );
  }
}

function roundScore(value: number): number {
  return Number(value.toFixed(1));
}

function getOrderedOwnerIds(teams: FantasyTeam[], draft: FantasyDraft | null): string[] {
  const teamOwnerIds = new Set(teams.map((team) => team.ownerId));

  const draftOrderOwnerIds =
    draft && Array.isArray(draft.roundOneOrder)
      ? draft.roundOneOrder.filter((ownerId) => teamOwnerIds.has(ownerId))
      : [];

  if (draftOrderOwnerIds.length > 0) {
    return draftOrderOwnerIds;
  }

  return [...teams]
    .sort((first, second) => first.teamName.localeCompare(second.teamName))
    .map((team) => team.ownerId);
}

function getMatchupWinnerOwnerId(
  teamAOwnerId: string,
  teamBOwnerId: string | null,
  teamAScore: number,
  teamBScore: number,
): string | null {
  if (!teamBOwnerId) {
    return null;
  }

  if (teamAScore > teamBScore) {
    return teamAOwnerId;
  }

  if (teamBScore > teamAScore) {
    return teamBOwnerId;
  }

  return null;
}

function getPlayoffWinner(
  matchup: FantasyMatchup,
  teamAScore: number,
  teamBScore: number,
): {
  winnerOwnerId: string;
  loserOwnerId: string;
  tieBrokenByHigherSeed: boolean;
} {
  if (!matchup.teamBOwnerId) {
    throw new Error(`Playoff matchup ${matchup.id} does not have two teams.`);
  }

  if (teamAScore > teamBScore) {
    return {
      winnerOwnerId: matchup.teamAOwnerId,
      loserOwnerId: matchup.teamBOwnerId,
      tieBrokenByHigherSeed: false,
    };
  }

  if (teamBScore > teamAScore) {
    return {
      winnerOwnerId: matchup.teamBOwnerId,
      loserOwnerId: matchup.teamAOwnerId,
      tieBrokenByHigherSeed: false,
    };
  }

  const teamASeed = matchup.teamASeed ?? Number.MAX_SAFE_INTEGER;
  const teamBSeed = matchup.teamBSeed ?? Number.MAX_SAFE_INTEGER;
  const teamAWinsTie = teamASeed <= teamBSeed;

  return {
    winnerOwnerId: teamAWinsTie ? matchup.teamAOwnerId : matchup.teamBOwnerId,
    loserOwnerId: teamAWinsTie ? matchup.teamBOwnerId : matchup.teamAOwnerId,
    tieBrokenByHigherSeed: true,
  };
}

function buildInitialRoundRobinLineup(orderedOwnerIds: string[]): Array<string | null> {
  const entries: Array<string | null> =
    orderedOwnerIds.length % 2 === 0 ? [...orderedOwnerIds] : [...orderedOwnerIds, null];

  const lineup = new Array<string | null>(entries.length).fill(null);
  let entryIndex = 0;

  for (
    let leftIndex = 0, rightIndex = entries.length - 1;
    leftIndex < rightIndex;
    leftIndex += 1, rightIndex -= 1
  ) {
    lineup[leftIndex] = entries[entryIndex] ?? null;
    entryIndex += 1;

    lineup[rightIndex] = entries[entryIndex] ?? null;
    entryIndex += 1;
  }

  return lineup;
}

function rotateRoundRobinLineup(lineup: Array<string | null>): Array<string | null> {
  if (lineup.length <= 2) {
    return lineup;
  }

  const fixedOwnerId = lineup[0];
  const rotatingOwnerIds = lineup.slice(1);
  const lastOwnerId = rotatingOwnerIds[rotatingOwnerIds.length - 1];
  const remainingOwnerIds = rotatingOwnerIds.slice(0, -1);

  return [fixedOwnerId, lastOwnerId, ...remainingOwnerIds];
}

function createCyclePairings(orderedOwnerIds: string[], cycleNumber: number): CyclePairing[] {
  if (orderedOwnerIds.length < 2) {
    throw new Error('At least two teams are required to create matchups.');
  }

  let lineup = buildInitialRoundRobinLineup(orderedOwnerIds);
  const rotationCount = lineup.length <= 1 ? 0 : (cycleNumber - 1) % (lineup.length - 1);

  for (let index = 0; index < rotationCount; index += 1) {
    lineup = rotateRoundRobinLineup(lineup);
  }

  const pairings: CyclePairing[] = [];

  for (
    let leftIndex = 0, rightIndex = lineup.length - 1;
    leftIndex < rightIndex;
    leftIndex += 1, rightIndex -= 1
  ) {
    let teamAOwnerId = lineup[leftIndex];
    let teamBOwnerId = lineup[rightIndex];

    if (!teamAOwnerId && !teamBOwnerId) {
      continue;
    }

    if (!teamAOwnerId) {
      teamAOwnerId = teamBOwnerId;
      teamBOwnerId = null;
    }

    if (!teamAOwnerId) {
      continue;
    }

    pairings.push({
      teamAOwnerId,
      teamBOwnerId,
    });
  }

  return pairings;
}

export function getRoundRobinCycleCount(teamCount: number): number {
  if (teamCount < 2) {
    return 0;
  }

  const lineupLength = teamCount % 2 === 0 ? teamCount : teamCount + 1;

  return Math.max(1, lineupLength - 1);
}

export function buildCycleSchedulePreview(
  teams: FantasyTeam[],
  draft: FantasyDraft | null,
  cycleCount?: number,
): CycleSchedulePreviewCycle[] {
  if (teams.length < 2) {
    return [];
  }

  const orderedOwnerIds = getOrderedOwnerIds(teams, draft);
  const previewCycleCount =
    cycleCount ?? getStandardRegularSeasonCycleCount(orderedOwnerIds.length);

  return Array.from({ length: previewCycleCount }, (_, cycleIndex) => {
    const cycleNumber = cycleIndex + 1;
    const pairings = createCyclePairings(orderedOwnerIds, cycleNumber);

    return {
      cycleNumber,
      matchups: pairings.map((pairing, matchupIndex) => ({
        id: `matchup-${matchupIndex + 1}`,
        teamAOwnerId: pairing.teamAOwnerId,
        teamBOwnerId: pairing.teamBOwnerId,
      })),
    };
  });
}

export async function getActiveLeagueCycles(leagueId: string): Promise<FantasyCycle[]> {
  const activeCyclesQuery = query(getCyclesRef(leagueId), where('status', '==', 'active'));
  const snapshot = await getDocs(activeCyclesQuery);

  return snapshot.docs
    .map((cycleDoc) => {
      const data = cycleDoc.data() as Partial<FantasyCycle>;

      return normalizeCycle(data, data.cycleNumber ?? FIRST_CYCLE_NUMBER);
    })
    .sort((first, second) => first.cycleNumber - second.cycleNumber);
}

export async function getCycleRosterPicksOnce(
  leagueId: string,
  cycleNumber: number,
): Promise<DraftPick[]> {
  const rosterPicksQuery = query(
    getCycleRosterPicksRef(leagueId, cycleNumber),
    orderBy('overallPick', 'asc'),
  );
  const snapshot = await getDocs(rosterPicksQuery);

  return snapshot.docs.map((pickDoc) => pickDoc.data() as DraftPick);
}

export async function getCycleMatchupsOnce(
  leagueId: string,
  cycleNumber: number,
): Promise<FantasyMatchup[]> {
  const matchupsQuery = query(getCycleMatchupsRef(leagueId, cycleNumber), orderBy('id', 'asc'));
  const snapshot = await getDocs(matchupsQuery);

  return snapshot.docs.map((matchupDoc) =>
    normalizeMatchup(matchupDoc.data() as Partial<FantasyMatchup>),
  );
}
export function listenToCycle(
  leagueId: string,
  cycleNumber: number,
  callback: (cycle: FantasyCycle | null) => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    getCycleRef(leagueId, cycleNumber),
    (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }

      callback(normalizeCycle(snapshot.data() as Partial<FantasyCycle>, cycleNumber));
    },
    (error) => {
      reportCycleListenerError(error, `Unable to load Cycle ${cycleNumber}.`, onError);
    },
  );
}

export function listenToLeagueCycles(
  leagueId: string,
  callback: (cycles: FantasyCycle[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const cyclesQuery = query(getCyclesRef(leagueId), orderBy('cycleNumber', 'asc'));

  return onSnapshot(
    cyclesQuery,
    (snapshot) => {
      callback(
        snapshot.docs.map((cycleDoc) => {
          const data = cycleDoc.data() as Partial<FantasyCycle>;

          return normalizeCycle(data, data.cycleNumber ?? FIRST_CYCLE_NUMBER);
        }),
      );
    },
    (error) => {
      reportCycleListenerError(error, 'Unable to load league cycles.', onError);
    },
  );
}

export function listenToLatestCycle(
  leagueId: string,
  callback: (cycle: FantasyCycle | null) => void,
  onError?: (error: Error) => void,
): () => void {
  const latestCycleQuery = query(getCyclesRef(leagueId), orderBy('cycleNumber', 'desc'), limit(1));

  return onSnapshot(
    latestCycleQuery,
    (snapshot) => {
      const latestCycleDoc = snapshot.docs[0];

      if (!latestCycleDoc) {
        callback(null);
        return;
      }

      const data = latestCycleDoc.data() as Partial<FantasyCycle>;

      callback(normalizeCycle(data, data.cycleNumber ?? FIRST_CYCLE_NUMBER));
    },
    (error) => {
      reportCycleListenerError(error, 'Unable to load the latest cycle.', onError);
    },
  );
}

export async function getLatestCycle(leagueId: string): Promise<FantasyCycle | null> {
  const latestCycleQuery = query(getCyclesRef(leagueId), orderBy('cycleNumber', 'desc'), limit(1));

  const snapshot = await getDocs(latestCycleQuery);
  const latestCycleDoc = snapshot.docs[0];

  if (!latestCycleDoc) {
    return null;
  }

  const data = latestCycleDoc.data() as Partial<FantasyCycle>;

  return normalizeCycle(data, data.cycleNumber ?? FIRST_CYCLE_NUMBER);
}

export function listenToCycleMatchups(
  leagueId: string,
  cycleNumber: number,
  callback: (matchups: FantasyMatchup[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const matchupsQuery = query(getCycleMatchupsRef(leagueId, cycleNumber), orderBy('id', 'asc'));

  return onSnapshot(
    matchupsQuery,
    (snapshot) => {
      callback(
        snapshot.docs.map((matchupDoc) =>
          normalizeMatchup(matchupDoc.data() as Partial<FantasyMatchup>),
        ),
      );
    },
    (error) => {
      reportCycleListenerError(error, `Unable to load Cycle ${cycleNumber} matchups.`, onError);
    },
  );
}

export function listenToCycleRosterPicks(
  leagueId: string,
  cycleNumber: number,
  callback: (picks: DraftPick[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const rosterPicksQuery = query(
    getCycleRosterPicksRef(leagueId, cycleNumber),
    orderBy('overallPick', 'asc'),
  );

  return onSnapshot(
    rosterPicksQuery,
    (snapshot) => {
      callback(snapshot.docs.map((pickDoc) => pickDoc.data() as DraftPick));
    },
    (error) => {
      reportCycleListenerError(
        error,
        `Unable to load Cycle ${cycleNumber} roster snapshots.`,
        onError,
      );
    },
  );
}

export async function startCycle(
  leagueId: string,
  teams: FantasyTeam[],
  cycleNumber: number,
): Promise<FantasyCycle> {
  if (teams.length < 2) {
    throw new Error('At least two teams are required to start a cycle.');
  }

  const cycleRef = getCycleRef(leagueId, cycleNumber);
  const draftRef = getDraftRef(leagueId);
  const draftPicksQuery = query(getDraftPicksRef(leagueId), orderBy('overallPick', 'asc'));

  const draftPicksSnapshot = await getDocs(draftPicksQuery);
  const draftPicks = draftPicksSnapshot.docs.map((pickDoc) => pickDoc.data() as DraftPick);

  const rosterSnapshotPicks = await buildCurrentRosterSnapshotPicks(
    leagueId,
    teams,
    draftPicks,
    cycleNumber,
  );
  const expectedRosterSlotIdsByOwner = buildExpectedRosterSlotIdsByOwner(rosterSnapshotPicks);

  return runTransaction(db, async (transaction) => {
    const [cycleSnapshot, draftSnapshot] = await Promise.all([
      transaction.get(cycleRef),
      transaction.get(draftRef),
    ]);

    if (cycleSnapshot.exists()) {
      throw new Error(`Cycle ${cycleNumber} has already been started.`);
    }

    if (!draftSnapshot.exists()) {
      throw new Error('The draft must be completed before starting a cycle.');
    }

    const draft = draftSnapshot.data() as FantasyDraft;

    if (draft.status !== 'complete') {
      throw new Error('The draft must be completed before starting a cycle.');
    }

    if (rosterSnapshotPicks.length === 0) {
      throw new Error('No active roster assets were found to snapshot for this cycle.');
    }

    const orderedOwnerIds = getOrderedOwnerIds(teams, draft);

    const pairings = createCyclePairings(orderedOwnerIds, cycleNumber);

    const matchupIds: string[] = [];

    pairings.forEach((pairing, index) => {
      const matchupId = `matchup-${index + 1}`;
      matchupIds.push(matchupId);

      transaction.set(getCycleMatchupRef(leagueId, cycleNumber, matchupId), {
        id: matchupId,
        cycleNumber,
        phase: 'regular_season',
        bracketType: null,
        playoffRoundNumber: null,
        playoffMatchupId: null,
        teamASeed: null,
        teamBSeed: null,
        winnerPlace: null,
        loserPlace: null,
        tieBrokenByHigherSeed: false,
        teamAOwnerId: pairing.teamAOwnerId,
        teamBOwnerId: pairing.teamBOwnerId,
        teamAScore: 0,
        teamBScore: 0,
        winnerOwnerId: null,
        status: 'active',
        completedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });

    writeCycleRosterPickSnapshots(transaction, leagueId, cycleNumber, rosterSnapshotPicks);

    const cycle: FantasyCycle = {
      id: getCycleDocumentId(cycleNumber),
      cycleNumber,
      status: 'active',
      phase: 'regular_season',
      playoffRoundNumber: null,
      playoffRoundCount: null,
      playoffRoundLabel: null,
      matchupIds,
      windowSchemaVersion: 1,
      expectedRosterSlotIdsByOwner,
      parentCycleNumber: null,
      overlapsPreviousCycle: false,
      totalExpectedWindowCount: countExpectedWindows(expectedRosterSlotIdsByOwner),
      activeWindowCount: rosterSnapshotPicks.length,
      completedWindowCount: 0,
      matchupCompletionSchemaVersion: 1,
      totalMatchupCount: matchupIds.length,
      completedMatchupCount: 0,
      pendingMatchupCount: matchupIds.length,
      lastMatchupCompletedAt: null,
      standingsAppliedAt: null,
      projectionAccuracyStatus: 'pending',
      projectionAccuracyAssetCount: 0,
      projectionAccuracyProjectionVersions: [],
      projectionAccuracyUpdatedAt: null,
      completedAt: null,
    };

    transaction.set(cycleRef, {
      ...cycle,
      startedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return cycle;
  });
}

export async function startNextCycle(
  leagueId: string,
  teams: FantasyTeam[],
  currentCycleNumber: number,
): Promise<FantasyCycle | null> {
  if (teams.length < 2) {
    throw new Error('At least two teams are required to start the next cycle.');
  }

  const nextCycleNumber = currentCycleNumber + 1;
  const currentCycleRef = getCycleRef(leagueId, currentCycleNumber);
  const nextCycleRef = getCycleRef(leagueId, nextCycleNumber);
  const draftRef = getDraftRef(leagueId);
  const playoffsRef = getFantasyPlayoffsRef(leagueId);
  const [currentCycleSnapshot, nextCycleSnapshot, playoffsSnapshot, draftSnapshot] =
    await Promise.all([
      getDoc(currentCycleRef),
      getDoc(nextCycleRef),
      getDoc(playoffsRef),
      getDoc(draftRef),
    ]);

  if (!currentCycleSnapshot.exists()) {
    throw new Error(`Cycle ${currentCycleNumber} does not exist.`);
  }

  const currentCycle = normalizeCycle(
    currentCycleSnapshot.data() as Partial<FantasyCycle>,
    currentCycleNumber,
  );

  if (currentCycle.status !== 'complete') {
    throw new Error(
      `${currentCycle.playoffRoundLabel ?? `Cycle ${currentCycleNumber}`} must be completed before starting the next matchup period.`,
    );
  }

  if (!draftSnapshot.exists()) {
    throw new Error('The draft must be completed before starting the next matchup period.');
  }

  const draft = draftSnapshot.data() as FantasyDraft;

  if (draft.status !== 'complete') {
    throw new Error('The draft must be completed before starting the next matchup period.');
  }

  let playoffState = playoffsSnapshot.exists()
    ? normalizeFantasyPlayoffs(playoffsSnapshot.data() as Partial<FantasyPlayoffs>)
    : null;
  const regularSeasonCycleCount = getStandardRegularSeasonCycleCount(teams.length);
  const enteringPlayoffs =
    currentCycle.phase === 'regular_season' && currentCycleNumber >= regularSeasonCycleCount;
  const continuingPlayoffs = currentCycle.phase === 'playoffs';
  const isPlayoffCycle = enteringPlayoffs || continuingPlayoffs;

  if (nextCycleSnapshot.exists()) {
    return normalizeCycle(nextCycleSnapshot.data() as Partial<FantasyCycle>, nextCycleNumber);
  }

  const draftPicksSnapshot = await getDocs(
    query(getDraftPicksRef(leagueId), orderBy('overallPick', 'asc')),
  );
  const draftPicks = draftPicksSnapshot.docs.map(
    (pickDocument) => pickDocument.data() as DraftPick,
  );

  let cyclePicks: DraftPick[] = [];
  let playoffRoundNumber: number | null = null;
  let playoffRoundLabel: string | null = null;
  let playoffMatchups = [] as ReturnType<typeof getPlayoffRoundMatchups>;
  let initialBankPayloads: FantasyPlayoffWindowBank[] = [];
  let assignedBanks: FantasyPlayoffWindowBank[] = [];

  if (isPlayoffCycle) {
    if (playoffState?.status === 'complete') {
      return null;
    }

    if (!playoffState) {
      playoffState = createStandardFantasyPlayoffs(teams, currentCycleNumber);

      const allPlayoffOwnerIds = new Set(playoffState.seeds.map((seed) => seed.ownerId));
      const allPlayoffPicks = await buildCurrentRosterSnapshotPicks(
        leagueId,
        teams,
        draftPicks,
        playoffState.regularSeasonCycleCount + 1,
        allPlayoffOwnerIds,
      );
      initialBankPayloads = createInitialPlayoffBankPayloads(playoffState, allPlayoffPicks);
    }

    playoffRoundNumber = playoffState.currentRoundNumber;
    playoffRoundLabel = getPlayoffRoundLabel(playoffRoundNumber, playoffState.playoffRoundCount);
    playoffMatchups = getPlayoffRoundMatchups(playoffState, playoffRoundNumber);

    if (playoffMatchups.length === 0) {
      throw new Error(`${playoffRoundLabel} does not have any playable matchups.`);
    }

    if (initialBankPayloads.length === 0) {
      const savedBanks = await getAllPlayoffWindowBanks(leagueId, playoffState);

      if (savedBanks.length === 0 && enteringPlayoffs) {
        const allPlayoffOwnerIds = new Set(playoffState.seeds.map((seed) => seed.ownerId));
        const allPlayoffPicks = await buildCurrentRosterSnapshotPicks(
          leagueId,
          teams,
          draftPicks,
          playoffState.regularSeasonCycleCount + 1,
          allPlayoffOwnerIds,
        );
        initialBankPayloads = createInitialPlayoffBankPayloads(playoffState, allPlayoffPicks);
      }
    }

    const banks =
      initialBankPayloads.length > 0
        ? initialBankPayloads
        : await getAllPlayoffWindowBanks(leagueId, playoffState);
    const assignmentsByOwnerId: Record<
      string,
      {
        ownerId: string;
        windowNumber: number;
        sourceCycleNumber: number;
      }
    > = {};
    const roundOwnerIds = getPlayoffRoundOwnerIds(playoffState, playoffRoundNumber);

    for (const ownerId of roundOwnerIds) {
      const bank = getEarliestUnassignedPlayoffWindow(banks, ownerId);

      if (!bank) {
        throw new Error(
          `No banked playoff window is ready for ${ownerId}. Open the current playoff matchup once to refresh banked windows, then try again.`,
        );
      }

      assignmentsByOwnerId[ownerId] = {
        ownerId,
        windowNumber: bank.windowNumber,
        sourceCycleNumber: bank.sourceCycleNumber,
      };
      assignedBanks.push(bank);
    }

    playoffState = assignPlayoffRoundWindows(
      playoffState,
      playoffRoundNumber,
      assignmentsByOwnerId,
    );
    playoffMatchups = getPlayoffRoundMatchups(playoffState, playoffRoundNumber);
    cyclePicks = assignedBanks.flatMap((bank) =>
      bank.picks.map((pick) => ({
        ...pick,
        playoffWindowNumber: bank.windowNumber,
        snapshotCycleNumber: bank.sourceCycleNumber,
      })),
    );
  } else {
    cyclePicks = await buildCurrentRosterSnapshotPicks(
      leagueId,
      teams,
      draftPicks,
      nextCycleNumber,
    );
  }

  if (cyclePicks.length === 0) {
    throw new Error('No active roster assets were found for the next matchup period.');
  }

  const expectedRosterSlotIdsByOwner = buildExpectedRosterSlotIdsByOwner(cyclePicks);

  return runTransaction(db, async (transaction) => {
    const [savedCurrent, savedNext, savedPlayoffs, savedDraft] = await Promise.all([
      transaction.get(currentCycleRef),
      transaction.get(nextCycleRef),
      transaction.get(playoffsRef),
      transaction.get(draftRef),
    ]);

    if (!savedCurrent.exists()) {
      throw new Error(`Cycle ${currentCycleNumber} does not exist.`);
    }

    if (
      normalizeCycle(savedCurrent.data() as Partial<FantasyCycle>, currentCycleNumber).status !==
      'complete'
    ) {
      throw new Error(
        `Cycle ${currentCycleNumber} must be complete before the next matchup period opens.`,
      );
    }

    if (savedNext.exists()) {
      return normalizeCycle(savedNext.data() as Partial<FantasyCycle>, nextCycleNumber);
    }

    if (!savedDraft.exists() || (savedDraft.data() as FantasyDraft).status !== 'complete') {
      throw new Error('The completed draft is required.');
    }

    const matchupIds: string[] = [];

    if (isPlayoffCycle && playoffState && playoffRoundNumber !== null) {
      for (const bank of initialBankPayloads) {
        const assignment = assignedBanks.find(
          (candidate) =>
            candidate.ownerId === bank.ownerId && candidate.windowNumber === bank.windowNumber,
        );

        transaction.set(
          getPlayoffWindowBankRef(leagueId, bank.ownerId, bank.windowNumber),
          assignment
            ? {
                ...bank,
                assignmentStatus: 'assigned',
                assignedMatchupId:
                  playoffMatchups.find(
                    (matchup) =>
                      matchup.teamAOwnerId === bank.ownerId ||
                      matchup.teamBOwnerId === bank.ownerId,
                  )?.id ?? null,
                assignedRoundNumber: playoffRoundNumber,
                assignedAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              }
            : bank,
        );
      }

      if (initialBankPayloads.length === 0) {
        for (const bank of assignedBanks) {
          const assignedMatchup = playoffMatchups.find(
            (matchup) =>
              matchup.teamAOwnerId === bank.ownerId || matchup.teamBOwnerId === bank.ownerId,
          );

          transaction.set(
            getPlayoffWindowBankRef(leagueId, bank.ownerId, bank.windowNumber),
            {
              assignmentStatus: 'assigned',
              assignedMatchupId: assignedMatchup?.id ?? null,
              assignedRoundNumber: playoffRoundNumber,
              assignedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        }
      }

      for (const playoffMatchup of playoffMatchups) {
        if (!playoffMatchup.teamAOwnerId || !playoffMatchup.teamBOwnerId) {
          continue;
        }

        matchupIds.push(playoffMatchup.id);
        transaction.set(getCycleMatchupRef(leagueId, nextCycleNumber, playoffMatchup.id), {
          id: playoffMatchup.id,
          cycleNumber: nextCycleNumber,
          phase: 'playoffs',
          bracketType: playoffMatchup.bracketType,
          playoffRoundNumber,
          playoffMatchupId: playoffMatchup.id,
          teamASeed: playoffMatchup.teamASeed,
          teamBSeed: playoffMatchup.teamBSeed,
          teamAWindowNumber: playoffMatchup.teamAWindowNumber,
          teamBWindowNumber: playoffMatchup.teamBWindowNumber,
          teamAWindowCycleNumber: playoffMatchup.teamAWindowCycleNumber,
          teamBWindowCycleNumber: playoffMatchup.teamBWindowCycleNumber,
          winnerPlace: playoffMatchup.winnerPlace,
          loserPlace: playoffMatchup.loserPlace,
          tieBrokenByHigherSeed: false,
          teamAOwnerId: playoffMatchup.teamAOwnerId,
          teamBOwnerId: playoffMatchup.teamBOwnerId,
          teamAScore: 0,
          teamBScore: 0,
          winnerOwnerId: null,
          status: 'active',
          completedAt: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      transaction.set(
        playoffsRef,
        {
          ...playoffState,
          formatVersion: 2,
          currentCycleNumber: nextCycleNumber,
          ...(savedPlayoffs.exists() ? {} : { createdAt: serverTimestamp() }),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      const pairings = createCyclePairings(getOrderedOwnerIds(teams, draft), nextCycleNumber);

      pairings.forEach((pairing, index) => {
        const matchupId = `matchup-${index + 1}`;
        matchupIds.push(matchupId);
        transaction.set(getCycleMatchupRef(leagueId, nextCycleNumber, matchupId), {
          id: matchupId,
          cycleNumber: nextCycleNumber,
          phase: 'regular_season',
          bracketType: null,
          playoffRoundNumber: null,
          playoffMatchupId: null,
          teamASeed: null,
          teamBSeed: null,
          teamAWindowNumber: null,
          teamBWindowNumber: null,
          teamAWindowCycleNumber: null,
          teamBWindowCycleNumber: null,
          winnerPlace: null,
          loserPlace: null,
          tieBrokenByHigherSeed: false,
          teamAOwnerId: pairing.teamAOwnerId,
          teamBOwnerId: pairing.teamBOwnerId,
          teamAScore: 0,
          teamBScore: 0,
          winnerOwnerId: null,
          status: 'active',
          completedAt: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });
    }

    writeCycleRosterPickSnapshots(transaction, leagueId, nextCycleNumber, cyclePicks);

    const cycle: FantasyCycle = {
      id: getCycleDocumentId(nextCycleNumber),
      cycleNumber: nextCycleNumber,
      status: 'active',
      phase: isPlayoffCycle ? 'playoffs' : 'regular_season',
      playoffRoundNumber,
      playoffRoundCount: isPlayoffCycle && playoffState ? playoffState.playoffRoundCount : null,
      playoffRoundLabel,
      matchupIds,
      windowSchemaVersion: 2,
      expectedRosterSlotIdsByOwner,
      parentCycleNumber: currentCycleNumber,
      overlapsPreviousCycle: isPlayoffCycle,
      bankedPlayoffWindowsEnabled: isPlayoffCycle,
      totalExpectedWindowCount: countExpectedWindows(expectedRosterSlotIdsByOwner),
      activeWindowCount: cyclePicks.length,
      completedWindowCount: 0,
      matchupCompletionSchemaVersion: 1,
      totalMatchupCount: matchupIds.length,
      completedMatchupCount: 0,
      pendingMatchupCount: matchupIds.length,
      lastMatchupCompletedAt: null,
      standingsAppliedAt: null,
      projectionAccuracyStatus: 'pending',
      projectionAccuracyAssetCount: 0,
      projectionAccuracyProjectionVersions: [],
      projectionAccuracyUpdatedAt: null,
      completedAt: null,
    };

    transaction.set(nextCycleRef, {
      ...cycle,
      startedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return cycle;
  });
}

function getCompletedWindowPickKeys(picks: DraftPick[], scoring: CycleScoringResult): Set<string> {
  const completed = new Set<string>();

  for (const pick of picks) {
    const slotId = getRosterSlotIdFromPick(pick);
    const windowId =
      pick.cycleWindowId ?? getCycleWindowId(pick.ownerId, slotId, pick.snapshotCycleNumber ?? 1);
    const summary = scoring.windowScores[windowId] ?? scoring.assetScores[pick.asset.assetKey];

    if (summary?.status === 'complete') {
      completed.add(`${pick.ownerId}::${slotId}`);
      completed.add(`${pick.ownerId}::asset:${pick.asset.assetKey}`);
    }
  }

  return completed;
}

interface PendingSlotActivationPlan {
  ownerId: string;
  rosterSlotId: string;
  pendingMoveId: string;
  pendingMove: PendingRosterSlotMove;
  outgoingAsset: RosterAsset | null;
  incomingAsset: RosterAsset;
}

function getPendingMoveRequestedCycleNumber(
  pendingMove: PendingRosterSlotMove | null | undefined,
): number | null {
  const requestedCycleNumber = pendingMove?.requestedEffectiveCycleNumber;

  return typeof requestedCycleNumber === 'number' &&
    Number.isFinite(requestedCycleNumber) &&
    requestedCycleNumber > 0
    ? Math.floor(requestedCycleNumber)
    : null;
}

function canActivatePendingMoveInCycle(
  pendingMove: PendingRosterSlotMove | null | undefined,
  cycleNumber: number,
): boolean {
  if (!pendingMove) {
    return false;
  }

  const requestedCycleNumber = getPendingMoveRequestedCycleNumber(pendingMove);

  return requestedCycleNumber === null || cycleNumber >= requestedCycleNumber;
}

async function buildNextWindowSnapshotPicks(
  leagueId: string,
  teams: FantasyTeam[],
  completedWindowKeys: Set<string>,
  currentWindowSlotKeys: Set<string>,
  nextCycleNumber: number,
): Promise<{
  picks: DraftPick[];
  expectedRosterSlotIdsByOwner: Record<string, string[]>;
  activationPlansBySlotKey: Record<string, PendingSlotActivationPlan>;
  openSlotRolloversByOwner: Record<string, string[]>;
}> {
  const draftPicksQuery = query(getDraftPicksRef(leagueId), orderBy('overallPick', 'asc'));
  const [draftPicksSnapshot, projectionAssetsByKey, rosterSnapshots] = await Promise.all([
    getDocs(draftPicksQuery),
    loadWindowProjectionAssetsByKey(leagueId, teams.length, nextCycleNumber),
    Promise.all(
      teams.map(async (team) => {
        const snapshot = await getDoc(getTeamRosterRef(leagueId, team.ownerId));

        return {
          ownerId: team.ownerId,
          roster: snapshot.exists()
            ? normalizeFantasyRoster(snapshot.data() as Partial<FantasyRoster>)
            : null,
        };
      }),
    ),
  ]);
  const draftPicks = draftPicksSnapshot.docs.map((snapshot) => snapshot.data() as DraftPick);
  const draftPickByOwnerAndAssetKey = new Map(
    draftPicks.map((pick) => [`${pick.ownerId}::${pick.asset.assetKey}`, pick] as const),
  );
  const teamIndexByOwnerId = new Map(teams.map((team, index) => [team.ownerId, index] as const));
  const nextPicks: DraftPick[] = [];
  const expectedRosterSlotIdsByOwner: Record<string, string[]> = {};
  const activationPlansBySlotKey: Record<string, PendingSlotActivationPlan> = {};
  const openSlotRolloversByOwner: Record<string, string[]> = {};

  for (const rosterSnapshot of rosterSnapshots) {
    const activeSlots = rosterSnapshot.roster?.activeSlots ?? [];

    for (const [slotIndex, slot] of activeSlots.entries()) {
      const currentAsset = slot.asset;
      const currentAssetKey = getRosterAssetKey(currentAsset);
      const completedSlotKey = `${rosterSnapshot.ownerId}::${slot.slotId}`;
      const completedAssetKey = currentAssetKey
        ? `${rosterSnapshot.ownerId}::asset:${currentAssetKey}`
        : '';
      const pendingMoveReady = canActivatePendingMoveInCycle(slot.pendingMove, nextCycleNumber);
      const slotWindowCompleted =
        completedWindowKeys.has(completedSlotKey) ||
        Boolean(completedAssetKey && completedWindowKeys.has(completedAssetKey));
      const slotHasCurrentWindow = currentWindowSlotKeys.has(completedSlotKey);
      const emptySlotReachedNextCycle =
        !currentAsset && (slotWindowCompleted || !slotHasCurrentWindow);
      const deferredOpenSlotReady = emptySlotReachedNextCycle && pendingMoveReady;

      if (!slotWindowCompleted && !deferredOpenSlotReady && !emptySlotReachedNextCycle) {
        continue;
      }

      const nextAsset = pendingMoveReady
        ? (slot.pendingMove?.incomingAsset ?? currentAsset)
        : currentAsset;

      if (!nextAsset) {
        // An empty active slot has no NHL schedule of its own. Once the league
        // has opened the next asynchronous cycle for other slots, carry this
        // slot's immediate-entry marker forward so a still-untouched incoming
        // asset can join that exact cycle instead of being forced one cycle late.
        openSlotRolloversByOwner[rosterSnapshot.ownerId] ??= [];
        openSlotRolloversByOwner[rosterSnapshot.ownerId].push(slot.slotId);
        continue;
      }

      expectedRosterSlotIdsByOwner[rosterSnapshot.ownerId] ??= [];
      expectedRosterSlotIdsByOwner[rosterSnapshot.ownerId].push(slot.slotId);

      const nextAssetKey = getRosterAssetKey(nextAsset);

      if (!nextAssetKey) {
        continue;
      }

      const matchingDraftPick =
        draftPickByOwnerAndAssetKey.get(`${rosterSnapshot.ownerId}::${nextAssetKey}`) ?? null;
      const teamIndex = teamIndexByOwnerId.get(rosterSnapshot.ownerId) ?? 0;
      const snapshotOrder =
        matchingDraftPick?.overallPick ?? 100000 + teamIndex * 100 + slotIndex + 1;

      nextPicks.push({
        overallPick: snapshotOrder,
        round: matchingDraftPick?.round ?? 0,
        pickInRound: matchingDraftPick?.pickInRound ?? slot.slotNumber,
        ownerId: rosterSnapshot.ownerId,
        rosterSlotId: slot.slotId,
        cycleWindowId: getCycleWindowId(rosterSnapshot.ownerId, slot.slotId, nextCycleNumber),
        snapshotCycleNumber: nextCycleNumber,
        snapshotOrder,
        asset: createDraftableAssetFromRosterAsset(
          nextAsset,
          projectionAssetsByKey.get(nextAssetKey) ?? null,
          matchingDraftPick?.asset ?? null,
          nextCycleNumber,
        ),
      });

      if (slot.pendingMove && pendingMoveReady) {
        activationPlansBySlotKey[completedSlotKey] = {
          ownerId: rosterSnapshot.ownerId,
          rosterSlotId: slot.slotId,
          pendingMoveId: slot.pendingMove.id,
          pendingMove: slot.pendingMove,
          outgoingAsset: currentAsset,
          incomingAsset: slot.pendingMove.incomingAsset,
        };
      }
    }
  }

  for (const slotIds of Object.values(expectedRosterSlotIdsByOwner)) {
    slotIds.sort();
  }

  for (const slotIds of Object.values(openSlotRolloversByOwner)) {
    slotIds.sort();
  }

  return {
    picks: nextPicks.sort((first, second) => {
      if (first.ownerId !== second.ownerId) {
        return first.ownerId.localeCompare(second.ownerId);
      }

      return (
        (first.snapshotOrder ?? first.overallPick) - (second.snapshotOrder ?? second.overallPick)
      );
    }),
    expectedRosterSlotIdsByOwner,
    activationPlansBySlotKey,
    openSlotRolloversByOwner,
  };
}

/**
 * Opens only the roster-slot windows that are ready to move forward. This is
 * the key regular-season overlap behavior: Cycle N+1 may begin accumulating
 * for fast NHL schedules while Cycle N remains active for slower schedules.
 * Playoff windows use the separate bank-and-route flow implemented by the
 * playoff window bank service.
 */
export async function advanceCompletedRegularSeasonAssetWindows(
  leagueId: string,
  teams: FantasyTeam[],
  currentCycle: FantasyCycle,
  currentPicks: DraftPick[],
  scoring: CycleScoringResult,
): Promise<FantasyCycle | null> {
  if (currentCycle.phase !== 'regular_season' || currentCycle.status !== 'active') {
    return null;
  }

  const regularSeasonCycleCount = getStandardRegularSeasonCycleCount(teams.length);
  const nextCycleNumber = currentCycle.cycleNumber + 1;

  // The final regular-season -> playoff transition still needs bracket-aware
  // banking/routing, which is implemented in the later playoff barrier stage.
  if (nextCycleNumber > regularSeasonCycleCount) {
    return null;
  }

  const completedWindowKeys = getCompletedWindowPickKeys(currentPicks, scoring);
  const currentWindowSlotKeys = new Set(
    currentPicks.map((pick) => `${pick.ownerId}::${getRosterSlotIdFromPick(pick)}`),
  );

  const {
    picks: nextPicks,
    activationPlansBySlotKey,
    openSlotRolloversByOwner,
  } = await buildNextWindowSnapshotPicks(
    leagueId,
    teams,
    completedWindowKeys,
    currentWindowSlotKeys,
    nextCycleNumber,
  );
  const expectedRosterSlotIdsByOwner =
    Object.keys(currentCycle.expectedRosterSlotIdsByOwner ?? {}).length > 0
      ? (currentCycle.expectedRosterSlotIdsByOwner ?? {})
      : buildExpectedRosterSlotIdsByOwner(currentPicks);

  // Do not create a new league cycle solely because a roster slot is empty.
  // The marker rolls forward only alongside at least one real asset window.
  if (nextPicks.length === 0) {
    return null;
  }

  const nextCycleRef = getCycleRef(leagueId, nextCycleNumber);
  const currentCycleRef = getCycleRef(leagueId, currentCycle.cycleNumber);
  const draftRef = getDraftRef(leagueId);
  const nextPickRefs = nextPicks.map((pick) =>
    getCycleRosterSlotPickRef(
      leagueId,
      nextCycleNumber,
      pick.ownerId,
      getRosterSlotIdFromPick(pick),
    ),
  );
  const rosterUpdateOwnerIds = [
    ...new Set([
      ...nextPicks
        .filter((pick) =>
          Boolean(activationPlansBySlotKey[`${pick.ownerId}::${getRosterSlotIdFromPick(pick)}`]),
        )
        .map((pick) => pick.ownerId),
      ...Object.keys(openSlotRolloversByOwner),
    ]),
  ];
  const rosterUpdateRefs = rosterUpdateOwnerIds.map((ownerId) =>
    getTeamRosterRef(leagueId, ownerId),
  );
  const currentExpectedRosterSlotIdsByOwner =
    Object.keys(currentCycle.expectedRosterSlotIdsByOwner ?? {}).length > 0
      ? (currentCycle.expectedRosterSlotIdsByOwner ?? {})
      : buildExpectedRosterSlotIdsByOwner(currentPicks);
  const currentCompletedWindowCount = currentPicks.filter((pick) => {
    const slotId = getRosterSlotIdFromPick(pick);
    const windowId =
      pick.cycleWindowId ?? getCycleWindowId(pick.ownerId, slotId, currentCycle.cycleNumber);
    const summary = scoring.windowScores[windowId] ?? scoring.assetScores[pick.asset.assetKey];

    return summary?.status === 'complete';
  }).length;

  return runTransaction(db, async (transaction) => {
    const snapshots = await Promise.all([
      transaction.get(nextCycleRef),
      transaction.get(draftRef),
      ...nextPickRefs.map((ref) => transaction.get(ref)),
      ...rosterUpdateRefs.map((ref) => transaction.get(ref)),
    ]);
    const nextCycleSnapshot = snapshots[0];
    const draftSnapshot = snapshots[1];
    const nextPickSnapshots = snapshots.slice(2, 2 + nextPickRefs.length);
    const rosterUpdateSnapshots = snapshots.slice(2 + nextPickRefs.length);
    const rostersByOwnerId = new Map(
      rosterUpdateOwnerIds.map((ownerId, index) => {
        const snapshot = rosterUpdateSnapshots[index];

        return [
          ownerId,
          snapshot?.exists()
            ? normalizeFantasyRoster(snapshot.data() as Partial<FantasyRoster>)
            : null,
        ] as const;
      }),
    );

    if (!draftSnapshot.exists()) {
      throw new Error('The completed draft is required to open overlapping slot windows.');
    }

    const draft = draftSnapshot.data() as FantasyDraft;

    if (draft.status !== 'complete') {
      throw new Error('The draft must be complete before overlapping cycles can open.');
    }

    let nextCycle: FantasyCycle;
    let existingAssignedWindowCount = 0;

    if (nextCycleSnapshot.exists()) {
      nextCycle = normalizeCycle(
        nextCycleSnapshot.data() as Partial<FantasyCycle>,
        nextCycleNumber,
      );

      if (nextCycle.phase !== 'regular_season') {
        throw new Error(`Cycle ${nextCycleNumber} already exists as a playoff period.`);
      }

      existingAssignedWindowCount = nextCycle.activeWindowCount ?? 0;
    } else {
      const orderedOwnerIds = getOrderedOwnerIds(teams, draft);
      const pairings = createCyclePairings(orderedOwnerIds, nextCycleNumber);
      const matchupIds: string[] = [];

      pairings.forEach((pairing, index) => {
        const matchupId = `matchup-${index + 1}`;
        matchupIds.push(matchupId);

        transaction.set(getCycleMatchupRef(leagueId, nextCycleNumber, matchupId), {
          id: matchupId,
          cycleNumber: nextCycleNumber,
          phase: 'regular_season',
          bracketType: null,
          playoffRoundNumber: null,
          playoffMatchupId: null,
          teamASeed: null,
          teamBSeed: null,
          winnerPlace: null,
          loserPlace: null,
          tieBrokenByHigherSeed: false,
          teamAOwnerId: pairing.teamAOwnerId,
          teamBOwnerId: pairing.teamBOwnerId,
          teamAScore: 0,
          teamBScore: 0,
          winnerOwnerId: null,
          status: 'active',
          completedAt: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });

      nextCycle = {
        id: getCycleDocumentId(nextCycleNumber),
        cycleNumber: nextCycleNumber,
        status: 'active',
        phase: 'regular_season',
        playoffRoundNumber: null,
        playoffRoundCount: null,
        playoffRoundLabel: null,
        matchupIds,
        windowSchemaVersion: 1,
        expectedRosterSlotIdsByOwner,
        parentCycleNumber: currentCycle.cycleNumber,
        overlapsPreviousCycle: true,
        totalExpectedWindowCount: countExpectedWindows(expectedRosterSlotIdsByOwner),
        activeWindowCount: 0,
        completedWindowCount: 0,
        matchupCompletionSchemaVersion: 1,
        totalMatchupCount: matchupIds.length,
        completedMatchupCount: 0,
        pendingMatchupCount: matchupIds.length,
        lastMatchupCompletedAt: null,
        standingsAppliedAt: null,
        projectionAccuracyStatus: 'pending',
        projectionAccuracyAssetCount: 0,
        projectionAccuracyProjectionVersions: [],
        projectionAccuracyUpdatedAt: null,
        completedAt: null,
      };

      transaction.set(nextCycleRef, {
        ...nextCycle,
        startedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    let newlyAssignedWindowCount = 0;
    const updatedRosterOwnerIds = new Set<string>();

    for (const [ownerId, slotIds] of Object.entries(openSlotRolloversByOwner)) {
      const roster = rostersByOwnerId.get(ownerId);

      if (!roster) {
        continue;
      }

      for (const slotId of slotIds) {
        const slotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === slotId);

        if (slotIndex < 0) {
          continue;
        }

        const slot = roster.activeSlots[slotIndex];

        // Re-check the authoritative roster inside the transaction. A user may
        // have filled this slot after the preflight read; never overwrite that.
        if (slot.asset || canActivatePendingMoveInCycle(slot.pendingMove, nextCycleNumber)) {
          continue;
        }

        roster.activeSlots[slotIndex] = {
          ...slot,
          openFromCycleNumber: nextCycleNumber,
        };
        updatedRosterOwnerIds.add(ownerId);
      }
    }

    nextPicks.forEach((pick, index) => {
      if (nextPickSnapshots[index]?.exists()) {
        return;
      }

      const rosterSlotId = getRosterSlotIdFromPick(pick);
      const slotKey = `${pick.ownerId}::${rosterSlotId}`;
      const activationPlan = activationPlansBySlotKey[slotKey] ?? null;

      if (activationPlan) {
        const roster = rostersByOwnerId.get(pick.ownerId);

        if (!roster) {
          throw new Error(
            `The roster for ${pick.ownerId} is missing while activating ${rosterSlotId}.`,
          );
        }

        const slotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === rosterSlotId);

        if (slotIndex === -1) {
          throw new Error(
            `Roster slot ${rosterSlotId} was not found while activating its queued move.`,
          );
        }

        const savedSlot = roster.activeSlots[slotIndex];
        const savedPendingMove = savedSlot.pendingMove;

        if (!savedPendingMove || savedPendingMove.id !== activationPlan.pendingMoveId) {
          throw new Error(
            `The queued move for ${rosterSlotId} changed before its slot boundary. Refresh and try again.`,
          );
        }

        const incomingAssetKey = getRosterAssetKey(savedPendingMove.incomingAsset);

        if (incomingAssetKey !== pick.asset.assetKey) {
          throw new Error(
            `The queued asset for ${rosterSlotId} no longer matches the next window snapshot.`,
          );
        }

        const outgoingAsset = savedSlot.asset;
        const sourceBenchSlotId = savedPendingMove.sourceBenchSlotId ?? null;

        if (sourceBenchSlotId) {
          const benchSlotIndex = roster.benchSlots.findIndex(
            (benchSlot) => benchSlot.slotId === sourceBenchSlotId,
          );

          if (benchSlotIndex === -1) {
            throw new Error(
              `Bench slot ${sourceBenchSlotId} was not found while activating ${rosterSlotId}.`,
            );
          }

          const benchSlot = roster.benchSlots[benchSlotIndex];
          if (getRosterAssetKey(benchSlot.asset) !== incomingAssetKey) {
            throw new Error(
              `The reserved bench asset for ${rosterSlotId} changed before activation.`,
            );
          }

          roster.benchSlots[benchSlotIndex] = {
            ...benchSlot,
            asset: outgoingAsset
              ? { ...outgoingAsset, rosterStatus: 'benched' }
              : null,
          };
        }

        roster.activeSlots[slotIndex] = {
          ...savedSlot,
          asset: { ...savedPendingMove.incomingAsset, rosterStatus: 'active' },
          pendingMove: null,
          openFromCycleNumber: null,
        };
        updatedRosterOwnerIds.add(pick.ownerId);

        if (!sourceBenchSlotId && outgoingAsset) {
          const outgoingAssetKey = getRosterAssetKey(outgoingAsset);

          if (outgoingAssetKey && outgoingAssetKey !== incomingAssetKey) {
            transaction.set(
              getWaiverRef(leagueId, outgoingAssetKey),
              buildActivatedDropWaiverPayload(outgoingAsset, pick.ownerId, nextCycleNumber),
            );
          }
        }

        if (savedPendingMove.sourceWaiverId) {
          transaction.set(
            getWaiverRef(leagueId, savedPendingMove.sourceWaiverId),
            {
              effectiveCycleNumber: nextCycleNumber,
              effectiveLabel: `Cycle ${nextCycleNumber}`,
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        }

        transaction.set(doc(getTransactionsRef(leagueId)), {
          type: sourceBenchSlotId ? 'active-bench-swap-activated' : 'slot-move-activated',
          ownerId: pick.ownerId,
          addedAsset: rosterAssetToDraftableAsset(savedPendingMove.incomingAsset),
          droppedAsset: outgoingAsset,
          waiverId: !sourceBenchSlotId && outgoingAsset ? getRosterAssetKey(outgoingAsset) : null,
          benchSlotId: sourceBenchSlotId,
          rosterSlotId,
          targetSlotId: rosterSlotId,
          queuedMoveId: savedPendingMove.id,
          effectiveCycleNumber: nextCycleNumber,
          effectiveLabel: `Cycle ${nextCycleNumber}`,
          createdAt: serverTimestamp(),
        });
      }

      newlyAssignedWindowCount += 1;
      transaction.set(nextPickRefs[index], {
        ...pick,
        snapshotCycleNumber: nextCycleNumber,
        snapshotSource: activationPlan ? 'queued-slot-move' : 'slot-window-advance',
        snapshottedAt: serverTimestamp(),
      });
    });

    for (const ownerId of updatedRosterOwnerIds) {
      const roster = rostersByOwnerId.get(ownerId);

      if (!roster) {
        continue;
      }

      transaction.set(
        getTeamRosterRef(leagueId, ownerId),
        {
          schemaVersion: roster.schemaVersion,
          activeSlots: roster.activeSlots,
          benchSlots: roster.benchSlots,
          irSlots: roster.irSlots,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }

    transaction.set(
      nextCycleRef,
      {
        windowSchemaVersion: 1,
        expectedRosterSlotIdsByOwner,
        parentCycleNumber: currentCycle.cycleNumber,
        overlapsPreviousCycle: true,
        totalExpectedWindowCount: countExpectedWindows(expectedRosterSlotIdsByOwner),
        activeWindowCount: existingAssignedWindowCount + newlyAssignedWindowCount,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(
      currentCycleRef,
      {
        windowSchemaVersion: 1,
        expectedRosterSlotIdsByOwner: currentExpectedRosterSlotIdsByOwner,
        totalExpectedWindowCount: countExpectedWindows(currentExpectedRosterSlotIdsByOwner),
        activeWindowCount: currentPicks.length,
        completedWindowCount: currentCompletedWindowCount,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    return {
      ...nextCycle,
      activeWindowCount: existingAssignedWindowCount + newlyAssignedWindowCount,
    };
  });
}

/**
 * Reconciles regular-season matchup completion from the persisted per-team
 * slot-window documents. A matchup becomes final as soon as every expected
 * slot for both teams is complete. The league cycle remains active until all
 * matchups are final, at which point standings are applied exactly once in the
 * same transaction.
 */
export async function reconcileRegularSeasonCycleMatchupCompletion(
  leagueId: string,
  cycleNumber: number,
): Promise<CycleMatchupCompletionResult> {
  const cycleRef = getCycleRef(leagueId, cycleNumber);

  return runTransaction(db, async (transaction) => {
    const cycleSnapshot = await transaction.get(cycleRef);

    if (!cycleSnapshot.exists()) {
      throw new Error(`Cycle ${cycleNumber} has not been started yet.`);
    }

    const cycle = normalizeCycle(cycleSnapshot.data() as Partial<FantasyCycle>, cycleNumber);
    const matchupIds = [...new Set(cycle.matchupIds)];
    const totalMatchupCount = matchupIds.length;

    if (cycle.phase !== 'regular_season') {
      return {
        newlyCompletedMatchupIds: [],
        completedMatchupCount: cycle.completedMatchupCount ?? 0,
        totalMatchupCount,
        pendingMatchupCount: Math.max(0, totalMatchupCount - (cycle.completedMatchupCount ?? 0)),
        cycleCompleted: cycle.status === 'complete',
      };
    }

    if (cycle.status === 'complete') {
      return {
        newlyCompletedMatchupIds: [],
        completedMatchupCount: cycle.completedMatchupCount ?? totalMatchupCount,
        totalMatchupCount,
        pendingMatchupCount: 0,
        cycleCompleted: true,
      };
    }

    if (totalMatchupCount === 0) {
      throw new Error(`Cycle ${cycleNumber} does not have any matchups to reconcile.`);
    }

    const matchupRefs = matchupIds.map((matchupId) =>
      getCycleMatchupRef(leagueId, cycleNumber, matchupId),
    );
    const matchupSnapshots = await Promise.all(
      matchupRefs.map((matchupRef) => transaction.get(matchupRef)),
    );
    const savedMatchups = matchupSnapshots.map((snapshot, index) => {
      if (!snapshot.exists()) {
        throw new Error(`Cycle ${cycleNumber} matchup ${matchupIds[index]} is missing.`);
      }

      return normalizeMatchup(snapshot.data() as Partial<FantasyMatchup>);
    });
    const ownerIds = [
      ...new Set(
        savedMatchups.flatMap((matchup) => [
          matchup.teamAOwnerId,
          ...(matchup.teamBOwnerId ? [matchup.teamBOwnerId] : []),
        ]),
      ),
    ];
    const teamWindowRefs = ownerIds.map((ownerId) =>
      getCycleTeamWindowsRef(leagueId, cycleNumber, ownerId),
    );
    const teamWindowSnapshots = await Promise.all(
      teamWindowRefs.map((teamWindowRef) => transaction.get(teamWindowRef)),
    );
    const teamWindowsByOwnerId = new Map(
      ownerIds.map((ownerId, index) => {
        const snapshot = teamWindowSnapshots[index];

        return [
          ownerId,
          snapshot.exists()
            ? normalizeFantasyTeamCycleWindows(ownerId, cycleNumber, snapshot.data() ?? {})
            : null,
        ] as const;
      }),
    );
    const completedAssetWindowCount = [...teamWindowsByOwnerId.values()]
      .filter((teamWindows) => Boolean(teamWindows))
      .reduce((total, teamWindows) => total + (teamWindows?.completedWindowCount ?? 0), 0);
    const effectiveMatchups: FantasyMatchup[] = [];
    const newlyCompletedMatchupIds: string[] = [];

    for (let index = 0; index < savedMatchups.length; index += 1) {
      const matchup = savedMatchups[index];

      if (matchup.status === 'complete') {
        effectiveMatchups.push(matchup);
        continue;
      }

      const teamAWindows = teamWindowsByOwnerId.get(matchup.teamAOwnerId);
      const teamBWindows = matchup.teamBOwnerId
        ? teamWindowsByOwnerId.get(matchup.teamBOwnerId)
        : null;
      const teamAComplete = isFantasyTeamCycleWindowsComplete(teamAWindows);
      const teamBComplete = matchup.teamBOwnerId
        ? isFantasyTeamCycleWindowsComplete(teamBWindows)
        : true;

      if (!teamAComplete || !teamBComplete) {
        effectiveMatchups.push(matchup);
        continue;
      }

      const teamAScore = roundScore(getFantasyTeamCycleWindowScore(teamAWindows));
      const teamBScore = matchup.teamBOwnerId
        ? roundScore(getFantasyTeamCycleWindowScore(teamBWindows))
        : 0;
      const winnerOwnerId = getMatchupWinnerOwnerId(
        matchup.teamAOwnerId,
        matchup.teamBOwnerId,
        teamAScore,
        teamBScore,
      );
      const completedMatchup: FantasyMatchup = {
        ...matchup,
        teamAScore,
        teamBScore,
        winnerOwnerId,
        status: 'complete',
      };

      transaction.update(matchupRefs[index], {
        teamAScore,
        teamBScore,
        winnerOwnerId,
        status: 'complete',
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      newlyCompletedMatchupIds.push(matchup.id);
      effectiveMatchups.push(completedMatchup);
    }

    const completedMatchupCount = effectiveMatchups.filter(
      (matchup) => matchup.status === 'complete',
    ).length;
    const pendingMatchupCount = Math.max(0, totalMatchupCount - completedMatchupCount);
    const cycleCompleted = totalMatchupCount > 0 && pendingMatchupCount === 0;

    if (cycleCompleted) {
      if (!cycle.standingsAppliedAt) {
        const recordDeltas: Record<
          string,
          {
            wins: number;
            losses: number;
            ties: number;
            pointsFor: number;
            pointsAgainst: number;
          }
        > = {};

        function ensureRecordDelta(ownerId: string): void {
          recordDeltas[ownerId] ??= {
            wins: 0,
            losses: 0,
            ties: 0,
            pointsFor: 0,
            pointsAgainst: 0,
          };
        }

        for (const matchup of effectiveMatchups) {
          if (!matchup.teamBOwnerId) {
            continue;
          }

          ensureRecordDelta(matchup.teamAOwnerId);
          ensureRecordDelta(matchup.teamBOwnerId);
          recordDeltas[matchup.teamAOwnerId].pointsFor += matchup.teamAScore;
          recordDeltas[matchup.teamAOwnerId].pointsAgainst += matchup.teamBScore;
          recordDeltas[matchup.teamBOwnerId].pointsFor += matchup.teamBScore;
          recordDeltas[matchup.teamBOwnerId].pointsAgainst += matchup.teamAScore;

          if (matchup.teamAScore === matchup.teamBScore) {
            recordDeltas[matchup.teamAOwnerId].ties += 1;
            recordDeltas[matchup.teamBOwnerId].ties += 1;
            continue;
          }

          if (matchup.winnerOwnerId === matchup.teamAOwnerId) {
            recordDeltas[matchup.teamAOwnerId].wins += 1;
            recordDeltas[matchup.teamBOwnerId].losses += 1;
          } else {
            recordDeltas[matchup.teamBOwnerId].wins += 1;
            recordDeltas[matchup.teamAOwnerId].losses += 1;
          }
        }

        for (const [ownerId, delta] of Object.entries(recordDeltas)) {
          const teamUpdate: Record<string, unknown> = {
            updatedAt: serverTimestamp(),
          };

          if (delta.wins !== 0) {
            teamUpdate['wins'] = increment(delta.wins);
          }

          if (delta.losses !== 0) {
            teamUpdate['losses'] = increment(delta.losses);
          }

          if (delta.ties !== 0) {
            teamUpdate['ties'] = increment(delta.ties);
          }

          if (delta.pointsFor !== 0) {
            teamUpdate['pointsFor'] = increment(roundScore(delta.pointsFor));
          }

          if (delta.pointsAgainst !== 0) {
            teamUpdate['pointsAgainst'] = increment(roundScore(delta.pointsAgainst));
          }

          transaction.update(getTeamRef(leagueId, ownerId), teamUpdate);
        }
      }

      transaction.update(cycleRef, {
        status: 'complete',
        matchupCompletionSchemaVersion: 1,
        totalMatchupCount,
        completedMatchupCount,
        pendingMatchupCount: 0,
        completedWindowCount: completedAssetWindowCount,
        lastMatchupCompletedAt:
          newlyCompletedMatchupIds.length > 0
            ? serverTimestamp()
            : (cycle.lastMatchupCompletedAt ?? serverTimestamp()),
        standingsAppliedAt: cycle.standingsAppliedAt ?? serverTimestamp(),
        projectionAccuracyStatus: 'pending',
        projectionAccuracyAssetCount: 0,
        projectionAccuracyProjectionVersions: [],
        projectionAccuracyUpdatedAt: null,
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (
      newlyCompletedMatchupIds.length > 0 ||
      cycle.matchupCompletionSchemaVersion !== 1 ||
      cycle.totalMatchupCount !== totalMatchupCount ||
      cycle.completedMatchupCount !== completedMatchupCount ||
      cycle.pendingMatchupCount !== pendingMatchupCount ||
      cycle.completedWindowCount !== completedAssetWindowCount
    ) {
      transaction.update(cycleRef, {
        matchupCompletionSchemaVersion: 1,
        totalMatchupCount,
        completedMatchupCount,
        pendingMatchupCount,
        completedWindowCount: completedAssetWindowCount,
        ...(newlyCompletedMatchupIds.length > 0
          ? { lastMatchupCompletedAt: serverTimestamp() }
          : {}),
        updatedAt: serverTimestamp(),
      });
    }

    return {
      newlyCompletedMatchupIds,
      completedMatchupCount,
      totalMatchupCount,
      pendingMatchupCount,
      cycleCompleted,
    };
  });
}

export async function updateCycleMatchupScores(
  leagueId: string,
  cycleNumber: number,
  matchups: FantasyMatchup[],
  teamScores: Record<string, number>,
): Promise<void> {
  if (matchups.length === 0) {
    throw new Error(`No Cycle ${cycleNumber} matchups were found to update.`);
  }

  const batch = writeBatch(db);
  let changedMatchupCount = 0;

  for (const matchup of matchups) {
    // Once a matchup is finalized from completed slot windows, later score
    // refreshes must not mutate its locked result while other league matchups
    // are still finishing the same cycle.
    if (matchup.status === 'complete') {
      continue;
    }

    const teamAScore = roundScore(teamScores[matchup.teamAOwnerId] ?? 0);

    const teamBScore = roundScore(
      matchup.teamBOwnerId ? (teamScores[matchup.teamBOwnerId] ?? 0) : 0,
    );

    if (
      roundScore(matchup.teamAScore ?? 0) === teamAScore &&
      roundScore(matchup.teamBScore ?? 0) === teamBScore
    ) {
      continue;
    }

    changedMatchupCount += 1;

    batch.update(getCycleMatchupRef(leagueId, cycleNumber, matchup.id), {
      teamAScore,
      teamBScore,
      updatedAt: serverTimestamp(),
    });
  }

  if (changedMatchupCount === 0) {
    return;
  }

  batch.update(getCycleRef(leagueId, cycleNumber), {
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
}

export async function completeCycle(
  leagueId: string,
  cycleNumber: number,
  matchups: FantasyMatchup[],
  teamScores: Record<string, number>,
): Promise<void> {
  if (matchups.length === 0) {
    throw new Error(`No Cycle ${cycleNumber} matchups were found to complete.`);
  }

  const cycleRef = getCycleRef(leagueId, cycleNumber);
  const playoffsRef = getFantasyPlayoffsRef(leagueId);

  await runTransaction(db, async (transaction) => {
    const cycleSnapshot = await transaction.get(cycleRef);

    if (!cycleSnapshot.exists()) {
      throw new Error(`Cycle ${cycleNumber} has not been started yet.`);
    }

    const cycle = normalizeCycle(cycleSnapshot.data() as Partial<FantasyCycle>, cycleNumber);

    if (cycle.status === 'complete') {
      throw new Error(`Cycle ${cycleNumber} has already been completed.`);
    }

    if (cycle.status !== 'active') {
      throw new Error('Only an active cycle can be completed.');
    }

    if (cycle.phase === 'playoffs') {
      const playoffsSnapshot = await transaction.get(playoffsRef);

      if (!playoffsSnapshot.exists()) {
        throw new Error('The playoff bracket could not be found.');
      }

      const playoffs = normalizeFantasyPlayoffs(
        playoffsSnapshot.data() as Partial<FantasyPlayoffs>,
      );
      const roundNumber = cycle.playoffRoundNumber;

      if (roundNumber === null || roundNumber === undefined) {
        throw new Error('The playoff round number is missing from this cycle.');
      }

      if (playoffs.status === 'complete') {
        throw new Error('The fantasy playoffs have already been completed.');
      }

      if (playoffs.currentRoundNumber !== roundNumber) {
        throw new Error(
          'The playoff bracket has already advanced. Refresh the page and try again.',
        );
      }

      const results: FantasyPlayoffRoundResult[] = [];

      for (const matchup of matchups) {
        if (!matchup.teamBOwnerId) {
          throw new Error(`Playoff matchup ${matchup.id} does not have two teams.`);
        }

        const teamAScore = roundScore(teamScores[matchup.teamAOwnerId] ?? matchup.teamAScore ?? 0);
        const teamBScore = roundScore(teamScores[matchup.teamBOwnerId] ?? matchup.teamBScore ?? 0);
        const winner = getPlayoffWinner(matchup, teamAScore, teamBScore);

        results.push({
          matchupId: matchup.playoffMatchupId ?? matchup.id,
          teamAScore,
          teamBScore,
          winnerOwnerId: winner.winnerOwnerId,
          loserOwnerId: winner.loserOwnerId,
          tieBrokenByHigherSeed: winner.tieBrokenByHigherSeed,
        });

        transaction.update(getCycleMatchupRef(leagueId, cycleNumber, matchup.id), {
          teamAScore,
          teamBScore,
          winnerOwnerId: winner.winnerOwnerId,
          tieBrokenByHigherSeed: winner.tieBrokenByHigherSeed,
          status: 'complete',
          completedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const updatedPlayoffs = applyPlayoffRoundResults(playoffs, roundNumber, results);

      transaction.set(
        playoffsRef,
        {
          ...updatedPlayoffs,
          updatedAt: serverTimestamp(),
          ...(updatedPlayoffs.status === 'complete' ? { completedAt: serverTimestamp() } : {}),
        },
        { merge: true },
      );

      transaction.update(cycleRef, {
        status: 'complete',
        matchupCompletionSchemaVersion: 1,
        totalMatchupCount: matchups.length,
        completedMatchupCount: matchups.length,
        pendingMatchupCount: 0,
        lastMatchupCompletedAt: serverTimestamp(),
        projectionAccuracyStatus: 'pending',
        projectionAccuracyAssetCount: 0,
        projectionAccuracyProjectionVersions: [],
        projectionAccuracyUpdatedAt: null,
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      return;
    }

    const recordDeltas: Record<
      string,
      {
        wins: number;
        losses: number;
        ties: number;
        pointsFor: number;
        pointsAgainst: number;
      }
    > = {};

    function ensureRecordDelta(ownerId: string): void {
      recordDeltas[ownerId] ??= {
        wins: 0,
        losses: 0,
        ties: 0,
        pointsFor: 0,
        pointsAgainst: 0,
      };
    }

    function addWin(ownerId: string): void {
      ensureRecordDelta(ownerId);
      recordDeltas[ownerId].wins += 1;
    }

    function addLoss(ownerId: string): void {
      ensureRecordDelta(ownerId);
      recordDeltas[ownerId].losses += 1;
    }

    function addTie(ownerId: string): void {
      ensureRecordDelta(ownerId);
      recordDeltas[ownerId].ties += 1;
    }

    function addPoints(ownerId: string, pointsFor: number, pointsAgainst: number): void {
      ensureRecordDelta(ownerId);
      recordDeltas[ownerId].pointsFor += pointsFor;
      recordDeltas[ownerId].pointsAgainst += pointsAgainst;
    }

    for (const matchup of matchups) {
      const teamAScore = roundScore(teamScores[matchup.teamAOwnerId] ?? matchup.teamAScore ?? 0);
      const teamBScore = roundScore(
        matchup.teamBOwnerId ? (teamScores[matchup.teamBOwnerId] ?? matchup.teamBScore ?? 0) : 0,
      );
      const winnerOwnerId = getMatchupWinnerOwnerId(
        matchup.teamAOwnerId,
        matchup.teamBOwnerId,
        teamAScore,
        teamBScore,
      );

      transaction.update(getCycleMatchupRef(leagueId, cycleNumber, matchup.id), {
        teamAScore,
        teamBScore,
        winnerOwnerId,
        status: 'complete',
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // A scheduled bye is neutral: it does not create a win, loss,
      // tie, Points For, or Points Against.
      if (!matchup.teamBOwnerId) {
        continue;
      }

      addPoints(matchup.teamAOwnerId, teamAScore, teamBScore);
      addPoints(matchup.teamBOwnerId, teamBScore, teamAScore);

      if (teamAScore === teamBScore) {
        addTie(matchup.teamAOwnerId);
        addTie(matchup.teamBOwnerId);
        continue;
      }

      if (winnerOwnerId === matchup.teamAOwnerId) {
        addWin(matchup.teamAOwnerId);
        addLoss(matchup.teamBOwnerId);
      } else {
        addWin(matchup.teamBOwnerId);
        addLoss(matchup.teamAOwnerId);
      }
    }

    for (const [ownerId, delta] of Object.entries(recordDeltas)) {
      const teamUpdate: Record<string, unknown> = {
        updatedAt: serverTimestamp(),
      };

      if (delta.wins !== 0) {
        teamUpdate['wins'] = increment(delta.wins);
      }

      if (delta.losses !== 0) {
        teamUpdate['losses'] = increment(delta.losses);
      }

      if (delta.ties !== 0) {
        teamUpdate['ties'] = increment(delta.ties);
      }

      if (delta.pointsFor !== 0) {
        teamUpdate['pointsFor'] = increment(roundScore(delta.pointsFor));
      }

      if (delta.pointsAgainst !== 0) {
        teamUpdate['pointsAgainst'] = increment(roundScore(delta.pointsAgainst));
      }

      transaction.update(getTeamRef(leagueId, ownerId), teamUpdate);
    }

    transaction.update(cycleRef, {
      status: 'complete',
      matchupCompletionSchemaVersion: 1,
      totalMatchupCount: matchups.length,
      completedMatchupCount: matchups.length,
      pendingMatchupCount: 0,
      lastMatchupCompletedAt: serverTimestamp(),
      standingsAppliedAt: serverTimestamp(),
      projectionAccuracyStatus: 'pending',
      projectionAccuracyAssetCount: 0,
      projectionAccuracyProjectionVersions: [],
      projectionAccuracyUpdatedAt: null,
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

export function listenToCycleOne(
  leagueId: string,
  callback: (cycle: FantasyCycle | null) => void,
): () => void {
  return listenToCycle(leagueId, FIRST_CYCLE_NUMBER, callback);
}

export function listenToCycleOneMatchups(
  leagueId: string,
  callback: (matchups: FantasyMatchup[]) => void,
): () => void {
  return listenToCycleMatchups(leagueId, FIRST_CYCLE_NUMBER, callback);
}

export async function startCycleOne(leagueId: string, teams: FantasyTeam[]): Promise<FantasyCycle> {
  return startCycle(leagueId, teams, FIRST_CYCLE_NUMBER);
}

export async function updateCycleOneMatchupScores(
  leagueId: string,
  matchups: FantasyMatchup[],
  teamScores: Record<string, number>,
): Promise<void> {
  return updateCycleMatchupScores(leagueId, FIRST_CYCLE_NUMBER, matchups, teamScores);
}

export async function completeCycleOne(
  leagueId: string,
  matchups: FantasyMatchup[],
  teamScores: Record<string, number>,
): Promise<void> {
  return completeCycle(leagueId, FIRST_CYCLE_NUMBER, matchups, teamScores);
}
