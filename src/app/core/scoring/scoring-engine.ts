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

export interface PointBreakdownLine {
  label: string;
  points: number;
}

export interface GamePointBreakdown {
  total: number;
  lines: PointBreakdownLine[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function getGoalieSavePercentagePoints(
  savePercentage: number,
  tiers: GoalieSavePercentageTier[]
): number {
  const matchingTier = tiers.find(
    (tier) => savePercentage >= tier.minSavePercentage
  );

  return matchingTier?.points ?? 0;
}

export function calculateSkaterGameBreakdown(
  stats: SkaterGameStats,
  rules: ScoringRules
): GamePointBreakdown {
  const lines: PointBreakdownLine[] = [];
  let total = 0;

  function addLine(label: string, points: number) {
    if (points === 0) {
      return;
    }

    const roundedPoints = rounded(points);

    lines.push({
      label,
      points: roundedPoints
    });

    total += roundedPoints;
  }

  addLine(
    `Goals (${stats.goals})`,
    stats.goals * rules.goal
  );

  addLine(
    `Primary Assists (${stats.primaryAssists})`,
    stats.primaryAssists * rules.primaryAssist
  );

  addLine(
    `Secondary Assists (${stats.secondaryAssists})`,
    stats.secondaryAssists * rules.secondaryAssist
  );

  addLine(
    `Shots on Goal (${stats.shotsOnGoal})`,
    stats.shotsOnGoal * rules.shotOnGoal
  );

  addLine(
    `Hits (${stats.hits})`,
    stats.hits * rules.hit
  );

  addLine(
    `Blocked Shots (${stats.blockedShots})`,
    stats.blockedShots * rules.blockedShot
  );

  addLine(
    `Power-Play Points (${stats.powerPlayPoints})`,
    stats.powerPlayPoints * rules.powerPlayPoint
  );

  addLine(
    `Short-Handed Points (${stats.shortHandedPoints})`,
    stats.shortHandedPoints * rules.shortHandedPoint
  );

  if (stats.gameWinningGoal) {
    addLine('Game-Winning Goal', rules.gameWinningGoal);
  }

  if (stats.overtimeGoal) {
    addLine('Overtime Goal', rules.overtimeGoal);
  }

  if (stats.goals >= 3) {
    addLine('Hat Trick Bonus', rules.hatTrickBonus);
  } else if (stats.goals === 2) {
    addLine('Two-Goal Game Bonus', rules.twoGoalGameBonus);
  }

  if (stats.position === 'D') {
    const toiMultiplier = clamp(
      rules.defenseToiBaseMultiplier +
        stats.plusMinus * rules.defenseToiPlusMinusModifier,
      rules.defenseToiFloor,
      rules.defenseToiCeiling
    );

    addLine(
      `Time on Ice (${stats.timeOnIceMinutes} min × ${toiMultiplier.toFixed(2)})`,
      stats.timeOnIceMinutes * toiMultiplier
    );
  } else {
    addLine(
      `Time on Ice (${stats.timeOnIceMinutes} min × ${rules.forwardToiMultiplier.toFixed(2)})`,
      stats.timeOnIceMinutes * rules.forwardToiMultiplier
    );
  }

  return {
    total: rounded(total),
    lines
  };
}

export function calculateGoalieGameBreakdown(
  stats: GoalieGameStats,
  rules: ScoringRules
): GamePointBreakdown {
  const lines: PointBreakdownLine[] = [];
  let total = 0;

  function addLine(label: string, points: number) {
    if (points === 0) {
      return;
    }

    const roundedPoints = rounded(points);

    lines.push({
      label,
      points: roundedPoints
    });

    total += roundedPoints;
  }

  const savePercentage =
    stats.shotsAgainst > 0
      ? stats.saves / stats.shotsAgainst
      : 0;

  addLine(
    `Saves (${stats.saves})`,
    stats.saves * rules.goalieSave
  );

  addLine(
    `Save Percentage (${(savePercentage * 100).toFixed(1)}%)`,
    getGoalieSavePercentagePoints(
      savePercentage,
      rules.goalieSavePercentageTiers
    )
  );

  if (stats.won) {
    addLine('Win', rules.goalieWin);
  }

  if (stats.shutout) {
    addLine('Shutout', rules.goalieShutout);
  }

  return {
    total: rounded(total),
    lines
  };
}

export function calculateSkaterGamePoints(
  stats: SkaterGameStats,
  rules: ScoringRules
): number {
  return calculateSkaterGameBreakdown(stats, rules).total;
}

export function calculateGoalieGamePoints(
  stats: GoalieGameStats,
  rules: ScoringRules
): number {
  return calculateGoalieGameBreakdown(stats, rules).total;
}