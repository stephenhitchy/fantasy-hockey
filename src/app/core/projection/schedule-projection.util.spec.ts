import { describe, expect, it } from 'vitest';

import {
  buildTeamStrengthProfiles,
  calculateProjectionScheduleContext,
} from './schedule-projection.util';
import { NhlTeamSeasonGame } from '../nhl/nhl-api.service';

function game(
  id: number,
  date: string,
  home: string,
  away: string,
  homeScore?: number,
  awayScore?: number,
): NhlTeamSeasonGame {
  return {
    id,
    gameDate: date,
    gameType: 2,
    gameState:
      typeof homeScore === 'number' && typeof awayScore === 'number'
        ? 'FINAL'
        : 'FUT',
    homeTeam: { abbrev: home, score: homeScore },
    awayTeam: { abbrev: away, score: awayScore },
  };
}

describe('schedule-adjusted projections', () => {
  it('raises skater projections for a favorable schedule and lowers them for a difficult one', () => {
    const previous = new Map<string, NhlTeamSeasonGame[]>([
      ['AAA', [game(1, '2025-01-01', 'AAA', 'BBB', 4, 1), game(2, '2025-01-03', 'CCC', 'AAA', 1, 4)]],
      ['BBB', [game(1, '2025-01-01', 'AAA', 'BBB', 4, 1), game(3, '2025-01-03', 'BBB', 'CCC', 1, 5)]],
      ['CCC', [game(2, '2025-01-03', 'CCC', 'AAA', 1, 4), game(3, '2025-01-03', 'BBB', 'CCC', 1, 5)]],
    ]);
    const current = new Map<string, NhlTeamSeasonGame[]>([
      ['AAA', [game(10, '2026-10-01', 'AAA', 'BBB'), game(11, '2026-10-04', 'AAA', 'BBB')]],
      ['BBB', [game(10, '2026-10-01', 'AAA', 'BBB'), game(11, '2026-10-04', 'AAA', 'BBB')]],
      ['CCC', []],
    ]);
    const profiles = buildTeamStrengthProfiles(current, previous);
    const favorable = calculateProjectionScheduleContext({
      teamAbbreviation: 'AAA',
      position: 'C',
      targetGames: current.get('AAA') ?? [],
      teamSchedules: current,
      teamStrengthProfiles: profiles,
      requiredGamesPerCycle: 2,
    });

    expect(favorable.multiplier).toBeGreaterThan(1);
  });

  it('flags back-to-back games without allowing the schedule layer to dominate talent', () => {
    const schedule = [
      game(20, '2026-10-01', 'AAA', 'BBB'),
      game(21, '2026-10-02', 'CCC', 'AAA'),
    ];
    const schedules = new Map<string, NhlTeamSeasonGame[]>([
      ['AAA', schedule],
      ['BBB', [schedule[0]]],
      ['CCC', [schedule[1]]],
    ]);
    const profiles = buildTeamStrengthProfiles(schedules, new Map());
    const context = calculateProjectionScheduleContext({
      teamAbbreviation: 'AAA',
      position: 'G',
      targetGames: schedule,
      teamSchedules: schedules,
      teamStrengthProfiles: profiles,
      requiredGamesPerCycle: 2,
    });

    expect(context.backToBackGames).toBe(1);
    expect(context.multiplier).toBeGreaterThanOrEqual(0.92);
    expect(context.multiplier).toBeLessThanOrEqual(1.07);
  });
});
