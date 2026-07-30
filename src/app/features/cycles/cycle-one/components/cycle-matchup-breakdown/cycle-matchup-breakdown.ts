import { Component, Input } from '@angular/core';

import type { FantasyMatchup } from '../../../../../core/cycle/cycle.models';
import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-matchup-breakdown',
  templateUrl: './cycle-matchup-breakdown.html',
  styles: [':host { display: contents; }'],
})
export class CycleMatchupBreakdown {
  @Input({ required: true }) matchup!: FantasyMatchup;
  @Input({ required: true }) presenter!: CycleOne;
}
