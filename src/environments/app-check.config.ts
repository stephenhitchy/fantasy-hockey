/**
 * Firebase App Check rollout configuration.
 *
 * Keep enabled=false until the production web app has been registered in
 * Firebase App Check with a reCAPTCHA Enterprise score-based site key.
 * After registration, paste the PUBLIC site key below, deploy the client, and
 * monitor App Check metrics before enabling enforcement in Firebase.
 */
export const FIREBASE_APP_CHECK_CONFIG = {
  enabled: false,
  recaptchaEnterpriseSiteKey: '',
  tokenAutoRefreshEnabled: true,
  localDebugTokenEnabled: false,
} as const;
