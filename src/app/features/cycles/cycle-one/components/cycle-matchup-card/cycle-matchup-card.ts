import { Component, Input } from '@angular/core';

import type { FantasyMatchup } from '../../../../../core/cycle/cycle.models';
import type { CycleOne } from '../../cycle-one';
import { CycleMatchupBreakdown } from '../cycle-matchup-breakdown/cycle-matchup-breakdown';
import { CycleMatchupOverview } from '../cycle-matchup-overview/cycle-matchup-overview';
import { CycleMatchupTeamPanel } from '../cycle-matchup-team-panel/cycle-matchup-team-panel';
import { CycleMobileHeadToHead } from '../cycle-mobile-head-to-head/cycle-mobile-head-to-head';

@Component({
  selector: 'app-cycle-matchup-card',
  imports: [
    CycleMatchupOverview,
    CycleMobileHeadToHead,
    CycleMatchupTeamPanel,
    CycleMatchupBreakdown,
  ],
  templateUrl: './cycle-matchup-card.html',
  styles: [':host { display: contents; }'],
})
export class CycleMatchupCard {
  @Input({ required: true }) matchup!: FantasyMatchup;
  @Input({ required: true }) presenter!: CycleOne;
}
