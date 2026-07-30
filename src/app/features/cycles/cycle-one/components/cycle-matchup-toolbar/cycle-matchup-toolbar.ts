import { Component, Input } from '@angular/core';

import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-matchup-toolbar',
  templateUrl: './cycle-matchup-toolbar.html',
  styles: [':host { display: contents; }'],
})
export class CycleMatchupToolbar {
  @Input({ required: true }) presenter!: CycleOne;
}
