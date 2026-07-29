import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { PlatformAdminService } from '../admin/platform-admin.service';
import { waitForAuthenticatedUser } from './auth.guard';

export const platformAdminGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const platformAdmin = inject(PlatformAdminService);
  const user = await waitForAuthenticatedUser();

  if (!user) {
    return router.createUrlTree(['/']);
  }

  const allowed = await platformAdmin.refreshAccess(true);

  if (allowed) {
    return true;
  }

  return router.createUrlTree(['/access-denied'], {
    queryParams: { reason: 'platform-admin' },
  });
};
