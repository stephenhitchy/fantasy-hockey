export type HistoricalReplayRosterMoveStatus =
  | 'inactive'
  | 'queued'
  | 'advancing'
  | 'ready'
  | 'error';

export interface HistoricalReplayRosterMoveControlLike {
  enabled?: boolean;
  status?: HistoricalReplayRosterMoveStatus | string;
  targetSeason?: string;
  simulatedDate?: string | null;
  seasonStartDate?: string | null;
  daysAdvanced?: number;
  lastReleasedGameCount?: number;
  totalReleasedGameCount?: number;
}

export interface LiveRosterMoveReplayContext {
  mode: 'live';
  safePregameRecovery: false;
}

export interface HistoricalRosterMoveReplayContext {
  mode: 'historical-replay';
  seasonOverride: string;
  completedThroughDate: string;
  safePregameRecovery: boolean;
}

export interface BlockedRosterMoveReplayContext {
  mode: 'blocked';
  message: string;
  safePregameRecovery: false;
}

export type RosterMoveReplayContext =
  | LiveRosterMoveReplayContext
  | HistoricalRosterMoveReplayContext
  | BlockedRosterMoveReplayContext;

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

function normalizeSeason(value: unknown): string | null {
  return typeof value === 'string' && /^\d{8}$/.test(value.trim())
    ? value.trim()
    : null;
}

function subtractUtcDay(value: string): string | null {
  const parsed = new Date(`${value}T12:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function hasVerifiedNoReleasedReplayGames(
  control: HistoricalReplayRosterMoveControlLike,
): boolean {
  return (
    typeof control.totalReleasedGameCount === 'number' &&
    Number.isFinite(control.totalReleasedGameCount) &&
    typeof control.lastReleasedGameCount === 'number' &&
    Number.isFinite(control.lastReleasedGameCount) &&
    control.totalReleasedGameCount <= 0 &&
    control.lastReleasedGameCount <= 0
  );
}

function getSafePregameEvaluationDate(
  control: HistoricalReplayRosterMoveControlLike,
): string | null {
  const seasonStartDate = normalizeIsoDate(control.seasonStartDate);

  if (seasonStartDate) {
    return subtractUtcDay(seasonStartDate);
  }

  return normalizeIsoDate(control.simulatedDate);
}

/**
 * Determines which NHL date the add/drop timing check may safely use.
 *
 * An errored historical replay normally blocks roster timing because the
 * failed date could have partially released NHL games. Before any NHL game has
 * been released, however, every roster slot is still at 0/6. In that narrow
 * pregame state, ownership and untouched Matchup 1 moves remain deterministic
 * and can safely use the last saved pregame date while replay recovery waits.
 */
export function resolveRosterMoveReplayContext(
  control: HistoricalReplayRosterMoveControlLike | null | undefined,
): RosterMoveReplayContext {
  if (!control?.enabled) {
    return {
      mode: 'live',
      safePregameRecovery: false,
    };
  }

  if (control.status === 'queued' || control.status === 'advancing') {
    return {
      mode: 'blocked',
      safePregameRecovery: false,
      message:
        control.status === 'queued'
          ? 'Historical replay is queued for this league. Wait for the queued replay day to finish before checking or submitting this roster move.'
          : 'Historical replay is advancing to the next day. Wait for the replay to finish before checking or submitting this roster move.',
    };
  }

  const targetSeason = normalizeSeason(control.targetSeason);
  const simulatedDate = normalizeIsoDate(control.simulatedDate);

  if (control.status === 'ready') {
    if (!targetSeason || !simulatedDate) {
      return {
        mode: 'blocked',
        safePregameRecovery: false,
        message:
          'The historical replay date is not ready yet. Wait a moment and retry the add/drop timing check.',
      };
    }

    return {
      mode: 'historical-replay',
      seasonOverride: targetSeason,
      completedThroughDate: simulatedDate,
      safePregameRecovery: false,
    };
  }

  if (
    (control.status === 'error' || control.status === 'inactive') &&
    hasVerifiedNoReleasedReplayGames(control)
  ) {
    const safeDate = getSafePregameEvaluationDate(control);

    if (targetSeason && safeDate) {
      return {
        mode: 'historical-replay',
        seasonOverride: targetSeason,
        completedThroughDate: safeDate,
        safePregameRecovery: true,
      };
    }
  }

  if (control.status === 'error') {
    return {
      mode: 'blocked',
      safePregameRecovery: false,
      message:
        'Historical replay must recover from its last error before RinkRat can determine the correct add/drop matchup. Retry the failed replay date from Game Center so no already-released game can be acquired retroactively.',
    };
  }

  return {
    mode: 'blocked',
    safePregameRecovery: false,
    message:
      'The historical replay date is not ready yet. Wait a moment and retry the add/drop timing check.',
  };
}
