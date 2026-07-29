import { inject } from '@angular/core';
import { CanActivateChildFn, CanActivateFn, Router, UrlTree } from '@angular/router';
import { onAuthStateChanged, User } from 'firebase/auth';

import { auth } from '../firebase-auth';

export function waitForAuthenticatedUser(): Promise<User | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
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
