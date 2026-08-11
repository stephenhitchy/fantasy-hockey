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
  lastReleasedGameCount?: number;
  totalReleasedGameCount?: number;
}

export type ServerRosterMoveReplayContext =
  | {
      mode: 'live';
      safePregameRecovery: false;
    }
  | {
      mode: 'historical-replay';
      seasonOverride: string;
      completedThroughDate: string;
      safePregameRecovery: boolean;
    }
  | {
      mode: 'blocked';
      message: string;
      safePregameRecovery: false;
    };

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
  return typeof control.totalReleasedGameCount === 'number' &&
    Number.isFinite(control.totalReleasedGameCount) &&
    typeof control.lastReleasedGameCount === 'number' &&
    Number.isFinite(control.lastReleasedGameCount) &&
    control.totalReleasedGameCount <= 0 &&
    control.lastReleasedGameCount <= 0;
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
 * Server mirror of the client roster-move replay decision.
 *
 * An errored replay blocks roster timing once any NHL game has been released.
 * Before the first released game, every slot is still untouched at 0/6, so a
 * saved pregame date is sufficient for a fair Matchup 1 roster decision.
 */
export function resolveServerRosterMoveReplayContext(
  control: HistoricalReplayRosterMoveControlLike | null | undefined,
): ServerRosterMoveReplayContext {
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
          ? 'Historical replay is queued. Wait for the queued replay day to finish before changing this roster.'
          : 'Historical replay is advancing. Wait for the replay day to finish before changing this roster.',
    };
  }

  const targetSeason = normalizeSeason(control.targetSeason);
  const simulatedDate = normalizeIsoDate(control.simulatedDate);

  if (control.status === 'ready') {
    if (!targetSeason || !simulatedDate) {
      return {
        mode: 'blocked',
        safePregameRecovery: false,
        message: 'The historical replay date is not ready for roster timing.',
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
        'Historical replay must recover from its failed date before this roster move can be timed safely.',
    };
  }

  return {
    mode: 'blocked',
    safePregameRecovery: false,
    message: 'The historical replay date is not ready for roster timing.',
  };
}
