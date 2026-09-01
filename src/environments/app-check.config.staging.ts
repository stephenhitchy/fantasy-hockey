/**
 * Staging starts with App Check collection disabled until the staging web app
 * has its own provider registration and legitimate browser/device baseline.
 * This compile-time replacement does not change Production App Check mode.
 */
export const FIREBASE_APP_CHECK_CONFIG = {
  enabled: false,
  recaptchaEnterpriseSiteKey: '',
  tokenAutoRefreshEnabled: true,
  localDebugTokenEnabled: false,
} as const;
