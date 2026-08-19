type FantasyRoster = import('../team/roster.models').FantasyRoster;
type RosterAsset = import('../team/roster.models').RosterAsset;
type LeaguePlayerBoardRow = import('./league-player-board.util').LeaguePlayerBoardRow;

export type LeaguePlayerRosterFitTier =
  | 'strong'
  | 'possible'
  | 'speculative'
  | 'limited'
  | 'insufficient';

export type LeaguePlayerRosterFitConfidence = 'high' | 'medium' | 'low';

export interface LeaguePlayerRosterFitRecommendation {
  assetKey: string;
  tier: LeaguePlayerRosterFitTier;
  confidence: LeaguePlayerRosterFitConfidence;
  hasOpenSlot: boolean;
  comparisonAssetKey: string | null;
  comparisonName: string | null;
  comparisonArea: 'active' | 'bench' | null;
  nextSixEdge: number | null;
  restOfSeasonEdge: number | null;
  expectedGamesAvailable: number | null;
  reliability: number | null;
  candidateNextSix: number | null;
  candidateRestOfSeason: number | null;
  summary: string;
  factors: string[];
  risks: string[];
  detailLines: string[];
}

export interface BuildLeaguePlayerRosterFitInput {
  rows: readonly LeaguePlayerBoardRow[];
  roster: FantasyRoster | null;
  requiredGames?: number;
}

const TIER_ORDER: Readonly<Record<LeaguePlayerRosterFitTier, number>> = {
  strong: 5,
  possible: 4,
  speculative: 3,
  limited: 2,
  insufficient: 1,
};

const CONFIDENCE_ORDER: Readonly<Record<LeaguePlayerRosterFitConfidence, number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatSigned(value: number): string {
  const rounded = roundOne(value);
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

function formatPoints(value: number | null): string {
  return value === null ? '—' : roundOne(value).toFixed(1);
}

function rosterAssetKey(asset: RosterAsset | null | undefined): string | null {
  if (!asset) {
    return null;
  }

  if (typeof asset.assetKey === 'string' && asset.assetKey.trim()) {
    return asset.assetKey.trim();
  }

  return asset.assetType === 'skater'
    ? `skater-${asset.player.id}`
    : `goalie-unit-${asset.teamAbbreviation}`;
}

function metricAscending(
  first: LeaguePlayerBoardRow,
  second: LeaguePlayerBoardRow,
): number {
  const firstNext = first.nextSixProjection ?? Number.POSITIVE_INFINITY;
  const secondNext = second.nextSixProjection ?? Number.POSITIVE_INFINITY;

  if (firstNext !== secondNext) {
    return firstNext - secondNext;
  }

  const firstRos = first.restOfSeasonProjection ?? Number.POSITIVE_INFINITY;
  const secondRos = second.restOfSeasonProjection ?? Number.POSITIVE_INFINITY;

  if (firstRos !== secondRos) {
    return firstRos - secondRos;
  }

  const firstSeason = first.seasonFantasyPoints ?? Number.POSITIVE_INFINITY;
  const secondSeason = second.seasonFantasyPoints ?? Number.POSITIVE_INFINITY;

  return firstSeason - secondSeason ||
    first.name.localeCompare(second.name) ||
    first.assetKey.localeCompare(second.assetKey);
}

function positionNextSixPercentile(row: LeaguePlayerBoardRow): number | null {
  const rank = row.nextSixPositionRank;
  const count = row.nextSixPositionRankCount;

  if (rank === null || count <= 0) {
    return null;
  }

  if (count === 1) {
    return 1;
  }

  return Math.max(0, Math.min(1, 1 - ((rank - 1) / (count - 1))));
}

function normalizeExpectedGames(
  row: LeaguePlayerBoardRow,
  requiredGames: number,
): number | null {
  const available = finiteNumberOrNull(row.expectedGamesAvailable);

  if (available !== null) {
    return Math.max(0, Math.min(requiredGames, roundOne(available)));
  }

  const missed = finiteNumberOrNull(row.expectedGamesMissed);
  return missed === null
    ? null
    : Math.max(0, Math.min(requiredGames, roundOne(requiredGames - missed)));
}

function normalizedReliability(row: LeaguePlayerBoardRow): number | null {
  const values = [row.reliabilityRating, row.projectionConfidence]
    .map(finiteNumberOrNull)
    .filter((value): value is number => value !== null)
    .map((value) => Math.max(0, Math.min(100, value)));

  if (values.length === 0) {
    return null;
  }

  return roundOne(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function resolveConfidence(
  evidenceCount: number,
  reliability: number | null,
): LeaguePlayerRosterFitConfidence {
  if (evidenceCount >= 4 && reliability !== null && reliability >= 70) {
    return 'high';
  }

  if (evidenceCount >= 3 && reliability !== null && reliability >= 50) {
    return 'medium';
  }

  return 'low';
}


function rowAvailabilityLabel(row: LeaguePlayerBoardRow): string | null {
  const values = [
    row.availabilityLabel,
    row.asset.availabilityLabel,
    row.asset.availabilityStatus,
  ];

  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function isHealthyAvailability(label: string | null): boolean {
  if (!label) {
    return true;
  }

  const normalized = label.trim().toLocaleLowerCase();
  return normalized === 'active' ||
    normalized === 'healthy' ||
    normalized === 'available';
}

function capTier(
  tier: LeaguePlayerRosterFitTier,
  maximum: LeaguePlayerRosterFitTier,
): LeaguePlayerRosterFitTier {
  return TIER_ORDER[tier] > TIER_ORDER[maximum] ? maximum : tier;
}

function buildTier(options: {
  hasOpenSlot: boolean;
  comparison: LeaguePlayerBoardRow | null;
  nextSixEdge: number | null;
  restOfSeasonEdge: number | null;
  expectedGames: number | null;
  confidence: LeaguePlayerRosterFitConfidence;
  positionPercentile: number | null;
  availabilityLabel: string | null;
  requiredGames: number;
  candidateNextSix: number | null;
  candidateRestOfSeason: number | null;
}): LeaguePlayerRosterFitTier {
  if (options.candidateNextSix === null && options.candidateRestOfSeason === null) {
    return 'insufficient';
  }

  let tier: LeaguePlayerRosterFitTier;

  if (options.hasOpenSlot) {
    if (
      options.candidateNextSix !== null &&
      (options.positionPercentile ?? 0) >= 0.65 &&
      (options.expectedGames ?? options.requiredGames) >= options.requiredGames - 1 &&
      options.confidence !== 'low'
    ) {
      tier = 'strong';
    } else if (
      options.candidateNextSix !== null &&
      (options.expectedGames ?? options.requiredGames) >= options.requiredGames - 2
    ) {
      tier = 'possible';
    } else {
      tier = 'speculative';
    }
  } else if (!options.comparison) {
    tier = 'insufficient';
  } else {
    const nextEdge = options.nextSixEdge;
    const rosEdge = options.restOfSeasonEdge;
    const strongNext = nextEdge !== null && nextEdge >= 4;
    const positiveNext = nextEdge !== null && nextEdge >= 0;
    const strongRos = rosEdge !== null && rosEdge >= 25;
    const positiveRos = rosEdge !== null && rosEdge >= 0;
    const gamesReady = (options.expectedGames ?? options.requiredGames) >= options.requiredGames - 1;
    const gamesUsable = (options.expectedGames ?? options.requiredGames) >= options.requiredGames - 2;

    if (
      gamesReady &&
      options.confidence !== 'low' &&
      ((strongNext && (rosEdge === null || positiveRos)) ||
        (strongRos && (nextEdge === null || nextEdge >= 2)))
    ) {
      tier = 'strong';
    } else if (gamesUsable && (positiveNext || positiveRos)) {
      tier = 'possible';
    } else if (
      positiveNext ||
      positiveRos ||
      (options.positionPercentile ?? 0) >= 0.75
    ) {
      tier = 'speculative';
    } else {
      tier = 'limited';
    }
  }

  if (options.expectedGames !== null && options.expectedGames <= 2) {
    tier = capTier(tier, 'limited');
  } else if (options.expectedGames !== null && options.expectedGames <= 4) {
    tier = capTier(tier, 'speculative');
  }

  if (!isHealthyAvailability(options.availabilityLabel)) {
    tier = capTier(tier, 'speculative');
  }

  if (options.confidence === 'low') {
    tier = capTier(tier, 'possible');
  }

  return tier;
}

function confidenceLabel(confidence: LeaguePlayerRosterFitConfidence): string {
  return confidence === 'high'
    ? 'High confidence'
    : confidence === 'medium'
      ? 'Medium confidence'
      : 'Low confidence';
}

function tierLabel(tier: LeaguePlayerRosterFitTier): string {
  switch (tier) {
    case 'strong':
      return 'Strong fit';
    case 'possible':
      return 'Possible fit';
    case 'speculative':
      return 'Speculative';
    case 'limited':
      return 'Limited fit';
    default:
      return 'More data needed';
  }
}

function buildRecommendation(options: {
  candidate: LeaguePlayerBoardRow;
  comparison: LeaguePlayerBoardRow | null;
  comparisonArea: 'active' | 'bench' | null;
  hasOpenSlot: boolean;
  requiredGames: number;
}): LeaguePlayerRosterFitRecommendation {
  const candidate = options.candidate;
  const comparison = options.comparison;
  const nextSixEdge = candidate.nextSixProjection !== null &&
      comparison !== null &&
      comparison.nextSixProjection !== null
    ? roundOne(candidate.nextSixProjection - comparison.nextSixProjection)
    : null;
  const restOfSeasonEdge = candidate.restOfSeasonProjection !== null &&
      comparison !== null &&
      comparison.restOfSeasonProjection !== null
    ? roundOne(candidate.restOfSeasonProjection - comparison.restOfSeasonProjection)
    : null;
  const expectedGames = normalizeExpectedGames(candidate, options.requiredGames);
  const reliability = normalizedReliability(candidate);
  const positionPercentile = positionNextSixPercentile(candidate);
  const evidenceCount = [
    candidate.nextSixProjection !== null && (options.hasOpenSlot || comparison?.nextSixProjection !== null),
    candidate.restOfSeasonProjection !== null && (options.hasOpenSlot || comparison?.restOfSeasonProjection !== null),
    expectedGames !== null,
    reliability !== null,
    candidate.nextSixPositionRank !== null,
  ].filter(Boolean).length;
  const confidence = resolveConfidence(evidenceCount, reliability);
  const tier = buildTier({
    hasOpenSlot: options.hasOpenSlot,
    comparison,
    nextSixEdge,
    restOfSeasonEdge,
    expectedGames,
    confidence,
    positionPercentile,
    availabilityLabel: rowAvailabilityLabel(candidate),
    requiredGames: options.requiredGames,
    candidateNextSix: candidate.nextSixProjection,
    candidateRestOfSeason: candidate.restOfSeasonProjection,
  });
  const factors: string[] = [];
  const risks: string[] = [];

  if (options.hasOpenSlot) {
    factors.push('Open roster slot');
  }

  if (nextSixEdge !== null) {
    if (nextSixEdge > 0) {
      factors.push(`${formatSigned(nextSixEdge)} Next 6 vs ${comparison?.name ?? 'roster option'}`);
    } else if (nextSixEdge < 0) {
      risks.push(`${formatSigned(nextSixEdge)} Next 6 vs ${comparison?.name ?? 'roster option'}`);
    }
  }

  if (restOfSeasonEdge !== null) {
    if (restOfSeasonEdge > 0) {
      factors.push(`${formatSigned(restOfSeasonEdge)} rest of season`);
    } else if (restOfSeasonEdge < 0) {
      risks.push(`${formatSigned(restOfSeasonEdge)} rest of season`);
    }
  }

  if (expectedGames !== null) {
    if (expectedGames >= options.requiredGames - 1) {
      factors.push(`${expectedGames}/${options.requiredGames} games expected`);
    } else {
      risks.push(`Only ${expectedGames}/${options.requiredGames} games expected`);
    }
  }

  const availabilityLabel = rowAvailabilityLabel(candidate);
  if (!isHealthyAvailability(availabilityLabel)) {
    risks.push(availabilityLabel ?? 'Availability concern');
  }

  if (confidence === 'low') {
    risks.push('Limited projection evidence');
  } else if (reliability !== null && reliability >= 75) {
    factors.push('Reliable projection');
  }

  const summaryParts: string[] = [];
  if (options.hasOpenSlot) {
    summaryParts.push('Open slot');
  } else if (nextSixEdge !== null && comparison) {
    summaryParts.push(`${formatSigned(nextSixEdge)} Next 6 vs ${comparison.name}`);
  } else if (comparison) {
    summaryParts.push(`Compared with ${comparison.name}`);
  } else {
    summaryParts.push('Roster comparison incomplete');
  }

  if (expectedGames !== null) {
    summaryParts.push(`${expectedGames}/${options.requiredGames} expected`);
  }
  summaryParts.push(confidenceLabel(confidence));

  const detailLines: string[] = [];
  detailLines.push(
    options.hasOpenSlot
      ? 'Comparison: an open legal roster slot; no player has to be dropped.'
      : comparison
        ? `Comparison: ${comparison.name}, the lowest-projected legal same-position ${options.comparisonArea === 'active' ? 'active' : 'bench'} option currently available.`
        : 'Comparison: no complete legal outgoing-player comparison was available.',
  );
  detailLines.push(
    `Next 6: ${formatPoints(candidate.nextSixProjection)}${comparison ? ` vs ${formatPoints(comparison.nextSixProjection)}${nextSixEdge !== null ? ` (${formatSigned(nextSixEdge)})` : ''}` : ''}.`,
  );
  detailLines.push(
    `Rest of season: ${formatPoints(candidate.restOfSeasonProjection)}${comparison ? ` vs ${formatPoints(comparison.restOfSeasonProjection)}${restOfSeasonEdge !== null ? ` (${formatSigned(restOfSeasonEdge)})` : ''}` : ''}.`,
  );
  detailLines.push(
    `Availability: ${expectedGames === null ? 'unknown' : `${expectedGames} of ${options.requiredGames} games expected`} · ${confidenceLabel(confidence).toLocaleLowerCase()}.`,
  );
  detailLines.push(
    candidate.status === 'waivers'
      ? 'Not included: waiver priority, competing claims, future injuries, or exact activation timing.'
      : 'Not included: future injuries or exact activation timing before a roster slot is selected.',
  );

  return {
    assetKey: candidate.assetKey,
    tier,
    confidence,
    hasOpenSlot: options.hasOpenSlot,
    comparisonAssetKey: comparison?.assetKey ?? null,
    comparisonName: comparison?.name ?? null,
    comparisonArea: options.comparisonArea,
    nextSixEdge,
    restOfSeasonEdge,
    expectedGamesAvailable: expectedGames,
    reliability,
    candidateNextSix: candidate.nextSixProjection,
    candidateRestOfSeason: candidate.restOfSeasonProjection,
    summary: summaryParts.join(' · '),
    factors: factors.slice(0, 3),
    risks: risks.slice(0, 2),
    detailLines,
  };
}

export function buildLeaguePlayerRosterFitRecommendations(
  input: BuildLeaguePlayerRosterFitInput,
): Map<string, LeaguePlayerRosterFitRecommendation> {
  const recommendations = new Map<string, LeaguePlayerRosterFitRecommendation>();
  const roster = input.roster;
  const requiredGames = Math.max(1, Math.round(input.requiredGames ?? 6));

  if (!roster) {
    return recommendations;
  }

  const rowByAssetKey = new Map(input.rows.map((row) => [row.assetKey, row] as const));
  const reservedBenchSlotIds = new Set(
    roster.activeSlots
      .map((slot) => slot.pendingMove?.sourceBenchSlotId?.trim() ?? '')
      .filter(Boolean),
  );

  for (const candidate of input.rows) {
    if (candidate.status !== 'free-agent' && candidate.status !== 'waivers') {
      continue;
    }

    const openActiveSlot = roster.activeSlots.some(
      (slot) => slot.position === candidate.position && slot.asset === null && !slot.pendingMove,
    );
    const openBenchSlot = roster.benchSlots.some((slot) => slot.asset === null);
    const hasOpenSlot = openActiveSlot || openBenchSlot;

    const activeSamePosition = roster.activeSlots
      .filter(
        (slot) => slot.position === candidate.position && slot.asset !== null && !slot.pendingMove,
      )
      .map((slot) => {
        const key = rosterAssetKey(slot.asset);
        return key ? rowByAssetKey.get(key) ?? null : null;
      })
      .filter((row): row is LeaguePlayerBoardRow => row !== null);

    const benchSamePosition = roster.benchSlots
      .filter(
        (slot) =>
          slot.asset !== null &&
          slot.asset.position === candidate.position &&
          !reservedBenchSlotIds.has(slot.slotId),
      )
      .map((slot) => {
        const key = rosterAssetKey(slot.asset);
        return key ? rowByAssetKey.get(key) ?? null : null;
      })
      .filter((row): row is LeaguePlayerBoardRow => row !== null);

    // Roster fit is replacement-value guidance, so every player is compared
    // only with legal roster options at the exact same position. Managers may
    // still choose a flexible cross-position bench drop in the transaction
    // workflow, but that separate choice must not inflate this position fit.
    const comparisonPool = [...activeSamePosition, ...benchSamePosition];
    const comparison = hasOpenSlot
      ? null
      : [...comparisonPool].sort(metricAscending)[0] ?? null;
    const comparisonArea = comparison
      ? activeSamePosition.some((row) => row.assetKey === comparison.assetKey)
        ? 'active'
        : 'bench'
      : null;

    recommendations.set(candidate.assetKey, buildRecommendation({
      candidate,
      comparison,
      comparisonArea,
      hasOpenSlot,
      requiredGames,
    }));
  }

  return recommendations;
}

export function compareLeaguePlayerRosterFitRecommendations(
  first: LeaguePlayerRosterFitRecommendation | null | undefined,
  second: LeaguePlayerRosterFitRecommendation | null | undefined,
): number {
  if (!first && !second) {
    return 0;
  }
  if (!first) {
    return 1;
  }
  if (!second) {
    return -1;
  }

  return TIER_ORDER[second.tier] - TIER_ORDER[first.tier] ||
    Number(second.hasOpenSlot) - Number(first.hasOpenSlot) ||
    CONFIDENCE_ORDER[second.confidence] - CONFIDENCE_ORDER[first.confidence] ||
    (second.nextSixEdge ?? Number.NEGATIVE_INFINITY) -
      (first.nextSixEdge ?? Number.NEGATIVE_INFINITY) ||
    (second.restOfSeasonEdge ?? Number.NEGATIVE_INFINITY) -
      (first.restOfSeasonEdge ?? Number.NEGATIVE_INFINITY) ||
    (second.candidateNextSix ?? Number.NEGATIVE_INFINITY) -
      (first.candidateNextSix ?? Number.NEGATIVE_INFINITY) ||
    (second.candidateRestOfSeason ?? Number.NEGATIVE_INFINITY) -
      (first.candidateRestOfSeason ?? Number.NEGATIVE_INFINITY) ||
    (second.reliability ?? Number.NEGATIVE_INFINITY) -
      (first.reliability ?? Number.NEGATIVE_INFINITY) ||
    first.assetKey.localeCompare(second.assetKey);
}

export function leaguePlayerRosterFitTierLabel(
  tier: LeaguePlayerRosterFitTier,
): string {
  return tierLabel(tier);
}

export function leaguePlayerRosterFitConfidenceLabel(
  confidence: LeaguePlayerRosterFitConfidence,
): string {
  return confidenceLabel(confidence);
}
