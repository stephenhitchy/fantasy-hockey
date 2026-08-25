import { Injectable, signal } from '@angular/core';

/**
 * Coordinates inline hockey definitions so only one explanation is visible at a time.
 * Keeping this state at the application level also prevents neighboring glossary chips
 * from stacking over one another when a manager quickly opens several definitions.
 */
@Injectable({ providedIn: 'root' })
export class HockeyTermPopoverCoordinator {
  private readonly activePanelIdState = signal<string | null>(null);

  readonly activePanelId = this.activePanelIdState.asReadonly();

  open(panelId: string): void {
    this.activePanelIdState.set(panelId);
  }

  toggle(panelId: string): boolean {
    const shouldOpen = this.activePanelIdState() !== panelId;
    this.activePanelIdState.set(shouldOpen ? panelId : null);
    return shouldOpen;
  }

  close(panelId?: string): void {
    if (!panelId || this.activePanelIdState() === panelId) {
      this.activePanelIdState.set(null);
    }
  }
}
