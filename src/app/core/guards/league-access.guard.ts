import { inject, Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, Router } from '@angular/router';
import { doc, getDoc } from 'firebase/firestore';

import { APP_RUNTIME_CONFIG } from '../../../environments/app-runtime.config';
import { db } from '../firebase-firestore';
import { waitForAuthenticatedUser } from './auth.guard';

interface LeagueAccessResult {
  member: boolean;
  commissioner: boolean;
}

interface CachedLeagueAccess {
  expiresAt: number;
  result: LeagueAccessResult;
}

const ACCESS_CACHE_MILLISECONDS = 30_000;

function routeLeagueId(route: ActivatedRouteSnapshot): string {
  let cursor: ActivatedRouteSnapshot | null = route;

  while (cursor) {
    const leagueId = cursor.paramMap.get('leagueId');

    if (leagueId) {
      return leagueId;
    }

    cursor = cursor.parent;
  }

  return '';
}

@Injectable({ providedIn: 'root' })
class LeagueAccessLookupService {
  private readonly cache = new Map<string, CachedLeagueAccess>();
  private readonly pending = new Map<string, Promise<LeagueAccessResult>>();

  get(userId: string, leagueId: string): Promise<LeagueAccessResult> {
    const key = `${userId}:${leagueId}`;
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.result);
    }

    const existingPromise = this.pending.get(key);

    if (existingPromise) {
      return existingPromise;
    }

    const lookupPromise = this.load(userId, leagueId)
      .then((result) => {
        this.cache.set(key, {
          expiresAt: Date.now() + ACCESS_CACHE_MILLISECONDS,
          result,
        });
        return result;
      })
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, lookupPromise);
    return lookupPromise;
  }

  private async load(userId: string, leagueId: string): Promise<LeagueAccessResult> {
    if (!leagueId) {
      return { member: false, commissioner: false };
    }

    const [leagueSnapshot, memberSnapshot, teamSnapshot] = await Promise.all([
      getDoc(doc(db, 'leagues', leagueId)),
      getDoc(doc(db, 'leagues', leagueId, 'members', userId)),
      getDoc(doc(db, 'leagues', leagueId, 'teams', userId)),
    ]);

    if (!leagueSnapshot.exists()) {
      return { member: false, commissioner: false };
    }

    const commissioner = leagueSnapshot.data()['commissionerId'] === userId;

    return {
      commissioner,
      member: commissioner || memberSnapshot.exists() || teamSnapshot.exists(),
    };
  }
}

export const leagueMemberGuard: CanActivateFn = async (route) => {
  const router = inject(Router);
  const lookup = inject(LeagueAccessLookupService);
  const user = await waitForAuthenticatedUser();

  if (!user) {
    return router.createUrlTree(['/']);
  }

  try {
    const leagueId = routeLeagueId(route);
    const access = await lookup.get(user.uid, leagueId);

    if (access.member) {
      return true;
    }

    return router.createUrlTree(['/access-denied'], {
      queryParams: {
        reason: 'league-member',
        leagueId,
      },
    });
  } catch (error: unknown) {
    console.warn('Unable to verify league membership.', error);
    return router.createUrlTree(['/access-denied'], {
      queryParams: { reason: 'league-check' },
    });
  }
};

export const commissionerGuard: CanActivateFn = async (route) => {
  const router = inject(Router);
  const lookup = inject(LeagueAccessLookupService);
  const user = await waitForAuthenticatedUser();

  if (!user) {
    return router.createUrlTree(['/']);
  }

  try {
    const leagueId = routeLeagueId(route);
    const access = await lookup.get(user.uid, leagueId);

    if (access.commissioner) {
      return true;
    }

    return router.createUrlTree(['/access-denied'], {
      queryParams: {
        reason: 'commissioner',
        leagueId,
      },
    });
  } catch (error: unknown) {
    console.warn('Unable to verify commissioner access.', error);
    return router.createUrlTree(['/access-denied'], {
      queryParams: { reason: 'commissioner-check' },
    });
  }
};

export const developerToolsGuard: CanActivateFn = () => {
  if (APP_RUNTIME_CONFIG.developerToolsEnabled) {
    return true;
  }

  return inject(Router).createUrlTree(['/access-denied'], {
    queryParams: { reason: 'developer-tools' },
  });
};
