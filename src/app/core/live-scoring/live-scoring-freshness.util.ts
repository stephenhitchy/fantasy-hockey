import type {
  SharedCycleScoringSnapshot,
  SharedLiveScoringControl,
} from './live-scoring.models';

export type LiveScoringFreshnessTone =
  | 'fresh'
  | 'scheduled'
  | 'working'
  | 'delayed'
  | 'error'
  | 'waiting'
  | 'complete';

export interface LiveScoringFreshnessViewModel {
  tone: LiveScoringFreshnessTone;
  statusLabel: string;
  title: string;
  summary: string;
  lastCheckedLabel: string;
  lastChangedLabel: string;
  nextCheckLabel: string;
  lastCheckedAt: number | null;
  lastChangedAt: number | null;
  nextCheckAt: number | null;
  explanation: string;
  ariaLabel: string;
}

export interface LiveScoringFreshnessInput {
  control: SharedLiveScoringControl | null;
  snapshot: SharedCycleScoringSnapshot | null;
  cycleStatus?: string | null;
  nowMilliseconds?: number;
}

const SCORE_CHECK_GRACE_MILLISECONDS = 5 * 60 * 1000;
const SCORE_DELAY_WARNING_MILLISECONDS = 15 * 60 * 1000;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function liveScoringTimestampMilliseconds(value: unknown): number | null {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  if (isUnknownRecord(value)) {
    const toMillis = value['toMillis'];

    if (typeof toMillis === 'function') {
      const milliseconds = toMillis.call(value);
      return typeof milliseconds === 'number' && Number.isFinite(milliseconds)
        ? milliseconds
        : null;
    }

    const seconds = value['seconds'];
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      const rawNanoseconds = value['nanoseconds'];
      const nanoseconds =
        typeof rawNanoseconds === 'number' && Number.isFinite(rawNanoseconds)
          ? rawNanoseconds
          : 0;
      return seconds * 1000 + Math.floor(nanoseconds / 1_000_000);
    }
  }

  return null;
}

export function formatLiveScoringRelativeAge(
  timestampMilliseconds: number | null,
  nowMilliseconds = Date.now(),
): string {
  if (timestampMilliseconds === null) {
    return 'Not yet';
  }

  const elapsed = Math.max(0, nowMilliseconds - timestampMilliseconds);
  const seconds = Math.floor(elapsed / 1000);

  if (seconds < 15) {
    return 'Just now';
  }

  if (seconds < 60) {
    return `${seconds} sec ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatLiveScoringCountdown(
  timestampMilliseconds: number | null,
  nowMilliseconds = Date.now(),
): string {
  if (timestampMilliseconds === null) {
    return 'Automatic';
  }

  const remaining = timestampMilliseconds - nowMilliseconds;
  if (remaining <= 0) {
    const overdueMinutes = Math.floor(Math.abs(remaining) / (60 * 1000));
    return overdueMinutes < 1 ? 'Due now' : `${overdueMinutes} min overdue`;
  }

  const minutes = Math.ceil(remaining / (60 * 1000));
  if (minutes < 60) {
    return `In ${minutes} min`;
  }

  const hours = Math.ceil(minutes / 60);
  return `In ${hours} hr${hours === 1 ? '' : 's'}`;
}

function lastPublishedMilliseconds(
  snapshot: SharedCycleScoringSnapshot | null,
): number | null {
  return (
    liveScoringTimestampMilliseconds(snapshot?.refreshedAt) ??
    liveScoringTimestampMilliseconds(snapshot?.result?.refreshedAt) ??
    liveScoringTimestampMilliseconds(snapshot?.updatedAt)
  );
}

function isHistoricalReplay(control: SharedLiveScoringControl | null): boolean {
  return (
    control?.historicalReplayEnabled === true ||
    control?.automationMode === 'historical-replay'
  );
}

export function buildLiveScoringFreshnessViewModel(
  input: LiveScoringFreshnessInput,
): LiveScoringFreshnessViewModel {
  const nowMilliseconds = input.nowMilliseconds ?? Date.now();
  const control = input.control;
  const snapshot = input.snapshot;
  const lastCheckedAt = liveScoringTimestampMilliseconds(
    control?.lastRefreshCompletedAt,
  );
  const lastChangedAt = lastPublishedMilliseconds(snapshot);
  const nextCheckAt = liveScoringTimestampMilliseconds(control?.nextRefreshAt);
  const historicalReplay = isHistoricalReplay(control);
  const cycleComplete = input.cycleStatus === 'complete';
  const hasLiveGames = snapshot?.result?.hasLiveGames === true;

  const base = {
    lastCheckedAt,
    lastChangedAt,
    nextCheckAt,
    lastCheckedLabel: formatLiveScoringRelativeAge(lastCheckedAt, nowMilliseconds),
    lastChangedLabel: formatLiveScoringRelativeAge(lastChangedAt, nowMilliseconds),
    nextCheckLabel: cycleComplete
      ? 'Complete'
      : formatLiveScoringCountdown(nextCheckAt, nowMilliseconds),
    explanation:
      'These timestamps show when RinkRat checked and published fantasy scores. Official NHL stat corrections may arrive later, so this is not an upstream NHL correction timestamp.',
  };

  let view: Omit<LiveScoringFreshnessViewModel, keyof typeof base | 'ariaLabel'>;

  if (cycleComplete) {
    view = {
      tone: 'complete',
      statusLabel: 'Final',
      title: 'Final matchup scores are saved',
      summary:
        'This matchup is complete. The displayed totals are the saved competitive record for this matchup period.',
    };
  } else if (control?.status === 'error') {
    view = {
      tone: 'error',
      statusLabel: 'Needs attention',
      title: 'Fantasy score updates need attention',
      summary:
        control.lastError ||
        'The last automatic score check did not finish. RinkRat will retry automatically, and a commissioner can request a refresh if the problem continues.',
    };
  } else if (control?.status === 'refreshing') {
    view = {
      tone: 'working',
      statusLabel: 'Updating',
      title: historicalReplay
        ? 'Updating historical fantasy scores'
        : 'Checking NHL results now',
      summary:
        'RinkRat is calculating one shared fantasy snapshot so every manager in this league sees the same scoring result.',
    };
  } else if (!control) {
    view = {
      tone: 'waiting',
      statusLabel: 'Starting',
      title: 'Waiting for the shared scorer',
      summary:
        'The trusted server scorer will create its first timing record during the next scheduled or requested score check.',
    };
  } else if (lastCheckedAt === null) {
    view = {
      tone: 'waiting',
      statusLabel: 'Waiting',
      title: 'Waiting for the first score check',
      summary:
        'RinkRat has not completed a shared score check for this league yet. Automatic scoring will begin around NHL game activity.',
    };
  } else if (historicalReplay) {
    view = {
      tone: 'fresh',
      statusLabel: 'Replay',
      title: 'Historical replay scoring is on schedule',
      summary:
        'The saved replay date controls when historical NHL results are released. Every manager reads the same shared fantasy snapshot.',
    };
  } else {
    const overdueMilliseconds =
      nextCheckAt === null ? null : nowMilliseconds - nextCheckAt;

    if (
      overdueMilliseconds !== null &&
      overdueMilliseconds > SCORE_DELAY_WARNING_MILLISECONDS
    ) {
      view = {
        tone: 'delayed',
        statusLabel: 'Delayed',
        title: 'Fantasy score updates may be delayed',
        summary:
          'The next automatic check is later than expected. The server will keep retrying; use the commissioner refresh only if this status persists.',
      };
    } else if (
      overdueMilliseconds !== null &&
      overdueMilliseconds > SCORE_CHECK_GRACE_MILLISECONDS
    ) {
      view = {
        tone: 'scheduled',
        statusLabel: 'Due',
        title: 'An automatic score check is due',
        summary:
          'The scheduled check is slightly overdue but still within the normal recovery window. RinkRat will continue retrying automatically.',
      };
    } else {
      view = {
        tone: 'fresh',
        statusLabel: hasLiveGames ? 'Live' : 'On schedule',
        title: hasLiveGames
          ? 'Live fantasy scores are on schedule'
          : 'Fantasy scores are on schedule',
        summary: hasLiveGames
          ? 'RinkRat checks NHL results on an automatic cadence while games are active and publishes a new snapshot only when fantasy scoring changes.'
          : 'RinkRat checks more often around NHL game activity and less often when no relevant game is active.',
      };
    }
  }

  const ariaLabel = [
    view.title,
    `Last checked ${base.lastCheckedLabel}.`,
    `Last score change ${base.lastChangedLabel}.`,
    `Next check ${base.nextCheckLabel}.`,
  ].join(' ');

  return {
    ...base,
    ...view,
    ariaLabel,
  };
}
