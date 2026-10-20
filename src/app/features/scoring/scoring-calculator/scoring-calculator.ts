import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  calculatePublicGoalieScore,
  calculatePublicSkaterScore,
  DEFAULT_PUBLIC_GOALIE_INPUT,
  DEFAULT_PUBLIC_SKATER_INPUT,
  DEFENSE_SCORING_PRESETS,
  formatPublicCalculatorPoints,
  FORWARD_SCORING_PRESETS,
  GOALIE_SCORING_PRESETS,
  type PublicGoalieCalculatorInput,
  type PublicScoringCalculatorMode,
  type PublicScoringCalculatorPreset,
  type PublicSkaterCalculatorInput,
} from '../../../core/scoring/public-scoring-calculator.util';
import {
  SCORING_RULES_V4_VERSION,
  SCORING_RULES_V5_VERSION,
  scoringRulesV4,
  scoringRulesV5,
} from '../../../core/scoring/scoring-rules';

type CalculatorScoringRulesVersion =
  | typeof SCORING_RULES_V4_VERSION
  | typeof SCORING_RULES_V5_VERSION;

@Component({
  selector: 'app-scoring-calculator',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './scoring-calculator.html',
  styleUrl: './scoring-calculator.css',
})
export class ScoringCalculator {
  readonly scoringRulesVersion = signal<CalculatorScoringRulesVersion>(
    SCORING_RULES_V4_VERSION,
  );
  readonly scoringRules = computed(() =>
    this.scoringRulesVersion() === SCORING_RULES_V5_VERSION
      ? scoringRulesV5
      : scoringRulesV4,
  );
  readonly scoringVersionLabel = computed(() =>
    this.scoringRulesVersion() === SCORING_RULES_V5_VERSION
      ? 'Opt-in Scoring V5'
      : 'Production Scoring V4',
  );
  readonly shootoutScoringEnabled = computed(() =>
    this.scoringRulesVersion() === SCORING_RULES_V5_VERSION,
  );
  readonly mode = signal<PublicScoringCalculatorMode>('forward');
  readonly skaterInput = signal<PublicSkaterCalculatorInput>({ ...DEFAULT_PUBLIC_SKATER_INPUT });
  readonly goalieInput = signal<PublicGoalieCalculatorInput>({ ...DEFAULT_PUBLIC_GOALIE_INPUT });

  readonly currentPresets = computed(() => {
    if (this.mode() === 'goalie') return GOALIE_SCORING_PRESETS;
    return this.mode() === 'defense' ? DEFENSE_SCORING_PRESETS : FORWARD_SCORING_PRESETS;
  });

  readonly result = computed(() => {
    const mode = this.mode();
    return mode === 'goalie'
      ? calculatePublicGoalieScore(this.goalieInput(), this.scoringRules())
      : calculatePublicSkaterScore(mode, this.skaterInput(), this.scoringRules());
  });

  selectScoringVersion(version: CalculatorScoringRulesVersion): void {
    this.scoringRulesVersion.set(version);

    if (version === SCORING_RULES_V4_VERSION) {
      this.skaterInput.update((current) => ({ ...current, shootoutGoals: 0 }));
      this.goalieInput.update((current) => ({ ...current, shootoutGoalsAgainst: 0 }));
    }
  }

  selectMode(mode: PublicScoringCalculatorMode): void {
    this.mode.set(mode);
    if (mode === 'goalie') {
      this.goalieInput.set({ ...DEFAULT_PUBLIC_GOALIE_INPUT });
      return;
    }

    this.skaterInput.set({ ...DEFAULT_PUBLIC_SKATER_INPUT });
  }

  updateSkater<K extends keyof PublicSkaterCalculatorInput>(key: K, value: PublicSkaterCalculatorInput[K]): void {
    this.skaterInput.update((current) => ({ ...current, [key]: value }));
  }

  updateGoalie<K extends keyof PublicGoalieCalculatorInput>(key: K, value: PublicGoalieCalculatorInput[K]): void {
    this.goalieInput.update((current) => ({ ...current, [key]: value }));
  }

  setOvertimeGoal(enabled: boolean): void {
    this.skaterInput.update((current) => ({
      ...current,
      overtimeGoal: enabled,
      gameWinningGoal: enabled ? true : current.gameWinningGoal,
    }));
  }

  applyPreset(preset: PublicScoringCalculatorPreset<PublicSkaterCalculatorInput | PublicGoalieCalculatorInput>): void {
    if (this.mode() === 'goalie') {
      this.goalieInput.set({ ...(preset.input as PublicGoalieCalculatorInput) });
      return;
    }

    this.skaterInput.set({ ...(preset.input as PublicSkaterCalculatorInput) });
  }

  reset(): void {
    if (this.mode() === 'goalie') {
      this.goalieInput.set({ ...DEFAULT_PUBLIC_GOALIE_INPUT });
    } else {
      this.skaterInput.set({ ...DEFAULT_PUBLIC_SKATER_INPUT });
    }
  }

  formatPoints(value: number, signed = false): string {
    return formatPublicCalculatorPoints(value, signed);
  }

  savePercentageLabel(): string {
    const savePercentage = this.result().savePercentage;
    return savePercentage === null ? '—' : savePercentage.toFixed(3).replace(/^0/, '');
  }
}
