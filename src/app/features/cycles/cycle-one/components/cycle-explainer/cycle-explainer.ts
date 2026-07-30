import { Component, Input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-explainer',
  imports: [RouterLink],
  templateUrl: './cycle-explainer.html',
  styles: [':host { display: contents; }'],
})
export class CycleExplainer {
  @Input({ required: true }) presenter!: CycleOne;
}
