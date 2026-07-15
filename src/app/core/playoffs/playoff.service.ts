import {
  doc,
  getDoc,
  onSnapshot
} from 'firebase/firestore';

import { db } from '../firebase';
import {
  buildFantasyStandings
} from '../league/standings.util';
import {
  FantasyTeam
} from '../team/team.service';

import {
  buildStandardBracketMatchups,
  getPlayoffRoundLabel,
  getStandardPlayoffRoundCount,
  getStandardPlayoffTeamCount
} from './playoff-format';

import {
  FantasyPlayoffMatchup,
  FantasyPlayoffPlacement,
  FantasyPlayoffRoundResult,
  FantasyPlayoffSeed,
  FantasyPlayoffs,
  FantasyPlayoffSource
} from './playoff.models';

export function getFantasyPlayoffsRef(leagueId: string) {
  return doc(
    db,
    'leagues',
    leagueId,
    'playoffs',
    'current'
  );
}

function getNumber(
  value: unknown,
  fallback: number = 0
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

function getNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function getNullableString(value: unknown): string | null {
  return typeof value === 'string' && value
    ? value
    : null;
}

function normalizeSource(
  value: unknown
): FantasyPlayoffSource {
  const source = value as Partial<FantasyPlayoffSource> | null;

  if (
    source?.type === 'seed' &&
    typeof source.seed === 'number'
  ) {
    return {
      type: 'seed',
      seed: source.seed
    };
  }

  if (
    (source?.type === 'winner' || source?.type === 'loser') &&
    typeof source.matchupId === 'string'
  ) {
    return {
      type: source.type,
      matchupId: source.matchupId
    };
  }

  return {
    type: 'seed',
    seed: 0
  };
}

function normalizeSeed(
  value: Partial<FantasyPlayoffSeed>
): FantasyPlayoffSeed {
  const wins = getNumber(value.wins);
  const losses = getNumber(value.losses);
  const ties = getNumber(value.ties);
  const gamesPlayed = getNumber(
    value.gamesPlayed,
    wins + losses + ties
  );

  return {
    seed: getNumber(value.seed),
    ownerId: value.ownerId ?? '',
    teamName: value.teamName ?? 'Unknown Team',
    wins,
    losses,
    ties,
    gamesPlayed,
    winPercentage: getNumber(value.winPercentage),
    pointsFor: getNumber(value.pointsFor),
    pointsAgainst: getNumber(value.pointsAgainst),
    pointDifferential: getNumber(value.pointDifferential)
  };
}

function normalizeMatchup(
  value: Partial<FantasyPlayoffMatchup>
): FantasyPlayoffMatchup {
  return {
    id: value.id ?? '',
    bracketType:
      value.bracketType === 'consolation'
        ? 'consolation'
        : 'championship',
    roundNumber: getNumber(value.roundNumber, 1),
    roundLabel: value.roundLabel ?? 'Playoffs',
    cycleNumber: getNumber(value.cycleNumber),
    sourceA: normalizeSource(value.sourceA),
    sourceB: normalizeSource(value.sourceB),
    teamAOwnerId: getNullableString(value.teamAOwnerId),
    teamBOwnerId: getNullableString(value.teamBOwnerId),
    teamASeed: getNullableNumber(value.teamASeed),
    teamBSeed: getNullableNumber(value.teamBSeed),
    teamAScore: getNullableNumber(value.teamAScore),
    teamBScore: getNullableNumber(value.teamBScore),
    winnerOwnerId: getNullableString(value.winnerOwnerId),
    loserOwnerId: getNullableString(value.loserOwnerId),
    winnerPlace: getNullableNumber(value.winnerPlace),
    loserPlace: getNullableNumber(value.loserPlace),
    status:
      value.status === 'complete'
        ? 'complete'
        : value.status === 'active'
          ? 'active'
          : 'scheduled',
    tieBrokenByHigherSeed:
      value.tieBrokenByHigherSeed === true,
    completedAt: value.completedAt ?? null
  };
}

function normalizePlacement(
  value: Partial<FantasyPlayoffPlacement>
): FantasyPlayoffPlacement {
  return {
    place: getNumber(value.place),
    ownerId: value.ownerId ?? '',
    seed: getNumber(value.seed),
    teamName: value.teamName ?? 'Unknown Team'
  };
}

export function normalizeFantasyPlayoffs(
  value: Partial<FantasyPlayoffs>
): FantasyPlayoffs {
  const seeds = Array.isArray(value.seeds)
    ? value.seeds.map((seed) => normalizeSeed(seed))
    : [];
  const matchups = Array.isArray(value.matchups)
    ? value.matchups.map((matchup) => normalizeMatchup(matchup))
    : [];
  const placements = Array.isArray(value.placements)
    ? value.placements.map((placement) =>
        normalizePlacement(placement)
      )
    : [];

  return {
    id: 'current',
    formatVersion: 1,
    formatName: 'standard',
    status: value.status === 'complete'
      ? 'complete'
      : 'active',
    regularSeasonCycleCount: getNumber(
      value.regularSeasonCycleCount
    ),
    playoffTeamCount: getNumber(value.playoffTeamCount),
    playoffRoundCount: getNumber(value.playoffRoundCount),
    currentRoundNumber: getNumber(value.currentRoundNumber, 1),
    currentCycleNumber: getNumber(value.currentCycleNumber),
    seeds,
    matchups,
    placements,
    championOwnerId: getNullableString(value.championOwnerId),
    runnerUpOwnerId: getNullableString(value.runnerUpOwnerId),
    thirdPlaceOwnerId: getNullableString(value.thirdPlaceOwnerId),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt ?? null
  };
}

export async function getFantasyPlayoffs(
  leagueId: string
): Promise<FantasyPlayoffs | null> {
  const snapshot = await getDoc(
    getFantasyPlayoffsRef(leagueId)
  );

  if (!snapshot.exists()) {
    return null;
  }

  return normalizeFantasyPlayoffs(
    snapshot.data() as Partial<FantasyPlayoffs>
  );
}

export function listenToFantasyPlayoffs(
  leagueId: string,
  callback: (playoffs: FantasyPlayoffs | null) => void,
  onError?: (error: Error) => void
): () => void {
  return onSnapshot(
    getFantasyPlayoffsRef(leagueId),
    (snapshot) => {
      callback(
        snapshot.exists()
          ? normalizeFantasyPlayoffs(
              snapshot.data() as Partial<FantasyPlayoffs>
            )
          : null
      );
    },
    (error) => {
      const normalizedError = error instanceof Error
        ? error
        : new Error('Unable to load the playoff bracket.');

      if (onError) {
        onError(normalizedError);
        return;
      }

      console.error('Unable to load the playoff bracket.', error);
    }
  );
}

function createPlayoffSeeds(
  teams: FantasyTeam[]
): FantasyPlayoffSeed[] {
  return buildFantasyStandings(teams).map((standing, index) => ({
    seed: index + 1,
    ...standing
  }));
}

function resolveSourceOwnerId(
  source: FantasyPlayoffSource,
  playoffs: FantasyPlayoffs
): string | null {
  if (source.type === 'seed') {
    return playoffs.seeds.find(
      (seed) => seed.seed === source.seed
    )?.ownerId ?? null;
  }

  const sourceMatchup = playoffs.matchups.find(
    (matchup) => matchup.id === source.matchupId
  );

  if (!sourceMatchup || sourceMatchup.status !== 'complete') {
    return null;
  }

  return source.type === 'winner'
    ? sourceMatchup.winnerOwnerId
    : sourceMatchup.loserOwnerId;
}

function getOwnerSeed(
  ownerId: string | null,
  playoffs: FantasyPlayoffs
): number | null {
  if (!ownerId) {
    return null;
  }

  return playoffs.seeds.find(
    (seed) => seed.ownerId === ownerId
  )?.seed ?? null;
}

export function resolvePlayoffRound(
  playoffs: FantasyPlayoffs,
  roundNumber: number
): FantasyPlayoffs {
  const working: FantasyPlayoffs = {
    ...playoffs,
    seeds: playoffs.seeds.map((seed) => ({ ...seed })),
    placements: playoffs.placements.map(
      (placement) => ({ ...placement })
    ),
    matchups: playoffs.matchups.map((matchup) => ({
      ...matchup,
      sourceA: { ...matchup.sourceA },
      sourceB: { ...matchup.sourceB }
    }))
  };

  working.matchups = working.matchups.map((matchup) => {
    if (
      matchup.roundNumber !== roundNumber ||
      matchup.status === 'complete'
    ) {
      return matchup;
    }

    const teamAOwnerId = resolveSourceOwnerId(
      matchup.sourceA,
      working
    );
    const teamBOwnerId = resolveSourceOwnerId(
      matchup.sourceB,
      working
    );

    return {
      ...matchup,
      teamAOwnerId,
      teamBOwnerId,
      teamASeed: getOwnerSeed(teamAOwnerId, working),
      teamBSeed: getOwnerSeed(teamBOwnerId, working),
      status:
        teamAOwnerId && teamBOwnerId
          ? 'active'
          : 'scheduled'
    };
  });

  return working;
}

function upsertPlacement(
  playoffs: FantasyPlayoffs,
  place: number,
  ownerId: string
): void {
  const seed = playoffs.seeds.find(
    (candidate) => candidate.ownerId === ownerId
  );

  if (!seed) {
    return;
  }

  const placement: FantasyPlayoffPlacement = {
    place,
    ownerId,
    seed: seed.seed,
    teamName: seed.teamName
  };

  const existingIndex = playoffs.placements.findIndex(
    (candidate) => candidate.place === place
  );

  if (existingIndex >= 0) {
    playoffs.placements[existingIndex] = placement;
    return;
  }

  playoffs.placements.push(placement);
}

export function createStandardFantasyPlayoffs(
  teams: FantasyTeam[],
  regularSeasonCycleCount: number
): FantasyPlayoffs {
  if (teams.length < 2) {
    throw new Error(
      'At least two teams are required to create playoffs.'
    );
  }

  const seeds = createPlayoffSeeds(teams);
  const playoffTeamCount = Math.min(
    getStandardPlayoffTeamCount(teams.length),
    teams.length
  );
  const playoffRoundCount = getStandardPlayoffRoundCount(
    playoffTeamCount
  );
  const championshipSeedNumbers = seeds
    .slice(0, playoffTeamCount)
    .map((seed) => seed.seed);
  const consolationSeedNumbers = seeds
    .slice(playoffTeamCount)
    .map((seed) => seed.seed);

  let playoffs: FantasyPlayoffs = {
    id: 'current',
    formatVersion: 1,
    formatName: 'standard',
    status: 'active',
    regularSeasonCycleCount,
    playoffTeamCount,
    playoffRoundCount,
    currentRoundNumber: 1,
    currentCycleNumber: regularSeasonCycleCount + 1,
    seeds,
    matchups: [
      ...buildStandardBracketMatchups(
        'championship',
        championshipSeedNumbers,
        0,
        playoffRoundCount,
        regularSeasonCycleCount
      ),
      ...buildStandardBracketMatchups(
        'consolation',
        consolationSeedNumbers,
        playoffTeamCount,
        playoffRoundCount,
        regularSeasonCycleCount
      )
    ],
    placements: [],
    championOwnerId: null,
    runnerUpOwnerId: null,
    thirdPlaceOwnerId: null,
    completedAt: null
  };

  if (consolationSeedNumbers.length === 1) {
    upsertPlacement(
      playoffs,
      playoffTeamCount + 1,
      seeds[playoffTeamCount].ownerId
    );
  }

  playoffs = resolvePlayoffRound(playoffs, 1);

  return playoffs;
}

export function getPlayoffRoundMatchups(
  playoffs: FantasyPlayoffs,
  roundNumber: number
): FantasyPlayoffMatchup[] {
  return playoffs.matchups
    .filter((matchup) =>
      matchup.roundNumber === roundNumber &&
      matchup.teamAOwnerId &&
      matchup.teamBOwnerId
    )
    .sort((first, second) => {
      if (first.bracketType !== second.bracketType) {
        return first.bracketType === 'championship' ? -1 : 1;
      }

      return first.id.localeCompare(second.id);
    });
}

export function getPlayoffRoundOwnerIds(
  playoffs: FantasyPlayoffs,
  roundNumber: number
): string[] {
  return Array.from(
    new Set(
      getPlayoffRoundMatchups(playoffs, roundNumber)
        .flatMap((matchup) => [
          matchup.teamAOwnerId,
          matchup.teamBOwnerId
        ])
        .filter((ownerId): ownerId is string => Boolean(ownerId))
    )
  );
}

export function applyPlayoffRoundResults(
  playoffs: FantasyPlayoffs,
  roundNumber: number,
  results: FantasyPlayoffRoundResult[]
): FantasyPlayoffs {
  const resultByMatchupId = new Map(
    results.map((result) => [result.matchupId, result])
  );

  let working: FantasyPlayoffs = {
    ...playoffs,
    seeds: playoffs.seeds.map((seed) => ({ ...seed })),
    placements: playoffs.placements.map(
      (placement) => ({ ...placement })
    ),
    matchups: playoffs.matchups.map((matchup) => ({
      ...matchup,
      sourceA: { ...matchup.sourceA },
      sourceB: { ...matchup.sourceB }
    }))
  };

  working.matchups = working.matchups.map((matchup) => {
    const result = resultByMatchupId.get(matchup.id);

    if (!result) {
      return matchup;
    }

    if (matchup.roundNumber !== roundNumber) {
      throw new Error(
        `Playoff result ${matchup.id} does not belong to round ${roundNumber}.`
      );
    }

    const savedParticipants = new Set([
      matchup.teamAOwnerId,
      matchup.teamBOwnerId
    ]);
    const resultParticipants = new Set([
      result.winnerOwnerId,
      result.loserOwnerId
    ]);

    if (
      savedParticipants.size !== 2 ||
      resultParticipants.size !== 2 ||
      !savedParticipants.has(result.winnerOwnerId) ||
      !savedParticipants.has(result.loserOwnerId)
    ) {
      throw new Error(
        `Playoff result ${matchup.id} does not match the saved bracket participants.`
      );
    }

    return {
      ...matchup,
      teamAScore: result.teamAScore,
      teamBScore: result.teamBScore,
      winnerOwnerId: result.winnerOwnerId,
      loserOwnerId: result.loserOwnerId,
      tieBrokenByHigherSeed: result.tieBrokenByHigherSeed,
      status: 'complete',
      completedAt: new Date().toISOString()
    };
  });

  for (const matchup of working.matchups) {
    const result = resultByMatchupId.get(matchup.id);

    if (!result) {
      continue;
    }

    if (typeof matchup.winnerPlace === 'number') {
      upsertPlacement(
        working,
        matchup.winnerPlace,
        result.winnerOwnerId
      );
    }

    if (typeof matchup.loserPlace === 'number') {
      upsertPlacement(
        working,
        matchup.loserPlace,
        result.loserOwnerId
      );
    }
  }

  working.placements.sort(
    (first, second) => first.place - second.place
  );

  if (roundNumber >= working.playoffRoundCount) {
    working.status = 'complete';
    working.championOwnerId = working.placements.find(
      (placement) => placement.place === 1
    )?.ownerId ?? null;
    working.runnerUpOwnerId = working.placements.find(
      (placement) => placement.place === 2
    )?.ownerId ?? null;
    working.thirdPlaceOwnerId = working.placements.find(
      (placement) => placement.place === 3
    )?.ownerId ?? null;
    working.completedAt = new Date().toISOString();
    return working;
  }

  working.currentRoundNumber = roundNumber + 1;
  working.currentCycleNumber =
    working.regularSeasonCycleCount + working.currentRoundNumber;
  working = resolvePlayoffRound(
    working,
    working.currentRoundNumber
  );

  return working;
}

export function getPlayoffStageLabel(
  playoffs: FantasyPlayoffs | null,
  roundNumber: number
): string {
  if (!playoffs) {
    return 'Playoffs';
  }

  return getPlayoffRoundLabel(
    roundNumber,
    playoffs.playoffRoundCount
  );
}
