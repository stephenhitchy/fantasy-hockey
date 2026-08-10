import { Injectable, computed, signal } from '@angular/core';
import {
  EmailAuthProvider,
  getIdTokenResult,
  reauthenticateWithCredential,
} from 'firebase/auth';

import { auth } from '../firebase-auth';
import { withTimeout } from './auth-session.service';
import { RECENT_AUTHENTICATION_WINDOW_SECONDS } from './auth-security.config';

export type RecentAuthenticationStatus =
  | 'signed-out'
  | 'checking'
  | 'recent'
  | 'expired'
  | 'unsupported'
  | 'error';

export interface RecentAuthenticationSnapshot {
  status: RecentAuthenticationStatus;
  ageSeconds: number | null;
  expiresInSeconds: number | null;
  checkedAt: number | null;
  message: string;
}

function claimSeconds(value: unknown): number | null {
  const candidate = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : null;
}

export function getFriendlyReauthenticationError(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code : '';

  if (code.includes('auth/wrong-password') || code.includes('auth/invalid-credential')) {
    return 'That password was not correct. Enter your current RinkRat password and try again.';
  }

  if (code.includes('auth/too-many-requests')) {
    return 'Too many verification attempts were made. Wait a few minutes and try again.';
  }

  if (code.includes('auth/network-request-failed')) {
    return 'RinkRat could not verify your password because the connection was interrupted.';
  }

  if (code.includes('auth/user-mismatch')) {
    return 'The credentials did not match the manager currently signed in.';
  }

  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  return message
    ? message.replace(/^Firebase:\s*/i, '').replace(/\s*\([^)]*\)\.?$/, '').trim()
    : 'RinkRat could not refresh this secure session.';
}

export async function reauthenticateCurrentUserWithPassword(
  password: string,
): Promise<void> {
  const user = auth.currentUser;

  if (!user || !user.email) {
    throw new Error('Your account is not signed in with an email-and-password identity.');
  }

  if (!user.providerData.some((provider) => provider.providerId === 'password')) {
    throw new Error(
      'This account does not use a password provider. Sign out and sign back in before continuing.',
    );
  }

  const credential = EmailAuthProvider.credential(user.email, password);
  await withTimeout(
    reauthenticateWithCredential(user, credential),
    20_000,
    'Password verification took too long. Check the connection and try again.',
  );
  await withTimeout(
    user.getIdToken(true),
    12_000,
    'The secure session refreshed, but the new account token took too long to arrive.',
  );
}

@Injectable({ providedIn: 'root' })
export class RecentAuthService {
  readonly snapshot = signal<RecentAuthenticationSnapshot>({
    status: 'checking',
    ageSeconds: null,
    expiresInSeconds: null,
    checkedAt: null,
    message: 'Checking the age of this secure session…',
  });
  readonly isRecent = computed(() => this.snapshot().status === 'recent');
  readonly needsStepUp = computed(() => {
    const status = this.snapshot().status;
    return status === 'expired' || status === 'unsupported' || status === 'error';
  });

  private refreshPromise: Promise<RecentAuthenticationSnapshot> | null = null;

  constructor() {
    void this.refresh();
  }

  async refresh(forceTokenRefresh = false): Promise<RecentAuthenticationSnapshot> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.loadSnapshot(forceTokenRefresh).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async reauthenticate(password: string): Promise<RecentAuthenticationSnapshot> {
    await reauthenticateCurrentUserWithPassword(password);
    return this.refresh(true);
  }

  private async loadSnapshot(
    forceTokenRefresh: boolean,
  ): Promise<RecentAuthenticationSnapshot> {
    const user = auth.currentUser;

    if (!user) {
      const snapshot: RecentAuthenticationSnapshot = {
        status: 'signed-out',
        ageSeconds: null,
        expiresInSeconds: null,
        checkedAt: Date.now(),
        message: 'Sign in before using protected account or administrator actions.',
      };
      this.snapshot.set(snapshot);
      return snapshot;
    }

    this.snapshot.update((current) => ({
      ...current,
      status: 'checking',
      message: 'Checking the age of this secure session…',
    }));

    try {
      const tokenResult = await withTimeout(
        getIdTokenResult(user, forceTokenRefresh),
        12_000,
        'The browser took too long to inspect the secure account session.',
      );
      const authTimeSeconds = claimSeconds(tokenResult.claims['auth_time']);
      const nowSeconds = Math.floor(Date.now() / 1_000);

      if (authTimeSeconds === null) {
        const snapshot: RecentAuthenticationSnapshot = {
          status: 'unsupported',
          ageSeconds: null,
          expiresInSeconds: null,
          checkedAt: Date.now(),
          message: 'RinkRat could not verify when this account last proved its identity.',
        };
        this.snapshot.set(snapshot);
        return snapshot;
      }

      const ageSeconds = Math.max(0, nowSeconds - authTimeSeconds);
      const expiresInSeconds = Math.max(
        0,
        RECENT_AUTHENTICATION_WINDOW_SECONDS - ageSeconds,
      );
      const recent = ageSeconds <= RECENT_AUTHENTICATION_WINDOW_SECONDS;
      const snapshot: RecentAuthenticationSnapshot = {
        status: recent ? 'recent' : 'expired',
        ageSeconds,
        expiresInSeconds,
        checkedAt: Date.now(),
        message: recent
          ? 'Protected actions are unlocked for this recently verified session.'
          : 'Enter your current password before performing a protected action.',
      };
      this.snapshot.set(snapshot);
      return snapshot;
    } catch (error: unknown) {
      const snapshot: RecentAuthenticationSnapshot = {
        status: 'error',
        ageSeconds: null,
        expiresInSeconds: null,
        checkedAt: Date.now(),
        message: getFriendlyReauthenticationError(error),
      };
      this.snapshot.set(snapshot);
      return snapshot;
    }
  }
}
