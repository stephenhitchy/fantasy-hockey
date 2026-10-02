export interface PlayerIntelRecentFormSource {
  recentFormSampleSize?: number | null;
  recentThreeGameFantasyPointsPerGame?: number | null;
  recentFiveGameFantasyPointsPerGame?: number | null;
  recentTenGameFantasyPointsPerGame?: number | null;
  recentTwentyGameFantasyPointsPerGame?: number | null;
}

export interface PlayerIntelRecentPaceCard {
  label: string;
  appearances: number;
  value: number;
}

const RECENT_PACE_WINDOWS = [
  ['recentThreeGameFantasyPointsPerGame', 3],
  ['recentFiveGameFantasyPointsPerGame', 5],
  ['recentTenGameFantasyPointsPerGame', 10],
  ['recentTwentyGameFantasyPointsPerGame', 20],
] as const;

function finiteNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Projection V11 may use a prior-season form sample early in a new season.
 * Cards name the appearances actually represented and collapse duplicate
 * windows so one observed game can never masquerade as four sample sizes.
 */
export function buildPlayerIntelRecentPaceCards(
  source: PlayerIntelRecentFormSource,
): PlayerIntelRecentPaceCard[] {
  const sampleSize = finiteNonNegativeInteger(source.recentFormSampleSize);
  const representedSamples = new Set<number>();
  const cards: PlayerIntelRecentPaceCard[] = [];

  if (sampleSize === 0) {
    return cards;
  }

  for (const [field, windowSize] of RECENT_PACE_WINDOWS) {
    const value = source[field];
    const appearances = Math.min(sampleSize, windowSize);

    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      representedSamples.has(appearances)
    ) {
      continue;
    }

    representedSamples.add(appearances);
    cards.push({
      label: appearances === 1 ? 'Last game' : `Last ${appearances}`,
      appearances,
      value,
    });
  }

  return cards;
}

export function formatPlayerIntelSeasonLabel(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  const match = /^(\d{4})(\d{4})$/.exec(normalized);

  if (!match) {
    return normalized;
  }

  return `${match[1]}–${match[2].slice(2)}`;
}
