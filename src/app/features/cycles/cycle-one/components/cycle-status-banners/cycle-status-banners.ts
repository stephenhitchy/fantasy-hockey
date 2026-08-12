import { Component, Input } from '@angular/core';

import { LiveScoreFreshness } from '../../../../../shared/live-score-freshness/live-score-freshness';
import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-status-banners',
  imports: [LiveScoreFreshness],
  templateUrl: './cycle-status-banners.html',
  styles: [':host { display: contents; }'],
})
export class CycleStatusBanners {
  @Input({ required: true }) presenter!: CycleOne;
}
