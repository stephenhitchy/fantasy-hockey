import { NgStyle } from '@angular/common';
import { Component, Input } from '@angular/core';

import type { FantasyMatchup } from '../../../../../core/cycle/cycle.models';
import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-matchup-overview',
  imports: [NgStyle],
  templateUrl: './cycle-matchup-overview.html',
  styleUrl: './cycle-matchup-overview.css',
})
export class CycleMatchupOverview {
  @Input({ required: true }) matchup!: FantasyMatchup;
  @Input({ required: true }) presenter!: CycleOne;
}
