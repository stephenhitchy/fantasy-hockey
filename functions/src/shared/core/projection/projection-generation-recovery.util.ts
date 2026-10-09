export const PROJECTION_GENERATION_ACTIVE_STATUSES = [
  'queued',
  'processing',
] as const;

type ProjectionGenerationActiveStatus =
  typeof PROJECTION_GENERATION_ACTIVE_STATUSES[number];

export interface ProjectionGenerationRecoveryState {
  status: unknown;
  leaseExpiresAtMilliseconds: number;
  activeRequestId: string;
}

export type ProjectionGenerationRecoveryAction =
  | 'skip'
  | 'cleanup-terminal'
  | 'recover-active';

export function isProjectionGenerationActiveStatus(
  value: unknown,
): value is ProjectionGenerationActiveStatus {
  return value === 'queued' || value === 'processing';
}

export function isStaleProjectionGenerationState(
  state: ProjectionGenerationRecoveryState,
  cutoffMilliseconds: number,
): boolean {
  return isProjectionGenerationActiveStatus(state.status) &&
    Number.isFinite(state.leaseExpiresAtMilliseconds) &&
    state.leaseExpiresAtMilliseconds > 0 &&
    state.leaseExpiresAtMilliseconds <= cutoffMilliseconds;
}

function hasExpiredProjectionGenerationLease(
  state: ProjectionGenerationRecoveryState,
  cutoffMilliseconds: number,
): boolean {
  return Number.isFinite(state.leaseExpiresAtMilliseconds) &&
    state.leaseExpiresAtMilliseconds > 0 &&
    state.leaseExpiresAtMilliseconds <= cutoffMilliseconds;
}

/**
 * A recovery query is only a candidate list. Re-read the control in a
 * transaction and require that the same request still owns a stale active
 * lease before changing either document.
 */
export function getProjectionGenerationRecoveryAction(input: {
  candidate: ProjectionGenerationRecoveryState;
  current: ProjectionGenerationRecoveryState;
  cutoffMilliseconds: number;
}): ProjectionGenerationRecoveryAction {
  if (
    !hasExpiredProjectionGenerationLease(
      input.candidate,
      input.cutoffMilliseconds,
    ) ||
    !hasExpiredProjectionGenerationLease(
      input.current,
      input.cutoffMilliseconds,
    )
  ) {
    return 'skip';
  }

  if (input.current.status === 'ready' || input.current.status === 'error') {
    return 'cleanup-terminal';
  }

  if (
    !isProjectionGenerationActiveStatus(input.candidate.status) ||
    !isProjectionGenerationActiveStatus(input.current.status) ||
    input.candidate.activeRequestId !== input.current.activeRequestId
  ) {
    return 'skip';
  }

  return 'recover-active';
}

/**
 * Terminal request evidence is immutable. Recovery may only fail the exact
 * queued/processing request still named by the control.
 */
export function shouldRecoverProjectionGenerationRequest(input: {
  exists: boolean;
  status: unknown;
  documentRequestId: unknown;
  expectedRequestId: string;
}): boolean {
  return input.exists &&
    isProjectionGenerationActiveStatus(input.status) &&
    input.documentRequestId === input.expectedRequestId;
}
