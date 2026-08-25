import { Component, Input } from '@angular/core';

import { LeagueQuickNavigation } from '../../../../../shared/league-quick-navigation/league-quick-navigation';
import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-page-header',
  imports: [LeagueQuickNavigation],
  templateUrl: './cycle-page-header.html',
  styles: [':host { display: contents; }'],
})
export class CyclePageHeader {
  @Input({ required: true }) presenter!: CycleOne;
}
