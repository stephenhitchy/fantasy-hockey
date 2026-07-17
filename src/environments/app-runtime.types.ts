export type AppScoringMode = 'historical' | 'live';

export interface AppRuntimeConfig {
  releaseLabel: string;
  scoringMode: AppScoringMode;
  historicalScoringDateIso: string | null;
  developerToolsEnabled: boolean;
  productionHistoricalScoringAllowed: boolean;
  regularSeasonAutoStartIso: string | null;
}
