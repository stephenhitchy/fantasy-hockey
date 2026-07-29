import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';
import type { AppCheck } from 'firebase/app-check';

import { FIREBASE_APP_CHECK_CONFIG } from '../../environments/app-check.config';
import { firebaseApp } from './firebase-app';

let initializedAppCheck: AppCheck | null = null;

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

export function initializeRinkRatAppCheck(): AppCheck | null {
  if (initializedAppCheck || !isBrowser() || !FIREBASE_APP_CHECK_CONFIG.enabled) {
    return initializedAppCheck;
  }

  const siteKey = FIREBASE_APP_CHECK_CONFIG.recaptchaEnterpriseSiteKey.trim();

  if (!siteKey) {
    console.warn(
      'Firebase App Check is enabled, but no reCAPTCHA Enterprise site key is configured.',
    );
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

  initializedAppCheck = initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: FIREBASE_APP_CHECK_CONFIG.tokenAutoRefreshEnabled,
  });

  return initializedAppCheck;
}
