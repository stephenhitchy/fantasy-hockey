import type {
  CanonicalScoringParityObservation,
} from './nhl-canonical-scoring-parity.util';

export type CanonicalScoringAuthoritySelection =
  | 'shadow-direct'
  | 'canonical-verified'
  | 'direct-fallback';

export interface CanonicalScoringAuthorityDecision {
  gameId: number;
  assetKey: string;
  sourceVersion: string;
  selection: CanonicalScoringAuthoritySelection;
  selectedPoints: number;
  selectedAppeared: boolean;
  directPoints: number;
  directAppeared: boolean;
  canonicalPoints: number | null;
  canonicalAppeared: boolean | null;
  fallbackReason: string;
  tripCircuitBreaker: boolean;
}

export interface CanonicalScoringAuthorityTaskSummary {
  configured: boolean;
  taskVersionAligned: boolean;
  observationCount: number;
  canonicalUsedCount: number;
  directFallbackCount: number;
  shadowDirectCount: number;
  mismatchCount: number;
  incompleteCount: number;
  canonicalMissingCount: number;
  tripCircuitBreaker: boolean;
  circuitBreakerReason: string;
}

export function decideCanonicalScoringAuthority(input: {
  configured: boolean;
  taskVersionAligned: boolean;
  observation: CanonicalScoringParityObservation;
}): CanonicalScoringAuthorityDecision {
  const observation = input.observation;

  if (!input.configured) {
    return {
      gameId: observation.gameId,
      assetKey: observation.assetKey,
      sourceVersion: observation.sourceVersion,
      selection: 'shadow-direct',
      selectedPoints: observation.directPoints,
      selectedAppeared: observation.directAppeared,
      directPoints: observation.directPoints,
      directAppeared: observation.directAppeared,
      canonicalPoints: observation.canonicalPoints,
      canonicalAppeared: observation.canonicalAppeared,
      fallbackReason: '',
      tripCircuitBreaker: false,
    };
  }

  if (!input.taskVersionAligned) {
    return {
      gameId: observation.gameId,
      assetKey: observation.assetKey,
      sourceVersion: observation.sourceVersion,
      selection: 'direct-fallback',
      selectedPoints: observation.directPoints,
      selectedAppeared: observation.directAppeared,
      directPoints: observation.directPoints,
      directAppeared: observation.directAppeared,
      canonicalPoints: observation.canonicalPoints,
      canonicalAppeared: observation.canonicalAppeared,
      fallbackReason: 'canonical-task-version-misaligned',
      tripCircuitBreaker: true,
    };
  }

  if (
    observation.status === 'matched' &&
    observation.canonicalPoints !== null &&
    observation.canonicalAppeared !== null
  ) {
    return {
      gameId: observation.gameId,
      assetKey: observation.assetKey,
      sourceVersion: observation.sourceVersion,
      selection: 'canonical-verified',
      selectedPoints: observation.canonicalPoints,
      selectedAppeared: observation.canonicalAppeared,
      directPoints: observation.directPoints,
      directAppeared: observation.directAppeared,
      canonicalPoints: observation.canonicalPoints,
      canonicalAppeared: observation.canonicalAppeared,
      fallbackReason: '',
      tripCircuitBreaker: false,
    };
  }

  const fallbackReason = observation.status === 'mismatch'
    ? 'canonical-score-mismatch'
    : observation.status === 'canonical-missing'
      ? 'canonical-game-missing'
      : observation.reason || 'canonical-game-incomplete';

  return {
    gameId: observation.gameId,
    assetKey: observation.assetKey,
    sourceVersion: observation.sourceVersion,
    selection: 'direct-fallback',
    selectedPoints: observation.directPoints,
    selectedAppeared: observation.directAppeared,
    directPoints: observation.directPoints,
    directAppeared: observation.directAppeared,
    canonicalPoints: observation.canonicalPoints,
    canonicalAppeared: observation.canonicalAppeared,
    fallbackReason,
    tripCircuitBreaker: true,
  };
}

export function summarizeCanonicalScoringAuthorityTask(input: {
  configured: boolean;
  taskVersionAligned: boolean;
  decisions: readonly CanonicalScoringAuthorityDecision[];
}): CanonicalScoringAuthorityTaskSummary {
  const canonicalUsedCount = input.decisions.filter(
    (decision) => decision.selection === 'canonical-verified',
  ).length;
  const directFallbackCount = input.decisions.filter(
    (decision) => decision.selection === 'direct-fallback',
  ).length;
  const shadowDirectCount = input.decisions.filter(
    (decision) => decision.selection === 'shadow-direct',
  ).length;
  const mismatchCount = input.decisions.filter(
    (decision) => decision.fallbackReason === 'canonical-score-mismatch',
  ).length;
  const canonicalMissingCount = input.decisions.filter(
    (decision) => decision.fallbackReason === 'canonical-game-missing',
  ).length;
  const incompleteCount = directFallbackCount - mismatchCount - canonicalMissingCount;
  const firstFallback = input.decisions.find(
    (decision) => decision.tripCircuitBreaker,
  );
  const taskCannotUseCanonical = input.configured && (
    !input.taskVersionAligned ||
    directFallbackCount > 0
  );
  const circuitBreakerReason = !input.configured
    ? ''
    : !input.taskVersionAligned
      ? 'canonical-task-version-misaligned'
      : firstFallback?.fallbackReason ?? '';

  return {
    configured: input.configured,
    taskVersionAligned: input.taskVersionAligned,
    observationCount: input.decisions.length,
    canonicalUsedCount,
    directFallbackCount,
    shadowDirectCount,
    mismatchCount,
    incompleteCount,
    canonicalMissingCount,
    tripCircuitBreaker: taskCannotUseCanonical,
    circuitBreakerReason,
  };
}
