import { NgStyle } from '@angular/common';
import { Component, Input } from '@angular/core';

import type { FantasyMatchup } from '../../../../../core/cycle/cycle.models';
import { ManagerAvatar } from '../../../../../shared/manager-avatar/manager-avatar';
import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-matchup-team-panel',
  imports: [NgStyle, ManagerAvatar],
  templateUrl: './cycle-matchup-team-panel.html',
  styles: [':host { display: contents; }'],
})
export class CycleMatchupTeamPanel {
  @Input({ required: true }) matchup!: FantasyMatchup;
  @Input({ required: true }) ownerId!: string | null;
  @Input({ required: true }) presenter!: CycleOne;
}
