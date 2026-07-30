import { NgStyle } from '@angular/common';
import { Component, Input } from '@angular/core';

import type { FantasyMatchup } from '../../../../../core/cycle/cycle.models';
import { ManagerAvatar } from '../../../../../shared/manager-avatar/manager-avatar';
import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-mobile-head-to-head',
  imports: [NgStyle, ManagerAvatar],
  templateUrl: './cycle-mobile-head-to-head.html',
  styles: [':host { display: contents; }'],
})
export class CycleMobileHeadToHead {
  @Input({ required: true }) matchup!: FantasyMatchup;
  @Input({ required: true }) presenter!: CycleOne;
}
