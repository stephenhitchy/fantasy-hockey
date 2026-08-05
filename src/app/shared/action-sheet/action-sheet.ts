import {
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';

import { DialogFocusTrapDirective } from '../accessibility/dialog-focus-trap.directive';
import { ViewportOverlayPortalDirective } from '../accessibility/viewport-overlay-portal.directive';

@Component({
  selector: 'app-action-sheet',
  imports: [DialogFocusTrapDirective, ViewportOverlayPortalDirective],
  templateUrl: './action-sheet.html',
  styleUrl: './action-sheet.css',
})
export class ActionSheet {
  @Input({ required: true }) open = false;
  @Input({ required: true }) title = '';
  @Input() eyebrow = '';
  @Input() description = '';
  @Input() closeLabel = 'Close';
  @Input() dialogId = 'rr-action-sheet-title';
  @Input() busy = false;
  @Input() wide = false;
  @Input() scrollChrome = false;

  @Output() close = new EventEmitter<void>();

  requestClose(): void {
    if (this.busy) {
      return;
    }

    this.close.emit();
  }
}
