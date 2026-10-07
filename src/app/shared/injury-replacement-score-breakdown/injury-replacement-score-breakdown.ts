import { Component, input } from '@angular/core';

import type { InjuryReplacementPresentation } from '../../core/cycle/injury-replacement-presentation.util';

@Component({
  selector: 'app-injury-replacement-score-breakdown',
  standalone: true,
  templateUrl: './injury-replacement-score-breakdown.html',
  styleUrl: './injury-replacement-score-breakdown.css',
})
export class InjuryReplacementScoreBreakdown {
  readonly presentation = input<InjuryReplacementPresentation | null>(null);
  readonly compact = input(false);
  readonly showTotal = input(true);
}
