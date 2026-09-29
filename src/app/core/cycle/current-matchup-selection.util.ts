import type { FantasyCycle, FantasyMatchup } from './cycle.models';

/**
 * Limits current-matchup navigation to every active cycle plus the most recent
 * completed cycle used as the fallback once a manager has no unfinished game.
 */
export function selectCurrentMatchupCycles(cycles: readonly FantasyCycle[]): FantasyCycle[] {
  const orderedCycles = [...cycles].sort(
    (first, second) => first.cycleNumber - second.cycleNumber,
  );
  const activeCycles = orderedCycles.filter((cycle) => cycle.status === 'active');
  const latestCompletedCycle = [...orderedCycles]
    .reverse()
    .find((cycle) => cycle.status === 'complete');
  const selectedCycles = [...activeCycles];

  if (
    latestCompletedCycle &&
    !selectedCycles.some(
      (cycle) => cycle.cycleNumber === latestCompletedCycle.cycleNumber,
    )
  ) {
    selectedCycles.push(latestCompletedCycle);
  }

  if (selectedCycles.length === 0 && orderedCycles.length > 0) {
    selectedCycles.push(orderedCycles[orderedCycles.length - 1]);
  }

  return selectedCycles.sort((first, second) => first.cycleNumber - second.cycleNumber);
}

/**
 * Resolves one stable current matchup for every participant from the same
 * authoritative cycle snapshot. Both sides of a matchup therefore receive the
 * same route, while managers with overlapping active cycles get their earliest
 * unfinished matchup before falling back to their most recent completed one.
 */
export function selectCurrentMatchupsByOwner(
  cycles: readonly FantasyCycle[],
  matchupsByCycle: ReadonlyMap<number, readonly FantasyMatchup[]>,
): ReadonlyMap<string, FantasyMatchup> {
  const ownerMatchups = new Map<
    string,
    Array<{ cycleNumber: number; matchup: FantasyMatchup }>
  >();

  for (const cycle of cycles) {
    for (const matchup of matchupsByCycle.get(cycle.cycleNumber) ?? []) {
      const ownerIds = [matchup.teamAOwnerId, matchup.teamBOwnerId].filter(
        (ownerId): ownerId is string => Boolean(ownerId),
      );

      for (const ownerId of ownerIds) {
        const entries = ownerMatchups.get(ownerId) ?? [];
        entries.push({ cycleNumber: cycle.cycleNumber, matchup });
        ownerMatchups.set(ownerId, entries);
      }
    }
  }

  const selections = new Map<string, FantasyMatchup>();

  for (const [ownerId, entries] of ownerMatchups) {
    entries.sort((first, second) => {
      if (first.cycleNumber !== second.cycleNumber) {
        return first.cycleNumber - second.cycleNumber;
      }

      return first.matchup.id.localeCompare(second.matchup.id);
    });

    const selected =
      entries.find(({ matchup }) => matchup.status !== 'complete') ??
      entries[entries.length - 1];

    if (selected) {
      selections.set(ownerId, selected.matchup);
    }
  }

  return selections;
}
