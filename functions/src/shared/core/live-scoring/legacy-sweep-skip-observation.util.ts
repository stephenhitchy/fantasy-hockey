export const LEGACY_SWEEP_SKIP_OBSERVATION_SCHEMA_VERSION = 1 as const;

export const LEGACY_SWEEP_SKIP_OBSERVATION_REASONS = [
  'saved-refresh-not-due',
  'refresh-proof-missing',
  'refresh-proof-stale',
  'historical-replay',
  'another-worker-active',
  'unrecognized-skip',
  'deep-run-published-or-transitioned',
  'deep-run-source-proof-required',
  'run-failed',
] as const;

export type LegacySweepSkipObservationReason =
  typeof LEGACY_SWEEP_SKIP_OBSERVATION_REASONS[number];

export interface LegacySweepSkipObservationInput {
  outcome: 'success' | 'skipped' | 'failed';
  observationStartedAtMilliseconds: number;
  skipReason?: string;
  nextRefreshAtMilliseconds?: number;
  publishedSnapshotCount?: number;
  cycleOneCreated?: boolean;
  transitionOccurred?: boolean;
}

export interface LegacySweepSkipObservation {
  eligible: boolean;
  reason: LegacySweepSkipObservationReason;
  deepScoringRan: boolean;
  noPublicationObserved: boolean;
}

export interface LegacySweepSkipObservationSummary {
  schemaVersion: typeof LEGACY_SWEEP_SKIP_OBSERVATION_SCHEMA_VERSION;
  mode: 'observe-only';
  enforcementEnabled: false;
  analyzedLeagueCount: number;
  eligibleLeagueCount: number;
  ineligibleLeagueCount: number;
  deepScoringRunCount: number;
  deepScoringNoPublicationCount: number;
  failedRunCount: number;
  reasonCounts: Record<LegacySweepSkipObservationReason, number>;
}

function nonNegativeInteger(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

/**
 * Classifies evidence produced by the unchanged legacy sweep. Eligibility is
 * deliberately limited to an already-proven `not-due` lease result with a
 * future saved refresh boundary. A completed no-publication scoring pass is
 * useful cost evidence, but it is not safe skip authority without a durable
 * NHL source/version proof captured before that pass.
 */
export function classifyLegacySweepSkipObservation(
  input: LegacySweepSkipObservationInput,
): LegacySweepSkipObservation {
  if (input.outcome === 'failed') {
    return {
      eligible: false,
      reason: 'run-failed',
      deepScoringRan: false,
      noPublicationObserved: false,
    };
  }

  if (input.outcome === 'skipped') {
    if (input.skipReason === 'historical-replay') {
      return {
        eligible: false,
        reason: 'historical-replay',
        deepScoringRan: false,
        noPublicationObserved: false,
      };
    }

    if (input.skipReason === 'another-server-worker') {
      return {
        eligible: false,
        reason: 'another-worker-active',
        deepScoringRan: false,
        noPublicationObserved: false,
      };
    }

    if (input.skipReason !== 'not-due') {
      return {
        eligible: false,
        reason: 'unrecognized-skip',
        deepScoringRan: false,
        noPublicationObserved: false,
      };
    }

    const nextRefreshAtMilliseconds = input.nextRefreshAtMilliseconds;

    if (
      typeof nextRefreshAtMilliseconds !== 'number' ||
      !Number.isFinite(nextRefreshAtMilliseconds) ||
      nextRefreshAtMilliseconds <= 0
    ) {
      return {
        eligible: false,
        reason: 'refresh-proof-missing',
        deepScoringRan: false,
        noPublicationObserved: false,
      };
    }

    if (
      !Number.isFinite(input.observationStartedAtMilliseconds) ||
      nextRefreshAtMilliseconds <= input.observationStartedAtMilliseconds
    ) {
      return {
        eligible: false,
        reason: 'refresh-proof-stale',
        deepScoringRan: false,
        noPublicationObserved: false,
      };
    }

    return {
      eligible: true,
      reason: 'saved-refresh-not-due',
      deepScoringRan: false,
      noPublicationObserved: false,
    };
  }

  const noPublicationObserved =
    nonNegativeInteger(input.publishedSnapshotCount) === 0;
  const publishedOrTransitioned =
    !noPublicationObserved ||
    input.cycleOneCreated === true ||
    input.transitionOccurred === true;

  return {
    eligible: false,
    reason: publishedOrTransitioned
      ? 'deep-run-published-or-transitioned'
      : 'deep-run-source-proof-required',
    deepScoringRan: true,
    noPublicationObserved,
  };
}

export function summarizeLegacySweepSkipObservations(
  observations: readonly LegacySweepSkipObservation[],
): LegacySweepSkipObservationSummary {
  const reasonCounts = Object.fromEntries(
    LEGACY_SWEEP_SKIP_OBSERVATION_REASONS.map((reason) => [reason, 0]),
  ) as Record<LegacySweepSkipObservationReason, number>;

  for (const observation of observations) {
    reasonCounts[observation.reason] += 1;
  }

  const eligibleLeagueCount = observations.filter(
    (observation) => observation.eligible,
  ).length;
  const deepScoringRunCount = observations.filter(
    (observation) => observation.deepScoringRan,
  ).length;
  const deepScoringNoPublicationCount = observations.filter(
    (observation) =>
      observation.deepScoringRan && observation.noPublicationObserved,
  ).length;

  return {
    schemaVersion: LEGACY_SWEEP_SKIP_OBSERVATION_SCHEMA_VERSION,
    mode: 'observe-only',
    enforcementEnabled: false,
    analyzedLeagueCount: observations.length,
    eligibleLeagueCount,
    ineligibleLeagueCount: observations.length - eligibleLeagueCount,
    deepScoringRunCount,
    deepScoringNoPublicationCount,
    failedRunCount: reasonCounts['run-failed'],
    reasonCounts,
  };
}
