import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  writeBatch
} from 'firebase/firestore';

import { db } from '../firebase';
import {
  DraftPick,
  DraftProjection,
  DraftableAsset
} from '../draft/draft.models';
import {
  createFrozenCycleProjection,
  getRawCycleProjection
} from '../projection/cycle-projection.util';
import {
  FantasyRoster,
  RosterAsset
} from '../team/roster.models';
import { normalizeFantasyRoster } from '../team/roster.service';
import {
  calculateCycleScoring,
  CycleScoringResult
} from '../cycle/cycle-scoring.service';
import { ScoringRules } from '../scoring/scoring-rules';
import { FantasyAssetCycleWindow } from '../cycle/cycle.models';
import {
  FantasyPlayoffWindowBank
} from './playoff-window-bank.models';
import { FantasyPlayoffs } from './playoff.models';

function getOwnerBankRef(leagueId: string, ownerId: string) {
  return doc(
    db,
    'leagues',
    leagueId,
    'playoffWindowBanks',
    ownerId
  );
}

function getOwnerWindowsRef(leagueId: string, ownerId: string) {
  return collection(getOwnerBankRef(leagueId, ownerId), 'windows');
}

export function getPlayoffWindowBankRef(
  leagueId: string,
  ownerId: string,
  windowNumber: number
) {
  return doc(
    getOwnerWindowsRef(leagueId, ownerId),
    `window-${windowNumber}`
  );
}

function getTeamRosterRef(leagueId: string, ownerId: string) {
  return doc(
    db,
    'leagues',
    leagueId,
    'teams',
    ownerId,
    'roster',
    'current'
  );
}

function getDraftPicksRef(leagueId: string) {
  return collection(
    db,
    'leagues',
    leagueId,
    'draft',
    'current',
    'picks'
  );
}

function getWaiverRef(leagueId: string, waiverId: string) {
  return doc(db, 'leagues', leagueId, 'waivers', waiverId);
}

function getTransactionsRef(leagueId: string) {
  return collection(db, 'leagues', leagueId, 'transactions');
}

function getProjectionSnapshotPointerRef(leagueId: string) {
  return doc(
    db,
    'leagues',
    leagueId,
    'projectionSnapshots',
    'current'
  );
}

function getProjectionSnapshotAssetsRef(
  leagueId: string,
  snapshotId: string
) {
  return collection(
    db,
    'leagues',
    leagueId,
    'projectionSnapshots',
    snapshotId,
    'assets'
  );
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function normalizeSlotWindows(value: unknown): FantasyAssetCycleWindow[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is FantasyAssetCycleWindow =>
        Boolean(entry) && typeof entry === 'object'
      )
    : [];
}

export function normalizePlayoffWindowBank(
  value: Partial<FantasyPlayoffWindowBank>,
  ownerId: string,
  windowNumber: number,
  regularSeasonCycleCount: number
): FantasyPlayoffWindowBank {
  return {
    id: value.id ?? `window-${windowNumber}`,
    ownerId: value.ownerId ?? ownerId,
    windowNumber: value.windowNumber ?? windowNumber,
    sourceCycleNumber:
      value.sourceCycleNumber ?? regularSeasonCycleCount + windowNumber,
    status:
      value.status === 'complete'
        ? 'complete'
        : value.status === 'active'
          ? 'active'
          : 'scheduled',
    assignmentStatus:
      value.assignmentStatus === 'assigned'
        ? 'assigned'
        : value.assignmentStatus === 'unused'
          ? 'unused'
          : 'unassigned',
    assignedMatchupId:
      typeof value.assignedMatchupId === 'string'
        ? value.assignedMatchupId
        : null,
    assignedRoundNumber:
      typeof value.assignedRoundNumber === 'number'
        ? value.assignedRoundNumber
        : null,
    expectedRosterSlotIds: normalizeStringArray(
      value.expectedRosterSlotIds
    ),
    picks: Array.isArray(value.picks)
      ? value.picks as DraftPick[]
      : [],
    slotWindows: normalizeSlotWindows(value.slotWindows),
    teamScore:
      typeof value.teamScore === 'number' ? value.teamScore : 0,
    completedWindowCount:
      typeof value.completedWindowCount === 'number'
        ? value.completedWindowCount
        : 0,
    totalWindowCount:
      typeof value.totalWindowCount === 'number'
        ? value.totalWindowCount
        : 0,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt ?? null,
    assignedAt: value.assignedAt ?? null
  };
}

export async function getAllPlayoffWindowBanks(
  leagueId: string,
  playoffs: FantasyPlayoffs
): Promise<FantasyPlayoffWindowBank[]> {
  const results = await Promise.all(
    playoffs.seeds.map(async (seed) => {
      const snapshot = await getDocs(
        getOwnerWindowsRef(leagueId, seed.ownerId)
      );

      return snapshot.docs.map((windowDocument) => {
        const match = /^window-(\d+)$/.exec(windowDocument.id);
        const windowNumber = match ? Number(match[1]) : 1;

        return normalizePlayoffWindowBank(
          windowDocument.data() as Partial<FantasyPlayoffWindowBank>,
          seed.ownerId,
          windowNumber,
          playoffs.regularSeasonCycleCount
        );
      });
    })
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
  ownerId: string
): FantasyPlayoffWindowBank | null {
  return banks
    .filter((bank) =>
      bank.ownerId === ownerId &&
      bank.assignmentStatus === 'unassigned'
    )
    .sort((first, second) => first.windowNumber - second.windowNumber)[0] ?? null;
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

function projectionFields(
  asset: DraftableAsset | RosterAsset
): DraftProjection {
  const projection = asset as DraftProjection;

  return {
    projectedSeasonPoints:
      projection.projectedSeasonPoints ?? null,
    projectedCyclePoints:
      projection.projectedCyclePoints ?? null,
    frozenCycleProjectionPoints:
      projection.frozenCycleProjectionPoints ?? null,
    frozenProjectionCycleNumber:
      projection.frozenProjectionCycleNumber ?? null,
    frozenProjectionSource:
      projection.frozenProjectionSource ?? null,
    seasonBaselineCyclePoints:
      projection.seasonBaselineCyclePoints ?? null,
    recentFormAdjustment:
      projection.recentFormAdjustment ?? null,
    roleAdjustment: projection.roleAdjustment ?? null,
    projectionDataSeason:
      projection.projectionDataSeason ?? null,
    projectionDataSource:
      projection.projectionDataSource ?? null,
    projectionGamesPlayed:
      projection.projectionGamesPlayed ?? null,
    recentFormSampleSize:
      projection.recentFormSampleSize ?? null,
    seasonFantasyPointsPerGame:
      projection.seasonFantasyPointsPerGame ?? null,
    recentThreeGameFantasyPointsPerGame:
      projection.recentThreeGameFantasyPointsPerGame ?? null,
    recentFiveGameFantasyPointsPerGame:
      projection.recentFiveGameFantasyPointsPerGame ?? null,
    recentTenGameFantasyPointsPerGame:
      projection.recentTenGameFantasyPointsPerGame ?? null,
    recentTwentyGameFantasyPointsPerGame:
      projection.recentTwentyGameFantasyPointsPerGame ?? null,
    draftProjectedSeasonPoints:
      projection.draftProjectedSeasonPoints ?? null,
    draftProjectedCyclePoints:
      projection.draftProjectedCyclePoints ?? null,
    draftRecentTrendAdjustment:
      projection.draftRecentTrendAdjustment ?? null,
    draftRoleAdjustment:
      projection.draftRoleAdjustment ?? null,
    draftReliabilityRating:
      projection.draftReliabilityRating ?? null,
    draftVolatilityPenalty:
      projection.draftVolatilityPenalty ?? null,
    draftFloorAdjustedCyclePoints:
      projection.draftFloorAdjustedCyclePoints ?? null,
    draftValueAboveReplacement:
      projection.draftValueAboveReplacement ?? null,
    draftScore: projection.draftScore ?? null,
    draftRank: projection.draftRank ?? null,
    draftPositionRank:
      projection.draftPositionRank ?? null,
    cycleValueAboveReplacement:
      projection.cycleValueAboveReplacement ?? null,
    cycleScore: projection.cycleScore ?? null,
    cycleRank: projection.cycleRank ?? null,
    cyclePositionRank:
      projection.cyclePositionRank ?? null,
    seasonAverageTimeOnIceMinutes:
      projection.seasonAverageTimeOnIceMinutes ?? null,
    recentAverageTimeOnIceMinutes:
      projection.recentAverageTimeOnIceMinutes ?? null,
    actualRecentAppearances:
      projection.actualRecentAppearances ?? null,
    missedRecentTeamGames:
      projection.missedRecentTeamGames ?? null,
    weightedRecentAppearances:
      projection.weightedRecentAppearances ?? null,
    fullWeightRecentGames:
      projection.fullWeightRecentGames ?? null,
    partialWeightRecentGames:
      projection.partialWeightRecentGames ?? null,
    healthyProjectedCyclePoints:
      projection.healthyProjectedCyclePoints ?? null,
    scheduledGamesInProjectionCycle:
      projection.scheduledGamesInProjectionCycle ?? null,
    expectedGamesAvailable:
      projection.expectedGamesAvailable ?? null,
    availabilityAdjustment:
      projection.availabilityAdjustment ?? null,
    availabilityAdjustedCyclePoints:
      projection.availabilityAdjustedCyclePoints ?? null,
    availabilityStatus:
      projection.availabilityStatus ?? null,
    availabilityLabel:
      projection.availabilityLabel ?? null,
    availabilityReturnDate:
      projection.availabilityReturnDate ?? null,
    availabilityNote:
      projection.availabilityNote ?? null,
    availabilityAsOf:
      projection.availabilityAsOf ?? null,
    targetProjectionCycleNumber:
      projection.targetProjectionCycleNumber ?? null,
    sharedProjectionSnapshotId:
      projection.sharedProjectionSnapshotId ?? null,
    projectionGeneratedAt:
      projection.projectionGeneratedAt ?? null,
    balancedDraftValue:
      projection.balancedDraftValue ?? null,
    balancedRank: projection.balancedRank ?? null,
    positionRank: projection.positionRank ?? null,
    reliabilityRating:
      projection.reliabilityRating ?? null,
    volatilityPenalty:
      projection.volatilityPenalty ?? null,
    floorAdjustedCyclePoints:
      projection.floorAdjustedCyclePoints ?? null,
    floorAdjustedDraftValue:
      projection.floorAdjustedDraftValue ?? null
  };
}

function rosterAssetToDraftableAsset(
  asset: RosterAsset,
  sourceCycleNumber: number,
  sharedProjection: DraftableAsset | null,
  draftFallback: DraftableAsset | null
): DraftableAsset {
  let projectionSource: DraftableAsset | RosterAsset = asset;
  let frozenProjectionSource: DraftProjection['frozenProjectionSource'] =
    'roster';

  const sharedTarget = sharedProjection?.targetProjectionCycleNumber;
  const sharedUsable = Boolean(
    sharedProjection &&
    getRawCycleProjection(sharedProjection) !== null &&
    (sharedTarget === null ||
      sharedTarget === undefined ||
      sharedTarget === sourceCycleNumber)
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
  const base: DraftableAsset = asset.assetType === 'skater'
    ? {
        assetType: 'skater',
        assetKey,
        position: asset.position,
        player: asset.player,
        ...fields
      }
    : {
        assetType: 'team-goalie-unit',
        assetKey,
        position: 'G',
        teamName: asset.teamName,
        teamAbbreviation: asset.teamAbbreviation,
        teamLogoUrl: asset.teamLogoUrl,
        ...fields
      };

  return {
    ...base,
    frozenCycleProjectionPoints: createFrozenCycleProjection(base),
    frozenProjectionCycleNumber: sourceCycleNumber,
    frozenProjectionSource
  };
}

async function loadActiveProjectionAssetsByKey(
  leagueId: string
): Promise<Map<string, DraftableAsset>> {
  const pointerSnapshot = await getDoc(
    getProjectionSnapshotPointerRef(leagueId)
  );

  if (!pointerSnapshot.exists()) {
    return new Map();
  }

  const pointer = pointerSnapshot.data() as {
    activeSnapshotId?: unknown;
    status?: unknown;
  };

  if (
    pointer.status !== 'ready' ||
    typeof pointer.activeSnapshotId !== 'string'
  ) {
    return new Map();
  }

  const snapshot = await getDocs(
    getProjectionSnapshotAssetsRef(
      leagueId,
      pointer.activeSnapshotId
    )
  );
  const assets = snapshot.docs.flatMap((assetDocument) => {
    const data = assetDocument.data() as {
      assets?: unknown;
      assetKey?: unknown;
    };

    if (Array.isArray(data.assets)) {
      return data.assets as DraftableAsset[];
    }

    return typeof data.assetKey === 'string'
      ? [data as DraftableAsset]
      : [];
  });

  return new Map(assets.map((asset) => [asset.assetKey, asset] as const));
}

function buildSlotWindows(
  bank: FantasyPlayoffWindowBank,
  scoring: CycleScoringResult
): FantasyAssetCycleWindow[] {
  return bank.picks.map((pick) => {
    const rosterSlotId = pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`;
    const windowId = pick.cycleWindowId ??
      `${pick.ownerId}__${rosterSlotId}__cycle-${bank.sourceCycleNumber}`;
    const summary = scoring.windowScores[windowId] ??
      scoring.assetScores[pick.asset.assetKey];

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
      completedGameIds: summary?.completedGameIds ?? [],
      appearanceGameIds: summary?.appearanceGameIds ?? [],
      scheduledGames: summary?.scheduledGames ?? 0,
      gamesPlayed: summary?.gamesPlayed ?? 0,
      actualGamesPlayed: summary?.actualGamesPlayed ?? 0,
      gamesLeft: summary?.gamesLeft ?? 0,
      fantasyPoints: summary?.currentScore ?? 0,
      frozenProjectionPoints:
        pick.asset.frozenCycleProjectionPoints ??
        pick.asset.projectedCyclePoints ??
        null,
      frozenProjectionVersion: null,
      firstScheduledGameDate: summary?.firstScheduledGameDate ?? null,
      lastScheduledGameDate: summary?.lastScheduledGameDate ?? null,
      startedAt: summary?.status === 'scheduled' ? null : new Date().toISOString(),
      completedAt: summary?.status === 'complete'
        ? new Date().toISOString()
        : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
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
      appearanceGameIds: window.appearanceGameIds,
      fantasyPoints: window.fantasyPoints
    }))
  });
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
  const banks = await getAllPlayoffWindowBanks(
    input.leagueId,
    input.playoffs
  );
  const scoringByOwnerWindow = new Map<string, CycleScoringResult>();

  if (input.assignedPicks?.length && input.assignedScoring) {
    const ownerWindowPairs = new Set(
      input.assignedPicks.map((pick) =>
        `${pick.ownerId}::${pick.playoffWindowNumber ?? 1}`
      )
    );

    for (const pair of ownerWindowPairs) {
      scoringByOwnerWindow.set(pair, input.assignedScoring);
    }
  }

  const unassignedBanks = banks.filter((bank) =>
    bank.assignmentStatus === 'unassigned' &&
    bank.picks.length > 0
  );

  if (unassignedBanks.length > 0) {
    const unassignedPicks = unassignedBanks.flatMap((bank) => bank.picks);
    const expectedRosterSlotIdsByOwner = Object.fromEntries(
      unassignedBanks.map((bank) => [
        bank.ownerId,
        bank.expectedRosterSlotIds
      ])
    );
    const scoring = await calculateCycleScoring({
      picks: unassignedPicks,
      cycleNumber: input.playoffs.regularSeasonCycleCount + 1,
      season: input.season,
      requiredGamesPerCycle: input.requiredGamesPerCycle,
      scoringRules: input.scoringRules,
      expectedRosterSlotIdsByOwner
    });

    for (const bank of unassignedBanks) {
      scoringByOwnerWindow.set(
        `${bank.ownerId}::${bank.windowNumber}`,
        scoring
      );
    }
  }

  const batch = writeBatch(db);
  const updatedBanks: FantasyPlayoffWindowBank[] = [];
  let writeCount = 0;

  for (const bank of banks) {
    const scoring = scoringByOwnerWindow.get(
      `${bank.ownerId}::${bank.windowNumber}`
    );

    if (!scoring) {
      updatedBanks.push(bank);
      continue;
    }

    const slotWindows = buildSlotWindows(bank, scoring);
    const completedWindowCount = slotWindows.filter(
      (window) => window.status === 'complete'
    ).length;
    const totalWindowCount = bank.expectedRosterSlotIds.length;
    const complete =
      totalWindowCount > 0 &&
      completedWindowCount >= totalWindowCount;
    const active = slotWindows.some(
      (window) => window.status !== 'scheduled'
    );
    const next: FantasyPlayoffWindowBank = {
      ...bank,
      slotWindows,
      teamScore: Number(
        slotWindows.reduce(
          (total, window) => total + window.fantasyPoints,
          0
        ).toFixed(1)
      ),
      completedWindowCount,
      totalWindowCount,
      status: complete
        ? 'complete'
        : active
          ? 'active'
          : 'scheduled',
      updatedAt: serverTimestamp(),
      completedAt: complete
        ? bank.completedAt ?? serverTimestamp()
        : null
    };

    updatedBanks.push(next);

    if (bankFingerprint(bank) === bankFingerprint(next)) {
      continue;
    }

    writeCount += 1;
    batch.set(
      getPlayoffWindowBankRef(
        input.leagueId,
        bank.ownerId,
        bank.windowNumber
      ),
      next,
      { merge: true }
    );
  }

  if (writeCount > 0) {
    await batch.commit();
  }

  return updatedBanks;
}

export function createInitialPlayoffBankPayloads(
  playoffs: FantasyPlayoffs,
  picks: DraftPick[]
): FantasyPlayoffWindowBank[] {
  return playoffs.seeds.map((seed) => {
    const ownerPicks = picks
      .filter((pick) => pick.ownerId === seed.ownerId)
      .map((pick) => ({
        ...pick,
        snapshotCycleNumber: playoffs.regularSeasonCycleCount + 1,
        playoffWindowNumber: 1,
        cycleWindowId:
          `${seed.ownerId}__${pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`}__cycle-${playoffs.regularSeasonCycleCount + 1}`
      }));
    const expectedRosterSlotIds = ownerPicks.map(
      (pick) => pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`
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
      assignedAt: null
    };
  });
}

export async function ensureNextPlayoffBankWindows(input: {
  leagueId: string;
  playoffs: FantasyPlayoffs;
  banks: FantasyPlayoffWindowBank[];
}): Promise<void> {
  const completeBanks = input.banks.filter((bank) => {
    if (
      bank.status !== 'complete' ||
      bank.windowNumber >= input.playoffs.playoffRoundCount
    ) {
      return false;
    }

    if (bank.assignmentStatus === 'unassigned') {
      return true;
    }

    if (!bank.assignedMatchupId) {
      return true;
    }

    return input.playoffs.matchups.some((matchup) =>
      (
        (
          matchup.sourceA.type === 'winner' ||
          matchup.sourceA.type === 'loser'
        ) && matchup.sourceA.matchupId === bank.assignedMatchupId
      ) ||
      (
        (
          matchup.sourceB.type === 'winner' ||
          matchup.sourceB.type === 'loser'
        ) && matchup.sourceB.matchupId === bank.assignedMatchupId
      )
    );
  });

  for (const bank of completeBanks) {
    const nextWindowNumber = bank.windowNumber + 1;
    const existing = input.banks.some((candidate) =>
      candidate.ownerId === bank.ownerId &&
      candidate.windowNumber === nextWindowNumber
    );

    if (existing) {
      continue;
    }

    await createNextPlayoffBankWindow(
      input.leagueId,
      input.playoffs,
      bank.ownerId,
      nextWindowNumber
    );
  }
}

async function createNextPlayoffBankWindow(
  leagueId: string,
  playoffs: FantasyPlayoffs,
  ownerId: string,
  windowNumber: number
): Promise<void> {
  const sourceCycleNumber =
    playoffs.regularSeasonCycleCount + windowNumber;
  const [draftSnapshot, projectionAssetsByKey] = await Promise.all([
    getDocs(getDraftPicksRef(leagueId)),
    loadActiveProjectionAssetsByKey(leagueId)
  ]);
  const draftPicks = draftSnapshot.docs.map(
    (document) => document.data() as DraftPick
  );
  const draftByAssetKey = new Map(
    draftPicks
      .filter((pick) => pick.ownerId === ownerId)
      .map((pick) => [pick.asset.assetKey, pick] as const)
  );
  const rosterRef = getTeamRosterRef(leagueId, ownerId);
  const bankRef = getPlayoffWindowBankRef(
    leagueId,
    ownerId,
    windowNumber
  );

  await runTransaction(db, async (transaction) => {
    const [rosterSnapshot, bankSnapshot] = await Promise.all([
      transaction.get(rosterRef),
      transaction.get(bankRef)
    ]);

    if (bankSnapshot.exists()) {
      return;
    }

    if (!rosterSnapshot.exists()) {
      throw new Error(
        `Roster ${ownerId} is missing while opening playoff window ${windowNumber}.`
      );
    }

    const roster = normalizeFantasyRoster(
      rosterSnapshot.data() as Partial<FantasyRoster>
    );
    const picks: DraftPick[] = [];

    for (const [slotIndex, slot] of roster.activeSlots.entries()) {
      const outgoingAsset = slot.asset;
      const incomingAsset = slot.pendingMove?.incomingAsset ?? outgoingAsset;

      if (!incomingAsset) {
        continue;
      }

      const incomingAssetKey = getRosterAssetKey(incomingAsset);
      const draftFallback = draftByAssetKey.get(incomingAssetKey)?.asset ?? null;
      const pick: DraftPick = {
        overallPick:
          draftByAssetKey.get(incomingAssetKey)?.overallPick ??
          100000 + slotIndex + 1,
        round: draftByAssetKey.get(incomingAssetKey)?.round ?? 0,
        pickInRound:
          draftByAssetKey.get(incomingAssetKey)?.pickInRound ?? slot.slotNumber,
        ownerId,
        rosterSlotId: slot.slotId,
        cycleWindowId:
          `${ownerId}__${slot.slotId}__cycle-${sourceCycleNumber}`,
        snapshotCycleNumber: sourceCycleNumber,
        playoffWindowNumber: windowNumber,
        snapshotOrder:
          draftByAssetKey.get(incomingAssetKey)?.overallPick ??
          100000 + slotIndex + 1,
        asset: rosterAssetToDraftableAsset(
          incomingAsset,
          sourceCycleNumber,
          projectionAssetsByKey.get(incomingAssetKey) ?? null,
          draftFallback
        )
      };

      picks.push(pick);

      if (slot.pendingMove) {
        const pendingMove = slot.pendingMove;
        slot.asset = pendingMove.incomingAsset;
        slot.pendingMove = null;

        if (outgoingAsset) {
          const outgoingAssetKey = getRosterAssetKey(outgoingAsset);

          if (outgoingAssetKey && outgoingAssetKey !== incomingAssetKey) {
            const outgoingDraftable = rosterAssetToDraftableAsset(
              outgoingAsset,
              sourceCycleNumber,
              null,
              null
            );

            transaction.set(
              getWaiverRef(leagueId, outgoingAssetKey),
              {
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
                processedAt: null
              }
            );
          }
        }

        transaction.set(doc(getTransactionsRef(leagueId)), {
          type: 'slot-move-activated',
          ownerId,
          addedAsset: rosterAssetToDraftableAsset(
            incomingAsset,
            sourceCycleNumber,
            null,
            null
          ),
          droppedAsset: outgoingAsset,
          waiverId: outgoingAsset
            ? getRosterAssetKey(outgoingAsset)
            : null,
          rosterSlotId: slot.slotId,
          targetSlotId: slot.slotId,
          queuedMoveId: pendingMove.id,
          effectiveCycleNumber: sourceCycleNumber,
          effectiveLabel: `Playoff Window ${windowNumber}`,
          createdAt: serverTimestamp()
        });
      }
    }

    const expectedRosterSlotIds = picks.map(
      (pick) => pick.rosterSlotId ?? `legacy-pick-${pick.overallPick}`
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
      assignedAt: null
    };

    transaction.set(bankRef, next);
    transaction.set(
      rosterRef,
      {
        schemaVersion: roster.schemaVersion,
        activeSlots: roster.activeSlots,
        irSlots: roster.irSlots,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );
  });
}
