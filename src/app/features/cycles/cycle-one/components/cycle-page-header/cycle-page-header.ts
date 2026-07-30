import { Component, Input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { CycleOne } from '../../cycle-one';

@Component({
  selector: 'app-cycle-page-header',
  imports: [RouterLink],
  templateUrl: './cycle-page-header.html',
  styles: [':host { display: contents; }'],
})
export class CyclePageHeader {
  @Input({ required: true }) presenter!: CycleOne;
}
