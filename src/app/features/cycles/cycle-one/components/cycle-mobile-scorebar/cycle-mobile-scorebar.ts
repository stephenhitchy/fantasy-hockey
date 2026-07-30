import { NgStyle } from '@angular/common';
import { Component, Input } from '@angular/core';

import type { FantasyMatchup } from '../../../../../core/cycle/cycle.models';
import { ManagerAvatar } from '../../../../../shared/manager-avatar/manager-avatar';
import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-mobile-scorebar',
  imports: [NgStyle, ManagerAvatar],
  templateUrl: './cycle-mobile-scorebar.html',
  styleUrl: './cycle-mobile-scorebar.css',
})
export class CycleMobileScorebar {
  @Input({ required: true }) mobileMatchup!: FantasyMatchup;
  @Input({ required: true }) presenter!: CycleOne;
}
