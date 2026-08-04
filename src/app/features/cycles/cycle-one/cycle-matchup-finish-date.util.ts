import type { NhlTeamSeasonGame } from '../../../core/nhl/nhl-api.service';

export interface MatchupFinishSlotInput {
  ownerId: string;
  rosterSlotId: string;
  teamAbbreviation: string | null;
  currentScheduledGameDates?: readonly string[];
  previousLastScheduledGameDate?: string | null;
}

export interface MatchupFinishDateInput {
  slots: readonly MatchupFinishSlotInput[];
  schedulesByTeam: Readonly<Record<string, readonly NhlTeamSeasonGame[]>>;
  requiredGamesPerWindow: number;
  fallbackStartDate?: string | null;
}

export type MatchupFinishDateConfidence =
  | 'scheduled'
  | 'projected'
  | 'partial'
  | 'unavailable';

export interface MatchupFinishDateResult {
  finishDate: string | null;
  confidence: MatchupFinishDateConfidence;
  totalSlotCount: number;
  resolvedSlotCount: number;
  scheduledSlotCount: number;
  projectedSlotCount: number;
  unresolvedSlotCount: number;
}

function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sortedUniqueDateKeys(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(isDateKey))].sort((first, second) =>
    first.localeCompare(second),
  );
}

function getTeamScheduleDates(
  schedulesByTeam: MatchupFinishDateInput['schedulesByTeam'],
  teamAbbreviation: string | null,
): string[] {
  if (!teamAbbreviation) {
    return [];
  }

  return sortedUniqueDateKeys(
    schedulesByTeam[teamAbbreviation.toUpperCase()]?.map((game) => game.gameDate),
  );
}

function resolveSlotFinishDate(input: {
  slot: MatchupFinishSlotInput;
  schedulesByTeam: MatchupFinishDateInput['schedulesByTeam'];
  requiredGamesPerWindow: number;
  fallbackStartDate: string | null;
}): { finishDate: string | null; source: 'scheduled' | 'projected' | 'unavailable' } {
  const requiredGames = Math.max(1, Math.floor(input.requiredGamesPerWindow));
  const currentDates = sortedUniqueDateKeys(input.slot.currentScheduledGameDates);

  if (currentDates.length >= requiredGames) {
    return {
      finishDate: currentDates[requiredGames - 1],
      source: 'scheduled',
    };
  }

  const scheduleDates = getTeamScheduleDates(
    input.schedulesByTeam,
    input.slot.teamAbbreviation,
  );

  if (scheduleDates.length === 0) {
    return {
      finishDate: null,
      source: 'unavailable',
    };
  }

  const remainingGames = requiredGames - currentDates.length;
  const currentBoundary = currentDates.at(-1) ?? null;
  const previousBoundary = isDateKey(input.slot.previousLastScheduledGameDate)
    ? input.slot.previousLastScheduledGameDate
    : null;
  const fallbackStart = isDateKey(input.fallbackStartDate)
    ? input.fallbackStartDate
    : null;
  const boundary = currentBoundary ?? previousBoundary ?? fallbackStart;

  if (!boundary) {
    return {
      finishDate: null,
      source: 'unavailable',
    };
  }

  const eligibleDates = scheduleDates.filter((gameDate) => {
    if (currentBoundary || previousBoundary) {
      // A new roster-slot window starts only after the prior assignment's
      // sixth scheduled NHL team game. A same-date game is not presumed to be
      // eligible because the earlier game may not have been final yet.
      return gameDate > boundary;
    }

    // Matchup 1 can begin on a day that still has unstarted NHL games.
    return gameDate >= boundary;
  });

  if (eligibleDates.length < remainingGames) {
    return {
      finishDate: null,
      source: 'unavailable',
    };
  }

  return {
    finishDate: eligibleDates[remainingGames - 1],
    source: 'projected',
  };
}

function getLaterIsoDate(
  currentDate: string | null,
  candidateDate: string,
): string {
  if (currentDate === null) {
    return candidateDate;
  }

  return candidateDate.localeCompare(currentDate) > 0
    ? candidateDate
    : currentDate;
}

/**
 * Returns the latest expected finish date across every active roster slot in
 * one fantasy matchup. RinkRat matchups do not share a league-wide clock: the
 * matchup ends when the slower team's final independent six-game slot window
 * finishes. Existing immutable window dates are preferred. A slot that has not
 * opened yet is projected from its prior boundary and the incoming/current
 * player's NHL team schedule.
 */
export function calculateMatchupFinishDate(
  input: MatchupFinishDateInput,
): MatchupFinishDateResult {
  const deduplicatedSlots = new Map<string, MatchupFinishSlotInput>();

  for (const slot of input.slots) {
    if (!slot.ownerId || !slot.rosterSlotId) {
      continue;
    }

    deduplicatedSlots.set(`${slot.ownerId}::${slot.rosterSlotId}`, slot);
  }

  let finishDate: string | null = null;
  let scheduledSlotCount = 0;
  let projectedSlotCount = 0;

  for (const slot of deduplicatedSlots.values()) {
    const resolved = resolveSlotFinishDate({
      slot,
      schedulesByTeam: input.schedulesByTeam,
      requiredGamesPerWindow: input.requiredGamesPerWindow,
      fallbackStartDate: input.fallbackStartDate ?? null,
    });

    if (!resolved.finishDate) {
      continue;
    }

    finishDate = getLaterIsoDate(finishDate, resolved.finishDate);

    if (resolved.source === 'scheduled') {
      scheduledSlotCount += 1;
    } else {
      projectedSlotCount += 1;
    }
  }

  const totalSlotCount = deduplicatedSlots.size;
  const resolvedSlotCount = scheduledSlotCount + projectedSlotCount;
  const unresolvedSlotCount = Math.max(0, totalSlotCount - resolvedSlotCount);
  const confidence: MatchupFinishDateConfidence =
    totalSlotCount === 0 || resolvedSlotCount === 0
      ? 'unavailable'
      : unresolvedSlotCount > 0
        ? 'partial'
        : projectedSlotCount > 0
          ? 'projected'
          : 'scheduled';

  return {
    finishDate,
    confidence,
    totalSlotCount,
    resolvedSlotCount,
    scheduledSlotCount,
    projectedSlotCount,
    unresolvedSlotCount,
  };
}
