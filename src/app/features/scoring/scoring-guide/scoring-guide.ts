import { Component, computed, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { getLeagueById } from '../../../core/league/league.service';
import {
  calculateGoalieGameBreakdown,
  calculateGoalieSaveQualityPoints,
  calculateSkaterGameBreakdown,
  GamePointBreakdown,
} from '../../../core/scoring/scoring-engine';
import {
  CURRENT_SCORING_RULES_VERSION,
  defaultScoringRules,
  DiminishingReturnValues,
  ScoringRules,
} from '../../../core/scoring/scoring-rules';
import { TelemetryService } from '../../../core/observability/telemetry.service';

interface ScoringRow {
  label: string;
  value: string;
  note?: string;
}

interface SaveQualityExample {
  percentage: string;
  points: string;
}

@Component({
  selector: 'app-scoring-guide',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './scoring-guide.html',
  styleUrl: './scoring-guide.css',
})
export class ScoringGuide {
  readonly rules = signal<ScoringRules>(defaultScoringRules);
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly leagueId = signal('');
  readonly leagueName = signal('');
  readonly scoringRulesVersion = signal(CURRENT_SCORING_RULES_VERSION);

  readonly pageTitle = computed(() =>
    this.leagueName()
      ? `${this.leagueName()} Scoring Guide`
      : 'RinkRat Scoring Guide',
  );

  readonly pageSubtitle = computed(() =>
    this.leagueName()
      ? 'These are the exact scoring rules saved to this league.'
      : 'These are the current standard rules used when a new RinkRat league is created.',
  );

  readonly cycleGameCount = computed(() => this.rules().requiredGamesPerCycle);
  readonly goalieCycleMaximum = computed(
    () => this.rules().goalieGameMaximum * this.rules().requiredGamesPerCycle,
  );

  readonly forwardRows = computed<ScoringRow[]>(() => {
    const rules = this.rules().forward;

    return [
      diminishingRow('Goals', rules.goal),
      diminishingRow('Primary assists', rules.primaryAssist),
      diminishingRow('Secondary assists', rules.secondaryAssist),
      perStatRow('Shot on goal', rules.shotOnGoal, 'Each official shot on goal'),
      perStatRow('Hit', rules.hit, 'Each official credited hit'),
      perStatRow('Blocked shot', rules.blockedShot, 'Each official blocked shot'),
      bonusRow('Power-play point', rules.powerPlayPoint, 'Added on top of the goal or assist points'),
      bonusRow('Short-handed point', rules.shortHandedPoint, 'Added on top of the goal or assist points'),
      perStatRow('Time on ice', this.rules().forwardToiMultiplier, 'For every minute played'),
    ];
  });

  readonly defenseRows = computed<ScoringRow[]>(() => {
    const rules = this.rules().defense;

    return [
      diminishingRow('Goals', rules.goal),
      diminishingRow('Primary assists', rules.primaryAssist),
      diminishingRow('Secondary assists', rules.secondaryAssist),
      perStatRow('Shot on goal', rules.shotOnGoal, 'Each official shot on goal'),
      perStatRow('Hit', rules.hit, 'Each official credited hit'),
      perStatRow('Blocked shot', rules.blockedShot, 'Each official blocked shot'),
      bonusRow('Power-play point', rules.powerPlayPoint, 'Added on top of the goal or assist points'),
      bonusRow('Short-handed point', rules.shortHandedPoint, 'Added on top of the goal or assist points'),
      {
        label: 'Time on ice',
        value: `${formatPoints(this.rules().defenseToiFloor)}–${formatPoints(this.rules().defenseToiCeiling)} pts/min`,
        note: `Starts at ${formatPoints(this.rules().defenseToiBaseMultiplier)} per minute. Each +/− point changes the multiplier by ${formatPoints(this.rules().defenseToiPlusMinusModifier)}, within the displayed range.`,
      },
    ];
  });

  readonly goalieRows = computed<ScoringRow[]>(() => [
    perStatRow('Completed NHL team game', this.rules().goalieGameBase, 'Participation base for the team goalie unit'),
    perStatRow('Save', this.rules().goalieSave, 'Every official save made by the team goalie unit'),
    {
      label: 'Save quality',
      value: `${signedPoints(this.rules().goalieSavePercentageMinimum)} to +${formatPoints(this.rules().goalieSavePercentageMaximum)} pts`,
      note: `Starts at ${formatPoints(this.rules().goalieSavePercentageBasePoints)} points at ${(this.rules().goalieSavePercentageBaseline * 100).toFixed(1)} SV%. Each percentage point above or below that baseline changes the score by ${formatPoints(this.rules().goalieSavePercentagePointsPerPercentagePoint)}.`,
    },
    bonusRow('Win', this.rules().goalieWin, 'Awarded when the NHL team wins the game'),
    bonusRow('Shutout', this.rules().goalieShutout, 'Stacks with the win and all other goalie scoring'),
    {
      label: 'Maximum per NHL game',
      value: `${formatPoints(this.rules().goalieGameMaximum)} pts`,
      note: `The team goalie unit cannot score more than this in one game. Across ${this.rules().requiredGamesPerCycle} games, the absolute ceiling is ${formatPoints(this.rules().goalieGameMaximum * this.rules().requiredGamesPerCycle)}.`,
    },
  ]);

  readonly commonBonusRows = computed<ScoringRow[]>(() => [
    bonusRow('Game-winning goal', this.rules().gameWinningGoal, 'Stacks with the goal and any special-teams points'),
    bonusRow('Overtime goal', this.rules().overtimeGoal, 'Stacks with the goal and game-winning-goal bonus when both apply'),
  ]);

  readonly saveQualityExamples = computed<SaveQualityExample[]>(() =>
    [0.85, 0.88, 0.9, 0.91, 0.92, 0.93, 0.95].map((percentage) => ({
      percentage: percentage.toFixed(3),
      points: signedPoints(calculateGoalieSaveQualityPoints(percentage, this.rules())),
    })),
  );

  readonly forwardExample = computed<GamePointBreakdown>(() =>
    calculateSkaterGameBreakdown(
      {
        position: 'F',
        goals: 2,
        primaryAssists: 1,
        secondaryAssists: 0,
        shotsOnGoal: 4,
        hits: 2,
        blockedShots: 0,
        plusMinus: 1,
        powerPlayPoints: 1,
        shortHandedPoints: 0,
        gameWinningGoal: true,
        overtimeGoal: false,
        timeOnIceMinutes: 18,
      },
      this.rules(),
    ),
  );

  readonly defenseExample = computed<GamePointBreakdown>(() =>
    calculateSkaterGameBreakdown(
      {
        position: 'D',
        goals: 1,
        primaryAssists: 1,
        secondaryAssists: 0,
        shotsOnGoal: 2,
        hits: 2,
        blockedShots: 3,
        plusMinus: 1,
        powerPlayPoints: 1,
        shortHandedPoints: 0,
        gameWinningGoal: false,
        overtimeGoal: false,
        timeOnIceMinutes: 23,
      },
      this.rules(),
    ),
  );

  readonly goalieExample = computed<GamePointBreakdown>(() =>
    calculateGoalieGameBreakdown(
      {
        saves: 30,
        shotsAgainst: 32,
        won: true,
        shutout: false,
      },
      this.rules(),
    ),
  );

  constructor(
    private readonly route: ActivatedRoute,
    private readonly telemetry: TelemetryService,
  ) {
    this.telemetry.track('scoring_guide_opened', {
      source: this.route.snapshot.paramMap.has('leagueId') ? 'league' : 'global',
    });

    void this.loadLeagueRules();
  }

  printGuide(): void {
    window.print();
  }

  formatPoints(value: number): string {
    return formatPoints(value);
  }

  signedPoints(value: number): string {
    return signedPoints(value);
  }

  private async loadLeagueRules(): Promise<void> {
    const leagueId = this.route.snapshot.paramMap.get('leagueId')?.trim() ?? '';

    if (!leagueId) {
      return;
    }

    this.leagueId.set(leagueId);
    this.loading.set(true);
    this.errorMessage.set('');

    try {
      const league = await getLeagueById(leagueId);

      if (!league) {
        this.errorMessage.set('This league could not be found. Standard RinkRat rules are shown instead.');
        return;
      }

      this.leagueName.set(league.name);
      this.rules.set(league.scoringRules ?? defaultScoringRules);
      this.scoringRulesVersion.set(league.scoringRulesVersion ?? CURRENT_SCORING_RULES_VERSION);
    } catch (error) {
      console.error('Unable to load league scoring rules.', error);
      this.errorMessage.set('League-specific scoring could not be loaded. Standard RinkRat rules are shown instead.');
    } finally {
      this.loading.set(false);
    }
  }
}

function diminishingRow(label: string, values: DiminishingReturnValues): ScoringRow {
  return {
    label,
    value: `${formatPoints(values.first)} / ${formatPoints(values.second)} / ${formatPoints(values.additional)}`,
    note: 'First in the game / second in the same game / each additional in that game',
  };
}

function perStatRow(label: string, points: number, note?: string): ScoringRow {
  return {
    label,
    value: `${signedPoints(points)} pts each`,
    note,
  };
}

function bonusRow(label: string, points: number, note?: string): ScoringRow {
  return {
    label,
    value: `${signedPoints(points)} pts`,
    note,
  };
}

function formatPoints(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function signedPoints(value: number): string {
  const formatted = formatPoints(value);
  return value > 0 ? `+${formatted}` : formatted;
}
