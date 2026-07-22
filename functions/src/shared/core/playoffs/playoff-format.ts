import {
  FantasyPlayoffBracketType,
  FantasyPlayoffMatchup,
  FantasyPlayoffSource
} from './playoff.models';

export const STANDARD_FULL_CYCLE_SEASON_COUNT = 13;

interface ClassificationTemplateMatchup {
  id: string;
  roundNumber: number;
  sourceA: FantasyPlayoffSource;
  sourceB: FantasyPlayoffSource;
  winnerRelativePlace: number | null;
  loserRelativePlace: number | null;
}

function seedSource(seed: number): FantasyPlayoffSource {
  return {
    type: 'seed',
    seed
  };
}

function winnerSource(matchupId: string): FantasyPlayoffSource {
  return {
    type: 'winner',
    matchupId
  };
}

function loserSource(matchupId: string): FantasyPlayoffSource {
  return {
    type: 'loser',
    matchupId
  };
}

export function getStandardPlayoffTeamCount(
  teamCount: number
): number {
  if (teamCount < 2) {
    return 0;
  }

  if (teamCount <= 3) {
    return 2;
  }

  if (teamCount <= 7) {
    return 4;
  }

  return 6;
}

export function getStandardPlayoffRoundCount(
  playoffTeamCount: number
): number {
  if (playoffTeamCount <= 1) {
    return 0;
  }

  if (playoffTeamCount <= 2) {
    return 1;
  }

  if (playoffTeamCount <= 4) {
    return 2;
  }

  return 3;
}

export function getStandardRegularSeasonCycleCount(
  teamCount: number
): number {
  const playoffTeamCount = getStandardPlayoffTeamCount(teamCount);
  const playoffRoundCount = getStandardPlayoffRoundCount(
    playoffTeamCount
  );

  return Math.max(
    1,
    STANDARD_FULL_CYCLE_SEASON_COUNT - playoffRoundCount
  );
}

export function getPlayoffRoundLabel(
  roundNumber: number,
  roundCount: number
): string {
  if (roundCount <= 1) {
    return 'League Championship';
  }

  if (roundCount === 2) {
    return roundNumber === 1
      ? 'Playoff Semifinals'
      : 'League Championship';
  }

  if (roundNumber === 1) {
    return 'Playoff Opening Round';
  }

  if (roundNumber === 2) {
    return 'Playoff Semifinals';
  }

  return 'League Championship';
}

export function getPlacementGameLabel(
  matchup: Pick<
    FantasyPlayoffMatchup,
    'bracketType' | 'winnerPlace' | 'loserPlace'
  >
): string {
  if (matchup.winnerPlace === 1 && matchup.loserPlace === 2) {
    return 'Championship Game';
  }

  if (
    typeof matchup.winnerPlace === 'number' &&
    typeof matchup.loserPlace === 'number'
  ) {
    return `${matchup.winnerPlace}${getOrdinalSuffix(matchup.winnerPlace)} Place Game`;
  }

  return matchup.bracketType === 'championship'
    ? 'Championship Bracket'
    : 'Consolation Bracket';
}

function getOrdinalSuffix(value: number): string {
  const lastTwoDigits = value % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
    return 'th';
  }

  switch (value % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

function createClassificationTemplate(
  bracketPrefix: string,
  seedNumbers: number[]
): ClassificationTemplateMatchup[] {
  const count = seedNumbers.length;
  const seed = (relativeSeed: number) =>
    seedNumbers[relativeSeed - 1];
  const id = (roundNumber: number, matchupNumber: number) =>
    `${bracketPrefix}-r${roundNumber}-m${matchupNumber}`;

  if (count <= 1) {
    return [];
  }

  if (count === 2) {
    return [
      {
        id: id(1, 1),
        roundNumber: 1,
        sourceA: seedSource(seed(1)),
        sourceB: seedSource(seed(2)),
        winnerRelativePlace: 1,
        loserRelativePlace: 2
      }
    ];
  }

  if (count === 3) {
    const openingMatchupId = id(1, 1);

    return [
      {
        id: openingMatchupId,
        roundNumber: 1,
        sourceA: seedSource(seed(2)),
        sourceB: seedSource(seed(3)),
        winnerRelativePlace: null,
        loserRelativePlace: 3
      },
      {
        id: id(2, 1),
        roundNumber: 2,
        sourceA: seedSource(seed(1)),
        sourceB: winnerSource(openingMatchupId),
        winnerRelativePlace: 1,
        loserRelativePlace: 2
      }
    ];
  }

  if (count === 4) {
    const semifinalOneId = id(1, 1);
    const semifinalTwoId = id(1, 2);

    return [
      {
        id: semifinalOneId,
        roundNumber: 1,
        sourceA: seedSource(seed(1)),
        sourceB: seedSource(seed(4)),
        winnerRelativePlace: null,
        loserRelativePlace: null
      },
      {
        id: semifinalTwoId,
        roundNumber: 1,
        sourceA: seedSource(seed(2)),
        sourceB: seedSource(seed(3)),
        winnerRelativePlace: null,
        loserRelativePlace: null
      },
      {
        id: id(2, 1),
        roundNumber: 2,
        sourceA: winnerSource(semifinalOneId),
        sourceB: winnerSource(semifinalTwoId),
        winnerRelativePlace: 1,
        loserRelativePlace: 2
      },
      {
        id: id(2, 2),
        roundNumber: 2,
        sourceA: loserSource(semifinalOneId),
        sourceB: loserSource(semifinalTwoId),
        winnerRelativePlace: 3,
        loserRelativePlace: 4
      }
    ];
  }

  if (count === 5) {
    const openingMatchupId = id(1, 1);
    const semifinalOneId = id(2, 1);
    const semifinalTwoId = id(2, 2);

    return [
      {
        id: openingMatchupId,
        roundNumber: 1,
        sourceA: seedSource(seed(4)),
        sourceB: seedSource(seed(5)),
        winnerRelativePlace: null,
        loserRelativePlace: 5
      },
      {
        id: semifinalOneId,
        roundNumber: 2,
        sourceA: seedSource(seed(1)),
        sourceB: winnerSource(openingMatchupId),
        winnerRelativePlace: null,
        loserRelativePlace: null
      },
      {
        id: semifinalTwoId,
        roundNumber: 2,
        sourceA: seedSource(seed(2)),
        sourceB: seedSource(seed(3)),
        winnerRelativePlace: null,
        loserRelativePlace: null
      },
      {
        id: id(3, 1),
        roundNumber: 3,
        sourceA: winnerSource(semifinalOneId),
        sourceB: winnerSource(semifinalTwoId),
        winnerRelativePlace: 1,
        loserRelativePlace: 2
      },
      {
        id: id(3, 2),
        roundNumber: 3,
        sourceA: loserSource(semifinalOneId),
        sourceB: loserSource(semifinalTwoId),
        winnerRelativePlace: 3,
        loserRelativePlace: 4
      }
    ];
  }

  const openingOneId = id(1, 1);
  const openingTwoId = id(1, 2);
  const semifinalOneId = id(2, 1);
  const semifinalTwoId = id(2, 2);

  return [
    {
      id: openingOneId,
      roundNumber: 1,
      sourceA: seedSource(seed(3)),
      sourceB: seedSource(seed(6)),
      winnerRelativePlace: null,
      loserRelativePlace: null
    },
    {
      id: openingTwoId,
      roundNumber: 1,
      sourceA: seedSource(seed(4)),
      sourceB: seedSource(seed(5)),
      winnerRelativePlace: null,
      loserRelativePlace: null
    },
    {
      id: semifinalOneId,
      roundNumber: 2,
      sourceA: seedSource(seed(1)),
      sourceB: winnerSource(openingTwoId),
      winnerRelativePlace: null,
      loserRelativePlace: null
    },
    {
      id: semifinalTwoId,
      roundNumber: 2,
      sourceA: seedSource(seed(2)),
      sourceB: winnerSource(openingOneId),
      winnerRelativePlace: null,
      loserRelativePlace: null
    },
    {
      id: id(2, 3),
      roundNumber: 2,
      sourceA: loserSource(openingOneId),
      sourceB: loserSource(openingTwoId),
      winnerRelativePlace: 5,
      loserRelativePlace: 6
    },
    {
      id: id(3, 1),
      roundNumber: 3,
      sourceA: winnerSource(semifinalOneId),
      sourceB: winnerSource(semifinalTwoId),
      winnerRelativePlace: 1,
      loserRelativePlace: 2
    },
    {
      id: id(3, 2),
      roundNumber: 3,
      sourceA: loserSource(semifinalOneId),
      sourceB: loserSource(semifinalTwoId),
      winnerRelativePlace: 3,
      loserRelativePlace: 4
    }
  ];
}

export function buildStandardBracketMatchups(
  bracketType: FantasyPlayoffBracketType,
  seedNumbers: number[],
  placementOffset: number,
  playoffRoundCount: number,
  regularSeasonCycleCount: number
): FantasyPlayoffMatchup[] {
  const prefix = bracketType === 'championship'
    ? 'championship'
    : 'consolation';

  return createClassificationTemplate(prefix, seedNumbers).map(
    (template) => ({
      id: template.id,
      bracketType,
      roundNumber: template.roundNumber,
      roundLabel: getPlayoffRoundLabel(
        template.roundNumber,
        playoffRoundCount
      ),
      cycleNumber:
        regularSeasonCycleCount + template.roundNumber,
      sourceA: template.sourceA,
      sourceB: template.sourceB,
      teamAOwnerId: null,
      teamBOwnerId: null,
      teamASeed: null,
      teamBSeed: null,
      teamAWindowNumber: null,
      teamBWindowNumber: null,
      teamAWindowCycleNumber: null,
      teamBWindowCycleNumber: null,
      teamAScore: null,
      teamBScore: null,
      winnerOwnerId: null,
      loserOwnerId: null,
      winnerPlace:
        template.winnerRelativePlace === null
          ? null
          : placementOffset + template.winnerRelativePlace,
      loserPlace:
        template.loserRelativePlace === null
          ? null
          : placementOffset + template.loserRelativePlace,
      status: 'scheduled',
      tieBrokenByHigherSeed: false,
      completedAt: null
    })
  );
}
