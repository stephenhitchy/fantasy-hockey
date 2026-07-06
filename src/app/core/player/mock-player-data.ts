import {
  calculateGoalieGamePoints,
  calculateSkaterGamePoints,
  GoalieGameStats,
  SkaterGameStats
} from '../scoring/scoring-engine';
import { defaultScoringRules } from '../scoring/scoring-rules';
import { NHLPlayer, PlayerCycleScore } from './player.models';

export interface MockSkaterGame {
  type: 'skater';
  date: string;
  opponent: string;
  result: string;
  stats: SkaterGameStats;
}

export interface MockGoalieGame {
  type: 'goalie';
  date: string;
  opponent: string;
  result: string;
  stats: GoalieGameStats;
}

export type MockPlayerGame = MockSkaterGame | MockGoalieGame;

export interface MockPlayerDetail {
  slotKey: string;
  player: NHLPlayer;
  gameLogs: MockPlayerGame[];
}

export interface MockRosterDisplayPlayer extends NHLPlayer {
  cycleScore: PlayerCycleScore;
}

function mockTeamLogo(teamAbbreviation: string): string {
  return `https://assets.nhle.com/logos/nhl/svg/${teamAbbreviation}_light.svg`;
}

function createPlayer(
  id: number,
  fullName: string,
  position: NHLPlayer['position'],
  team: string
): NHLPlayer {
  return {
    id,
    fullName,
    position,
    nhlTeamAbbreviation: team,
    teamLogoUrl: mockTeamLogo(team)
  };
}

function skaterStats(
  position: 'F' | 'D',
  overrides: Partial<SkaterGameStats>
): SkaterGameStats {
  return {
    position,
    goals: 0,
    primaryAssists: 0,
    secondaryAssists: 0,
    shotsOnGoal: 0,
    hits: 0,
    blockedShots: 0,
    plusMinus: 0,
    powerPlayPoints: 0,
    shortHandedPoints: 0,
    gameWinningGoal: false,
    overtimeGoal: false,
    timeOnIceMinutes: 0,
    ...overrides
  };
}

function goalieStats(
  overrides: Partial<GoalieGameStats>
): GoalieGameStats {
  return {
    saves: 0,
    shotsAgainst: 0,
    won: false,
    shutout: false,
    ...overrides
  };
}

export const MOCK_PLAYER_DETAILS: Record<number, MockPlayerDetail> = {
  101: {
    slotKey: 'LW-1',
    player: createPlayer(101, 'Test Left Wing', 'LW', 'VGK'),
    gameLogs: [
      {
        type: 'skater',
        date: 'Oct 8',
        opponent: 'vs ANA',
        result: 'W 4–2',
        stats: skaterStats('F', {
          goals: 1,
          primaryAssists: 1,
          shotsOnGoal: 4,
          hits: 1,
          timeOnIceMinutes: 18.5
        })
      },
      {
        type: 'skater',
        date: 'Oct 10',
        opponent: '@ LAK',
        result: 'L 3–2',
        stats: skaterStats('F', {
          secondaryAssists: 1,
          shotsOnGoal: 3,
          hits: 2,
          timeOnIceMinutes: 17.2
        })
      },
      {
        type: 'skater',
        date: 'Oct 12',
        opponent: 'vs DAL',
        result: 'W 5–3',
        stats: skaterStats('F', {
          goals: 1,
          shotsOnGoal: 5,
          powerPlayPoints: 1,
          timeOnIceMinutes: 19.1
        })
      }
    ]
  },

  102: {
    slotKey: 'C-1',
    player: createPlayer(102, 'Test Center', 'C', 'EDM'),
    gameLogs: [
      {
        type: 'skater',
        date: 'Oct 8',
        opponent: 'vs CGY',
        result: 'W 4–1',
        stats: skaterStats('F', {
          goals: 1,
          primaryAssists: 1,
          shotsOnGoal: 6,
          powerPlayPoints: 1,
          timeOnIceMinutes: 21.4
        })
      },
      {
        type: 'skater',
        date: 'Oct 10',
        opponent: '@ VAN',
        result: 'W 3–2',
        stats: skaterStats('F', {
          primaryAssists: 2,
          shotsOnGoal: 4,
          hits: 1,
          timeOnIceMinutes: 20.8
        })
      },
      {
        type: 'skater',
        date: 'Oct 13',
        opponent: 'vs WPG',
        result: 'L 3–2',
        stats: skaterStats('F', {
          goals: 1,
          shotsOnGoal: 5,
          timeOnIceMinutes: 22.1
        })
      }
    ]
  },

  103: {
    slotKey: 'RW-1',
    player: createPlayer(103, 'Test Right Wing', 'RW', 'TBL'),
    gameLogs: [
      {
        type: 'skater',
        date: 'Oct 9',
        opponent: 'vs FLA',
        result: 'W 5–4',
        stats: skaterStats('F', {
          goals: 1,
          secondaryAssists: 1,
          shotsOnGoal: 4,
          timeOnIceMinutes: 18.3
        })
      },
      {
        type: 'skater',
        date: 'Oct 11',
        opponent: '@ BOS',
        result: 'L 3–1',
        stats: skaterStats('F', {
          shotsOnGoal: 3,
          hits: 3,
          timeOnIceMinutes: 17.6
        })
      },
      {
        type: 'skater',
        date: 'Oct 14',
        opponent: 'vs CAR',
        result: 'W 4–0',
        stats: skaterStats('F', {
          goals: 1,
          gameWinningGoal: true,
          shotsOnGoal: 5,
          timeOnIceMinutes: 19.4
        })
      }
    ]
  },

  104: {
    slotKey: 'D-1',
    player: createPlayer(104, 'Test Defenseman', 'D', 'COL'),
    gameLogs: [
      {
        type: 'skater',
        date: 'Oct 7',
        opponent: 'vs NSH',
        result: 'W 3–1',
        stats: skaterStats('D', {
          primaryAssists: 1,
          shotsOnGoal: 2,
          blockedShots: 4,
          plusMinus: 2,
          timeOnIceMinutes: 24.3
        })
      },
      {
        type: 'skater',
        date: 'Oct 10',
        opponent: '@ MIN',
        result: 'W 4–3',
        stats: skaterStats('D', {
          shotsOnGoal: 3,
          hits: 2,
          blockedShots: 3,
          plusMinus: 1,
          timeOnIceMinutes: 25.1
        })
      },
      {
        type: 'skater',
        date: 'Oct 12',
        opponent: 'vs DAL',
        result: 'L 2–1',
        stats: skaterStats('D', {
          secondaryAssists: 1,
          blockedShots: 5,
          plusMinus: -1,
          timeOnIceMinutes: 23.5
        })
      }
    ]
  },

  105: {
    slotKey: 'G-1',
    player: createPlayer(105, 'Test Goalie', 'G', 'WPG'),
    gameLogs: [
      {
        type: 'goalie',
        date: 'Oct 8',
        opponent: 'vs MTL',
        result: 'W 4–2',
        stats: goalieStats({
          saves: 31,
          shotsAgainst: 33,
          won: true
        })
      },
      {
        type: 'goalie',
        date: 'Oct 11',
        opponent: '@ TOR',
        result: 'L 3–2',
        stats: goalieStats({
          saves: 28,
          shotsAgainst: 31
        })
      },
      {
        type: 'goalie',
        date: 'Oct 14',
        opponent: 'vs OTT',
        result: 'W 3–0',
        stats: goalieStats({
          saves: 24,
          shotsAgainst: 24,
          won: true,
          shutout: true
        })
      }
    ]
  }
};

export function getMockPlayerDetail(playerId: number): MockPlayerDetail | null {
  return MOCK_PLAYER_DETAILS[playerId] ?? null;
}

export function getMockRosterDisplayPlayers(): Record<
  string,
  MockRosterDisplayPlayer
> {
  const rosterPlayers: Record<string, MockRosterDisplayPlayer> = {};

  for (const detail of Object.values(MOCK_PLAYER_DETAILS)) {
    const fantasyPoints = detail.gameLogs.reduce((total, game) => {
      const gamePoints =
        game.type === 'skater'
          ? calculateSkaterGamePoints(game.stats, defaultScoringRules)
          : calculateGoalieGamePoints(game.stats, defaultScoringRules);

      return total + gamePoints;
    }, 0);

    rosterPlayers[detail.slotKey] = {
      ...detail.player,
      cycleScore: {
        playerId: detail.player.id,
        cycleNumber: 1,
        gamesCounted: detail.gameLogs.length,
        fantasyPoints: Number(fantasyPoints.toFixed(2))
      }
    };
  }

  return rosterPlayers;
}