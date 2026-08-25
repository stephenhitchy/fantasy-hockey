import {
  Component,
  computed,
  ElementRef,
  HostListener,
  Input,
  OnDestroy,
  signal,
  ViewChild,
} from '@angular/core';

import { ViewportOverlayPortalDirective } from '../accessibility/viewport-overlay-portal.directive';
import { HockeyTermPopoverCoordinator } from './hockey-term-popover-coordinator.service';
import {
  getHockeyTermDefinition,
  getHockeyTermDisplayLabel,
  HockeyTermKey,
  loadStoredHockeyExperienceLevel,
} from './hockey-terms.data';

interface HockeyTermPanelPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

let hockeyTermChipInstanceId = 0;

@Component({
  selector: 'app-hockey-term',
  standalone: true,
  imports: [ViewportOverlayPortalDirective],
  templateUrl: './hockey-term-chip.html',
  styleUrl: './hockey-term-chip.css',
})
export class HockeyTermChip implements OnDestroy {
  @Input({ required: true }) term!: HockeyTermKey;
  @Input() compact = false;
  @Input() popoverAlign: 'start' | 'center' | 'end' = 'start';

  @ViewChild('termTrigger') private triggerElement?: ElementRef<HTMLButtonElement>;
  @ViewChild('termPanel') private panelElement?: ElementRef<HTMLElement>;

  readonly panelId = `hockey-term-panel-${++hockeyTermChipInstanceId}`;
  readonly titleId = `${this.panelId}-title`;
  readonly open = computed(() => this.coordinator.activePanelId() === this.panelId);
  readonly panelPosition = signal<HockeyTermPanelPosition | null>(null);
  readonly mobilePanel = signal(false);

  private firstPositionFrame: number | null = null;
  private secondPositionFrame: number | null = null;
  private readonly inheritedPanelVariables = new Map<string, string>();

  constructor(
    private readonly coordinator: HockeyTermPopoverCoordinator,
    private readonly hostElement: ElementRef<HTMLElement>,
  ) {}

  definition() {
    return getHockeyTermDefinition(this.term);
  }

  experience() {
    return loadStoredHockeyExperienceLevel();
  }

  displayLabel(): string {
    return getHockeyTermDisplayLabel(this.term, this.experience(), this.compact);
  }

  toggle(): void {
    const opened = this.coordinator.toggle(this.panelId);

    if (opened) {
      // The panel is portaled under document.body so fixed positioning is based on
      // the real viewport even when an animated page creates a containing block.
      this.capturePanelVariables();
      this.panelPosition.set(null);
      this.mobilePanel.set(false);
      this.schedulePanelPosition();
    } else {
      this.cancelPositionFrames();
      this.panelPosition.set(null);
      this.mobilePanel.set(false);
    }
  }

  close(restoreFocus = false): void {
    if (!this.open()) {
      return;
    }

    this.coordinator.close(this.panelId);
    this.cancelPositionFrames();
    this.panelPosition.set(null);
    this.mobilePanel.set(false);

    if (restoreFocus && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => this.triggerElement?.nativeElement.focus());
    }
  }

  @HostListener('document:keydown.escape')
  closeOnEscape(): void {
    this.close(true);
  }

  @HostListener('document:pointerdown', ['$event'])
  closeOnOutsidePointer(event: PointerEvent): void {
    if (!this.open()) {
      return;
    }

    const target = event.target;
    const panel = this.panelElement?.nativeElement;
    if (
      target instanceof Node &&
      (this.hostElement.nativeElement.contains(target) || panel?.contains(target))
    ) {
      return;
    }

    this.close();
  }

  @HostListener('window:resize')
  @HostListener('window:scroll')
  keepPanelInsideViewport(): void {
    if (this.open()) {
      this.schedulePanelPosition();
    }
  }

  ngOnDestroy(): void {
    this.close();
    this.cancelPositionFrames();
  }

  private schedulePanelPosition(): void {
    if (typeof window === 'undefined') {
      return;
    }

    this.cancelPositionFrames();
    this.firstPositionFrame = window.requestAnimationFrame(() => {
      this.firstPositionFrame = null;
      this.secondPositionFrame = window.requestAnimationFrame(() => {
        this.secondPositionFrame = null;
        this.positionPanel();
      });
    });
  }

  private positionPanel(): void {
    if (!this.open() || typeof window === 'undefined') {
      return;
    }

    const trigger = this.triggerElement?.nativeElement;
    const panel = this.panelElement?.nativeElement;

    if (!trigger || !panel) {
      return;
    }

    this.applyPanelVariables(panel);

    const viewportMargin = 12;
    const panelGap = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const mobilePanel = viewportWidth <= 520;
    this.mobilePanel.set(mobilePanel);

    if (mobilePanel) {
      // A non-null position reveals the panel after measurement. The mobile stylesheet owns
      // its fixed-sheet coordinates, so no desktop inline coordinates compete with it.
      this.panelPosition.set({ top: 0, left: 0, width: 0, maxHeight: 0 });
      return;
    }

    const panelWidth = Math.max(220, Math.min(320, viewportWidth - viewportMargin * 2));
    const triggerRect = trigger.getBoundingClientRect();

    let left = triggerRect.left;
    if (this.popoverAlign === 'center') {
      left = triggerRect.left + (triggerRect.width - panelWidth) / 2;
    } else if (this.popoverAlign === 'end') {
      left = triggerRect.right - panelWidth;
    }
    left = Math.min(
      Math.max(viewportMargin, left),
      Math.max(viewportMargin, viewportWidth - panelWidth - viewportMargin),
    );

    const measuredPanelHeight = Math.max(panel.scrollHeight, panel.getBoundingClientRect().height);
    const availableBelow = Math.max(
      0,
      viewportHeight - triggerRect.bottom - panelGap - viewportMargin,
    );
    const availableAbove = Math.max(0, triggerRect.top - panelGap - viewportMargin);
    const openAbove = measuredPanelHeight > availableBelow && availableAbove > availableBelow;
    const availableHeight = openAbove ? availableAbove : availableBelow;
    const maxHeight = Math.max(
      120,
      Math.min(measuredPanelHeight, availableHeight || viewportHeight - viewportMargin * 2),
    );
    const renderedHeight = Math.min(measuredPanelHeight, maxHeight);
    const top = openAbove
      ? Math.max(viewportMargin, triggerRect.top - panelGap - renderedHeight)
      : Math.min(
          Math.max(viewportMargin, triggerRect.bottom + panelGap),
          Math.max(viewportMargin, viewportHeight - renderedHeight - viewportMargin),
        );

    this.panelPosition.set({ top, left, width: panelWidth, maxHeight });
  }

  private capturePanelVariables(): void {
    this.inheritedPanelVariables.clear();

    if (typeof window === 'undefined') {
      return;
    }

    const styles = window.getComputedStyle(this.hostElement.nativeElement);
    const variableNames = [
      '--hockey-term-accent',
      '--hockey-term-surface',
      '--position-accent',
      '--rr-forward-position-accent',
      '--rr-defense-position-accent',
      '--rr-goalie-position-accent',
      '--user-team-accent',
      '--user-team-primary',
      '--surface-1',
      '--surface-2',
      '--border-strong',
      '--text-primary',
      '--text-secondary',
      '--focus-ring',
      '--rr-font-ui',
      '--rr-mobile-text-body',
    ];

    for (const variableName of variableNames) {
      const value = styles.getPropertyValue(variableName).trim();
      if (value) {
        this.inheritedPanelVariables.set(variableName, value);
      }
    }
  }

  private applyPanelVariables(panel: HTMLElement): void {
    for (const [variableName, value] of this.inheritedPanelVariables) {
      panel.style.setProperty(variableName, value);
    }
  }

  private cancelPositionFrames(): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.firstPositionFrame !== null) {
      window.cancelAnimationFrame(this.firstPositionFrame);
      this.firstPositionFrame = null;
    }

    if (this.secondPositionFrame !== null) {
      window.cancelAnimationFrame(this.secondPositionFrame);
      this.secondPositionFrame = null;
    }
  }
}
