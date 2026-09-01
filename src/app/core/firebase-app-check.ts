import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';
import type { AppCheck } from 'firebase/app-check';

import { FIREBASE_APP_CHECK_CONFIG } from '../../environments/app-check.config';
import { D1N_LOCAL_EMULATOR_CONFIG } from '../../environments/d1n-local-emulator.config';
import { firebaseApp } from './firebase-app';

export type RinkRatAppCheckStatus =
  | 'disabled'
  | 'misconfigured'
  | 'initializing'
  | 'valid'
  | 'error';

export interface RinkRatAppCheckState {
  configured: boolean;
  initialized: boolean;
  status: RinkRatAppCheckStatus;
  lastVerifiedAt: number | null;
  errorMessage: string;
}

let initializedAppCheck: AppCheck | null = null;
let appCheckState: RinkRatAppCheckState = {
  configured: false,
  initialized: false,
  status: 'disabled',
  lastVerifiedAt: null,
  errorMessage: '',
};
const stateListeners = new Set<(state: RinkRatAppCheckState) => void>();

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isLocalDevelopmentHost(): boolean {
  if (!isBrowser()) {
    return false;
  }

  const hostname = window.location.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function publishAppCheckState(next: Partial<RinkRatAppCheckState>): void {
  appCheckState = Object.freeze({ ...appCheckState, ...next });

  for (const listener of stateListeners) {
    listener(appCheckState);
  }
}

function withAppCheckTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('App Check token verification timed out.')),
      milliseconds,
    );
  });

  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

export function getRinkRatAppCheckState(): RinkRatAppCheckState {
  return { ...appCheckState };
}

export async function getRinkRatAppCheckToken(): Promise<string | null> {
  if (!initializedAppCheck) {
    return null;
  }

  try {
    const result = await withAppCheckTimeout(
      getToken(initializedAppCheck, false),
      5_000,
    );
    return result.token || null;
  } catch {
    // The NHL proxy remains in App Check monitor mode. A missing token must not
    // break hockey data while we verify supported browsers and devices.
    return null;
  }
}

export function listenToRinkRatAppCheckState(
  listener: (state: RinkRatAppCheckState) => void,
): () => void {
  stateListeners.add(listener);
  listener(getRinkRatAppCheckState());

  return () => stateListeners.delete(listener);
}

export async function verifyRinkRatAppCheckToken(
  forceRefresh = false,
): Promise<RinkRatAppCheckState> {
  if (!initializedAppCheck) {
    return getRinkRatAppCheckState();
  }

  publishAppCheckState({ status: 'initializing', errorMessage: '' });

  try {
    const result = await withAppCheckTimeout(
      getToken(initializedAppCheck, forceRefresh),
      20_000,
    );

    if (!result.token) {
      throw new Error('Firebase returned an empty App Check token.');
    }

    publishAppCheckState({
      status: 'valid',
      initialized: true,
      lastVerifiedAt: Date.now(),
      errorMessage: '',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to verify App Check.';
    publishAppCheckState({
      status: 'error',
      initialized: true,
      errorMessage: message,
    });
  }

  return getRinkRatAppCheckState();
}

export function initializeRinkRatAppCheck(): AppCheck | null {
  if (initializedAppCheck || !isBrowser()) {
    return initializedAppCheck;
  }

  if (D1N_LOCAL_EMULATOR_CONFIG.enabled) {
    publishAppCheckState({
      configured: false,
      initialized: false,
      status: 'disabled',
      errorMessage: '',
    });
    return null;
  }

  const siteKey = FIREBASE_APP_CHECK_CONFIG.recaptchaEnterpriseSiteKey.trim();
  const configured = FIREBASE_APP_CHECK_CONFIG.enabled && siteKey.length > 0;

  if (!FIREBASE_APP_CHECK_CONFIG.enabled) {
    publishAppCheckState({
      configured: false,
      initialized: false,
      status: 'disabled',
      errorMessage: '',
    });
    return null;
  }

  if (!siteKey) {
    publishAppCheckState({
      configured: false,
      initialized: false,
      status: 'misconfigured',
      errorMessage: 'App Check is enabled, but the reCAPTCHA Enterprise site key is missing.',
    });
    console.warn(appCheckState.errorMessage);
    return null;
  }

  if (
    FIREBASE_APP_CHECK_CONFIG.localDebugTokenEnabled &&
    isLocalDevelopmentHost()
  ) {
    (globalThis as typeof globalThis & {
      FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean;
    }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }

  publishAppCheckState({
    configured,
    initialized: false,
    status: 'initializing',
    errorMessage: '',
  });

  try {
    initializedAppCheck = initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: FIREBASE_APP_CHECK_CONFIG.tokenAutoRefreshEnabled,
    });
    publishAppCheckState({ initialized: true });
    void verifyRinkRatAppCheckToken();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to initialize App Check.';
    publishAppCheckState({
      initialized: false,
      status: 'error',
      errorMessage: message,
    });
    console.warn('Firebase App Check could not initialize.', error);
  }

  return initializedAppCheck;
}
