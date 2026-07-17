import { AppRuntimeConfig } from './app-runtime.types';

/**
 * Safe production defaults. Angular replaces app-runtime.config.ts with this
 * file for production builds, so historical scoring and temporary simulator
 * controls cannot accidentally ship to the live site.
 */
export const APP_RUNTIME_CONFIG: AppRuntimeConfig = {
  releaseLabel: 'Release Candidate 1',
  scoringMode: 'live',
  historicalScoringDateIso: null,
  developerToolsEnabled: false,
  productionHistoricalScoringAllowed: false,
};
