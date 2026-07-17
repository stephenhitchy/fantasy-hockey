import { AppRuntimeConfig } from './app-runtime.types';

export const APP_RUNTIME_CONFIG: AppRuntimeConfig = {
  releaseLabel: 'Release Candidate 1',
  scoringMode: 'historical',
  historicalScoringDateIso: '2026-01-10T12:00:00Z',
  developerToolsEnabled: true,
  productionHistoricalScoringAllowed: false,
};
