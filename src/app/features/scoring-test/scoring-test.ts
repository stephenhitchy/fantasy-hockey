import { Component } from '@angular/core';
import { defaultScoringRules } from '../../core/scoring/scoring-rules';
import {
  calculateGoalieGamePoints,
  calculateSkaterGamePoints,
  GoalieGameStats,
  SkaterGameStats
} from '../../core/scoring/scoring-engine';

interface ScoringTestCase {
  name: string;
  type: 'skater' | 'goalie';
  description: string;
  points: number;
}

@Component({
  selector: 'app-scoring-test',
  imports: [],
  templateUrl: './scoring-test.html',
  styleUrl: './scoring-test.css'
})
export class ScoringTest {
  testCases: ScoringTestCase[] = [
    this.createSkaterTest('Connor McDavid', 'Superstar forward game', {
      position: 'F',
      goals: 1,
      primaryAssists: 2,
      secondaryAssists: 0,
      shotsOnGoal: 6,
      hits: 0,
      blockedShots: 0,
      plusMinus: 1,
      powerPlayPoints: 2,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceMinutes: 22
    }),
    this.createSkaterTest('Zach Werenski', 'High-TOI defenseman game', {
      position: 'D',
      goals: 0,
      primaryAssists: 1,
      secondaryAssists: 1,
      shotsOnGoal: 3,
      hits: 1,
      blockedShots: 4,
      plusMinus: 1,
      powerPlayPoints: 1,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceMinutes: 26
    }),
    this.createSkaterTest('Brandon Tanev', 'Useful grinder game', {
      position: 'F',
      goals: 0,
      primaryAssists: 0,
      secondaryAssists: 0,
      shotsOnGoal: 2,
      hits: 5,
      blockedShots: 1,
      plusMinus: 0,
      powerPlayPoints: 0,
      shortHandedPoints: 0,
      gameWinningGoal: false,
      overtimeGoal: false,
      timeOnIceMinutes: 14
    }),
    this.createGoalieTest('Connor Hellebuyck', 'Elite goalie win', {
      saves: 34,
      shotsAgainst: 36,
      won: true,
      shutout: false
    }),
    this.createGoalieTest('Average Goalie', 'Average starter win', {
      saves: 27,
      shotsAgainst: 30,
      won: true,
      shutout: false
    }),
    this.createGoalieTest('Bad Goalie Game', 'Rough goalie loss', {
      saves: 20,
      shotsAgainst: 25,
      won: false,
      shutout: false
    })
  ];

  private createSkaterTest(
    name: string,
    description: string,
    stats: SkaterGameStats
  ): ScoringTestCase {
    return {
      name,
      type: 'skater',
      description,
      points: calculateSkaterGamePoints(stats, defaultScoringRules)
    };
  }

  private createGoalieTest(
    name: string,
    description: string,
    stats: GoalieGameStats
  ): ScoringTestCase {
    return {
      name,
      type: 'goalie',
      description,
      points: calculateGoalieGamePoints(stats, defaultScoringRules)
    };
  }
}