import type { DraftableAsset } from '../draft/draft.models';

export type PlayerOpportunityImpact = 'positive' | 'neutral' | 'negative';

export interface PlayerOpportunityFactor {
  key: 'availability' | 'schedule' | 'rest' | 'role' | 'form';
  label: string;
  value: string;
  impact: PlayerOpportunityImpact;
  detail: string;
  weight: number;
}

export interface PlayerOpportunityLens {
  headline: string;
  summary: string;
  factors: PlayerOpportunityFactor[];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatSignedPoints(value: number): string {
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(1).replace(/\.0$/, '')} FP`;
}

function formatGameCount(value: number): string {
  return Number.isInteger(value)
    ? value.toFixed(0)
    : value.toFixed(1).replace(/\.0$/, '');
}

function adjustmentImpact(value: number): PlayerOpportunityImpact {
  if (value >= 0.25) {
    return 'positive';
  }
  if (value <= -0.25) {
    return 'negative';
  }
  return 'neutral';
}

function buildAvailabilityFactor(asset: DraftableAsset): PlayerOpportunityFactor | null {
  const expected = finiteNumber(asset.expectedGamesAvailable);
  const scheduled = finiteNumber(asset.scheduledGamesInProjectionCycle);

  if (expected === null || scheduled === null || scheduled <= 0) {
    return null;
  }

  const missed = Math.max(0, scheduled - expected);
  const impact: PlayerOpportunityImpact = missed >= 0.25 ? 'negative' : 'neutral';

  return {
    key: 'availability',
    label: 'Availability',
    value: `${formatGameCount(expected)} of ${formatGameCount(scheduled)} expected`,
    impact,
    detail: missed >= 0.25
      ? `Availability currently removes about ${formatGameCount(missed)} ${missed === 1 ? 'game' : 'games'} from the six-game opportunity.`
      : 'The full scheduled opportunity is currently expected to be available.',
    weight: missed >= 0.25 ? 100 + missed * 10 : 1,
  };
}

function buildScheduleFactor(asset: DraftableAsset): PlayerOpportunityFactor | null {
  const adjustment = finiteNumber(asset.scheduleStrengthAdjustment);
  const label = asset.scheduleDifficultyLabel?.trim();

  if (adjustment === null && !label) {
    return null;
  }

  const normalizedAdjustment = adjustment ?? 0;
  const impact = adjustmentImpact(normalizedAdjustment);
  const value = [label, adjustment === null ? null : formatSignedPoints(normalizedAdjustment)]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return {
    key: 'schedule',
    label: 'Schedule',
    value: value || 'Neutral',
    impact,
    detail: impact === 'neutral'
      ? 'Opponent and venue context is close to neutral for this block.'
      : `Opponent and venue context ${normalizedAdjustment > 0 ? 'adds' : 'removes'} about ${Math.abs(normalizedAdjustment).toFixed(1).replace(/\.0$/, '')} projected fantasy points.`,
    weight: Math.abs(normalizedAdjustment) * 10 + (impact === 'neutral' ? 0 : 10),
  };
}

function buildRestFactor(asset: DraftableAsset): PlayerOpportunityFactor | null {
  const backToBacks = finiteNumber(asset.projectionBackToBackGames);
  const restAdvantages = finiteNumber(asset.projectionRestAdvantageGames);

  if (backToBacks === null && restAdvantages === null) {
    return null;
  }

  const backToBackCount = Math.max(0, Math.round(backToBacks ?? 0));
  const restAdvantageCount = Math.max(0, Math.round(restAdvantages ?? 0));
  const net = restAdvantageCount - backToBackCount;
  const impact: PlayerOpportunityImpact = net > 0
    ? 'positive'
    : net < 0
      ? 'negative'
      : 'neutral';

  return {
    key: 'rest',
    label: 'Rest pattern',
    value: `${restAdvantageCount} rest ${restAdvantageCount === 1 ? 'edge' : 'edges'} · ${backToBackCount} ${backToBackCount === 1 ? 'back-to-back' : 'back-to-backs'}`,
    impact,
    detail: net === 0
      ? 'Rest advantages and back-to-backs are balanced in this block.'
      : `${Math.abs(net)} more ${net > 0 ? 'rest advantage' : 'back-to-back'}${Math.abs(net) === 1 ? '' : 's'} shape this block.`,
    weight: Math.abs(net) * 6 + (backToBackCount + restAdvantageCount),
  };
}

function buildAdjustmentFactor(
  key: 'role' | 'form',
  label: string,
  adjustment: number | null,
): PlayerOpportunityFactor | null {
  if (adjustment === null) {
    return null;
  }

  const impact = adjustmentImpact(adjustment);
  return {
    key,
    label,
    value: formatSignedPoints(adjustment),
    impact,
    detail: impact === 'neutral'
      ? `${label} is not materially changing the next-six projection.`
      : `${label} ${adjustment > 0 ? 'adds' : 'removes'} about ${Math.abs(adjustment).toFixed(1).replace(/\.0$/, '')} projected fantasy points.`,
    weight: Math.abs(adjustment) * 10,
  };
}

export function buildPlayerOpportunityLens(asset: DraftableAsset): PlayerOpportunityLens {
  const availability = buildAvailabilityFactor(asset);
  const schedule = buildScheduleFactor(asset);
  const rest = buildRestFactor(asset);
  const role = buildAdjustmentFactor(
    'role',
    'Recent role',
    finiteNumber(asset.roleAdjustment),
  );
  const form = buildAdjustmentFactor(
    'form',
    'Recent form',
    finiteNumber(asset.recentFormAdjustment),
  );
  const allFactors = [availability, schedule, rest, role, form]
    .filter((factor): factor is PlayerOpportunityFactor => factor !== null);
  const meaningful = allFactors
    .filter((factor) => factor.impact !== 'neutral')
    .sort((left, right) => right.weight - left.weight);
  const selected: PlayerOpportunityFactor[] = [];

  if (availability?.impact === 'negative') {
    selected.push(availability);
  }

  for (const factor of meaningful) {
    if (!selected.some((candidate) => candidate.key === factor.key)) {
      selected.push(factor);
    }
    if (selected.length === 3) {
      break;
    }
  }

  for (const factor of allFactors) {
    if (selected.length === 3) {
      break;
    }
    if (!selected.some((candidate) => candidate.key === factor.key)) {
      selected.push(factor);
    }
  }

  const expected = finiteNumber(asset.expectedGamesAvailable);
  const scheduled = finiteNumber(asset.scheduledGamesInProjectionCycle);
  const scheduleAdjustment = finiteNumber(asset.scheduleStrengthAdjustment) ?? 0;
  const roleAndForm = (finiteNumber(asset.roleAdjustment) ?? 0) +
    (finiteNumber(asset.recentFormAdjustment) ?? 0);

  let headline = 'Next-six outlook';
  if (expected !== null && scheduled !== null && scheduled - expected >= 0.25) {
    headline = `Reduced to ${formatGameCount(expected)} of ${formatGameCount(scheduled)}`;
  } else if (scheduleAdjustment >= 1) {
    headline = 'Schedule boost';
  } else if (scheduleAdjustment <= -1) {
    headline = 'Tough six-game draw';
  } else if (roleAndForm >= 1) {
    headline = 'Role and form trending up';
  } else if (roleAndForm <= -1) {
    headline = 'Role or form is pulling back';
  } else if (expected !== null && scheduled !== null && expected >= scheduled - 0.1) {
    headline = 'Full six-game opportunity';
  }

  return {
    headline,
    summary: selected.length
      ? selected.slice(0, 2).map((factor) => factor.detail).join(' ')
      : 'Projection V11 has not published enough schedule context for a deeper explanation yet.',
    factors: selected,
  };
}
