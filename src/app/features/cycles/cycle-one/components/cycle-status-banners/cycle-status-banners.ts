import { Component, Input } from '@angular/core';

import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-status-banners',
  templateUrl: './cycle-status-banners.html',
  styles: [':host { display: contents; }'],
})
export class CycleStatusBanners {
  @Input({ required: true }) presenter!: CycleOne;
}
