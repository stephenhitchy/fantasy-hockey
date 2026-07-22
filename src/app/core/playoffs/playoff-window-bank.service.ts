import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';

import { db } from '../firebase';
import { DraftPick, DraftProjection, DraftableAsset } from '../draft/draft.models';
import { getRawCycleProjection } from '../projection/cycle-projection.util';
import {
  createFrozenWindowProjectionFields,
  ensureWindowProjectionBundle,
  FrozenWindowProjectionFields,
} from '../projection/window-projection.service';
import { FantasyRoster, PendingRosterSlotMove, RosterAsset } from '../team/roster.models';
import { normalizeFantasyRoster } from '../team/roster.service';
import { calculateCycleScoring, CycleScoringResult } from '../cycle/cycle-scoring.service';
import { defaultScoringRules, ScoringRules } from '../scoring/scoring-rules';
import { FantasyAssetCycleWindow } from '../cycle/cycle.models';
import { FantasyPlayoffWindowBank } from './playoff-window-bank.models';
import { FantasyPlayoffs } from './playoff.models';

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
  return {
    id: value.id ?? '',
    ownerId: value.ownerId ?? '',
    rosterSlotId: value.rosterSlotId ?? '',
    cycleNumber: typeof value.cycleNumber === 'number' ? value.cycleNumber : 0,
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
  return {
    id: value.id ?? `window-${windowNumber}`,
    ownerId: value.ownerId ?? ownerId,
    windowNumber: value.windowNumber ?? windowNumber,
    sourceCycleNumber: value.sourceCycleNumber ?? regularSeasonCycleCount + windowNumber,
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
    picks: Array.isArray(value.picks) ? (value.picks as DraftPick[]) : [],
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
): Promise<Map<string, DraftableAsset>> {
  const bundle = await ensureWindowProjectionBundle({
    leagueId,
    teamCount: Math.max(2, playoffs.seeds.length),
    requiredGamesPerCycle: defaultScoringRules.requiredGamesPerCycle,
    targetCycleNumber: sourceCycleNumber,
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
  const previousById = new Map(bank.slotWindows.map((window) => [window.id, window] as const));

  return bank.picks.map((pick) => {
    const rosterSlotId = pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`;
    const windowId =
      pick.cycleWindowId ?? `${pick.ownerId}__${rosterSlotId}__cycle-${bank.sourceCycleNumber}`;
    const summary = scoring.windowScores[windowId] ?? scoring.assetScores[pick.asset.assetKey];
    const previous = previousById.get(windowId);
    const nowIso = new Date().toISOString();

    return {
      id: windowId,
      ownerId: pick.ownerId,
      rosterSlotId,
      cycleNumber: bank.sourceCycleNumber,
      position: pick.asset.position,
      assetKey: pick.asset.assetKey,
      asset: pick.asset,
      status: summary?.status ?? 'scheduled',
      scheduledGameIds: summary?.scheduledGameIds ?? [],
      scheduledGameDates: summary?.scheduledGameDates ?? [],
      scheduledGameLabels: summary?.scheduledGameLabels ?? [],
      completedGameIds: summary?.completedGameIds ?? previous?.completedGameIds ?? [],
      liveGameIds: summary?.liveGameIds ?? previous?.liveGameIds ?? [],
      appearanceGameIds: summary?.appearanceGameIds ?? previous?.appearanceGameIds ?? [],
      gameScores: summary?.gameScores ?? previous?.gameScores ?? {},
      gameStates: summary?.gameStates ?? previous?.gameStates ?? {},
      scheduledGames: summary?.scheduledGames ?? 0,
      gamesPlayed: summary?.gamesPlayed ?? 0,
      actualGamesPlayed: summary?.actualGamesPlayed ?? 0,
      gamesLeft: summary?.gamesLeft ?? 0,
      fantasyPoints: summary?.currentScore ?? 0,
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
      firstScheduledGameDate: summary?.firstScheduledGameDate ?? null,
      lastScheduledGameDate: summary?.lastScheduledGameDate ?? null,
      startedAt:
        summary?.status === 'scheduled'
          ? (previous?.startedAt ?? null)
          : (previous?.startedAt ?? nowIso),
      completedAt: summary?.status === 'complete' ? (previous?.completedAt ?? nowIso) : null,
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
      fantasyPoints: window.fantasyPoints,
      frozenProjectionPoints: window.frozenProjectionPoints,
      frozenProjectionVersion: window.frozenProjectionVersion,
      frozenProjectionSnapshotId: window.frozenProjectionSnapshotId,
      frozenProjectionFrozenAt: window.frozenProjectionFrozenAt,
      frozenProjectionTargetGameIds: window.frozenProjectionTargetGameIds,
    })),
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

  for (const window of slotWindows) {
    const summary = {
      assetKey: window.assetKey,
      ownerId: window.ownerId,
      rosterSlotId: window.rosterSlotId,
      windowId: window.id,
      currentScore: window.fantasyPoints,
      gamesPlayed: window.gamesPlayed,
      actualGamesPlayed: window.actualGamesPlayed,
      scheduledGames: window.scheduledGames,
      gamesLeft: window.gamesLeft,
      scheduledGameIds: window.scheduledGameIds,
      scheduledGameDates: window.scheduledGameDates,
      scheduledGameLabels: window.scheduledGameLabels,
      completedGameIds: window.completedGameIds,
      liveGameIds: window.liveGameIds,
      appearanceGameIds: window.appearanceGameIds,
      gameScores: window.gameScores,
      gameStates: window.gameStates,
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
}): Promise<FantasyPlayoffWindowBank[]> {
  const banks = await getAllPlayoffWindowBanks(input.leagueId, input.playoffs);
  const scoringByOwnerWindow = new Map<string, CycleScoringResult>();

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
    const unassignedPicks = unassignedBanks.flatMap((bank) => bank.picks);
    const expectedRosterSlotIdsByOwner = Object.fromEntries(
      unassignedBanks.map((bank) => [bank.ownerId, bank.expectedRosterSlotIds]),
    );
    const previousResult = buildPreviousScoringResultFromBanks(unassignedBanks);
    const scoring = await calculateCycleScoring({
      picks: unassignedPicks,
      cycleNumber: input.playoffs.regularSeasonCycleCount + 1,
      season: input.season,
      requiredGamesPerCycle: input.requiredGamesPerCycle,
      scoringRules: input.scoringRules,
      expectedRosterSlotIdsByOwner,
      previousResult,
    });

    for (const bank of unassignedBanks) {
      scoringByOwnerWindow.set(`${bank.ownerId}::${bank.windowNumber}`, scoring);
    }
  }

  const batch = writeBatch(db);
  const updatedBanks: FantasyPlayoffWindowBank[] = [];
  let writeCount = 0;

  for (const bank of banks) {
    const scoring = scoringByOwnerWindow.get(`${bank.ownerId}::${bank.windowNumber}`);

    if (!scoring) {
      updatedBanks.push(bank);
      continue;
    }

    const slotWindows = buildSlotWindows(bank, scoring);
    const completedWindowCount = slotWindows.filter(
      (window) => window.status === 'complete',
    ).length;
    const totalWindowCount = bank.expectedRosterSlotIds.length;
    const complete = totalWindowCount > 0 && completedWindowCount >= totalWindowCount;
    const active = slotWindows.some((window) => window.status !== 'scheduled');
    const next: FantasyPlayoffWindowBank = {
      ...bank,
      slotWindows,
      teamScore: Number(
        slotWindows.reduce((total, window) => total + window.fantasyPoints, 0).toFixed(1),
      ),
      completedWindowCount,
      totalWindowCount,
      status: complete ? 'complete' : active ? 'active' : 'scheduled',
      updatedAt: serverTimestamp(),
      completedAt: complete ? (bank.completedAt ?? serverTimestamp()) : null,
    };

    updatedBanks.push(next);

    if (bankFingerprint(bank) === bankFingerprint(next)) {
      continue;
    }

    writeCount += 1;
    batch.set(getPlayoffWindowBankRef(input.leagueId, bank.ownerId, bank.windowNumber), next, {
      merge: true,
    });
  }

  if (writeCount > 0) {
    await batch.commit();
  }

  return updatedBanks;
}

export function createInitialPlayoffBankPayloads(
  playoffs: FantasyPlayoffs,
  picks: DraftPick[],
): FantasyPlayoffWindowBank[] {
  return playoffs.seeds.map((seed) => {
    const ownerPicks = picks
      .filter((pick) => pick.ownerId === seed.ownerId)
      .map((pick) => ({
        ...pick,
        snapshotCycleNumber: playoffs.regularSeasonCycleCount + 1,
        playoffWindowNumber: 1,
        cycleWindowId: `${seed.ownerId}__${pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`}__cycle-${playoffs.regularSeasonCycleCount + 1}`,
      }));
    const expectedRosterSlotIds = ownerPicks.map(
      (pick) => pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`,
    );

    return {
      id: 'window-1',
      ownerId: seed.ownerId,
      windowNumber: 1,
      sourceCycleNumber: playoffs.regularSeasonCycleCount + 1,
      status: 'scheduled',
      assignmentStatus: 'unassigned',
      assignedMatchupId: null,
      assignedRoundNumber: null,
      expectedRosterSlotIds,
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
): Promise<void> {
  const sourceCycleNumber = playoffs.regularSeasonCycleCount + windowNumber;
  const [draftSnapshot, projectionAssetsByKey] = await Promise.all([
    getDocs(getDraftPicksRef(leagueId)),
    loadWindowProjectionAssetsByKey(leagueId, playoffs, sourceCycleNumber),
  ]);
  const draftPicks = draftSnapshot.docs.map((document) => document.data() as DraftPick);
  const draftByAssetKey = new Map(
    draftPicks
      .filter((pick) => pick.ownerId === ownerId)
      .map((pick) => [pick.asset.assetKey, pick] as const),
  );
  const rosterRef = getTeamRosterRef(leagueId, ownerId);
  const bankRef = getPlayoffWindowBankRef(leagueId, ownerId, windowNumber);

  await runTransaction(db, async (transaction) => {
    const [rosterSnapshot, bankSnapshot] = await Promise.all([
      transaction.get(rosterRef),
      transaction.get(bankRef),
    ]);

    if (bankSnapshot.exists()) {
      return;
    }

    if (!rosterSnapshot.exists()) {
      throw new Error(`Roster ${ownerId} is missing while opening playoff window ${windowNumber}.`);
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
      const pick: DraftPick = {
        overallPick: draftByAssetKey.get(incomingAssetKey)?.overallPick ?? 100000 + slotIndex + 1,
        round: draftByAssetKey.get(incomingAssetKey)?.round ?? 0,
        pickInRound: draftByAssetKey.get(incomingAssetKey)?.pickInRound ?? slot.slotNumber,
        ownerId,
        rosterSlotId: slot.slotId,
        cycleWindowId: `${ownerId}__${slot.slotId}__cycle-${sourceCycleNumber}`,
        snapshotCycleNumber: sourceCycleNumber,
        playoffWindowNumber: windowNumber,
        snapshotOrder: draftByAssetKey.get(incomingAssetKey)?.overallPick ?? 100000 + slotIndex + 1,
        asset: rosterAssetToDraftableAsset(
          incomingAsset,
          sourceCycleNumber,
          projectionAssetsByKey.get(incomingAssetKey) ?? null,
          draftFallback,
        ),
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
      status: 'scheduled',
      assignmentStatus: 'unassigned',
      assignedMatchupId: null,
      assignedRoundNumber: null,
      expectedRosterSlotIds,
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
