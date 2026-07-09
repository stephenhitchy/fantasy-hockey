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
  Transaction,
  serverTimestamp,
  writeBatch
} from 'firebase/firestore';

import { db } from '../firebase';

import {
  FantasyCycle,
  FantasyMatchup
} from './cycle.models';

import {
  FantasyTeam
} from '../team/team.service';

import {
  DraftableAsset,
  DraftPick,
  FantasyDraft
} from '../draft/draft.models';

import {
  FantasyRoster,
  RosterAsset
} from '../team/roster.models';

import {
  normalizeFantasyRoster
} from '../team/roster.service';

const FIRST_CYCLE_NUMBER = 1;

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

function getCycleDocumentId(cycleNumber: number): string {
  return `cycle-${cycleNumber}`;
}

function getCycleRef(
  leagueId: string,
  cycleNumber: number
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'cycles',
    getCycleDocumentId(cycleNumber)
  );
}

function getDraftRef(leagueId: string) {
  return doc(
    db,
    'leagues',
    leagueId,
    'draft',
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

function getDraftPickDocumentId(overallPick: number): string {
  return overallPick.toString().padStart(3, '0');
}

function getTeamRef(
  leagueId: string,
  ownerId: string
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'teams',
    ownerId
  );
}


function getTeamRosterRef(
  leagueId: string,
  ownerId: string
) {
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

function getCyclesRef(leagueId: string) {
  return collection(
    db,
    'leagues',
    leagueId,
    'cycles'
  );
}

function getCycleMatchupsRef(
  leagueId: string,
  cycleNumber: number
) {
  return collection(
    db,
    'leagues',
    leagueId,
    'cycles',
    getCycleDocumentId(cycleNumber),
    'matchups'
  );
}

function getCycleMatchupRef(
  leagueId: string,
  cycleNumber: number,
  matchupId: string
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'cycles',
    getCycleDocumentId(cycleNumber),
    'matchups',
    matchupId
  );
}

function getCycleRosterPicksRef(
  leagueId: string,
  cycleNumber: number
) {
  return collection(
    db,
    'leagues',
    leagueId,
    'cycles',
    getCycleDocumentId(cycleNumber),
    'rosterPicks'
  );
}

function getCycleRosterPickRef(
  leagueId: string,
  cycleNumber: number,
  overallPick: number
) {
  return doc(
    db,
    'leagues',
    leagueId,
    'cycles',
    getCycleDocumentId(cycleNumber),
    'rosterPicks',
    getDraftPickDocumentId(overallPick)
  );
}

function normalizeCycle(
  data: Partial<FantasyCycle>,
  fallbackCycleNumber: number = FIRST_CYCLE_NUMBER
): FantasyCycle {
  return {
    id: data.id ?? getCycleDocumentId(fallbackCycleNumber),
    cycleNumber: data.cycleNumber ?? fallbackCycleNumber,
    status: data.status ?? 'active',
    matchupIds: Array.isArray(data.matchupIds)
      ? data.matchupIds
      : [],
    startedAt: data.startedAt,
    completedAt: data.completedAt ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

function normalizeMatchup(
  data: Partial<FantasyMatchup>
): FantasyMatchup {
  return {
    id: data.id ?? '',
    cycleNumber: data.cycleNumber ?? FIRST_CYCLE_NUMBER,
    teamAOwnerId: data.teamAOwnerId ?? '',
    teamBOwnerId: data.teamBOwnerId ?? null,
    teamAScore:
      typeof data.teamAScore === 'number'
        ? data.teamAScore
        : 0,
    teamBScore:
      typeof data.teamBScore === 'number'
        ? data.teamBScore
        : 0,
    winnerOwnerId: data.winnerOwnerId ?? null,
    status: data.status ?? 'active',
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
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

    const playerId =
      player.id ??
      player.playerId ??
      player.nhlPlayerId;

    return playerId
      ? `skater-${playerId}`
      : '';
  }

  return asset.teamAbbreviation
    ? `goalie-unit-${asset.teamAbbreviation}`
    : '';
}

function createDraftableAssetFromRosterAsset(
  rosterAsset: RosterAsset,
  fallbackAsset: DraftableAsset | null
): DraftableAsset {
  if (fallbackAsset) {
    return fallbackAsset;
  }

  const projectedFields = {
    projectedSeasonPoints: rosterAsset.projectedSeasonPoints ?? null,
    projectedCyclePoints: rosterAsset.projectedCyclePoints ?? null,
    reliabilityRating: rosterAsset.reliabilityRating ?? null,
    volatilityPenalty: rosterAsset.volatilityPenalty ?? null,
    floorAdjustedCyclePoints: rosterAsset.floorAdjustedCyclePoints ?? null,
    floorAdjustedDraftValue: rosterAsset.floorAdjustedDraftValue ?? null
  };

  if (rosterAsset.assetType === 'skater') {
    return {
      assetType: 'skater',
      assetKey: getRosterAssetKey(rosterAsset),
      position: rosterAsset.position,
      player: rosterAsset.player,
      ...projectedFields
    };
  }

  return {
    assetType: 'team-goalie-unit',
    assetKey: getRosterAssetKey(rosterAsset),
    position: 'G',
    teamName: rosterAsset.teamName,
    teamAbbreviation: rosterAsset.teamAbbreviation,
    teamLogoUrl: rosterAsset.teamLogoUrl,
    ...projectedFields
  };
}

async function buildCurrentRosterSnapshotPicks(
  leagueId: string,
  teams: FantasyTeam[],
  draftPicks: DraftPick[]
): Promise<DraftPick[]> {
  const draftPickByOwnerAndAssetKey = new Map<string, DraftPick>();

  for (const pick of draftPicks) {
    draftPickByOwnerAndAssetKey.set(
      `${pick.ownerId}::${pick.asset.assetKey}`,
      pick
    );
  }

  const rosterSnapshots = await Promise.all(
    teams.map(async (team) => {
      const rosterSnapshot = await getDoc(
        getTeamRosterRef(leagueId, team.ownerId)
      );

      const roster: FantasyRoster | null = rosterSnapshot.exists()
        ? normalizeFantasyRoster(
            rosterSnapshot.data() as Partial<FantasyRoster>
          )
        : null;

      return {
        ownerId: team.ownerId,
        roster
      };
    })
  );

  const snapshotPicks: DraftPick[] = [];
  let syntheticOverallPick = 100000;

  for (const rosterSnapshot of rosterSnapshots) {
    const activeSlots = rosterSnapshot.roster?.activeSlots ?? [];

    for (const slot of activeSlots) {
      if (!slot.asset) {
        continue;
      }

      const assetKey = getRosterAssetKey(slot.asset);

      if (!assetKey) {
        continue;
      }

      const matchingDraftPick = draftPickByOwnerAndAssetKey.get(
        `${rosterSnapshot.ownerId}::${assetKey}`
      ) ?? null;

      const overallPick =
        matchingDraftPick?.overallPick ??
        syntheticOverallPick;

      if (!matchingDraftPick) {
        syntheticOverallPick += 1;
      }

      snapshotPicks.push({
        overallPick,
        round: matchingDraftPick?.round ?? 0,
        pickInRound: matchingDraftPick?.pickInRound ?? slot.slotNumber,
        ownerId: rosterSnapshot.ownerId,
        asset: createDraftableAssetFromRosterAsset(
          slot.asset,
          matchingDraftPick?.asset ?? null
        )
      });
    }
  }

  return snapshotPicks.sort((first, second) => {
    if (first.ownerId !== second.ownerId) {
      return first.ownerId.localeCompare(second.ownerId);
    }

    return first.overallPick - second.overallPick;
  });
}

function writeCycleRosterPickSnapshots(
  transaction: Transaction,
  leagueId: string,
  cycleNumber: number,
  draftPicks: DraftPick[]
): void {
  for (const pick of draftPicks) {
    transaction.set(
      getCycleRosterPickRef(
        leagueId,
        cycleNumber,
        pick.overallPick
      ),
      {
        ...pick,
        snapshotCycleNumber: cycleNumber,
        snapshotSource: 'active-roster',
        snapshottedAt: serverTimestamp()
      }
    );
  }
}

function roundScore(value: number): number {
  return Number(value.toFixed(1));
}

function getOrderedOwnerIds(
  teams: FantasyTeam[],
  draft: FantasyDraft | null
): string[] {
  const teamOwnerIds = new Set(
    teams.map((team) => team.ownerId)
  );

  const draftOrderOwnerIds =
    draft && Array.isArray(draft.roundOneOrder)
      ? draft.roundOneOrder.filter(
          (ownerId) => teamOwnerIds.has(ownerId)
        )
      : [];

  if (draftOrderOwnerIds.length > 0) {
    return draftOrderOwnerIds;
  }

  return [...teams]
    .sort((first, second) =>
      first.teamName.localeCompare(second.teamName)
    )
    .map((team) => team.ownerId);
}

function getMatchupWinnerOwnerId(
  teamAOwnerId: string,
  teamBOwnerId: string | null,
  teamAScore: number,
  teamBScore: number
): string | null {
  if (!teamBOwnerId) {
    return teamAOwnerId;
  }

  if (teamAScore > teamBScore) {
    return teamAOwnerId;
  }

  if (teamBScore > teamAScore) {
    return teamBOwnerId;
  }

  return null;
}

function buildInitialRoundRobinLineup(
  orderedOwnerIds: string[]
): Array<string | null> {
  const entries: Array<string | null> =
    orderedOwnerIds.length % 2 === 0
      ? [...orderedOwnerIds]
      : [...orderedOwnerIds, null];

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

function rotateRoundRobinLineup(
  lineup: Array<string | null>
): Array<string | null> {
  if (lineup.length <= 2) {
    return lineup;
  }

  const fixedOwnerId = lineup[0];
  const rotatingOwnerIds = lineup.slice(1);
  const lastOwnerId = rotatingOwnerIds[rotatingOwnerIds.length - 1];
  const remainingOwnerIds = rotatingOwnerIds.slice(0, -1);

  return [
    fixedOwnerId,
    lastOwnerId,
    ...remainingOwnerIds
  ];
}

function createCyclePairings(
  orderedOwnerIds: string[],
  cycleNumber: number
): CyclePairing[] {
  if (orderedOwnerIds.length < 2) {
    throw new Error(
      'At least two teams are required to create matchups.'
    );
  }

  let lineup = buildInitialRoundRobinLineup(orderedOwnerIds);
  const rotationCount =
    lineup.length <= 1
      ? 0
      : (cycleNumber - 1) % (lineup.length - 1);

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
      teamBOwnerId
    });
  }

  return pairings;
}

export function getRoundRobinCycleCount(teamCount: number): number {
  if (teamCount < 2) {
    return 0;
  }

  const lineupLength = teamCount % 2 === 0
    ? teamCount
    : teamCount + 1;

  return Math.max(1, lineupLength - 1);
}

export function buildCycleSchedulePreview(
  teams: FantasyTeam[],
  draft: FantasyDraft | null,
  cycleCount?: number
): CycleSchedulePreviewCycle[] {
  if (teams.length < 2) {
    return [];
  }

  const orderedOwnerIds = getOrderedOwnerIds(teams, draft);
  const previewCycleCount = cycleCount ?? getRoundRobinCycleCount(orderedOwnerIds.length);

  return Array.from({ length: previewCycleCount }, (_, cycleIndex) => {
    const cycleNumber = cycleIndex + 1;
    const pairings = createCyclePairings(orderedOwnerIds, cycleNumber);

    return {
      cycleNumber,
      matchups: pairings.map((pairing, matchupIndex) => ({
        id: `matchup-${matchupIndex + 1}`,
        teamAOwnerId: pairing.teamAOwnerId,
        teamBOwnerId: pairing.teamBOwnerId
      }))
    };
  });
}

export function listenToCycle(
  leagueId: string,
  cycleNumber: number,
  callback: (cycle: FantasyCycle | null) => void
): () => void {
  return onSnapshot(getCycleRef(leagueId, cycleNumber), (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }

    callback(
      normalizeCycle(
        snapshot.data() as Partial<FantasyCycle>,
        cycleNumber
      )
    );
  });
}


export function listenToLeagueCycles(
  leagueId: string,
  callback: (cycles: FantasyCycle[]) => void
): () => void {
  const cyclesQuery = query(
    getCyclesRef(leagueId),
    orderBy('cycleNumber', 'asc')
  );

  return onSnapshot(cyclesQuery, (snapshot) => {
    callback(
      snapshot.docs.map((cycleDoc) => {
        const data = cycleDoc.data() as Partial<FantasyCycle>;

        return normalizeCycle(
          data,
          data.cycleNumber ?? FIRST_CYCLE_NUMBER
        );
      })
    );
  });
}

export function listenToLatestCycle(
  leagueId: string,
  callback: (cycle: FantasyCycle | null) => void
): () => void {
  const latestCycleQuery = query(
    getCyclesRef(leagueId),
    orderBy('cycleNumber', 'desc'),
    limit(1)
  );

  return onSnapshot(latestCycleQuery, (snapshot) => {
    const latestCycleDoc = snapshot.docs[0];

    if (!latestCycleDoc) {
      callback(null);
      return;
    }

    const data = latestCycleDoc.data() as Partial<FantasyCycle>;

    callback(
      normalizeCycle(
        data,
        data.cycleNumber ?? FIRST_CYCLE_NUMBER
      )
    );
  });
}

export function listenToCycleMatchups(
  leagueId: string,
  cycleNumber: number,
  callback: (matchups: FantasyMatchup[]) => void
): () => void {
  const matchupsQuery = query(
    getCycleMatchupsRef(leagueId, cycleNumber),
    orderBy('id', 'asc')
  );

  return onSnapshot(matchupsQuery, (snapshot) => {
    callback(
      snapshot.docs.map((matchupDoc) =>
        normalizeMatchup(
          matchupDoc.data() as Partial<FantasyMatchup>
        )
      )
    );
  });
}

export function listenToCycleRosterPicks(
  leagueId: string,
  cycleNumber: number,
  callback: (picks: DraftPick[]) => void
): () => void {
  const rosterPicksQuery = query(
    getCycleRosterPicksRef(leagueId, cycleNumber),
    orderBy('overallPick', 'asc')
  );

  return onSnapshot(rosterPicksQuery, (snapshot) => {
    callback(
      snapshot.docs.map(
        (pickDoc) => pickDoc.data() as DraftPick
      )
    );
  });
}

export async function startCycle(
  leagueId: string,
  teams: FantasyTeam[],
  cycleNumber: number
): Promise<FantasyCycle> {
  if (teams.length < 2) {
    throw new Error(
      'At least two teams are required to start a cycle.'
    );
  }

  const cycleRef = getCycleRef(leagueId, cycleNumber);
  const draftRef = getDraftRef(leagueId);
  const draftPicksQuery = query(
    getDraftPicksRef(leagueId),
    orderBy('overallPick', 'asc')
  );

  const draftPicksSnapshot = await getDocs(draftPicksQuery);
  const draftPicks = draftPicksSnapshot.docs.map(
    (pickDoc) => pickDoc.data() as DraftPick
  );

  const rosterSnapshotPicks = await buildCurrentRosterSnapshotPicks(
    leagueId,
    teams,
    draftPicks
  );

  return runTransaction(db, async (transaction) => {
    const [
      cycleSnapshot,
      draftSnapshot
    ] = await Promise.all([
      transaction.get(cycleRef),
      transaction.get(draftRef)
    ]);

    if (cycleSnapshot.exists()) {
      throw new Error(`Cycle ${cycleNumber} has already been started.`);
    }

    if (!draftSnapshot.exists()) {
      throw new Error(
        'The draft must be completed before starting a cycle.'
      );
    }

    const draft =
      draftSnapshot.data() as FantasyDraft;

    if (draft.status !== 'complete') {
      throw new Error(
        'The draft must be completed before starting a cycle.'
      );
    }

    if (rosterSnapshotPicks.length === 0) {
      throw new Error(
        'No active roster assets were found to snapshot for this cycle.'
      );
    }

    const orderedOwnerIds =
      getOrderedOwnerIds(teams, draft);

    const pairings =
      createCyclePairings(orderedOwnerIds, cycleNumber);

    const matchupIds: string[] = [];

    pairings.forEach((pairing, index) => {
      const matchupId = `matchup-${index + 1}`;
      matchupIds.push(matchupId);

      transaction.set(
        getCycleMatchupRef(leagueId, cycleNumber, matchupId),
        {
          id: matchupId,
          cycleNumber,
          teamAOwnerId: pairing.teamAOwnerId,
          teamBOwnerId: pairing.teamBOwnerId,
          teamAScore: 0,
          teamBScore: 0,
          winnerOwnerId: null,
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      );
    });

    writeCycleRosterPickSnapshots(
      transaction,
      leagueId,
      cycleNumber,
      rosterSnapshotPicks
    );

    const cycle: FantasyCycle = {
      id: getCycleDocumentId(cycleNumber),
      cycleNumber,
      status: 'active',
      matchupIds,
      completedAt: null
    };

    transaction.set(cycleRef, {
      ...cycle,
      startedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    return cycle;
  });
}

export async function startNextCycle(
  leagueId: string,
  teams: FantasyTeam[],
  currentCycleNumber: number
): Promise<FantasyCycle> {
  if (teams.length < 2) {
    throw new Error(
      'At least two teams are required to start the next cycle.'
    );
  }

  const nextCycleNumber = currentCycleNumber + 1;
  const currentCycleRef = getCycleRef(leagueId, currentCycleNumber);
  const nextCycleRef = getCycleRef(leagueId, nextCycleNumber);
  const draftRef = getDraftRef(leagueId);
  const draftPicksQuery = query(
    getDraftPicksRef(leagueId),
    orderBy('overallPick', 'asc')
  );

  const draftPicksSnapshot = await getDocs(draftPicksQuery);
  const draftPicks = draftPicksSnapshot.docs.map(
    (pickDoc) => pickDoc.data() as DraftPick
  );

  const rosterSnapshotPicks = await buildCurrentRosterSnapshotPicks(
    leagueId,
    teams,
    draftPicks
  );

  return runTransaction(db, async (transaction) => {
    const [
      currentCycleSnapshot,
      nextCycleSnapshot,
      draftSnapshot
    ] = await Promise.all([
      transaction.get(currentCycleRef),
      transaction.get(nextCycleRef),
      transaction.get(draftRef)
    ]);

    if (!currentCycleSnapshot.exists()) {
      throw new Error(`Cycle ${currentCycleNumber} does not exist.`);
    }

    const currentCycle = normalizeCycle(
      currentCycleSnapshot.data() as Partial<FantasyCycle>,
      currentCycleNumber
    );

    if (currentCycle.status !== 'complete') {
      throw new Error(
        `Cycle ${currentCycleNumber} must be completed before starting Cycle ${nextCycleNumber}.`
      );
    }

    if (nextCycleSnapshot.exists()) {
      throw new Error(`Cycle ${nextCycleNumber} has already been started.`);
    }

    if (!draftSnapshot.exists()) {
      throw new Error(
        'The draft must be completed before starting the next cycle.'
      );
    }

    const draft =
      draftSnapshot.data() as FantasyDraft;

    if (draft.status !== 'complete') {
      throw new Error(
        'The draft must be completed before starting the next cycle.'
      );
    }

    if (rosterSnapshotPicks.length === 0) {
      throw new Error(
        'No active roster assets were found to snapshot for the next cycle.'
      );
    }

    const orderedOwnerIds =
      getOrderedOwnerIds(teams, draft);

    const pairings =
      createCyclePairings(orderedOwnerIds, nextCycleNumber);

    const matchupIds: string[] = [];

    pairings.forEach((pairing, index) => {
      const matchupId = `matchup-${index + 1}`;
      matchupIds.push(matchupId);

      transaction.set(
        getCycleMatchupRef(leagueId, nextCycleNumber, matchupId),
        {
          id: matchupId,
          cycleNumber: nextCycleNumber,
          teamAOwnerId: pairing.teamAOwnerId,
          teamBOwnerId: pairing.teamBOwnerId,
          teamAScore: 0,
          teamBScore: 0,
          winnerOwnerId: null,
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      );
    });

    writeCycleRosterPickSnapshots(
      transaction,
      leagueId,
      nextCycleNumber,
      rosterSnapshotPicks
    );

    const cycle: FantasyCycle = {
      id: getCycleDocumentId(nextCycleNumber),
      cycleNumber: nextCycleNumber,
      status: 'active',
      matchupIds,
      completedAt: null
    };

    transaction.set(nextCycleRef, {
      ...cycle,
      startedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    return cycle;
  });
}

export async function updateCycleMatchupScores(
  leagueId: string,
  cycleNumber: number,
  matchups: FantasyMatchup[],
  teamScores: Record<string, number>
): Promise<void> {
  if (matchups.length === 0) {
    throw new Error(`No Cycle ${cycleNumber} matchups were found to update.`);
  }

  const batch = writeBatch(db);

  for (const matchup of matchups) {
    const teamAScore =
      teamScores[matchup.teamAOwnerId] ?? 0;

    const teamBScore =
      matchup.teamBOwnerId
        ? teamScores[matchup.teamBOwnerId] ?? 0
        : 0;

    batch.update(
      getCycleMatchupRef(leagueId, cycleNumber, matchup.id),
      {
        teamAScore: roundScore(teamAScore),
        teamBScore: roundScore(teamBScore),
        updatedAt: serverTimestamp()
      }
    );
  }

  batch.update(
    getCycleRef(leagueId, cycleNumber),
    {
      updatedAt: serverTimestamp()
    }
  );

  await batch.commit();
}

export async function completeCycle(
  leagueId: string,
  cycleNumber: number,
  matchups: FantasyMatchup[],
  teamScores: Record<string, number>
): Promise<void> {
  if (matchups.length === 0) {
    throw new Error(`No Cycle ${cycleNumber} matchups were found to complete.`);
  }

  const cycleRef = getCycleRef(leagueId, cycleNumber);

  await runTransaction(db, async (transaction) => {
    const cycleSnapshot =
      await transaction.get(cycleRef);

    if (!cycleSnapshot.exists()) {
      throw new Error(`Cycle ${cycleNumber} has not been started yet.`);
    }

    const cycle = normalizeCycle(
      cycleSnapshot.data() as Partial<FantasyCycle>,
      cycleNumber
    );

    if (cycle.status === 'complete') {
      throw new Error(`Cycle ${cycleNumber} has already been completed.`);
    }

    if (cycle.status !== 'active') {
      throw new Error('Only an active cycle can be completed.');
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
        pointsAgainst: 0
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

    function addPoints(
      ownerId: string,
      pointsFor: number,
      pointsAgainst: number
    ): void {
      ensureRecordDelta(ownerId);
      recordDeltas[ownerId].pointsFor += pointsFor;
      recordDeltas[ownerId].pointsAgainst += pointsAgainst;
    }

    for (const matchup of matchups) {
      const teamAScore = roundScore(
        teamScores[matchup.teamAOwnerId] ??
          matchup.teamAScore ??
          0
      );

      const teamBScore = roundScore(
        matchup.teamBOwnerId
          ? teamScores[matchup.teamBOwnerId] ??
              matchup.teamBScore ??
              0
          : 0
      );

      const winnerOwnerId =
        getMatchupWinnerOwnerId(
          matchup.teamAOwnerId,
          matchup.teamBOwnerId,
          teamAScore,
          teamBScore
        );

      transaction.update(
        getCycleMatchupRef(leagueId, cycleNumber, matchup.id),
        {
          teamAScore,
          teamBScore,
          winnerOwnerId,
          status: 'complete',
          updatedAt: serverTimestamp()
        }
      );

      addPoints(
        matchup.teamAOwnerId,
        teamAScore,
        teamBScore
      );

      if (matchup.teamBOwnerId) {
        addPoints(
          matchup.teamBOwnerId,
          teamBScore,
          teamAScore
        );
      }

      if (!matchup.teamBOwnerId) {
        addWin(matchup.teamAOwnerId);
        continue;
      }

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
        updatedAt: serverTimestamp()
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

      transaction.update(
        getTeamRef(leagueId, ownerId),
        teamUpdate
      );
    }

    transaction.update(cycleRef, {
      status: 'complete',
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  });
}

export function listenToCycleOne(
  leagueId: string,
  callback: (cycle: FantasyCycle | null) => void
): () => void {
  return listenToCycle(leagueId, FIRST_CYCLE_NUMBER, callback);
}

export function listenToCycleOneMatchups(
  leagueId: string,
  callback: (matchups: FantasyMatchup[]) => void
): () => void {
  return listenToCycleMatchups(leagueId, FIRST_CYCLE_NUMBER, callback);
}

export async function startCycleOne(
  leagueId: string,
  teams: FantasyTeam[]
): Promise<FantasyCycle> {
  return startCycle(leagueId, teams, FIRST_CYCLE_NUMBER);
}

export async function updateCycleOneMatchupScores(
  leagueId: string,
  matchups: FantasyMatchup[],
  teamScores: Record<string, number>
): Promise<void> {
  return updateCycleMatchupScores(
    leagueId,
    FIRST_CYCLE_NUMBER,
    matchups,
    teamScores
  );
}

export async function completeCycleOne(
  leagueId: string,
  matchups: FantasyMatchup[],
  teamScores: Record<string, number>
): Promise<void> {
  return completeCycle(
    leagueId,
    FIRST_CYCLE_NUMBER,
    matchups,
    teamScores
  );
}
