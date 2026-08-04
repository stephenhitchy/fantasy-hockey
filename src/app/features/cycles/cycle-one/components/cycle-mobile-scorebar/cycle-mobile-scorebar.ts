import { NgStyle } from '@angular/common';
import { Component, Input } from '@angular/core';

import type { FantasyMatchup } from '../../../../../core/cycle/cycle.models';
import { ManagerAvatar } from '../../../../../shared/manager-avatar/manager-avatar';
import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-mobile-scorebar',
  imports: [NgStyle, ManagerAvatar],
  templateUrl: './cycle-mobile-scorebar.html',
  styles: [
    ':host { display: contents; }',
    '.mobile-score-finish { margin-top: 3px; color: #b9d6ef !important; }',
  ],
})
export class CycleMobileScorebar {
  @Input({ required: true }) mobileMatchup!: FantasyMatchup;
  @Input({ required: true }) presenter!: CycleOne;
}
