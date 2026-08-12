
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const RESERVED_DOCUMENT_ID_PATTERN = /^__.*__$/;
const LEAGUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function normalizeAppCheckCallableCanaryLeagueId(
  value: unknown,
): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (
    id.length < 3 ||
    Buffer.byteLength(id, 'utf8') > 128 ||
    id.includes('/') ||
    CONTROL_CHARACTER_PATTERN.test(id) ||
    id === '.' ||
    id === '..' ||
    RESERVED_DOCUMENT_ID_PATTERN.test(id) ||
    !LEAGUE_ID_PATTERN.test(id)
  ) {
    return null;
  }
  return id;
}

export const APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION = 1;
export const APP_CHECK_CALLABLE_CANARY_CONTROL_PATH =
  'appData/appCheckCallableCanaryControl';
export const APP_CHECK_CALLABLE_CANARY_HEALTH_PATH =
  'appData/appCheckCallableCanaryHealth';
export const APP_CHECK_CALLABLE_CANARY_MAXIMUM_LEAGUES = 5;
export const APP_CHECK_CALLABLE_CANARY_MINIMUM_REASON_LENGTH = 8;
export const APP_CHECK_CALLABLE_CANARY_CONTROL_CACHE_MILLISECONDS = 5_000;

export const APP_CHECK_CALLABLE_CANARY_OPTIONS = Object.freeze([
  Object.freeze({
    name: 'requestProjectionSnapshotGeneration',
    label: 'Projection generation',
    description: 'Expensive but recoverable server Projection V11 preparation.',
    recommendedOrder: 1,
  }),
  Object.freeze({
    name: 'advanceHistoricalReplayDay',
    label: 'Historical replay',
    description: 'Platform-admin test control with preserved retry state.',
    recommendedOrder: 2,
  }),
  Object.freeze({
    name: 'makeSecureDraftPick',
    label: 'Draft pick',
    description: 'Server-authoritative live Draft selection.',
    recommendedOrder: 3,
  }),
  Object.freeze({
    name: 'applyImmediateRosterMove',
    label: 'Immediate roster move',
    description: 'Untouched-window lineup and IR changes.',
    recommendedOrder: 4,
  }),
  Object.freeze({
    name: 'executeSecureRosterAction',
    label: 'Roster, waiver, and IR action',
    description: 'Scheduled add/drop, waiver, lineup, and IR authority.',
    recommendedOrder: 5,
  }),
] as const);

export type AppCheckCallableCanaryName =
  (typeof APP_CHECK_CALLABLE_CANARY_OPTIONS)[number]['name'];
export type AppCheckCallableCanaryMode = 'monitor' | 'canary';
export type AppCheckCallableCanaryRequestStatus = 'valid' | 'missing';

export interface AppCheckCallableCanaryControl {
  schemaVersion: number;
  mode: AppCheckCallableCanaryMode;
  revision: number;
  approvedBuildId: string | null;
  approvedAppId: string | null;
  selectedCallables: AppCheckCallableCanaryName[];
  canaryLeagueIds: string[];
  reason: string;
  updatedBy: string | null;
  automaticPromotion: false;
}

export interface AppCheckCallableCanaryDecision {
  selectedForCanary: boolean;
  requestStatus: AppCheckCallableCanaryRequestStatus;
  shouldReject: boolean;
  expectedAppId: string | null;
  receivedAppId: string | null;
}

export const DEFAULT_APP_CHECK_CALLABLE_CANARY_CONTROL:
  AppCheckCallableCanaryControl = Object.freeze({
    schemaVersion: APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION,
    mode: 'monitor',
    revision: 0,
    approvedBuildId: null,
    approvedAppId: null,
    selectedCallables: [],
    canaryLeagueIds: [],
    reason: 'Selected-callable App Check enforcement has not started.',
    updatedBy: null,
    automaticPromotion: false,
  });

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedString(value: unknown, maximumLength: number): string {
  return typeof value === 'string'
    ? value.trim().slice(0, maximumLength)
    : '';
}

export function isAppCheckCallableCanaryName(
  value: unknown,
): value is AppCheckCallableCanaryName {
  return APP_CHECK_CALLABLE_CANARY_OPTIONS.some((option) => option.name === value);
}

export function normalizeAppCheckCallableCanaryNames(
  value: unknown,
): AppCheckCallableCanaryName[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(isAppCheckCallableCanaryName))]
    .sort((left, right) => {
      const leftOrder = APP_CHECK_CALLABLE_CANARY_OPTIONS.find(
        (option) => option.name === left,
      )?.recommendedOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = APP_CHECK_CALLABLE_CANARY_OPTIONS.find(
        (option) => option.name === right,
      )?.recommendedOrder ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.localeCompare(right);
    });
}

export function normalizeAppCheckCallableCanaryLeagueIds(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .map((item) => normalizeAppCheckCallableCanaryLeagueId(item))
    .filter((item): item is string => Boolean(item));

  return [...new Set(normalized)]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, APP_CHECK_CALLABLE_CANARY_MAXIMUM_LEAGUES);
}

export function normalizeAppCheckCallableCanaryControl(
  value: unknown,
): AppCheckCallableCanaryControl {
  const source = asRecord(value);
  const mode: AppCheckCallableCanaryMode = source['mode'] === 'canary'
    ? 'canary'
    : 'monitor';
  const revision = typeof source['revision'] === 'number' &&
    Number.isFinite(source['revision']) && source['revision'] >= 0
      ? Math.floor(source['revision'])
      : 0;

  return {
    schemaVersion: APP_CHECK_CALLABLE_CANARY_SCHEMA_VERSION,
    mode,
    revision,
    approvedBuildId: boundedString(source['approvedBuildId'], 180) || null,
    approvedAppId: boundedString(source['approvedAppId'], 180) || null,
    selectedCallables: normalizeAppCheckCallableCanaryNames(
      source['selectedCallables'],
    ),
    canaryLeagueIds: normalizeAppCheckCallableCanaryLeagueIds(
      source['canaryLeagueIds'],
    ),
    reason: boundedString(source['reason'], 500) ||
      DEFAULT_APP_CHECK_CALLABLE_CANARY_CONTROL.reason,
    updatedBy: boundedString(source['updatedBy'], 128) || null,
    automaticPromotion: false,
  };
}

export function buildAppCheckCallableCanaryDecision(
  controlValue: unknown,
  options: {
    callableName: AppCheckCallableCanaryName;
    leagueId: string;
    appId?: unknown;
  },
): AppCheckCallableCanaryDecision {
  const control = normalizeAppCheckCallableCanaryControl(controlValue);
  const receivedAppId = boundedString(options.appId, 180) || null;
  const selectedForCanary =
    control.mode === 'canary' &&
    control.selectedCallables.includes(options.callableName) &&
    control.canaryLeagueIds.includes(options.leagueId);
  const requestStatus: AppCheckCallableCanaryRequestStatus =
    receivedAppId && control.approvedAppId === receivedAppId
      ? 'valid'
      : 'missing';

  return {
    selectedForCanary,
    requestStatus,
    shouldReject: selectedForCanary && requestStatus !== 'valid',
    expectedAppId: control.approvedAppId,
    receivedAppId,
  };
}
