import type { DraftableAsset } from '../../core/draft/draft.models';

export type FreeAgentMoveLensVerdict =
  | 'lean-add'
  | 'lean-hold'
  | 'close-call'
  | 'open-slot-caution';

export type FreeAgentMoveLensConfidence = 'high' | 'medium' | 'low';
export type FreeAgentMoveLensDirection = 'incoming' | 'outgoing' | 'even' | 'uncertain';

export interface FreeAgentMoveLensFactor {
  key:
    | 'next-six'
    | 'rest-of-season'
    | 'availability'
    | 'projection-floor'
    | 'season-pace'
    | 'reliability'
    | 'replacement-value';
  label: string;
  direction: FreeAgentMoveLensDirection;
  detail: string;
}

export interface FreeAgentMoveLensResult {
  verdict: FreeAgentMoveLensVerdict;
  headline: string;
  confidence: FreeAgentMoveLensConfidence;
  confidenceLabel: string;
  summary: string;
  factors: FreeAgentMoveLensFactor[];
  uncertainty: string;
  evidenceCount: number;
  incomingSignalCount: number;
  outgoingSignalCount: number;
}

export interface BuildFreeAgentMoveLensInput {
  incoming: DraftableAsset;
  outgoing: DraftableAsset | null;
  transactionType: 'free-agent' | 'waiver';
  openSlot: boolean;
}

interface CandidateSignal extends FreeAgentMoveLensFactor {
  priority: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function signed(value: number, suffix = ''): string {
  if (Math.abs(value) < 0.05) {
    return `0${suffix}`;
  }

  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}${suffix}`;
}

function adaptiveThreshold(
  incoming: number,
  outgoing: number,
  minimum: number,
  relative: number,
): number {
  return Math.max(minimum, ((Math.abs(incoming) + Math.abs(outgoing)) / 2) * relative);
}

function compareMetric(options: {
  key: CandidateSignal['key'];
  label: string;
  incoming: number | null;
  outgoing: number | null;
  minimumThreshold: number;
  relativeThreshold: number;
  suffix?: string;
  priority: number;
  incomingLabel: string;
  outgoingLabel: string;
}): CandidateSignal | null {
  if (options.incoming === null || options.outgoing === null) {
    return null;
  }

  const difference = options.incoming - options.outgoing;
  const threshold = adaptiveThreshold(
    options.incoming,
    options.outgoing,
    options.minimumThreshold,
    options.relativeThreshold,
  );
  const direction: FreeAgentMoveLensDirection = difference > threshold
    ? 'incoming'
    : difference < -threshold
      ? 'outgoing'
      : 'even';

  return {
    key: options.key,
    label: options.label,
    direction,
    priority: options.priority,
    detail: `${signed(difference, options.suffix)} · ${options.incomingLabel} ${options.incoming.toFixed(1)} vs ${options.outgoingLabel} ${options.outgoing.toFixed(1)}`,
  };
}

function normalizedReliability(asset: DraftableAsset): number | null {
  return finiteNumber(asset.reliabilityRating ?? asset.draftReliabilityRating);
}

function normalizedCyclePoints(asset: DraftableAsset): number | null {
  return finiteNumber(asset.availabilityAdjustedCyclePoints ?? asset.projectedCyclePoints);
}

function normalizedAvailability(asset: DraftableAsset): number | null {
  return finiteNumber(asset.expectedGamesAvailable);
}

function normalizedAvailabilityStatus(asset: DraftableAsset): string {
  return (asset.availabilityStatus ?? '').trim().toLowerCase();
}

function isAvailabilityConcern(asset: DraftableAsset): boolean {
  const status = normalizedAvailabilityStatus(asset);
  return Boolean(status && status !== 'active' && status !== 'unknown');
}

function buildAvailabilitySignal(
  incoming: DraftableAsset,
  outgoing: DraftableAsset,
): CandidateSignal | null {
  const incomingGames = normalizedAvailability(incoming);
  const outgoingGames = normalizedAvailability(outgoing);

  if (incomingGames !== null && outgoingGames !== null) {
    const difference = incomingGames - outgoingGames;
    const direction: FreeAgentMoveLensDirection = difference > 0.75
      ? 'incoming'
      : difference < -0.75
        ? 'outgoing'
        : 'even';

    return {
      key: 'availability',
      label: 'Availability',
      direction,
      priority: 1,
      detail: `${signed(difference, ' games')} · incoming ${incomingGames.toFixed(1)} vs outgoing ${outgoingGames.toFixed(1)}`,
    };
  }

  const incomingConcern = isAvailabilityConcern(incoming);
  const outgoingConcern = isAvailabilityConcern(outgoing);

  if (!incomingConcern && !outgoingConcern) {
    return null;
  }

  return {
    key: 'availability',
    label: 'Availability',
    direction: incomingConcern === outgoingConcern
      ? 'uncertain'
      : incomingConcern
        ? 'outgoing'
        : 'incoming',
    priority: 1,
    detail: incomingConcern && outgoingConcern
      ? 'Both players carry current availability risk.'
      : incomingConcern
        ? 'The incoming player carries the current availability risk.'
        : 'The outgoing player carries the current availability risk.',
  };
}

function buildOpenSlotSignals(incoming: DraftableAsset): CandidateSignal[] {
  const signals: CandidateSignal[] = [];
  const replacementValue = finiteNumber(incoming.cycleValueAboveReplacement);
  const expectedGames = normalizedAvailability(incoming);
  const reliability = normalizedReliability(incoming);

  if (replacementValue !== null) {
    signals.push({
      key: 'replacement-value',
      label: 'Replacement value',
      direction: replacementValue > 1.5
        ? 'incoming'
        : replacementValue < -1.5
          ? 'outgoing'
          : 'even',
      priority: 1,
      detail: `${signed(replacementValue, ' pts')} above the current replacement baseline.`,
    });
  }

  if (expectedGames !== null) {
    signals.push({
      key: 'availability',
      label: 'Availability',
      direction: expectedGames >= 5
        ? 'incoming'
        : expectedGames <= 3
          ? 'outgoing'
          : 'even',
      priority: 2,
      detail: `${expectedGames.toFixed(1)} of 6 games expected.`,
    });
  }

  if (reliability !== null) {
    signals.push({
      key: 'reliability',
      label: 'Reliability',
      direction: reliability >= 75
        ? 'incoming'
        : reliability < 55
          ? 'outgoing'
          : 'even',
      priority: 3,
      detail: `${reliability.toFixed(0)}/100 projection reliability.`,
    });
  }

  return signals;
}

function projectionUncertaintyRatio(asset: DraftableAsset): number | null {
  const uncertainty = finiteNumber(asset.projectionUncertaintyPoints);
  const projection = normalizedCyclePoints(asset);

  if (uncertainty === null || projection === null || Math.abs(projection) < 1) {
    return null;
  }

  return Math.abs(uncertainty / projection);
}

function buildUncertaintyMessage(
  input: BuildFreeAgentMoveLensInput,
  evidenceCount: number,
): string {
  const messages: string[] = [];
  const incomingUncertainty = projectionUncertaintyRatio(input.incoming);
  const outgoingUncertainty = input.outgoing
    ? projectionUncertaintyRatio(input.outgoing)
    : null;
  const widestUncertainty = Math.max(
    incomingUncertainty ?? 0,
    outgoingUncertainty ?? 0,
  );

  if (input.transactionType === 'waiver') {
    messages.push('Waiver priority cost and competing claims are not scored.');
  }

  if (isAvailabilityConcern(input.incoming) || (input.outgoing && isAvailabilityConcern(input.outgoing))) {
    messages.push('Injury or return timing can change the result.');
  }

  if (widestUncertainty >= 0.3) {
    messages.push('At least one next-six range is wide.');
  } else if (evidenceCount < 3) {
    messages.push('Some comparison data is unavailable.');
  }

  if (messages.length === 0) {
    messages.push('Current projection ranges are relatively stable, but this is still an estimate.');
  }

  return messages.slice(0, 2).join(' ');
}

function confidenceFromSignals(options: {
  evidenceCount: number;
  margin: number;
  hasCoreProjection: boolean;
  widestUncertainty: number;
}): FreeAgentMoveLensConfidence {
  if (
    options.evidenceCount >= 4 &&
    options.margin >= 3 &&
    options.hasCoreProjection &&
    options.widestUncertainty < 0.25
  ) {
    return 'high';
  }

  if (options.evidenceCount >= 3 && options.hasCoreProjection) {
    return 'medium';
  }

  return 'low';
}

function confidenceLabel(confidence: FreeAgentMoveLensConfidence): string {
  switch (confidence) {
    case 'high':
      return 'Higher confidence';
    case 'medium':
      return 'Moderate confidence';
    default:
      return 'Low confidence';
  }
}

export function buildFreeAgentMoveLens(
  input: BuildFreeAgentMoveLensInput,
): FreeAgentMoveLensResult {
  const incomingName = input.incoming.assetType === 'skater'
    ? input.incoming.player.fullName
    : `${input.incoming.teamName} Goalie Unit`;
  const outgoingName = input.outgoing?.assetType === 'skater'
    ? input.outgoing.player.fullName
    : input.outgoing
      ? `${input.outgoing.teamName} Goalie Unit`
      : null;
  const actionLabel = input.transactionType === 'waiver' ? 'claim' : 'add';
  let signals: CandidateSignal[];

  if (!input.outgoing || input.openSlot) {
    signals = buildOpenSlotSignals(input.incoming);
  } else {
    signals = [
      buildAvailabilitySignal(input.incoming, input.outgoing),
      compareMetric({
        key: 'next-six',
        label: 'Next 6',
        incoming: normalizedCyclePoints(input.incoming),
        outgoing: normalizedCyclePoints(input.outgoing),
        minimumThreshold: 1.5,
        relativeThreshold: 0.06,
        priority: 2,
        incomingLabel: 'in',
        outgoingLabel: 'out',
      }),
      compareMetric({
        key: 'rest-of-season',
        label: 'Rest of season',
        incoming: finiteNumber(input.incoming.projectedRestOfSeasonPoints),
        outgoing: finiteNumber(input.outgoing.projectedRestOfSeasonPoints),
        minimumThreshold: 8,
        relativeThreshold: 0.03,
        priority: 3,
        incomingLabel: 'in',
        outgoingLabel: 'out',
      }),
      compareMetric({
        key: 'projection-floor',
        label: 'Projection floor',
        incoming: finiteNumber(input.incoming.projectionFloorPoints),
        outgoing: finiteNumber(input.outgoing.projectionFloorPoints),
        minimumThreshold: 1,
        relativeThreshold: 0.06,
        priority: 4,
        incomingLabel: 'in',
        outgoingLabel: 'out',
      }),
      compareMetric({
        key: 'season-pace',
        label: 'Season pace',
        incoming: finiteNumber(input.incoming.seasonFantasyPointsPerGame),
        outgoing: finiteNumber(input.outgoing.seasonFantasyPointsPerGame),
        minimumThreshold: 0.25,
        relativeThreshold: 0.08,
        suffix: ' FPPG',
        priority: 5,
        incomingLabel: 'in',
        outgoingLabel: 'out',
      }),
      compareMetric({
        key: 'reliability',
        label: 'Reliability',
        incoming: normalizedReliability(input.incoming),
        outgoing: normalizedReliability(input.outgoing),
        minimumThreshold: 8,
        relativeThreshold: 0.05,
        suffix: '',
        priority: 6,
        incomingLabel: 'in',
        outgoingLabel: 'out',
      }),
    ].filter((signal): signal is CandidateSignal => signal !== null);
  }

  const incomingSignalCount = signals.filter((signal) => signal.direction === 'incoming').length;
  const outgoingSignalCount = signals.filter((signal) => signal.direction === 'outgoing').length;
  const evidenceCount = incomingSignalCount + outgoingSignalCount;
  const margin = Math.abs(incomingSignalCount - outgoingSignalCount);
  const hasCoreProjection = signals.some((signal) => signal.key === 'next-six') ||
    (!input.outgoing && signals.some((signal) => signal.key === 'replacement-value'));
  const widestUncertainty = Math.max(
    projectionUncertaintyRatio(input.incoming) ?? 0,
    input.outgoing ? projectionUncertaintyRatio(input.outgoing) ?? 0 : 0,
  );
  const confidence = confidenceFromSignals({
    evidenceCount,
    margin,
    hasCoreProjection,
    widestUncertainty,
  });

  let verdict: FreeAgentMoveLensVerdict;
  let headline: string;
  let summary: string;

  if (!input.outgoing || input.openSlot) {
    if (incomingSignalCount >= 2 && outgoingSignalCount === 0) {
      verdict = 'lean-add';
      headline = `Leans ${actionLabel}`;
      summary = `${incomingSignalCount} available signals support using the open slot for ${incomingName}.`;
    } else if (outgoingSignalCount >= 2) {
      verdict = 'open-slot-caution';
      headline = 'Open-slot caution';
      summary = `No player is being dropped, but ${outgoingSignalCount} current signals raise concern.`;
    } else {
      verdict = 'close-call';
      headline = 'Open-slot call';
      summary = 'No player is being dropped; current evidence is limited or mixed.';
    }
  } else if (incomingSignalCount >= outgoingSignalCount + 2) {
    verdict = 'lean-add';
    headline = `Leans ${actionLabel}`;
    summary = `${incomingSignalCount} of ${evidenceCount} decisive signals favor ${incomingName}.`;
  } else if (outgoingSignalCount >= incomingSignalCount + 2) {
    verdict = 'lean-hold';
    headline = 'Leans hold';
    summary = `${outgoingSignalCount} of ${evidenceCount} decisive signals favor keeping ${outgoingName}.`;
  } else {
    verdict = 'close-call';
    headline = 'Close call';
    summary = evidenceCount > 0
      ? `Signals are split ${incomingSignalCount}–${outgoingSignalCount}; neither side has a clear edge.`
      : 'There is not enough current evidence for a directional recommendation.';
  }

  const factorDirections = new Set<FreeAgentMoveLensDirection>();
  const factors = [...signals]
    .sort((left, right) => {
      const leftDecisive = left.direction === 'incoming' || left.direction === 'outgoing' ? 0 : 1;
      const rightDecisive = right.direction === 'incoming' || right.direction === 'outgoing' ? 0 : 1;
      return leftDecisive - rightDecisive || left.priority - right.priority;
    })
    .filter((factor) => {
      if (factorDirections.has(factor.direction) && factor.direction === 'even') {
        return false;
      }
      factorDirections.add(factor.direction);
      return true;
    })
    .slice(0, 3)
    .map(({ priority: _priority, ...factor }) => factor);

  return {
    verdict,
    headline,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    summary,
    factors,
    uncertainty: buildUncertaintyMessage(input, evidenceCount),
    evidenceCount,
    incomingSignalCount,
    outgoingSignalCount,
  };
}
