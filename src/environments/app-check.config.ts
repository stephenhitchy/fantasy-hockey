/**
 * Firebase App Check rollout configuration.
 *
 * `enabled` controls whether the browser requests reCAPTCHA Enterprise App
 * Check tokens. Firebase enforcement is configured separately in the Firebase
 * Console and should remain disabled until legitimate production traffic has
 * been monitored successfully.
 *
 * The site key is public browser configuration. Local development should use
 * Firebase's registered debug-token workflow rather than a production-domain
 * exception. `localDebugTokenEnabled` is intentionally false in production.
 */
export const FIREBASE_APP_CHECK_CONFIG = {
  enabled: true,
  recaptchaEnterpriseSiteKey: '6Lc_on8tAAAAAMcZ0UAtbBr9cpO5qJidjSIPOb5F',
  tokenAutoRefreshEnabled: true,
  localDebugTokenEnabled: false,
} as const;
