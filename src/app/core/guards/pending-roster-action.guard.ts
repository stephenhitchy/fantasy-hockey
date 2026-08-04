import { CanDeactivateFn } from '@angular/router';

export interface PendingRosterActionAware {
  canLeaveRosterPage(): boolean;
}

export const pendingRosterActionGuard: CanDeactivateFn<PendingRosterActionAware> = (
  component,
) => component.canLeaveRosterPage();
