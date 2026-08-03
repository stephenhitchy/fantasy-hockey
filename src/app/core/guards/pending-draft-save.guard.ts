import { CanDeactivateFn } from '@angular/router';

export interface PendingDraftSaveAware {
  canLeaveDraftSetup(): boolean;
}

export const pendingDraftSaveGuard: CanDeactivateFn<PendingDraftSaveAware> = (component) =>
  component.canLeaveDraftSetup();
