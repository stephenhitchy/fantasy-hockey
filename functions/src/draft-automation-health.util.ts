export const DRAFT_AUTOMATION_HEALTH_MAX_FRESHNESS_MILLISECONDS =
  4 * 60 * 1000;
export const DRAFT_AUTOMATION_EXPECTED_SCAN_INTERVAL_MILLISECONDS =
  60 * 1000;
export const DRAFT_AUTOMATION_IDLE_HEARTBEAT_DUE_MILLISECONDS =
  DRAFT_AUTOMATION_HEALTH_MAX_FRESHNESS_MILLISECONDS -
  DRAFT_AUTOMATION_EXPECTED_SCAN_INTERVAL_MILLISECONDS;

export interface DraftAutomationHealthSummary {
  schemaVersion: number;
  status: string;
  activeDraftCount: number;
  picksMade: number;
  failedDraftCount: number;
  failures: readonly unknown[];
}

export type DraftAutomationHealthWriteReason =
  | 'active-work'
  | 'failure'
  | 'state-transition'
  | 'heartbeat-due'
  | 'empty-repeat-suppressed';

export interface DraftAutomationHealthWriteDecision {
  shouldWrite: boolean;
  reason: DraftAutomationHealthWriteReason;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function isHealthyEmptyDraftAutomationState(value: unknown): boolean {
  const record = asRecord(value);

  return record?.['schemaVersion'] === 1 &&
    record['status'] === 'success' &&
    record['activeDraftCount'] === 0 &&
    record['picksMade'] === 0 &&
    record['failedDraftCount'] === 0 &&
    Array.isArray(record['failures']) &&
    record['failures'].length === 0;
}

export function getDraftAutomationHealthWriteDecision(input: {
  current: DraftAutomationHealthSummary;
  previous: unknown;
  previousLastRunMilliseconds: number | null;
  nowMilliseconds: number;
}): DraftAutomationHealthWriteDecision {
  if (
    input.current.status !== 'success' ||
    input.current.failedDraftCount > 0 ||
    input.current.failures.length > 0
  ) {
    return { shouldWrite: true, reason: 'failure' };
  }

  if (!isHealthyEmptyDraftAutomationState(input.current)) {
    return { shouldWrite: true, reason: 'active-work' };
  }

  if (!isHealthyEmptyDraftAutomationState(input.previous)) {
    return { shouldWrite: true, reason: 'state-transition' };
  }

  if (
    input.previousLastRunMilliseconds === null ||
    !Number.isFinite(input.previousLastRunMilliseconds) ||
    input.previousLastRunMilliseconds > input.nowMilliseconds ||
    input.nowMilliseconds - input.previousLastRunMilliseconds >=
      DRAFT_AUTOMATION_IDLE_HEARTBEAT_DUE_MILLISECONDS
  ) {
    return { shouldWrite: true, reason: 'heartbeat-due' };
  }

  return { shouldWrite: false, reason: 'empty-repeat-suppressed' };
}
