import { APP_RUNTIME_CONFIG } from '../../../environments/app-runtime.config';
import { AppScoringMode } from '../../../environments/app-runtime.types';

export interface ScoringRuntimeState {
  releaseLabel: string;
  requestedMode: AppScoringMode;
  effectiveMode: AppScoringMode;
  historicalDateIso: string | null;
  developerToolsEnabled: boolean;
  productionHost: boolean;
  historicalModeBlocked: boolean;
  warningMessage: string;
}

function getCurrentHostname(): string {
  if (typeof globalThis.location?.hostname !== 'string') {
    return '';
  }

  return globalThis.location.hostname.trim().toLowerCase();
}

function isLocalDevelopmentHostname(hostname: string): boolean {
  return (
    !hostname ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  );
}

export function getScoringRuntimeState(): ScoringRuntimeState {
  const hostname = getCurrentHostname();
  const productionHost = !isLocalDevelopmentHostname(hostname);
  const requestedHistorical = APP_RUNTIME_CONFIG.scoringMode === 'historical';
  const historicalModeBlocked =
    requestedHistorical && productionHost && !APP_RUNTIME_CONFIG.productionHistoricalScoringAllowed;
  const effectiveMode: AppScoringMode = historicalModeBlocked
    ? 'live'
    : APP_RUNTIME_CONFIG.scoringMode;
  const historicalDateIso =
    effectiveMode === 'historical' ? APP_RUNTIME_CONFIG.historicalScoringDateIso : null;

  let warningMessage = '';

  if (historicalModeBlocked) {
    warningMessage =
      'Historical scoring was requested, but this production-like host forced live NHL scoring for safety.';
  } else if (effectiveMode === 'historical') {
    warningMessage = historicalDateIso
      ? `Historical testing mode is active. NHL scoring uses ${new Date(historicalDateIso).toLocaleString()}.`
      : 'Historical testing mode is active, but no valid historical date is configured.';
  }

  return {
    releaseLabel: APP_RUNTIME_CONFIG.releaseLabel,
    requestedMode: APP_RUNTIME_CONFIG.scoringMode,
    effectiveMode,
    historicalDateIso,
    developerToolsEnabled: APP_RUNTIME_CONFIG.developerToolsEnabled && !productionHost,
    productionHost,
    historicalModeBlocked,
    warningMessage,
  };
}

export function getHistoricalScoringTestDate(): Date | null {
  const value = getScoringRuntimeState().historicalDateIso;

  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function getScoringReferenceDate(fallbackDate: Date = new Date()): Date {
  return getHistoricalScoringTestDate() ?? fallbackDate;
}

export function isHistoricalScoringReplayEnabled(): boolean {
  return getScoringRuntimeState().effectiveMode === 'historical';
}

export function areDeveloperToolsEnabled(): boolean {
  return getScoringRuntimeState().developerToolsEnabled;
}
