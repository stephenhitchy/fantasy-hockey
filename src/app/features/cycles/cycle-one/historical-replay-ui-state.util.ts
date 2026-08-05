export type HistoricalReplayStatusLike = 'inactive' | 'advancing' | 'ready' | 'error';

export interface HistoricalReplayControlLike {
  status: HistoricalReplayStatusLike;
  daysAdvanced: number;
  simulatedDate: string | null;
  lastError: string;
  message?: string;
  lastReleasedGameCount?: number;
  totalReleasedGameCount?: number;
  updatedAt?: unknown;
}

export interface HistoricalReplayAdvanceBaseline {
  status: HistoricalReplayStatusLike;
  daysAdvanced: number;
  simulatedDate: string | null;
  lastError: string;
  message: string;
  lastReleasedGameCount: number;
  totalReleasedGameCount: number;
  updatedAtFingerprint: string;
}

export interface HistoricalReplayAdvanceEvaluation {
  state: 'pending' | 'ready' | 'error';
  sawServerStart: boolean;
}

function getUpdatedAtFingerprint(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (value instanceof Date) {
    return String(value.getTime());
  }

  if (typeof value === 'number' || typeof value === 'string') {
    return String(value);
  }

  if (typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const toMillis = record['toMillis'];

  if (typeof toMillis === 'function') {
    try {
      return String((toMillis as () => number).call(value));
    } catch {
      // Fall through to the structural Timestamp fields below.
    }
  }

  const seconds = record['seconds'] ?? record['_seconds'];
  const nanoseconds = record['nanoseconds'] ?? record['_nanoseconds'];

  if (typeof seconds === 'number') {
    return `${seconds}:${typeof nanoseconds === 'number' ? nanoseconds : 0}`;
  }

  return '';
}

export function createHistoricalReplayAdvanceBaseline(
  control: HistoricalReplayControlLike | null,
): HistoricalReplayAdvanceBaseline {
  return {
    status: control?.status ?? 'inactive',
    daysAdvanced: control?.daysAdvanced ?? 0,
    simulatedDate: control?.simulatedDate ?? null,
    lastError: control?.lastError ?? '',
    message: control?.message ?? '',
    lastReleasedGameCount: control?.lastReleasedGameCount ?? 0,
    totalReleasedGameCount: control?.totalReleasedGameCount ?? 0,
    updatedAtFingerprint: getUpdatedAtFingerprint(control?.updatedAt),
  };
}

export function evaluateHistoricalReplayAdvance(
  baseline: HistoricalReplayAdvanceBaseline,
  control: HistoricalReplayControlLike | null,
  sawServerStart: boolean,
): HistoricalReplayAdvanceEvaluation {
  if (!control) {
    return {
      state: 'pending',
      sawServerStart,
    };
  }

  const nextSawServerStart = sawServerStart || control.status === 'advancing';
  const replayPositionChanged =
    control.daysAdvanced !== baseline.daysAdvanced ||
    control.simulatedDate !== baseline.simulatedDate ||
    (control.lastReleasedGameCount ?? 0) !== baseline.lastReleasedGameCount ||
    (control.totalReleasedGameCount ?? 0) !== baseline.totalReleasedGameCount;
  const controlCopyChanged =
    control.lastError !== baseline.lastError ||
    (control.message ?? '') !== baseline.message ||
    getUpdatedAtFingerprint(control.updatedAt) !== baseline.updatedAtFingerprint;
  const terminalStatusChanged =
    control.status !== baseline.status &&
    (control.status === 'ready' || control.status === 'error');
  const belongsToCurrentRequest =
    nextSawServerStart || replayPositionChanged || controlCopyChanged || terminalStatusChanged;

  if (belongsToCurrentRequest && control.status === 'ready') {
    return {
      state: 'ready',
      sawServerStart: nextSawServerStart,
    };
  }

  if (belongsToCurrentRequest && control.status === 'error') {
    return {
      state: 'error',
      sawServerStart: nextSawServerStart,
    };
  }

  return {
    state: 'pending',
    sawServerStart: nextSawServerStart,
  };
}
