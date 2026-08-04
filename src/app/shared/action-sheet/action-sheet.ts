import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
} from '@angular/core';

import { DialogFocusTrapDirective } from '../accessibility/dialog-focus-trap.directive';

let actionSheetBodyLockCount = 0;
let actionSheetPreviousBodyOverflow = '';

@Component({
  selector: 'app-action-sheet',
  imports: [DialogFocusTrapDirective],
  templateUrl: './action-sheet.html',
  styleUrl: './action-sheet.css',
})
export class ActionSheet implements OnChanges, OnDestroy {
  @Input({ required: true }) open = false;
  @Input({ required: true }) title = '';
  @Input() eyebrow = '';
  @Input() description = '';
  @Input() closeLabel = 'Close';
  @Input() dialogId = 'rr-action-sheet-title';
  @Input() busy = false;

  @Output() close = new EventEmitter<void>();

  private bodyLocked = false;

  ngOnChanges(changes: SimpleChanges): void {
    if ('open' in changes) {
      this.syncBodyLock();
    }
  }

  ngOnDestroy(): void {
    this.releaseBodyLock();
  }

  requestClose(): void {
    if (this.busy) {
      return;
    }

    this.close.emit();
  }

  private syncBodyLock(): void {
    if (this.open) {
      this.acquireBodyLock();
      return;
    }

    this.releaseBodyLock();
  }

  private acquireBodyLock(): void {
    if (this.bodyLocked || typeof document === 'undefined') {
      return;
    }

    if (actionSheetBodyLockCount === 0) {
      actionSheetPreviousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    actionSheetBodyLockCount += 1;
    this.bodyLocked = true;
  }

  private releaseBodyLock(): void {
    if (!this.bodyLocked || typeof document === 'undefined') {
      return;
    }

    actionSheetBodyLockCount = Math.max(0, actionSheetBodyLockCount - 1);
    this.bodyLocked = false;

    if (actionSheetBodyLockCount === 0) {
      document.body.style.overflow = actionSheetPreviousBodyOverflow;
      actionSheetPreviousBodyOverflow = '';
    }
  }
}
