import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
} from '../firebase-admin-compat';

import { db } from '../firebase';
import {
  DraftPick,
  DraftProjection,
  DraftableAsset,
  FantasyDraft,
} from '../draft/draft.models';
import { getRawCycleProjection } from '../projection/cycle-projection.util';
import {
  createFrozenWindowProjectionFields,
  ensureWindowProjectionBundle,
  FrozenWindowProjectionFields,
} from '../projection/window-projection.service';
import { FantasyRoster, PendingRosterSlotMove, RosterAsset } from '../team/roster.models';
import { normalizeFantasyRoster } from '../team/roster.service';
import {
  calculateCycleScoring,
  CycleScoringResult,
  NhlPlayerTeamIdentityBoundaryRefreshRequiredError,
} from '../cycle/cycle-scoring.service';
import { defaultScoringRules, ScoringRules } from '../scoring/scoring-rules';
import { FantasyAssetCycleWindow } from '../cycle/cycle.models';
import {
  buildSourceNhlTargetGameIdsByTeam,
  resolveFrozenSeasonSourceGameIdsByTeam,
  resolveSourceNhlBlockNumber,
} from '../cycle/cycle-window-selection.util';
import { NhlTeamSeasonGame } from '../nhl/nhl-api.service';
import { loadCurrentNhlPlayerTeamIdentity } from '../nhl/nhl-player-team-identity.service';
import { normalizeNhlFinalInputCompletenessRecord } from '../nhl/nhl-final-input-completeness.util';
import { FantasyPlayoffWindowBank } from './playoff-window-bank.models';
import { FantasyPlayoffs } from './playoff.models';
import {
  advancePlayerWindowContinuity,
  createPlayerWindowContinuity,
  normalizePlayerWindowContinuity,
  PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
  resolveConsistentPlayerWindowContinuity,
  resolvePlayerWindowContinuity,
} from '../cycle/player-window-continuity.util';
import {
  getInjuryReplacementProtectedGameIds,
  getInjuryReplacementAssetKeyByGameId,
  getInjuryReplacementPlanAuthorityFingerprint,
  hasConsistentInjuryReplacementWindowEvidence,
  hasExactInjuryReplacementScoringAssetKeyMap,
  hasPreservedInjuryReplacementProtectedGameOwnership,
  requireValidInjuryReplacementWindowPlan,
  resolveConsistentInjuryReplacementWindowPlan,
} from '../cycle/injury-replacement-window.util';

function getOwnerBankRef(leagueId: string, ownerId: string) {
  return doc(db, 'leagues', leagueId, 'playoffWindowBanks', ownerId);
}

function getOwnerWindowsRef(leagueId: string, ownerId: string) {
  return collection(getOwnerBankRef(leagueId, ownerId), 'windows');
}

export function getPlayoffWindowBankRef(leagueId: string, ownerId: string, windowNumber: number) {
  return doc(getOwnerWindowsRef(leagueId, ownerId), `window-${windowNumber}`);
}

function getTeamRosterRef(leagueId: string, ownerId: string) {
  return doc(db, 'leagues', leagueId, 'teams', ownerId, 'roster', 'current');
}

function getDraftPicksRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'draft', 'current', 'picks');
}

function getDraftRef(leagueId: string) {
  return doc(db, 'leagues', leagueId, 'draft', 'current');
}

function getWaiverRef(leagueId: string, waiverId: string) {
  return doc(db, 'leagues', leagueId, 'waivers', waiverId);
}

function getTransactionsRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'transactions');
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function normalizeNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    : [];
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

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim().length > 0,
    ),
  );
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
                typeof gameId === 'number' && Number.isSafeInteger(gameId) && gameId > 0,
            )
          : [],
      ] as const)
      .filter(([teamAbbreviation, gameIds]) =>
        /^[A-Z0-9]{2,4}$/.test(teamAbbreviation) && gameIds.length > 0),
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

function normalizeSlotWindow(value: Partial<FantasyAssetCycleWindow>): FantasyAssetCycleWindow {
  const cycleNumber = typeof value.cycleNumber === 'number' ? value.cycleNumber : 0;
  const ownerId = value.ownerId ?? '';
  const rosterSlotId = value.rosterSlotId ?? '';
  const asset = value.asset as FantasyAssetCycleWindow['asset'];
  const playerWindowContinuity = asset
    ? resolvePlayerWindowContinuity({
        value: value.playerWindowContinuity,
        ownerId,
        rosterSlotId,
        asset,
      })
    : normalizePlayerWindowContinuity(value.playerWindowContinuity);
  const injuryReplacementWindow = requireValidInjuryReplacementWindowPlan(
    value.injuryReplacementWindow,
    `Playoff window ${ownerId}/${rosterSlotId}`,
  );
  const savedScoringAssetKeyByGameId = normalizeStringRecord(
    value.scoringAssetKeyByGameId,
  );
  const scoringAssetKeyByGameId = injuryReplacementWindow
    ? getInjuryReplacementAssetKeyByGameId(injuryReplacementWindow)
    : {};

  if (
    injuryReplacementWindow
      ? !hasConsistentInjuryReplacementWindowEvidence({
          plan: injuryReplacementWindow,
          scheduledGameIds: value.scheduledGameIds,
          scoringAssetKeyByGameId: value.scoringAssetKeyByGameId,
          assetKey: value.assetKey ?? asset?.assetKey ?? '',
          ownerId,
          rosterSlotId,
          position: value.position,
          scheduleTeamAbbreviation: value.scheduleTeamAbbreviation,
          sourceTeamAbbreviationByGameId:
            value.sourceTeamAbbreviationByGameId,
          completedGameIds: value.completedGameIds,
          liveGameIds: value.liveGameIds,
          incompleteFinalGameIds: value.incompleteFinalGameIds,
          appearanceGameIds: value.appearanceGameIds,
          gameStates: value.gameStates,
        })
      : Object.keys(savedScoringAssetKeyByGameId).length > 0
  ) {
    throw new Error(
      `Playoff window ${ownerId}/${rosterSlotId} contains conflicting ` +
      'injury-replacement game ownership.',
    );
  }

  return {
    id: value.id ?? '',
    ownerId,
    rosterSlotId,
    cycleNumber,
    sourceNhlBlockNumber: resolveSourceNhlBlockNumber(
      value.sourceNhlBlockNumber,
      cycleNumber,
    ),
    position: value.position ?? 'C',
    assetKey: value.assetKey ?? value.asset?.assetKey ?? '',
    asset,
    status:
      value.status === 'complete' ? 'complete' : value.status === 'active' ? 'active' : 'scheduled',
    scheduledGameIds: normalizeNumberArray(value.scheduledGameIds),
    scheduledGameDates: normalizeStringArray(value.scheduledGameDates),
    scheduledGameLabels: normalizeStringArray(value.scheduledGameLabels),
    scheduleTeamAbbreviation:
      typeof value.scheduleTeamAbbreviation === 'string'
        ? value.scheduleTeamAbbreviation
        : undefined,
    sourceTeamAbbreviationByGameId: normalizeStringRecord(
      value.sourceTeamAbbreviationByGameId,
    ),
    teamIdentityChanged: value.teamIdentityChanged === true,
    ...(playerWindowContinuity ? { playerWindowContinuity } : {}),
    ...(injuryReplacementWindow
      ? {
          injuryReplacementWindow,
          scoringAssetKeyByGameId,
        }
      : {}),
    completedGameIds: normalizeNumberArray(value.completedGameIds),
    liveGameIds: normalizeNumberArray(value.liveGameIds),
    appearanceGameIds: normalizeNumberArray(value.appearanceGameIds),
    gameScores: normalizeNumberRecord(value.gameScores),
    gameStates: normalizeGameStateRecord(value.gameStates),
    gameInputCompleteness: normalizeNhlFinalInputCompletenessRecord(
      value.gameInputCompleteness,
    ),
    incompleteFinalGameIds: normalizeNumberArray(value.incompleteFinalGameIds),
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

function normalizeSlotWindows(value: unknown): FantasyAssetCycleWindow[] {
  return Array.isArray(value)
    ? value
        .filter((entry) => Boolean(entry) && typeof entry === 'object')
        .map((entry) => normalizeSlotWindow(entry as Partial<FantasyAssetCycleWindow>))
    : [];
}

export function normalizePlayoffWindowBank(
  value: Partial<FantasyPlayoffWindowBank>,
  ownerId: string,
  windowNumber: number,
  regularSeasonCycleCount: number,
): FantasyPlayoffWindowBank {
  const sourceCycleNumber = value.sourceCycleNumber ?? regularSeasonCycleCount + windowNumber;
  const firstPickSourceNhlBlockNumber = Array.isArray(value.picks)
    ? (value.picks as DraftPick[]).find(
        (pick) => typeof pick.sourceNhlBlockNumber === 'number',
      )?.sourceNhlBlockNumber
    : undefined;

  return {
    id: value.id ?? `window-${windowNumber}`,
    ownerId: value.ownerId ?? ownerId,
    windowNumber: value.windowNumber ?? windowNumber,
    sourceCycleNumber,
    sourceNhlBlockNumber: resolveSourceNhlBlockNumber(
      value.sourceNhlBlockNumber ?? firstPickSourceNhlBlockNumber,
      sourceCycleNumber,
    ),
    sourceNhlTargetGameIdsByTeam: normalizeSourceNhlTargetGameIdsByTeam(
      value.sourceNhlTargetGameIdsByTeam,
    ),
    status:
      value.status === 'complete' ? 'complete' : value.status === 'active' ? 'active' : 'scheduled',
    assignmentStatus:
      value.assignmentStatus === 'assigned'
        ? 'assigned'
        : value.assignmentStatus === 'unused'
          ? 'unused'
          : 'unassigned',
    assignedMatchupId: typeof value.assignedMatchupId === 'string' ? value.assignedMatchupId : null,
    assignedRoundNumber:
      typeof value.assignedRoundNumber === 'number' ? value.assignedRoundNumber : null,
    expectedRosterSlotIds: normalizeStringArray(value.expectedRosterSlotIds),
    playerWindowContinuitySchemaVersion:
      typeof value.playerWindowContinuitySchemaVersion === 'number'
        ? value.playerWindowContinuitySchemaVersion
        : 0,
    picks: Array.isArray(value.picks)
      ? (value.picks as DraftPick[]).map((pick) => {
          const injuryReplacementWindow =
            requireValidInjuryReplacementWindowPlan(
              pick.injuryReplacementWindow,
              `Playoff bank pick ${pick.ownerId}/${pick.rosterSlotId ?? pick.overallPick}`,
            );

          return injuryReplacementWindow
            ? { ...pick, injuryReplacementWindow }
            : pick;
        })
      : [],
    slotWindows: normalizeSlotWindows(value.slotWindows),
    teamScore: typeof value.teamScore === 'number' ? value.teamScore : 0,
    completedWindowCount:
      typeof value.completedWindowCount === 'number' ? value.completedWindowCount : 0,
    totalWindowCount: typeof value.totalWindowCount === 'number' ? value.totalWindowCount : 0,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt ?? null,
    assignedAt: value.assignedAt ?? null,
  };
}

export async function getAllPlayoffWindowBanks(
  leagueId: string,
  playoffs: FantasyPlayoffs,
): Promise<FantasyPlayoffWindowBank[]> {
  const results = await Promise.all(
    playoffs.seeds.map(async (seed) => {
      const snapshot = await getDocs(getOwnerWindowsRef(leagueId, seed.ownerId));

      return snapshot.docs.map((windowDocument) => {
        const match = /^window-(\d+)$/.exec(windowDocument.id);
        const windowNumber = match ? Number(match[1]) : 1;

        return normalizePlayoffWindowBank(
          windowDocument.data() as Partial<FantasyPlayoffWindowBank>,
          seed.ownerId,
          windowNumber,
          playoffs.regularSeasonCycleCount,
        );
      });
    }),
  );

  return results.flat().sort((first, second) => {
    if (first.ownerId !== second.ownerId) {
      return first.ownerId.localeCompare(second.ownerId);
    }

    return first.windowNumber - second.windowNumber;
  });
}

export function getEarliestUnassignedPlayoffWindow(
  banks: FantasyPlayoffWindowBank[],
  ownerId: string,
): FantasyPlayoffWindowBank | null {
  return (
    banks
      .filter((bank) => bank.ownerId === ownerId && bank.assignmentStatus === 'unassigned')
      .sort((first, second) => first.windowNumber - second.windowNumber)[0] ?? null
  );
}

function getRosterAssetKey(asset: RosterAsset | null): string {
  if (!asset) {
    return '';
  }

  if (asset.assetKey) {
    return asset.assetKey;
  }

  if (asset.assetType === 'skater') {
    return `skater-${asset.player.id}`;
  }

  return `goalie-unit-${asset.teamAbbreviation}`;
}

function getAssetTeamAbbreviation(asset: DraftableAsset | RosterAsset): string {
  return (
    asset.assetType === 'skater'
      ? asset.player.nhlTeamAbbreviation
      : asset.teamAbbreviation
  ).trim().toUpperCase();
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
    return plannedTargets;
  }

  const initialNhlBlockNumber = resolveSourceNhlBlockNumber(
    draft.initialNhlBlockNumber,
    1,
  );

  if (sourceNhlBlockNumber === initialNhlBlockNumber) {
    const openingTargets = Object.fromEntries(
      (draft.seasonWindowAnchorTeams ?? []).map((team) => [
        team.teamAbbreviation.trim().toUpperCase(),
        team.targetGameIds.filter(
          (gameId) => Number.isSafeInteger(gameId) && gameId > 0,
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
      `The frozen NHL source-game plan is unavailable for playoff source block ${sourceNhlBlockNumber}.`,
    );
  }

  return {};
}

function projectionFields(asset: DraftableAsset | RosterAsset): DraftProjection {
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

function rosterAssetToDraftableAsset(
  asset: RosterAsset,
  sourceCycleNumber: number,
  sharedProjection: DraftableAsset | null,
  draftFallback: DraftableAsset | null,
): DraftableAsset {
  let projectionSource: DraftableAsset | RosterAsset = asset;
  let frozenProjectionSource: FrozenWindowProjectionFields['frozenProjectionSource'] = 'roster';

  const sharedTarget = sharedProjection?.targetProjectionCycleNumber;
  const sharedUsable = Boolean(
    sharedProjection &&
    getRawCycleProjection(sharedProjection) !== null &&
    (sharedTarget === null || sharedTarget === undefined || sharedTarget === sourceCycleNumber),
  );

  if (sharedUsable && sharedProjection) {
    projectionSource = sharedProjection;
    frozenProjectionSource = 'shared-snapshot';
  } else if (getRawCycleProjection(asset as unknown as DraftProjection) === null && draftFallback) {
    projectionSource = draftFallback;
    frozenProjectionSource = 'draft-pick';
  }

  const assetKey = getRosterAssetKey(asset);
  const fields = projectionFields(projectionSource);
  const base: DraftableAsset =
    asset.assetType === 'skater'
      ? {
          assetType: 'skater',
          assetKey,
          position: asset.position,
          player: asset.player,
          ...fields,
        }
      : {
          assetType: 'team-goalie-unit',
          assetKey,
          position: 'G',
          teamName: asset.teamName,
          teamAbbreviation: asset.teamAbbreviation,
          teamLogoUrl: asset.teamLogoUrl,
          ...fields,
        };

  return {
    ...base,
    ...createFrozenWindowProjectionFields(base, sourceCycleNumber, frozenProjectionSource),
  };
}

async function loadWindowProjectionAssetsByKey(
  leagueId: string,
  playoffs: FantasyPlayoffs,
  sourceCycleNumber: number,
  sourceNhlBlockNumber: number,
  sourceNhlTargetGameIdsByTeam: Readonly<Record<string, readonly number[]>>,
  seasonWindowAnchorEvidenceHash?: string | null,
): Promise<Map<string, DraftableAsset>> {
  const bundle = await ensureWindowProjectionBundle({
    leagueId,
    teamCount: Math.max(2, playoffs.seeds.length),
    requiredGamesPerCycle: defaultScoringRules.requiredGamesPerCycle,
    targetCycleNumber: sourceCycleNumber,
    targetSourceBlockNumber: sourceNhlBlockNumber,
    targetGameIdsByTeam: sourceNhlTargetGameIdsByTeam,
    seasonWindowAnchorEvidenceHash:
      seasonWindowAnchorEvidenceHash?.trim() || undefined,
  });

  if (bundle.errorMessage) {
    console.warn(
      `Playoff Window ${sourceCycleNumber - playoffs.regularSeasonCycleCount} opened with the best saved projection snapshot because the automatic refresh did not complete.`,
      bundle.errorMessage,
    );
  }

  return bundle.assetsByKey;
}

function buildSlotWindows(
  bank: FantasyPlayoffWindowBank,
  scoring: CycleScoringResult,
): FantasyAssetCycleWindow[] {
  if (
    (bank.playerWindowContinuitySchemaVersion ?? 0) >
    PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION
  ) {
    throw new Error(
      `Playoff Window ${bank.windowNumber} uses an unsupported player-window ` +
      `continuity schema.`,
    );
  }

  const previousById = new Map(bank.slotWindows.map((window) => [window.id, window] as const));

  return bank.picks.map((pick) => {
    const rosterSlotId = pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`;
    const windowId =
      pick.cycleWindowId ?? `${pick.ownerId}__${rosterSlotId}__cycle-${bank.sourceCycleNumber}`;
    const candidateSummary =
      scoring.windowScores[windowId] ?? scoring.assetScores[pick.asset.assetKey];
    const previous = previousById.get(windowId);
    const nowIso = new Date().toISOString();
    const savedInjuryReplacementWindow =
      resolveConsistentInjuryReplacementWindowPlan({
        values: [
          previous?.injuryReplacementWindow,
          pick.injuryReplacementWindow,
        ],
        context: `Playoff bank ${bank.windowNumber} ${pick.ownerId}/${rosterSlotId}`,
      });
    const scoredInjuryReplacementWindow =
      requireValidInjuryReplacementWindowPlan(
        candidateSummary?.injuryReplacementWindow,
        `Playoff scoring result ${bank.windowNumber} ${pick.ownerId}/${rosterSlotId}`,
      );
    const injuryReplacementWindow =
      resolveConsistentInjuryReplacementWindowPlan({
        values: [
          scoredInjuryReplacementWindow,
          savedInjuryReplacementWindow,
        ],
        context: `Playoff scoring ${bank.windowNumber} ${pick.ownerId}/${rosterSlotId}`,
      });

    if (
      scoredInjuryReplacementWindow &&
      !hasExactInjuryReplacementScoringAssetKeyMap(
        scoredInjuryReplacementWindow,
        candidateSummary?.scoringAssetKeyByGameId,
      )
    ) {
      throw new Error(
        `Playoff scoring ${bank.windowNumber} ${pick.ownerId}/${rosterSlotId} ` +
          'contains conflicting injury-replacement game ownership.',
      );
    }

    if (
      previous &&
      injuryReplacementWindow &&
      !hasPreservedInjuryReplacementProtectedGameOwnership({
        previousPlan: previous.injuryReplacementWindow,
        nextPlan: injuryReplacementWindow,
        protectedGameIds: getInjuryReplacementProtectedGameIds(previous),
        previousAssetKey: previous.assetKey,
        previousScheduleTeamAbbreviation: previous.scheduleTeamAbbreviation,
        previousSourceTeamAbbreviationByGameId:
          previous.sourceTeamAbbreviationByGameId,
      })
    ) {
      throw new Error(
        `Playoff scoring ${bank.windowNumber} ${pick.ownerId}/${rosterSlotId} ` +
          'changed protected injury-replacement game ownership.',
      );
    }

    const summaryMatchesSavedInjuryOwnership =
      !savedInjuryReplacementWindow ||
      Boolean(
        scoredInjuryReplacementWindow &&
        getInjuryReplacementPlanAuthorityFingerprint(
          injuryReplacementWindow!,
        ) ===
          getInjuryReplacementPlanAuthorityFingerprint(
            scoredInjuryReplacementWindow,
          ),
      );
    const summary = summaryMatchesSavedInjuryOwnership
      ? candidateSummary
      : undefined;
    const playerWindowContinuity = resolveConsistentPlayerWindowContinuity({
      values: [
        summary?.playerWindowContinuity,
        previous?.playerWindowContinuity,
        pick.playerWindowContinuity,
      ],
      ownerId: pick.ownerId,
      rosterSlotId,
      asset: pick.asset,
    });
    const scoringAssetKeyByGameId = injuryReplacementWindow
      ? getInjuryReplacementAssetKeyByGameId(injuryReplacementWindow)
      : undefined;

    if (
      bank.playerWindowContinuitySchemaVersion ===
        PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION &&
      pick.asset.assetType === 'skater' &&
      !playerWindowContinuity
    ) {
      throw new Error(
        `Playoff Window ${bank.windowNumber} requires player-window continuity ` +
        `for ${pick.ownerId}/${rosterSlotId}/${pick.asset.assetKey}.`,
      );
    }

    return {
      id: windowId,
      ownerId: pick.ownerId,
      rosterSlotId,
      cycleNumber: bank.sourceCycleNumber,
      sourceNhlBlockNumber: resolveSourceNhlBlockNumber(
        summary?.sourceNhlBlockNumber ?? pick.sourceNhlBlockNumber ?? bank.sourceNhlBlockNumber,
        bank.sourceCycleNumber,
      ),
      position: pick.asset.position,
      assetKey: pick.asset.assetKey,
      asset: pick.asset,
      status: summary?.status ?? previous?.status ?? 'scheduled',
      scheduledGameIds:
        summary?.scheduledGameIds ?? previous?.scheduledGameIds ?? [],
      scheduledGameDates:
        summary?.scheduledGameDates ?? previous?.scheduledGameDates ?? [],
      scheduledGameLabels:
        summary?.scheduledGameLabels ?? previous?.scheduledGameLabels ?? [],
      scheduleTeamAbbreviation:
        summary?.scheduleTeamAbbreviation ?? previous?.scheduleTeamAbbreviation,
      sourceTeamAbbreviationByGameId:
        summary?.sourceTeamAbbreviationByGameId ??
        previous?.sourceTeamAbbreviationByGameId ??
        {},
      teamIdentityChanged:
        summary?.teamIdentityChanged ?? previous?.teamIdentityChanged ?? false,
      ...(playerWindowContinuity ? { playerWindowContinuity } : {}),
      ...(injuryReplacementWindow
        ? {
            injuryReplacementWindow,
            scoringAssetKeyByGameId,
          }
        : {}),
      completedGameIds: summary?.completedGameIds ?? previous?.completedGameIds ?? [],
      liveGameIds: summary?.liveGameIds ?? previous?.liveGameIds ?? [],
      appearanceGameIds: summary?.appearanceGameIds ?? previous?.appearanceGameIds ?? [],
      gameScores: summary?.gameScores ?? previous?.gameScores ?? {},
      gameStates: summary?.gameStates ?? previous?.gameStates ?? {},
      gameInputCompleteness:
        summary?.gameInputCompleteness ?? previous?.gameInputCompleteness ?? {},
      incompleteFinalGameIds:
        summary?.incompleteFinalGameIds ?? previous?.incompleteFinalGameIds ?? [],
      scheduledGames:
        summary?.scheduledGames ?? previous?.scheduledGames ?? 0,
      gamesPlayed: summary?.gamesPlayed ?? previous?.gamesPlayed ?? 0,
      actualGamesPlayed:
        summary?.actualGamesPlayed ?? previous?.actualGamesPlayed ?? 0,
      gamesLeft: summary?.gamesLeft ?? previous?.gamesLeft ?? 0,
      fantasyPoints:
        summary?.currentScore ?? previous?.fantasyPoints ?? 0,
      frozenProjectionPoints:
        pick.asset.frozenCycleProjectionPoints ?? pick.asset.projectedCyclePoints ?? null,
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
        summary?.scheduledGameIds ?? previous?.frozenProjectionTargetGameIds ?? [],
      firstScheduledGameDate:
        summary?.firstScheduledGameDate ?? previous?.firstScheduledGameDate ?? null,
      lastScheduledGameDate:
        summary?.lastScheduledGameDate ?? previous?.lastScheduledGameDate ?? null,
      startedAt:
        (summary?.status ?? previous?.status) === 'scheduled'
          ? (previous?.startedAt ?? null)
          : (previous?.startedAt ?? nowIso),
      completedAt:
        (summary?.status ?? previous?.status) === 'complete'
          ? (previous?.completedAt ?? nowIso)
          : null,
      createdAt: previous?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
  });
}

function bankFingerprint(bank: FantasyPlayoffWindowBank): string {
  return JSON.stringify({
    status: bank.status,
    assignmentStatus: bank.assignmentStatus,
    assignedMatchupId: bank.assignedMatchupId,
    assignedRoundNumber: bank.assignedRoundNumber,
    teamScore: bank.teamScore,
    completedWindowCount: bank.completedWindowCount,
    slotWindows: bank.slotWindows.map((window) => ({
      id: window.id,
      status: window.status,
      completedGameIds: window.completedGameIds,
      liveGameIds: window.liveGameIds,
      appearanceGameIds: window.appearanceGameIds,
      gameScores: window.gameScores,
      gameStates: window.gameStates,
      scheduleTeamAbbreviation: window.scheduleTeamAbbreviation ?? '',
      sourceTeamAbbreviationByGameId:
        window.sourceTeamAbbreviationByGameId ?? {},
      teamIdentityChanged: window.teamIdentityChanged === true,
      playerWindowContinuity: window.playerWindowContinuity ?? null,
      injuryReplacementWindow: window.injuryReplacementWindow ?? null,
      scoringAssetKeyByGameId: window.scoringAssetKeyByGameId ?? {},
      gameInputCompleteness: window.gameInputCompleteness ?? {},
      incompleteFinalGameIds: window.incompleteFinalGameIds ?? [],
      fantasyPoints: window.fantasyPoints,
      frozenProjectionPoints: window.frozenProjectionPoints,
      frozenProjectionVersion: window.frozenProjectionVersion,
      frozenProjectionSnapshotId: window.frozenProjectionSnapshotId,
      frozenProjectionFrozenAt: window.frozenProjectionFrozenAt,
      frozenProjectionTargetGameIds: window.frozenProjectionTargetGameIds,
    })),
  });
}

function bankPickAuthorityFingerprint(picks: readonly DraftPick[]): string {
  return JSON.stringify(
    [...picks]
      .map((pick) => {
        const rosterSlotId = pick.rosterSlotId ??
          `legacy-pick-${pick.overallPick}`;
        const continuity = resolvePlayerWindowContinuity({
          value: pick.playerWindowContinuity,
          ownerId: pick.ownerId,
          rosterSlotId,
          asset: pick.asset,
        });

        return {
          ownerId: pick.ownerId,
          rosterSlotId,
          assetKey: pick.asset.assetKey,
          currentTeamAbbreviation: getAssetTeamAbbreviation(pick.asset),
          cycleWindowId: pick.cycleWindowId ?? '',
          snapshotCycleNumber: pick.snapshotCycleNumber ?? null,
          playoffWindowNumber: pick.playoffWindowNumber ?? null,
          continuityId: continuity?.continuityId ?? '',
          injuryReplacementWindow:
            requireValidInjuryReplacementWindowPlan(
              pick.injuryReplacementWindow,
              `Playoff pick fingerprint ${pick.ownerId}/${rosterSlotId}`,
            ) ?? null,
          sourceNhlTargetGameIds: pick.sourceNhlTargetGameIds ?? [],
        };
      })
      .sort((first, second) =>
        `${first.ownerId}::${first.rosterSlotId}`.localeCompare(
          `${second.ownerId}::${second.rosterSlotId}`,
        ),
      ),
  );
}

function bankAuthorityFingerprint(bank: FantasyPlayoffWindowBank): string {
  return JSON.stringify({
    ownerId: bank.ownerId,
    windowNumber: bank.windowNumber,
    sourceCycleNumber: bank.sourceCycleNumber,
    sourceNhlBlockNumber: bank.sourceNhlBlockNumber ?? null,
    assignmentStatus: bank.assignmentStatus,
    assignedMatchupId: bank.assignedMatchupId,
    assignedRoundNumber: bank.assignedRoundNumber,
    expectedRosterSlotIds: [...bank.expectedRosterSlotIds].sort(),
    playerWindowContinuitySchemaVersion:
      bank.playerWindowContinuitySchemaVersion ?? 0,
    pickAuthority: bankPickAuthorityFingerprint(bank.picks),
  });
}

function buildPreviousScoringResultFromBanks(
  banks: FantasyPlayoffWindowBank[],
): CycleScoringResult | null {
  const slotWindows = banks.flatMap((bank) => bank.slotWindows);

  if (slotWindows.length === 0) {
    return null;
  }

  const assetScores: CycleScoringResult['assetScores'] = {};
  const windowScores: CycleScoringResult['windowScores'] = {};
  const teamScores: Record<string, number> = {};
  const teamCycleComplete: Record<string, boolean> = {};
  let hasLiveGames = false;
  let hasIncompleteFinalGames = false;

  for (const window of slotWindows) {
    const summary = {
      assetKey: window.assetKey,
      ownerId: window.ownerId,
      rosterSlotId: window.rosterSlotId,
      windowId: window.id,
      sourceNhlBlockNumber: resolveSourceNhlBlockNumber(
        window.sourceNhlBlockNumber,
        window.cycleNumber,
      ),
      currentScore: window.fantasyPoints,
      gamesPlayed: window.gamesPlayed,
      actualGamesPlayed: window.actualGamesPlayed,
      scheduledGames: window.scheduledGames,
      gamesLeft: window.gamesLeft,
      scheduledGameIds: window.scheduledGameIds,
      scheduledGameDates: window.scheduledGameDates,
      scheduledGameLabels: window.scheduledGameLabels,
      scheduleTeamAbbreviation: window.scheduleTeamAbbreviation,
      sourceTeamAbbreviationByGameId:
        window.sourceTeamAbbreviationByGameId ?? {},
      teamIdentityChanged: window.teamIdentityChanged === true,
      ...(window.playerWindowContinuity
        ? {
            playerWindowContinuityId:
              window.playerWindowContinuity.continuityId,
          }
        : {}),
      ...(window.injuryReplacementWindow
        ? {
            injuryReplacementWindow: window.injuryReplacementWindow,
            scoringAssetKeyByGameId:
              window.scoringAssetKeyByGameId ??
              getInjuryReplacementAssetKeyByGameId(
                window.injuryReplacementWindow,
              ),
          }
        : {}),
      completedGameIds: window.completedGameIds,
      liveGameIds: window.liveGameIds,
      appearanceGameIds: window.appearanceGameIds,
      gameScores: window.gameScores,
      gameStates: window.gameStates,
      gameInputCompleteness: window.gameInputCompleteness ?? {},
      incompleteFinalGameIds: window.incompleteFinalGameIds ?? [],
      firstScheduledGameDate: window.firstScheduledGameDate,
      lastScheduledGameDate: window.lastScheduledGameDate,
      status: window.status,
    };

    windowScores[window.id] = summary;
    assetScores[window.assetKey] = summary;
    teamScores[window.ownerId] = Number(
      ((teamScores[window.ownerId] ?? 0) + window.fantasyPoints).toFixed(1),
    );
    hasLiveGames = hasLiveGames || window.liveGameIds.length > 0;
    hasIncompleteFinalGames = hasIncompleteFinalGames ||
      (window.incompleteFinalGameIds?.length ?? 0) > 0;
  }

  for (const bank of banks) {
    teamCycleComplete[bank.ownerId] = bank.status === 'complete';
  }

  return {
    scoringSchemaVersion: 2,
    assetScores,
    windowScores,
    teamScores,
    teamGameCounts: {},
    teamCycleComplete,
    cycleHasScheduledGames: slotWindows.some((window) => window.scheduledGames > 0),
    hasLiveGames,
    hasIncompleteFinalGames,
    nextScheduledGameStart: null,
    refreshedAt: new Date().toISOString(),
    dataFingerprint: banks
      .map((bank) => bankFingerprint(bank))
      .sort()
      .join('|'),
  };
}

export async function syncPlayoffWindowBankScores(input: {
  leagueId: string;
  playoffs: FantasyPlayoffs;
  season: string;
  requiredGamesPerCycle: number;
  scoringRules: ScoringRules;
  assignedPicks?: DraftPick[];
  assignedScoring?: CycleScoringResult | null;
  replayGamesByAssetKey?: Record<string, NhlTeamSeasonGame[]>;
  replaySourceTeamAbbreviationByAssetGameId?: Record<string, Record<string, string>>;
  gameLogSeason?: string;
  currentTeamAbbreviationByPlayerId?: ReadonlyMap<number, string>;
  currentTeamConfirmedAtByPlayerId?: ReadonlyMap<number, string>;
  currentTeamIdentityHash?: string;
  currentTeamIdentityGeneratedAt?: string;
}): Promise<FantasyPlayoffWindowBank[]> {
  const [banks, draftAuthoritySnapshot] = await Promise.all([
    getAllPlayoffWindowBanks(input.leagueId, input.playoffs),
    getDoc(getDraftRef(input.leagueId)),
  ]);
  const draftAuthority = draftAuthoritySnapshot.exists()
    ? (draftAuthoritySnapshot.data() as FantasyDraft)
    : null;
  const scoringByOwnerWindow = new Map<string, CycleScoringResult>();
  let currentTeamAbbreviationByPlayerId =
    input.currentTeamAbbreviationByPlayerId;
  let currentTeamConfirmedAtByPlayerId =
    input.currentTeamConfirmedAtByPlayerId;
  let currentTeamIdentityHash = input.currentTeamIdentityHash;
  let currentTeamIdentityGeneratedAt =
    input.currentTeamIdentityGeneratedAt;

  if (input.assignedPicks?.length && input.assignedScoring) {
    const ownerWindowPairs = new Set(
      input.assignedPicks.map((pick) => `${pick.ownerId}::${pick.playoffWindowNumber ?? 1}`),
    );

    for (const pair of ownerWindowPairs) {
      scoringByOwnerWindow.set(pair, input.assignedScoring);
    }
  }

  const unassignedBanks = banks.filter(
    (bank) => bank.assignmentStatus === 'unassigned' && bank.picks.length > 0,
  );

  if (unassignedBanks.length > 0) {
    const banksBySourceBlock = new Map<number, FantasyPlayoffWindowBank[]>();

    for (const bank of unassignedBanks) {
      const sourceNhlBlockNumber = resolveSourceNhlBlockNumber(
        bank.sourceNhlBlockNumber,
        bank.sourceCycleNumber,
      );
      const groupedBanks = banksBySourceBlock.get(sourceNhlBlockNumber) ?? [];
      groupedBanks.push(bank);
      banksBySourceBlock.set(sourceNhlBlockNumber, groupedBanks);
    }

    for (const [sourceNhlBlockNumber, groupedBanks] of banksBySourceBlock) {
      const sourceNhlTargetGameIdsByTeam =
        groupedBanks.find(
          (bank) => Object.keys(bank.sourceNhlTargetGameIdsByTeam ?? {}).length > 0,
        )?.sourceNhlTargetGameIdsByTeam ??
        (draftAuthority
          ? getDraftSourceNhlTargetGameIdsByTeam(
              draftAuthority,
              sourceNhlBlockNumber,
            )
          : {});
      const unassignedPicks = groupedBanks.flatMap((bank) =>
        bank.picks.map((pick) => ({
          ...pick,
          sourceNhlBlockNumber,
          sourceNhlTargetGameIds:
            sourceNhlTargetGameIdsByTeam[getAssetTeamAbbreviation(pick.asset)] ??
            pick.sourceNhlTargetGameIds,
          sourceNhlTargetGameIdsByTeam: {
            ...sourceNhlTargetGameIdsByTeam,
          },
        })),
      );
      const expectedRosterSlotIdsByOwner = Object.fromEntries(
        groupedBanks.map((bank) => [bank.ownerId, bank.expectedRosterSlotIds]),
      );
      const previousResult = buildPreviousScoringResultFromBanks(groupedBanks);
      const calculateScoringPass = () => calculateCycleScoring({
          picks: unassignedPicks,
          cycleNumber: input.playoffs.regularSeasonCycleCount + 1,
          season: input.season,
          requiredGamesPerCycle: input.requiredGamesPerCycle,
          scoringRules: input.scoringRules,
          expectedRosterSlotIdsByOwner,
          previousResult,
          sourceNhlTargetGameIdsByTeam,
          seasonSourceGameIdsByTeam:
            resolveFrozenSeasonSourceGameIdsByTeam(draftAuthority),
          currentTeamIdentityHash,
          currentTeamIdentityGeneratedAt,
          currentTeamConfirmedAtByPlayerId,
          replayGamesByAssetKey: input.replayGamesByAssetKey,
          replaySourceTeamAbbreviationByAssetGameId:
            input.replaySourceTeamAbbreviationByAssetGameId,
          gameLogSeason: input.gameLogSeason,
          currentTeamAbbreviationByPlayerId,
        });
      let scoring: CycleScoringResult;

      try {
        scoring = await calculateScoringPass();
      } catch (error: unknown) {
        if (
          input.replayGamesByAssetKey ||
          !(error instanceof NhlPlayerTeamIdentityBoundaryRefreshRequiredError)
        ) {
          throw error;
        }

        const requiredPlayerIds = [
          ...new Set(
            unassignedPicks
              .filter((pick) => pick.asset.assetType === 'skater')
              .map((pick) =>
                pick.asset.assetType === 'skater'
                  ? pick.asset.player.id
                  : 0,
              )
              .filter((playerId) => playerId > 0),
          ),
        ];
        const identity = await loadCurrentNhlPlayerTeamIdentity({
          requiredPlayerIds,
          minimumGeneratedAtMilliseconds:
            error.minimumGeneratedAtMilliseconds,
        });
        currentTeamAbbreviationByPlayerId = identity.byPlayerId;
        currentTeamConfirmedAtByPlayerId =
          identity.teamConfirmedAtByPlayerId;
        currentTeamIdentityHash = identity.identityHash;
        currentTeamIdentityGeneratedAt = identity.generatedAt;
        scoring = await calculateScoringPass();
      }

      for (const bank of groupedBanks) {
        scoringByOwnerWindow.set(`${bank.ownerId}::${bank.windowNumber}`, scoring);
      }
    }
  }

  const updatedBanks: FantasyPlayoffWindowBank[] = [];

  for (const bank of banks) {
    const scoring = scoringByOwnerWindow.get(`${bank.ownerId}::${bank.windowNumber}`);

    if (!scoring) {
      updatedBanks.push(bank);
      continue;
    }

    const expectedAuthorityFingerprint = bankAuthorityFingerprint(bank);
    const expectedScoringFingerprint = bankFingerprint(bank);
    const next = await runTransaction(db, async (transaction) => {
      const reference = getPlayoffWindowBankRef(
        input.leagueId,
        bank.ownerId,
        bank.windowNumber,
      );
      const snapshot = await transaction.get(reference);

      if (!snapshot.exists()) {
        throw new Error(
          `Playoff Window ${bank.windowNumber} for ${bank.ownerId} disappeared during scoring.`,
        );
      }

      const current = normalizePlayoffWindowBank(
        snapshot.data() as Partial<FantasyPlayoffWindowBank>,
        bank.ownerId,
        bank.windowNumber,
        input.playoffs.regularSeasonCycleCount,
      );

      if (
        bankAuthorityFingerprint(current) !== expectedAuthorityFingerprint ||
        bankFingerprint(current) !== expectedScoringFingerprint
      ) {
        throw new Error(
          `Playoff Window ${bank.windowNumber} for ${bank.ownerId} changed during scoring. ` +
          'The stale scoring pass was discarded and will retry.',
        );
      }

      if (current.assignmentStatus === 'assigned') {
        const assignedPicks = (input.assignedPicks ?? []).filter(
          (pick) =>
            pick.ownerId === current.ownerId &&
            (pick.playoffWindowNumber ?? 1) === current.windowNumber,
        );

        if (
          assignedPicks.length === 0 ||
          bankPickAuthorityFingerprint(assignedPicks) !==
            bankPickAuthorityFingerprint(current.picks)
        ) {
          throw new Error(
            `Assigned Playoff Window ${current.windowNumber} for ${current.ownerId} ` +
            'does not match the active cycle picks. Scoring was left unchanged.',
          );
        }
      }

      const slotWindows = buildSlotWindows(current, scoring);
      const completedWindowCount = slotWindows.filter(
        (window) => window.status === 'complete',
      ).length;
      const totalWindowCount = current.expectedRosterSlotIds.length;
      const complete = totalWindowCount > 0 &&
        completedWindowCount >= totalWindowCount;
      const active = slotWindows.some(
        (window) => window.status !== 'scheduled',
      );
      const status = complete
        ? 'complete' as const
        : active
          ? 'active' as const
          : 'scheduled' as const;
      const teamScore = Number(
        slotWindows
          .reduce((total, window) => total + window.fantasyPoints, 0)
          .toFixed(1),
      );
      const completedAt = complete
        ? current.completedAt ?? serverTimestamp()
        : null;
      const nextBank: FantasyPlayoffWindowBank = {
        ...current,
        slotWindows,
        teamScore,
        completedWindowCount,
        totalWindowCount,
        status,
        updatedAt: serverTimestamp(),
        completedAt,
      };

      if (bankFingerprint(current) !== bankFingerprint(nextBank)) {
        transaction.set(
          reference,
          {
            slotWindows,
            teamScore,
            completedWindowCount,
            totalWindowCount,
            status,
            completedAt,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      }

      return nextBank;
    });

    updatedBanks.push(next);
  }

  return updatedBanks;
}

export function createInitialPlayoffBankPayloads(
  playoffs: FantasyPlayoffs,
  picks: DraftPick[],
  sourceNhlTargetGameIdsByTeam: Readonly<Record<string, number[]>> = {},
): FantasyPlayoffWindowBank[] {
  return playoffs.seeds.map((seed) => {
    const sourceCycleNumber = playoffs.regularSeasonCycleCount + 1;
    const seedPicks = picks.filter((pick) => pick.ownerId === seed.ownerId);
    const sourceNhlBlockNumber = resolveSourceNhlBlockNumber(
      seedPicks.find((pick) => typeof pick.sourceNhlBlockNumber === 'number')
        ?.sourceNhlBlockNumber,
      sourceCycleNumber,
    );
    const ownerPicks = picks
      .filter((pick) => pick.ownerId === seed.ownerId)
      .map((pick) => {
        const {
          sourceNhlTargetGameIds: existingSourceNhlTargetGameIds,
          ...persistedPick
        } = pick;
        const sourceNhlTargetGameIds =
          sourceNhlTargetGameIdsByTeam[getAssetTeamAbbreviation(pick.asset)] ??
          existingSourceNhlTargetGameIds;

        return {
          ...persistedPick,
          snapshotCycleNumber: sourceCycleNumber,
          sourceNhlBlockNumber,
          ...(sourceNhlTargetGameIds === undefined
            ? {}
            : { sourceNhlTargetGameIds }),
          sourceNhlTargetGameIdsByTeam: { ...sourceNhlTargetGameIdsByTeam },
          playoffWindowNumber: 1,
          cycleWindowId: `${seed.ownerId}__${pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`}__cycle-${sourceCycleNumber}`,
        };
      });
    const expectedRosterSlotIds = ownerPicks.map(
      (pick) => pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`,
    );

    for (const pick of ownerPicks) {
      if (pick.asset.assetType !== 'skater') {
        continue;
      }

      const rosterSlotId = pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`;

      if (!resolvePlayerWindowContinuity({
        value: pick.playerWindowContinuity,
        ownerId: pick.ownerId,
        rosterSlotId,
        asset: pick.asset,
      })) {
        throw new Error(
          `Playoff Window 1 cannot open without player-window continuity for ` +
          `${pick.ownerId}/${rosterSlotId}/${pick.asset.assetKey}.`,
        );
      }
    }

    return {
      id: 'window-1',
      ownerId: seed.ownerId,
      windowNumber: 1,
      sourceCycleNumber,
      sourceNhlBlockNumber,
      sourceNhlTargetGameIdsByTeam: { ...sourceNhlTargetGameIdsByTeam },
      status: 'scheduled',
      assignmentStatus: 'unassigned',
      assignedMatchupId: null,
      assignedRoundNumber: null,
      expectedRosterSlotIds,
      playerWindowContinuitySchemaVersion:
        PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
      picks: ownerPicks,
      slotWindows: [],
      teamScore: 0,
      completedWindowCount: 0,
      totalWindowCount: expectedRosterSlotIds.length,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      completedAt: null,
      assignedAt: null,
    };
  });
}

export async function ensureNextPlayoffBankWindows(input: {
  leagueId: string;
  playoffs: FantasyPlayoffs;
  banks: FantasyPlayoffWindowBank[];
}): Promise<void> {
  const completeBanks = input.banks.filter((bank) => {
    if (bank.status !== 'complete' || bank.windowNumber >= input.playoffs.playoffRoundCount) {
      return false;
    }

    if (bank.assignmentStatus === 'unassigned') {
      return true;
    }

    if (!bank.assignedMatchupId) {
      return true;
    }

    return input.playoffs.matchups.some(
      (matchup) =>
        ((matchup.sourceA.type === 'winner' || matchup.sourceA.type === 'loser') &&
          matchup.sourceA.matchupId === bank.assignedMatchupId) ||
        ((matchup.sourceB.type === 'winner' || matchup.sourceB.type === 'loser') &&
          matchup.sourceB.matchupId === bank.assignedMatchupId),
    );
  });

  for (const bank of completeBanks) {
    const nextWindowNumber = bank.windowNumber + 1;
    const existing = input.banks.some(
      (candidate) =>
        candidate.ownerId === bank.ownerId && candidate.windowNumber === nextWindowNumber,
    );

    if (existing) {
      continue;
    }

    await createNextPlayoffBankWindow(
      input.leagueId,
      input.playoffs,
      bank.ownerId,
      nextWindowNumber,
      resolveSourceNhlBlockNumber(
        bank.sourceNhlBlockNumber,
        bank.sourceCycleNumber,
      ) + 1,
    );
  }
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

async function createNextPlayoffBankWindow(
  leagueId: string,
  playoffs: FantasyPlayoffs,
  ownerId: string,
  windowNumber: number,
  sourceNhlBlockNumber: number,
): Promise<void> {
  const sourceCycleNumber = playoffs.regularSeasonCycleCount + windowNumber;
  const [draftSnapshot, draftAuthoritySnapshot] = await Promise.all([
    getDocs(getDraftPicksRef(leagueId)),
    getDoc(getDraftRef(leagueId)),
  ]);
  const draftPicks = draftSnapshot.docs.map((document) => document.data() as DraftPick);
  const draftAuthority = draftAuthoritySnapshot.exists()
    ? (draftAuthoritySnapshot.data() as FantasyDraft)
    : null;

  if (!draftAuthority || draftAuthority.status !== 'complete') {
    throw new Error('The completed draft is required to open a playoff window.');
  }

  const sourceNhlTargetGameIdsByTeam = getDraftSourceNhlTargetGameIdsByTeam(
    draftAuthority,
    sourceNhlBlockNumber,
  );
  const projectionAssetsByKey = await loadWindowProjectionAssetsByKey(
    leagueId,
    playoffs,
    sourceCycleNumber,
    sourceNhlBlockNumber,
    sourceNhlTargetGameIdsByTeam,
    draftAuthority.seasonWindowAnchorEvidenceHash,
  );
  const draftByAssetKey = new Map(
    draftPicks
      .filter((pick) => pick.ownerId === ownerId)
      .map((pick) => [pick.asset.assetKey, pick] as const),
  );
  const rosterRef = getTeamRosterRef(leagueId, ownerId);
  const bankRef = getPlayoffWindowBankRef(leagueId, ownerId, windowNumber);
  const previousBankRef = windowNumber > 1
    ? getPlayoffWindowBankRef(leagueId, ownerId, windowNumber - 1)
    : null;

  await runTransaction(db, async (transaction) => {
    const [
      rosterSnapshot,
      bankSnapshot,
      savedDraftSnapshot,
      previousBankSnapshot,
    ] = await Promise.all([
      transaction.get(rosterRef),
      transaction.get(bankRef),
      transaction.get(getDraftRef(leagueId)),
      previousBankRef ? transaction.get(previousBankRef) : Promise.resolve(null),
    ]);

    if (bankSnapshot.exists()) {
      return;
    }

    if (!savedDraftSnapshot.exists()) {
      throw new Error('The completed draft is required to open a playoff window.');
    }

    const savedDraft = savedDraftSnapshot.data() as FantasyDraft;

    if (
      savedDraft.status !== 'complete' ||
      JSON.stringify(
        getDraftSourceNhlTargetGameIdsByTeam(savedDraft, sourceNhlBlockNumber),
      ) !== JSON.stringify(sourceNhlTargetGameIdsByTeam)
    ) {
      throw new Error(
        'The frozen NHL source-game plan changed while the playoff window was opening.',
      );
    }

    if (!rosterSnapshot.exists()) {
      throw new Error(`Roster ${ownerId} is missing while opening playoff window ${windowNumber}.`);
    }

    const previousBank = previousBankSnapshot?.exists
      ? normalizePlayoffWindowBank(
          previousBankSnapshot.data() as Partial<FantasyPlayoffWindowBank>,
          ownerId,
          windowNumber - 1,
          playoffs.regularSeasonCycleCount,
        )
      : null;

    if (windowNumber > 1 && (!previousBank || previousBank.status !== 'complete')) {
      throw new Error(
        `Playoff Window ${windowNumber - 1} must be complete before Window ${windowNumber} opens.`,
      );
    }

    if (
      windowNumber > 1 &&
      previousBank?.playerWindowContinuitySchemaVersion !==
        PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION
    ) {
      throw new Error(
        `Playoff Window ${windowNumber - 1} predates required player-window ` +
        `continuity. The next bank was not opened from incomplete legacy evidence.`,
      );
    }

    const previousPickBySlotId = new Map(
      (previousBank?.picks ?? []).map((pick) => [
        pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`,
        pick,
      ] as const),
    );
    const previousWindowBySlotId = new Map(
      (previousBank?.slotWindows ?? []).map((window) => [
        window.rosterSlotId,
        window,
      ] as const),
    );
    const previousContinuityBySlotId = new Map<string, ReturnType<
      typeof resolveConsistentPlayerWindowContinuity
    >>();

    for (const previousPick of previousBank?.picks ?? []) {
      if (previousPick.asset.assetType !== 'skater') {
        continue;
      }

      const rosterSlotId = previousPick.rosterSlotId ??
        `legacy-pick-${previousPick.overallPick}`;
      const previousWindow = previousWindowBySlotId.get(rosterSlotId);

      if (
        !previousWindow ||
        previousWindow.status !== 'complete' ||
        previousWindow.assetKey !== previousPick.asset.assetKey
      ) {
        throw new Error(
          `Playoff Window ${windowNumber - 1} is missing the completed window ` +
          `for ${ownerId}/${rosterSlotId}/${previousPick.asset.assetKey}.`,
        );
      }

      const continuity = resolveConsistentPlayerWindowContinuity({
        values: [
          previousPick.playerWindowContinuity,
          previousWindow.playerWindowContinuity,
        ],
        ownerId,
        rosterSlotId,
        asset: previousPick.asset,
      });

      if (!continuity) {
        throw new Error(
          `Playoff Window ${windowNumber - 1} is missing required player-window ` +
          `continuity for ${ownerId}/${rosterSlotId}/${previousPick.asset.assetKey}.`,
        );
      }

      previousContinuityBySlotId.set(rosterSlotId, continuity);
    }

    const roster = normalizeFantasyRoster(rosterSnapshot.data() as Partial<FantasyRoster>);
    const picks: DraftPick[] = [];

    for (const [slotIndex, slot] of roster.activeSlots.entries()) {
      const outgoingAsset = slot.asset;
      const pendingMoveReady = canActivatePendingMoveInCycle(slot.pendingMove, sourceCycleNumber);
      const incomingAsset = pendingMoveReady
        ? (slot.pendingMove?.incomingAsset ?? outgoingAsset)
        : outgoingAsset;

      if (!incomingAsset) {
        continue;
      }

      const incomingAssetKey = getRosterAssetKey(incomingAsset);
      const draftFallback = draftByAssetKey.get(incomingAssetKey)?.asset ?? null;
      const nextDraftableAsset = rosterAssetToDraftableAsset(
        incomingAsset,
        sourceCycleNumber,
        projectionAssetsByKey.get(incomingAssetKey) ?? null,
        draftFallback,
      );
      const previousPick = previousPickBySlotId.get(slot.slotId);
      const previousWindow = previousWindowBySlotId.get(slot.slotId);
      const previousContinuity = previousContinuityBySlotId.get(slot.slotId);
      const previousInjuryReplacementWindow =
        resolveConsistentInjuryReplacementWindowPlan({
          values: [
            previousWindow?.injuryReplacementWindow,
            previousPick?.injuryReplacementWindow,
          ],
          context: `Playoff rollover ${ownerId}/${slot.slotId}`,
        });
      const currentInjurySegment =
        previousInjuryReplacementWindow?.segments.at(-1);
      const playerWindowContinuity = pendingMoveReady && slot.pendingMove
        ? createPlayerWindowContinuity({
            ownerId,
            rosterSlotId: slot.slotId,
            asset: nextDraftableAsset,
            activationKey: `move-${slot.pendingMove.id}`,
            assignmentNotBefore: Date.now(),
          })
        : previousPick && previousWindow
          ? advancePlayerWindowContinuity({
              previousAsset: previousPick.asset,
              nextAsset: nextDraftableAsset,
              previousContinuity,
              completedScheduledGameIds:
                currentInjurySegment?.scheduledGameIds ??
                previousWindow.scheduledGameIds,
              completedScheduleTeamAbbreviation:
                currentInjurySegment?.sourceTeamAbbreviation ??
                previousWindow.scheduleTeamAbbreviation,
              ownerId,
              rosterSlotId: slot.slotId,
              activationKey: `playoff-window-${windowNumber}`,
              assignmentNotBefore: previousPick.snapshottedAt,
            })
          : createPlayerWindowContinuity({
              ownerId,
              rosterSlotId: slot.slotId,
              asset: nextDraftableAsset,
              activationKey: `playoff-window-${windowNumber}`,
            });
      const pick: DraftPick = {
        overallPick: draftByAssetKey.get(incomingAssetKey)?.overallPick ?? 100000 + slotIndex + 1,
        round: draftByAssetKey.get(incomingAssetKey)?.round ?? 0,
        pickInRound: draftByAssetKey.get(incomingAssetKey)?.pickInRound ?? slot.slotNumber,
        ownerId,
        rosterSlotId: slot.slotId,
        cycleWindowId: `${ownerId}__${slot.slotId}__cycle-${sourceCycleNumber}`,
        snapshotCycleNumber: sourceCycleNumber,
        sourceNhlBlockNumber,
        ...(sourceNhlTargetGameIdsByTeam[getAssetTeamAbbreviation(incomingAsset)]
          ? {
              sourceNhlTargetGameIds:
                sourceNhlTargetGameIdsByTeam[getAssetTeamAbbreviation(incomingAsset)],
            }
          : {}),
        sourceNhlTargetGameIdsByTeam: { ...sourceNhlTargetGameIdsByTeam },
        ...(playerWindowContinuity ? { playerWindowContinuity } : {}),
        snapshotSource: pendingMoveReady && slot.pendingMove
          ? 'queued-playoff-slot-move'
          : 'playoff-window-open',
        snapshottedAt: new Date().toISOString(),
        playoffWindowNumber: windowNumber,
        snapshotOrder: draftByAssetKey.get(incomingAssetKey)?.overallPick ?? 100000 + slotIndex + 1,
        asset: nextDraftableAsset,
      };

      picks.push(pick);

      if (slot.pendingMove && pendingMoveReady) {
        const pendingMove = slot.pendingMove;
        const sourceBenchSlotId = pendingMove.sourceBenchSlotId ?? null;

        if (sourceBenchSlotId) {
          const benchSlotIndex = roster.benchSlots.findIndex(
            (benchSlot) => benchSlot.slotId === sourceBenchSlotId,
          );

          if (benchSlotIndex === -1) {
            throw new Error(
              `Bench slot ${sourceBenchSlotId} was not found while opening playoff window ${windowNumber}.`,
            );
          }

          const benchSlot = roster.benchSlots[benchSlotIndex];
          if (getRosterAssetKey(benchSlot.asset) !== incomingAssetKey) {
            throw new Error('The reserved bench asset changed before its playoff activation.');
          }

          roster.benchSlots[benchSlotIndex] = {
            ...benchSlot,
            asset: outgoingAsset
              ? { ...outgoingAsset, rosterStatus: 'benched' }
              : null,
          };
        }

        slot.asset = { ...pendingMove.incomingAsset, rosterStatus: 'active' };
        slot.pendingMove = null;

        if (!sourceBenchSlotId && outgoingAsset) {
          const outgoingAssetKey = getRosterAssetKey(outgoingAsset);

          if (outgoingAssetKey && outgoingAssetKey !== incomingAssetKey) {
            const outgoingDraftable = rosterAssetToDraftableAsset(
              outgoingAsset,
              sourceCycleNumber,
              null,
              null,
            );

            transaction.set(getWaiverRef(leagueId, outgoingAssetKey), {
              assetKey: outgoingAssetKey,
              asset: outgoingDraftable,
              droppedAsset: outgoingAsset,
              droppedByOwnerId: ownerId,
              status: 'active',
              claims: [],
              awardedToOwnerId: null,
              effectiveCycleNumber: sourceCycleNumber,
              effectiveLabel: `Playoff Window ${windowNumber}`,
              queuedMoveId: pendingMove.id,
              rosterSlotId: slot.slotId,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              processedAt: null,
            });
          }
        }

        transaction.set(doc(getTransactionsRef(leagueId)), {
          type: sourceBenchSlotId ? 'active-bench-swap-activated' : 'slot-move-activated',
          ownerId,
          addedAsset: rosterAssetToDraftableAsset(incomingAsset, sourceCycleNumber, null, null),
          droppedAsset: outgoingAsset,
          waiverId: !sourceBenchSlotId && outgoingAsset ? getRosterAssetKey(outgoingAsset) : null,
          benchSlotId: sourceBenchSlotId,
          rosterSlotId: slot.slotId,
          targetSlotId: slot.slotId,
          queuedMoveId: pendingMove.id,
          effectiveCycleNumber: sourceCycleNumber,
          effectiveLabel: `Playoff Window ${windowNumber}`,
          createdAt: serverTimestamp(),
        });
      }
    }

    const expectedRosterSlotIds = picks.map(
      (pick) => pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`,
    );
    const next: FantasyPlayoffWindowBank = {
      id: `window-${windowNumber}`,
      ownerId,
      windowNumber,
      sourceCycleNumber,
      sourceNhlBlockNumber,
      sourceNhlTargetGameIdsByTeam,
      status: 'scheduled',
      assignmentStatus: 'unassigned',
      assignedMatchupId: null,
      assignedRoundNumber: null,
      expectedRosterSlotIds,
      playerWindowContinuitySchemaVersion:
        PLAYER_WINDOW_CONTINUITY_SCHEMA_VERSION,
      picks,
      slotWindows: [],
      teamScore: 0,
      completedWindowCount: 0,
      totalWindowCount: expectedRosterSlotIds.length,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      completedAt: null,
      assignedAt: null,
    };

    transaction.set(bankRef, next);
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
  });
}
