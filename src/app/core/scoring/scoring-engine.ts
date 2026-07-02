import { GoalieSavePercentageTier, ScoringRules } from './scoring-rules';

export interface SkaterGameStats {
  position: 'F' | 'D';
  goals: number;
  primaryAssists: number;
  secondaryAssists: number;
  shotsOnGoal: number;
  hits: number;
  blockedShots: number;
  plusMinus: number;
  powerPlayPoints: number;
  shortHandedPoints: number;
  gameWinningGoal: boolean;
  overtimeGoal: boolean;
  timeOnIceMinutes: number;
}

export interface GoalieGameStats {
  saves: number;
  shotsAgainst: number;
  won: boolean;
  shutout: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getGoalieSavePercentagePoints(
  savePercentage: number,
  tiers: GoalieSavePercentageTier[]
): number {
  const tier = tiers.find(tier => savePercentage >= tier.minSavePercentage);
  return tier?.points ?? 0;
}

export function calculateSkaterGamePoints(
  stats: SkaterGameStats,
  rules: ScoringRules
): number {
  let points = 0;

  points += stats.goals * rules.goal;
  points += stats.primaryAssists * rules.primaryAssist;
  points += stats.secondaryAssists * rules.secondaryAssist;
  points += stats.shotsOnGoal * rules.shotOnGoal;
  points += stats.hits * rules.hit;
  points += stats.blockedShots * rules.blockedShot;
  points += stats.powerPlayPoints * rules.powerPlayPoint;
  points += stats.shortHandedPoints * rules.shortHandedPoint;

  if (stats.gameWinningGoal) points += rules.gameWinningGoal;
  if (stats.overtimeGoal) points += rules.overtimeGoal;

  if (stats.goals >= 3) {
    points += rules.hatTrickBonus;
  } else if (stats.goals === 2) {
    points += rules.twoGoalGameBonus;
  }

  if (stats.position === 'D') {
    const multiplier = clamp(
      rules.defenseToiBaseMultiplier + stats.plusMinus * rules.defenseToiPlusMinusModifier,
      rules.defenseToiFloor,
      rules.defenseToiCeiling
    );

    points += stats.timeOnIceMinutes * multiplier;
  } else {
    points += stats.timeOnIceMinutes * rules.forwardToiMultiplier;
  }

  return Number(points.toFixed(2));
}

export function calculateGoalieGamePoints(
  stats: GoalieGameStats,
  rules: ScoringRules
): number {
  const savePercentage =
    stats.shotsAgainst > 0 ? stats.saves / stats.shotsAgainst : 0;

  let points = 0;

  points += getGoalieSavePercentagePoints(
    savePercentage,
    rules.goalieSavePercentageTiers
  );

  points += stats.saves * rules.goalieSave;

  if (stats.won) points += rules.goalieWin;
  if (stats.shutout) points += rules.goalieShutout;

  return Number(points.toFixed(2));
}