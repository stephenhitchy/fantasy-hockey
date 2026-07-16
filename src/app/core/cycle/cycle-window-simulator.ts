import { selectCycleWindowGames } from './cycle-window-selection.util';

export interface SyntheticCycleGame {
  id: number;
  day: number;
  final: boolean;
}

export interface CycleSimulationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface CycleSimulationTeamResult {
  teamLabel: string;
  cycleOneGameIds: number[];
  cycleTwoGameIds: number[];
  cycleOneFinalCount: number;
  cycleTwoFinalCount: number;
}

export interface CycleSimulationReport {
  requiredGamesPerCycle: number;
  checks: CycleSimulationCheck[];
  teams: CycleSimulationTeamResult[];
  cycleOneMatchupComplete: boolean;
  cycleTwoHasStarted: boolean;
  allPassed: boolean;
}

function ids(games: SyntheticCycleGame[]): number[] {
  return games.map((game) => game.id);
}

function sameIds(first: number[], second: number[]): boolean {
  return first.length === second.length &&
    first.every((value, index) => value === second[index]);
}

export function runDeterministicCycleWindowSimulation(
  requiredGamesPerCycle: number = 6
): CycleSimulationReport {
  const fastSchedule: SyntheticCycleGame[] = Array.from(
    { length: 7 },
    (_, index) => ({
      id: 101 + index,
      day: index + 1,
      final: true
    })
  );

  const slowSchedule: SyntheticCycleGame[] = [
    { id: 201, day: 1, final: true },
    { id: 202, day: 3, final: true },
    { id: 203, day: 5, final: true },
    { id: 204, day: 7, final: true }
  ];

  const fastCycleOne = selectCycleWindowGames(
    fastSchedule,
    1,
    requiredGamesPerCycle
  );
  const fastCycleTwo = selectCycleWindowGames(
    fastSchedule,
    2,
    requiredGamesPerCycle
  );
  const slowCycleOne = selectCycleWindowGames(
    slowSchedule,
    1,
    requiredGamesPerCycle
  );
  const slowCycleTwo = selectCycleWindowGames(
    slowSchedule,
    2,
    requiredGamesPerCycle
  );

  const fastCycleOneIds = ids(fastCycleOne);
  const fastCycleTwoIds = ids(fastCycleTwo);
  const slowCycleOneIds = ids(slowCycleOne);
  const slowCycleTwoIds = ids(slowCycleTwo);

  const fastCycleOneComplete =
    fastCycleOne.filter((game) => game.final).length === requiredGamesPerCycle;
  const slowCycleOneComplete =
    slowCycleOne.filter((game) => game.final).length === requiredGamesPerCycle;
  const cycleOneMatchupComplete =
    fastCycleOneComplete && slowCycleOneComplete;
  const cycleTwoHasStarted = fastCycleTwo.length > 0;

  const repeatedFastCycleOneIds = ids(
    selectCycleWindowGames(
      fastSchedule,
      1,
      requiredGamesPerCycle
    )
  );

  const fastAppearanceGameIds = new Set([101, 102, 104, 105, 106]);
  const missedGameAdvancesWindow =
    fastCycleOneIds.includes(103) && !fastAppearanceGameIds.has(103);

  const checks: CycleSimulationCheck[] = [
    {
      id: 'cycle-one-six-games',
      label: 'The faster schedule assigns exactly six games to Cycle 1',
      passed: sameIds(fastCycleOneIds, [101, 102, 103, 104, 105, 106]),
      detail: `Cycle 1 received: ${fastCycleOneIds.join(', ')}`
    },
    {
      id: 'seventh-game-next-cycle',
      label: 'The seventh scheduled game moves to Cycle 2',
      passed: sameIds(fastCycleTwoIds, [107]),
      detail: `Cycle 2 received: ${fastCycleTwoIds.join(', ') || 'none'}`
    },
    {
      id: 'no-duplicate-game-ids',
      label: 'No NHL game appears in both cycle windows',
      passed: fastCycleOneIds.every(
        (gameId) => !fastCycleTwoIds.includes(gameId)
      ),
      detail: 'Cycle 1 and Cycle 2 game-ID sets are disjoint.'
    },
    {
      id: 'slow-team-stays-cycle-one',
      label: 'The slower schedule remains at four Cycle 1 games',
      passed: sameIds(slowCycleOneIds, [201, 202, 203, 204]) &&
        slowCycleTwoIds.length === 0,
      detail: `Slow schedule Cycle 1: ${slowCycleOneIds.join(', ')}`
    },
    {
      id: 'overlap-supported',
      label: 'Cycle 2 can start while the Cycle 1 matchup remains open',
      passed: cycleTwoHasStarted && !cycleOneMatchupComplete,
      detail: 'Fast slot has entered Cycle 2; slow slot is still finishing Cycle 1.'
    },
    {
      id: 'missed-game-progress',
      label: 'A missed appearance still advances scheduled-game progress',
      passed: missedGameAdvancesWindow,
      detail: 'Synthetic game 103 counts in the six-game window without an appearance.'
    },
    {
      id: 'idempotent-selection',
      label: 'Running the same window selection twice is idempotent',
      passed: sameIds(fastCycleOneIds, repeatedFastCycleOneIds),
      detail: 'Repeated processing returns the same six game IDs.'
    }
  ];

  return {
    requiredGamesPerCycle,
    checks,
    teams: [
      {
        teamLabel: 'Fast NHL schedule',
        cycleOneGameIds: fastCycleOneIds,
        cycleTwoGameIds: fastCycleTwoIds,
        cycleOneFinalCount: fastCycleOne.filter((game) => game.final).length,
        cycleTwoFinalCount: fastCycleTwo.filter((game) => game.final).length
      },
      {
        teamLabel: 'Slow NHL schedule',
        cycleOneGameIds: slowCycleOneIds,
        cycleTwoGameIds: slowCycleTwoIds,
        cycleOneFinalCount: slowCycleOne.filter((game) => game.final).length,
        cycleTwoFinalCount: slowCycleTwo.filter((game) => game.final).length
      }
    ],
    cycleOneMatchupComplete,
    cycleTwoHasStarted,
    allPassed: checks.every((check) => check.passed)
  };
}
