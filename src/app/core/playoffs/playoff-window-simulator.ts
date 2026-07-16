import { FantasyTeam } from '../team/team.service';
import {
  applyPlayoffRoundResults,
  assignPlayoffRoundWindows,
  createStandardFantasyPlayoffs,
  getPlayoffRoundMatchups
} from './playoff.service';

export interface PlayoffWindowSimulationCheck {
  id: string;
  label: string;
  detail: string;
  passed: boolean;
}

export interface PlayoffWindowSimulationAssignment {
  ownerId: string;
  teamName: string;
  matchupLabel: string;
  windowNumber: number;
  sourceCycleNumber: number;
}

export interface PlayoffWindowSimulationReport {
  allPassed: boolean;
  checks: PlayoffWindowSimulationCheck[];
  openingAssignments: PlayoffWindowSimulationAssignment[];
  secondRoundAssignments: PlayoffWindowSimulationAssignment[];
  regularSeasonCycleCount: number;
}

function createTeams(): FantasyTeam[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `owner-${index + 1}`,
    ownerId: `owner-${index + 1}`,
    teamName: `Seed ${index + 1}`,
    logo: '',
    wins: 12 - index,
    losses: index,
    ties: 0,
    pointsFor: 1200 - (index * 50),
    pointsAgainst: 900 + (index * 20),
    waiverPriority: index + 1,
    draftPosition: index + 1
  }));
}

export function runDeterministicPlayoffWindowSimulation(): PlayoffWindowSimulationReport {
  const regularSeasonCycleCount = 10;
  let playoffs = createStandardFantasyPlayoffs(
    createTeams(),
    regularSeasonCycleCount
  );
  const initialRound = getPlayoffRoundMatchups(playoffs, 1);
  const roundOneAssignments = Object.fromEntries(
    initialRound
      .flatMap((matchup) => [
        matchup.teamAOwnerId,
        matchup.teamBOwnerId
      ])
      .filter((ownerId): ownerId is string => Boolean(ownerId))
      .map((ownerId) => [
        ownerId,
        {
          ownerId,
          windowNumber: 1,
          sourceCycleNumber: regularSeasonCycleCount + 1
        }
      ])
  );

  playoffs = assignPlayoffRoundWindows(
    playoffs,
    1,
    roundOneAssignments
  );
  const roundOne = getPlayoffRoundMatchups(playoffs, 1);
  const championshipOpeners = roundOne.filter(
    (matchup) => matchup.bracketType === 'championship'
  );
  const [firstOpening, secondOpening] = championshipOpeners;
  const consolationOpening = roundOne.find(
    (matchup) => matchup.bracketType === 'consolation'
  );

  if (!firstOpening || !secondOpening || !consolationOpening) {
    throw new Error('The eight-team opening round could not be constructed.');
  }

  const firstWinner = firstOpening.teamAOwnerId === 'owner-3'
    ? 'owner-3'
    : firstOpening.teamAOwnerId!;
  const firstLoser = firstOpening.teamAOwnerId === firstWinner
    ? firstOpening.teamBOwnerId!
    : firstOpening.teamAOwnerId!;
  const secondWinner = secondOpening.teamAOwnerId!;
  const secondLoser = secondOpening.teamBOwnerId!;

  playoffs = applyPlayoffRoundResults(playoffs, 1, [
    {
      matchupId: firstOpening.id,
      teamAScore: firstOpening.teamAOwnerId === firstWinner ? 100 : 80,
      teamBScore: firstOpening.teamBOwnerId === firstWinner ? 100 : 80,
      winnerOwnerId: firstWinner,
      loserOwnerId: firstLoser,
      tieBrokenByHigherSeed: false
    },
    {
      matchupId: secondOpening.id,
      teamAScore: 95,
      teamBScore: 75,
      winnerOwnerId: secondWinner,
      loserOwnerId: secondLoser,
      tieBrokenByHigherSeed: false
    },
    {
      matchupId: consolationOpening.id,
      teamAScore: 70,
      teamBScore: 60,
      winnerOwnerId: consolationOpening.teamAOwnerId!,
      loserOwnerId: consolationOpening.teamBOwnerId!,
      tieBrokenByHigherSeed: false
    }
  ]);

  const roundTwoOwnerIds = getPlayoffRoundMatchups(playoffs, 2)
    .flatMap((matchup) => [
      matchup.teamAOwnerId,
      matchup.teamBOwnerId
    ])
    .filter((ownerId): ownerId is string => Boolean(ownerId));
  const secondRoundAssignments = Object.fromEntries(
    [...new Set(roundTwoOwnerIds)].map((ownerId) => {
      const hasBye = ownerId === 'owner-1' || ownerId === 'owner-2';

      return [
        ownerId,
        {
          ownerId,
          windowNumber: hasBye ? 1 : 2,
          sourceCycleNumber:
            regularSeasonCycleCount + (hasBye ? 1 : 2)
        }
      ];
    })
  );

  playoffs = assignPlayoffRoundWindows(
    playoffs,
    2,
    secondRoundAssignments
  );
  const roundTwo = getPlayoffRoundMatchups(playoffs, 2);
  const usedAssignments = [
    ...roundOne.flatMap((matchup) => [
      `${matchup.teamAOwnerId}:${matchup.teamAWindowNumber}`,
      `${matchup.teamBOwnerId}:${matchup.teamBWindowNumber}`
    ]),
    ...roundTwo.flatMap((matchup) => [
      `${matchup.teamAOwnerId}:${matchup.teamAWindowNumber}`,
      `${matchup.teamBOwnerId}:${matchup.teamBWindowNumber}`
    ])
  ];
  const checks: PlayoffWindowSimulationCheck[] = [
    {
      id: 'opening-window-one',
      label: 'Opening-round teams use Playoff Window 1',
      detail: 'Seeds 3–6 are assigned their first six-game postseason window.',
      passed: championshipOpeners.every((matchup) =>
        matchup.teamAWindowNumber === 1 &&
        matchup.teamBWindowNumber === 1
      )
    },
    {
      id: 'bye-window-banked',
      label: 'Bye teams keep Window 1 banked',
      detail: 'Seeds 1 and 2 do not spend their first window during the opening round.',
      passed: championshipOpeners.every((matchup) =>
        matchup.teamAOwnerId !== 'owner-1' &&
        matchup.teamBOwnerId !== 'owner-1' &&
        matchup.teamAOwnerId !== 'owner-2' &&
        matchup.teamBOwnerId !== 'owner-2'
      )
    },
    {
      id: 'bye-enters-semifinal-window-one',
      label: 'Bye teams enter the semifinals with banked Window 1',
      detail: 'The top two seeds retain already-played Window 1 games when their opponents become known.',
      passed: roundTwo
        .filter((matchup) =>
          matchup.teamAOwnerId === 'owner-1' ||
          matchup.teamAOwnerId === 'owner-2' ||
          matchup.teamBOwnerId === 'owner-1' ||
          matchup.teamBOwnerId === 'owner-2'
        )
        .every((matchup) => {
          const byeSide = matchup.teamAOwnerId === 'owner-1' ||
            matchup.teamAOwnerId === 'owner-2'
            ? matchup.teamAWindowNumber
            : matchup.teamBWindowNumber;

          return byeSide === 1;
        })
    },
    {
      id: 'opening-team-advances-window-two',
      label: 'Opening-round teams advance with Window 2',
      detail: 'Winners and fifth-place participants use the next six-game window rather than replaying Window 1.',
      passed: roundTwo.every((matchup) => {
        const nonByeWindow = matchup.teamAOwnerId === 'owner-1' ||
          matchup.teamAOwnerId === 'owner-2'
          ? matchup.teamBWindowNumber
          : matchup.teamAWindowNumber;

        return nonByeWindow === 2;
      })
    },
    {
      id: 'fifth-place-routing',
      label: 'Opening-round losers route into the fifth-place game',
      detail: `${firstLoser} and ${secondLoser} are routed through their second banked windows.`,
      passed: roundTwo.some((matchup) =>
        matchup.winnerPlace === 5 &&
        new Set([
          matchup.teamAOwnerId,
          matchup.teamBOwnerId
        ]).has(firstLoser) &&
        new Set([
          matchup.teamAOwnerId,
          matchup.teamBOwnerId
        ]).has(secondLoser) &&
        matchup.teamAWindowNumber === 2 &&
        matchup.teamBWindowNumber === 2
      )
    },
    {
      id: 'no-window-double-use',
      label: 'No owner/window assignment is used twice',
      detail: 'A six-game bank can feed only one playoff matchup.',
      passed: new Set(usedAssignments).size === usedAssignments.length
    },
    {
      id: 'different-window-sides-supported',
      label: 'One matchup can use different window numbers on each side',
      detail: 'A bye team can use Window 1 against an opening-round winner using Window 2.',
      passed: roundTwo.some((matchup) =>
        matchup.teamAWindowNumber !== matchup.teamBWindowNumber
      )
    }
  ];

  const teamName = (ownerId: string | null) =>
    playoffs.seeds.find((seed) => seed.ownerId === ownerId)?.teamName ??
    'Unknown';
  const toAssignments = (
    matchups: typeof roundOne
  ): PlayoffWindowSimulationAssignment[] =>
    matchups.flatMap((matchup) => [
      {
        ownerId: matchup.teamAOwnerId!,
        teamName: teamName(matchup.teamAOwnerId),
        matchupLabel: matchup.winnerPlace === 5
          ? '5th Place Game'
          : matchup.roundLabel,
        windowNumber: matchup.teamAWindowNumber ?? 0,
        sourceCycleNumber: matchup.teamAWindowCycleNumber ?? 0
      },
      {
        ownerId: matchup.teamBOwnerId!,
        teamName: teamName(matchup.teamBOwnerId),
        matchupLabel: matchup.winnerPlace === 5
          ? '5th Place Game'
          : matchup.roundLabel,
        windowNumber: matchup.teamBWindowNumber ?? 0,
        sourceCycleNumber: matchup.teamBWindowCycleNumber ?? 0
      }
    ]);

  return {
    allPassed: checks.every((check) => check.passed),
    checks,
    openingAssignments: toAssignments(roundOne),
    secondRoundAssignments: toAssignments(roundTwo),
    regularSeasonCycleCount
  };
}
