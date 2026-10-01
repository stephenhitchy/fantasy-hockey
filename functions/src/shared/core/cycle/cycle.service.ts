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

import {
  FantasyAssetCycleWindow,
  FantasyCycle,
  FantasyMatchup,
} from './cycle.models';

import { CycleScoringResult } from './cycle-scoring.service';

import {
  getCycleTeamWindowsRef,
  getFantasyTeamCycleWindowScore,
  isFantasyTeamCycleWindowsComplete,
  normalizeFantasyTeamCycleWindows,
} from './asset-cycle-window.service';

import { FantasyTeam } from '../team/team.service';

import {
  DraftableAsset,
  DraftPick,
  DraftProjection,
  FantasyDraft,
  PlayerWindowContinuity,
} from '../draft/draft.models';

import { FantasyRoster, PendingRosterSlotMove, RosterAsset } from '../team/roster.models';

import { normalizeFantasyRoster } from '../team/roster.service';

import {
  getAnchoredRegularSeasonCycleCount,
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
  WindowProjectionRefreshPolicy,
} from '../projection/window-projection.service';

import { defaultScoringRules } from '../scoring/scoring-rules';
import {
  buildSourceNhlTargetGameIdsByTeam,
  resolveSourceNhlBlockNumber,
} from './cycle-window-selection.util';
import {
  advancePlayerWindowContinuity,
  createPlayerWindowContinuity,
  mergeLegacyPlayerWindowContinuityCopies,
  PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
  reconstructLegacyPlayerWindowContinuity,
  resolveConsistentPlayerWindowContinuity,
  resolvePlayerWindowContinuity,
} from './player-window-continuity.util';

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

function getAssetTeamAbbreviation(asset: DraftableAsset | RosterAsset): string {
  return (
    asset.assetType === 'skater'
      ? asset.player.nhlTeamAbbreviation
      : asset.teamAbbreviation
  ).trim().toUpperCase();
}

function normalizeSourceNhlTargetGameIdsByTeam(
  value: unknown,
): Record<string, number[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([teamAbbreviation, gameIds]) => [
        teamAbbreviation.trim().toUpperCase(),
        Array.isArray(gameIds)
          ? gameIds.filter(
              (gameId): gameId is number =>
                typeof gameId === 'number' && Number.isInteger(gameId) && gameId > 0,
            )
          : [],
      ] as const)
      .filter(([teamAbbreviation, gameIds]) => teamAbbreviation.length > 0 && gameIds.length > 0),
  );
}

function getDraftSourceNhlBlockNumber(
  draft: FantasyDraft,
  fantasyCycleNumber: number,
): number {
  const initialNhlBlockNumber = resolveSourceNhlBlockNumber(
    draft.initialNhlBlockNumber,
    FIRST_CYCLE_NUMBER,
  );

  return initialNhlBlockNumber + Math.max(0, fantasyCycleNumber - FIRST_CYCLE_NUMBER);
}

function getDraftSourceNhlTargetGameIdsByTeam(
  draft: FantasyDraft,
  sourceNhlBlockNumber: number,
): Record<string, number[]> {
  const plannedTargets = buildSourceNhlTargetGameIdsByTeam(
    draft.seasonWindowSourceGameIdsByTeam,
    sourceNhlBlockNumber,
    defaultScoringRules.requiredGamesPerCycle,
  );

  if (Object.keys(plannedTargets).length > 0) {
    const missingTeams = (draft.seasonWindowAnchorTeams ?? [])
      .map((team) => team.teamAbbreviation.trim().toUpperCase())
      .filter((teamAbbreviation) => !plannedTargets[teamAbbreviation]);

    if (missingTeams.length > 0) {
      throw new Error(
        `The frozen NHL source-game plan is missing club(s): ${missingTeams.join(', ')}.`,
      );
    }

    return plannedTargets;
  }

  const initialNhlBlockNumber = getDraftSourceNhlBlockNumber(draft, FIRST_CYCLE_NUMBER);

  if (sourceNhlBlockNumber === initialNhlBlockNumber) {
    const openingTargets = Object.fromEntries(
      (draft.seasonWindowAnchorTeams ?? []).map((team) => [
        team.teamAbbreviation.trim().toUpperCase(),
        team.targetGameIds.filter(
          (gameId) => Number.isInteger(gameId) && gameId > 0,
        ),
      ] as const),
    );

    if (
      draft.seasonWindowAnchorStatus === 'ready' &&
      (
        Object.keys(openingTargets).length === 0 ||
        Object.values(openingTargets).some(
          (gameIds) => gameIds.length !== defaultScoringRules.requiredGamesPerCycle,
        )
      )
    ) {
      throw new Error('The frozen opening NHL source-game evidence is incomplete.');
    }

    return openingTargets;
  }

  if (draft.seasonWindowAnchorStatus === 'ready') {
    throw new Error(
      `The frozen NHL source-game plan is unavailable for source block ${sourceNhlBlockNumber}.`,
    );
  }

  return {};
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
  const cycleNumber = data.cycleNumber ?? fallbackCycleNumber;

  return {
    id: data.id ?? getCycleDocumentId(fallbackCycleNumber),
    cycleNumber,
    sourceNhlBlockNumber: resolveSourceNhlBlockNumber(
      data.sourceNhlBlockNumber,
      cycleNumber,
    ),
    sourceNhlTargetGameIdsByTeam: normalizeSourceNhlTargetGameIdsByTeam(
      data.sourceNhlTargetGameIdsByTeam,
    ),
    status: data.status ?? 'active',
    phase: data.phase === 'playoffs' ? 'playoffs' : 'regular_season',
    playoffRoundNumber:
      typeof data.playoffRoundNumber === 'number' ? data.playoffRoundNumber : null,
    playoffRoundCount: typeof data.playoffRoundCount === 'number' ? data.playoffRoundCount : null,
    playoffRoundLabel: typeof data.playoffRoundLabel === 'string' ? data.playoffRoundLabel : null,
    matchupIds: Array.isArray(data.matchupIds) ? data.matchupIds : [],
    windowSchemaVersion:
      typeof data.windowSchemaVersion === 'number' ? data.windowSchemaVersion : 0,
    playerWindowContinuitySchemaVersion:
      typeof data.playerWindowContinuitySchemaVersion === 'number'
        ? data.playerWindowContinuitySchemaVersion
        : 0,
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
    prospectProjectionModelVersion: projection.prospectProjectionModelVersion ?? null,
    prospectEvidenceSnapshotId: projection.prospectEvidenceSnapshotId ?? null,
    prospectEvidenceAsOf: projection.prospectEvidenceAsOf ?? null,
    prospectEvidenceSource: projection.prospectEvidenceSource ?? null,
    prospectEvidenceConfidence: projection.prospectEvidenceConfidence ?? null,
    prospectTranslationConfidence: projection.prospectTranslationConfidence ?? null,
    prospectPriorWeight: projection.prospectPriorWeight ?? null,
    prospectNhlEvidenceWeight: projection.prospectNhlEvidenceWeight ?? null,
    prospectRoleLabel: projection.prospectRoleLabel ?? null,
    prospectRoleConfidence: projection.prospectRoleConfidence ?? null,
    prospectAppearanceProbability: projection.prospectAppearanceProbability ?? null,
    prospectExpectedAppearances: projection.prospectExpectedAppearances ?? null,
    prospectOpportunityAdjustment: projection.prospectOpportunityAdjustment ?? null,
    prospectMissingCategories: projection.prospectMissingCategories ?? null,
    prospectQualityFlags: projection.prospectQualityFlags ?? null,
    prospectEvidenceProvisional: projection.prospectEvidenceProvisional ?? null,
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
  targetSourceBlockNumber: number = targetCycleNumber,
  targetGameIdsByTeam: Readonly<Record<string, readonly number[]>> = {},
  seasonWindowAnchorEvidenceHash?: string | null,
  refreshPolicy: WindowProjectionRefreshPolicy = 'refresh-if-needed',
): Promise<Map<string, DraftableAsset>> {
  const bundle = await ensureWindowProjectionBundle({
    leagueId,
    teamCount,
    requiredGamesPerCycle: defaultScoringRules.requiredGamesPerCycle,
    targetCycleNumber,
    targetSourceBlockNumber,
    targetGameIdsByTeam,
    seasonWindowAnchorEvidenceHash:
      seasonWindowAnchorEvidenceHash?.trim() || undefined,
    refreshPolicy,
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
  sourceNhlBlockNumber: number,
  sourceNhlTargetGameIdsByTeam: Readonly<Record<string, number[]>> = {},
  seasonWindowAnchorEvidenceHash?: string | null,
  includedOwnerIds?: Set<string>,
  projectionRefreshPolicy: WindowProjectionRefreshPolicy = 'refresh-if-needed',
  continuityBySlotKey: ReadonlyMap<
    string,
    { assetKey: string; continuity: PlayerWindowContinuity }
  > = new Map(),
  activationPlansBySlotKey?: Record<string, PendingSlotActivationPlan>,
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
    loadWindowProjectionAssetsByKey(
      leagueId,
      teams.length,
      cycleNumber,
      sourceNhlBlockNumber,
      sourceNhlTargetGameIdsByTeam,
      seasonWindowAnchorEvidenceHash,
      projectionRefreshPolicy,
    ),
  ]);

  const snapshotPicks: DraftPick[] = [];

  for (const [teamIndex, rosterSnapshot] of rosterSnapshots.entries()) {
    const activeSlots = rosterSnapshot.roster?.activeSlots ?? [];

    for (const [slotIndex, slot] of activeSlots.entries()) {
      const pendingMoveReady = Boolean(
        activationPlansBySlotKey &&
        canActivatePendingMoveInCycle(slot.pendingMove, cycleNumber),
      );
      const rosterAsset = pendingMoveReady
        ? slot.pendingMove?.incomingAsset ?? slot.asset
        : slot.asset;

      if (!rosterAsset) {
        continue;
      }

      const assetKey = getRosterAssetKey(rosterAsset);

      if (!assetKey) {
        continue;
      }

      const matchingDraftPick =
        draftPickByOwnerAndAssetKey.get(`${rosterSnapshot.ownerId}::${assetKey}`) ?? null;
      const snapshotOrder =
        matchingDraftPick?.overallPick ?? 100000 + teamIndex * 100 + slotIndex + 1;
      const draftableAsset = createDraftableAssetFromRosterAsset(
        rosterAsset,
        projectionAssetsByKey.get(assetKey) ?? null,
        matchingDraftPick?.asset ?? null,
        cycleNumber,
      );
      const continuitySeed = continuityBySlotKey.get(
        `${rosterSnapshot.ownerId}::${slot.slotId}`,
      );
      const playerWindowContinuity = pendingMoveReady && slot.pendingMove
        ? createPlayerWindowContinuity({
            ownerId: rosterSnapshot.ownerId,
            rosterSlotId: slot.slotId,
            asset: draftableAsset,
            activationKey: `move-${slot.pendingMove.id}`,
          })
        : continuitySeed?.assetKey === draftableAsset.assetKey
          ? continuitySeed.continuity
          : createPlayerWindowContinuity({
              ownerId: rosterSnapshot.ownerId,
              rosterSlotId: slot.slotId,
              asset: draftableAsset,
              activationKey: `cycle-${cycleNumber}`,
            });

      snapshotPicks.push({
        overallPick: snapshotOrder,
        round: matchingDraftPick?.round ?? 0,
        pickInRound: matchingDraftPick?.pickInRound ?? slot.slotNumber,
        ownerId: rosterSnapshot.ownerId,
        rosterSlotId: slot.slotId,
        cycleWindowId: getCycleWindowId(rosterSnapshot.ownerId, slot.slotId, cycleNumber),
        snapshotCycleNumber: cycleNumber,
        sourceNhlBlockNumber,
        ...(sourceNhlTargetGameIdsByTeam[getAssetTeamAbbreviation(rosterAsset)]
          ? {
              sourceNhlTargetGameIds:
                sourceNhlTargetGameIdsByTeam[getAssetTeamAbbreviation(rosterAsset)],
            }
          : {}),
        sourceNhlTargetGameIdsByTeam: { ...sourceNhlTargetGameIdsByTeam },
        ...(playerWindowContinuity ? { playerWindowContinuity } : {}),
        snapshotOrder,
        asset: draftableAsset,
      });

      if (pendingMoveReady && slot.pendingMove && activationPlansBySlotKey) {
        activationPlansBySlotKey[
          `${rosterSnapshot.ownerId}::${slot.slotId}`
        ] = {
          ownerId: rosterSnapshot.ownerId,
          rosterSlotId: slot.slotId,
          pendingMoveId: slot.pendingMove.id,
          pendingMove: slot.pendingMove,
          outgoingAsset: slot.asset,
          incomingAsset: slot.pendingMove.incomingAsset,
        };
      }
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
    const {
      sourceNhlTargetGameIds,
      ...persistedPick
    } = pick;

    transaction.set(
      getCycleRosterSlotPickRef(leagueId, cycleNumber, pick.ownerId, getRosterSlotIdFromPick(pick)),
      {
        ...persistedPick,
        ...(sourceNhlTargetGameIds === undefined
          ? {}
          : { sourceNhlTargetGameIds }),
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

function fantasyAssetWindowOwnershipStarted(
  window: FantasyAssetCycleWindow,
): boolean {
  return (
    window.status === 'active' ||
    window.status === 'complete' ||
    window.startedAt !== undefined && window.startedAt !== null ||
    window.completedAt !== undefined && window.completedAt !== null ||
    window.completedGameIds.length > 0 ||
    window.liveGameIds.length > 0 ||
    window.appearanceGameIds.length > 0 ||
    (window.incompleteFinalGameIds?.length ?? 0) > 0 ||
    Object.values(window.gameStates).some(
      (state) => state === 'live' || state === 'final',
    )
  );
}

function requireCyclePlayerWindowContinuity(
  cycle: FantasyCycle,
  picks: readonly DraftPick[],
): void {
  if (
    (cycle.playerWindowContinuitySchemaVersion ?? 0) >
    PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION
  ) {
    throw new Error(
      `Cycle ${cycle.cycleNumber} uses unsupported player-window continuity ` +
      `schema ${cycle.playerWindowContinuitySchemaVersion}.`,
    );
  }

  for (const pick of picks) {
    if (pick.asset.assetType !== 'skater') {
      continue;
    }

    const rosterSlotId = getRosterSlotIdFromPick(pick);
    const continuity = resolvePlayerWindowContinuity({
      value: pick.playerWindowContinuity,
      ownerId: pick.ownerId,
      rosterSlotId,
      asset: pick.asset,
    });

    if (!continuity) {
      throw new Error(
        `Cycle ${cycle.cycleNumber} requires player-window continuity, but ` +
        `${pick.ownerId}/${rosterSlotId}/${pick.asset.assetKey} is missing it. ` +
        `Scoring was left unchanged and will retry.`,
      );
    }
  }
}

interface LegacyCycleWindowHistory {
  cycleNumber: number;
  picksBySlotKey: Map<string, DraftPick>;
  windowsByOwnerId: Map<string, ReturnType<typeof normalizeFantasyTeamCycleWindows>>;
}

/**
 * One-time mixed-version bridge for active regular-season cycles created
 * before per-slot continuity existed. The marker is committed only after all
 * skater picks have a cursor rebuilt from every contiguous, persisted started
 * assignment. Marked cycles never reinterpret a missing cursor as empty.
 */
export async function ensureCyclePlayerWindowContinuity(
  leagueId: string,
  cycle: FantasyCycle,
  loadedPicks?: DraftPick[],
): Promise<DraftPick[]> {
  let picks = loadedPicks ?? await getCycleRosterPicksOnce(
    leagueId,
    cycle.cycleNumber,
  );
  const schemaVersion = cycle.playerWindowContinuitySchemaVersion ?? 0;

  if (schemaVersion === PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION) {
    requireCyclePlayerWindowContinuity(cycle, picks);
    return picks;
  }

  if (schemaVersion > PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION) {
    requireCyclePlayerWindowContinuity(cycle, picks);
  }

  // Older playoff banks have separate persisted-window lineage. They remain
  // compatible and are not guessed by this regular-season migration.
  if (cycle.phase !== 'regular_season') {
    return picks;
  }

  const currentPickSnapshot = await getDocs(query(
    getCycleRosterPicksRef(leagueId, cycle.cycleNumber),
    orderBy('overallPick', 'asc'),
  ));
  const currentPickDocumentIdBySlotKey = new Map<string, string>();
  const currentPicks = currentPickSnapshot.docs.map((snapshot) => {
    const pick = snapshot.data() as DraftPick;
    const slotKey = `${pick.ownerId}::${getRosterSlotIdFromPick(pick)}`;

    if (currentPickDocumentIdBySlotKey.has(slotKey)) {
      throw new Error(
        `Cycle ${cycle.cycleNumber} contains duplicate roster snapshots for ${slotKey}.`,
      );
    }

    currentPickDocumentIdBySlotKey.set(slotKey, snapshot.id);
    return pick;
  });

  if (
    currentPicks.length !== picks.length ||
    currentPicks.some((pick) => {
      const slotKey = `${pick.ownerId}::${getRosterSlotIdFromPick(pick)}`;
      const loaded = picks.find(
        (candidate) =>
          `${candidate.ownerId}::${getRosterSlotIdFromPick(candidate)}` === slotKey,
      );

      return !loaded || loaded.asset.assetKey !== pick.asset.assetKey;
    })
  ) {
    throw new Error(
      `Cycle ${cycle.cycleNumber} roster snapshots changed during continuity bootstrap.`,
    );
  }

  picks = currentPicks;

  const skaterPicks = picks.filter(
    (pick) => pick.asset.assetType === 'skater',
  );
  const skaterOwnerIds = [...new Set(skaterPicks.map((pick) => pick.ownerId))];
  const currentTeamWindowSnapshots = await Promise.all(
    skaterOwnerIds.map((ownerId) =>
      getDoc(getCycleTeamWindowsRef(leagueId, cycle.cycleNumber, ownerId)),
    ),
  );
  const currentTeamWindowsByOwnerId = new Map(
    skaterOwnerIds.flatMap((ownerId, index) => {
      const snapshot = currentTeamWindowSnapshots[index];

      return snapshot?.exists()
        ? [[
            ownerId,
            normalizeFantasyTeamCycleWindows(
              ownerId,
              cycle.cycleNumber,
              snapshot.data()!,
            ),
          ] as const]
        : [];
    }),
  );
  const priorCycleNumbers = Array.from(
    { length: Math.max(0, cycle.cycleNumber - FIRST_CYCLE_NUMBER) },
    (_, index) => cycle.cycleNumber - index - 1,
  );
  const history: LegacyCycleWindowHistory[] = await Promise.all(
    priorCycleNumbers.map(async (cycleNumber) => {
      const [priorPicks, ...ownerWindowSnapshots] = await Promise.all([
        getCycleRosterPicksOnce(leagueId, cycleNumber),
        ...skaterOwnerIds.map((ownerId) =>
          getDoc(getCycleTeamWindowsRef(leagueId, cycleNumber, ownerId)),
        ),
      ]);
      const picksBySlotKey = new Map<string, DraftPick>();

      for (const pick of priorPicks) {
        const slotKey = `${pick.ownerId}::${getRosterSlotIdFromPick(pick)}`;

        if (picksBySlotKey.has(slotKey)) {
          throw new Error(
            `Cycle ${cycleNumber} contains duplicate roster snapshots for ${slotKey}.`,
          );
        }

        picksBySlotKey.set(slotKey, pick);
      }

      return {
        cycleNumber,
        picksBySlotKey,
        windowsByOwnerId: new Map(
          skaterOwnerIds.flatMap((ownerId, index) => {
            const snapshot = ownerWindowSnapshots[index];

            return snapshot?.exists()
              ? [[
                  ownerId,
                  normalizeFantasyTeamCycleWindows(
                    ownerId,
                    cycleNumber,
                    snapshot.data()!,
                  ),
                ] as const]
              : [];
          }),
        ),
      };
    }),
  );
  const assignmentsBySlotKey = new Map<
    string,
    Parameters<typeof reconstructLegacyPlayerWindowContinuity>[0]['assignmentsNewestFirst']
  >();
  const rebuiltBySlotKey = new Map<string, PlayerWindowContinuity>();

  for (const pick of skaterPicks) {
    const rosterSlotId = getRosterSlotIdFromPick(pick);
    const slotKey = `${pick.ownerId}::${rosterSlotId}`;
    const assignments: Array<
      NonNullable<
        Parameters<typeof reconstructLegacyPlayerWindowContinuity>[0]['assignmentsNewestFirst'][number]
      > | null
    > = [];

    const currentSnapshotStartsNewStint =
      pick.snapshotSource?.toLowerCase().includes('move') === true;

    for (const prior of currentSnapshotStartsNewStint ? [] : history) {
      const priorPick = prior.picksBySlotKey.get(slotKey);

      if (!priorPick || priorPick.asset.assetKey !== pick.asset.assetKey) {
        assignments.push(null);
        break;
      }

      const teamWindows = prior.windowsByOwnerId.get(pick.ownerId);
      const window = teamWindows?.windows.find(
        (candidate) => candidate.rosterSlotId === rosterSlotId,
      );

      if (!window || window.assetKey !== priorPick.asset.assetKey) {
        throw new Error(
          `Legacy player-window history is missing the Cycle ${prior.cycleNumber} ` +
          `assignment for ${slotKey}/${priorPick.asset.assetKey}.`,
        );
      }

      const savedContinuity = mergeLegacyPlayerWindowContinuityCopies({
        values: [
          priorPick.playerWindowContinuity,
          window.playerWindowContinuity,
        ],
        ownerId: pick.ownerId,
        rosterSlotId,
        asset: priorPick.asset,
      });

      assignments.push({
        cycleNumber: prior.cycleNumber,
        asset: priorPick.asset,
        scheduledGameIds: window.scheduledGameIds,
        scheduleTeamAbbreviation: window.scheduleTeamAbbreviation,
        ownershipStarted: fantasyAssetWindowOwnershipStarted(window),
        ...(savedContinuity
          ? { playerWindowContinuity: savedContinuity }
          : {}),
        ...(priorPick.snapshotSource
          ? { snapshotSource: priorPick.snapshotSource }
          : {}),
      });
    }

    assignmentsBySlotKey.set(slotKey, assignments);
    const currentWindow = currentTeamWindowsByOwnerId
      .get(pick.ownerId)
      ?.windows.find((window) => window.rosterSlotId === rosterSlotId);

    if (currentWindow && currentWindow.assetKey !== pick.asset.assetKey) {
      throw new Error(
        `Cycle ${cycle.cycleNumber} window and roster snapshot disagree for ${slotKey}.`,
      );
    }

    const currentContinuity = mergeLegacyPlayerWindowContinuityCopies({
      values: [
        pick.playerWindowContinuity,
        currentWindow?.playerWindowContinuity,
      ],
      ownerId: pick.ownerId,
      rosterSlotId,
      asset: pick.asset,
    });
    const rebuilt = reconstructLegacyPlayerWindowContinuity({
      ownerId: pick.ownerId,
      rosterSlotId,
      currentCycleNumber: cycle.cycleNumber,
      currentAsset: pick.asset,
      currentContinuity,
      currentSnapshotSource: pick.snapshotSource,
      assignmentsNewestFirst: assignments,
    });

    if (!rebuilt) {
      throw new Error(
        `Unable to rebuild player-window continuity for ${slotKey}/${pick.asset.assetKey}.`,
      );
    }

    rebuiltBySlotKey.set(slotKey, rebuilt);
  }

  const cycleRef = getCycleRef(leagueId, cycle.cycleNumber);
  const pickRefs = picks.map((pick) =>
    doc(
      getCycleRosterPicksRef(leagueId, cycle.cycleNumber),
      currentPickDocumentIdBySlotKey.get(
        `${pick.ownerId}::${getRosterSlotIdFromPick(pick)}`,
      )!,
    ),
  );
  const currentTeamWindowRefs = skaterOwnerIds.map((ownerId) =>
    getCycleTeamWindowsRef(leagueId, cycle.cycleNumber, ownerId),
  );

  return runTransaction(db, async (transaction) => {
    const snapshots = await Promise.all([
      transaction.get(cycleRef),
      ...pickRefs.map((pickRef) => transaction.get(pickRef)),
      ...currentTeamWindowRefs.map((windowRef) => transaction.get(windowRef)),
    ]);
    const savedCycleSnapshot = snapshots[0];
    const savedPickSnapshots = snapshots.slice(1, 1 + pickRefs.length);
    const savedTeamWindowSnapshots = snapshots.slice(1 + pickRefs.length);

    if (!savedCycleSnapshot.exists()) {
      throw new Error(`Cycle ${cycle.cycleNumber} no longer exists.`);
    }

    const savedCycle = normalizeCycle(
      savedCycleSnapshot.data() as Partial<FantasyCycle>,
      cycle.cycleNumber,
    );
    const savedPicks = savedPickSnapshots.map((snapshot, index) => {
      if (!snapshot.exists()) {
        throw new Error(
          `Cycle ${cycle.cycleNumber} roster snapshot changed during continuity bootstrap.`,
        );
      }

      const savedPick = snapshot.data() as DraftPick;
      const expectedPick = picks[index];

      if (
        savedPick.ownerId !== expectedPick.ownerId ||
        getRosterSlotIdFromPick(savedPick) !== getRosterSlotIdFromPick(expectedPick) ||
        savedPick.asset.assetKey !== expectedPick.asset.assetKey
      ) {
        throw new Error(
          `Cycle ${cycle.cycleNumber} roster snapshot changed during continuity bootstrap.`,
        );
      }

      return savedPick;
    });

    if (
      savedCycle.playerWindowContinuitySchemaVersion ===
      PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION
    ) {
      requireCyclePlayerWindowContinuity(savedCycle, savedPicks);
      return savedPicks;
    }

    if (
      (savedCycle.playerWindowContinuitySchemaVersion ?? 0) >
      PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION
    ) {
      requireCyclePlayerWindowContinuity(savedCycle, savedPicks);
    }

    const savedTeamWindowsByOwnerId = new Map(
      skaterOwnerIds.flatMap((ownerId, index) => {
        const snapshot = savedTeamWindowSnapshots[index];

        return snapshot?.exists()
          ? [[
              ownerId,
              normalizeFantasyTeamCycleWindows(
                ownerId,
                cycle.cycleNumber,
                snapshot.data()!,
              ),
            ] as const]
          : [];
      }),
    );
    const updatedTeamWindowsByOwnerId = new Map(savedTeamWindowsByOwnerId);
    const updatedPicks = savedPicks.map((savedPick, index) => {
      if (savedPick.asset.assetType !== 'skater') {
        return savedPick;
      }

      const rosterSlotId = getRosterSlotIdFromPick(savedPick);
      const slotKey = `${savedPick.ownerId}::${rosterSlotId}`;
      const savedTeamWindows = updatedTeamWindowsByOwnerId.get(savedPick.ownerId);
      const savedWindowIndex = savedTeamWindows?.windows.findIndex(
        (window) => window.rosterSlotId === rosterSlotId,
      ) ?? -1;
      const savedWindow = savedWindowIndex >= 0
        ? savedTeamWindows?.windows[savedWindowIndex]
        : undefined;

      if (savedWindow && savedWindow.assetKey !== savedPick.asset.assetKey) {
        throw new Error(
          `Cycle ${cycle.cycleNumber} window and roster snapshot changed for ${slotKey}.`,
        );
      }

      const savedCurrentContinuity = mergeLegacyPlayerWindowContinuityCopies({
        values: [
          savedPick.playerWindowContinuity,
          savedWindow?.playerWindowContinuity,
        ],
        ownerId: savedPick.ownerId,
        rosterSlotId,
        asset: savedPick.asset,
      });
      const rebuilt = reconstructLegacyPlayerWindowContinuity({
        ownerId: savedPick.ownerId,
        rosterSlotId,
        currentCycleNumber: cycle.cycleNumber,
        currentAsset: savedPick.asset,
        currentContinuity: savedCurrentContinuity,
        currentSnapshotSource: savedPick.snapshotSource,
        assignmentsNewestFirst: assignmentsBySlotKey.get(slotKey) ?? [],
      }) ?? rebuiltBySlotKey.get(slotKey);

      if (!rebuilt) {
        throw new Error(
          `Unable to commit player-window continuity for ${slotKey}/${savedPick.asset.assetKey}.`,
        );
      }

      transaction.set(
        pickRefs[index],
        {
          playerWindowContinuity: rebuilt,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );

      if (savedTeamWindows && savedWindow && savedWindowIndex >= 0) {
        const windows = [...savedTeamWindows.windows];
        windows[savedWindowIndex] = {
          ...savedWindow,
          playerWindowContinuity: rebuilt,
        };
        updatedTeamWindowsByOwnerId.set(savedPick.ownerId, {
          ...savedTeamWindows,
          windows,
        });
      }

      return {
        ...savedPick,
        playerWindowContinuity: rebuilt,
      };
    });

    for (const [ownerId, teamWindows] of updatedTeamWindowsByOwnerId) {
      const ownerIndex = skaterOwnerIds.indexOf(ownerId);

      if (ownerIndex < 0) {
        continue;
      }

      transaction.set(
        currentTeamWindowRefs[ownerIndex],
        {
          windows: teamWindows.windows,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }

    transaction.set(
      cycleRef,
      {
        playerWindowContinuitySchemaVersion:
          PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    requireCyclePlayerWindowContinuity(
      {
        ...savedCycle,
        playerWindowContinuitySchemaVersion:
          PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
      },
      updatedPicks,
    );

    return updatedPicks;
  });
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

  const [draftPicksSnapshot, draftPreflightSnapshot] = await Promise.all([
    getDocs(draftPicksQuery),
    getDoc(draftRef),
  ]);
  const draftPicks = draftPicksSnapshot.docs.map((pickDoc) => pickDoc.data() as DraftPick);

  if (!draftPreflightSnapshot.exists()) {
    throw new Error('The draft must be completed before starting a cycle.');
  }

  const draftPreflight = draftPreflightSnapshot.data() as FantasyDraft;
  const sourceNhlBlockNumber = getDraftSourceNhlBlockNumber(draftPreflight, cycleNumber);
  const sourceNhlTargetGameIdsByTeam = getDraftSourceNhlTargetGameIdsByTeam(
    draftPreflight,
    sourceNhlBlockNumber,
  );

  const rosterSnapshotPicks = await buildCurrentRosterSnapshotPicks(
    leagueId,
    teams,
    draftPicks,
    cycleNumber,
    sourceNhlBlockNumber,
    sourceNhlTargetGameIdsByTeam,
    draftPreflight.seasonWindowAnchorEvidenceHash,
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

    if (getDraftSourceNhlBlockNumber(draft, cycleNumber) !== sourceNhlBlockNumber) {
      throw new Error('The frozen NHL source block changed while the cycle was opening. Retry.');
    }

    const savedSourceNhlTargetGameIdsByTeam = getDraftSourceNhlTargetGameIdsByTeam(
      draft,
      sourceNhlBlockNumber,
    );

    if (
      JSON.stringify(savedSourceNhlTargetGameIdsByTeam) !==
      JSON.stringify(sourceNhlTargetGameIdsByTeam)
    ) {
      throw new Error('The frozen NHL source-game plan changed while the cycle was opening.');
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
      sourceNhlBlockNumber,
      sourceNhlTargetGameIdsByTeam,
      status: 'active',
      phase: 'regular_season',
      playoffRoundNumber: null,
      playoffRoundCount: null,
      playoffRoundLabel: null,
      matchupIds,
      windowSchemaVersion: 1,
      playerWindowContinuitySchemaVersion:
        PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
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

export interface StartNextCycleOptions {
  projectionRefreshPolicy?: WindowProjectionRefreshPolicy;
}

async function loadCompletedContinuitySeeds(input: {
  leagueId: string;
  teams: FantasyTeam[];
  cycle: FantasyCycle;
}): Promise<Map<string, { assetKey: string; continuity: PlayerWindowContinuity }>> {
  const cycleNumber = input.cycle.cycleNumber;
  const loadedPicks = await getCycleRosterPicksOnce(
    input.leagueId,
    cycleNumber,
  );
  const picks = await ensureCyclePlayerWindowContinuity(
    input.leagueId,
    input.cycle,
    loadedPicks,
  );
  const teamWindowSnapshots = await Promise.all(
    input.teams.map((team) =>
      getDoc(
        getCycleTeamWindowsRef(
          input.leagueId,
          cycleNumber,
          team.ownerId,
        ),
      ),
    ),
  );
  const windowsBySlotKey = new Map<
    string,
    ReturnType<typeof normalizeFantasyTeamCycleWindows>['windows'][number]
  >(
    teamWindowSnapshots.flatMap((snapshot, index) => {
      if (!snapshot.exists()) {
        return [];
      }

      const ownerId = input.teams[index].ownerId;
      const teamWindows = normalizeFantasyTeamCycleWindows(
        ownerId,
        cycleNumber,
        snapshot.data()!,
      );

      return teamWindows.windows.map((window) => [
        `${ownerId}::${window.rosterSlotId}`,
        window,
      ] as const);
    }),
  );
  const continuityBySlotKey = new Map<
    string,
    { assetKey: string; continuity: PlayerWindowContinuity }
  >();

  for (const pick of picks) {
    if (pick.asset.assetType !== 'skater') {
      continue;
    }

    const rosterSlotId = getRosterSlotIdFromPick(pick);
    const slotKey = `${pick.ownerId}::${rosterSlotId}`;
    const window = windowsBySlotKey.get(slotKey);

    if (!window || window.status !== 'complete' || window.assetKey !== pick.asset.assetKey) {
      if (pick.asset.assetType === 'skater') {
        throw new Error(
          `Cycle ${cycleNumber} cannot advance ${slotKey}/${pick.asset.assetKey} ` +
          `without its exact completed player window.`,
        );
      }

      continue;
    }

    const persistedContinuity = resolveConsistentPlayerWindowContinuity({
      values: [
        pick.playerWindowContinuity,
        window.playerWindowContinuity,
      ],
      ownerId: pick.ownerId,
      rosterSlotId,
      asset: pick.asset,
    });

    if (!persistedContinuity) {
      throw new Error(
        `Cycle ${cycleNumber} cannot advance ${slotKey}/${pick.asset.assetKey} ` +
        `without required player-window continuity.`,
      );
    }
    const continuity = advancePlayerWindowContinuity({
      previousAsset: pick.asset,
      nextAsset: pick.asset,
      previousContinuity: persistedContinuity,
      completedScheduledGameIds: window.scheduledGameIds,
      completedScheduleTeamAbbreviation:
        window.scheduleTeamAbbreviation,
      ownerId: pick.ownerId,
      rosterSlotId,
      activationKey: `cycle-${cycleNumber + 1}`,
    });

    if (continuity) {
      continuityBySlotKey.set(slotKey, {
        assetKey: pick.asset.assetKey,
        continuity,
      });
    }
  }

  return continuityBySlotKey;
}

export async function startNextCycle(
  leagueId: string,
  teams: FantasyTeam[],
  currentCycleNumber: number,
  options: StartNextCycleOptions = {},
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
  const nextSourceNhlBlockNumber = resolveSourceNhlBlockNumber(
    currentCycle.sourceNhlBlockNumber,
    currentCycleNumber,
  ) + 1;

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

  const nextSourceNhlTargetGameIdsByTeam = getDraftSourceNhlTargetGameIdsByTeam(
    draft,
    nextSourceNhlBlockNumber,
  );

  let playoffState = playoffsSnapshot.exists()
    ? normalizeFantasyPlayoffs(playoffsSnapshot.data() as Partial<FantasyPlayoffs>)
    : null;
  const initialNhlBlockNumber = getDraftSourceNhlBlockNumber(
    draft,
    FIRST_CYCLE_NUMBER,
  );
  const regularSeasonCycleCount = getAnchoredRegularSeasonCycleCount(
    teams.length,
    initialNhlBlockNumber,
  );
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
  const continuityBySlotKey = await loadCompletedContinuitySeeds({
    leagueId,
    teams,
    cycle: currentCycle,
  });

  let cyclePicks: DraftPick[] = [];
  let playoffRoundNumber: number | null = null;
  let playoffRoundLabel: string | null = null;
  let playoffMatchups = [] as ReturnType<typeof getPlayoffRoundMatchups>;
  let initialBankPayloads: FantasyPlayoffWindowBank[] = [];
  let assignedBanks: FantasyPlayoffWindowBank[] = [];
  const playoffActivationPlansBySlotKey: Record<
    string,
    PendingSlotActivationPlan
  > = {};

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
        nextSourceNhlBlockNumber,
        nextSourceNhlTargetGameIdsByTeam,
        draft.seasonWindowAnchorEvidenceHash,
        allPlayoffOwnerIds,
        options.projectionRefreshPolicy,
        continuityBySlotKey,
        playoffActivationPlansBySlotKey,
      );
      initialBankPayloads = createInitialPlayoffBankPayloads(
        playoffState,
        allPlayoffPicks,
        nextSourceNhlTargetGameIdsByTeam,
      );
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
          nextSourceNhlBlockNumber,
          nextSourceNhlTargetGameIdsByTeam,
          draft.seasonWindowAnchorEvidenceHash,
          allPlayoffOwnerIds,
          options.projectionRefreshPolicy,
          continuityBySlotKey,
          playoffActivationPlansBySlotKey,
        );
        initialBankPayloads = createInitialPlayoffBankPayloads(
          playoffState,
          allPlayoffPicks,
          nextSourceNhlTargetGameIdsByTeam,
        );
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
    cyclePicks = assignedBanks.flatMap((bank) => {
      const bankSourceNhlBlockNumber = resolveSourceNhlBlockNumber(
        bank.sourceNhlBlockNumber,
        bank.sourceCycleNumber,
      );
      const bankTargetGameIdsByTeam =
        Object.keys(bank.sourceNhlTargetGameIdsByTeam ?? {}).length > 0
          ? (bank.sourceNhlTargetGameIdsByTeam ?? {})
          : getDraftSourceNhlTargetGameIdsByTeam(
              draft,
              bankSourceNhlBlockNumber,
            );

      return bank.picks.map((pick) => ({
        ...pick,
        playoffWindowNumber: bank.windowNumber,
        snapshotCycleNumber: bank.sourceCycleNumber,
        sourceNhlBlockNumber: bankSourceNhlBlockNumber,
        sourceNhlTargetGameIds:
          bankTargetGameIdsByTeam[getAssetTeamAbbreviation(pick.asset)] ??
          pick.sourceNhlTargetGameIds,
        sourceNhlTargetGameIdsByTeam: { ...bankTargetGameIdsByTeam },
      }));
    });
  } else {
    cyclePicks = await buildCurrentRosterSnapshotPicks(
      leagueId,
      teams,
      draftPicks,
      nextCycleNumber,
      nextSourceNhlBlockNumber,
      nextSourceNhlTargetGameIdsByTeam,
      draft.seasonWindowAnchorEvidenceHash,
      undefined,
      options.projectionRefreshPolicy,
      continuityBySlotKey,
    );
  }

  if (cyclePicks.length === 0) {
    throw new Error('No active roster assets were found for the next matchup period.');
  }

  const expectedRosterSlotIdsByOwner = buildExpectedRosterSlotIdsByOwner(cyclePicks);
  const cyclePicksHavePlayerWindowContinuity = cyclePicks.every((pick) =>
    pick.asset.assetType !== 'skater' ||
    Boolean(resolvePlayerWindowContinuity({
      value: pick.playerWindowContinuity,
      ownerId: pick.ownerId,
      rosterSlotId: getRosterSlotIdFromPick(pick),
      asset: pick.asset,
    })),
  );

  if (!isPlayoffCycle && !cyclePicksHavePlayerWindowContinuity) {
    throw new Error(
      `Cycle ${nextCycleNumber} could not create every required skater ` +
      `player-window continuity cursor.`,
    );
  }

  const playoffActivationOwnerIds = [
    ...new Set(
      Object.values(playoffActivationPlansBySlotKey).map(
        (plan) => plan.ownerId,
      ),
    ),
  ];
  const playoffActivationRosterRefs = playoffActivationOwnerIds.map(
    (ownerId) => getTeamRosterRef(leagueId, ownerId),
  );

  return runTransaction(db, async (transaction) => {
    const snapshots = await Promise.all([
      transaction.get(currentCycleRef),
      transaction.get(nextCycleRef),
      transaction.get(playoffsRef),
      transaction.get(draftRef),
      ...playoffActivationRosterRefs.map((reference) =>
        transaction.get(reference),
      ),
    ]);
    const [savedCurrent, savedNext, savedPlayoffs, savedDraft] = snapshots;
    const playoffActivationRostersByOwnerId = new Map(
      playoffActivationOwnerIds.map((ownerId, index) => {
        const snapshot = snapshots[index + 4];

        return [
          ownerId,
          snapshot?.exists()
            ? normalizeFantasyRoster(
                snapshot.data() as Partial<FantasyRoster>,
              )
            : null,
        ] as const;
      }),
    );

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

    const savedSourceNhlTargetGameIdsByTeam = getDraftSourceNhlTargetGameIdsByTeam(
      savedDraft.data() as FantasyDraft,
      nextSourceNhlBlockNumber,
    );

    if (
      JSON.stringify(savedSourceNhlTargetGameIdsByTeam) !==
      JSON.stringify(nextSourceNhlTargetGameIdsByTeam)
    ) {
      throw new Error(
        'The frozen NHL source-game plan changed while the next matchup period was opening.',
      );
    }

    for (const [slotKey, activationPlan] of Object.entries(
      playoffActivationPlansBySlotKey,
    )) {
      const roster = playoffActivationRostersByOwnerId.get(
        activationPlan.ownerId,
      );
      const expectedPick = cyclePicks.find(
        (pick) =>
          `${pick.ownerId}::${getRosterSlotIdFromPick(pick)}` === slotKey,
      );

      if (!roster || !expectedPick) {
        throw new Error(
          `The roster or playoff snapshot for ${slotKey} is unavailable while activating its queued move.`,
        );
      }

      activatePendingSlotMoveInRoster({
        transaction,
        leagueId,
        roster,
        plan: activationPlan,
        expectedIncomingAssetKey: expectedPick.asset.assetKey,
        effectiveCycleNumber: nextCycleNumber,
        effectiveLabel: 'Playoff Window 1',
      });
    }

    for (const ownerId of playoffActivationOwnerIds) {
      const roster = playoffActivationRostersByOwnerId.get(ownerId);

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
      sourceNhlBlockNumber: nextSourceNhlBlockNumber,
      sourceNhlTargetGameIdsByTeam: nextSourceNhlTargetGameIdsByTeam,
      status: 'active',
      phase: isPlayoffCycle ? 'playoffs' : 'regular_season',
      playoffRoundNumber,
      playoffRoundCount: isPlayoffCycle && playoffState ? playoffState.playoffRoundCount : null,
      playoffRoundLabel,
      matchupIds,
      windowSchemaVersion: 2,
      ...(cyclePicksHavePlayerWindowContinuity
        ? {
            playerWindowContinuitySchemaVersion:
              PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
          }
        : {}),
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

function activatePendingSlotMoveInRoster(input: {
  transaction: Transaction;
  leagueId: string;
  roster: FantasyRoster;
  plan: PendingSlotActivationPlan;
  expectedIncomingAssetKey: string;
  effectiveCycleNumber: number;
  effectiveLabel: string;
}): void {
  const slotIndex = input.roster.activeSlots.findIndex(
    (slot) => slot.slotId === input.plan.rosterSlotId,
  );

  if (slotIndex < 0) {
    throw new Error(
      `Roster slot ${input.plan.rosterSlotId} was not found while activating its queued move.`,
    );
  }

  const savedSlot = input.roster.activeSlots[slotIndex];
  const savedPendingMove = savedSlot.pendingMove;

  if (!savedPendingMove || savedPendingMove.id !== input.plan.pendingMoveId) {
    throw new Error(
      `The queued move for ${input.plan.rosterSlotId} changed before its slot boundary. Refresh and try again.`,
    );
  }

  const incomingAssetKey = getRosterAssetKey(savedPendingMove.incomingAsset);

  if (incomingAssetKey !== input.expectedIncomingAssetKey) {
    throw new Error(
      `The queued asset for ${input.plan.rosterSlotId} no longer matches the next window snapshot.`,
    );
  }

  const outgoingAsset = savedSlot.asset;
  const sourceBenchSlotId = savedPendingMove.sourceBenchSlotId ?? null;

  if (sourceBenchSlotId) {
    const benchSlotIndex = input.roster.benchSlots.findIndex(
      (benchSlot) => benchSlot.slotId === sourceBenchSlotId,
    );

    if (benchSlotIndex < 0) {
      throw new Error(
        `Bench slot ${sourceBenchSlotId} was not found while activating ${input.plan.rosterSlotId}.`,
      );
    }

    const benchSlot = input.roster.benchSlots[benchSlotIndex];

    if (getRosterAssetKey(benchSlot.asset) !== incomingAssetKey) {
      throw new Error(
        `The reserved bench asset for ${input.plan.rosterSlotId} changed before activation.`,
      );
    }

    input.roster.benchSlots[benchSlotIndex] = {
      ...benchSlot,
      asset: outgoingAsset
        ? { ...outgoingAsset, rosterStatus: 'benched' }
        : null,
    };
  }

  input.roster.activeSlots[slotIndex] = {
    ...savedSlot,
    asset: { ...savedPendingMove.incomingAsset, rosterStatus: 'active' },
    pendingMove: null,
    openFromCycleNumber: null,
  };

  if (!sourceBenchSlotId && outgoingAsset) {
    const outgoingAssetKey = getRosterAssetKey(outgoingAsset);

    if (outgoingAssetKey && outgoingAssetKey !== incomingAssetKey) {
      input.transaction.set(
        getWaiverRef(input.leagueId, outgoingAssetKey),
        buildActivatedDropWaiverPayload(
          outgoingAsset,
          input.plan.ownerId,
          input.effectiveCycleNumber,
        ),
      );
    }
  }

  if (savedPendingMove.sourceWaiverId) {
    input.transaction.set(
      getWaiverRef(input.leagueId, savedPendingMove.sourceWaiverId),
      {
        effectiveCycleNumber: input.effectiveCycleNumber,
        effectiveLabel: input.effectiveLabel,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }

  input.transaction.set(doc(getTransactionsRef(input.leagueId)), {
    type: sourceBenchSlotId
      ? 'active-bench-swap-activated'
      : 'slot-move-activated',
    ownerId: input.plan.ownerId,
    addedAsset: rosterAssetToDraftableAsset(savedPendingMove.incomingAsset),
    droppedAsset: outgoingAsset,
    waiverId:
      !sourceBenchSlotId && outgoingAsset
        ? getRosterAssetKey(outgoingAsset)
        : null,
    benchSlotId: sourceBenchSlotId,
    rosterSlotId: input.plan.rosterSlotId,
    targetSlotId: input.plan.rosterSlotId,
    queuedMoveId: savedPendingMove.id,
    effectiveCycleNumber: input.effectiveCycleNumber,
    effectiveLabel: input.effectiveLabel,
    createdAt: serverTimestamp(),
  });
}

async function buildNextWindowSnapshotPicks(
  leagueId: string,
  teams: FantasyTeam[],
  currentPicks: DraftPick[],
  scoring: CycleScoringResult,
  completedWindowKeys: Set<string>,
  currentWindowSlotKeys: Set<string>,
  nextCycleNumber: number,
  sourceNhlBlockNumber: number,
  sourceNhlTargetGameIdsByTeam: Readonly<Record<string, number[]>>,
  seasonWindowAnchorEvidenceHash: string | null | undefined,
  projectionRefreshPolicy: WindowProjectionRefreshPolicy,
): Promise<{
  picks: DraftPick[];
  expectedRosterSlotIdsByOwner: Record<string, string[]>;
  activationPlansBySlotKey: Record<string, PendingSlotActivationPlan>;
  openSlotRolloversByOwner: Record<string, string[]>;
}> {
  const draftPicksQuery = query(getDraftPicksRef(leagueId), orderBy('overallPick', 'asc'));
  const [draftPicksSnapshot, projectionAssetsByKey, rosterSnapshots] = await Promise.all([
    getDocs(draftPicksQuery),
    loadWindowProjectionAssetsByKey(
      leagueId,
      teams.length,
      nextCycleNumber,
      sourceNhlBlockNumber,
      sourceNhlTargetGameIdsByTeam,
      seasonWindowAnchorEvidenceHash,
      projectionRefreshPolicy,
    ),
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
  const currentPickBySlotKey = new Map<string, DraftPick>(
    currentPicks.map((pick) => [
      `${pick.ownerId}::${getRosterSlotIdFromPick(pick)}`,
      pick,
    ] as const),
  );
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
      const nextDraftableAsset = createDraftableAssetFromRosterAsset(
        nextAsset,
        projectionAssetsByKey.get(nextAssetKey) ?? null,
        matchingDraftPick?.asset ?? null,
        nextCycleNumber,
      );
      const previousPick = currentPickBySlotKey.get(completedSlotKey);
      const previousWindowId = previousPick
        ? previousPick.cycleWindowId ?? getCycleWindowId(
            previousPick.ownerId,
            getRosterSlotIdFromPick(previousPick),
            previousPick.snapshotCycleNumber ?? nextCycleNumber - 1,
          )
        : '';
      const previousSummary = previousPick
        ? scoring.windowScores[previousWindowId] ??
          scoring.assetScores[previousPick.asset.assetKey]
        : undefined;
      const playerWindowContinuity =
        slot.pendingMove && pendingMoveReady
          ? createPlayerWindowContinuity({
              ownerId: rosterSnapshot.ownerId,
              rosterSlotId: slot.slotId,
              asset: nextDraftableAsset,
              activationKey: `move-${slot.pendingMove.id}`,
            })
          : previousPick && previousSummary
            ? advancePlayerWindowContinuity({
                previousAsset: previousPick.asset,
                nextAsset: nextDraftableAsset,
                previousContinuity: previousPick.playerWindowContinuity,
                completedScheduledGameIds: previousSummary.scheduledGameIds,
                completedScheduleTeamAbbreviation:
                  previousSummary.scheduleTeamAbbreviation,
                ownerId: rosterSnapshot.ownerId,
                rosterSlotId: slot.slotId,
                activationKey: `cycle-${nextCycleNumber}`,
              })
            : createPlayerWindowContinuity({
                ownerId: rosterSnapshot.ownerId,
                rosterSlotId: slot.slotId,
                asset: nextDraftableAsset,
                activationKey: `cycle-${nextCycleNumber}`,
              });

      nextPicks.push({
        overallPick: snapshotOrder,
        round: matchingDraftPick?.round ?? 0,
        pickInRound: matchingDraftPick?.pickInRound ?? slot.slotNumber,
        ownerId: rosterSnapshot.ownerId,
        rosterSlotId: slot.slotId,
        cycleWindowId: getCycleWindowId(rosterSnapshot.ownerId, slot.slotId, nextCycleNumber),
        snapshotCycleNumber: nextCycleNumber,
        sourceNhlBlockNumber,
        ...(sourceNhlTargetGameIdsByTeam[getAssetTeamAbbreviation(nextAsset)]
          ? {
              sourceNhlTargetGameIds:
                sourceNhlTargetGameIdsByTeam[getAssetTeamAbbreviation(nextAsset)],
            }
          : {}),
        sourceNhlTargetGameIdsByTeam: { ...sourceNhlTargetGameIdsByTeam },
        ...(playerWindowContinuity ? { playerWindowContinuity } : {}),
        snapshotOrder,
        asset: nextDraftableAsset,
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
export interface AdvanceCompletedWindowOptions {
  projectionRefreshPolicy?: WindowProjectionRefreshPolicy;
}

export async function advanceCompletedRegularSeasonAssetWindows(
  leagueId: string,
  teams: FantasyTeam[],
  currentCycle: FantasyCycle,
  currentPicks: DraftPick[],
  scoring: CycleScoringResult,
  options: AdvanceCompletedWindowOptions = {},
): Promise<FantasyCycle | null> {
  if (currentCycle.phase !== 'regular_season' || currentCycle.status !== 'active') {
    return null;
  }

  const initialNhlBlockNumber = resolveSourceNhlBlockNumber(
    currentCycle.sourceNhlBlockNumber,
    currentCycle.cycleNumber,
  ) - (currentCycle.cycleNumber - FIRST_CYCLE_NUMBER);
  const regularSeasonCycleCount = getAnchoredRegularSeasonCycleCount(
    teams.length,
    initialNhlBlockNumber,
  );
  const nextCycleNumber = currentCycle.cycleNumber + 1;
  const nextSourceNhlBlockNumber = resolveSourceNhlBlockNumber(
    currentCycle.sourceNhlBlockNumber,
    currentCycle.cycleNumber,
  ) + 1;

  // The final regular-season -> playoff transition still needs bracket-aware
  // banking/routing, which is implemented in the later playoff barrier stage.
  if (nextCycleNumber > regularSeasonCycleCount) {
    return null;
  }

  const draftRef = getDraftRef(leagueId);
  const draftPlanSnapshot = await getDoc(draftRef);

  if (!draftPlanSnapshot.exists()) {
    throw new Error('The completed draft is required to open overlapping slot windows.');
  }

  const draftPlan = draftPlanSnapshot.data() as FantasyDraft;

  if (draftPlan.status !== 'complete') {
    throw new Error('The draft must be complete before overlapping cycles can open.');
  }

  const nextSourceNhlTargetGameIdsByTeam = getDraftSourceNhlTargetGameIdsByTeam(
    draftPlan,
    nextSourceNhlBlockNumber,
  );

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
    currentPicks,
    scoring,
    completedWindowKeys,
    currentWindowSlotKeys,
    nextCycleNumber,
    nextSourceNhlBlockNumber,
    nextSourceNhlTargetGameIdsByTeam,
    draftPlan.seasonWindowAnchorEvidenceHash,
    options.projectionRefreshPolicy ?? 'refresh-if-needed',
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

    if (
      JSON.stringify(
        getDraftSourceNhlTargetGameIdsByTeam(draft, nextSourceNhlBlockNumber),
      ) !== JSON.stringify(nextSourceNhlTargetGameIdsByTeam)
    ) {
      throw new Error(
        'The frozen NHL source-game plan changed while overlapping windows were opening.',
      );
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
        sourceNhlBlockNumber: nextSourceNhlBlockNumber,
        sourceNhlTargetGameIdsByTeam: nextSourceNhlTargetGameIdsByTeam,
        status: 'active',
        phase: 'regular_season',
        playoffRoundNumber: null,
        playoffRoundCount: null,
        playoffRoundLabel: null,
        matchupIds,
        windowSchemaVersion: 1,
        playerWindowContinuitySchemaVersion:
          PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
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
        ...(nextCycle.playerWindowContinuitySchemaVersion ===
        PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION
          ? {
              playerWindowContinuitySchemaVersion:
                PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
            }
          : {}),
        sourceNhlBlockNumber: nextSourceNhlBlockNumber,
        sourceNhlTargetGameIdsByTeam: nextSourceNhlTargetGameIdsByTeam,
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

interface SavedCycleRosterPick extends DraftPick {
  snapshotSource?: string;
  snapshottedAt?: unknown;
}

function getStoredTimestampMilliseconds(value: unknown): number | null {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const milliseconds = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const timestamp = value as {
    toMillis?: () => number;
    toDate?: () => Date;
    seconds?: number;
    nanoseconds?: number;
    _seconds?: number;
    _nanoseconds?: number;
  };

  if (typeof timestamp.toMillis === 'function') {
    try {
      const milliseconds = timestamp.toMillis();
      return Number.isFinite(milliseconds) ? milliseconds : null;
    } catch {
      return null;
    }
  }

  if (typeof timestamp.toDate === 'function') {
    try {
      const milliseconds = timestamp.toDate().getTime();
      return Number.isFinite(milliseconds) ? milliseconds : null;
    } catch {
      return null;
    }
  }

  const seconds = typeof timestamp.seconds === 'number'
    ? timestamp.seconds
    : timestamp._seconds;
  const nanoseconds = typeof timestamp.nanoseconds === 'number'
    ? timestamp.nanoseconds
    : timestamp._nanoseconds ?? 0;

  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return null;
  }

  return seconds * 1000 + (Number.isFinite(nanoseconds) ? nanoseconds / 1_000_000 : 0);
}

function wasPendingMoveQueuedBeforeCycleSnapshot(
  pendingMove: PendingRosterSlotMove,
  pick: SavedCycleRosterPick,
): boolean {
  const queuedAtMilliseconds = Date.parse(pendingMove.queuedAt);
  const snapshottedAtMilliseconds = getStoredTimestampMilliseconds(pick.snapshottedAt);

  // A current matchup snapshot normally predates a move queued during that
  // matchup. Recovery is allowed only when the target snapshot was created
  // after the reservation, which identifies the older/manual opener failure
  // without activating a current-window move before its six-game boundary.
  return Number.isFinite(queuedAtMilliseconds) &&
    snapshottedAtMilliseconds !== null &&
    snapshottedAtMilliseconds >= queuedAtMilliseconds;
}

export interface PendingRosterMoveReconciliationResult {
  activatedMoveCount: number;
  skippedMoveCount: number;
  activatedOwnerIds: string[];
}

/**
 * Repairs a regular-season period whose roster-slot snapshots were opened
 * before a ready queued move was activated. This is primarily a recovery
 * guard for older/manual lifecycle paths, but it also makes server scoring
 * self-healing if a transient failure occurs between opening a slot window and
 * updating the authoritative roster.
 *
 * A move is eligible only when this exact roster slot already has a snapshot
 * in the requested cycle. That preserves asynchronous windows: a fast slot
 * may activate its move in Matchup N while slower slots remain in Matchup
 * N-1, and a slower slot is never pulled forward merely because the league
 * period document exists.
 */
export async function reconcilePendingRosterMovesForRegularSeasonCycle(
  leagueId: string,
  teams: FantasyTeam[],
  cycle: FantasyCycle,
): Promise<PendingRosterMoveReconciliationResult> {
  if (cycle.phase !== 'regular_season' || cycle.status !== 'active') {
    return {
      activatedMoveCount: 0,
      skippedMoveCount: 0,
      activatedOwnerIds: [],
    };
  }

  const cyclePicks = await getCycleRosterPicksOnce(leagueId, cycle.cycleNumber);

  if (cyclePicks.length === 0) {
    return {
      activatedMoveCount: 0,
      skippedMoveCount: 0,
      activatedOwnerIds: [],
    };
  }

  const picksByOwnerId = new Map<string, DraftPick[]>();

  for (const pick of cyclePicks) {
    const ownerPicks = picksByOwnerId.get(pick.ownerId) ?? [];
    ownerPicks.push(pick);
    picksByOwnerId.set(pick.ownerId, ownerPicks);
  }

  const ownerEntries = [...picksByOwnerId.entries()];
  const rosterPreflightSnapshots = await Promise.all(
    ownerEntries.map(([ownerId]) => getDoc(getTeamRosterRef(leagueId, ownerId))),
  );
  const candidateOwnerIds = new Set<string>();

  ownerEntries.forEach(([ownerId, ownerPicks], index) => {
    const rosterSnapshot = rosterPreflightSnapshots[index];

    if (!rosterSnapshot?.exists()) {
      return;
    }

    const roster = normalizeFantasyRoster(
      rosterSnapshot.data() as Partial<FantasyRoster>,
    );
    const pickBySlotId = new Map(
      ownerPicks.map(
        (pick) => [getRosterSlotIdFromPick(pick), pick as SavedCycleRosterPick] as const,
      ),
    );
    const hasReadyMove = roster.activeSlots.some((slot) => {
      const pick = pickBySlotId.get(slot.slotId);
      const pendingMove = slot.pendingMove;

      return Boolean(
        pick &&
        pendingMove &&
        canActivatePendingMoveInCycle(pendingMove, cycle.cycleNumber) &&
        wasPendingMoveQueuedBeforeCycleSnapshot(pendingMove, pick),
      );
    });

    if (hasReadyMove) {
      candidateOwnerIds.add(ownerId);
    }
  });

  if (candidateOwnerIds.size === 0) {
    return {
      activatedMoveCount: 0,
      skippedMoveCount: 0,
      activatedOwnerIds: [],
    };
  }

  const draftPicksQuery = query(getDraftPicksRef(leagueId), orderBy('overallPick', 'asc'));
  const [draftPicksSnapshot, draftAuthoritySnapshot] = await Promise.all([
    getDocs(draftPicksQuery),
    getDoc(getDraftRef(leagueId)),
  ]);
  const draftAuthority = draftAuthoritySnapshot.exists()
    ? (draftAuthoritySnapshot.data() as FantasyDraft)
    : null;
  const projectionAssetsByKey = await loadWindowProjectionAssetsByKey(
    leagueId,
    teams.length,
    cycle.cycleNumber,
    resolveSourceNhlBlockNumber(cycle.sourceNhlBlockNumber, cycle.cycleNumber),
    cycle.sourceNhlTargetGameIdsByTeam ?? {},
    draftAuthority?.seasonWindowAnchorEvidenceHash,
  );
  const draftPicks = draftPicksSnapshot.docs.map((snapshot) => snapshot.data() as DraftPick);
  const draftPickByOwnerAndAssetKey = new Map(
    draftPicks.map((pick) => [`${pick.ownerId}::${pick.asset.assetKey}`, pick] as const),
  );

  let activatedMoveCount = 0;
  let skippedMoveCount = 0;
  const activatedOwnerIds = new Set<string>();

  // Process one roster at a time. A malformed reservation on one team must
  // never prevent another team's ready slot from entering its next window.
  for (const [ownerId, ownerPicks] of picksByOwnerId.entries()) {
    if (!candidateOwnerIds.has(ownerId)) {
      continue;
    }

    const rosterRef = getTeamRosterRef(leagueId, ownerId);
    const teamWindowsRef = getCycleTeamWindowsRef(
      leagueId,
      cycle.cycleNumber,
      ownerId,
    );
    const pickRefs = ownerPicks.map((pick) =>
      getCycleRosterSlotPickRef(
        leagueId,
        cycle.cycleNumber,
        ownerId,
        getRosterSlotIdFromPick(pick),
      ),
    );

    const ownerResult = await runTransaction(db, async (transaction) => {
      const snapshots = await Promise.all([
        transaction.get(rosterRef),
        transaction.get(teamWindowsRef),
        ...pickRefs.map((reference) => transaction.get(reference)),
      ]);
      const rosterSnapshot = snapshots[0];
      const teamWindowsSnapshot = snapshots[1];

      if (!rosterSnapshot.exists()) {
        return { activated: 0, skipped: 0 };
      }

      const roster = normalizeFantasyRoster(
        rosterSnapshot.data() as Partial<FantasyRoster>,
      );
      const savedPickSnapshots = snapshots.slice(2);
      const persistedTeamWindows = teamWindowsSnapshot.exists()
        ? normalizeFantasyTeamCycleWindows(
            ownerId,
            cycle.cycleNumber,
            teamWindowsSnapshot.data()!,
          )
        : null;
      let activated = 0;
      let skipped = 0;

      ownerPicks.forEach((fallbackPick, index) => {
        const pickSnapshot = savedPickSnapshots[index];

        if (!pickSnapshot?.exists()) {
          return;
        }

        const pick = pickSnapshot.data() as SavedCycleRosterPick;
        const rosterSlotId = getRosterSlotIdFromPick(pick) || getRosterSlotIdFromPick(fallbackPick);
        const slotIndex = roster.activeSlots.findIndex((slot) => slot.slotId === rosterSlotId);

        if (slotIndex < 0) {
          skipped += 1;
          console.warn(
            `Unable to reconcile queued move for ${ownerId}/${rosterSlotId}: roster slot is missing.`,
          );
          return;
        }

        const savedSlot = roster.activeSlots[slotIndex];
        const pendingMove = savedSlot.pendingMove;

        if (!canActivatePendingMoveInCycle(pendingMove, cycle.cycleNumber)) {
          return;
        }

        if (!pendingMove) {
          return;
        }

        if (!wasPendingMoveQueuedBeforeCycleSnapshot(pendingMove, pick)) {
          // This is the current window that existed before the move was
          // queued, not a target window opened with the wrong player.
          return;
        }

        const persistedWindow = persistedTeamWindows?.windows.find(
          (window) => window.rosterSlotId === rosterSlotId,
        );
        const persistedWindowIsUntouched = Boolean(
          persistedWindow &&
          persistedWindow.status === 'scheduled' &&
          // Once any NHL ids are assigned, puck drop can outrun the saved
          // counters. Recovery must not replace that ownership based on a
          // stale zero-state document; the normal boundary path will apply it.
          persistedWindow.scheduledGameIds.length === 0 &&
          persistedWindow.gamesPlayed === 0 &&
          persistedWindow.actualGamesPlayed === 0 &&
          persistedWindow.fantasyPoints === 0 &&
          persistedWindow.completedGameIds.length === 0 &&
          persistedWindow.liveGameIds.length === 0 &&
          persistedWindow.appearanceGameIds.length === 0 &&
          (persistedWindow.incompleteFinalGameIds?.length ?? 0) === 0,
        );

        if (!persistedWindowIsUntouched) {
          // A scoring worker may have crossed puck drop since the preflight.
          // The transaction read makes that race retry here; retain the queued
          // move for the next fair boundary instead of replacing ownership.
          skipped += 1;
          console.warn(
            `Deferred queued move for ${ownerId}/${rosterSlotId}: ` +
            `the persisted slot window is missing or has started.`,
          );
          return;
        }

        const incomingAssetKey = getRosterAssetKey(pendingMove.incomingAsset);
        const outgoingAsset = savedSlot.asset;
        const outgoingAssetKey = getRosterAssetKey(outgoingAsset);

        if (!incomingAssetKey) {
          skipped += 1;
          console.warn(
            `Unable to reconcile queued move for ${ownerId}/${rosterSlotId}: incoming asset key is missing.`,
          );
          return;
        }

        if (
          pendingMove.outgoingAssetKey &&
          outgoingAssetKey !== pendingMove.outgoingAssetKey
        ) {
          skipped += 1;
          console.warn(
            `Unable to reconcile queued move for ${ownerId}/${rosterSlotId}: the current asset changed.`,
          );
          return;
        }

        if (!pendingMove.outgoingAssetKey && outgoingAssetKey) {
          skipped += 1;
          console.warn(
            `Unable to reconcile queued open-slot move for ${ownerId}/${rosterSlotId}: the slot is no longer open.`,
          );
          return;
        }

        const sourceBenchSlotId = pendingMove.sourceBenchSlotId ?? null;

        if (sourceBenchSlotId) {
          const benchSlotIndex = roster.benchSlots.findIndex(
            (benchSlot) => benchSlot.slotId === sourceBenchSlotId,
          );

          if (benchSlotIndex < 0) {
            skipped += 1;
            console.warn(
              `Unable to reconcile queued bench swap for ${ownerId}/${rosterSlotId}: bench slot ${sourceBenchSlotId} is missing.`,
            );
            return;
          }

          const benchSlot = roster.benchSlots[benchSlotIndex];

          if (getRosterAssetKey(benchSlot.asset) !== incomingAssetKey) {
            skipped += 1;
            console.warn(
              `Unable to reconcile queued bench swap for ${ownerId}/${rosterSlotId}: reserved bench asset changed.`,
            );
            return;
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
          asset: { ...pendingMove.incomingAsset, rosterStatus: 'active' },
          pendingMove: null,
          openFromCycleNumber: null,
        };

        if (!sourceBenchSlotId && outgoingAsset) {
          if (outgoingAssetKey && outgoingAssetKey !== incomingAssetKey) {
            transaction.set(
              getWaiverRef(leagueId, outgoingAssetKey),
              buildActivatedDropWaiverPayload(
                outgoingAsset,
                ownerId,
                cycle.cycleNumber,
              ),
            );
          }
        }

        if (pendingMove.sourceWaiverId) {
          transaction.set(
            getWaiverRef(leagueId, pendingMove.sourceWaiverId),
            {
              effectiveCycleNumber: cycle.cycleNumber,
              effectiveLabel: `Cycle ${cycle.cycleNumber}`,
              updatedAt: serverTimestamp(),
            },
            { merge: true },
          );
        }

        const matchingDraftPick =
          draftPickByOwnerAndAssetKey.get(`${ownerId}::${incomingAssetKey}`) ?? null;
        const repairedAsset = createDraftableAssetFromRosterAsset(
          pendingMove.incomingAsset,
          projectionAssetsByKey.get(incomingAssetKey) ?? null,
          matchingDraftPick?.asset ?? null,
          cycle.cycleNumber,
        );

        const incomingSourceNhlTargetGameIds =
          cycle.sourceNhlTargetGameIdsByTeam?.[
            getAssetTeamAbbreviation(pendingMove.incomingAsset)
          ];
        const playerWindowContinuity = createPlayerWindowContinuity({
          ownerId,
          rosterSlotId,
          asset: repairedAsset,
          activationKey: `move-${pendingMove.id}`,
        });

        transaction.set(pickRefs[index], {
          ...pick,
          ownerId,
          rosterSlotId,
          cycleWindowId: getCycleWindowId(ownerId, rosterSlotId, cycle.cycleNumber),
          snapshotCycleNumber: cycle.cycleNumber,
          sourceNhlBlockNumber: resolveSourceNhlBlockNumber(
            cycle.sourceNhlBlockNumber,
            cycle.cycleNumber,
          ),
          ...(incomingSourceNhlTargetGameIds === undefined
            ? {}
            : { sourceNhlTargetGameIds: incomingSourceNhlTargetGameIds }),
          ...(playerWindowContinuity
            ? { playerWindowContinuity }
            : { playerWindowContinuity: null }),
          snapshotSource: 'queued-slot-move-reconciled',
          asset: repairedAsset,
          snapshottedAt: serverTimestamp(),
        });

        transaction.set(doc(getTransactionsRef(leagueId)), {
          type: sourceBenchSlotId ? 'active-bench-swap-activated' : 'slot-move-activated',
          ownerId,
          addedAsset: rosterAssetToDraftableAsset(pendingMove.incomingAsset),
          droppedAsset: outgoingAsset,
          waiverId: !sourceBenchSlotId && outgoingAsset ? outgoingAssetKey : null,
          benchSlotId: sourceBenchSlotId,
          rosterSlotId,
          targetSlotId: rosterSlotId,
          queuedMoveId: pendingMove.id,
          effectiveCycleNumber: cycle.cycleNumber,
          effectiveLabel: `Cycle ${cycle.cycleNumber}`,
          recoverySource: 'active-cycle-pending-move-reconciliation',
          authority: 'cloud-function',
          createdAt: serverTimestamp(),
        });

        activated += 1;
      });

      if (activated > 0) {
        transaction.set(
          rosterRef,
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

      return { activated, skipped };
    });

    activatedMoveCount += ownerResult.activated;
    skippedMoveCount += ownerResult.skipped;

    if (ownerResult.activated > 0) {
      activatedOwnerIds.add(ownerId);
    }
  }

  return {
    activatedMoveCount,
    skippedMoveCount,
    activatedOwnerIds: [...activatedOwnerIds].sort(),
  };
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
