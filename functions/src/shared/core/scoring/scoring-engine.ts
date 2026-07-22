import {
  DEFAULT_GOALIE_GAME_MAXIMUM,
  DiminishingReturnValues,
  ScoringRules
} from './scoring-rules';

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

function calculateDiminishingPoints(
  count: number,
  values: DiminishingReturnValues
): number {
  if (count <= 0) {
    return 0;
  }

  let points = values.first;

  if (count >= 2) {
    points += values.second;
  }

  if (count >= 3) {
    points += (count - 2) * values.additional;
  }

  return points;
}

function diminishingLabel(
  label: string,
  count: number,
  values: DiminishingReturnValues
): string {
  if (count === 1) {
    return `${label} (1 × ${values.first})`;
  }

  if (count === 2) {
    return `${label} (${values.first} + ${values.second})`;
  }

  return `${label} (${values.first} + ${values.second} + ${count - 2} × ${values.additional})`;
}

export function calculateGoalieSaveQualityPoints(
  savePercentage: number,
  rules: ScoringRules
): number {
  if (!Number.isFinite(savePercentage)) {
    return 0;
  }

  const percentagePointsFromBaseline =
    (savePercentage - rules.goalieSavePercentageBaseline) * 100;

  return rounded(
    clamp(
      rules.goalieSavePercentageBasePoints +
        percentagePointsFromBaseline *
          rules.goalieSavePercentagePointsPerPercentagePoint,
      rules.goalieSavePercentageMinimum,
      rules.goalieSavePercentageMaximum
    )
  );
}

export function calculateSkaterGameBreakdown(
  stats: SkaterGameStats,
  rules: ScoringRules
): GamePointBreakdown {
  const lines: PointBreakdownLine[] = [];
  let total = 0;

  const positionRules =
    stats.position === 'D'
      ? rules.defense
      : rules.forward;

  function addLine(label: string, points: number): void {
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

  const goalPoints = calculateDiminishingPoints(
    stats.goals,
    positionRules.goal
  );

  addLine(
    diminishingLabel('Goals', stats.goals, positionRules.goal),
    goalPoints
  );

  const primaryAssistPoints = calculateDiminishingPoints(
    stats.primaryAssists,
    positionRules.primaryAssist
  );

  addLine(
    diminishingLabel(
      'Primary Assists',
      stats.primaryAssists,
      positionRules.primaryAssist
    ),
    primaryAssistPoints
  );

  const secondaryAssistPoints = calculateDiminishingPoints(
    stats.secondaryAssists,
    positionRules.secondaryAssist
  );

  addLine(
    diminishingLabel(
      'Secondary Assists',
      stats.secondaryAssists,
      positionRules.secondaryAssist
    ),
    secondaryAssistPoints
  );

  addLine(
    `Shots on Goal (${stats.shotsOnGoal})`,
    stats.shotsOnGoal * positionRules.shotOnGoal
  );

  addLine(
    `Hits (${stats.hits})`,
    stats.hits * positionRules.hit
  );

  addLine(
    `Blocked Shots (${stats.blockedShots})`,
    stats.blockedShots * positionRules.blockedShot
  );

  addLine(
    `Power-Play Points (${stats.powerPlayPoints})`,
    stats.powerPlayPoints * positionRules.powerPlayPoint
  );

  addLine(
    `Short-Handed Points (${stats.shortHandedPoints})`,
    stats.shortHandedPoints * positionRules.shortHandedPoint
  );

  if (stats.gameWinningGoal) {
    addLine('Game-Winning Goal', rules.gameWinningGoal);
  }

  if (stats.overtimeGoal) {
    addLine('Overtime Goal', rules.overtimeGoal);
  }

  if (stats.position === 'D') {
    const toiMultiplier = clamp(
      rules.defenseToiBaseMultiplier +
        stats.plusMinus * rules.defenseToiPlusMinusModifier,
      rules.defenseToiFloor,
      rules.defenseToiCeiling
    );

    const plusMinusLabel =
      stats.plusMinus >= 0
        ? `+${stats.plusMinus}`
        : `${stats.plusMinus}`;

    addLine(
      `Defensive TOI (${stats.timeOnIceMinutes} min × ${toiMultiplier.toFixed(2)}; ${plusMinusLabel} +/-)`,
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

  function addLine(label: string, points: number): void {
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

  addLine('Completed Team Game', rules.goalieGameBase);

  addLine(
    `Saves (${stats.saves})`,
    stats.saves * rules.goalieSave
  );

  addLine(
    `Save Quality (${(savePercentage * 100).toFixed(1)}%; ${(rules.goalieSavePercentageBaseline * 100).toFixed(1)}% baseline)`,
    calculateGoalieSaveQualityPoints(savePercentage, rules)
  );

  if (stats.won) {
    addLine('Win', rules.goalieWin);
  }

  if (stats.shutout) {
    addLine('Shutout', rules.goalieShutout);
  }

  const goalieGameMaximum =
    typeof rules.goalieGameMaximum === 'number' &&
    rules.goalieGameMaximum > 0
      ? rules.goalieGameMaximum
      : DEFAULT_GOALIE_GAME_MAXIMUM;

  if (total > goalieGameMaximum) {
    addLine(
      `Goalie Game Maximum (${goalieGameMaximum})`,
      goalieGameMaximum - total
    );
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