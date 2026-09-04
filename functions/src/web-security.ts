/**
 * Browser origins that are allowed to call Firebase callable functions.
 *
 * The NHL and ESPN browser requests use same-origin Firebase Hosting rewrites,
 * so those routes do not need CORS at all. Callable Functions are hosted on a
 * Google domain, so their CORS policy must explicitly trust the production,
 * isolated staging, legacy Hosting, and local-development origins.
 */
export const TRUSTED_WEB_ORIGINS: Array<string | RegExp> = [
  'https://rinkratfantasy.com',
  'https://www.rinkratfantasy.com',
  'https://cycle-puck.web.app',
  'https://cycle-puck.firebaseapp.com',
  'https://rinkrat-staging-d1nc-2026.web.app',
  'https://rinkrat-staging-d1nc-2026.firebaseapp.com',
  /^http:\/\/localhost(?::\d+)?$/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/,
];
