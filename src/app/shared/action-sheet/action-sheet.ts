import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  signal,
} from '@angular/core';

import { DialogFocusTrapDirective } from '../accessibility/dialog-focus-trap.directive';
import { ViewportOverlayPortalDirective } from '../accessibility/viewport-overlay-portal.directive';

const DEFAULT_BUSY_VISUAL_RELEASE_MILLISECONDS = 12_000;

@Component({
  selector: 'app-action-sheet',
  imports: [DialogFocusTrapDirective, ViewportOverlayPortalDirective],
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
  @Input() wide = false;
  @Input() scrollChrome = false;
  @Input() busyVisualReleaseMilliseconds = DEFAULT_BUSY_VISUAL_RELEASE_MILLISECONDS;

  @Output() close = new EventEmitter<void>();

  /**
   * A network request may continue after Mobile Safari loses its HTTP response.
   * The parent still owns the competitive pending state, but this shared visual
   * watchdog guarantees that a modal backdrop can never trap the manager
   * indefinitely. Parent pages expose a compact status dock while reconciling.
   */
  readonly visualReleased = signal(false);

  private busyVisualReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private previousOpen = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open']) {
      const openedNow = this.open && !this.previousOpen;
      this.previousOpen = this.open;

      if (openedNow || !this.open) {
        this.visualReleased.set(false);
      }
    }

    this.updateBusyVisualWatchdog();
  }

  ngOnDestroy(): void {
    this.clearBusyVisualWatchdog();
  }

  requestClose(): void {
    if (this.busy) {
      return;
    }

    this.close.emit();
  }

  private updateBusyVisualWatchdog(): void {
    this.clearBusyVisualWatchdog();

    if (!this.open || !this.busy || this.visualReleased()) {
      return;
    }

    this.busyVisualReleaseTimer = globalThis.setTimeout(() => {
      this.busyVisualReleaseTimer = null;

      if (this.open && this.busy) {
        this.visualReleased.set(true);
      }
    }, Math.max(2_000, this.busyVisualReleaseMilliseconds));
  }

  private clearBusyVisualWatchdog(): void {
    if (!this.busyVisualReleaseTimer) {
      return;
    }

    globalThis.clearTimeout(this.busyVisualReleaseTimer);
    this.busyVisualReleaseTimer = null;
  }
}
