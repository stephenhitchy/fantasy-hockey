import { Component, Input } from '@angular/core';

import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-matchup-finish-card',
  templateUrl: './cycle-matchup-finish-card.html',
  styleUrl: './cycle-matchup-finish-card.css',
})
export class CycleMatchupFinishCard {
  @Input({ required: true }) presenter!: CycleOne;
}
