import { CanDeactivateFn } from '@angular/router';

export interface PendingDraftActionAware {
  canLeaveDraftRoom(): boolean;
}

export const pendingDraftActionGuard: CanDeactivateFn<PendingDraftActionAware> = (component) =>
  component.canLeaveDraftRoom();
