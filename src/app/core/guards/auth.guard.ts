import { inject } from '@angular/core';
import { CanActivateChildFn, CanActivateFn, Router, UrlTree } from '@angular/router';
import { User } from 'firebase/auth';

import { waitForAuthState } from '../auth/auth-session.service';

export function waitForAuthenticatedUser(): Promise<User | null> {
  return waitForAuthState(undefined, 10_000);
}

async function requireAuthenticatedRoute(stateUrl: string): Promise<true | UrlTree> {
  const router = inject(Router);
  const user = await waitForAuthenticatedUser();

  if (user) {
    return true;
  }

  return router.createUrlTree(['/'], {
    queryParams: {
      returnUrl: stateUrl,
    },
  });
}

export const authGuard: CanActivateFn = (_route, state) =>
  requireAuthenticatedRoute(state.url);

export const authChildGuard: CanActivateChildFn = (_route, state) =>
  requireAuthenticatedRoute(state.url);
