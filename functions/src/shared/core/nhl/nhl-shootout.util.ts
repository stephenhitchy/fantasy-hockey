import type {
  NhlGamePlayByPlayResponse,
} from './nhl-api.service';

interface ShootoutGoalAttribution {
  eventId: number | null;
  playerId: number | null;
  teamId: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function getShootoutGoalAttribution(play: unknown): ShootoutGoalAttribution | null {
  if (!isRecord(play) || typeof play['typeDescKey'] !== 'string') {
    return null;
  }

  const periodDescriptor = play['periodDescriptor'];
  const details = play['details'];

  if (
    play['typeDescKey'].trim().toLowerCase() !== 'goal' ||
    !isRecord(periodDescriptor) ||
    typeof periodDescriptor['periodType'] !== 'string' ||
    periodDescriptor['periodType'].trim().toUpperCase() !== 'SO' ||
    !isRecord(details)
  ) {
    return null;
  }

  return {
    eventId: positiveInteger(play['eventId']),
    playerId: positiveInteger(details['scoringPlayerId']),
    teamId: positiveInteger(details['eventOwnerTeamId']),
  };
}

function countShootoutGoals(
  playByPlay: NhlGamePlayByPlayResponse,
  matches: (attribution: ShootoutGoalAttribution) => boolean,
): number {
  const seenEventIds = new Set<number>();
  let count = 0;

  for (const play of Array.isArray(playByPlay?.plays) ? playByPlay.plays : []) {
    const attribution = getShootoutGoalAttribution(play);
    if (!attribution || !matches(attribution)) continue;
    if (attribution.eventId !== null) {
      if (seenEventIds.has(attribution.eventId)) continue;
      seenEventIds.add(attribution.eventId);
    }
    count += 1;
  }

  return count;
}

/**
 * NHL boxscores intentionally exclude shootout attempts from ordinary player
 * goals. Play-by-play is therefore the stable source for RinkRat's separate
 * Shootout Goal category.
 */
export function getSkaterShootoutGoals(
  playByPlay: NhlGamePlayByPlayResponse,
  playerId: number,
): number {
  if (!Number.isInteger(playerId) || playerId <= 0) {
    return 0;
  }

  return countShootoutGoals(
    playByPlay,
    (attribution) => attribution.playerId === playerId,
  );
}

/** Count successful shootout attempts owned by one exact NHL team. */
export function getTeamShootoutGoals(
  playByPlay: NhlGamePlayByPlayResponse,
  teamId: number | null | undefined,
): number {
  if (!Number.isInteger(teamId) || Number(teamId) <= 0) {
    return 0;
  }

  return countShootoutGoals(
    playByPlay,
    (attribution) => attribution.teamId === teamId,
  );
}
