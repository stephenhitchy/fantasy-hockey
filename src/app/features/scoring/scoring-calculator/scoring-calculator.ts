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
import { CURRENT_SCORING_RULES_VERSION } from '../../../core/scoring/scoring-rules';

@Component({
  selector: 'app-scoring-calculator',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './scoring-calculator.html',
  styleUrl: './scoring-calculator.css',
})
export class ScoringCalculator {
  readonly scoringRulesVersion = CURRENT_SCORING_RULES_VERSION;
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
      ? calculatePublicGoalieScore(this.goalieInput())
      : calculatePublicSkaterScore(mode, this.skaterInput());
  });

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
